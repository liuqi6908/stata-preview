/**
 * DTA 单变量汇总统计。
 *
 * 输入列式数据和可选行索引，输出 Webview 变量统计弹窗所需的统一结构。
 */

import type { ContinuousTab, DtaColumnar, TabulateResult } from './types'
import { l10n } from 'vscode'

/** 离散型变量的最大类别数。 */
const MAX_DISCRETE_CATEGORIES = 20
/** 整数型变量若唯一值数不超过此阈值，则显示每值柱状图。 */
const MAX_INT_BAR_VALUES = 200
/** 连续变量直方图分箱数。 */
const HISTOGRAM_BINS = 30

/**
 * 使用列式数据为单个变量计算汇总结果。
 *
 * 如果提供 indices，则只汇总指定行；否则汇总完整数据集。
 */
export function tabulateColumnar(columnar: DtaColumnar, varName: string, indices?: Uint32Array): TabulateResult {
  const colIdx = columnar.meta.headers.indexOf(varName)
  if (colIdx === -1)
    throw new Error(l10n.t('Variable not found: {0}', varName))
  const colType = columnar.meta.types[colIdx]
  const col = columnar.columns[varName]
  const miss = columnar.missing[varName]
  const N = columnar.meta.nobs

  const isNumeric = colType === 'byte' || colType === 'int' || colType === 'long' || colType === 'float' || colType === 'double'
  const isString = colType.startsWith('str')

  const numericValues: number[] = isNumeric ? [] : (null as any)
  const stringValues: string[] = isString ? [] : (null as any)
  let nMissing = 0

  const total = indices ? indices.length : N
  for (let k = 0; k < total; k++) {
    const i = indices ? indices[k] : k
    if (miss[i]) {
      nMissing++
      continue
    }
    if (isNumeric) {
      const v = col[i] as number
      if (Number.isNaN(v))
        nMissing++
      else
        numericValues.push(v)
    }
    else if (isString) {
      const s = col[i] as string
      if (!s || s.length === 0)
        nMissing++
      else
        stringValues.push(s)
    }
    else {
      nMissing++
    }
  }

  const labelMap = columnar.meta.valueLabels[varName]
  const nValid = isNumeric ? numericValues.length : (isString ? stringValues.length : 0)
  if (!isNumeric && !isString) {
    return {
      kind: 'string',
      varName,
      nValid: 0,
      nMissing,
      nUnique: 0,
      topValues: [],
    }
  }

  // 判断是否按离散型输出：
  // 1) 若存在值标签，则始终视为离散型。
  // 2) 唯一值数量较少时按离散型展示；浮点数需要所有唯一值均为整数。
  const uniqueCounter = new Map<any, number>()
  let exceededCap = false
  const cap = (isNumeric ? MAX_INT_BAR_VALUES : MAX_DISCRETE_CATEGORIES) + 1

  if (isNumeric) {
    for (let i = 0; i < numericValues.length; i++) {
      const v = numericValues[i]
      if (!uniqueCounter.has(v)) {
        if (uniqueCounter.size >= cap) {
          exceededCap = true
          break
        }
      }
      uniqueCounter.set(v, (uniqueCounter.get(v) || 0) + 1)
    }
  }
  else if (isString) {
    for (let i = 0; i < stringValues.length; i++) {
      const v = stringValues[i]
      if (!uniqueCounter.has(v)) {
        if (uniqueCounter.size >= cap) {
          exceededCap = true
          break
        }
      }
      uniqueCounter.set(v, (uniqueCounter.get(v) || 0) + 1)
    }
  }

  const hasLabels = !!labelMap && Object.keys(labelMap).length > 0
  const isFloatLike = colType === 'float' || colType === 'double'
  let allIntegers = true
  if (isFloatLike && !exceededCap) {
    for (const v of uniqueCounter.keys()) {
      if (!Number.isInteger(v)) {
        allIntegers = false
        break
      }
    }
  }

  const treatDiscrete
    = hasLabels
      || (!exceededCap && uniqueCounter.size > 0 && uniqueCounter.size <= MAX_DISCRETE_CATEGORIES
        && (!isFloatLike || allIntegers))

  if (treatDiscrete) {
    let fullCounter = uniqueCounter
    if (hasLabels && exceededCap) {
      fullCounter = new Map<any, number>()
      const src = isNumeric ? numericValues : stringValues
      for (let i = 0; i < src.length; i++) {
        fullCounter.set(src[i], (fullCounter.get(src[i]) || 0) + 1)
      }
    }

    const total = nValid
    const sortedKeys = [...fullCounter.keys()].sort((a, b) => {
      if (typeof a === 'number' && typeof b === 'number')
        return a - b
      return String(a).localeCompare(String(b))
    })

    let cum = 0
    const entries = sortedKeys.map((k) => {
      const freq = fullCounter.get(k)!
      const pct = total > 0 ? (freq / total) * 100 : 0
      cum += pct
      const lbl = labelMap && labelMap[k]
      return { value: k, label: lbl, freq, pct, cum }
    })

    return {
      kind: 'discrete',
      varName,
      nValid,
      nMissing,
      entries,
    }
  }

  if (isNumeric) {
    const arr = numericValues
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
    const knownUniques = !exceededCap
    let allInts = false
    if (knownUniques) {
      allInts = true
      for (const v of uniqueCounter.keys()) {
        if (!Number.isInteger(v)) {
          allInts = false
          break
        }
      }
    }
    const useBars = knownUniques && allInts
      && uniqueCounter.size > MAX_DISCRETE_CATEGORIES
      && uniqueCounter.size <= MAX_INT_BAR_VALUES

    let chart: ContinuousTab['chart']
    if (useBars) {
      const bars = [...uniqueCounter.entries()]
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
      nMissing,
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
      nUnique: exceededCap ? -1 : uniqueCounter.size,
    }
  }

  const counter = new Map<string, number>()
  for (let i = 0; i < stringValues.length; i++) {
    counter.set(stringValues[i], (counter.get(stringValues[i]) || 0) + 1)
  }
  const top = [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([value, freq]) => ({ value, freq, pct: (freq / nValid) * 100 }))

  return {
    kind: 'string',
    varName,
    nValid,
    nMissing,
    nUnique: counter.size,
    topValues: top,
  }
}
