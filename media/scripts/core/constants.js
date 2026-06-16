/**
 * Webview 共享常量。
 *
 * 这里集中维护跨功能脚本复用的配置、默认值和固定资源片段。
 */

// ---------- 数据表格 ----------

/** 默认列宽 */
const DEFAULT_COL_WIDTH = 140
/** 字符串列默认列宽 */
const DEFAULT_STR_COL_WIDTH = 240
/** 仅显示值标签时的默认列宽 */
const DEFAULT_LABEL_COL_WIDTH = 220
/** 同时显示原始值和值标签时的默认列宽 */
const DEFAULT_VALUE_LABEL_COL_WIDTH = 280
/** 行详情表默认列宽 */
const ROW_DETAIL_DEFAULT_COLUMN_WIDTHS = [180, 220, 220, 220]
/** 默认行高估计值 */
const DEFAULT_ROW_HEIGHT = 32
/** 表格视口上下额外渲染的行数 */
const ROW_OVERSCAN = 12

// ---------- 变量面板 ----------

/** 默认变量项高度估计值 */
const DEFAULT_VARIABLE_ITEM_HEIGHT = 32
/** 变量列表视口上下额外渲染的项数 */
const VARIABLE_OVERSCAN = 8
/** 文件大小展示单位 */
const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
/** 可用的值标签显示模式 */
const VALUE_LABEL_DISPLAY_MODES = new Set(['raw', 'label', 'both'])

// ---------- 变量统计 ----------

/** 变量统计 SVG 图表宽度 */
const EXPLORER_CHART_WIDTH = 560
/** 变量统计 SVG 图表高度 */
const EXPLORER_CHART_HEIGHT = 220
/** 变量统计 SVG 图表左侧留白 */
const EXPLORER_CHART_PAD_LEFT = 50
/** 变量统计 SVG 图表右侧留白 */
const EXPLORER_CHART_PAD_RIGHT = 10
/** 变量统计 SVG 图表顶部留白 */
const EXPLORER_CHART_PAD_TOP = 10
/** 变量统计 SVG 图表底部留白 */
const EXPLORER_CHART_PAD_BOTTOM = 30
/** 变量统计 SVG 图表横向网格线分段数 */
const EXPLORER_CHART_GRID_STEPS = 4

// ---------- 筛选输入 ----------

/** 筛选输入助手本地存储键 */
const FILTER_ASSIST_STORAGE_KEY = 'stataPreview.filterAssist.v1'
/** 最多保留的历史表达式数量 */
const FILTER_HISTORY_LIMIT = 50
/** 最多保留的常用筛选数量 */
const FILTER_SAVED_LIMIT = 50
/** 筛选工具图标 */
const FILTER_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24">
  <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5h16M7 12h10m-7 7h4"/>
</svg>`
/** 可自动补全的筛选函数 */
const FILTER_FUNCTION_COMPLETIONS = [
  {
    name: 'missing',
    signature: 'missing(var)',
    template: 'missing()',
    cursorOffset: 8,
    group: 'set',
    variableTemplate: 'missing({var})',
    description: bootstrap.l10n.MissingFunctionDescription,
  },
  {
    name: 'inlist',
    signature: 'inlist(var, ...)',
    template: 'inlist(, )',
    cursorOffset: 7,
    group: 'set',
    variableTemplate: 'inlist({var}, {cursor})',
    description: bootstrap.l10n.InlistFunctionDescription,
  },
  {
    name: 'inrange',
    signature: 'inrange(var, lo, hi)',
    template: 'inrange(, , )',
    cursorOffset: 8,
    group: 'set',
    variableTemplate: 'inrange({var}, {cursor}, )',
    description: bootstrap.l10n.InrangeFunctionDescription,
  },
  {
    name: 'contains',
    signature: 'contains(text, sub)',
    template: 'contains(, "")',
    cursorOffset: 9,
    group: 'string',
    variableTemplate: 'contains({var}, "{cursor}")',
    description: bootstrap.l10n.ContainsFunctionDescription,
  },
  {
    name: 'strpos',
    signature: 'strpos(text, sub)',
    template: 'strpos(, "")',
    cursorOffset: 7,
    group: 'string',
    variableTemplate: 'strpos({var}, "{cursor}")',
    description: bootstrap.l10n.StrposFunctionDescription,
  },
  {
    name: 'regexm',
    signature: 'regexm(text, pattern)',
    template: 'regexm(, "")',
    cursorOffset: 7,
    group: 'string',
    variableTemplate: 'regexm({var}, "{cursor}")',
    description: bootstrap.l10n.RegexmFunctionDescription,
  },
  {
    name: 'lower',
    signature: 'lower(text)',
    template: 'lower()',
    cursorOffset: 6,
    group: 'string',
    variableTemplate: 'lower({var})',
    description: bootstrap.l10n.LowerFunctionDescription,
  },
  {
    name: 'upper',
    signature: 'upper(text)',
    template: 'upper()',
    cursorOffset: 6,
    group: 'string',
    variableTemplate: 'upper({var})',
    description: bootstrap.l10n.UpperFunctionDescription,
  },
  {
    name: 'trim',
    signature: 'trim(text)',
    template: 'trim()',
    cursorOffset: 5,
    group: 'string',
    variableTemplate: 'trim({var})',
    description: bootstrap.l10n.TrimFunctionDescription,
  },
  {
    name: 'length',
    signature: 'length(text)',
    template: 'length()',
    cursorOffset: 7,
    group: 'string',
    variableTemplate: 'length({var})',
    description: bootstrap.l10n.LengthFunctionDescription,
  },
  {
    name: 'year',
    signature: 'year(date)',
    template: 'year()',
    cursorOffset: 5,
    group: 'date',
    variableTemplate: 'year({var})',
    description: bootstrap.l10n.YearFunctionDescription,
  },
  {
    name: 'month',
    signature: 'month(date)',
    template: 'month()',
    cursorOffset: 6,
    group: 'date',
    variableTemplate: 'month({var})',
    description: bootstrap.l10n.MonthFunctionDescription,
  },
  {
    name: 'day',
    signature: 'day(date)',
    template: 'day()',
    cursorOffset: 4,
    group: 'date',
    variableTemplate: 'day({var})',
    description: bootstrap.l10n.DayFunctionDescription,
  },
]
