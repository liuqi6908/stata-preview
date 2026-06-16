/**
 * Webview 加载状态、初始化数据和宿主消息入口。
 */

// ---------- 加载状态 ----------

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
  const percentage = totalRows > 0 ? (rowsRead / totalRows) * 100 : 0
  progressFill.style.width = `${percentage.toFixed(1)}%`
  progressText.textContent = formatL10n(
    bootstrap.l10n.LoadingRowsProgress,
    formatInt(rowsRead),
    formatInt(totalRows),
    percentage.toFixed(0),
  )
}

// ---------- 初始化数据 ----------

/**
 * 应用宿主发送的初始数据
 */
function applyInitData(payload) {
  hideHeaderContextMenu()
  applyFileInfoState(payload.fileInfo)
  applyMetaState(payload.meta)
  applyPageState(payload.page)
  resetDatasetViewState()
  resetVariablePanelState()
  resetFilterInputState()
  renderInitializedDataset()
  hideLoading()
}

/**
 * 应用宿主下发的文件信息
 */
function applyFileInfoState(fileInfo) {
  if (fileInfo) {
    fileInfoState = {
      ...fileInfoState,
      ...fileInfo,
    }
  }
}

/**
 * 应用数据集元信息
 */
function applyMetaState(nextMeta) {
  meta = nextMeta
  meta.valueLabels = normalizeValueLabels(meta.valueLabels)
  if (!hasAnyValueLabels())
    valueLabelDisplayMode = 'raw'
}

/**
 * 应用第一页数据和分页统计
 */
function applyPageState(page) {
  currentPageRows = page.rows
  currentPageRowIndices = normalizePageRowIndices(page.rowIndices, currentPageRows.length, page.offset)
  pageOffset = page.offset
  totalFiltered = page.totalFiltered
  totalAll = page.totalAll
}

/**
 * 新数据集到达后，重置依赖元数据的视图状态
 */
function resetDatasetViewState() {
  clearSelectedRow()
  visibleColumns = createAllColumnSet()
  colWidths = {}
  sortSpec = []
}

/**
 * 重置变量面板搜索和字典缓存
 */
function resetVariablePanelState() {
  variableSearchText = createVariableSearchText()
  variableSearchQuery = ''
  variableSearch.value = ''
  variableDictionaryEntries = null
  dictionarySearchQuery = ''
}

/**
 * 构建变量搜索缓存
 */
function createVariableSearchText() {
  return meta.headers.map((header, i) => `${header} ${meta.labels[i] || ''}`.toLowerCase())
}

/**
 * 重置通用筛选输入和筛选助手
 */
function resetFilterInputState() {
  filterQuery = ''
  searchInput.value = ''
  hideFilterAssist()
  hideFilterAssist(mainFilterAssistTarget)
  updateFilterMemoryControls()
}

/**
 * 刷新依赖初始化数据的视图
 */
function renderInitializedDataset() {
  updateValueLabelModeControl()
  renderSidebar({ resetScroll: true })
  renderTable()
  renderPaginationBar()
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
    if (loadingCard) {
      loadingCard.classList.add('error')
      loadingCard.innerHTML = `
        <h2>${bootstrap.l10n.couldNotOpenFile}</h2>
        <div id="loading-error-message">${escapeHtml(msg.error)}</div>
      `
    }
  }
})
