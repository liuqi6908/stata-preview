/**
 * Stata .dta parser for VS Code extension.
 * Supports Stata format 117 (Stata 13) and 118 (Stata 14+) natively, and
 * dispatches to ./parserLegacy for pre-13 binary formats 113, 114, 115.
 *
 * Reference: https://www.stata.com/help.cgi?dta
 */
import { Buffer } from 'node:buffer'
import { isLegacyDtaFormat, parseColumnarLegacy, parseColumnarLegacyAsync } from './parserLegacy'

export interface DtaData {
  headers: string[]
  labels: string[]
  rows: any[][]
  valueLabels?: { [varName: string]: { [value: number]: string } }
  nobs?: number
}

/**
 * Columnar representation: each variable's data lives in a typed array
 * (or string[] for string vars). Missingness is tracked separately so we
 * never confuse a real value (e.g. 0) with a missing one.
 */
export type ColumnArray
  = | Int8Array | Int16Array | Int32Array
    | Float32Array | Float64Array
    | string[]

export interface DtaMeta {
  headers: string[]
  labels: string[]
  types: string[] // 'byte' | 'int' | 'long' | 'float' | 'double' | 'strN'
  typeSizes: number[]
  valueLabels: { [varName: string]: { [value: number]: string } }
  nobs: number // total N (full file)
  release: 117 | 118
}

export interface DtaColumnar {
  meta: DtaMeta
  columns: { [varName: string]: ColumnArray }
  missing: { [varName: string]: Uint8Array } // 1 = missing, 0 = valid
}

export interface ParseColumnarOptions {
  /** Optional progress callback: called every ~progressStep rows during the data scan. */
  onProgress?: (rowsRead: number, totalRows: number) => void
  progressStep?: number
}

export interface ParseColumnarAsyncOptions extends ParseColumnarOptions {
  /** Yield to the event loop every ~yieldEvery rows so postMessage progress reaches the UI. */
  yieldEvery?: number
}

export interface DiscreteTab {
  kind: 'discrete'
  varName: string
  nValid: number
  nMissing: number
  entries: { value: any, label?: string, freq: number, pct: number, cum: number }[]
}

export interface ContinuousTab {
  kind: 'continuous'
  varName: string
  nValid: number
  nMissing: number
  min: number
  max: number
  mean: number
  sd: number
  median: number
  p1: number
  p25: number
  p75: number
  p99: number
  // Either a binned histogram (for truly continuous data) OR a per-value
  // bar chart (for integer-valued discrete data with 21..MAX_INT_BAR_VALUES uniques).
  chart:
    | { type: 'histogram', bins: { bin: number, lo: number, hi: number, count: number }[] }
    | { type: 'bars', bars: { value: number, count: number }[] }
  nUnique: number // exact if <= cap, else -1 sentinel
}

export interface StringTab {
  kind: 'string'
  varName: string
  nValid: number
  nMissing: number
  nUnique: number
  topValues: { value: string, freq: number, pct: number }[]
}

export type TabulateResult = DiscreteTab | ContinuousTab | StringTab

const MAX_DISCRETE_CATEGORIES = 20
const MAX_INT_BAR_VALUES = 200 // integer-valued vars with up to this many uniques get per-value bars
const HISTOGRAM_BINS = 30

interface FormatSpec {
  release: 117 | 118
  varnameLen: number
  varlabelLen: number
  formatLen: number
  valueLabelNameLen: number
  nobsBytes: number
  encoding: 'latin1' | 'utf8'
}

const FMT_117: FormatSpec = {
  release: 117,
  varnameLen: 33,
  varlabelLen: 81,
  formatLen: 49,
  valueLabelNameLen: 33,
  nobsBytes: 4,
  encoding: 'latin1',
}

const FMT_118: FormatSpec = {
  release: 118,
  varnameLen: 129,
  varlabelLen: 321,
  formatLen: 57,
  valueLabelNameLen: 129,
  nobsBytes: 8,
  encoding: 'utf8',
}

