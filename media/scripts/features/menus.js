/**
 * 排序、列操作、上下文菜单与导出入口。
 */

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
    // Shift 点击：在多列排序中切换当前列
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
    // 普通点击：单列排序，按 asc -> desc -> none 循环
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

// ---------- 剪贴板与列操作 ----------

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
    // Webview 权限不一定允许 Clipboard API，下面使用兼容方案
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
 * 按表格当前显示模式生成单元格复制文本
 */
function formatDataCellCopyValue(rowData, colIndex) {
  if (!rowData || colIndex < 0 || colIndex >= rowData.length)
    return ''
  const value = rowData[colIndex]
  if (isMissingCellValue(value))
    return ''
  return formatCellDisplayValue(value, getValueLabelMap(colIndex))
}

/**
 * 按当前可见列生成一行的键值文本快照
 */
function buildDataRowCopyText(rowData) {
  return getVisibleColumnSpecs()
    .map(({ header, index }) => `${header}=${formatDataCellCopyValue(rowData, index)}`)
    .join('\n')
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

// ---------- 菜单基础能力 ----------

/**
 * 隐藏当前右键菜单
 */
function hideHeaderContextMenu() {
  if (headerContextMenu)
    headerContextMenu.remove()
  headerContextMenu = null
}

/**
 * 关闭当前打开的弹窗
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
 * 构建二级菜单入口
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
 * 将菜单放在鼠标点附近，底部空间不足时向上展开
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
 * 将二级菜单放在入口旁边；右侧空间不足时向左展开
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
 * 将菜单贴近触发元素，底部空间不足时在触发元素上方展开
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

// ---------- 表头菜单 ----------

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

// ---------- 表体菜单 ----------

/**
 * 显示数据单元格右键菜单
 */
function showDataCellContextMenu(pageRow, colIndex, clientX, clientY) {
  hideHeaderContextMenu()

  const rowData = currentPageRows[pageRow]
  if (!rowData)
    return

  const cellText = formatDataCellCopyValue(rowData, colIndex)
  const rowText = buildDataRowCopyText(rowData)

  const menu = document.createElement('div')
  menu.className = 'context-menu'
  menu.id = 'data-cell-context-menu'
  menu.append(
    createHeaderMenuItem(bootstrap.l10n.CopyCell, () => void copyText(cellText)),
    createHeaderMenuItem(bootstrap.l10n.CopyCurrentRow, () => void copyText(rowText)),
  )

  document.body.appendChild(menu)
  placeContextMenuAtPoint(menu, clientX, clientY)
  headerContextMenu = menu
}

// ---------- 变量筛选菜单 ----------

/**
 * 显示变量筛选模板菜单
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
 * 构建变量函数模板二级菜单
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

// ---------- 筛选工具菜单 ----------

/**
 * 显示筛选工具菜单
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

// ---------- 顶部工具栏菜单 ----------

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

// ---------- 变量面板状态 ----------

/**
 * 同步变量面板开关状态
 */
function updateSidebarToggle() {
  toggleSidebar.checked = sidebarVisible
  toggleSidebarControl.title = sidebarVisible ? bootstrap.l10n.HideVariablesPanel : bootstrap.l10n.ShowVariablesPanel
}

/**
 * 同步变量面板位置按钮提示
 */
function updateSidebarPositionButton() {
  sidebarPositionBtn.title = sidebarPosition === 'right'
    ? bootstrap.l10n.MoveVariablesPanelToBottom
    : bootstrap.l10n.MoveVariablesPanelToRight
}

// ---------- 导出 ----------

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

// ---------- 全局事件 ----------

/**
 * 点击菜单外部时关闭当前菜单
 */
function handleDocumentClick(e) {
  if (!headerContextMenu)
    return
  if (e.target instanceof Node && headerContextMenu.contains(e.target))
    return
  hideHeaderContextMenu()
}

/**
 * 点击筛选助手外部时关闭助手
 */
function handleDocumentMouseDown(e) {
  if (!isFilterAssistOpen())
    return
  const target = activeFilterAssistTarget
  if (!target)
    return
  if (e.target instanceof Node && (target.input.contains(e.target) || target.panel.contains(e.target)))
    return
  hideFilterAssist(target)
}

/**
 * 处理全局 Esc 关闭行为
 */
function handleDocumentKeyDown(e) {
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
}

/**
 * 在菜单外打开原生右键菜单时关闭当前菜单
 */
function handleDocumentContextMenu(e) {
  if (!headerContextMenu)
    return
  if (e.target instanceof Element && e.target.closest('thead th, .context-menu'))
    return
  hideHeaderContextMenu()
}

document.addEventListener('click', handleDocumentClick)
document.addEventListener('mousedown', handleDocumentMouseDown)
document.addEventListener('keydown', handleDocumentKeyDown)
document.addEventListener('contextmenu', handleDocumentContextMenu)
window.addEventListener('blur', hideHeaderContextMenu)
window.addEventListener('resize', hideHeaderContextMenu)
