/**
 * Webview 静态 DOM 引用与弹窗注册。
 */

// ---------- 应用布局 ----------

const layoutContainer = document.getElementById('layout-container')
const mainPanel = document.getElementById('main-panel')
const resizeHandle = document.getElementById('resize-handle')

// ---------- 工具栏与筛选 ----------

const searchInput = document.getElementById('search-input')
const filterTools = document.getElementById('filter-tools')
const filterAssist = document.getElementById('filter-assist')
const searchApply = document.getElementById('search-apply')
const searchClear = document.getElementById('search-clear')
const filterError = document.getElementById('filter-error')
const toggleSidebar = document.getElementById('toggle-sidebar')
const toggleSidebarControl = document.getElementById('toggle-sidebar-control')
const exportData = document.getElementById('export-data')
const refreshData = document.getElementById('refresh-data')
const helpMenu = document.getElementById('help-menu')

// ---------- 数据表格 ----------

const gridContainer = document.getElementById('grid-container')
const gridOverlay = document.getElementById('grid-overlay')
const gridOverlayMessage = document.getElementById('grid-overlay-message')
const dataTable = document.getElementById('data-table')
const tableHead = document.getElementById('table-head')
const tableBody = document.getElementById('table-body')

// ---------- 行详情 ----------

const rowDetailPanel = document.getElementById('row-detail-panel')
const rowDetailResizeHandle = document.getElementById('row-detail-resize-handle')
const rowDetailSummary = document.getElementById('row-detail-summary')
const rowDetailClose = document.getElementById('row-detail-close')
const rowDetailBody = document.getElementById('row-detail-body')
const rowDetailTable = document.getElementById('row-detail-table')
const rowDetailTableBody = document.getElementById('row-detail-table-body')

// ---------- 分页控件 ----------

const pageFirst = document.getElementById('page-first')
const pagePrev = document.getElementById('page-prev')
const pageNext = document.getElementById('page-next')
const pageLast = document.getElementById('page-last')
const pageInfo = document.getElementById('page-info')
const pageSizeSelect = document.getElementById('page-size')
const pageSummary = document.getElementById('page-summary')

// ---------- 变量面板 ----------

const sidebar = document.getElementById('sidebar')
const sidebarPositionBtn = document.getElementById('sidebar-position')
const valueLabelModeWrap = document.getElementById('value-label-mode-wrap')
const valueLabelModeControl = document.getElementById('value-label-mode')
const valueLabelModeButtons = Array.from(valueLabelModeControl.querySelectorAll('[data-value-label-mode]'))
const variableSearch = document.getElementById('variable-search')
const highlightMissing = document.getElementById('highlight-missing')
const selectAllVariables = document.getElementById('select-all-variables')
const deselectAllVariables = document.getElementById('deselect-all-variables')
const variableList = document.getElementById('variable-list')

// ---------- 初始加载 ----------

const loadingEl = document.getElementById('initial-loading')
const loadingCard = document.getElementById('initial-loading-card')
const progressFill = document.getElementById('progress-fill')
const progressText = document.getElementById('progress-text')

// ---------- 文件信息与变量字典 ----------

const fileInfoBody = document.getElementById('file-info-body')
const dictionaryBody = document.getElementById('dictionary-body')

// ---------- 变量统计 ----------

const explorerVariable = document.getElementById('explorer-variable')
const explorerBody = document.getElementById('explorer-body')

// ---------- 弹窗注册 ----------

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