// Type codes for formats 117/118 (uint16 LE):
// 1..2045   -> strN (fixed-width string of N bytes)
// 32768     -> strL (long string, 8-byte pointer in data)
// 65526     -> double (8 bytes)
// 65527     -> float  (4 bytes)
// 65528     -> long   (4 bytes, int32)
// 65529     -> int    (2 bytes, int16)
// 65530     -> byte   (1 byte, int8)
function decodeTypeCode(code: number): { type: string, size: number } | null {
  if (code === 65526)
    return { type: 'double', size: 8 }
  if (code === 65527)
    return { type: 'float', size: 4 }
  if (code === 65528)
    return { type: 'long', size: 4 }
  if (code === 65529)
    return { type: 'int', size: 2 }
  if (code === 65530)
    return { type: 'byte', size: 1 }
  if (code === 32768)
    return { type: 'strL', size: 8 }
  if (code >= 1 && code <= 2045)
    return { type: `str${code}`, size: code }
  return null
}

// Stata-style missing-value sentinels (.= and .a..z all live above these thresholds).
// Reference: Stata "[U] 12.2.1 Missing values".
function isMissingNumeric(v: number, t: string): boolean {
  if (v === null || v === undefined || Number.isNaN(v))
    return true
  if (t === 'byte')
    return v > 100
  if (t === 'int')
    return v > 32740
  if (t === 'long')
    return v > 2147483620
  if (t === 'float')
    return v >= 1.7014118e+38 || !Number.isFinite(v)
  if (t === 'double')
    return v >= 8.98846567431158e+307 || !Number.isFinite(v)
  return false
}

function allocColumn(type: string, size: number, n: number): ColumnArray {
  if (type === 'byte')
    return new Int8Array(n)
  if (type === 'int')
    return new Int16Array(n)
  if (type === 'long')
    return new Int32Array(n)
  if (type === 'float')
    return new Float32Array(n)
  if (type === 'double')
    return new Float64Array(n)
    // string types (strN, strL): use plain string array
  return Array.from<string>({ length: n }).fill('')
}

function readCString(buf: Buffer, offset: number, maxLen: number, encoding: 'latin1' | 'utf8'): string {
  let end = offset
  const limit = Math.min(offset + maxLen, buf.length)
  while (end < limit && buf[end] !== 0) end++
  return buf.toString(encoding, offset, end)
}

// Find the byte offset of a tag's content (just after `<tag>`).
// Returns -1 if not found. Tag must be ASCII.
function findTagOpen(buf: Buffer, tag: string, fromOffset: number = 0): number {
  const needle = Buffer.from(`<${tag}>`, 'latin1')
  const idx = buf.indexOf(needle, fromOffset)
  return idx === -1 ? -1 : idx + needle.length
}

function findTagClose(buf: Buffer, tag: string, fromOffset: number = 0): number {
  const needle = Buffer.from(`</${tag}>`, 'latin1')
  return buf.indexOf(needle, fromOffset)
}

