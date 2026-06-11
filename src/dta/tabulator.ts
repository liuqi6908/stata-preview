/**
 * DTA 单变量汇总统计。
 *
 * 输入列式数据和可选行索引，输出 Webview 变量统计弹窗所需的统一结构。
 */

import type { ContinuousTab, DtaColumnar, TabulateResult, VariableDictionaryEntry } from './types'
import { l10n } from 'vscode'

/** 离散型变量的最大类别数。 */
const MAX_DISCRETE_CATEGORIES = 20
/** 整数型变量若唯一值数不超过此阈值，则显示每值柱状图。 */
const MAX_INT_BAR_VALUES = 200
/** 连续变量直方图分箱数。 */
const HISTOGRAM_BINS = 30
/** 变量字典每扫描多少个观测让出一次事件循环。 */
const DEFAULT_DICTIONARY_YIELD_EVERY = 50000

/** 构建变量字典摘要的配置。 */
export interface VariableDictionaryBuildOptions {
  /** 扫描多少个观测后让出事件循环。 */
  yieldEvery?: number
  /** 调用方可在分块间检查取消或过期状态。 */
  checkCancelled?: () => void
}

/** 单变量统计采集结果，供变量统计弹窗和变量字典共用。 */
interface VariableProfile {
  /** 变量名。 */
  varName: string
  /** 变量列序号。 */
  colIndex: number
  /** DTA 变量类型。 */
  colType: string
  /** 是否为数值列。 */
  isNumeric: boolean
  /** 是否为字符串列。 */
  isString: boolean
  /** 变量标签。 */
  label: string
  /** 值标签映射。 */
  labelMap?: { [value: number]: string }
  /** 数值列的有效值。 */
  numericValues: number[]
  /** 字符串列的有效值。 */
  stringValues: string[]
  /** 精确唯一值频数。 */
  uniqueCounter: Map<any, number>
  /** 有效观测数。 */
  nValid: number
  /** 缺失观测数。 */
  nMissing: number
  /** 与变量统计弹窗一致的统计展示类型。 */
  statType: TabulateResult['kind']
}

/** 单变量统计采集中的可变状态。 */
interface VariableProfileBuilder {
  /** 列式数据集。 */
  columnar: DtaColumnar
  /** 变量名。 */
  varName: string
  /** 变量列序号。 */
  colIndex: number
  /** DTA 变量类型。 */
  colType: string
  /** 是否为数值列。 */
  isNumeric: boolean
  /** 是否为字符串列。 */
  isString: boolean
  /** 是否保留有效值数组。 */
  collectValues: boolean
  /** 数值列的有效值。 */
  numericValues: number[]
  /** 字符串列的有效值。 */
  stringValues: string[]
  /** 精确唯一值频数。 */
  uniqueCounter: Map<any, number>
  /** 缺失观测数。 */
  nMissing: number
}

/**
 * 使用列式数据为单个变量计算汇总结果。
 *
 * 如果提供 indices，则只汇总指定行；否则汇总完整数据集。
 */
