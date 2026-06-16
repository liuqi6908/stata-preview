/**
 * 分页、值标签与行详情逻辑。
 */

// ---------- 页面加载 ----------

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
      succeeded = true
    }
  }
  // 只有当前请求没有被更新请求取代时，才隐藏遮罩
  if (succeeded)
    showOverlay(false)
}

/**
 * 显示或隐藏表格计算遮罩
 */
function showOverlay(show, message) {
  gridOverlay.style.display = show ? 'flex' : 'none'
  if (show && message && gridOverlayMessage)
    gridOverlayMessage.textContent = message
}

/**
 * 渲染分页栏状态
 */
function renderPaginationBar() {
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize))
  const currentPage = Math.floor(pageOffset / pageSize) + 1
  pageInfo.textContent = formatL10n(bootstrap.l10n.PageInfo, formatInt(currentPage), formatInt(totalPages))
  const start = totalFiltered === 0 ? 0 : pageOffset + 1
  const end = Math.min(pageOffset + currentPageRows.length, totalFiltered)
  pageSummary.textContent = totalFiltered === totalAll
    ? formatL10n(bootstrap.l10n.PageSummaryAll, formatInt(start), formatInt(end), formatInt(totalAll))
    : formatL10n(bootstrap.l10n.PageSummaryFiltered, formatInt(start), formatInt(end), formatInt(totalFiltered), formatInt(totalAll))
  pageFirst.disabled = pagePrev.disabled = currentPage <= 1
  pageLast.disabled = pageNext.disabled = currentPage >= totalPages
  if (fileInfoDialog.isOpen())
    renderFileInfo()
}

// ---------- 值标签 ----------

/**
 * 规范化宿主下发的值标签映射
 */
function normalizeValueLabels(valueLabels) {
  return valueLabels && typeof valueLabels === 'object' ? valueLabels : {}
}

/**
 * 规范化当前页原始行索引
 */
function normalizePageRowIndices(rowIndices, rowCount, offset = pageOffset) {
  if (!Array.isArray(rowIndices))
    return Array.from({ length: rowCount }, (_, i) => offset + i)
  return rowIndices
}

/**
 * 规范化值标签显示模式
 */
function normalizeValueLabelDisplayMode(mode) {
  return VALUE_LABEL_DISPLAY_MODES.has(mode) ? mode : 'raw'
}

/**
 * 获取指定列的值标签表
 */
function getValueLabelMap(colIndex) {
  if (!meta)
    return null
  const header = meta.headers[colIndex]
  const labelMap = meta.valueLabels && meta.valueLabels[header]
  return labelMap && typeof labelMap === 'object' ? labelMap : null
}

/**
 * 指定列是否绑定了值标签
 */
function hasValueLabelColumn(colIndex) {
  const labelMap = getValueLabelMap(colIndex)
  return !!labelMap && Object.keys(labelMap).length > 0
}

/**
 * 当前数据集是否包含任意值标签
 */
function hasAnyValueLabels() {
  if (!meta || !meta.valueLabels)
    return false
  return Object.values(meta.valueLabels).some(labelMap =>
    labelMap && typeof labelMap === 'object' && Object.keys(labelMap).length > 0,
  )
}

/**
 * 查找单元格原始值对应的值标签
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
 * 按当前显示模式格式化单元格文本
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

// ---------- 行选择与详情 ----------

/**
 * 清除当前行选择并关闭详情面板
 */
function clearSelectedRow() {
  selectedPageRow = null
  hideRowDetailPanel()
  updateSelectedRowMarkers()
}

/**
 * 选中当前页中的一行
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
 * 同步当前虚拟窗口里的行选中样式
 */
function updateSelectedRowMarkers() {
  tableBody.querySelectorAll('tr[data-page-row]').forEach((tr) => {
    const pageRow = Number.parseInt(tr.dataset.pageRow || '-1', 10)
    tr.classList.toggle('row-selected', pageRow === selectedPageRow)
  })
}

/**
 * 同步所有数据表的缺失值高亮状态
 */
function updateHighlightMissingState(enabled) {
  dataTable.classList.toggle('highlight-missing', enabled)
  rowDetailTable.classList.toggle('highlight-missing', enabled)
}

/**
 * 隐藏行详情面板
 */
function hideRowDetailPanel() {
  rowDetailPanel.hidden = true
  rowDetailTableBody.innerHTML = ''
  rowDetailSummary.textContent = ''
  requestAnimationFrame(renderBodyWindow)
}

/**
 * 渲染当前选中行的转置详情表
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
    ? formatL10n(bootstrap.l10n.RowDetailSummary, formatInt(viewRow), formatInt(sourceRowIndex + 1))
    : formatL10n(bootstrap.l10n.RowDetailViewSummary, formatInt(viewRow))

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
 * 追加行详情普通文本单元格
 */
function appendDetailTextCell(tr, value) {
  const td = document.createElement('td')
  td.textContent = value === null || value === undefined ? '' : String(value)
  tr.appendChild(td)
}

/**
 * 追加行详情值单元格
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
 * 追加行详情值标签单元格
 */
function appendDetailValueLabelCell(tr, labelMap, rawValue) {
  const label = getValueLabelForCell(labelMap, rawValue)
  appendDetailTextCell(tr, label || '')
}

/**
 * 同步行详情表列宽
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

// ---------- 控件状态 ----------

/**
 * 同步值标签模式控件状态
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

// ---------- 事件绑定 ----------

/**
 * 跳转到第一页
 */
function handlePageFirstClick() {
  loadPage(0)
}

/**
 * 跳转到上一页
 */
function handlePagePrevClick() {
  loadPage(Math.max(0, pageOffset - pageSize))
}

/**
 * 跳转到下一页
 */
function handlePageNextClick() {
  loadPage(pageOffset + pageSize)
}

/**
 * 跳转到最后一页
 */
function handlePageLastClick() {
  loadPage(Math.max(0, (Math.ceil(totalFiltered / pageSize) - 1) * pageSize))
}

/**
 * 切换分页大小
 */
function handlePageSizeChange() {
  pageSize = Number.parseInt(pageSizeSelect.value, 10) || 1000
  loadPage(0)
}

pageFirst.addEventListener('click', handlePageFirstClick)
pagePrev.addEventListener('click', handlePagePrevClick)
pageNext.addEventListener('click', handlePageNextClick)
pageLast.addEventListener('click', handlePageLastClick)
pageSizeSelect.addEventListener('change', handlePageSizeChange)