export class DtaParser {
  static parse(buffer: Buffer): DtaData {
    // --- 1. Detect format release ---
    // Header is ASCII at the very start.
    const head = buffer.toString('latin1', 0, 200)
    if (!head.includes('<stata_dta>')) {
      const first10 = buffer.toString('hex', 0, 10)
      throw new Error(`Unsupported Stata file. First 10 bytes: ${first10}. Only Stata 13+ (formats 117/118) are supported.`)
    }

    const releaseMatch = head.match(/<release>(\d+)<\/release>/)
    const releaseNum = releaseMatch ? Number.parseInt(releaseMatch[1], 10) : 0
    let fmt: FormatSpec
    if (releaseNum === 117)
      fmt = FMT_117
    else if (releaseNum === 118)
      fmt = FMT_118
    else throw new Error(`Unsupported Stata release: ${releaseNum || 'unknown'}. Supported: 117, 118.`)

    const byteorderMatch = head.match(/<byteorder>(LSF|MSF)<\/byteorder>/)
    const isLE = !byteorderMatch || byteorderMatch[1] === 'LSF'
    if (!isLE)
      throw new Error('MSF (big-endian) Stata files are not supported yet.')

    // --- 2. Parse <K> (number of variables) ---
    const kOpen = findTagOpen(buffer, 'K')
    if (kOpen === -1)
      throw new Error('Missing <K> tag.')
    const K = buffer.readUInt16LE(kOpen)

    // --- 3. Parse <N> (number of observations): 4 bytes (117) or 8 bytes (118) ---
    const nOpen = findTagOpen(buffer, 'N')
    if (nOpen === -1)
      throw new Error('Missing <N> tag.')
    let N: number
    if (fmt.nobsBytes === 4) {
      N = buffer.readUInt32LE(nOpen)
    }
    else {
      // Read as bigint then narrow; .dta nobs in practice fits in JS number.
      const big = buffer.readBigUInt64LE(nOpen)
      N = Number(big)
    }

    // --- 4. Parse <map>: 14 uint64 LE offsets ---
    // Map order (per Stata docs):
    //  0: <stata_dta>
    //  1: <map>
    //  2: <variable_types>
    //  3: <varnames>
    //  4: <sortlist>
    //  5: <formats>
    //  6: <value_label_names>
    //  7: <variable_labels>
    //  8: <characteristics>
    //  9: <data>
    // 10: <strls>
    // 11: <value_labels>
    // 12: </stata_data>  (end marker)
    // 13: end-of-file
    const mapOpen = findTagOpen(buffer, 'map')
    if (mapOpen === -1)
      throw new Error('Missing <map> tag.')
    const mapOffsets: number[] = []
    for (let i = 0; i < 14; i++) {
      const big = buffer.readBigUInt64LE(mapOpen + i * 8)
      mapOffsets.push(Number(big))
    }

    // Helper: read content between <tag>...</tag> using map-anchored offset.
    // The map points to '<' of the opening tag.
    const sliceTagContent = (mapIdx: number, tag: string): { start: number, end: number } => {
      const tagStart = mapOffsets[mapIdx]
      const openLen = tag.length + 2 // <tag>
      const start = tagStart + openLen
      const end = findTagClose(buffer, tag, start)
      if (end === -1)
        throw new Error(`Missing </${tag}> close tag.`)
      return { start, end }
    }

    // --- 5. <variable_types>: K * uint16 LE ---
    const vt = sliceTagContent(2, 'variable_types')
    const types: string[] = []
    const typeSizes: number[] = []
    for (let j = 0; j < K; j++) {
      const code = buffer.readUInt16LE(vt.start + j * 2)
      const dec = decodeTypeCode(code)
      if (!dec) {
        // Unknown code: skip variable but keep alignment by treating as byte.
        types.push('byte')
        typeSizes.push(1)
      }
      else {
        types.push(dec.type)
        typeSizes.push(dec.size)
      }
    }

    // --- 6. <varnames>: K * varnameLen, NUL-terminated, encoding-aware ---
    const vn = sliceTagContent(3, 'varnames')
    const headers: string[] = []
    for (let j = 0; j < K; j++) {
      headers.push(readCString(buffer, vn.start + j * fmt.varnameLen, fmt.varnameLen, fmt.encoding))
    }

    // --- 7. <variable_labels>: K * varlabelLen ---
    const vl = sliceTagContent(7, 'variable_labels')
    const labels: string[] = []
    for (let j = 0; j < K; j++) {
      labels.push(readCString(buffer, vl.start + j * fmt.varlabelLen, fmt.varlabelLen, fmt.encoding))
    }

    // --- 8. <value_labels>: zero or more <lbl> blocks ---
    const valueLabels: { [varName: string]: { [value: number]: string } } = {}
    try {
      const vlbl = sliceTagContent(11, 'value_labels')
      let cursor = vlbl.start
      const lblOpen = Buffer.from('<lbl>', 'latin1')
      const lblClose = Buffer.from('</lbl>', 'latin1')
      while (cursor < vlbl.end) {
        const oStart = buffer.indexOf(lblOpen, cursor)
        if (oStart === -1 || oStart >= vlbl.end)
          break
        const cStart = buffer.indexOf(lblClose, oStart + lblOpen.length)
        if (cStart === -1 || cStart > vlbl.end)
          break

        const blockStart = oStart + lblOpen.length
        const blockEnd = cStart
        cursor = cStart + lblClose.length

        // Block layout:
        //  int32  len           (size of remaining table after this header+name+pad)
        //  char   name[L]       (L = valueLabelNameLen, NUL-terminated)
        //  char   pad[3]        (always)
        //  int32  n             (number of entries)
        //  int32  txtlen        (length of text pool)
        //  int32  off[n]        (byte offset into text pool for each entry)
        //  int32  val[n]        (value for each entry)
        //  char   txt[txtlen]   (NUL-separated label strings)
        let off = blockStart
        if (off + 4 > blockEnd)
          continue
        off += 4 // skip len

        if (off + fmt.valueLabelNameLen + 3 > blockEnd)
          continue
        const lblName = readCString(buffer, off, fmt.valueLabelNameLen, fmt.encoding)
        off += fmt.valueLabelNameLen + 3

        if (off + 8 > blockEnd)
          continue
        const n = buffer.readInt32LE(off)
        off += 4
        const txtlen = buffer.readInt32LE(off)
        off += 4

        if (n < 0 || n > 1_000_000)
          continue
        if (off + 4 * n + 4 * n + txtlen > blockEnd)
          continue

        const offs: number[] = []
        for (let k = 0; k < n; k++) {
          offs.push(buffer.readInt32LE(off))
          off += 4
        }
        const vals: number[] = []
        for (let k = 0; k < n; k++) {
          vals.push(buffer.readInt32LE(off))
          off += 4
        }
        const txtStart = off
        const txtEnd = txtStart + txtlen

        const map: { [v: number]: string } = {}
        for (let k = 0; k < n; k++) {
          const s = txtStart + offs[k]
          if (s < txtStart || s >= txtEnd)
            continue
          map[vals[k]] = readCString(buffer, s, txtEnd - s, fmt.encoding)
        }
        if (lblName)
          valueLabels[lblName] = map
      }
    }
    catch { /* value_labels missing or malformed; skip */ }

    // Stata stores per-variable association via <value_label_names>: K * varnameLen, each pointing
    // to a label name in valueLabels. Map each variable to its label table.
    const variableValueLabels: { [varName: string]: { [v: number]: string } } = {}
    try {
      const vln = sliceTagContent(6, 'value_label_names')
      for (let j = 0; j < K; j++) {
        const lblName = readCString(buffer, vln.start + j * fmt.valueLabelNameLen, fmt.valueLabelNameLen, fmt.encoding)
        if (lblName && valueLabels[lblName]) {
          variableValueLabels[headers[j]] = valueLabels[lblName]
        }
      }
    }
    catch { /* skip */ }

    // --- 9. <data>: read rows ---
    const dataTagStart = mapOffsets[9]
    const dataContentStart = dataTagStart + '<data>'.length
    const rowSize = typeSizes.reduce((a, b) => a + b, 0)
    const limitRows = Math.min(N, 5000)
    const rows: any[][] = []

    if (rowSize > 0 && N > 0) {
      let offset = dataContentStart
      for (let i = 0; i < limitRows; i++) {
        if (offset + rowSize > buffer.length)
          break
        const row: any[] = []
        for (let j = 0; j < K; j++) {
          const type = types[j]
          const size = typeSizes[j]
          let val: any = null
          try {
            if (type === 'byte') {
              val = buffer.readInt8(offset)
            }
            else if (type === 'int') {
              val = buffer.readInt16LE(offset)
            }
            else if (type === 'long') {
              val = buffer.readInt32LE(offset)
            }
            else if (type === 'float') {
              val = buffer.readFloatLE(offset)
              if (Number.isFinite(val))
                val = Number.parseFloat(val.toFixed(6))
            }
            else if (type === 'double') {
              val = buffer.readDoubleLE(offset)
              if (Number.isFinite(val))
                val = Number.parseFloat(val.toFixed(6))
            }
            else if (type === 'strL') {
              // strL is an 8-byte (v,o) pointer; we don't resolve the pool yet.
              val = ''
            }
            else if (type.startsWith('str')) {
              val = readCString(buffer, offset, size, fmt.encoding)
            }
          }
          catch { val = null }
          row.push(val)
          offset += size
        }
        rows.push(row)
      }
    }

    return {
      headers,
      labels,
      rows,
      valueLabels: variableValueLabels,
      nobs: N,
    }
  }

