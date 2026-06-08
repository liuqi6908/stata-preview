/**
 * DTA 数据层共享类型。
 *
 * 这里集中维护解析、查询、过滤、汇总和导出之间共用的数据结构，
 * 避免各模块互相从实现文件里反向引用类型。
 */

/** Stata 文件字节序。LSF 为小端，MSF 为大端。 */
export type ByteOrder = 'LSF' | 'MSF'

/** 行式预览数据。 */
export interface DtaData {
  /** 变量名列表。 */
  headers: string[]
  /** 变量标签列表。 */
  labels: string[]
  /** 预览行数据，每行与 headers 对齐。 */
  rows: any[][]
  /** 变量到值标签表的映射。 */
  valueLabels?: { [varName: string]: { [value: number]: string } }
  /** 原始总观测数。 */
  nobs?: number
}

/**
 * 单列数据的列式存储。
 *
 * 数值变量使用 TypedArray，字符串变量使用 string[]。
 */
export type ColumnArray
  = | Int8Array | Int16Array | Int32Array
    | Float32Array | Float64Array
    | string[]

/** 数据集元信息。 */
export interface DtaMeta {
  /** 变量名列表。 */
  headers: string[]
  /** 变量标签列表。 */
  labels: string[]
  /** 内部变量类型。 */
  types: string[]
  /** 每个变量在单行数据中的字节大小。 */
  typeSizes: number[]
  /** 变量到值标签表的映射。 */
  valueLabels: { [varName: string]: { [value: number]: string } }
  /** 原始总观测数。 */
  nobs: number
  /** 解析后的 Stata release 标记。 */
  release: 117 | 118 | 119
  /** 文件字节序。 */
  byteOrder: ByteOrder
}

/** 列式数据集。 */
export interface DtaColumnar {
  /** 数据集元信息。 */
  meta: DtaMeta
  /** 每个变量对应一列。 */
  columns: { [varName: string]: ColumnArray }
  /** 缺失值掩码：1 = 缺失，0 = 有效。 */
  missing: { [varName: string]: Uint8Array }
}

/** 列式解析配置。 */
export interface ParseColumnarOptions {
  /** 进度回调。 */
  onProgress?: (rowsRead: number, totalRows: number) => void
  /** 进度回调间隔。 */
  progressStep?: number
}

/** 异步列式解析配置。 */
export interface ParseColumnarAsyncOptions extends ParseColumnarOptions {
  /** 让出事件循环的行数间隔。 */
  yieldEvery?: number
}

/** 排序配置。 */
export interface SortSpec {
  /** 排序列。 */
  col: string
  /** 排序方向。 */
  dir: 'asc' | 'desc'
}

/** 筛选配置。 */
export interface FilterSpec {
  /** 筛选表达式，例如 `edad > 30 & treatment == 1`。 */
  query: string
}

/** 分页请求参数。 */
export interface PageRequest {
  /** 在（过滤 + 排序后）视图中的起始位置。 */
  offset: number
  /** 分页大小。 */
  limit: number
  /** 可选列名列表；不传时返回全部列。 */
  columns?: string[]
}

/** 分页结果。 */
export interface PageResult {
  /** 行数组，每行与请求列或 meta.headers 对齐。 */
  rows: any[][]
  /** 行在原始文件中的行索引。 */
  rowIndices: number[]
  /** 在（过滤 + 排序后）视图中的起始位置。 */
  offset: number
  /** 分页大小。 */
  limit: number
  /** 当前视图大小（过滤后）。 */
  totalFiltered: number
  /** 原始总观测数（未过滤）。 */
  totalAll: number
}

/**
 * 离散变量的汇总结果。
 * 适用于拥有值标签或唯一值较少的变量。
 */
export interface DiscreteTab {
  /** 汇总类型。 */
  kind: 'discrete'
  /** 变量名。 */
  varName: string
  /** 有效观测数。 */
  nValid: number
  /** 缺失观测数。 */
  nMissing: number
  /** 按值统计的频数、百分比和累计百分比。 */
  entries: { value: any, label?: string, freq: number, pct: number, cum: number }[]
}

/**
 * 连续变量的汇总结果。
 * 包含分位数、均值、标准差和可用于绘图的直方图/柱状图数据。
 */
export interface ContinuousTab {
  /** 汇总类型。 */
  kind: 'continuous'
  /** 变量名。 */
  varName: string
  /** 有效观测数。 */
  nValid: number
  /** 缺失观测数。 */
  nMissing: number
  /** 最小值。 */
  min: number
  /** 最大值。 */
  max: number
  /** 均值。 */
  mean: number
  /** 标准差。 */
  sd: number
  /** 中位数。 */
  median: number
  /** 1% 分位数。 */
  p1: number
  /** 25% 分位数。 */
  p25: number
  /** 75% 分位数。 */
  p75: number
  /** 99% 分位数。 */
  p99: number
  /** 图表数据。 */
  chart:
    | { type: 'histogram', bins: { bin: number, lo: number, hi: number, count: number }[] }
    | { type: 'bars', bars: { value: number, count: number }[] }
  /** 唯一值数量；超过统计上限时为 -1。 */
  nUnique: number
}

/**
 * 字符串变量的汇总结果。
 * 包含出现频率最高的 top 值与唯一值数量。
 */
export interface StringTab {
  /** 汇总类型。 */
  kind: 'string'
  /** 变量名。 */
  varName: string
  /** 有效观测数。 */
  nValid: number
  /** 缺失观测数。 */
  nMissing: number
  /** 唯一值数量。 */
  nUnique: number
  /** 出现频率最高的字符串值。 */
  topValues: { value: string, freq: number, pct: number }[]
}

/** 单变量汇总结果。 */
export type TabulateResult = DiscreteTab | ContinuousTab | StringTab

/** 表格导出格式。 */
export type TableExportFormat = 'csv' | 'xlsx'