export function tabulateColumnar(columnar: DtaColumnar, varName: string, indices?: Uint32Array): TabulateResult {
  const profile = collectVariableProfile(columnar, varName, indices)
  if (!profile.isNumeric && !profile.isString) {
    return {
      kind: 'string',
      varName,
      nValid: 0,
      nMissing: profile.nMissing,
      nUnique: 0,
      topValues: [],
    }
  }

  if (profile.statType === 'discrete') {
    const total = profile.nValid
    const sortedKeys = [...profile.uniqueCounter.keys()].sort((a, b) => {
      if (typeof a === 'number' && typeof b === 'number')
        return a - b
      return String(a).localeCompare(String(b))
    })

    let cum = 0
    const entries = sortedKeys.map((k) => {
      const freq = profile.uniqueCounter.get(k)!
      const pct = total > 0 ? (freq / total) * 100 : 0
      cum += pct
      const lbl = profile.labelMap && profile.labelMap[k]
      return { value: k, label: lbl, freq, pct, cum }
    })

    return {
      kind: 'discrete',
      varName,
      nValid: profile.nValid,
      nMissing: profile.nMissing,
      nUnique: profile.uniqueCounter.size,
      entries,
    }
  }

  if (profile.isNumeric) {
    const arr = profile.numericValues
    const sorted = [...arr].sort((a, b) => a - b)
    const n = sorted.length
    const min = sorted[0]
    const max = sorted[n - 1]
    const sum = arr.reduce((a, b) => a + b, 0)
    const mean = sum / n
    let sqSum = 0
    for (let i = 0; i < n; i++) {
      const d = arr[i] - mean
      sqSum += d * d
    }
    const sd = n > 1 ? Math.sqrt(sqSum / (n - 1)) : 0

    const pct = (p: number): number => {
      if (n === 0)
        return Number.NaN
      const idx = (p / 100) * (n - 1)
      const lo = Math.floor(idx)
      const hi = Math.ceil(idx)
      if (lo === hi)
        return sorted[lo]
      return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo)
    }

    // 整数型高唯一值使用每值柱状图，否则使用连续直方图。
    const allInts = allUniqueValuesAreIntegers(profile.uniqueCounter)
    const useBars = allInts
      && profile.uniqueCounter.size > MAX_DISCRETE_CATEGORIES
      && profile.uniqueCounter.size <= MAX_INT_BAR_VALUES

    let chart: ContinuousTab['chart']
    if (useBars) {
      const bars = [...profile.uniqueCounter.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value - b.value)
      chart = { type: 'bars', bars }
    }
    else {
      const histogram: { bin: number, lo: number, hi: number, count: number }[] = []
      if (min === max) {
        histogram.push({ bin: 0, lo: min, hi: max, count: n })
      }
      else {
        const bins = HISTOGRAM_BINS
        const width = (max - min) / bins
        const counts = Array.from<number>({ length: bins }).fill(0)
        for (let i = 0; i < n; i++) {
          let b = Math.floor((arr[i] - min) / width)
          if (b >= bins)
            b = bins - 1
          if (b < 0)
            b = 0
          counts[b]++
        }
        for (let b = 0; b < bins; b++) {
          histogram.push({ bin: b, lo: min + b * width, hi: min + (b + 1) * width, count: counts[b] })
        }
      }
      chart = { type: 'histogram', bins: histogram }
    }

    return {
      kind: 'continuous',
      varName,
      nValid: n,
      nMissing: profile.nMissing,
      min,
      max,
      mean,
      sd,
      median: pct(50),
      p1: pct(1),
      p25: pct(25),
      p75: pct(75),
      p99: pct(99),
      chart,
      nUnique: profile.uniqueCounter.size,
    }
  }

  const top = [...profile.uniqueCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([value, freq]) => ({ value: String(value), freq, pct: (freq / profile.nValid) * 100 }))

  return {
    kind: 'string',
    varName,
    nValid: profile.nValid,
    nMissing: profile.nMissing,
    nUnique: profile.uniqueCounter.size,
    topValues: top,
  }
}

/**
 * 为当前数据集构建变量字典摘要。
 *
 * 字典需要完整扫描各列，才能给出精确缺失数和唯一值数量；这里按列分块让出
 * 事件循环，避免宽表或长表一次性占住扩展宿主。
 */
export async function buildVariableDictionaryAsync(
  columnar: DtaColumnar,
  options: VariableDictionaryBuildOptions = {},
): Promise<VariableDictionaryEntry[]> {
  const yieldEvery = normalizePositiveInteger(options.yieldEvery, DEFAULT_DICTIONARY_YIELD_EVERY)
  const meta = columnar.meta
  const entries: VariableDictionaryEntry[] = []

  for (let colIndex = 0; colIndex < meta.headers.length; colIndex++) {
    const name = meta.headers[colIndex]
    const profile = await collectVariableProfileAsync(columnar, name, {
      ...options,
      yieldEvery,
    })

    entries.push({
      index: profile.colIndex + 1,
      name: profile.varName,
      label: profile.label,
      type: profile.colType,
      statType: profile.statType,
      nValid: profile.nValid,
      nMissing: profile.nMissing,
      nUnique: profile.uniqueCounter.size,
    })
    await yieldVariableDictionaryChunk(options)
  }

  return entries
}

/**
 * 同步采集单变量 profile。
 */
function collectVariableProfile(columnar: DtaColumnar, varName: string, indices?: Uint32Array): VariableProfile {
  const builder = createVariableProfileBuilder(columnar, varName, true)
  const total = indices ? indices.length : columnar.meta.nobs
  for (let k = 0; k < total; k++)
    ingestProfileRow(builder, indices ? indices[k] : k)
  return finishVariableProfile(builder)
}

/**
 * 异步采集单变量 profile，供变量字典复用同一套统计口径。
 */
async function collectVariableProfileAsync(
  columnar: DtaColumnar,
  varName: string,
  options: VariableDictionaryBuildOptions,
): Promise<VariableProfile> {
  const yieldEvery = normalizePositiveInteger(options.yieldEvery, DEFAULT_DICTIONARY_YIELD_EVERY)
  const builder = createVariableProfileBuilder(columnar, varName, false)
  for (let rowIndex = 0; rowIndex < columnar.meta.nobs; rowIndex++) {
    ingestProfileRow(builder, rowIndex)
    if ((rowIndex + 1) % yieldEvery === 0)
      await yieldVariableDictionaryChunk(options)
  }
  return finishVariableProfile(builder)
}

/**
 * 创建单变量 profile 采集器。
 */
