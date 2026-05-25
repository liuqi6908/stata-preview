/**
 * Webview controller. Holds NO bulk data — only metadata and the current page.
 * All sort/filter/pagination operations round-trip to the extension host.
 */

/* global bootstrap, vscode */

(function () {
  // --- State (filled in once `initData` arrives from the host) ---
  let meta = null // { headers, labels, types, valueLabels, nobs, release }
  let pageSize = bootstrap.pageSize || 5000
  let currentPageRows = []
  let totalFiltered = 0
  let totalAll = 0
  let pageOffset = 0

  let visibleColumns = new Set()
  let colWidths = {} // header name -> px width (persists across re-renders)
  const DEFAULT_COL_WIDTH = 140 // numeric/default
  const DEFAULT_STR_COL_WIDTH = 240 // string columns start wider
  let sortSpec = [] // [{ col: 'edad', dir: 'asc' }, ...]
  let showLabels = false
  let filterQuery = ''
  let sidebarVisible = true
  let sidebarPosition = 'right'

  // --- Body virtualization ---
  // Rendering an entire page as DOM (e.g. 5000 rows x 877 cols = 4.4M <td>)
  // freezes the webview. We instead render only the rows in (or near) the
  // scroll viewport, with spacer rows preserving the real scroll height.
  let estRowHeight = 31 // refined after first paint from a real row
  const ROW_OVERSCAN = 12 // extra rows above/below the viewport
  let virtScrollScheduled = false

  // Pending host requests (for cancellation by id).
  let lastRequestId = 0
  const pending = new Map()
  function nextRequestId() {
    return ++lastRequestId
  }
  function postRequest(command, payload) {
    const requestId = nextRequestId()
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      vscode.postMessage({ command, requestId, ...payload })
    })
  }

  // Per-channel "latest request wins": ignores responses that have been superseded
  // by a newer request on the same logical channel (e.g. user types fast in filter box).
  const latestByChannel = new Map()
  async function postLatest(channel, command, payload) {
    const myId = nextRequestId()
    latestByChannel.set(channel, myId)
    const result = await new Promise((resolve, reject) => {
      pending.set(myId, { resolve, reject })
      vscode.postMessage({ command, requestId: myId, ...payload })
    })
    if (latestByChannel.get(channel) !== myId) {
      // A newer request superseded us; throw a sentinel that callers ignore.
      throw new StaleRequestError(channel)
    }
    return result
  }
  class StaleRequestError extends Error {
    constructor(channel) {
      super(`stale request on ${channel}`)
      this.stale = true
    }
  }

  // --- Elements ---
  const layoutContainer = document.getElementById('layout-container')
  const tableHead = document.getElementById('table-head')
  const tableBody = document.getElementById('table-body')
  const gridWrapper = document.getElementById('grid-wrapper')
  const varList = document.getElementById('var-list')
  const searchInput = document.getElementById('search')
  const searchBtn = document.getElementById('search-btn')
  const clearFilterBtn = document.getElementById('clear-filter-btn')
  const filterError = document.getElementById('filter-error')
  const varSearchInput = document.getElementById('var-search')
  const selectAllVarsBtn = document.getElementById('select-all-vars')
  const deselectAllVarsBtn = document.getElementById('deselect-all-vars')
  const stats = document.getElementById('stats')
  const toggleLabelsBtn = document.getElementById('toggle-labels-btn')
  const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn')
  const sidebarPositionBtn = document.getElementById('sidebar-position-btn')
  const refreshBtn = document.getElementById('refresh-btn')
  const resizeHandle = document.getElementById('resize-handle')
  const sidebar = document.getElementById('sidebar')
  const gridOverlay = document.getElementById('grid-overlay')
  const explorerModal = document.getElementById('explorer-modal')
  const closeExplorerBtn = document.getElementById('close-explorer')
  const explorerVarName = document.getElementById('explorer-var-name')
  const explorerBody = document.getElementById('explorer-body')

  // Pagination
  const pageFirst = document.getElementById('page-first')
  const pagePrev = document.getElementById('page-prev')
  const pageNext = document.getElementById('page-next')
  const pageLast = document.getElementById('page-last')
  const pageInfo = document.getElementById('page-info')
  const pageSizeSelect = document.getElementById('page-size')
  const pageSummary = document.getElementById('page-summary')

  // --- Loading screen elements ---
  const loadingEl = document.getElementById('initial-loading')
  const progressFill = document.getElementById('progress-fill')
  const progressText = document.getElementById('progress-text')

  pageSizeSelect.value = String(pageSize)
  initResizeHandle()

  function hideLoading() {
    if (loadingEl)
      loadingEl.style.display = 'none'
  }
  function showLoading() {
    if (loadingEl) {
      loadingEl.style.display = 'flex'
      progressFill.style.width = '0%'
      progressText.textContent = 'Reading file…'
    }
  }
  function setProgress(rowsRead, totalRows) {
    if (!loadingEl)
      return
    const pct = totalRows > 0 ? (rowsRead / totalRows) * 100 : 0
    progressFill.style.width = `${pct.toFixed(1)}%`
    progressText.textContent = `Loading rows: ${rowsRead.toLocaleString()} / ${totalRows.toLocaleString()} (${pct.toFixed(0)}%)`
  }

  function applyInitData(payload) {
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

  // --- Host messages ---
  window.addEventListener('message', (event) => {
    const msg = event.data
    if (msg.requestId && pending.has(msg.requestId)) {
      const p = pending.get(msg.requestId)
      pending.delete(msg.requestId)
      if (msg.error || msg.command === 'filterError') {
        p.reject(new Error(msg.error || 'Filter error'))
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
        const card = loadingEl.querySelector('.initial-loading-card')
        if (card) {
          card.classList.add('error')
          card.innerHTML = `
                        <h2>Could not open file</h2>
                        <div class="load-error-msg">${escapeHtml(msg.error)}</div>
                    `
        }
      }
    }
  })

  // --- Page navigation ---
  async function loadPage(offset) {
    showOverlay(true, 'Loading page…')
    let succeeded = false
    try {
      const res = await postLatest('page', 'getPage', { offset, limit: pageSize })
      currentPageRows = res.page.rows
      pageOffset = res.page.offset
      totalFiltered = res.page.totalFiltered
      totalAll = res.page.totalAll
      gridWrapper.scrollTop = 0
      renderBody()
      renderPaginationBar()
      succeeded = true
    }
    catch (e) {
      if (!e.stale) {
        console.error('getPage failed', e)
        succeeded = true // hide overlay on real errors too
      }
    }
    // Only hide if no newer request is still pending on the same channel.
    if (succeeded)
      showOverlay(false)
  }

  function showOverlay(show, message) {
    gridOverlay.style.display = show ? 'flex' : 'none'
    if (show && message) {
      const m = gridOverlay.querySelector('.grid-overlay-msg')
      if (m)
        m.textContent = message
    }
  }

  function renderPaginationBar() {
    const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize))
    const currentPage = Math.floor(pageOffset / pageSize) + 1
    pageInfo.textContent = `Page ${currentPage} / ${totalPages}`
    const start = totalFiltered === 0 ? 0 : pageOffset + 1
    const end = Math.min(pageOffset + currentPageRows.length, totalFiltered)
    const filteredNote = totalFiltered === totalAll
      ? ` of ${fmtInt(totalAll)}`
      : ` of ${fmtInt(totalFiltered)} filtered (of ${fmtInt(totalAll)} total)`
    pageSummary.textContent = `Showing ${fmtInt(start)}–${fmtInt(end)}${filteredNote}`
    pageFirst.disabled = pagePrev.disabled = currentPage <= 1
    pageLast.disabled = pageNext.disabled = currentPage >= totalPages
    stats.textContent = `Rows: ${fmtInt(totalFiltered)}`
  }

  function fmtInt(n) {
    return n.toLocaleString()
  }

  pageFirst.addEventListener('click', () => loadPage(0))
  pagePrev.addEventListener('click', () => loadPage(Math.max(0, pageOffset - pageSize)))
  pageNext.addEventListener('click', () => loadPage(pageOffset + pageSize))
  pageLast.addEventListener('click', () => {
    const lastOffset = Math.max(0, (Math.ceil(totalFiltered / pageSize) - 1) * pageSize)
    loadPage(lastOffset)
  })
  pageSizeSelect.addEventListener('change', () => {
    pageSize = Number.parseInt(pageSizeSelect.value, 10) || 5000
    loadPage(0)
  })

  // --- Filter ---
  searchBtn.addEventListener('click', applyFilterAndReload)
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter')
      applyFilterAndReload()
  })
  searchInput.addEventListener('input', clearFilterError)
  clearFilterBtn.addEventListener('click', () => {
    searchInput.value = ''
    filterQuery = ''
    applyFilterAndReload()
  })

  async function applyFilterAndReload() {
    filterQuery = searchInput.value
    clearFilterError()
    showOverlay(true, 'Applying filter…')
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

  function clearFilterError() {
    searchInput.classList.remove('error')
    filterError.textContent = ''
  }
  function showFilterError(msg) {
    searchInput.classList.add('error')
    filterError.textContent = msg
  }

  // --- Sort ---
  async function applySort(spec) {
    sortSpec = spec
    showOverlay(true, 'Sorting…')
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

  function handleHeaderClick(colIndex, shiftKey) {
    const col = meta.headers[colIndex]
    const existing = sortSpec.findIndex(s => s.col === col)
    if (shiftKey) {
      // Multi-sort: toggle this column inside spec
      if (existing === -1) {
        sortSpec.push({ col, dir: 'asc' })
      }
      else {
        const cur = sortSpec[existing]
        if (cur.dir === 'asc')
          sortSpec[existing] = { col, dir: 'desc' }
        else sortSpec.splice(existing, 1)
      }
    }
    else {
      // Single-column: replace spec, cycle asc → desc → none
      if (existing === -1) {
        sortSpec = [{ col, dir: 'asc' }]
      }
      else {
        const cur = sortSpec[existing]
        if (sortSpec.length === 1 && cur.dir === 'asc')
          sortSpec = [{ col, dir: 'desc' }]
        else if (sortSpec.length === 1 && cur.dir === 'desc')
          sortSpec = []
        else sortSpec = [{ col, dir: 'asc' }]
      }
    }
    applySort([...sortSpec])
  }

  // --- Header / body rendering ---
  function renderTable() {
    gridWrapper.scrollTop = 0
    renderHeader()
    renderBody()
    initColumnResize()
  }

  function defaultColWidth(i) {
    const t = meta.types && meta.types[i]
    const isStr = typeof t === 'string' && t.startsWith('str')
    return isStr ? DEFAULT_STR_COL_WIDTH : DEFAULT_COL_WIDTH
  }

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
      th.innerHTML = `<span>${escapeHtml(header)}</span>${
        sortDir ? `<span class="sort-indicator">${sortDir === 'asc' ? ' ▲' : ' ▼'}${sortIdx ? ` ${sortIdx}` : ''}</span>` : ''}`
      th.title = meta.labels[i] || header
      if (sortDir)
        th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc')
      th.addEventListener('click', (e) => {
        if (e.target.classList.contains('resize-handle'))
          return
        handleHeaderClick(i, e.shiftKey)
      })
      tr.appendChild(th)
    })
    tableHead.appendChild(tr)
  }

  function visibleColCount() {
    let n = 0
    for (let c = 0; c < meta.headers.length; c++) {
      if (visibleColumns.has(c))
        n++
    }
    return n
  }

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
      else if (showLabels && meta.valueLabels && meta.valueLabels[meta.headers[c]]) {
        const map = meta.valueLabels[meta.headers[c]]
        if (map[rawVal] !== undefined) {
          td.textContent = map[rawVal]
          td.title = `Value: ${rawVal}`
        }
        else {
          td.textContent = String(rawVal)
        }
      }
      else {
        td.textContent = String(rawVal)
      }
      tr.appendChild(td)
    }
    return tr
  }

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

  // Render only the rows in/near the scroll viewport. Spacer <tr>s above and
  // below reserve the full scroll height so the scrollbar stays accurate.
  function renderBody() {
    const total = currentPageRows.length
    if (total === 0) {
      tableBody.innerHTML = ''
      return
    }

    const colspan = Math.max(1, visibleColCount())
    const viewportH = gridWrapper.clientHeight || 600
    const scrollTop = gridWrapper.scrollTop

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

    // Refine the row-height estimate from a real rendered row, then
    // re-render once if it was off enough to misplace the window.
    const sampleRow = tableBody.querySelector('tr:not(.v-spacer)')
    if (sampleRow) {
      const h = sampleRow.getBoundingClientRect().height
      if (h > 0 && Math.abs(h - estRowHeight) > 1) {
        estRowHeight = h
        renderBodyWindow()
      }
    }
  }

  // Re-render just the visible window (used on scroll; never rebuilds header).
  function renderBodyWindow() {
    if (!meta || currentPageRows.length === 0)
      return
    renderBody()
  }

  gridWrapper.addEventListener('scroll', () => {
    if (virtScrollScheduled)
      return
    virtScrollScheduled = true
    requestAnimationFrame(() => {
      virtScrollScheduled = false
      renderBodyWindow()
    })
  })

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      '\'': '&#39;',
    })[c])
  }

  // --- Sidebar ---
  function renderSidebar() {
    varList.innerHTML = ''
    meta.headers.forEach((header, i) => {
      const label = meta.labels[i]
      const div = document.createElement('div')
      div.className = 'var-item-with-explore'

      const varInfo = document.createElement('div')
      varInfo.className = 'var-info'

      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = visibleColumns.has(i)
      checkbox.addEventListener('change', (e) => {
        if (e.target.checked)
          visibleColumns.add(i)
        else visibleColumns.delete(i)
        renderHeader()
        renderBody()
        updateBulkActions()
      })

      const text = document.createElement('label')
      text.textContent = header + (label ? ` (${label})` : '')
      text.title = label || header
      text.onclick = () => checkbox.click()

      varInfo.appendChild(checkbox)
      varInfo.appendChild(text)

      const exploreBtn = document.createElement('button')
      exploreBtn.className = 'btn-explore'
      exploreBtn.textContent = 'Explore'
      exploreBtn.onclick = () => openExplorer(i)

      div.appendChild(varInfo)
      div.appendChild(exploreBtn)
      varList.appendChild(div)
    })
    updateBulkActions()
  }

  // "Select all" only shows when not every variable is selected.
  // "Deselect all" only shows when at least one variable is selected.
  function updateBulkActions() {
    if (!meta)
      return
    const total = meta.headers.length
    const selected = visibleColumns.size
    selectAllVarsBtn.style.display = selected < total ? '' : 'none'
    deselectAllVarsBtn.style.display = selected > 0 ? '' : 'none'
  }

  selectAllVarsBtn.addEventListener('click', () => {
    visibleColumns = new Set(meta.headers.map((_, i) => i))
    renderSidebar()
    renderHeader()
    renderBody()
  })
  deselectAllVarsBtn.addEventListener('click', () => {
    visibleColumns = new Set()
    renderSidebar()
    renderHeader()
    renderBody()
  })

  varSearchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase()
    varList.querySelectorAll('.var-item-with-explore').forEach((item) => {
      item.style.display = item.textContent.toLowerCase().includes(query) ? '' : 'none'
    })
  })

  // --- Top toolbar buttons ---
  refreshBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'refresh' })
  })
  toggleLabelsBtn.addEventListener('click', () => {
    showLabels = !showLabels
    toggleLabelsBtn.textContent = `Labels: ${showLabels ? 'ON' : 'OFF'}`
    renderBody()
  })
  toggleSidebarBtn.addEventListener('click', () => {
    sidebarVisible = !sidebarVisible
    layoutContainer.classList.toggle('sidebar-hidden', !sidebarVisible)
  })
  sidebarPositionBtn.addEventListener('click', () => {
    sidebarPosition = sidebarPosition === 'right' ? 'bottom' : 'right'
    layoutContainer.classList.toggle('sidebar-bottom', sidebarPosition === 'bottom')
  })

  // --- Variable Explorer ---
  closeExplorerBtn.addEventListener('click', () => explorerModal.classList.remove('show'))
  explorerModal.addEventListener('click', (e) => {
    if (e.target === explorerModal)
      explorerModal.classList.remove('show')
  })

  // Explorer-local state, reset every time the modal opens.
  let explorerVar = null
  let explorerExpr = ''
  let explorerInheritGeneral = false

  async function openExplorer(varIndex) {
    explorerVar = meta.headers[varIndex]
    const varLabel = meta.labels[varIndex]
    explorerExpr = ''
    explorerInheritGeneral = false
    explorerVarName.textContent = explorerVar + (varLabel ? ` - ${varLabel}` : '')
    explorerModal.classList.add('show')
    await runTabulate()
  }

  async function runTabulate() {
    // Render the filter panel + a placeholder for the result so the user can
    // tweak the expression while the previous result is still on screen.
    explorerBody.innerHTML = `${renderExplorerFilterPanel()
    }<div id="explorer-result"><div class="explorer-loading">Computing...</div></div>`
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
        resultEl.innerHTML = '<div class="explorer-error">Fix the filter to compute results.</div>'
        return
      }
      clearExplorerFilterError()
      resultEl.innerHTML = renderTabulateResult(res.result, explorerVar, res.scopeN)
    }
    catch (e) {
      resultEl.innerHTML = `<div class="explorer-error">Error: ${escapeHtml(String(e.message || e))}</div>`
    }
  }

  function renderExplorerFilterPanel() {
    const generalActive = totalFiltered !== totalAll
    const inheritDisabled = !generalActive
    const inheritChecked = explorerInheritGeneral && generalActive
    const generalNote = generalActive
      ? `(general filter: ${fmtInt(totalFiltered)} / ${fmtInt(totalAll)} rows)`
      : `(no general filter active)`
    return `
            <div class="explorer-filter-panel">
                <div class="explorer-filter-row">
                    <input type="text" id="explorer-filter-input" placeholder="Filter for this tabulation, e.g. edad == 30 & treatment == 1"
                           value="${escapeHtml(explorerExpr)}">
                    <button id="explorer-filter-apply" class="btn-search">Apply</button>
                    <button id="explorer-filter-clear" class="btn-toggle">Clear</button>
                </div>
                <div class="explorer-filter-row explorer-filter-options">
                    <label class="explorer-inherit">
                        <input type="checkbox" id="explorer-inherit"
                               ${inheritChecked ? 'checked' : ''}
                               ${inheritDisabled ? 'disabled' : ''}>
                        <span>Combine with general filter</span>
                        <span class="explorer-inherit-note">${generalNote}</span>
                    </label>
                    <span id="explorer-filter-error" class="filter-error"></span>
                </div>
            </div>
        `
  }

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

  function showExplorerFilterError(msg) {
    const input = document.getElementById('explorer-filter-input')
    const err = document.getElementById('explorer-filter-error')
    if (input)
      input.classList.add('error')
    if (err)
      err.textContent = msg
  }
  function clearExplorerFilterError() {
    const input = document.getElementById('explorer-filter-input')
    const err = document.getElementById('explorer-filter-error')
    if (input)
      input.classList.remove('error')
    if (err)
      err.textContent = ''
  }

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

  function renderTabulateResult(r, varName, scopeN) {
    const total = r.nValid + r.nMissing
    const missingPct = total > 0 ? (r.nMissing / total * 100).toFixed(1) : '0.0'
    let badge, badgeClass
    if (r.kind === 'discrete') {
      badge = 'Discrete'
      badgeClass = 'var-type-categorical'
    }
    else if (r.kind === 'continuous') {
      badge = 'Continuous'
      badgeClass = 'var-type-continuous'
    }
    else {
      badge = 'String'
      badgeClass = 'var-type-string'
    }

    let html = `<span class="var-type-badge ${badgeClass}">${badge}</span>`
    if (typeof scopeN === 'number') {
      html += `<span class="explorer-scope-info">Tabulating ${fmtNum(scopeN)} of ${fmtNum(totalAll)} rows.</span>`
    }
    html += '<div class="explorer-section"><h3>General</h3><div class="stats-grid">'
    html += `<div class="stat-item"><div class="stat-label">Valid N</div><div class="stat-value">${fmtNum(r.nValid)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">Missing</div><div class="stat-value">${fmtNum(r.nMissing)} (${missingPct}%)</div></div>`
    if (r.nUnique !== undefined && r.nUnique >= 0) {
      html += `<div class="stat-item"><div class="stat-label">Unique</div><div class="stat-value">${fmtNum(r.nUnique)}</div></div>`
    }
    else if (r.kind === 'continuous' && r.nUnique === -1) {
      html += `<div class="stat-item"><div class="stat-label">Unique</div><div class="stat-value">&gt; 200</div></div>`
    }
    html += '</div></div>'
    if (r.kind === 'discrete')
      html += renderDiscrete(r)
    else if (r.kind === 'continuous')
      html += renderContinuous(r)
    else html += renderStringTop(r)
    return html
  }

  function renderDiscrete(r) {
    const maxFreq = r.entries.reduce((m, e) => Math.max(m, e.freq), 0)
    let html = '<div class="explorer-section"><h3>Frequency Distribution</h3>'
    html += '<table class="freq-table">'
    html += '<thead><tr><th>Value</th><th>Label</th><th style="text-align:right">Freq</th><th style="text-align:right">%</th><th style="text-align:right">Cum %</th><th>Bar</th></tr></thead><tbody>'
    for (const e of r.entries) {
      const pctOfMax = maxFreq > 0 ? (e.freq / maxFreq * 100) : 0
      const lbl = e.label !== undefined && e.label !== null ? escapeHtml(e.label) : ''
      html += `<tr>
                <td>${escapeHtml(String(e.value))}</td>
                <td>${lbl}</td>
                <td style="text-align:right">${fmtNum(e.freq)}</td>
                <td style="text-align:right">${e.pct.toFixed(2)}</td>
                <td style="text-align:right">${e.cum.toFixed(2)}</td>
                <td><div class="bar-cell"><div class="bar-fill" style="width:${pctOfMax}%"></div></div></td>
            </tr>`
    }
    html += '</tbody></table></div>'
    return html
  }

  function renderContinuous(r) {
    let html = ''
    html += '<div class="explorer-section"><h3>Descriptive Statistics</h3><div class="stats-grid">'
    html += `<div class="stat-item"><div class="stat-label">Mean</div><div class="stat-value">${fmtNum(r.mean)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">Std Dev</div><div class="stat-value">${fmtNum(r.sd)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">Min</div><div class="stat-value">${fmtNum(r.min)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">Max</div><div class="stat-value">${fmtNum(r.max)}</div></div>`
    html += '</div></div>'
    html += '<div class="explorer-section"><h3>Percentiles</h3><div class="stats-grid">'
    html += `<div class="stat-item"><div class="stat-label">P1</div><div class="stat-value">${fmtNum(r.p1)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">P25</div><div class="stat-value">${fmtNum(r.p25)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">Median</div><div class="stat-value">${fmtNum(r.median)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">P75</div><div class="stat-value">${fmtNum(r.p75)}</div></div>`
    html += `<div class="stat-item"><div class="stat-label">P99</div><div class="stat-value">${fmtNum(r.p99)}</div></div>`
    html += '</div></div>'
    const chart = r.chart
    if (chart) {
      const title = chart.type === 'bars' ? 'Distribution (per value)' : 'Histogram'
      html += `<div class="explorer-section"><h3>${title}</h3>`
      if (chart.type === 'bars')
        html += renderValueBarsSVG(chart.bars)
      else html += renderHistogramSVG(chart.bins)
      html += '</div>'
    }
    return html
  }

  function renderValueBarsSVG(bars) {
    if (!bars || bars.length === 0)
      return '<div>No data</div>'
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
    let svg = `<svg class="hist-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`
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
      svg += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" class="hist-bar"><title>${escapeHtml(`${fmtNum(b.value)}  n=${fmtNum(b.count)}`)}</title></rect>`
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

  function renderHistogramSVG(bins) {
    if (!bins || bins.length === 0)
      return '<div>No data</div>'
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
    let svg = `<svg class="hist-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`
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
      const tt = `[${fmtNum(b.lo)}, ${fmtNum(b.hi)})  n=${fmtNum(b.count)}`
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

  function renderStringTop(r) {
    const maxFreq = r.topValues.reduce((m, e) => Math.max(m, e.freq), 0)
    let html = '<div class="explorer-section"><h3>Top 10 Values</h3>'
    html += '<table class="freq-table">'
    html += '<thead><tr><th>Value</th><th style="text-align:right">Freq</th><th style="text-align:right">%</th><th>Bar</th></tr></thead><tbody>'
    for (const e of r.topValues) {
      const pctOfMax = maxFreq > 0 ? (e.freq / maxFreq * 100) : 0
      html += `<tr>
                <td>${escapeHtml(e.value)}</td>
                <td style="text-align:right">${fmtNum(e.freq)}</td>
                <td style="text-align:right">${e.pct.toFixed(2)}</td>
                <td><div class="bar-cell"><div class="bar-fill" style="width:${pctOfMax}%"></div></div></td>
            </tr>`
    }
    html += '</tbody></table></div>'
    return html
  }

  // --- Resize handles ---
  function initResizeHandle() {
    let isResizing = false
    let startX = 0
    let startY = 0
    let startW = 0
    let startH = 0
    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true
      startX = e.clientX
      startY = e.clientY
      if (sidebarPosition === 'right')
        startW = sidebar.offsetWidth
      else startH = sidebar.offsetHeight
      e.preventDefault()
    })
    document.addEventListener('mousemove', (e) => {
      if (!isResizing)
        return
      if (sidebarPosition === 'right') {
        const delta = startX - e.clientX
        sidebar.style.width = `${Math.max(150, Math.min(600, startW + delta))}px`
      }
      else {
        const delta = startY - e.clientY
        sidebar.style.height = `${Math.max(100, Math.min(500, startH + delta))}px`
      }
    })
    document.addEventListener('mouseup', () => {
      isResizing = false
    })
  }

  let resizingCol = null
  let resizeStartX = 0
  let resizeStartWidth = 0
  function initColumnResize() {
    const ths = tableHead.querySelectorAll('th')
    ths.forEach((th) => {
      const handle = document.createElement('div')
      handle.className = 'resize-handle'
      th.appendChild(handle)
      handle.addEventListener('mousedown', (e) => {
        resizingCol = th
        resizeStartX = e.clientX
        resizeStartWidth = th.offsetWidth
        e.stopPropagation()
        e.preventDefault()
      })
    })
    document.addEventListener('mousemove', (e) => {
      if (!resizingCol)
        return
      const delta = e.clientX - resizeStartX
      const w = Math.max(40, resizeStartWidth + delta)
      resizingCol.style.width = `${w}px`
      // Persist so sort/filter/paging re-renders keep the chosen width.
      const col = resizingCol.dataset.col
      if (col != null)
        colWidths[col] = w
    })
    document.addEventListener('mouseup', () => {
      resizingCol = null
    })
  }
})()
