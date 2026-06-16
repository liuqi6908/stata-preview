/**
 * 数据表头、表体与虚拟滚动渲染。
 */

// ---------- 表格入口 ----------

/**
 * 重新渲染完整表格
 */
function renderTable() {
  gridContainer.scrollTop = 0
  renderHeader()
  renderBody()
}

// ---------- 列布局 ----------

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
 * 获取当前列宽
 */
function getColumnWidth(i) {
  const header = meta.headers[i]
  return colWidths[header] ?? defaultColWidth(i)
}

/**
 * 获取当前可见列布局
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
 * 同步表格列宽和总宽度
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

// ---------- 表头 ----------

/**
 * 渲染表头
 */
function renderHeader() {
  tableHead.innerHTML = ''
  const tr = document.createElement('tr')
  const specs = getVisibleColumnSpecs()
  syncTableColumnLayout(specs)
  specs.forEach(({ header, index: i, width }) => {
    tr.appendChild(buildHeaderCell(header, i, width))
  })
  tableHead.appendChild(tr)
  initColumnResize()
}

/**
 * 构建单个表头单元格
 */
function buildHeaderCell(header, index, width) {
  const th = document.createElement('th')
  th.dataset.col = header
  th.style.width = `${width}px`
  th.innerHTML = `<span>${escapeHtml(header)}</span>`
  th.title = meta.labels[index] || header
  applyHeaderSortState(th, header)
  th.addEventListener('click', e => handleHeaderCellClick(e, index))
  th.addEventListener('contextmenu', e => handleHeaderCellContextMenu(e, index))
  return th
}

/**
 * 同步表头排序状态
 */
function applyHeaderSortState(th, header) {
  const sortInfo = sortSpec.findIndex(s => s.col === header)
  const sortDir = sortInfo >= 0 ? sortSpec[sortInfo].dir : null
  const sortIndex = sortInfo >= 0 && sortSpec.length > 1 ? sortInfo + 1 : null
  if (!sortDir)
    return
  th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc')
  if (sortIndex)
    th.setAttribute('data-sort', sortIndex)
}

/**
 * 处理表头点击
 */
function handleHeaderCellClick(e, index) {
  if (isResizeHandleEvent(e))
    return
  handleHeaderClick(index, e.shiftKey)
}

/**
 * 处理表头右键菜单
 */
function handleHeaderCellContextMenu(e, index) {
  if (isResizeHandleEvent(e))
    return
  e.preventDefault()
  e.stopPropagation()
  showHeaderContextMenu(index, e.clientX, e.clientY)
}

/**
 * 判断事件是否来自列宽拖拽手柄
 */
function isResizeHandleEvent(e) {
  return e.target instanceof Element && e.target.closest('.resize-handle')
}

// ---------- 表体 ----------

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
    td.dataset.colIndex = String(c)
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

  // 使用真实渲染行修正行高估计，必要时重绘一次可见窗口
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

// ---------- 事件绑定 ----------

/**
 * 滚动时重绘表格可见窗口
 */
function handleGridScroll() {
  if (tableScrollScheduled)
    return
  tableScrollScheduled = true
  requestAnimationFrame(() => {
    tableScrollScheduled = false
    renderBodyWindow()
  })
}

/**
 * 处理表体右键复制菜单
 */
function handleTableBodyContextMenu(e) {
  const target = e.target instanceof Element ? e.target : null
  const cell = target ? target.closest('td[data-col-index]') : null
  if (!cell || !tableBody.contains(cell))
    return

  const row = cell.closest('tr[data-page-row]')
  const pageRow = row ? Number.parseInt(row.dataset.pageRow || '-1', 10) : -1
  const colIndex = Number.parseInt(cell.dataset.colIndex || '-1', 10)
  if (!Number.isInteger(pageRow) || pageRow < 0 || !Number.isInteger(colIndex) || colIndex < 0)
    return

  e.preventDefault()
  e.stopPropagation()
  showDataCellContextMenu(pageRow, colIndex, e.clientX, e.clientY)
}

gridContainer.addEventListener('scroll', handleGridScroll)
tableBody.addEventListener('contextmenu', handleTableBodyContextMenu)