function createVariableProfileBuilder(
  columnar: DtaColumnar,
  varName: string,
  collectValues: boolean,
): VariableProfileBuilder {
  const colIndex = columnar.meta.headers.indexOf(varName)
  if (colIndex === -1)
    throw new Error(l10n.t('Variable not found: {0}', varName))

  const colType = columnar.meta.types[colIndex] || ''
  return {
    columnar,
    varName,
    colIndex,
    colType,
    isNumeric: isNumericDtaType(colType),
    isString: colType.startsWith('str'),
    collectValues,
    numericValues: [],
    stringValues: [],
    uniqueCounter: new Map<any, number>(),
    nMissing: 0,
  }
}

/**
 * 将一行值纳入 profile 统计。
 */
function ingestProfileRow(builder: VariableProfileBuilder, rowIndex: number): void {
  const col = builder.columnar.columns[builder.varName]
  const miss = builder.columnar.missing[builder.varName]
  const value = col[rowIndex] as string | number

  if (isProfileMissingValue(value, !!miss[rowIndex], builder.isString)) {
    builder.nMissing++
    return
  }

  if (builder.isNumeric) {
    const numericValue = value as number
    if (builder.collectValues)
      builder.numericValues.push(numericValue)
    addUniqueValue(builder.uniqueCounter, numericValue)
    return
  }

  if (builder.isString) {
    const stringValue = value as string
    if (builder.collectValues)
      builder.stringValues.push(stringValue)
    addUniqueValue(builder.uniqueCounter, stringValue)
    return
  }

  builder.nMissing++
}

/**
 * 完成 profile 采集并推断统计类型。
 */
function finishVariableProfile(builder: VariableProfileBuilder): VariableProfile {
  const labelMap = builder.columnar.meta.valueLabels[builder.varName]
  const nValid = builder.isNumeric || builder.isString ? countProfileValidValues(builder.uniqueCounter) : 0
  const profile: VariableProfile = {
    varName: builder.varName,
    colIndex: builder.colIndex,
    colType: builder.colType,
    isNumeric: builder.isNumeric,
    isString: builder.isString,
    label: builder.columnar.meta.labels[builder.colIndex] || '',
    labelMap,
    numericValues: builder.numericValues,
    stringValues: builder.stringValues,
    uniqueCounter: builder.uniqueCounter,
    nValid,
    nMissing: builder.nMissing,
    statType: 'string',
  }
  profile.statType = inferProfileStatType(profile)
  return profile
}

/**
 * 判断 profile 统计中的缺失值。
 */
function isProfileMissingValue(value: string | number, markedMissing: boolean, isString: boolean): boolean {
  if (markedMissing)
    return true
  if (isString)
    return value === ''
  return typeof value === 'number' && Number.isNaN(value)
}

/**
 * 累计精确唯一值频数。
 */
function addUniqueValue(counter: Map<any, number>, value: string | number): void {
  counter.set(value, (counter.get(value) || 0) + 1)
}

/**
 * 从精确唯一值频数反推有效观测数。
 */
function countProfileValidValues(counter: Map<any, number>): number {
  let total = 0
  for (const count of counter.values())
    total += count
  return total
}

/**
 * 使用与变量统计弹窗一致的规则推断字典中的统计类型。
 */
function inferProfileStatType(profile: VariableProfile): TabulateResult['kind'] {
  if (!profile.isNumeric && !profile.isString)
    return 'string'

  const hasLabels = !!profile.labelMap && Object.keys(profile.labelMap).length > 0
  const isFloatLike = profile.colType === 'float' || profile.colType === 'double'
  const treatDiscrete = hasLabels
    || (profile.uniqueCounter.size > 0 && profile.uniqueCounter.size <= MAX_DISCRETE_CATEGORIES
      && (!isFloatLike || allUniqueValuesAreIntegers(profile.uniqueCounter)))

  if (treatDiscrete)
    return 'discrete'
  return profile.isNumeric ? 'continuous' : 'string'
}

/**
 * 是否为 DTA 数值存储类型。
 */
function isNumericDtaType(colType: string): boolean {
  return colType === 'byte' || colType === 'int' || colType === 'long' || colType === 'float' || colType === 'double'
}

/**
 * 浮点列只有唯一值全为整数时才按少量离散值展示。
 */
function allUniqueValuesAreIntegers(uniqueValues: Map<any, number>): boolean {
  for (const value of uniqueValues.keys()) {
    if (typeof value !== 'number' || !Number.isInteger(value))
      return false
  }
  return true
}

/**
 * 归一化正整数配置。
 */
function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0)
    return fallback
  return Math.max(1, Math.floor(value))
}

/**
 * 让出变量字典扫描任务。
 */
async function yieldVariableDictionaryChunk(options: VariableDictionaryBuildOptions): Promise<void> {
  options.checkCancelled?.()
  await yieldToEventLoop()
  options.checkCancelled?.()
}

/**
 * 让出一次事件循环。
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}
