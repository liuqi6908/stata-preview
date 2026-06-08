/**
 * Webview 控制器。
 *
 * 只保存元数据与当前页数据，不持有完整数据集。
 * 筛选、排序、分页和变量汇总均通过消息发送给扩展宿主处理。
 */

/* global bootstrap, vscode, modals */

(function () {
  // ---------- 状态 ----------

  /** 数据集元信息，由宿主发送 initData 后填充 */
  let meta = null
  /** 当前分页大小 */
  let pageSize = bootstrap.pageSize || 1000
  /** 当前页行数据 */
  let currentPageRows = []
  /** 当前过滤后的总行数 */
  let totalFiltered = 0
  /** 原始总行数 */
  let totalAll = 0
  /** 当前页在过滤后视图中的起始偏移 */
  let pageOffset = 0
  /** 当前文件信息，刷新数据后由宿主更新 */
  let fileInfoState = {
    fileName: bootstrap.fileName,
    filePath: bootstrap.filePath,
    fileSize: bootstrap.fileSize,
    lastModified: bootstrap.lastModified,
  }

  /** 当前可见列下标集合 */
  let visibleColumns = new Set()
  /** 列宽缓存：变量名 -> 像素宽度 */
  let colWidths = {}
  /** 默认列宽 */
  const DEFAULT_COL_WIDTH = 140
  /** 字符串列默认更宽 */
  const DEFAULT_STR_COL_WIDTH = 240
  /** 多列排序配置 */
  let sortSpec = []
  /** 当前通用过滤表达式 */
  let filterQuery = ''
  /** 侧边栏是否显示 */
  let sidebarVisible = true
  /** 侧边栏位置 */
  let sidebarPosition = 'right'
  /** 表头右键菜单 */
  let headerContextMenu = null

  // ---------- 表格虚拟滚动 ----------

  // 完整渲染大页会产生大量 DOM 节点，因此只渲染视口附近的行，
  // 并通过占位行保持真实滚动高度。
  /** 行高估计值，首次渲染后会用真实行高修正 */
  let estRowHeight = 31
  /** 视口上下额外渲染的行数 */
  const ROW_OVERSCAN = 12
  /** 是否已有一次滚动重绘排队 */
  let virtScrollScheduled = false

  // ---------- 宿主请求 ----------

  /** 最新请求 id */
  let lastRequestId = 0
  /** 等待宿主响应的请求 */
  const pending = new Map()

  /**
   * 生成新的请求 id
   */
  function nextRequestId() {
    return ++lastRequestId
  }

  /**
   * 发送普通宿主请求
   */
  function postRequest(command, payload) {
    const requestId = nextRequestId()
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      vscode.postMessage({ command, requestId, ...payload })
    })
  }

  /** 各通道最近一次请求，用于实现“最新请求优先” */
  const latestByChannel = new Map()

  /**
   * 发送同通道仅保留最新结果的宿主请求
   */
  async function postLatest(channel, command, payload) {
    const myId = nextRequestId()
    latestByChannel.set(channel, myId)
    const result = await new Promise((resolve, reject) => {
      pending.set(myId, { resolve, reject })
      vscode.postMessage({ command, requestId: myId, ...payload })
    })
    if (latestByChannel.get(channel) !== myId) {
      // 同通道已有更新请求，调用方会忽略该哨兵错误。
      throw new StaleRequestError(channel)
    }
    return result
  }

  /**
   * 过期请求错误
   */
  class StaleRequestError extends Error {
    constructor(channel) {
      super(`stale request on ${channel}`)
      this.stale = true
    }
  }

  // ---------- DOM 元素 ----------

  const layoutContainer = document.getElementById('layout-container')
  const resizeHandle = document.getElementById('resize-handle')

  // 工具栏
  const searchInput = document.getElementById('search-input')
  const searchApply = document.getElementById('search-apply')
  const searchClear = document.getElementById('search-clear')
  const filterError = document.getElementById('filter-error')
  const toggleSidebar = document.getElementById('toggle-sidebar')
  const exportData = document.getElementById('export-data')
  const refreshData = document.getElementById('refresh-data')
  const fileInfo = document.getElementById('file-info')
  const usageGuide = document.getElementById('usage-guide')

  // 网格器
  const gridContainer = document.getElementById('grid-container')
  const gridOverlay = document.getElementById('grid-overlay')
  const tableHead = document.getElementById('table-head')
  const tableBody = document.getElementById('table-body')

  // 分页控件
  const pageFirst = document.getElementById('page-first')
  const pagePrev = document.getElementById('page-prev')
  const pageNext = document.getElementById('page-next')
  const pageLast = document.getElementById('page-last')
  const pageInfo = document.getElementById('page-info')
  const pageSizeSelect = document.getElementById('page-size')
  const pageSummary = document.getElementById('page-summary')

  // 侧边栏
  const sidebar = document.getElementById('sidebar')
  const sidebarPositionBtn = document.getElementById('sidebar-position')
  const variableSearch = document.getElementById('variable-search')
  const selectAllVariables = document.getElementById('select-all-variables')
  const deselectAllVariables = document.getElementById('deselect-all-variables')
  const variableList = document.getElementById('variable-list')

  // 初始加载
  const loadingEl = document.getElementById('initial-loading')
  const progressFill = document.getElementById('progress-fill')
  const progressText = document.getElementById('progress-text')

  // 文件信息弹窗
  const fileInfoBody = document.getElementById('file-info-body')

  // 变量汇总弹窗
  const explorerVariable = document.getElementById('explorer-variable')
  const explorerBody = document.getElementById('explorer-body')
  const modalRegistry = modals.createRegistry([
    'file-info-modal',
    'usage-guide-modal',
    'explorer-modal',
  ])
  const fileInfoDialog = modalRegistry.get('file-info-modal')
  const usageGuideDialog = modalRegistry.get('usage-guide-modal')
  const explorerDialog = modalRegistry.get('explorer-modal')

  pageSizeSelect.value = String(pageSize)
  initResizeHandle()

  /**
   * 隐藏初始加载界面
   */
  function hideLoading() {
    if (loadingEl)
      loadingEl.style.display = 'none'
  }

  /**
   * 显示初始加载界面
   */
  function showLoading() {
    if (loadingEl) {
      loadingEl.style.display = 'flex'
      progressFill.style.width = '0%'
      progressText.textContent = bootstrap.l10n.readingFile
    }
  }

  /**
   * 更新加载进度
   */
  function setProgress(rowsRead, totalRows) {
    if (!loadingEl)
      return
    const pct = totalRows > 0 ? (rowsRead / totalRows) * 100 : 0
    progressFill.style.width = `${pct.toFixed(1)}%`
    progressText.textContent = formatL10n(
      bootstrap.l10n.LoadingRowsProgress,
      fmtInt(rowsRead),
      fmtInt(totalRows),
      pct.toFixed(0),
    )
  }

  /**
   * 应用宿主发送的初始数据
   */
  function applyInitData(payload) {
    hideHeaderContextMenu()
    if (payload.fileInfo)
      fileInfoState = { ...fileInfoState, ...payload.fileInfo }
    meta = payload.meta
    currentPageRows = payload.page.rows
    pageOffset = payload.page.offset
    totalFiltered = payload.page.totalFiltered
    totalAll = payload.page.totalAll
    visibleColumns = new Set(meta.headers.map((_, i) => i))
    colWidths = {}
    sortSpec = []
    filterQuery = ''
    searchInput.value = ''
    renderSidebar()
    renderTable()
    renderPaginationBar()
    hideLoading()
  }

  // ---------- 宿主消息 ----------

  window.addEventListener('message', (event) => {
    const msg = event.data
    if (msg.requestId && pending.has(msg.requestId)) {
      const p = pending.get(msg.requestId)
      pending.delete(msg.requestId)
      if (msg.error || msg.command === 'filterError') {
        p.reject(new Error(msg.error || bootstrap.l10n.FilterError))
      }
      else {
        p.resolve(msg)
      }
      return
    }
    if (msg.command === 'loadProgress') {
      setProgress(msg.rowsRead, msg.totalRows)
    }
    else if (msg.command === 'initData') {
      applyInitData(msg)
    }
    else if (msg.command === 'showLoading') {
      showLoading()
    }
    else if (msg.command === 'loadError') {
      if (loadingEl) {
        const card = loadingEl.querySelector('#initial-loading-card')
        if (card) {
          card.classList.add('error')
          card.innerHTML = `
            <h2>${bootstrap.l10n.couldNotOpenFile}</h2>
            <div id="loading-error-message">${escapeHtml(msg.error)}</div>
          `
        }
      }
    }
  })
  vscode.postMessage({ command: 'ready' })

  // ---------- 分页 ----------

  /**
   * 请求并渲染指定偏移处的页面
   */
  async function loadPage(offset) {
    showOverlay(true, bootstrap.l10n.loadingPage)
    let succeeded = false
    try {
      const res = await postLatest('page', 'getPage', { offset, limit: pageSize })
      currentPageRows = res.page.rows
      pageOffset = res.page.offset
      totalFiltered = res.page.totalFiltered
      totalAll = res.page.totalAll
      gridContainer.scrollTop = 0
      renderBody()
      renderPaginationBar()
      succeeded = true
    }
    catch (e) {
      if (!e.stale) {
        console.error('getPage failed', e)
        // 真实错误也需要隐藏遮罩。
        succeeded = true
      }
    }
    // 只有当前请求没有被更新请求取代时，才隐藏遮罩。
    if (succeeded)
      showOverlay(false)
  }

  /**
   * 显示或隐藏表格计算遮罩
   */
  function showOverlay(show, message) {
    gridOverlay.style.display = show ? 'flex' : 'none'
    if (show && message) {
      const dom = gridOverlay.querySelector('#grid-overlay-message')
      if (dom)
        dom.textContent = message
    }
  }

  /**
   * 渲染分页栏状态
   */
  function renderPaginationBar() {
    const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize))
    const currentPage = Math.floor(pageOffset / pageSize) + 1
    pageInfo.textContent = formatL10n(bootstrap.l10n.PageInfo, fmtInt(currentPage), fmtInt(totalPages))
    const start = totalFiltered === 0 ? 0 : pageOffset + 1
    const end = Math.min(pageOffset + currentPageRows.length, totalFiltered)
    pageSummary.textContent = totalFiltered === totalAll
      ? formatL10n(bootstrap.l10n.PageSummaryAll, fmtInt(start), fmtInt(end), fmtInt(totalAll))
      : formatL10n(bootstrap.l10n.PageSummaryFiltered, fmtInt(start), fmtInt(end), fmtInt(totalFiltered), fmtInt(totalAll))
    pageFirst.disabled = pagePrev.disabled = currentPage <= 1
    pageLast.disabled = pageNext.disabled = currentPage >= totalPages
    if (fileInfoDialog.isOpen())
      renderFileInfo()
  }

  /**
   * 格式化整数
   */
  function fmtInt(n) {
    return n.toLocaleString()
  }

  /**
   * 格式化 l10n 模板
   */
  function formatL10n(template, ...args) {
    return String(template).replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? '')
  }

  pageFirst.addEventListener('click', () => loadPage(0))
  pagePrev.addEventListener('click', () => loadPage(Math.max(0, pageOffset - pageSize)))
  pageNext.addEventListener('click', () => loadPage(pageOffset + pageSize))
  pageLast.addEventListener('click', () => {
    const lastOffset = Math.max(0, (Math.ceil(totalFiltered / pageSize) - 1) * pageSize)
    loadPage(lastOffset)
  })
  pageSizeSelect.addEventListener('change', () => {
    pageSize = Number.parseInt(pageSizeSelect.value, 10) || 1000
    loadPage(0)
  })

  // ---------- 筛选 ----------

  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter')
      applyFilterAndReload()
  })
  searchInput.addEventListener('input', clearFilterError)
  searchApply.addEventListener('click', applyFilterAndReload)
  searchClear.addEventListener('click', () => {
    searchInput.value = ''
    filterQuery = ''
    applyFilterAndReload()
  })

  /**
   * 应用通用过滤表达式并回到第一页
   */
  async function applyFilterAndReload() {
    filterQuery = searchInput.value
    clearFilterError()
    showOverlay(true, bootstrap.l10n.applyingFilter)
    try {
      const spec = filterQuery.trim() ? { query: filterQuery } : null
      await postLatest('filter', 'setFilter', { spec })
      await loadPage(0)
    }
    catch (e) {
      if (e.stale)
        return
      showFilterError(e.message || String(e))
      showOverlay(false)
    }
  }

  /**
   * 清除通用过滤错误提示
   */
  function clearFilterError() {
    searchInput.classList.remove('error')
    filterError.textContent = ''
  }

  /**
   * 显示通用过滤错误提示
   */
  function showFilterError(msg) {
    searchInput.classList.add('error')
    filterError.textContent = msg
  }

  // ---------- 排序 ----------

  /**
   * 应用排序配置并回到第一页
   */
  async function applySort(spec) {
    sortSpec = spec
    renderHeader()
    showOverlay(true, bootstrap.l10n.sorting)
    try {
      await postLatest('sort', 'setSort', { spec })
      await loadPage(0)
    }
    catch (e) {
      if (e.stale)
        return
      console.error('sort failed', e)
      showOverlay(false)
    }
  }

  /**
   * 处理表头点击排序
   */
  function handleHeaderClick(colIndex, shiftKey) {
    const col = meta.headers[colIndex]
    const existing = sortSpec.findIndex(s => s.col === col)
    if (shiftKey) {
      // Shift 点击：在多列排序中切换当前列。
      if (existing === -1) {
        sortSpec.push({ col, dir: 'asc' })
      }
      else {
        const cur = sortSpec[existing]
        if (cur.dir === 'asc')
          sortSpec[existing] = { col, dir: 'desc' }
        else
          sortSpec.splice(existing, 1)
      }
    }
    else {
      // 普通点击：单列排序，按 asc -> desc -> none 循环。
      if (existing === -1) {
        sortSpec = [{ col, dir: 'asc' }]
      }
      else {
        const cur = sortSpec[existing]
        if (sortSpec.length === 1 && cur.dir === 'asc')
          sortSpec = [{ col, dir: 'desc' }]
        else if (sortSpec.length === 1 && cur.dir === 'desc')
          sortSpec = []
        else
          sortSpec = [{ col, dir: 'asc' }]
      }
    }
    applySort([...sortSpec])
  }

  /**
   * 复制文本到剪贴板
   */
  async function copyText(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text)
        return
      }
    }
    catch {
      // Webview 权限不一定允许 Clipboard API，下面使用兼容方案。
    }

    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }

  /**
   * 重新渲染列显隐相关界面
   */
  function renderColumnVisibility() {
    renderSidebar()
    renderHeader()
    renderBody()
    updateBulkActions()
  }

  /**
   * 设置单列表头菜单排序
   */
  function sortColumnFromMenu(colIndex, dir) {
    const col = meta.headers[colIndex]
    applySort([{ col, dir }])
  }

  /**
   * 清除当前列排序
   */
  function clearColumnSort(colIndex) {
    const col = meta.headers[colIndex]
    applySort(sortSpec.filter(s => s.col !== col))
  }

  /**
   * 隐藏当前列
   */
  function hideColumn(colIndex) {
    visibleColumns.delete(colIndex)
    renderColumnVisibility()
  }

  /**
   * 仅显示当前列
   */
  function showOnlyColumn(colIndex) {
    visibleColumns = new Set([colIndex])
    renderColumnVisibility()
  }

  /**
   * 重置当前列宽
   */
  function resetColumnWidth(colIndex) {
    const col = meta.headers[colIndex]
    delete colWidths[col]
    renderHeader()
    renderBody()
  }

  /**
   * 隐藏表头右键菜单
   */
  function hideHeaderContextMenu() {
    if (headerContextMenu)
      headerContextMenu.remove()
    headerContextMenu = null
  }

  /**
   * 关闭当前打开的弹窗。
   */
  function closeOpenModal() {
    return modalRegistry.closeOpen()
  }

  /**
   * 构建表头右键菜单项
   */
  function createHeaderMenuItem(label, action, disabled = false) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = label
    btn.disabled = disabled
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (disabled)
        return
      hideHeaderContextMenu()
      action()
    })
    return btn
  }

  /**
   * 构建表头右键菜单分隔线
   */
  function createHeaderMenuSeparator() {
    const separator = document.createElement('div')
    separator.className = 'context-menu-separator'
    return separator
  }

  /**
   * 显示表头右键菜单
   */
  function showHeaderContextMenu(colIndex, clientX, clientY) {
    hideHeaderContextMenu()

    const header = meta.headers[colIndex]
    const label = meta.labels[colIndex]
    const sorted = sortSpec.some(s => s.col === header)
    const hasCustomWidth = colWidths[header] != null
    const onlyColumnVisible = visibleColumns.size === 1 && visibleColumns.has(colIndex)

    const menu = document.createElement('div')
    menu.className = 'context-menu'
    menu.id = 'header-context-menu'
    menu.append(
      createHeaderMenuItem(bootstrap.l10n.CopyVariableName, () => void copyText(header)),
      createHeaderMenuItem(bootstrap.l10n.CopyVariableLabel, () => void copyText(label), !label),
      createHeaderMenuSeparator(),
      createHeaderMenuItem(bootstrap.l10n.SortAscending, () => sortColumnFromMenu(colIndex, 'asc')),
      createHeaderMenuItem(bootstrap.l10n.SortDescending, () => sortColumnFromMenu(colIndex, 'desc')),
      createHeaderMenuItem(bootstrap.l10n.ClearColumnSort, () => clearColumnSort(colIndex), !sorted),
      createHeaderMenuSeparator(),
      createHeaderMenuItem(bootstrap.l10n.HideColumn, () => hideColumn(colIndex), visibleColumns.size <= 1),
      createHeaderMenuItem(bootstrap.l10n.ShowOnlyThisColumn, () => showOnlyColumn(colIndex), onlyColumnVisible),
      createHeaderMenuItem(bootstrap.l10n.ResetColumnWidth, () => resetColumnWidth(colIndex), !hasCustomWidth),
      createHeaderMenuSeparator(),
      createHeaderMenuItem(bootstrap.l10n.ExploreVariableStatistics, () => openExplorer(colIndex)),
    )

    document.body.appendChild(menu)
    const rect = menu.getBoundingClientRect()
    const left = Math.max(4, Math.min(clientX, window.innerWidth - rect.width - 4))
    const top = Math.max(4, Math.min(clientY, window.innerHeight - rect.height - 4))
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
    headerContextMenu = menu
  }

  /**
   * 显示导出菜单
   */
  function showExportMenu(anchor) {
    hideHeaderContextMenu()

    const menu = document.createElement('div')
    menu.className = 'context-menu'
    menu.append(
      createHeaderMenuItem(bootstrap.l10n.ExportAsCsv, () => void exportTableData('csv')),
      createHeaderMenuItem(bootstrap.l10n.ExportAsExcel, () => void exportTableData('xlsx')),
    )

    document.body.appendChild(menu)
    const anchorRect = anchor.getBoundingClientRect()
    const rect = menu.getBoundingClientRect()
    const left = Math.max(4, Math.min(anchorRect.right - rect.width, window.innerWidth - rect.width - 4))
    const top = Math.max(4, Math.min(anchorRect.bottom + 4, window.innerHeight - rect.height - 4))
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
    headerContextMenu = menu
  }

  /**
   * 导出当前表格视图
   */
  async function exportTableData(format) {
    if (!meta)
      return
    const columns = meta.headers.filter((_, i) => visibleColumns.has(i))
    showOverlay(true, bootstrap.l10n.exportingData)
    try {
      await postRequest('exportData', { format, columns })
    }
    catch (e) {
      console.error('export failed', e)
    }
    finally {
      showOverlay(false)
    }
  }

  document.addEventListener('click', (e) => {
    if (!headerContextMenu)
      return
    if (e.target instanceof Node && headerContextMenu.contains(e.target))
      return
    hideHeaderContextMenu()
  })

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape')
      return

    if (closeOpenModal()) {
      hideHeaderContextMenu()
      e.preventDefault()
      e.stopPropagation()
      return
    }

    if (headerContextMenu) {
      hideHeaderContextMenu()
      e.preventDefault()
    }
  })

  document.addEventListener('contextmenu', (e) => {
    if (!headerContextMenu)
      return
    if (e.target instanceof Element && e.target.closest('thead th, .context-menu'))
      return
    hideHeaderContextMenu()
  })

  window.addEventListener('blur', hideHeaderContextMenu)
  window.addEventListener('resize', hideHeaderContextMenu)

  // ---------- 表格渲染 ----------

  /**
   * 重新渲染完整表格
   */
  function renderTable() {
    gridContainer.scrollTop = 0
    renderHeader()
    renderBody()
  }

  /**
   * 获取默认列宽
   */
  function defaultColWidth(i) {
    const t = meta.types && meta.types[i]
    const isStr = typeof t === 'string' && t.startsWith('str')
    return isStr ? DEFAULT_STR_COL_WIDTH : DEFAULT_COL_WIDTH
  }

  /**
   * 渲染表头
   */
  function renderHeader() {
    tableHead.innerHTML = ''
    const tr = document.createElement('tr')
    meta.headers.forEach((header, i) => {
      if (!visibleColumns.has(i))
        return
      const th = document.createElement('th')
      th.dataset.col = header
      const w = colWidths[header] ?? defaultColWidth(i)
      th.style.width = `${w}px`
      const sortInfo = sortSpec.findIndex(s => s.col === header)
      const sortDir = sortInfo >= 0 ? sortSpec[sortInfo].dir : null
      const sortIdx = sortInfo >= 0 && sortSpec.length > 1 ? sortInfo + 1 : null
      th.innerHTML = `<span>${escapeHtml(header)}</span>`
      th.title = meta.labels[i] || header
      if (sortDir) {
        th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc')
        if (sortIdx) {
          th.setAttribute('data-sort', sortIdx)
        }
      }
      th.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.closest('.resize-handle'))
          return
        handleHeaderClick(i, e.shiftKey)
      })
      th.addEventListener('contextmenu', (e) => {
        if (e.target instanceof Element && e.target.closest('.resize-handle'))
          return
        e.preventDefault()
        e.stopPropagation()
        showHeaderContextMenu(i, e.clientX, e.clientY)
      })
      tr.appendChild(th)
    })
    tableHead.appendChild(tr)
    initColumnResize()
  }

  /**
   * 计算当前可见列数
   */
  function visibleColCount() {
    let n = 0
    for (let c = 0; c < meta.headers.length; c++) {
      if (visibleColumns.has(c))
        n++
    }
    return n
  }

  /**
   * 构建单行 DOM
   */
  function buildRow(rowData) {
    const tr = document.createElement('tr')
    for (let c = 0; c < meta.headers.length; c++) {
      if (!visibleColumns.has(c))
        continue
      const td = document.createElement('td')
      const rawVal = rowData[c]
      if (rawVal === null || rawVal === undefined) {
        td.textContent = ''
        td.classList.add('cell-missing')
      }
      else {
        td.textContent = String(rawVal)
      }
      tr.appendChild(td)
    }
    return tr
  }

  /**
   * 构建虚拟滚动占位行
   */
  function spacerRow(height, colspan) {
    const tr = document.createElement('tr')
    tr.className = 'v-spacer'
    const td = document.createElement('td')
    td.colSpan = colspan
    td.style.padding = '0'
    td.style.border = 'none'
    td.style.height = `${height}px`
    tr.appendChild(td)
    return tr
  }

  /**
   * 渲染视口附近的表格行
   */
  function renderBody() {
    const total = currentPageRows.length
    if (total === 0) {
      tableBody.innerHTML = ''
      return
    }

    const colspan = Math.max(1, visibleColCount())
    const viewportH = gridContainer.clientHeight || 600
    const scrollTop = gridContainer.scrollTop

    let start = Math.floor(scrollTop / estRowHeight) - ROW_OVERSCAN
    if (start < 0)
      start = 0
    const visibleCount = Math.ceil(viewportH / estRowHeight) + ROW_OVERSCAN * 2
    let end = start + visibleCount
    if (end > total)
      end = total

    const topH = start * estRowHeight
    const bottomH = (total - end) * estRowHeight

    const fragment = document.createDocumentFragment()
    if (topH > 0)
      fragment.appendChild(spacerRow(topH, colspan))
    for (let r = start; r < end; r++) {
      fragment.appendChild(buildRow(currentPageRows[r]))
    }
    if (bottomH > 0)
      fragment.appendChild(spacerRow(bottomH, colspan))

    tableBody.innerHTML = ''
    tableBody.appendChild(fragment)

    // 使用真实渲染行修正行高估计，必要时重绘一次可见窗口。
    const sampleRow = tableBody.querySelector('tr:not(.v-spacer)')
    if (sampleRow) {
      const h = sampleRow.getBoundingClientRect().height
      if (h > 0 && Math.abs(h - estRowHeight) > 1) {
        estRowHeight = h
        renderBodyWindow()
      }
    }
  }

  /**
   * 重绘可见行窗口
   */
  function renderBodyWindow() {
    if (!meta || currentPageRows.length === 0)
      return
    renderBody()
  }

  gridContainer.addEventListener('scroll', () => {
    if (virtScrollScheduled)
      return
    virtScrollScheduled = true
    requestAnimationFrame(() => {
      virtScrollScheduled = false
      renderBodyWindow()
    })
  })

  /**
   * 转义 HTML 文本
   */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      '\'': '&#39;',
    })[c])
  }

  // ---------- 侧边栏 ----------

  /**
   * 渲染变量列表
   */
  function renderSidebar() {
    variableList.innerHTML = ''
    meta.headers.forEach((header, i) => {
      const label = meta.labels[i]
      const div = document.createElement('div')
      div.className = 'variable-item'

      const info = document.createElement('div')
      info.className = 'variable-info'

      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = visibleColumns.has(i)
      checkbox.addEventListener('change', (e) => {
        if (e.target.checked)
          visibleColumns.add(i)
        else
          visibleColumns.delete(i)
        renderHeader()
        renderBody()
        updateBulkActions()
      })

      const text = document.createElement('label')
      text.textContent = header + (label ? ` (${label})` : '')
      text.title = label || header
      text.onclick = () => checkbox.click()

      info.appendChild(checkbox)
      info.appendChild(text)

      const btn = document.createElement('button')
      btn.className = 'outline'
      btn.textContent = bootstrap.l10n.Explore
      btn.onclick = () => openExplorer(i)

      div.appendChild(info)
      div.appendChild(btn)
      variableList.appendChild(div)
    })
    updateBulkActions()
  }

  /**
   * 更新批量选择按钮可见性
   */
  function updateBulkActions() {
    if (!meta)
      return
    const total = meta.headers.length
    const selected = visibleColumns.size
    selectAllVariables.style.display = selected < total ? '' : 'none'
    deselectAllVariables.style.display = selected > 0 ? '' : 'none'
  }

  selectAllVariables.addEventListener('click', () => {
    visibleColumns = new Set(meta.headers.map((_, i) => i))
    renderSidebar()
    renderHeader()
    renderBody()
  })
  deselectAllVariables.addEventListener('click', () => {
    visibleColumns = new Set()
    renderSidebar()
    renderHeader()
    renderBody()
  })

  variableSearch.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase()
    variableList.querySelectorAll('.variable-item').forEach((item) => {
      item.style.display = item.textContent.toLowerCase().includes(query) ? '' : 'none'
    })
  })

  // ---------- 顶部工具栏 ----------

  refreshData.addEventListener('click', () => {
    vscode.postMessage({ command: 'refresh' })
  })
  exportData.addEventListener('click', (e) => {
    e.stopPropagation()
    showExportMenu(exportData)
  })
  toggleSidebar.addEventListener('click', () => {
    sidebarVisible = !sidebarVisible
    layoutContainer.classList.toggle('sidebar-hidden', !sidebarVisible)
  })
  sidebarPositionBtn.addEventListener('click', () => {
    sidebarPosition = sidebarPosition === 'right' ? 'bottom' : 'right'
    layoutContainer.classList.toggle('sidebar-bottom', sidebarPosition === 'bottom')
  })

  // ---------- 文件信息弹窗 ----------

  fileInfo.addEventListener('click', () => {
    renderFileInfo()
    fileInfoDialog.show()
  })

  // ---------- 使用说明弹窗 ----------

  usageGuide.addEventListener('click', () => {
    usageGuideDialog.show()
  })

  /**
   * 渲染文件信息弹窗内容
   */
  function renderFileInfo() {
    const variableCount = meta ? meta.headers.length : 0
    const release = meta && meta.release ? meta.release : bootstrap.l10n.Unknown
    const byteOrder = meta && meta.byteOrder ? meta.byteOrder : bootstrap.l10n.Unknown
    const details = [
      [bootstrap.l10n.FileName, fileInfoState.fileName],
      [bootstrap.l10n.FilePath, fileInfoState.filePath],
      [bootstrap.l10n.FileSize, fmtBytes(fileInfoState.fileSize)],
      [bootstrap.l10n.LastUpdated, fileInfoState.lastModified],
      [bootstrap.l10n.StataRelease, release],
      [bootstrap.l10n.ByteOrder, byteOrder],
      [bootstrap.l10n.DataVolume, fmtInt(totalAll)],
      [bootstrap.l10n.VariablesCount, fmtInt(variableCount)],
    ]
    fileInfoBody.innerHTML = `
      <div class="file-info-grid">
        ${details.map(([label, value]) => `
          <div class="file-info-label">${escapeHtml(label)}</div>
          <div class="file-info-value" title="${escapeHtml(value)}">${escapeHtml(value)}</div>
        `).join('')}
      </div>
    `
  }

  /**
   * 格式化文件大小
   */
  function fmtBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
      return bootstrap.l10n.Unknown
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024
      unitIndex++
    }
    const formatted = unitIndex === 0
      ? fmtInt(value)
      : value.toLocaleString(undefined, { maximumFractionDigits: 1 })
    return `${formatted} ${units[unitIndex]}`
  }

  // ---------- 变量汇总弹窗 ----------

  /** 当前汇总变量名 */
  let explorerVar = null
  /** 变量汇总局部过滤表达式 */
  let explorerExpr = ''
  /** 是否继承表格通用过滤 */
  let explorerInheritGeneral = false

  /**
   * 打开变量汇总弹窗
   */
  async function openExplorer(varIndex) {
    explorerVar = meta.headers[varIndex]
    const varLabel = meta.labels[varIndex]
    explorerExpr = ''
    explorerInheritGeneral = false
    explorerVariable.textContent = explorerVar + (varLabel ? ` - ${varLabel}` : '')
    explorerDialog.show()
    await runTabulate()
  }

  /**
   * 请求并渲染变量汇总结果
   */
  async function runTabulate() {
    // 先渲染过滤面板和结果占位，让用户能继续编辑过滤表达式。
    explorerBody.innerHTML = `${renderExplorerFilterPanel()}<div id="explorer-result"><div class="explorer-loading">${bootstrap.l10n.Computing}</div></div>`
    wireExplorerFilterPanel()

    const resultEl = document.getElementById('explorer-result')
    try {
      const res = await postRequest('tabulate', {
        varName: explorerVar,
        explorerExpr,
        inheritGeneral: explorerInheritGeneral,
      })
      if (res.kind === 'filterError') {
        showExplorerFilterError(res.error)
        resultEl.innerHTML = `<div class="explorer-error">${bootstrap.l10n.FixFilterToComputeResults}</div>`
        return
      }
      clearExplorerFilterError()
      resultEl.innerHTML = renderTabulateResult(res.result, explorerVar, res.scopeN)
    }
    catch (e) {
      resultEl.innerHTML = `<div class="explorer-error">${bootstrap.l10n.ErrorPrefix} ${escapeHtml(String(e.message || e))}</div>`
    }
  }

  /**
   * 渲染变量汇总过滤面板
   */
  function renderExplorerFilterPanel() {
    const generalActive = totalFiltered !== totalAll
    const inheritDisabled = !generalActive
    const inheritChecked = explorerInheritGeneral && generalActive
    const generalNote = generalActive
      ? formatL10n(bootstrap.l10n.GeneralFilterNote, fmtInt(totalFiltered), fmtInt(totalAll))
      : bootstrap.l10n.NoGeneralFilterActive
    return `
      <div class="explorer-filter-panel">
        <div class="explorer-filter-row">
          <input id="explorer-filter-input" class="bordered" type="text" placeholder="${bootstrap.l10n.filterForTabulationPlaceholder}" value="${escapeHtml(explorerExpr)}">
          <button id="explorer-filter-apply">${bootstrap.l10n.Apply}</button>
          <button id="explorer-filter-clear">${bootstrap.l10n.Clear}</button>
        </div>
        <div class="explorer-filter-row explorer-filter-options">
          <label>
            <input id="explorer-inherit" type="checkbox" ${inheritChecked ? 'checked' : ''} ${inheritDisabled ? 'disabled' : ''}>
            <span>${bootstrap.l10n.combineWithGeneralFilter}</span>
            <span class="explorer-inherit-note">${generalNote}</span>
          </label>
          <span id="explorer-filter-error"></span>
        </div>
      </div>
    `
  }

  /**
   * 绑定变量汇总过滤面板事件
   */
  function wireExplorerFilterPanel() {
    const input = document.getElementById('explorer-filter-input')
    const apply = document.getElementById('explorer-filter-apply')
    const clear = document.getElementById('explorer-filter-clear')
    const inherit = document.getElementById('explorer-inherit')
    const onApply = () => {
      explorerExpr = input.value
      runTabulate()
    }
    apply.addEventListener('click', onApply)
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter')
        onApply()
    })
    input.addEventListener('input', clearExplorerFilterError)
    clear.addEventListener('click', () => {
      explorerExpr = ''
      runTabulate()
    })
    if (inherit && !inherit.disabled) {
      inherit.addEventListener('change', (e) => {
        explorerInheritGeneral = e.target.checked
        runTabulate()
      })
    }
  }

  /**
   * 显示变量汇总局部过滤错误
   */
  function showExplorerFilterError(msg) {
    const input = document.getElementById('explorer-filter-input')
    const err = document.getElementById('explorer-filter-error')
    if (input)
      input.classList.add('error')
    if (err)
      err.textContent = msg
  }

  /**
   * 清除变量汇总局部过滤错误
   */
  function clearExplorerFilterError() {
    const input = document.getElementById('explorer-filter-input')
    const err = document.getElementById('explorer-filter-error')
    if (input)
      input.classList.remove('error')
    if (err)
      err.textContent = ''
  }

  /**
   * 格式化数值
   */
  function fmtNum(n) {
    if (n === null || n === undefined || Number.isNaN(n))
      return '—'
    if (!Number.isFinite(n))
      return String(n)
    if (Number.isInteger(n) && Math.abs(n) < 1e15)
      return n.toLocaleString()
    const abs = Math.abs(n)
    if (abs !== 0 && (abs < 1e-3 || abs >= 1e9))
      return n.toExponential(3)
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
  }

  /**
   * 渲染变量汇总结果
   */
  function renderTabulateResult(r, varName, scopeN) {
    const total = r.nValid + r.nMissing
    const missingPct = total > 0 ? (r.nMissing / total * 100).toFixed(1) : '0.0'
    let badge, badgeClass
    if (r.kind === 'continuous') {
      badge = bootstrap.l10n.Continuous
      badgeClass = 'primary'
    }
    else if (r.kind === 'discrete') {
      badge = bootstrap.l10n.Discrete
      badgeClass = 'secondary'
    }
    else {
      badge = bootstrap.l10n.StringType
      badgeClass = 'tertiary'
    }

    let html = `<div class="explorer-scope-info"><span class="badge ${badgeClass}">${badge}</span>`
    if (typeof scopeN === 'number') {
      html += `<span>${formatL10n(bootstrap.l10n.TabulatingScope, fmtNum(scopeN), fmtNum(totalAll))}</span>`
    }
    html += `</div>`
    html += `<div class="explorer-section"><h3>${bootstrap.l10n.General}</h3><div class="stats-grid">`
    html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.ValidN}</div><div class="stat-value">${fmtNum(r.nValid)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Missing}</div><div class="stat-value">${fmtNum(r.nMissing)} (${missingPct}%)</div></div>`
    if (r.nUnique !== undefined && r.nUnique >= 0) {
      html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Unique}</div><div class="stat-value">${fmtNum(r.nUnique)}</div></div>`
    }
    else if (r.kind === 'continuous' && r.nUnique === -1) {
      html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Unique}</div><div class="stat-value">&gt; 200</div></div>`
    }
    html += '</div></div>'
    if (r.kind === 'discrete')
      html += renderDiscrete(r)
    else if (r.kind === 'continuous')
      html += renderContinuous(r)
    else
      html += renderStringTop(r)
    return html
  }

  /**
   * 渲染离散变量频数表
   */
  function renderDiscrete(r) {
    const maxFreq = r.entries.reduce((m, e) => Math.max(m, e.freq), 0)
    let html = `<div class="explorer-section"><h3>${bootstrap.l10n.FrequencyDistribution}</h3>`
    html += '<table class="flat">'
    html += `<thead><tr><th>${bootstrap.l10n.Value}</th><th>${bootstrap.l10n.Label}</th><th style="text-align: right">${bootstrap.l10n.Freq}</th><th style="text-align: right">${bootstrap.l10n.Percent}</th><th style="text-align: right">${bootstrap.l10n.CumPercent}</th><th style="width: 162px">${bootstrap.l10n.Bar}</th></tr></thead><tbody>`
    for (const e of r.entries) {
      const pctOfMax = maxFreq > 0 ? (e.freq / maxFreq * 100) : 0
      const lbl = e.label !== undefined && e.label !== null ? escapeHtml(e.label) : ''
      html += `<tr>
          <td>${escapeHtml(String(e.value))}</td>
          <td>${lbl}</td>
          <td style="text-align: right">${fmtNum(e.freq)}</td>
          <td style="text-align: right">${e.pct.toFixed(2)}</td>
          <td style="text-align: right">${e.cum.toFixed(2)}</td>
          <td><div class="bar-chart"><div class="bar-fill" style="width: ${pctOfMax}%"></div></div></td>
        </tr>`
    }
    html += '</tbody></table></div>'
    return html
  }

  /**
   * 渲染连续变量统计表与图表
   */
  function renderContinuous(r) {
    let html = ''
    html += `<div class="explorer-section"><h3>${bootstrap.l10n.DescriptiveStatistics}</h3><div class="stats-grid">`
    html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Mean}</div><div class="stat-value">${fmtNum(r.mean)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.StdDev}</div><div class="stat-value">${fmtNum(r.sd)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Min}</div><div class="stat-value">${fmtNum(r.min)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Max}</div><div class="stat-value">${fmtNum(r.max)}</div></div>`
    html += '</div></div>'
    html += `<div class="explorer-section"><h3>${bootstrap.l10n.Percentiles}</h3><div class="stats-grid">`
    html += `<div class="stat-item"><div class="stat-label">P1</div><div class="stat-value">${fmtNum(r.p1)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">P25</div><div class="stat-value">${fmtNum(r.p25)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Median}</div><div class="stat-value">${fmtNum(r.median)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">P75</div><div class="stat-value">${fmtNum(r.p75)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">P99</div><div class="stat-value">${fmtNum(r.p99)}</div></div>`
    html += '</div></div>'
    const chart = r.chart
    if (chart) {
      const title = chart.type === 'bars' ? bootstrap.l10n.DistributionPerValue : bootstrap.l10n.Histogram
      html += `<div class="explorer-section"><h3>${title}</h3>`
      if (chart.type === 'bars')
        html += renderValueBarsSVG(chart.bars)
      else
        html += renderHistogramSVG(chart.bins)
      html += '</div>'
    }
    return html
  }

  /**
   * 渲染整数离散值柱状 SVG
   */
  function renderValueBarsSVG(bars) {
    if (!bars || bars.length === 0)
      return `<div>${bootstrap.l10n.NoData}</div>`
    const maxCount = bars.reduce((m, b) => Math.max(m, b.count), 0)
    const W = 560
    const H = 220
    const padL = 50
    const padR = 10
    const padT = 10
    const padB = 30
    const plotW = W - padL - padR
    const plotH = H - padT - padB
    const slot = plotW / bars.length
    const barW = Math.max(1, slot - 1)
    let svg = `<svg class="histogram" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH - (plotH * i / 4)
      const v = Math.round(maxCount * i / 4)
      svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="hist-grid"/>`
      svg += `<text x="${padL - 6}" y="${y + 4}" class="hist-axis" text-anchor="end">${v}</text>`
    }
    bars.forEach((b, i) => {
      const h = maxCount > 0 ? (b.count / maxCount) * plotH : 0
      const x = padL + i * slot + (slot - barW) / 2
      const y = padT + plotH - h
      const tt = formatL10n(bootstrap.l10n.ValueCountTitle, fmtNum(b.value), fmtNum(b.count))
      svg += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" class="hist-bar"><title>${escapeHtml(tt)}</title></rect>`
    })
    const nLabels = Math.min(6, bars.length)
    const step = bars.length > 1 ? (bars.length - 1) / Math.max(1, nLabels - 1) : 0
    for (let k = 0; k < nLabels; k++) {
      const i = Math.round(k * step)
      const x = padL + i * slot + slot / 2
      svg += `<text x="${x}" y="${H - 8}" class="hist-axis" text-anchor="middle">${fmtNum(bars[i].value)}</text>`
    }
    svg += '</svg>'
    return svg
  }

  /**
   * 渲染连续变量直方图 SVG
   */
  function renderHistogramSVG(bins) {
    if (!bins || bins.length === 0)
      return `<div>${bootstrap.l10n.NoData}</div>`
    const maxCount = bins.reduce((m, b) => Math.max(m, b.count), 0)
    const W = 560
    const H = 220
    const padL = 50
    const padR = 10
    const padT = 10
    const padB = 30
    const plotW = W - padL - padR
    const plotH = H - padT - padB
    const barW = plotW / bins.length
    let svg = `<svg class="histogram" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH - (plotH * i / 4)
      const v = Math.round(maxCount * i / 4)
      svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="hist-grid"/>`
      svg += `<text x="${padL - 6}" y="${y + 4}" class="hist-axis" text-anchor="end">${v}</text>`
    }
    bins.forEach((b, i) => {
      const h = maxCount > 0 ? (b.count / maxCount) * plotH : 0
      const x = padL + i * barW
      const y = padT + plotH - h
      const tt = formatL10n(bootstrap.l10n.HistogramBinCountTitle, fmtNum(b.lo), fmtNum(b.hi), fmtNum(b.count))
      svg += `<rect x="${x + 0.5}" y="${y}" width="${Math.max(0, barW - 1)}" height="${h}" class="hist-bar"><title>${escapeHtml(tt)}</title></rect>`
    })
    const xLabels = [0, Math.floor(bins.length / 2), bins.length - 1]
    xLabels.forEach((i) => {
      const x = padL + i * barW + barW / 2
      svg += `<text x="${x}" y="${H - 8}" class="hist-axis" text-anchor="middle">${fmtNum(bins[i].lo)}</text>`
    })
    svg += '</svg>'
    return svg
  }

  /**
   * 渲染字符串变量 Top 值表
   */
  function renderStringTop(r) {
    const maxFreq = r.topValues.reduce((m, e) => Math.max(m, e.freq), 0)
    let html = `<div class="explorer-section"><h3>${bootstrap.l10n.Top10Values}</h3>`
    html += '<table class="flat">'
    html += `<thead><tr><th>${bootstrap.l10n.Value}</th><th style="text-align: right">${bootstrap.l10n.Freq}</th><th style="text-align: right">${bootstrap.l10n.Percent}</th><th style="width: 162px">${bootstrap.l10n.Bar}</th></tr></thead><tbody>`
    for (const e of r.topValues) {
      const pctOfMax = maxFreq > 0 ? (e.freq / maxFreq * 100) : 0
      html += `<tr>
          <td>${escapeHtml(e.value)}</td>
          <td style="text-align: right">${fmtNum(e.freq)}</td>
          <td style="text-align: right">${e.pct.toFixed(2)}</td>
          <td><div class="bar-chart"><div class="bar-fill" style="width: ${pctOfMax}%"></div></div></td>
        </tr>`
    }
    html += '</tbody></table></div>'
    return html
  }

  // ---------- 尺寸拖拽 ----------

  /**
   * 初始化侧边栏拖拽手柄
   */
  function initResizeHandle() {
    let isResizing = false
    let startX = 0
    let startY = 0
    let startW = 0
    let startH = 0
    let resizeMode = 'horizontal'
    let pendingSize = 0
    let resizeRaf = 0

    const applyPanelSize = (size) => {
      const prop = resizeMode === 'horizontal' ? '--sidebar-width' : '--sidebar-height'
      layoutContainer.style.setProperty(prop, `${size}px`)
    }

    const queuePanelSize = (size) => {
      pendingSize = size
      if (resizeRaf)
        return
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0
        applyPanelSize(pendingSize)
      })
    }

    const finishResize = () => {
      if (!isResizing)
        return
      if (resizeRaf) {
        cancelAnimationFrame(resizeRaf)
        resizeRaf = 0
        applyPanelSize(pendingSize)
      }
      isResizing = false
      layoutContainer.classList.remove('is-resizing')
    }

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true
      resizeMode = sidebarPosition === 'right' ? 'horizontal' : 'vertical'
      startX = e.clientX
      startY = e.clientY
      if (resizeMode === 'horizontal')
        startW = sidebar.getBoundingClientRect().width
      else
        startH = sidebar.getBoundingClientRect().height
      pendingSize = resizeMode === 'horizontal' ? startW : startH
      layoutContainer.classList.add('is-resizing')
      e.preventDefault()
    })
    document.addEventListener('mousemove', (e) => {
      if (!isResizing)
        return
      if (resizeMode === 'horizontal') {
        const delta = startX - e.clientX
        queuePanelSize(Math.max(150, Math.min(600, startW + delta)))
      }
      else {
        const delta = startY - e.clientY
        queuePanelSize(Math.max(100, Math.min(500, startH + delta)))
      }
    })
    document.addEventListener('mouseup', finishResize)
    window.addEventListener('blur', finishResize)
  }

  /** 正在调整宽度的列 */
  let resizingCol = null
  /** 列宽拖拽起始 X 坐标 */
  let resizeStartX = 0
  /** 列宽拖拽起始宽度 */
  let resizeStartWidth = 0
  /** 是否已绑定列宽拖拽全局事件 */
  let columnResizeListenersReady = false

  /**
   * 结束列宽拖拽
   */
  function finishColumnResize() {
    if (!resizingCol)
      return
    resizingCol.classList.remove('is-resizing')
    resizingCol = null
  }

  /**
   * 初始化列宽拖拽手柄
   */
  function initColumnResize() {
    const ths = tableHead.querySelectorAll('th')
    ths.forEach((th) => {
      if (th.querySelector('.resize-handle'))
        return
      const handle = document.createElement('div')
      handle.className = 'resize-handle'
      th.appendChild(handle)
      handle.addEventListener('mousedown', (e) => {
        resizingCol = th
        resizeStartX = e.clientX
        resizeStartWidth = th.offsetWidth
        th.classList.add('is-resizing')
        e.stopPropagation()
        e.preventDefault()
      })
    })
    if (columnResizeListenersReady)
      return
    columnResizeListenersReady = true
    document.addEventListener('mousemove', (e) => {
      if (!resizingCol)
        return
      const delta = e.clientX - resizeStartX
      const w = Math.max(40, resizeStartWidth + delta)
      resizingCol.style.width = `${w}px`
      // 记录用户列宽，避免排序、筛选、分页重绘后丢失。
      const col = resizingCol.dataset.col
      if (col != null)
        colWidths[col] = w
    })
    document.addEventListener('mouseup', finishColumnResize)
    window.addEventListener('blur', finishColumnResize)
  }
})()
