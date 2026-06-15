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
  /** 值标签显示模式 */
  let valueLabelDisplayMode = 'raw'
  /** 可用的值标签显示模式 */
  const VALUE_LABEL_DISPLAY_MODES = new Set(['raw', 'label', 'both'])
  /** 当前页行数据 */
  let currentPageRows = []
  /** 当前页每行对应的原始文件行号（0 基） */
  let currentPageRowIndices = []
  /** 当前页中被选中的行下标 */
  let selectedPageRow = null
  /** 行详情表默认列宽 */
  const ROW_DETAIL_DEFAULT_COLUMN_WIDTHS = [180, 220, 220, 220]
  /** 行详情表列宽缓存 */
  let rowDetailColumnWidths = ROW_DETAIL_DEFAULT_COLUMN_WIDTHS.slice()
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
  /** 仅显示值标签时的默认列宽 */
  const DEFAULT_LABEL_COL_WIDTH = 220
  /** 同时显示原始值和值标签时的默认列宽 */
  const DEFAULT_VALUE_LABEL_COL_WIDTH = 280
  /** 多列排序配置 */
  let sortSpec = []
  /** 当前通用过滤表达式 */
  let filterQuery = ''
  /** 筛选输入助手本地存储键 */
  const FILTER_ASSIST_STORAGE_KEY = 'stataPreview.filterAssist.v1'
  /** 最多保留的历史表达式数量 */
  const FILTER_HISTORY_LIMIT = 30
  /** 最多保留的常用筛选数量 */
  const SAVED_FILTER_LIMIT = 50
  /** 可自动补全的筛选函数。 */
  const FILTER_FUNCTION_COMPLETIONS = [
    { name: 'missing', signature: 'missing(var)', template: 'missing()', cursorOffset: 8, group: 'set', variableTemplate: 'missing({var})', description: bootstrap.l10n.MissingFunctionDescription },
    { name: 'inlist', signature: 'inlist(var, ...)', template: 'inlist(, )', cursorOffset: 7, group: 'set', variableTemplate: 'inlist({var}, {cursor})', description: bootstrap.l10n.InlistFunctionDescription },
    { name: 'inrange', signature: 'inrange(var, lo, hi)', template: 'inrange(, , )', cursorOffset: 8, group: 'set', variableTemplate: 'inrange({var}, {cursor}, )', description: bootstrap.l10n.InrangeFunctionDescription },
    { name: 'contains', signature: 'contains(text, sub)', template: 'contains(, "")', cursorOffset: 9, group: 'string', variableTemplate: 'contains({var}, "{cursor}")', description: bootstrap.l10n.ContainsFunctionDescription },
    { name: 'strpos', signature: 'strpos(text, sub)', template: 'strpos(, "")', cursorOffset: 7, group: 'string', variableTemplate: 'strpos({var}, "{cursor}")', description: bootstrap.l10n.StrposFunctionDescription },
    { name: 'regexm', signature: 'regexm(text, pattern)', template: 'regexm(, "")', cursorOffset: 7, group: 'string', variableTemplate: 'regexm({var}, "{cursor}")', description: bootstrap.l10n.RegexmFunctionDescription },
    { name: 'lower', signature: 'lower(text)', template: 'lower()', cursorOffset: 6, group: 'string', variableTemplate: 'lower({var})', description: bootstrap.l10n.LowerFunctionDescription },
    { name: 'upper', signature: 'upper(text)', template: 'upper()', cursorOffset: 6, group: 'string', variableTemplate: 'upper({var})', description: bootstrap.l10n.UpperFunctionDescription },
    { name: 'trim', signature: 'trim(text)', template: 'trim()', cursorOffset: 5, group: 'string', variableTemplate: 'trim({var})', description: bootstrap.l10n.TrimFunctionDescription },
    { name: 'length', signature: 'length(text)', template: 'length()', cursorOffset: 7, group: 'string', variableTemplate: 'length({var})', description: bootstrap.l10n.LengthFunctionDescription },
    { name: 'year', signature: 'year(date)', template: 'year()', cursorOffset: 5, group: 'date', variableTemplate: 'year({var})', description: bootstrap.l10n.YearFunctionDescription },
    { name: 'month', signature: 'month(date)', template: 'month()', cursorOffset: 6, group: 'date', variableTemplate: 'month({var})', description: bootstrap.l10n.MonthFunctionDescription },
    { name: 'day', signature: 'day(date)', template: 'day()', cursorOffset: 4, group: 'date', variableTemplate: 'day({var})', description: bootstrap.l10n.DayFunctionDescription },
  ]
  /** 筛选工具图标。 */
  const FILTER_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24">
    <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5h16M7 12h10m-7 7h4"/>
  </svg>`
  /** 筛选历史与常用筛选。 */
  let filterAssistState = { history: [], saved: [] }
  /** 当前打开的筛选助手目标。 */
  let activeFilterAssistTarget = null
  /** 主筛选框的筛选助手目标。 */
  let mainFilterAssistTarget = null
  /** 侧边栏是否显示 */
  let sidebarVisible = true
  /** 侧边栏位置 */
  let sidebarPosition = 'right'
  /** 表头右键菜单 */
  let headerContextMenu = null
  /** 变量搜索用的规范化文本缓存 */
  let variableSearchText = []
  /** 当前变量搜索表达式 */
  let variableSearchQuery = ''
  /** 当前变量搜索命中的变量下标 */
  let filteredVariableIndices = []
  /** 变量项高度估计值，首次渲染后会用真实高度修正 */
  let estVariableItemHeight = 40
  /** 变量列表视口上下额外渲染的项数 */
  const VARIABLE_OVERSCAN = 8
  /** 是否已有一次变量列表滚动重绘排队 */
  let variableScrollScheduled = false
  /** 当前文件的变量字典摘要，按需从宿主端加载 */
  let variableDictionaryEntries = null
  /** 变量字典弹窗内的搜索表达式 */
  let dictionarySearchQuery = ''

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
  const mainPanel = document.getElementById('main-panel')
  const resizeHandle = document.getElementById('resize-handle')

  // 工具栏
  const searchInput = document.getElementById('search-input')
  const filterTools = document.getElementById('filter-tools')
  const filterAssist = document.getElementById('filter-assist')
  const searchApply = document.getElementById('search-apply')
  const searchClear = document.getElementById('search-clear')
  const filterError = document.getElementById('filter-error')
  const valueLabelModeWrap = document.getElementById('value-label-mode-wrap')
  const valueLabelModeControl = document.getElementById('value-label-mode')
  const valueLabelModeButtons = Array.from(valueLabelModeControl.querySelectorAll('[data-value-label-mode]'))
  const toggleSidebar = document.getElementById('toggle-sidebar')
  const toggleSidebarControl = document.getElementById('toggle-sidebar-control')
  const exportData = document.getElementById('export-data')
  const refreshData = document.getElementById('refresh-data')
  const helpMenu = document.getElementById('help-menu')

  // 网格器
  const gridContainer = document.getElementById('grid-container')
  const gridOverlay = document.getElementById('grid-overlay')
  const dataTable = document.getElementById('data-table')
  const tableHead = document.getElementById('table-head')
  const tableBody = document.getElementById('table-body')
  const rowDetailPanel = document.getElementById('row-detail-panel')
  const rowDetailResizeHandle = document.getElementById('row-detail-resize-handle')
  const rowDetailSummary = document.getElementById('row-detail-summary')
  const rowDetailClose = document.getElementById('row-detail-close')
  const rowDetailBody = document.getElementById('row-detail-body')
  const rowDetailTable = document.getElementById('row-detail-table')
  const rowDetailTableBody = document.getElementById('row-detail-table-body')

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
  const highlightMissing = document.getElementById('highlight-missing')
  const selectAllVariables = document.getElementById('select-all-variables')
  const deselectAllVariables = document.getElementById('deselect-all-variables')
  const variableList = document.getElementById('variable-list')

  // 初始加载
  const loadingEl = document.getElementById('initial-loading')
  const progressFill = document.getElementById('progress-fill')
  const progressText = document.getElementById('progress-text')

  // 文件信息弹窗
  const fileInfoBody = document.getElementById('file-info-body')
  const dictionaryBody = document.getElementById('dictionary-body')

  // 变量汇总弹窗
  const explorerVariable = document.getElementById('explorer-variable')
  const explorerBody = document.getElementById('explorer-body')
  const modalRegistry = modals.createRegistry([
    'file-info-modal',
    'usage-guide-modal',
    'dictionary-modal',
    'explorer-modal',
  ])
  const fileInfoDialog = modalRegistry.get('file-info-modal')
  const usageGuideDialog = modalRegistry.get('usage-guide-modal')
  const dictionaryDialog = modalRegistry.get('dictionary-modal')
  const explorerDialog = modalRegistry.get('explorer-modal')

  mainFilterAssistTarget = createFilterAssistTarget({
    input: searchInput,
    panel: filterAssist,
    clearError: clearFilterError,
    onApply: applyFilterAndReload,
    updateControls: updateFilterMemoryControls,
  })
  filterAssistState = loadFilterAssistState()
  pageSizeSelect.value = String(pageSize)
  initResizeHandle()
  initRowDetailResizeHandle()
  initRowDetailColumnResize()
  syncRowDetailColumnLayout()
  updateValueLabelModeControl()
  updateFilterMemoryControls()
  updateSidebarToggle()
  updateSidebarPositionButton()

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
    meta.valueLabels = normalizeValueLabels(meta.valueLabels)
    if (!hasAnyValueLabels())
      valueLabelDisplayMode = 'raw'
    currentPageRows = payload.page.rows
    currentPageRowIndices = normalizePageRowIndices(payload.page.rowIndices, currentPageRows.length, payload.page.offset)
    pageOffset = payload.page.offset
    totalFiltered = payload.page.totalFiltered
    totalAll = payload.page.totalAll
    clearSelectedRow()
    visibleColumns = createAllColumnSet()
    variableSearchText = meta.headers.map((header, i) => `${header} ${meta.labels[i] || ''}`.toLowerCase())
    variableSearchQuery = ''
    colWidths = {}
    sortSpec = []
    filterQuery = ''
    variableDictionaryEntries = null
    dictionarySearchQuery = ''
    searchInput.value = ''
    hideFilterAssist()
    hideFilterAssist(mainFilterAssistTarget)
    updateFilterMemoryControls()
    updateValueLabelModeControl()
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
        const error = new Error(msg.error || bootstrap.l10n.FilterError)
        error.stale = !!msg.stale
        p.reject(error)
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
      currentPageRowIndices = normalizePageRowIndices(res.page.rowIndices, currentPageRows.length, res.page.offset)
      pageOffset = res.page.offset
      totalFiltered = res.page.totalFiltered
      totalAll = res.page.totalAll
      clearSelectedRow()
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

  /**
   * 规范化宿主下发的值标签映射。
   */
  function normalizeValueLabels(valueLabels) {
    return valueLabels && typeof valueLabels === 'object' ? valueLabels : {}
  }

  /**
   * 规范化当前页原始行索引。
   */
  function normalizePageRowIndices(rowIndices, rowCount, offset = pageOffset) {
    if (!Array.isArray(rowIndices))
      return Array.from({ length: rowCount }, (_, i) => offset + i)
    return rowIndices
  }

  /**
   * 规范化值标签显示模式。
   */
  function normalizeValueLabelDisplayMode(mode) {
    return VALUE_LABEL_DISPLAY_MODES.has(mode) ? mode : 'raw'
  }

  /**
   * 获取指定列的值标签表。
   */
  function getValueLabelMap(colIndex) {
    if (!meta)
      return null
    const header = meta.headers[colIndex]
    const labelMap = meta.valueLabels && meta.valueLabels[header]
    return labelMap && typeof labelMap === 'object' ? labelMap : null
  }

  /**
   * 指定列是否绑定了值标签。
   */
  function hasValueLabelColumn(colIndex) {
    const labelMap = getValueLabelMap(colIndex)
    return !!labelMap && Object.keys(labelMap).length > 0
  }

  /**
   * 当前数据集是否包含任意值标签。
   */
  function hasAnyValueLabels() {
    if (!meta || !meta.valueLabels)
      return false
    return Object.values(meta.valueLabels).some(labelMap =>
      labelMap && typeof labelMap === 'object' && Object.keys(labelMap).length > 0,
    )
  }

  /**
   * 查找单元格原始值对应的值标签。
   */
  function getValueLabelForCell(labelMap, rawValue) {
    if (!labelMap || isMissingCellValue(rawValue))
      return null
    const key = String(rawValue)
    if (!Object.hasOwn(labelMap, key))
      return null
    const label = labelMap[key]
    if (label === null || label === undefined)
      return null
    const text = String(label)
    return text.length > 0 ? text : null
  }

  /**
   * 按当前显示模式格式化单元格文本。
   */
  function formatCellDisplayValue(rawValue, labelMap) {
    const rawText = String(rawValue)
    const label = getValueLabelForCell(labelMap, rawValue)
    if (!label || valueLabelDisplayMode === 'raw')
      return rawText
    if (valueLabelDisplayMode === 'label')
      return label
    return `${rawText} (${label})`
  }

  /**
   * 清除当前行选择并关闭详情面板。
   */
  function clearSelectedRow() {
    selectedPageRow = null
    hideRowDetailPanel()
    updateSelectedRowMarkers()
  }

  /**
   * 选中当前页中的一行。
   */
  function selectRow(pageRow) {
    if (!Number.isInteger(pageRow) || pageRow < 0 || pageRow >= currentPageRows.length)
      return
    if (selectedPageRow === pageRow && !rowDetailPanel.hidden) {
      clearSelectedRow()
      return
    }
    selectedPageRow = pageRow
    updateSelectedRowMarkers()
    renderSelectedRowDetails()
  }

  /**
   * 同步当前虚拟窗口里的行选中样式。
   */
  function updateSelectedRowMarkers() {
    tableBody.querySelectorAll('tr[data-page-row]').forEach((tr) => {
      const pageRow = Number.parseInt(tr.dataset.pageRow || '-1', 10)
      tr.classList.toggle('row-selected', pageRow === selectedPageRow)
    })
  }

  /**
   * 同步所有数据表的缺失值高亮状态。
   */
  function updateHighlightMissingState(enabled) {
    dataTable.classList.toggle('highlight-missing', enabled)
    rowDetailTable.classList.toggle('highlight-missing', enabled)
  }

  /**
   * 隐藏行详情面板。
   */
  function hideRowDetailPanel() {
    rowDetailPanel.hidden = true
    rowDetailTableBody.innerHTML = ''
    rowDetailSummary.textContent = ''
    requestAnimationFrame(renderBodyWindow)
  }

  /**
   * 渲染当前选中行的转置详情表。
   */
  function renderSelectedRowDetails() {
    if (selectedPageRow === null || !meta || !currentPageRows[selectedPageRow]) {
      hideRowDetailPanel()
      return
    }

    const rowData = currentPageRows[selectedPageRow]
    const viewRow = pageOffset + selectedPageRow + 1
    const sourceRowIndex = currentPageRowIndices[selectedPageRow]
    rowDetailSummary.textContent = Number.isFinite(sourceRowIndex)
      ? formatL10n(bootstrap.l10n.RowDetailSummary, fmtInt(viewRow), fmtInt(sourceRowIndex + 1))
      : formatL10n(bootstrap.l10n.RowDetailViewSummary, fmtInt(viewRow))

    const fragment = document.createDocumentFragment()
    for (let i = 0; i < meta.headers.length; i++) {
      const tr = document.createElement('tr')
      appendDetailTextCell(tr, meta.headers[i])
      appendDetailTextCell(tr, meta.labels[i] || '')
      appendDetailValueCell(tr, rowData[i])
      appendDetailValueLabelCell(tr, getValueLabelMap(i), rowData[i])
      fragment.appendChild(tr)
    }

    rowDetailTableBody.innerHTML = ''
    rowDetailTableBody.appendChild(fragment)
    syncRowDetailColumnLayout()
    rowDetailBody.scrollTop = 0
    rowDetailPanel.hidden = false
    requestAnimationFrame(renderBodyWindow)
  }

  /**
   * 追加行详情普通文本单元格。
   */
  function appendDetailTextCell(tr, value) {
    const td = document.createElement('td')
    td.textContent = value === null || value === undefined ? '' : String(value)
    tr.appendChild(td)
  }

  /**
   * 追加行详情值单元格。
   */
  function appendDetailValueCell(tr, value) {
    const td = document.createElement('td')
    if (isMissingCellValue(value)) {
      td.classList.add('cell-missing')
    }
    else if (value === '') {
      const span = document.createElement('span')
      span.className = 'whitespace-value'
      span.textContent = '""'
      td.appendChild(span)
    }
    else if (isWhitespaceOnlyString(value)) {
      const span = document.createElement('span')
      span.className = 'whitespace-value'
      span.textContent = formatWhitespacePreview(value)
      td.appendChild(span)
    }
    else {
      td.textContent = String(value)
    }
    tr.appendChild(td)
  }

  /**
   * 追加行详情值标签单元格。
   */
  function appendDetailValueLabelCell(tr, labelMap, rawValue) {
    const label = getValueLabelForCell(labelMap, rawValue)
    appendDetailTextCell(tr, label || '')
  }

  /**
   * 同步行详情表列宽。
   */
  function syncRowDetailColumnLayout() {
    let colgroup = rowDetailTable.querySelector('colgroup')
    if (!colgroup) {
      colgroup = document.createElement('colgroup')
      rowDetailTable.insertBefore(colgroup, rowDetailTable.firstChild)
    }

    colgroup.innerHTML = ''
    const headers = rowDetailTable.querySelectorAll('thead th')
    rowDetailColumnWidths = rowDetailColumnWidths.map(width => Math.max(60, width))
    rowDetailColumnWidths.forEach((width, index) => {
      const col = document.createElement('col')
      col.style.width = `${width}px`
      colgroup.appendChild(col)
      if (headers[index])
        headers[index].style.width = `${width}px`
    })
    const totalWidth = rowDetailColumnWidths.reduce((sum, width) => sum + width, 0)
    rowDetailTable.style.width = `${totalWidth}px`
  }

  /**
   * 同步值标签模式控件状态。
   */
  function updateValueLabelModeControl() {
    const enabled = hasAnyValueLabels()
    valueLabelModeWrap.title = enabled
      ? bootstrap.l10n.ValueLabelModeTitle
      : bootstrap.l10n.NoValueLabelsInDataset
    for (const button of valueLabelModeButtons) {
      const mode = normalizeValueLabelDisplayMode(button.dataset.valueLabelMode)
      const active = mode === valueLabelDisplayMode
      button.disabled = !enabled
      button.classList.toggle('active', active)
    }
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

  searchInput.addEventListener('keydown', e => handleFilterInputKeydown(mainFilterAssistTarget, e))
  searchInput.addEventListener('input', () => {
    clearFilterError()
    updateFilterMemoryControls()
    updateFilterAutocomplete(mainFilterAssistTarget, false)
  })
  searchInput.addEventListener('click', () => updateFilterAutocomplete(mainFilterAssistTarget, false))
  searchApply.addEventListener('click', applyFilterAndReload)
  searchClear.addEventListener('click', () => {
    searchInput.value = ''
    filterQuery = ''
    hideFilterAssist(mainFilterAssistTarget)
    updateFilterMemoryControls()
    applyFilterAndReload()
  })
  filterTools.addEventListener('click', (e) => {
    e.stopPropagation()
    showFilterToolsMenu(mainFilterAssistTarget, filterTools)
  })

  /**
   * 应用通用过滤表达式并回到第一页
   */
  async function applyFilterAndReload() {
    filterQuery = searchInput.value
    clearFilterError()
    hideFilterAssist(mainFilterAssistTarget)
    updateFilterMemoryControls()
    showOverlay(true, bootstrap.l10n.applyingFilter)
    try {
      const spec = filterQuery.trim() ? { query: filterQuery } : null
      await postLatest('filter', 'setFilter', { spec })
      if (spec)
        rememberFilterExpression(filterQuery)
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

  /**
   * 创建可复用的筛选输入助手目标。
   */
  function createFilterAssistTarget(options) {
    return {
      input: options.input,
      panel: options.panel,
      clearError: options.clearError || (() => {}),
      onApply: options.onApply || (() => {}),
      updateControls: options.updateControls || (() => {}),
      mode: null,
      items: [],
      activeIndex: -1,
    }
  }

  /**
   * 处理筛选输入框的快捷键。
   */
  function handleFilterInputKeydown(target, e) {
    if (isFilterAssistOpen(target)) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        moveFilterAssistActive(target, e.key === 'ArrowDown' ? 1 : -1)
        e.preventDefault()
        return
      }
      if (e.key === 'Tab' && target.activeIndex >= 0) {
        acceptFilterAssistItem(target, target.items[target.activeIndex])
        e.preventDefault()
        return
      }
      if (e.key === 'Enter') {
        if (target.mode !== 'suggestions' && target.activeIndex >= 0)
          acceptFilterAssistItem(target, target.items[target.activeIndex])
        else
          target.onApply()
        e.preventDefault()
        return
      }
      if (e.key === 'Escape') {
        hideFilterAssist(target)
        e.preventDefault()
        return
      }
    }

    if (e.key === 'Enter') {
      target.onApply()
      e.preventDefault()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
      updateFilterAutocomplete(target, true)
      e.preventDefault()
    }
  }

  /**
   * 是否正在显示筛选助手。
   */
  function isFilterAssistOpen(target = activeFilterAssistTarget) {
    return !!target && !!target.mode && !target.panel.hidden
  }

  /**
   * 根据光标位置刷新变量和函数补全。
   */
  function updateFilterAutocomplete(target, force, ignoreFocus = false) {
    if (!meta || (!ignoreFocus && document.activeElement !== target.input))
      return
    const context = getFilterCompletionContext(target, force)
    if (!context) {
      hideFilterAssist(target)
      return
    }

    const items = buildFilterCompletionItems(context)
    if (items.length === 0 && !force) {
      hideFilterAssist(target)
      return
    }
    showFilterAssistPanel(target, 'suggestions', bootstrap.l10n.FilterSuggestions, items, bootstrap.l10n.NoData)
  }

  /**
   * 获取当前补全上下文。
   */
  function getFilterCompletionContext(target, force) {
    const value = target.input.value
    const cursor = getFilterInputSelection(target.input).start
    if (isCursorInsideString(value, cursor))
      return null

    let start = cursor
    while (start > 0 && isFilterIdentifierChar(value[start - 1]))
      start--
    let end = cursor
    while (end < value.length && isFilterIdentifierChar(value[end]))
      end++

    const prefix = value.slice(start, cursor)
    if (!force && prefix.length === 0)
      return null
    return { prefix, replaceStart: start, replaceEnd: end }
  }

  /**
   * 筛选表达式标识符字符。
   */
  function isFilterIdentifierChar(char) {
    return /[\p{L}\p{N}_]/u.test(char)
  }

  /**
   * 简单判断光标是否位于字符串字面量中。
   */
  function isCursorInsideString(value, cursor) {
    let quote = ''
    for (let i = 0; i < cursor; i++) {
      const char = value[i]
      if (char !== '"' && char !== '\'')
        continue
      if (i > 0 && value[i - 1] === '\\')
        continue
      if (!quote)
        quote = char
      else if (quote === char)
        quote = ''
    }
    return !!quote
  }

  /**
   * 构建变量名与函数候选项。
   */
  function buildFilterCompletionItems(context) {
    const prefix = context.prefix.toLowerCase()
    const memoryItems = buildFilterMemoryCompletionItems(prefix)
    const variableItems = []
    const functionItems = []

    if (meta) {
      for (let i = 0; i < meta.headers.length; i++) {
        const header = meta.headers[i]
        const label = meta.labels[i] || ''
        const headerText = header.toLowerCase()
        const searchText = `${header} ${label}`.toLowerCase()
        if (prefix && !headerText.startsWith(prefix) && !searchText.includes(prefix))
          continue
        variableItems.push({
          kind: 'variable',
          label: header,
          detail: label,
          badge: bootstrap.l10n.VariableSuggestion,
          insertText: header,
          replaceStart: context.replaceStart,
          replaceEnd: context.replaceEnd,
          score: headerText.startsWith(prefix) ? 0 : 1,
          index: i,
        })
      }
    }

    for (const fn of FILTER_FUNCTION_COMPLETIONS) {
      const fnText = `${fn.name} ${fn.signature}`.toLowerCase()
      if (prefix && !fn.name.startsWith(prefix) && !fnText.includes(prefix))
        continue
      functionItems.push({
        kind: 'function',
        label: fn.signature,
        detail: fn.description,
        badge: bootstrap.l10n.FunctionSuggestion,
        insertText: fn.template,
        cursorOffset: fn.cursorOffset,
        replaceStart: context.replaceStart,
        replaceEnd: context.replaceEnd,
        score: fn.name.startsWith(prefix) ? 0 : 1,
        sortName: fn.name,
      })
    }

    variableItems.sort((a, b) => a.score - b.score || a.index - b.index)
    functionItems.sort((a, b) => a.score - b.score || a.sortName.localeCompare(b.sortName))
    return memoryItems.concat(variableItems.slice(0, 8), functionItems.slice(0, 8))
  }

  /**
   * 构建历史和常用筛选补全候选。
   */
  function buildFilterMemoryCompletionItems(prefix) {
    const saved = filterAssistState.saved
      .filter(expr => filterMemoryMatches(expr, prefix))
      .map(expr => createFilterMemoryItem('saved', expr, prefix))
      .sort(compareFilterMemoryItems)
      .slice(0, 4)
    const savedSet = new Set(filterAssistState.saved)
    const history = filterAssistState.history
      .filter(expr => !savedSet.has(expr) && filterMemoryMatches(expr, prefix))
      .map(expr => createFilterMemoryItem('history', expr, prefix))
      .sort(compareFilterMemoryItems)
      .slice(0, 4)
    return saved.concat(history)
  }

  /**
   * 判断历史/常用筛选是否匹配当前补全前缀。
   */
  function filterMemoryMatches(expr, prefix) {
    return !prefix || expr.toLowerCase().includes(prefix)
  }

  /**
   * 构建历史/常用筛选候选项。
   */
  function createFilterMemoryItem(kind, expr, prefix) {
    const text = expr.toLowerCase()
    return {
      kind,
      label: expr,
      detail: '',
      expression: expr,
      badge: kind === 'history' ? bootstrap.l10n.FilterHistory : bootstrap.l10n.SavedFilters,
      score: prefix && text.startsWith(prefix) ? 0 : 1,
    }
  }

  /**
   * 排序历史/常用筛选候选项。
   */
  function compareFilterMemoryItems(a, b) {
    return a.score - b.score
  }

  /**
   * 渲染历史或常用筛选列表。
   */
  function showFilterMemoryPanel(target, mode, title, expressions, emptyMessage) {
    const items = expressions.map(expr => ({
      kind: mode,
      label: expr,
      detail: '',
      expression: expr,
      badge: mode === 'history' ? bootstrap.l10n.FilterHistory : bootstrap.l10n.SavedFilters,
    }))
    showFilterAssistPanel(target, mode, title, items, emptyMessage)
  }

  /**
   * 显示筛选助手面板。
   */
  function showFilterAssistPanel(target, mode, title, items, emptyMessage) {
    if (activeFilterAssistTarget && activeFilterAssistTarget !== target)
      hideFilterAssist(activeFilterAssistTarget)
    activeFilterAssistTarget = target
    target.mode = mode
    target.items = items
    target.activeIndex = items.length > 0 ? 0 : -1
    target.panel.innerHTML = ''

    const titleEl = document.createElement('div')
    titleEl.className = 'filter-assist-title'
    const titleText = document.createElement('span')
    titleText.textContent = title
    titleEl.appendChild(titleText)
    const titleAction = buildFilterAssistTitleAction(target, mode, items.length)
    if (titleAction)
      titleEl.appendChild(titleAction)
    target.panel.appendChild(titleEl)

    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'filter-assist-empty'
      empty.textContent = emptyMessage
      target.panel.appendChild(empty)
    }
    else {
      const list = document.createElement('div')
      list.className = 'filter-assist-list'
      items.forEach((item, index) => list.appendChild(buildFilterAssistRow(target, item, index)))
      target.panel.appendChild(list)
      syncFilterAssistActiveRow(target)
    }

    target.panel.hidden = false
  }

  /**
   * 构建筛选助手候选行。
   */
  function buildFilterAssistRow(target, item, index) {
    const row = document.createElement('div')
    row.className = 'filter-assist-row'
    if (!item.detail)
      row.classList.add('single-line')
    row.dataset.index = String(index)

    const pick = document.createElement('div')
    pick.className = 'filter-assist-pick'
    pick.title = item.kind === 'history' || item.kind === 'saved'
      ? `${bootstrap.l10n.UseFilter}: ${item.label}`
      : item.label
    pick.addEventListener('mousemove', () => setFilterAssistActive(target, index, false))
    pick.addEventListener('click', () => acceptFilterAssistItem(target, item))

    const main = document.createElement('span')
    main.className = 'filter-assist-main'
    main.textContent = item.label
    pick.appendChild(main)

    if (item.detail) {
      const detail = document.createElement('span')
      detail.className = 'filter-assist-detail'
      detail.textContent = item.detail
      pick.appendChild(detail)
    }

    if (item.badge) {
      const badge = document.createElement('span')
      badge.className = 'filter-assist-badge'
      badge.textContent = item.badge
      pick.appendChild(badge)
    }

    row.appendChild(pick)
    const actions = buildFilterAssistActions(target, item)
    if (actions)
      row.appendChild(actions)
    return row
  }

  /**
   * 构建历史和常用筛选行的操作按钮。
   */
  function buildFilterAssistActions(target, item) {
    if (item.kind !== 'history' && item.kind !== 'saved')
      return null

    const actions = document.createElement('div')
    actions.className = 'filter-assist-actions'
    if (item.kind === 'history') {
      const saved = filterAssistState.saved.includes(item.expression)
      const action = createFilterAssistAction(saved ? bootstrap.l10n.RemoveSavedFilter : bootstrap.l10n.Save)
      action.title = saved ? bootstrap.l10n.RemoveSavedFilter : bootstrap.l10n.SaveFilter
      action.addEventListener('click', (e) => {
        e.stopPropagation()
        if (saved)
          deleteSavedFilter(item.expression)
        else
          addSavedFilter(item.expression)
        refreshCurrentFilterAssistPanel(target)
      })
      actions.appendChild(action)
      const remove = createFilterAssistAction(bootstrap.l10n.Delete)
      remove.addEventListener('click', (e) => {
        e.stopPropagation()
        deleteFilterHistory(item.expression)
        refreshCurrentFilterAssistPanel(target)
      })
      actions.appendChild(remove)
    }
    else {
      const remove = createFilterAssistAction(bootstrap.l10n.Delete)
      remove.addEventListener('click', (e) => {
        e.stopPropagation()
        deleteSavedFilter(item.expression)
        refreshCurrentFilterAssistPanel(target)
      })
      actions.appendChild(remove)
    }
    return actions
  }

  /**
   * 构建筛选助手标题栏操作。
   */
  function buildFilterAssistTitleAction(target, mode, itemCount) {
    if (itemCount === 0)
      return null
    if (mode === 'suggestions') {
      const hint = document.createElement('span')
      hint.className = 'filter-assist-hint'
      hint.textContent = bootstrap.l10n.FilterSuggestionTabHint
      return hint
    }
    if (mode !== 'history' && mode !== 'saved')
      return null
    const clear = createFilterAssistAction(bootstrap.l10n.ClearAll)
    clear.classList.add('filter-assist-clear')
    clear.addEventListener('click', (e) => {
      e.stopPropagation()
      if (mode === 'history')
        clearFilterHistory()
      else
        clearSavedFilters()
      refreshCurrentFilterAssistPanel(target)
    })
    return clear
  }

  /**
   * 构建轻量筛选记录操作按钮。
   */
  function createFilterAssistAction(label) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'filter-assist-action text link small'
    button.textContent = label
    return button
  }

  /**
   * 根据当前面板类型刷新筛选助手。
   */
  function refreshCurrentFilterAssistPanel(target = activeFilterAssistTarget) {
    if (!target)
      return
    if (target.mode === 'history') {
      showFilterMemoryPanel(target, 'history', bootstrap.l10n.FilterHistory, filterAssistState.history, bootstrap.l10n.NoFilterHistory)
      return
    }
    if (target.mode === 'saved') {
      showFilterMemoryPanel(target, 'saved', bootstrap.l10n.SavedFilters, filterAssistState.saved, bootstrap.l10n.NoSavedFilters)
      return
    }
    if (target.mode === 'suggestions')
      updateFilterAutocomplete(target, true, true)
  }

  /**
   * 接受当前候选项。
   */
  function acceptFilterAssistItem(target, item) {
    if (!item)
      return
    if (item.kind === 'history' || item.kind === 'saved') {
      setFilterInputValue(target, item.expression)
      return
    }
    insertFilterSnippet(
      target,
      item.insertText,
      item.cursorOffset ?? item.insertText.length,
      item.replaceStart,
      item.replaceEnd,
    )
  }

  /**
   * 移动筛选助手键盘选择。
   */
  function moveFilterAssistActive(target, delta) {
    if (target.items.length === 0)
      return
    const next = (target.activeIndex + delta + target.items.length) % target.items.length
    setFilterAssistActive(target, next, true)
  }

  /**
   * 设置筛选助手当前活动项。
   */
  function setFilterAssistActive(target, index, scrollIntoView = true) {
    if (target.activeIndex === index)
      return
    target.activeIndex = index
    syncFilterAssistActiveRow(target, scrollIntoView)
  }

  /**
   * 同步筛选助手活动行样式。
   */
  function syncFilterAssistActiveRow(target, scrollIntoView = true) {
    let activeRow = null
    target.panel.querySelectorAll('.filter-assist-row').forEach((row) => {
      const index = Number.parseInt(row.dataset.index || '-1', 10)
      const active = index === target.activeIndex
      row.classList.toggle('active', active)
      if (active)
        activeRow = row
    })
    if (!activeRow)
      return
    if (!scrollIntoView)
      return
    const list = activeRow.parentElement
    if (!list)
      return
    const rowTop = activeRow.offsetTop - list.offsetTop
    const rowBottom = rowTop + activeRow.offsetHeight
    if (rowTop < list.scrollTop)
      list.scrollTop = rowTop
    else if (rowBottom > list.scrollTop + list.clientHeight)
      list.scrollTop = rowBottom - list.clientHeight
  }

  /**
   * 隐藏筛选助手。
   */
  function hideFilterAssist(target = activeFilterAssistTarget) {
    if (!target)
      return
    target.panel.hidden = true
    target.mode = null
    target.items = []
    target.activeIndex = -1
    if (activeFilterAssistTarget === target)
      activeFilterAssistTarget = null
  }

  /**
   * 设置筛选输入值。
   */
  function setFilterInputValue(target, value) {
    target.input.value = value
    target.input.focus()
    target.input.setSelectionRange(value.length, value.length)
    target.clearError()
    hideFilterAssist(target)
    target.updateControls()
  }

  /**
   * 插入筛选表达式片段。
   */
  function insertFilterSnippet(target, snippet, cursorOffset = snippet.length, replaceStart, replaceEnd) {
    const value = target.input.value
    const selection = getFilterInputSelection(target.input)
    const start = Number.isInteger(replaceStart) ? replaceStart : selection.start
    const end = Number.isInteger(replaceEnd) ? replaceEnd : selection.end
    target.input.value = `${value.slice(0, start)}${snippet}${value.slice(end)}`
    const cursor = start + cursorOffset
    target.input.focus()
    target.input.setSelectionRange(cursor, cursor)
    target.clearError()
    hideFilterAssist(target)
    target.updateControls()
  }

  /**
   * 获取筛选输入框选区。
   */
  function getFilterInputSelection(input) {
    const value = input.value
    const start = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length
    const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start
    return { start, end }
  }

  /**
   * 插入变量名。
   */
  function insertVariableFilterToken(header) {
    insertFilterSnippet(mainFilterAssistTarget, header)
  }

  /**
   * 插入带变量名的筛选模板。
   */
  function insertVariableFilterTemplate(header, fn) {
    const resolved = resolveVariableFunctionSnippet(fn, header)
    insertFilterSnippet(mainFilterAssistTarget, resolved.snippet, resolved.cursorOffset)
  }

  /**
   * 生成带当前变量名的函数片段。
   */
  function resolveVariableFunctionSnippet(fn, header) {
    const marker = '{cursor}'
    const template = (fn.variableTemplate || `${fn.name}({var})`).split('{var}').join(header)
    const cursorIndex = template.indexOf(marker)
    if (cursorIndex < 0)
      return { snippet: template, cursorOffset: template.length }
    return {
      snippet: template.slice(0, cursorIndex) + template.slice(cursorIndex + marker.length),
      cursorOffset: cursorIndex,
    }
  }

  /**
   * 保存当前筛选表达式。
   */
  function saveCurrentFilter(target = mainFilterAssistTarget) {
    const expr = target.input.value.trim()
    if (!expr)
      return
    addSavedFilter(expr)
    refreshCurrentFilterAssistPanel(target)
  }

  /**
   * 将表达式加入历史。
   */
  function rememberFilterExpression(expr) {
    filterAssistState.history = addExpressionToList(filterAssistState.history, expr, FILTER_HISTORY_LIMIT)
    persistFilterAssistState()
    updateFilterMemoryControls()
  }

  /**
   * 删除单条筛选历史。
   */
  function deleteFilterHistory(expr) {
    filterAssistState.history = filterAssistState.history.filter(item => item !== expr)
    persistFilterAssistState()
    updateFilterMemoryControls()
  }

  /**
   * 添加常用筛选。
   */
  function addSavedFilter(expr) {
    filterAssistState.saved = addExpressionToList(filterAssistState.saved, expr, SAVED_FILTER_LIMIT)
    persistFilterAssistState()
    updateFilterMemoryControls()
  }

  /**
   * 删除常用筛选。
   */
  function deleteSavedFilter(expr) {
    filterAssistState.saved = filterAssistState.saved.filter(item => item !== expr)
    persistFilterAssistState()
    updateFilterMemoryControls()
  }

  /**
   * 清空筛选历史。
   */
  function clearFilterHistory() {
    filterAssistState.history = []
    persistFilterAssistState()
    updateFilterMemoryControls()
  }

  /**
   * 清空常用筛选。
   */
  function clearSavedFilters() {
    filterAssistState.saved = []
    persistFilterAssistState()
    updateFilterMemoryControls()
  }

  /**
   * 去重并把表达式放到列表首位。
   */
  function addExpressionToList(list, expr, limit) {
    const normalized = expr.trim()
    if (!normalized)
      return list
    return [normalized, ...list.filter(item => item !== normalized)].slice(0, limit)
  }

  /**
   * 更新历史/保存按钮状态。
   */
  function updateFilterMemoryControls() {
    filterTools.disabled = false
  }

  /**
   * 读取筛选助手持久状态。
   */
  function loadFilterAssistState() {
    const fromStorage = readFilterAssistStorage()
    if (fromStorage)
      return fromStorage
    try {
      const state = typeof vscode.getState === 'function' ? vscode.getState() : null
      return sanitizeFilterAssistState(state && state.filterAssist)
    }
    catch {
      return { history: [], saved: [] }
    }
  }

  /**
   * 从 localStorage 读取筛选助手状态。
   */
  function readFilterAssistStorage() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(FILTER_ASSIST_STORAGE_KEY)
      return raw ? sanitizeFilterAssistState(JSON.parse(raw)) : null
    }
    catch {
      return null
    }
  }

  /**
   * 持久化筛选助手状态。
   */
  function persistFilterAssistState() {
    filterAssistState = sanitizeFilterAssistState(filterAssistState)
    try {
      if (window.localStorage)
        window.localStorage.setItem(FILTER_ASSIST_STORAGE_KEY, JSON.stringify(filterAssistState))
    }
    catch {
      // VS Code Webview 可能禁用 localStorage，继续使用 setState 回退。
    }
    try {
      if (typeof vscode.setState === 'function') {
        const current = typeof vscode.getState === 'function' ? vscode.getState() || {} : {}
        vscode.setState({ ...current, filterAssist: filterAssistState })
      }
    }
    catch {
      // 状态保存失败不影响筛选功能本身。
    }
  }

  /**
   * 规范化筛选助手状态。
   */
  function sanitizeFilterAssistState(value) {
    const history = sanitizeExpressionList(value && value.history, FILTER_HISTORY_LIMIT)
    const saved = sanitizeExpressionList(value && value.saved, SAVED_FILTER_LIMIT)
    return { history, saved }
  }

  /**
   * 规范化表达式数组。
   */
  function sanitizeExpressionList(value, limit) {
    if (!Array.isArray(value))
      return []
    const result = []
    for (const item of value) {
      if (typeof item !== 'string')
        continue
      const expr = item.trim()
      if (!expr || result.includes(expr))
        continue
      result.push(expr)
      if (result.length >= limit)
        break
    }
    return result
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
  function createHeaderMenuItem(label, action, disabled = false, detail = '') {
    const btn = document.createElement('button')
    btn.type = 'button'
    if (detail) {
      btn.classList.add('context-menu-item-with-detail')
      btn.title = `${label}\n${detail}`
      const labelEl = document.createElement('span')
      labelEl.className = 'context-menu-item-label'
      labelEl.textContent = label
      const detailEl = document.createElement('span')
      detailEl.className = 'context-menu-item-detail'
      detailEl.textContent = detail
      btn.append(labelEl, detailEl)
    }
    else {
      btn.textContent = label
    }
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
   * 构建二级菜单入口。
   */
  function createSubmenuMenuItem(label, buildSubmenu) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'context-menu-submenu-trigger'
    btn.textContent = label
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const menu = btn.closest('.context-menu')
      if (!menu)
        return
      const existing = menu.querySelector('.context-submenu')
      if (existing) {
        existing.remove()
        return
      }
      const submenu = buildSubmenu()
      submenu.classList.add('context-submenu')
      menu.appendChild(submenu)
      placeContextSubmenuNearAnchor(submenu, btn.getBoundingClientRect())
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
   * 将菜单放在鼠标点附近，底部空间不足时向上展开。
   */
  function placeContextMenuAtPoint(menu, clientX, clientY) {
    const rect = menu.getBoundingClientRect()
    const margin = 4
    const left = Math.max(margin, Math.min(clientX, window.innerWidth - rect.width - margin))
    const belowTop = clientY
    const aboveTop = clientY - rect.height
    const top = belowTop + rect.height <= window.innerHeight - margin
      ? belowTop
      : aboveTop
    menu.style.left = `${left}px`
    menu.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - rect.height - margin))}px`
  }

  /**
   * 将二级菜单放在入口旁边；右侧空间不足时向左展开。
   */
  function placeContextSubmenuNearAnchor(menu, anchorRect) {
    const rect = menu.getBoundingClientRect()
    const margin = 4
    const rightLeft = anchorRect.right + margin
    const leftLeft = anchorRect.left - rect.width - margin
    const left = rightLeft + rect.width <= window.innerWidth - margin
      ? rightLeft
      : leftLeft
    const top = Math.max(margin, Math.min(anchorRect.top, window.innerHeight - rect.height - margin))
    menu.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin))}px`
    menu.style.top = `${top}px`
  }

  /**
   * 将菜单贴近触发元素，底部空间不足时在触发元素上方展开。
   */
  function placeContextMenuNearAnchor(menu, anchorRect, align = 'right') {
    const rect = menu.getBoundingClientRect()
    const margin = 4
    const preferredLeft = align === 'left' ? anchorRect.left : anchorRect.right - rect.width
    const left = Math.max(margin, Math.min(preferredLeft, window.innerWidth - rect.width - margin))
    const belowTop = anchorRect.bottom + margin
    const aboveTop = anchorRect.top - rect.height - margin
    const top = belowTop + rect.height <= window.innerHeight - margin
      ? belowTop
      : aboveTop
    menu.style.left = `${left}px`
    menu.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - rect.height - margin))}px`
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
    placeContextMenuAtPoint(menu, clientX, clientY)
    headerContextMenu = menu
  }

  /**
   * 显示变量筛选模板菜单。
   */
  function showVariableFilterMenu(colIndex, anchor) {
    hideHeaderContextMenu()

    const header = meta.headers[colIndex]
    const menu = document.createElement('div')
    menu.className = 'context-menu'
    menu.append(
      createHeaderMenuItem(bootstrap.l10n.InsertVariableName, () => insertVariableFilterToken(header)),
      createSubmenuMenuItem(
        bootstrap.l10n.InsertFunctionTemplate,
        () => buildVariableFunctionSubmenu(header),
      ),
      createHeaderMenuItem(bootstrap.l10n.ExploreVariableStatistics, () => openExplorer(colIndex)),
    )

    document.body.appendChild(menu)
    placeContextMenuNearAnchor(menu, anchor.getBoundingClientRect(), 'left')
    headerContextMenu = menu
  }

  /**
   * 构建变量函数模板二级菜单。
   */
  function buildVariableFunctionSubmenu(header) {
    const submenu = document.createElement('div')
    submenu.className = 'context-menu'
    let previousGroup = ''
    for (const fn of FILTER_FUNCTION_COMPLETIONS) {
      if (previousGroup && previousGroup !== fn.group)
        submenu.append(createHeaderMenuSeparator())
      submenu.append(createHeaderMenuItem(
        fn.signature,
        () => insertVariableFilterTemplate(header, fn),
        false,
        fn.description,
      ))
      previousGroup = fn.group
    }
    return submenu
  }

  /**
   * 显示筛选工具菜单。
   */
  function showFilterToolsMenu(target, anchor) {
    hideHeaderContextMenu()
    hideFilterAssist(target)

    const expr = target.input.value.trim()
    const alreadySaved = !!expr && filterAssistState.saved.includes(expr)
    const menu = document.createElement('div')
    menu.className = 'context-menu'
    menu.append(
      createHeaderMenuItem(bootstrap.l10n.SaveFilter, () => saveCurrentFilter(target), !expr || alreadySaved),
      createHeaderMenuSeparator(),
      createHeaderMenuItem(bootstrap.l10n.FilterHistory, () => showFilterMemoryPanel(
        target,
        'history',
        bootstrap.l10n.FilterHistory,
        filterAssistState.history,
        bootstrap.l10n.NoFilterHistory,
      )),
      createHeaderMenuItem(bootstrap.l10n.SavedFilters, () => showFilterMemoryPanel(
        target,
        'saved',
        bootstrap.l10n.SavedFilters,
        filterAssistState.saved,
        bootstrap.l10n.NoSavedFilters,
      )),
    )

    document.body.appendChild(menu)
    placeContextMenuNearAnchor(menu, anchor.getBoundingClientRect())
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
    placeContextMenuNearAnchor(menu, anchor.getBoundingClientRect())
    headerContextMenu = menu
  }

  /**
   * 显示帮助菜单
   */
  function showHelpMenu(anchor) {
    hideHeaderContextMenu()

    const menu = document.createElement('div')
    menu.className = 'context-menu'
    menu.append(
      createHeaderMenuItem(bootstrap.l10n.UsageGuide, () => usageGuideDialog.show()),
      createHeaderMenuItem(bootstrap.l10n.VariableDictionary, openVariableDictionary),
      createHeaderMenuItem(bootstrap.l10n.FileInformation, openFileInfo),
    )

    document.body.appendChild(menu)
    placeContextMenuNearAnchor(menu, anchor.getBoundingClientRect())
    headerContextMenu = menu
  }

  /**
   * 同步变量面板开关状态。
   */
  function updateSidebarToggle() {
    toggleSidebar.checked = sidebarVisible
    toggleSidebarControl.title = sidebarVisible ? bootstrap.l10n.HideVariablesPanel : bootstrap.l10n.ShowVariablesPanel
  }

  /**
   * 同步变量面板位置按钮提示。
   */
  function updateSidebarPositionButton() {
    sidebarPositionBtn.title = sidebarPosition === 'right'
      ? bootstrap.l10n.MoveVariablesPanelToBottom
      : bootstrap.l10n.MoveVariablesPanelToRight
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
      if (!e.stale)
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
  document.addEventListener('mousedown', (e) => {
    if (!isFilterAssistOpen())
      return
    const target = activeFilterAssistTarget
    if (!target)
      return
    if (e.target instanceof Node && (target.input.contains(e.target) || target.panel.contains(e.target)))
      return
    hideFilterAssist(target)
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

    if (isFilterAssistOpen()) {
      hideFilterAssist()
      e.preventDefault()
      return
    }

    if (headerContextMenu) {
      hideHeaderContextMenu()
      e.preventDefault()
      return
    }

    if (!rowDetailPanel.hidden) {
      clearSelectedRow()
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
    if (hasValueLabelColumn(i)) {
      if (valueLabelDisplayMode === 'label')
        return DEFAULT_LABEL_COL_WIDTH
      if (valueLabelDisplayMode === 'both')
        return DEFAULT_VALUE_LABEL_COL_WIDTH
    }
    const t = meta.types && meta.types[i]
    const isStr = typeof t === 'string' && t.startsWith('str')
    return isStr ? DEFAULT_STR_COL_WIDTH : DEFAULT_COL_WIDTH
  }

  /**
   * 获取当前列宽。
   */
  function getColumnWidth(i) {
    const header = meta.headers[i]
    return colWidths[header] ?? defaultColWidth(i)
  }

  /**
   * 获取当前可见列布局。
   */
  function getVisibleColumnSpecs() {
    const specs = []
    for (let i = 0; i < meta.headers.length; i++) {
      if (!visibleColumns.has(i))
        continue
      specs.push({
        index: i,
        header: meta.headers[i],
        width: getColumnWidth(i),
        valueLabels: getValueLabelMap(i),
      })
    }
    return specs
  }

  /**
   * 同步表格列宽和总宽度。
   *
   * 少列时不能依赖 table width: 100%，否则浏览器会拉伸列宽，
   * 导致拖拽手柄位置和鼠标位置不一致。
   */
  function syncTableColumnLayout(specs = getVisibleColumnSpecs()) {
    let colgroup = dataTable.querySelector('colgroup')
    if (!colgroup) {
      colgroup = document.createElement('colgroup')
      dataTable.insertBefore(colgroup, dataTable.firstChild)
    }

    const totalWidth = specs.reduce((sum, spec) => sum + spec.width, 0)
    colgroup.innerHTML = ''
    specs.forEach((spec) => {
      const col = document.createElement('col')
      col.dataset.col = spec.header
      col.style.width = `${spec.width}px`
      colgroup.appendChild(col)
    })

    dataTable.style.width = `${Math.max(1, totalWidth)}px`
  }

  /**
   * 渲染表头
   */
  function renderHeader() {
    tableHead.innerHTML = ''
    const tr = document.createElement('tr')
    const specs = getVisibleColumnSpecs()
    syncTableColumnLayout(specs)
    specs.forEach(({ header, index: i, width }) => {
      const th = document.createElement('th')
      th.dataset.col = header
      th.style.width = `${width}px`
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
   * 构建单行 DOM
   */
  function buildRow(rowData, specs, pageRow) {
    const tr = document.createElement('tr')
    tr.dataset.pageRow = String(pageRow)
    tr.classList.toggle('row-selected', pageRow === selectedPageRow)
    tr.addEventListener('click', () => selectRow(pageRow))
    for (const { index: c, valueLabels } of specs) {
      const td = document.createElement('td')
      const rawVal = rowData[c]
      if (isMissingCellValue(rawVal)) {
        td.textContent = ''
        td.classList.add('cell-missing')
      }
      else {
        const displayValue = formatCellDisplayValue(rawVal, valueLabels)
        td.textContent = displayValue
        if (isWhitespaceOnlyString(displayValue))
          td.classList.add('cell-blank')
      }
      tr.appendChild(td)
    }
    return tr
  }

  /**
   * 判断单元格是否为真实缺失值。
   */
  function isMissingCellValue(value) {
    return value === null || value === undefined
  }

  /**
   * 判断单元格是否为仅包含空白字符的字符串。
   */
  function isWhitespaceOnlyString(value) {
    return typeof value === 'string' && value.trim().length === 0
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
    const specs = getVisibleColumnSpecs()
    syncTableColumnLayout(specs)
    if (total === 0) {
      tableBody.innerHTML = ''
      return
    }

    const colspan = Math.max(1, specs.length)
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
      fragment.appendChild(buildRow(currentPageRows[r], specs, r))
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
  function renderSidebar(options = {}) {
    rebuildFilteredVariableIndices()
    if (options.resetScroll)
      variableList.scrollTop = 0
    renderVariableListWindow()
    updateBulkActions()
  }

  /**
   * 重建当前变量搜索结果。
   */
  function rebuildFilteredVariableIndices() {
    const total = meta ? meta.headers.length : 0
    filteredVariableIndices = []
    if (!variableSearchQuery) {
      for (let i = 0; i < total; i++)
        filteredVariableIndices.push(i)
      return
    }

    for (let i = 0; i < total; i++) {
      if (variableSearchText[i].includes(variableSearchQuery))
        filteredVariableIndices.push(i)
    }
  }

  /**
   * 渲染变量列表当前可见窗口。
   */
  function renderVariableListWindow() {
    const scrollTop = variableList.scrollTop
    variableList.innerHTML = ''
    const total = filteredVariableIndices.length
    if (total === 0) {
      const empty = document.createElement('div')
      empty.className = 'variable-empty'
      empty.textContent = bootstrap.l10n.NoData
      variableList.appendChild(empty)
      return
    }

    const viewportHeight = variableList.clientHeight || 320
    const start = Math.max(0, Math.floor(scrollTop / estVariableItemHeight) - VARIABLE_OVERSCAN)
    const visibleCount = Math.ceil(viewportHeight / estVariableItemHeight) + VARIABLE_OVERSCAN * 2
    const end = Math.min(total, start + visibleCount)
    const topH = start * estVariableItemHeight
    const bottomH = (total - end) * estVariableItemHeight

    const fragment = document.createDocumentFragment()
    if (topH > 0)
      fragment.appendChild(variableSpacer(topH))
    for (let r = start; r < end; r++) {
      fragment.appendChild(buildVariableItem(filteredVariableIndices[r]))
    }
    if (bottomH > 0)
      fragment.appendChild(variableSpacer(bottomH))

    variableList.appendChild(fragment)
    variableList.scrollTop = scrollTop

    const sampleItem = variableList.querySelector('.variable-item')
    if (sampleItem) {
      const h = sampleItem.getBoundingClientRect().height
      if (h > 0 && Math.abs(h - estVariableItemHeight) > 1) {
        estVariableItemHeight = h
        renderVariableListWindow()
      }
    }
  }

  /**
   * 构建变量列表占位元素。
   */
  function variableSpacer(height) {
    const spacer = document.createElement('div')
    spacer.className = 'variable-spacer'
    spacer.style.height = `${height}px`
    return spacer
  }

  /**
   * 构建单个变量项。
   */
  function buildVariableItem(i) {
    const header = meta.headers[i]
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

    const text = document.createElement('span')
    text.className = 'variable-name'
    text.textContent = header + (label ? ` (${label})` : '')
    text.title = bootstrap.l10n.InsertVariableInFilter
    text.addEventListener('click', (e) => {
      e.stopPropagation()
      showVariableFilterMenu(i, text)
    })

    info.appendChild(checkbox)
    info.appendChild(text)

    const btn = document.createElement('button')
    btn.className = 'outline'
    btn.textContent = bootstrap.l10n.Explore
    btn.onclick = () => openExplorer(i)

    div.appendChild(info)
    div.appendChild(btn)
    return div
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

  /**
   * 创建包含全部变量下标的集合。
   */
  function createAllColumnSet() {
    const all = new Set()
    for (let i = 0; i < meta.headers.length; i++)
      all.add(i)
    return all
  }

  selectAllVariables.addEventListener('click', () => {
    visibleColumns = createAllColumnSet()
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
    variableSearchQuery = e.target.value.trim().toLowerCase()
    renderSidebar({ resetScroll: true })
  })
  variableList.addEventListener('scroll', () => {
    if (variableScrollScheduled)
      return
    variableScrollScheduled = true
    requestAnimationFrame(() => {
      variableScrollScheduled = false
      renderVariableListWindow()
    })
  })

  // ---------- 顶部工具栏 ----------

  valueLabelModeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled)
        return
      valueLabelDisplayMode = normalizeValueLabelDisplayMode(button.dataset.valueLabelMode)
      updateValueLabelModeControl()
      renderHeader()
      renderBodyWindow()
    })
  })
  refreshData.addEventListener('click', () => {
    vscode.postMessage({ command: 'refresh' })
  })
  exportData.addEventListener('click', (e) => {
    e.stopPropagation()
    showExportMenu(exportData)
  })
  helpMenu.addEventListener('click', (e) => {
    e.stopPropagation()
    showHelpMenu(helpMenu)
  })
  toggleSidebar.addEventListener('change', (e) => {
    sidebarVisible = e.target.checked
    layoutContainer.classList.toggle('sidebar-hidden', !sidebarVisible)
    updateSidebarToggle()
  })
  highlightMissing.addEventListener('change', (e) => {
    updateHighlightMissingState(e.target.checked)
  })
  rowDetailClose.addEventListener('click', clearSelectedRow)
  sidebarPositionBtn.addEventListener('click', () => {
    sidebarPosition = sidebarPosition === 'right' ? 'bottom' : 'right'
    layoutContainer.classList.toggle('sidebar-bottom', sidebarPosition === 'bottom')
    updateSidebarPositionButton()
  })

  // ---------- 文件信息弹窗 ----------

  function openFileInfo() {
    renderFileInfo()
    fileInfoDialog.show()
  }

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

  // ---------- 变量字典弹窗 ----------

  /**
   * 打开变量字典弹窗。
   */
  async function openVariableDictionary() {
    dictionaryDialog.show()
    if (variableDictionaryEntries) {
      renderVariableDictionary()
      return
    }

    dictionaryBody.innerHTML = `<div class="dictionary-loading">${bootstrap.l10n.LoadingVariableDictionary}</div>`
    try {
      const res = await postRequest('getVariableDictionary', {})
      variableDictionaryEntries = Array.isArray(res.entries) ? res.entries : []
      renderVariableDictionary()
    }
    catch (e) {
      if (e.stale)
        return
      dictionaryBody.innerHTML = `<div class="dictionary-error">${bootstrap.l10n.ErrorPrefix} ${escapeHtml(String(e.message || e))}</div>`
    }
  }

  /**
   * 渲染变量字典外壳和当前搜索结果。
   */
  function renderVariableDictionary() {
    const query = escapeHtml(dictionarySearchQuery)
    dictionaryBody.innerHTML = `
      <div class="dictionary-control-panel">
        <input id="dictionary-search" class="bordered" type="text" placeholder="${bootstrap.l10n.FilterDictionary}" value="${query}">
        <div class="dictionary-actions">
          <button id="dictionary-export-csv" class="outline" title="${bootstrap.l10n.ExportAsCsv}">${bootstrap.l10n.ExportAsCsv}</button>
          <button id="dictionary-export-xlsx" class="outline" title="${bootstrap.l10n.ExportAsExcel}">${bootstrap.l10n.ExportAsExcel}</button>
        </div>
      </div>
      <div id="dictionary-result"></div>
    `

    const input = document.getElementById('dictionary-search')
    input.addEventListener('input', (e) => {
      dictionarySearchQuery = e.target.value.trim().toLowerCase()
      renderVariableDictionaryResult()
    })
    document.getElementById('dictionary-export-csv').addEventListener('click', () => {
      void exportVariableDictionaryData('csv')
    })
    document.getElementById('dictionary-export-xlsx').addEventListener('click', () => {
      void exportVariableDictionaryData('xlsx')
    })
    renderVariableDictionaryResult()
  }

  /**
   * 渲染变量字典表格。
   */
  function renderVariableDictionaryResult() {
    const resultEl = document.getElementById('dictionary-result')
    if (!resultEl)
      return
    const entries = variableDictionaryEntries || []
    const filtered = filterVariableDictionaryEntries(entries)
    const summary = formatL10n(
      bootstrap.l10n.VariableDictionarySummary,
      fmtInt(filtered.length),
      fmtInt(entries.length),
    )

    if (filtered.length === 0) {
      resultEl.innerHTML = `
        <div class="dictionary-summary">${summary}</div>
        <div class="dictionary-empty-state">${bootstrap.l10n.NoData}</div>
      `
      return
    }

    resultEl.innerHTML = `
      <div class="dictionary-summary">${summary}</div>
      <div class="dictionary-table-wrap">
        <table class="flat">
          <thead>
            <tr>
              <th>${bootstrap.l10n.Number}</th>
              <th>${bootstrap.l10n.Variable}</th>
              <th>${bootstrap.l10n.VariableLabel}</th>
              <th>${bootstrap.l10n.Type}</th>
              <th>${bootstrap.l10n.StatisticalType}</th>
              <th class="cell-right">${bootstrap.l10n.ValidN}</th>
              <th class="cell-right">${bootstrap.l10n.Missing}</th>
              <th class="cell-right">${bootstrap.l10n.Unique}</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(renderVariableDictionaryRow).join('')}
          </tbody>
        </table>
      </div>
    `
  }

  /**
   * 按弹窗搜索条件过滤变量字典。
   */
  function filterVariableDictionaryEntries(entries) {
    const query = dictionarySearchQuery.trim().toLowerCase()
    if (!query)
      return entries

    return entries.filter((entry) => {
      const text = [
        entry.index,
        entry.name,
        entry.label,
        entry.type,
        getDictionaryStatTypeLabel(entry.statType),
      ].filter(Boolean).join(' ').toLowerCase()
      return text.includes(query)
    })
  }

  /**
   * 渲染变量字典中的一行。
   */
  function renderVariableDictionaryRow(entry) {
    return `<tr>
      <td>${fmtNum(entry.index)}</td>
      <td>${renderDictionaryText(entry.name)}</td>
      <td>${renderDictionaryText(entry.label, '')}</td>
      <td>${renderDictionaryText(entry.type)}</td>
      <td>${escapeHtml(getDictionaryStatTypeLabel(entry.statType))}</td>
      <td class="cell-right">${fmtNum(entry.nValid)}</td>
      <td class="cell-right">${renderDictionaryMissing(entry)}</td>
      <td class="cell-right">${fmtNum(entry.nUnique)}</td>
    </tr>`
  }

  /**
   * 本地化变量字典中的统计类型。
   */
  function getDictionaryStatTypeLabel(statType) {
    if (statType === 'continuous')
      return bootstrap.l10n.Continuous
    if (statType === 'discrete')
      return bootstrap.l10n.Discrete
    return bootstrap.l10n.StringType
  }

  /**
   * 渲染缺失数和缺失率。
   */
  function renderDictionaryMissing(entry) {
    const nMissing = Number.isFinite(entry.nMissing) ? entry.nMissing : 0
    const nValid = Number.isFinite(entry.nValid) ? entry.nValid : 0
    const total = nMissing + nValid
    const pct = total > 0 ? (nMissing / total) * 100 : 0
    return formatL10n(bootstrap.l10n.MissingSummary, fmtNum(nMissing), pct.toFixed(1))
  }

  /**
   * 渲染字典普通文本单元格。
   */
  function renderDictionaryText(value, emptyText = '—') {
    if (value === null || value === undefined || String(value).length === 0)
      return emptyText
    return escapeHtml(value)
  }

  /**
   * 导出变量字典。
   */
  async function exportVariableDictionaryData(format) {
    setDictionaryExportBusy(true)
    try {
      await postRequest('exportVariableDictionary', { format })
    }
    catch (e) {
      if (!e.stale)
        console.error('export variable dictionary failed', e)
    }
    finally {
      setDictionaryExportBusy(false)
    }
  }

  /**
   * 导出期间禁用字典导出按钮。
   */
  function setDictionaryExportBusy(busy) {
    dictionaryBody.querySelectorAll('#dictionary-export-csv, #dictionary-export-xlsx').forEach((button) => {
      button.disabled = busy
    })
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
      if (explorerExpr.trim())
        rememberFilterExpression(explorerExpr)
      resultEl.innerHTML = renderTabulateResult(res.result, explorerVar, res.scopeN)
      hydrateBarWidths(resultEl)
    }
    catch (e) {
      if (e.stale)
        return
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
          <div class="explorer-filter-field">
            <input id="explorer-filter-input" class="bordered" type="text" placeholder="${bootstrap.l10n.filterForTabulationPlaceholder}" value="${escapeHtml(explorerExpr)}">
            <button id="explorer-filter-tools" class="icon" title="${bootstrap.l10n.FilterTools}">${FILTER_ICON_SVG}</button>
            <div id="explorer-filter-assist" class="filter-assist" hidden></div>
          </div>
          <button id="explorer-filter-apply" title="${bootstrap.l10n.ApplyFilterTitle}">${bootstrap.l10n.Apply}</button>
          <button id="explorer-filter-clear" title="${bootstrap.l10n.ClearFilterTitle}">${bootstrap.l10n.Clear}</button>
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
    const tools = document.getElementById('explorer-filter-tools')
    const assist = document.getElementById('explorer-filter-assist')
    const apply = document.getElementById('explorer-filter-apply')
    const clear = document.getElementById('explorer-filter-clear')
    const inherit = document.getElementById('explorer-inherit')
    let target = null
    const onApply = () => {
      explorerExpr = input.value
      hideFilterAssist(target)
      runTabulate()
    }
    target = createFilterAssistTarget({
      input,
      panel: assist,
      clearError: clearExplorerFilterError,
      onApply,
    })
    apply.addEventListener('click', onApply)
    input.addEventListener('keydown', e => handleFilterInputKeydown(target, e))
    input.addEventListener('input', () => {
      clearExplorerFilterError()
      updateFilterAutocomplete(target, false)
    })
    input.addEventListener('click', () => updateFilterAutocomplete(target, false))
    tools.addEventListener('click', (e) => {
      e.stopPropagation()
      showFilterToolsMenu(target, tools)
    })
    clear.addEventListener('click', () => {
      explorerExpr = ''
      hideFilterAssist(target)
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
    if (r.nUnique !== undefined) {
      html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Unique}</div><div class="stat-value">${fmtNum(r.nUnique)}</div></div>`
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
    html += `<thead><tr><th>${bootstrap.l10n.Value}</th><th>${bootstrap.l10n.ValueLabel}</th><th class="cell-right">${bootstrap.l10n.Freq}</th><th class="cell-right">${bootstrap.l10n.Percent}</th><th class="cell-right">${bootstrap.l10n.CumPercent}</th><th class="bar-cell">${bootstrap.l10n.Bar}</th></tr></thead><tbody>`
    for (const e of r.entries) {
      const pctOfMax = maxFreq > 0 ? (e.freq / maxFreq * 100) : 0
      const lbl = e.label !== undefined && e.label !== null ? escapeHtml(e.label) : ''
      html += `<tr>
          <td>${renderValueCell(e.value)}</td>
          <td>${lbl}</td>
          <td class="cell-right">${fmtNum(e.freq)}</td>
          <td class="cell-right">${e.pct.toFixed(2)}</td>
          <td class="cell-right">${e.cum.toFixed(2)}</td>
          <td class="bar-cell"><div class="bar-chart"><div class="bar-fill" data-width="${barWidthValue(pctOfMax)}"></div></div></td>
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
    html += `<thead><tr><th>${bootstrap.l10n.Value}</th><th class="cell-right">${bootstrap.l10n.Freq}</th><th class="cell-right">${bootstrap.l10n.Percent}</th><th class="bar-cell">${bootstrap.l10n.Bar}</th></tr></thead><tbody>`
    for (const e of r.topValues) {
      const pctOfMax = maxFreq > 0 ? (e.freq / maxFreq * 100) : 0
      html += `<tr>
          <td>${renderValueCell(e.value)}</td>
          <td class="cell-right">${fmtNum(e.freq)}</td>
          <td class="cell-right">${e.pct.toFixed(2)}</td>
          <td class="bar-cell"><div class="bar-chart"><div class="bar-fill" data-width="${barWidthValue(pctOfMax)}"></div></div></td>
        </tr>`
    }
    html += '</tbody></table></div>'
    return html
  }

  /**
   * 将柱状图宽度写入 CSSOM，避免在 HTML 字符串里生成 style 属性。
   */
  function hydrateBarWidths(root) {
    root.querySelectorAll('.bar-fill[data-width]').forEach((bar) => {
      const width = Number.parseFloat(bar.dataset.width || '0')
      bar.style.width = `${Number.isFinite(width) ? width : 0}%`
      bar.removeAttribute('data-width')
    })
  }

  /**
   * 生成安全的柱状图百分比。
   */
  function barWidthValue(value) {
    const width = Number.isFinite(value) ? value : 0
    return Math.max(0, Math.min(100, width)).toFixed(4)
  }

  /**
   * 渲染统计表中的值单元格。
   */
  function renderValueCell(value) {
    const text = String(value)
    if (isWhitespaceOnlyString(text))
      return `<span class="whitespace-value">${escapeHtml(formatWhitespacePreview(text))}</span>`
    return escapeHtml(text)
  }

  /**
   * 将纯空白字符串转换为可见标记。
   */
  function formatWhitespacePreview(value) {
    const chars = Array.from(value)
    if (chars.length === 0)
      return ''
    if (chars.every(ch => ch === chars[0]))
      return `${whitespaceSymbol(chars[0])}×${chars.length}`
    return chars.map(whitespaceSymbol).join('')
  }

  /**
   * 将单个空白字符转换为可见符号。
   */
  function whitespaceSymbol(ch) {
    if (ch === ' ')
      return '␠'
    if (ch === '\t')
      return '⇥'
    if (ch === '\n')
      return '↵'
    if (ch === '\r')
      return '␍'
    return `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
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

  /**
   * 初始化行详情面板高度拖拽手柄。
   */
  function initRowDetailResizeHandle() {
    let isResizing = false
    let startY = 0
    let startH = 0
    let pendingHeight = 0
    let resizeRaf = 0

    const normalizeHeight = (height) => {
      const minHeight = 120
      const panelHeight = mainPanel.clientHeight || window.innerHeight || 600
      const maxHeight = Math.max(minHeight, Math.min(panelHeight - 160, panelHeight * 0.75))
      return Math.max(minHeight, Math.min(maxHeight, height))
    }

    const applyHeight = (height) => {
      rowDetailPanel.style.setProperty('--row-detail-height', `${normalizeHeight(height)}px`)
    }

    const queueHeight = (height) => {
      pendingHeight = height
      if (resizeRaf)
        return
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0
        applyHeight(pendingHeight)
      })
    }

    const finishResize = () => {
      if (!isResizing)
        return
      if (resizeRaf) {
        cancelAnimationFrame(resizeRaf)
        resizeRaf = 0
        applyHeight(pendingHeight)
      }
      isResizing = false
      mainPanel.classList.remove('row-detail-resizing')
      requestAnimationFrame(renderBodyWindow)
    }

    rowDetailResizeHandle.addEventListener('mousedown', (e) => {
      if (rowDetailPanel.hidden)
        return
      isResizing = true
      startY = e.clientY
      startH = rowDetailPanel.getBoundingClientRect().height
      pendingHeight = startH
      mainPanel.classList.add('row-detail-resizing')
      e.preventDefault()
    })
    document.addEventListener('mousemove', (e) => {
      if (!isResizing)
        return
      queueHeight(startH - (e.clientY - startY))
    })
    document.addEventListener('mouseup', finishResize)
    window.addEventListener('blur', finishResize)
  }

  /**
   * 初始化行详情表列宽拖拽手柄。
   */
  function initRowDetailColumnResize() {
    let resizingTh = null
    let resizingIndex = -1
    let startX = 0
    let startWidth = 0

    const finishResize = () => {
      if (!resizingTh)
        return
      resizingTh.classList.remove('is-resizing')
      resizingTh = null
      resizingIndex = -1
    }

    rowDetailTable.querySelectorAll('thead th').forEach((th, index) => {
      if (th.querySelector('.row-detail-column-resize-handle'))
        return
      const handle = document.createElement('div')
      handle.className = 'resize-handle row-detail-column-resize-handle'
      th.appendChild(handle)
      handle.addEventListener('mousedown', (e) => {
        resizingTh = th
        resizingIndex = index
        startX = e.clientX
        startWidth = rowDetailColumnWidths[index] || th.offsetWidth
        th.classList.add('is-resizing')
        e.stopPropagation()
        e.preventDefault()
      })
    })

    document.addEventListener('mousemove', (e) => {
      if (!resizingTh || resizingIndex < 0)
        return
      const width = Math.max(60, startWidth + e.clientX - startX)
      rowDetailColumnWidths[resizingIndex] = width
      syncRowDetailColumnLayout()
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
      if (col != null) {
        colWidths[col] = w
        syncTableColumnLayout()
      }
    })
    document.addEventListener('mouseup', finishColumnResize)
    window.addEventListener('blur', finishColumnResize)
  }
})()
