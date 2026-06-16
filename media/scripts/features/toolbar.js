/**
 * 顶部工具栏与面板开关事件。
 */

// ---------- 工具栏动作 ----------

/**
 * 切换值标签显示模式
 */
function handleValueLabelModeClick(button) {
  if (button.disabled)
    return
  valueLabelDisplayMode = normalizeValueLabelDisplayMode(button.dataset.valueLabelMode)
  updateValueLabelModeControl()
  renderHeader()
  renderBodyWindow()
}

/**
 * 请求刷新当前数据
 */
function handleRefreshDataClick() {
  vscode.postMessage({ command: 'refresh' })
}

/**
 * 打开导出菜单
 */
function handleExportDataClick(e) {
  e.stopPropagation()
  showExportMenu(exportData)
}

/**
 * 打开帮助菜单
 */
function handleHelpMenuClick(e) {
  e.stopPropagation()
  showHelpMenu(helpMenu)
}

// ---------- 面板动作 ----------

/**
 * 切换变量面板显示状态
 */
function handleToggleSidebarChange(e) {
  sidebarVisible = e.target.checked
  layoutContainer.classList.toggle('sidebar-hidden', !sidebarVisible)
  updateSidebarToggle()
}

/**
 * 切换缺失值高亮
 */
function handleHighlightMissingChange(e) {
  updateHighlightMissingState(e.target.checked)
}

/**
 * 切换变量面板位置
 */
function handleSidebarPositionClick() {
  sidebarPosition = sidebarPosition === 'right' ? 'bottom' : 'right'
  layoutContainer.classList.toggle('sidebar-bottom', sidebarPosition === 'bottom')
  updateSidebarPositionButton()
}

// ---------- 事件绑定 ----------

valueLabelModeButtons.forEach((button) => {
  button.addEventListener('click', () => handleValueLabelModeClick(button))
})
refreshData.addEventListener('click', handleRefreshDataClick)
exportData.addEventListener('click', handleExportDataClick)
helpMenu.addEventListener('click', handleHelpMenuClick)
toggleSidebar.addEventListener('change', handleToggleSidebarChange)
highlightMissing.addEventListener('change', handleHighlightMissingChange)
rowDetailClose.addEventListener('click', clearSelectedRow)
sidebarPositionBtn.addEventListener('click', handleSidebarPositionClick)
