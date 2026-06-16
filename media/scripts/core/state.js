/**
 * Webview 共享状态。
 */

// ---------- 数据集与分页 ----------

/** 数据集元信息 */
let meta = null
/** 当前分页大小 */
let pageSize = bootstrap.pageSize || 1000
/** 当前页行数据 */
let currentPageRows = []
/** 当前页每行对应的原始文件行号（0 基） */
let currentPageRowIndices = []
/** 当前过滤后的总行数 */
let totalFiltered = 0
/** 原始总行数 */
let totalAll = 0
/** 当前页在过滤后视图中的起始偏移 */
let pageOffset = 0
/** 当前文件信息 */
let fileInfoState = {
  fileName: bootstrap.fileName,
  filePath: bootstrap.filePath,
  fileSize: bootstrap.fileSize,
  lastModified: bootstrap.lastModified,
}

// ---------- 数据表格 ----------

/** 值标签显示模式 */
let valueLabelDisplayMode = 'raw'
/** 当前可见列下标集合 */
let visibleColumns = new Set()
/** 列宽缓存（变量名 -> 像素宽度） */
let colWidths = {}
/** 多列排序配置 */
let sortSpec = []
/** 行高估计值（首次渲染后会用真实行高修正） */
let estRowHeight = DEFAULT_ROW_HEIGHT
/** 是否已有一次表格滚动重绘排队 */
let tableScrollScheduled = false

// ---------- 行详情 ----------

/** 当前页中被选中的行下标 */
let selectedPageRow = null
/** 行详情表列宽缓存 */
let rowDetailColumnWidths = ROW_DETAIL_DEFAULT_COLUMN_WIDTHS.slice()

// ---------- 筛选输入 ----------

/** 当前通用过滤表达式 */
let filterQuery = ''
/** 筛选历史与常用筛选 */
let filterAssistState = { history: [], saved: [] }
/** 当前打开的筛选助手目标 */
let activeFilterAssistTarget = null
/** 主筛选框的筛选助手目标 */
let mainFilterAssistTarget = null

// ---------- 变量面板 ----------

/** 侧边栏是否显示 */
let sidebarVisible = true
/** 侧边栏位置 */
let sidebarPosition = 'right'
/** 变量搜索用的规范化文本缓存 */
let variableSearchText = []
/** 当前变量搜索表达式 */
let variableSearchQuery = ''
/** 当前变量搜索命中的变量下标 */
let filteredVariableIndices = []
/** 变量项高度估计值（首次渲染后会用真实高度修正） */
let estVariableItemHeight = DEFAULT_VARIABLE_ITEM_HEIGHT
/** 是否已有一次变量列表滚动重绘排队 */
let variableScrollScheduled = false

// ---------- 弹窗状态 ----------

/** 表头右键菜单 */
let headerContextMenu = null
/** 当前文件的变量字典摘要 */
let variableDictionaryEntries = null
/** 变量字典弹窗内的搜索表达式 */
let dictionarySearchQuery = ''