  /**
   * Compute a tabulation/summary for a single variable using the in-memory
   * columnar representation. Format-agnostic (works for 117/118 and legacy 113-115).
   * If `indices` is provided, the tabulation operates only on those rows.
   */
  static tabulate(columnar: DtaColumnar, varName: string, indices?: Uint32Array): TabulateResult {
    const colIdx = columnar.meta.headers.indexOf(varName)
    if (colIdx === -1)
      throw new Error(`Variable not found: ${varName}`)
    const colType = columnar.meta.types[colIdx]
    const col = columnar.columns[varName]
    const miss = columnar.missing[varName]
    const N = columnar.meta.nobs

    const isNumeric = colType === 'byte' || colType === 'int' || colType === 'long' || colType === 'float' || colType === 'double'
    const isString = colType.startsWith('str') && colType !== 'strL'

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
        const v = (col as any)[i] as number
        if (Number.isNaN(v))
          nMissing++
        else
          numericValues.push(v)
      }
      else if (isString) {
        const s = (col as string[])[i]
        if (!s || s.length === 0)
          nMissing++
        else
          stringValues.push(s)
      }
      else {
        nMissing++ // strL or unknown
      }
    }

    const labelMap = columnar.meta.valueLabels[varName]
    const nValid = isNumeric ? numericValues.length : (isString ? stringValues.length : 0)

    // --- Discrete decision ---
    // 1) Has value labels → always discrete.
    // 2) Compute unique count (bounded). If <= MAX_DISCRETE_CATEGORIES → discrete.
    //    For floats, only discrete if all unique values are integers.
    const uniqueCounter = new Map<any, number>()
    let exceededCap = false
    // For numeric vars we want to be able to detect "21..200 integer uniques" so we
    // can render per-value bars instead of a histogram. So the cap is wider for numerics.
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
        if (!Number.isInteger(v as number)) {
          allIntegers = false
          break
        }
      }
    }

    const treatDiscrete
      = hasLabels
        || (!exceededCap && uniqueCounter.size > 0 && uniqueCounter.size <= MAX_DISCRETE_CATEGORIES
          && (!isFloatLike || allIntegers))

    // --- Discrete output ---
    if (treatDiscrete) {
      // If cap exceeded but labels exist, we still need full counts: redo without cap.
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
        const lbl = labelMap && labelMap[k as number]
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

    // --- Continuous output ---
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

      // Decide chart type:
      //   - If unique count is known (cap not exceeded), all values are integers,
      //     and uniques are between MAX_DISCRETE_CATEGORIES+1 and MAX_INT_BAR_VALUES,
      //     show per-value bars (this var is "discrete with many categories").
      //   - Otherwise binned histogram.
      const knownUniques = !exceededCap
      let allInts = false
      if (knownUniques) {
        allInts = true
        for (const v of uniqueCounter.keys()) {
          if (!Number.isInteger(v as number)) {
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
          .map(([value, count]) => ({ value: value as number, count }))
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

    // --- String output (many unique strings) ---
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

  /**
   * Async variant that yields to the event loop every `yieldEvery` rows.
   * Use this so a UI can paint progress updates while a large file is parsed.
   */
  static async parseColumnarAsync(buffer: Buffer, opts: ParseColumnarAsyncOptions = {}): Promise<DtaColumnar> {
    // Dispatch to legacy parser for pre-13 binary formats.
    if (isLegacyDtaFormat(buffer)) {
      return parseColumnarLegacyAsync(buffer, opts)
    }
    const layout = computeLayout(buffer)
    const { fmt, K, N, headers, types, typeSizes, dataStart, valueLabels } = layout
    const labels: string[] = readVarLabels(buffer, fmt, K)
    const rowSize = typeSizes.reduce((a, b) => a + b, 0)

    const columns: { [name: string]: ColumnArray } = {}
    const missing: { [name: string]: Uint8Array } = {}
    const colOffsets: number[] = []
    {
      let acc = 0
      for (let j = 0; j < K; j++) {
        colOffsets.push(acc)
        acc += typeSizes[j]
      }
    }
    for (let j = 0; j < K; j++) {
      columns[headers[j]] = allocColumn(types[j], typeSizes[j], N)
      missing[headers[j]] = new Uint8Array(N)
    }

    const progressStep = opts.progressStep ?? 10000
    const yieldEvery = opts.yieldEvery ?? 20000
    const onProgress = opts.onProgress

    for (let i = 0; i < N; i++) {
      const rowOff = dataStart + i * rowSize
      if (rowOff + rowSize > buffer.length)
        break

      for (let j = 0; j < K; j++) {
        const off = rowOff + colOffsets[j]
        const t = types[j]
        const size = typeSizes[j]
        const col = columns[headers[j]]
        const miss = missing[headers[j]]
        try {
          if (t === 'byte') {
            const v = buffer.readInt8(off)
            if (isMissingNumeric(v, 'byte'))
              miss[i] = 1
            else (col as Int8Array)[i] = v
          }
          else if (t === 'int') {
            const v = buffer.readInt16LE(off)
            if (isMissingNumeric(v, 'int'))
              miss[i] = 1
            else (col as Int16Array)[i] = v
          }
          else if (t === 'long') {
            const v = buffer.readInt32LE(off)
            if (isMissingNumeric(v, 'long'))
              miss[i] = 1
            else (col as Int32Array)[i] = v
          }
          else if (t === 'float') {
            const v = buffer.readFloatLE(off)
            if (isMissingNumeric(v, 'float')) {
              miss[i] = 1;
              (col as Float32Array)[i] = Number.NaN
            }
            else {
              (col as Float32Array)[i] = v
            }
          }
          else if (t === 'double') {
            const v = buffer.readDoubleLE(off)
            if (isMissingNumeric(v, 'double')) {
              miss[i] = 1;
              (col as Float64Array)[i] = Number.NaN
            }
            else {
              (col as Float64Array)[i] = v
            }
          }
          else if (t === 'strL') {
            miss[i] = 1;
            (col as string[])[i] = ''
          }
          else if (t.startsWith('str')) {
            const s = readCString(buffer, off, size, fmt.encoding)
            if (s.length === 0)
              miss[i] = 1;
            (col as string[])[i] = s
          }
        }
        catch {
          miss[i] = 1
        }
      }

      if (onProgress && (i + 1) % progressStep === 0) {
        onProgress(i + 1, N)
      }
      if ((i + 1) % yieldEvery === 0) {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }
    if (onProgress)
      onProgress(N, N)

    return {
      meta: {
        headers,
        labels,
        types,
        typeSizes,
        valueLabels,
        nobs: N,
        release: fmt.release,
      },
      columns,
      missing,
    }
  }

  /**
   * Single-pass columnar parse over ALL N observations.
   * Returns metadata + one TypedArray (or string[]) per variable + a missingness mask.
   * This is the foundation for filtering, sorting, paging and tabulation in O(1) per row.
   */
  static parseColumnar(buffer: Buffer, opts: ParseColumnarOptions = {}): DtaColumnar {
    if (isLegacyDtaFormat(buffer)) {
      return parseColumnarLegacy(buffer)
    }
    const layout = computeLayout(buffer)
    const { fmt, K, N, headers, types, typeSizes, dataStart, valueLabels } = layout
    const labels: string[] = readVarLabels(buffer, fmt, K)

    const rowSize = typeSizes.reduce((a, b) => a + b, 0)

    // Allocate one column container per variable.
    const columns: { [name: string]: ColumnArray } = {}
    const missing: { [name: string]: Uint8Array } = {}
    const colOffsets: number[] = []
    {
      let acc = 0
      for (let j = 0; j < K; j++) {
        colOffsets.push(acc)
        acc += typeSizes[j]
      }
    }
    for (let j = 0; j < K; j++) {
      columns[headers[j]] = allocColumn(types[j], typeSizes[j], N)
      missing[headers[j]] = new Uint8Array(N)
    }

    const progressStep = opts.progressStep ?? 10000
    const onProgress = opts.onProgress

    // Single linear pass.
    for (let i = 0; i < N; i++) {
      const rowOff = dataStart + i * rowSize
      if (rowOff + rowSize > buffer.length)
        break

      for (let j = 0; j < K; j++) {
        const off = rowOff + colOffsets[j]
        const t = types[j]
        const size = typeSizes[j]
        const col = columns[headers[j]]
        const miss = missing[headers[j]]

        try {
          if (t === 'byte') {
            const v = buffer.readInt8(off)
            if (isMissingNumeric(v, 'byte'))
              miss[i] = 1
            else (col as Int8Array)[i] = v
          }
          else if (t === 'int') {
            const v = buffer.readInt16LE(off)
            if (isMissingNumeric(v, 'int'))
              miss[i] = 1
            else (col as Int16Array)[i] = v
          }
          else if (t === 'long') {
            const v = buffer.readInt32LE(off)
            if (isMissingNumeric(v, 'long'))
              miss[i] = 1
            else (col as Int32Array)[i] = v
          }
          else if (t === 'float') {
            const v = buffer.readFloatLE(off)
            if (isMissingNumeric(v, 'float')) {
              miss[i] = 1;
              (col as Float32Array)[i] = Number.NaN
            }
            else {
              (col as Float32Array)[i] = v
            }
          }
          else if (t === 'double') {
            const v = buffer.readDoubleLE(off)
            if (isMissingNumeric(v, 'double')) {
              miss[i] = 1;
              (col as Float64Array)[i] = Number.NaN
            }
            else {
              (col as Float64Array)[i] = v
            }
          }
          else if (t === 'strL') {
            // strL pointers are not yet resolved against <strls>; treat as missing for now.
            miss[i] = 1;
            (col as string[])[i] = ''
          }
          else if (t.startsWith('str')) {
            const s = readCString(buffer, off, size, fmt.encoding)
            if (s.length === 0)
              miss[i] = 1;
            (col as string[])[i] = s
          }
        }
        catch {
          miss[i] = 1
        }
      }

      if (onProgress && (i + 1) % progressStep === 0) {
        onProgress(i + 1, N)
      }
    }
    if (onProgress)
      onProgress(N, N)

    return {
      meta: {
        headers,
        labels,
        types,
        typeSizes,
        valueLabels,
        nobs: N,
        release: fmt.release,
      },
      columns,
      missing,
    }
  }
}

// ---- Internal helpers shared by parse() and tabulate() ----

interface Layout {
  fmt: FormatSpec
  K: number
  N: number
  headers: string[]
  types: string[]
  typeSizes: number[]
  dataStart: number
  valueLabels: { [varName: string]: { [v: number]: string } }
}

function readVarLabels(buffer: Buffer, fmt: FormatSpec, K: number): string[] {
  // Re-find the tag offset using the map (cheap; called once per parseColumnar).
  const mapOpen = findTagOpen(buffer, 'map')
  if (mapOpen === -1)
    return Array.from<string>({ length: K }).fill('')
  const off7 = Number(buffer.readBigUInt64LE(mapOpen + 7 * 8))
  const start = off7 + 'variable_labels'.length + 2
  const end = findTagClose(buffer, 'variable_labels', start)
  if (end === -1)
    return Array.from<string>({ length: K }).fill('')
  const labels: string[] = []
  for (let j = 0; j < K; j++) {
    labels.push(readCString(buffer, start + j * fmt.varlabelLen, fmt.varlabelLen, fmt.encoding))
  }
  return labels
}

function computeLayout(buffer: Buffer): Layout {
  const head = buffer.toString('latin1', 0, 200)
  if (!head.includes('<stata_dta>')) {
    // Old binary formats (pre-Stata 13) start with a single ds_format byte.
    // Recognized values: 105, 108, 110, 111, 112, 113, 114, 115.
    const firstByte = buffer.length > 0 ? buffer[0] : -1
    const legacyFormats: { [k: number]: string } = {
      105: 'Stata 5 (format 105)',
      108: 'Stata 6 (format 108)',
      110: 'Stata 7 (format 110)',
      111: 'Stata 7SE (format 111)',
      112: 'Stata 8/9 (format 112)',
      113: 'Stata 8/9 (format 113)',
      114: 'Stata 10/11 (format 114)',
      115: 'Stata 12 (format 115)',
    }
    if (legacyFormats[firstByte]) {
      throw new Error(
        `Unsupported file: ${legacyFormats[firstByte]}. `
        + `This viewer supports formats 117 (Stata 13) and 118 (Stata 14+). `
        + `Open the file in Stata and re-save it (\`saveold, version(13)\` or just \`save\`) to use it here.`,
      )
    }
    throw new Error('Not a Stata file (or unrecognized format).')
  }
  const releaseMatch = head.match(/<release>(\d+)<\/release>/)
  const releaseNum = releaseMatch ? Number.parseInt(releaseMatch[1], 10) : 0
  const fmt = releaseNum === 117 ? FMT_117 : releaseNum === 118 ? FMT_118 : null
  if (!fmt)
    throw new Error(`Unsupported Stata release: ${releaseNum}. Supported: 117, 118.`)

  const kOpen = findTagOpen(buffer, 'K')
  const K = buffer.readUInt16LE(kOpen)
  const nOpen = findTagOpen(buffer, 'N')
  const N = fmt.nobsBytes === 4
    ? buffer.readUInt32LE(nOpen)
    : Number(buffer.readBigUInt64LE(nOpen))

  const mapOpen = findTagOpen(buffer, 'map')
  const mapOffsets: number[] = []
  for (let i = 0; i < 14; i++) {
    mapOffsets.push(Number(buffer.readBigUInt64LE(mapOpen + i * 8)))
  }

  const sliceTagContent = (mapIdx: number, tag: string): { start: number, end: number } => {
    const start = mapOffsets[mapIdx] + tag.length + 2
    const end = findTagClose(buffer, tag, start)
    if (end === -1)
      throw new Error(`Missing </${tag}>`)
    return { start, end }
  }

  const vt = sliceTagContent(2, 'variable_types')
  const types: string[] = []
  const typeSizes: number[] = []
  for (let j = 0; j < K; j++) {
    const code = buffer.readUInt16LE(vt.start + j * 2)
    const dec = decodeTypeCode(code)
    types.push(dec ? dec.type : 'byte')
    typeSizes.push(dec ? dec.size : 1)
  }

  const vn = sliceTagContent(3, 'varnames')
  const headers: string[] = []
  for (let j = 0; j < K; j++) {
    headers.push(readCString(buffer, vn.start + j * fmt.varnameLen, fmt.varnameLen, fmt.encoding))
  }

  // Value labels (rebuild to map var -> labels, same logic as parse()).
  const valueLabels: { [name: string]: { [v: number]: string } } = {}
  const rawLabels: { [name: string]: { [v: number]: string } } = {}
  try {
    const vlbl = sliceTagContent(11, 'value_labels')
    let cursor = vlbl.start
    const lblOpen = Buffer.from('<lbl>', 'latin1')
    const lblClose = Buffer.from('</lbl>', 'latin1')
    while (cursor < vlbl.end) {
      const oStart = buffer.indexOf(lblOpen, cursor)
      if (oStart === -1 || oStart >= vlbl.end)
        break
      const cStart = buffer.indexOf(lblClose, oStart + lblOpen.length)
      if (cStart === -1 || cStart > vlbl.end)
        break
      const blockStart = oStart + lblOpen.length
      const blockEnd = cStart
      cursor = cStart + lblClose.length

      let off = blockStart
      if (off + 4 > blockEnd)
        continue
      off += 4
      if (off + fmt.valueLabelNameLen + 3 > blockEnd)
        continue
      const lblName = readCString(buffer, off, fmt.valueLabelNameLen, fmt.encoding)
      off += fmt.valueLabelNameLen + 3
      if (off + 8 > blockEnd)
        continue
      const n = buffer.readInt32LE(off)
      off += 4
      const txtlen = buffer.readInt32LE(off)
      off += 4
      if (n < 0 || n > 1_000_000)
        continue
      if (off + 8 * n + txtlen > blockEnd)
        continue
      const offs: number[] = []
      for (let k = 0; k < n; k++) {
        offs.push(buffer.readInt32LE(off))
        off += 4
      }
      const vals: number[] = []
      for (let k = 0; k < n; k++) {
        vals.push(buffer.readInt32LE(off))
        off += 4
      }
      const txtStart = off
      const txtEnd = txtStart + txtlen
      const map: { [v: number]: string } = {}
      for (let k = 0; k < n; k++) {
        const s = txtStart + offs[k]
        if (s < txtStart || s >= txtEnd)
          continue
        map[vals[k]] = readCString(buffer, s, txtEnd - s, fmt.encoding)
      }
      if (lblName)
        rawLabels[lblName] = map
    }

    const vln = sliceTagContent(6, 'value_label_names')
    for (let j = 0; j < K; j++) {
      const name = readCString(buffer, vln.start + j * fmt.valueLabelNameLen, fmt.valueLabelNameLen, fmt.encoding)
      if (name && rawLabels[name])
        valueLabels[headers[j]] = rawLabels[name]
    }
  }
  catch { /* skip */ }

  const dataStart = mapOffsets[9] + '<data>'.length

  return { fmt, K, N, headers, types, typeSizes, dataStart, valueLabels }
}
