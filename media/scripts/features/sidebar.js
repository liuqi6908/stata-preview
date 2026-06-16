/**
 * 变量侧边栏与变量列表虚拟渲染。
 */

// ---------- 列表渲染 ----------

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
 * 重建当前变量搜索结果
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
 * 渲染变量列表当前可见窗口
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
 * 构建变量列表占位元素
 */
function variableSpacer(height) {
  const spacer = document.createElement('div')
  spacer.className = 'variable-spacer'
  spacer.style.height = `${height}px`
  return spacer
}

/**
 * 构建单个变量项
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
 * 创建包含全部变量下标的集合
 */
function createAllColumnSet() {
  const all = new Set()
  for (let i = 0; i < meta.headers.length; i++)
    all.add(i)
  return all
}

// ---------- 批量操作 ----------

/**
 * 选中所有变量
 */
function handleSelectAllVariablesClick() {
  visibleColumns = createAllColumnSet()
  renderVariableColumnSelection()
}

/**
 * 取消选中所有变量
 */
function handleDeselectAllVariablesClick() {
  visibleColumns = new Set()
  renderVariableColumnSelection()
}

/**
 * 刷新变量列选择后的表格和侧边栏
 */
function renderVariableColumnSelection() {
  renderSidebar()
  renderHeader()
  renderBody()
}

// ---------- 事件绑定 ----------

/**
 * 更新变量搜索条件
 */
function handleVariableSearchInput(e) {
  variableSearchQuery = e.target.value.trim().toLowerCase()
  renderSidebar({ resetScroll: true })
}

/**
 * 滚动时重绘变量列表可见窗口
 */
function handleVariableListScroll() {
  if (variableScrollScheduled)
    return
  variableScrollScheduled = true
  requestAnimationFrame(() => {
    variableScrollScheduled = false
    renderVariableListWindow()
  })
}

selectAllVariables.addEventListener('click', handleSelectAllVariablesClick)
deselectAllVariables.addEventListener('click', handleDeselectAllVariablesClick)
variableSearch.addEventListener('input', handleVariableSearchInput)
variableList.addEventListener('scroll', handleVariableListScroll)
