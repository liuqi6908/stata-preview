/**
 * VS Code 扩展用的 Stata .dta 解析器。
 *
 * 原生支持 Stata 格式 117（Stata 13）和 118（Stata 14+），
 * 对于 113、114、115 等旧版二进制格式则派发到 ./parserLegacy 处理。
 *
 * 参考：https://www.stata.com/help.cgi?dta
 */

import { Buffer } from 'node:buffer'
import { isLegacyDtaFormat, parseColumnarLegacy, parseColumnarLegacyAsync } from './parserLegacy'

/** 行式预览数据 */
export interface DtaData {
  /** 变量名列表 */
  headers: string[]
  /** 变量标签列表 */
  labels: string[]
  /** 预览行数据，每行与 headers 对齐 */
  rows: any[][]
  /** 变量到值标签表的映射 */
  valueLabels?: { [varName: string]: { [value: number]: string } }
  /** 原始总观测数 */
  nobs?: number
}

/**
 * 列式表示：每个变量的数据存储在 TypedArray 中，
 * 字符串变量则使用 string[]。
 * 缺失值单独记录，避免将真实值（例如 0）误认为缺失。
 */
export type ColumnArray
  = | Int8Array | Int16Array | Int32Array
    | Float32Array | Float64Array
    | string[]

/** 数据集元信息 */
export interface DtaMeta {
  /** 变量名列表 */
  headers: string[]
  /** 变量标签列表 */
  labels: string[]
  /** 内部变量类型 */
  types: string[]
  /** 每个变量在单行数据中的字节大小 */
  typeSizes: number[]
  /** 变量到值标签表的映射 */
  valueLabels: { [varName: string]: { [value: number]: string } }
  /** 原始总观测数 */
  nobs: number
  /** 解析后的 Stata release 标记 */
  release: 117 | 118
}

/** 列式数据集 */
export interface DtaColumnar {
  /** 数据集元信息 */
  meta: DtaMeta
  /** 每个变量对应一列 */
  columns: { [varName: string]: ColumnArray }
  /** 缺失值掩码：1 = 缺失，0 = 有效 */
  missing: { [varName: string]: Uint8Array }
}

/** 列式解析配置 */
export interface ParseColumnarOptions {
  /** 进度回调 */
  onProgress?: (rowsRead: number, totalRows: number) => void
  /** 进度回调间隔 */
  progressStep?: number
}

/** 异步列式解析配置 */
export interface ParseColumnarAsyncOptions extends ParseColumnarOptions {
  /** 让出事件循环的行数间隔 */
  yieldEvery?: number
}

/**
 * 离散变量的汇总结果。
 * 适用于拥有值标签或唯一值较少的变量。
 */
export interface DiscreteTab {
  /** 汇总类型 */
  kind: 'discrete'
  /** 变量名 */
  varName: string
  /** 有效观测数 */
  nValid: number
  /** 缺失观测数 */
  nMissing: number
  /** 按值统计的频数、百分比和累计百分比 */
  entries: { value: any, label?: string, freq: number, pct: number, cum: number }[]
}

/**
 * 连续变量的汇总结果。
 * 包含分位数、均值、标准差和可用于绘图的直方图/柱状图数据。
 */
export interface ContinuousTab {
  /** 汇总类型 */
  kind: 'continuous'
  /** 变量名 */
  varName: string
  /** 有效观测数 */
  nValid: number
  /** 缺失观测数 */
  nMissing: number
  /** 最小值 */
  min: number
  /** 最大值 */
  max: number
  /** 均值 */
  mean: number
  /** 标准差 */
  sd: number
  /** 中位数 */
  median: number
  /** 1% 分位数 */
  p1: number
  /** 25% 分位数 */
  p25: number
  /** 75% 分位数 */
  p75: number
  /** 99% 分位数 */
  p99: number
  /** 图表数据 */
  chart:
    | { type: 'histogram', bins: { bin: number, lo: number, hi: number, count: number }[] }
    | { type: 'bars', bars: { value: number, count: number }[] }
  /** 唯一值数量；超过统计上限时为 -1 */
  nUnique: number
}

/**
 * 字符串变量的汇总结果。
 * 包含出现频率最高的 top 值与唯一值数量。
 */
export interface StringTab {
  /** 汇总类型 */
  kind: 'string'
  /** 变量名 */
  varName: string
  /** 有效观测数 */
  nValid: number
  /** 缺失观测数 */
  nMissing: number
  /** 唯一值数量 */
  nUnique: number
  /** 出现频率最高的字符串值 */
  topValues: { value: string, freq: number, pct: number }[]
}

/** 单变量汇总结果 */
export type TabulateResult = DiscreteTab | ContinuousTab | StringTab

/** 离散型变量的最大类别数 */
const MAX_DISCRETE_CATEGORIES = 20
/** 整数型变量若唯一值数不超过此阈值，则显示每值柱状图 */
const MAX_INT_BAR_VALUES = 200
/** 连续变量直方图分箱数 */
const HISTOGRAM_BINS = 30

/**
 * Stata 117/118 文件头部格式规格。
 * 控制变量名、变量标签和值标签名称等字段的长度与编码方式。
 */
interface FormatSpec {
  /** Stata release 标记 */
  release: 117 | 118
  /** 变量名字段长度 */
  varnameLen: number
  /** 变量标签字段长度 */
  varlabelLen: number
  /** 显示格式字段长度 */
  formatLen: number
  /** 值标签名称字段长度 */
  valueLabelNameLen: number
  /** 观测数字段字节数 */
  nobsBytes: number
  /** 字符串编码 */
  encoding: 'latin1' | 'utf8'
}

/** Stata 117 文件规格 */
const FMT_117: FormatSpec = {
  release: 117,
  varnameLen: 33,
  varlabelLen: 81,
  formatLen: 49,
  valueLabelNameLen: 33,
  nobsBytes: 4,
  encoding: 'latin1',
}

/** Stata 118 文件规格 */
const FMT_118: FormatSpec = {
  release: 118,
  varnameLen: 129,
  varlabelLen: 321,
  formatLen: 57,
  valueLabelNameLen: 129,
  nobsBytes: 8,
  encoding: 'utf8',
}

/**
 * 解码 Stata 117/118 类型代码。
 *
 * 类型代码（uint16 LE）：
 *   1..2045   -> strN（固定宽度字符串，N 字节）
 *   32768     -> strL（长字符串，数据中为 8 字节指针）
 *   65526     -> double（8 字节）
 *   65527     -> float（4 字节）
 *   65528     -> long（4 字节，int32）
 *   65529     -> int（2 字节，int16）
 *   65530     -> byte（1 字节，int8）
 */
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

/**
 * 判断数值是否为 Stata 缺失值。
 *
 * Stata 的 .= 和 .a..z 均高于各类型的普通取值阈值。
 * 参考：Stata "[U] 12.2.1 Missing values"。
 */
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

/**
 * 根据变量类型分配列存储
 */
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
  return Array.from<string>({ length: n }).fill('')
}

/**
 * 读取 NUL 终止字符串
 */
function readCString(buf: Buffer, offset: number, maxLen: number, encoding: 'latin1' | 'utf8'): string {
  let end = offset
  const limit = Math.min(offset + maxLen, buf.length)
  while (end < limit && buf[end] !== 0)
    end++
  return buf.toString(encoding, offset, end)
}

/** strL 长字符串查找表：数据行中的 8 字节引用 -> 实际字符串 */
type StrLMap = Map<string, string>

/**
 * 根据 GSO 记录中的 (v, o) 生成数据行里使用的 8 字节 strL 引用键。
 */
function strLKey(fmt: FormatSpec, v: number, o: bigint | number): string {
  const ob = typeof o === 'bigint' ? o : BigInt(o)
  if (fmt.release === 117)
    return (BigInt(v) + (ob << 32n)).toString()
  return (BigInt(v & 0xFFFF) + ((ob & ((1n << 48n) - 1n)) << 16n)).toString()
}

/**
 * 读取数据行里的 strL 引用。
 */
function readStrLRef(buffer: Buffer, offset: number, strls: StrLMap): string {
  if (offset + 8 > buffer.length)
    return ''
  const key = buffer.readBigUInt64LE(offset).toString()
  return strls.get(key) || ''
}

/**
 * 解析 <strls> 段中的 GSO 记录。
 *
 * Stata 117/118 的数据区只保存 strL 引用，真正内容存放在 <strls> 段。
 * type=130 是文本，type=129 是二进制；二进制用 latin1 做字节保真映射，
 * 以便统计时仍能按完整字节序列计数。
 */
function readStrLs(buffer: Buffer, fmt: FormatSpec, tagStart: number): StrLMap {
  const out: StrLMap = new Map()
  out.set('0', '')
  if (tagStart < 0 || tagStart >= buffer.length)
    return out

  const start = tagStart + '<strls>'.length
  const end = findTagClose(buffer, 'strls', start)
  if (end === -1)
    return out

  let off = start
  while (off + 3 <= end) {
    if (buffer.toString('latin1', off, off + 3) !== 'GSO')
      break
    off += 3

    const minHeader = fmt.release === 117 ? 13 : 17
    if (off + minHeader > end)
      break

    const v = buffer.readUInt32LE(off)
    off += 4
    const o = fmt.release === 117 ? BigInt(buffer.readUInt32LE(off)) : buffer.readBigUInt64LE(off)
    off += fmt.release === 117 ? 4 : 8
    const type = buffer.readUInt8(off)
    off += 1
    const len = buffer.readUInt32LE(off)
    off += 4

    if (off + len > end)
      break

    const raw = buffer.subarray(off, off + len)
    off += len

    let value: string
    if (type === 130) {
      const text = raw.length > 0 && raw[raw.length - 1] === 0
        ? raw.subarray(0, raw.length - 1)
        : raw
      value = text.toString(fmt.encoding)
    }
    else {
      value = raw.toString('latin1')
    }
    out.set(strLKey(fmt, v, o), value)
  }

  return out
}

/**
 * 初始化列存储、缺失值掩码与行内列偏移
 */
function createColumnarStorage(headers: string[], types: string[], typeSizes: number[], N: number) {
  const columns: { [name: string]: ColumnArray } = {}
  const missing: { [name: string]: Uint8Array } = {}
  const colOffsets: number[] = []
  let acc = 0
  for (let j = 0; j < headers.length; j++) {
    colOffsets.push(acc)
    acc += typeSizes[j]
    columns[headers[j]] = allocColumn(types[j], typeSizes[j], N)
    missing[headers[j]] = new Uint8Array(N)
  }
  return { columns, missing, colOffsets }
}

/**
 * 读取一行数据并写入列式存储
 */
function readColumnarRow(
  buffer: Buffer,
  rowOff: number,
  i: number,
  headers: string[],
  types: string[],
  typeSizes: number[],
  columns: { [name: string]: ColumnArray },
  missing: { [name: string]: Uint8Array },
  colOffsets: number[],
  encoding: 'latin1' | 'utf8',
  strls: StrLMap,
) {
  const K = headers.length
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
        else
          col[i] = v
      }
      else if (t === 'int') {
        const v = buffer.readInt16LE(off)
        if (isMissingNumeric(v, 'int'))
          miss[i] = 1
        else
          col[i] = v
      }
      else if (t === 'long') {
        const v = buffer.readInt32LE(off)
        if (isMissingNumeric(v, 'long'))
          miss[i] = 1
        else
          col[i] = v
      }
      else if (t === 'float') {
        const v = buffer.readFloatLE(off)
        if (isMissingNumeric(v, 'float')) {
          miss[i] = 1
          col[i] = Number.NaN
        }
        else {
          col[i] = v
        }
      }
      else if (t === 'double') {
        const v = buffer.readDoubleLE(off)
        if (isMissingNumeric(v, 'double')) {
          miss[i] = 1
          col[i] = Number.NaN
        }
        else {
          col[i] = v
        }
      }
      else if (t === 'strL') {
        const s = readStrLRef(buffer, off, strls)
        if (s.length === 0)
          miss[i] = 1
        col[i] = s
      }
      else if (t.startsWith('str')) {
        const s = readCString(buffer, off, size, encoding)
        if (s.length === 0)
          miss[i] = 1
        col[i] = s
      }
    }
    catch {
      miss[i] = 1
    }
  }
}

/**
 * 查找开始标签偏移
 */
function findTagStart(buf: Buffer, tag: string, fromOffset: number = 0): number {
  const needle = Buffer.from(`<${tag}>`, 'latin1')
  return buf.indexOf(needle, fromOffset)
}

/**
 * 查找标签内容起始偏移
 */
function findTagOpen(buf: Buffer, tag: string, fromOffset: number = 0): number {
  const idx = findTagStart(buf, tag, fromOffset)
  return idx === -1 ? -1 : idx + tag.length + 2
}

/**
 * 查找结束标签偏移
 */
function findTagClose(buf: Buffer, tag: string, fromOffset: number = 0): number {
  const needle = Buffer.from(`</${tag}>`, 'latin1')
  return buf.indexOf(needle, fromOffset)
}

/**
 * 读取 <map> 中的 14 个 uint64 LE 偏移量。
 */
function readMapOffsets(buffer: Buffer): number[] | null {
  const mapOpen = findTagOpen(buffer, 'map')
  if (mapOpen === -1 || mapOpen + 14 * 8 > buffer.length)
    return null

  const offsets: number[] = []
  for (let i = 0; i < 14; i++) {
    offsets.push(Number(buffer.readBigUInt64LE(mapOpen + i * 8)))
  }
  return offsets
}

/**
 * 判断指定偏移处是否正好是目标开始标签。
 * 用于校验 <map> 中记录的偏移是否可信，避免把偏移 0 或错误位置处的头部内容当作变量标签等数据段读取。
 */
function isTagStart(buffer: Buffer, tag: string, offset: number): boolean {
  if (!Number.isFinite(offset) || offset < 0)
    return false
  const needle = Buffer.from(`<${tag}>`, 'latin1')
  if (offset + needle.length > buffer.length)
    return false
  return buffer.subarray(offset, offset + needle.length).equals(needle)
}

/**
 * 根据 map 定位标签；若某些 117 文件的 map 槽位为 0 或偏移无效，则回退到实际标签搜索。
 */
function resolveMappedTagStart(buffer: Buffer, mapOffsets: number[] | null, mapIdx: number, tag: string): number {
  const mapped = mapOffsets?.[mapIdx]
  if (typeof mapped === 'number') {
    if (isTagStart(buffer, tag, mapped))
      return mapped

    // 容忍少数写入器把内容起点而不是开标签起点写入 map。
    const contentMappedStart = mapped - (tag.length + 2)
    if (isTagStart(buffer, tag, contentMappedStart))
      return contentMappedStart
  }

  return findTagStart(buffer, tag)
}

function sliceMappedTagContent(buffer: Buffer, mapOffsets: number[] | null, mapIdx: number, tag: string): { start: number, end: number } {
  const tagStart = resolveMappedTagStart(buffer, mapOffsets, mapIdx, tag)
  if (tagStart === -1)
    throw new Error(`Missing <${tag}> tag.`)

  const start = tagStart + tag.length + 2
  const end = findTagClose(buffer, tag, start)
  if (end === -1)
    throw new Error(`Missing </${tag}> close tag.`)
  return { start, end }
}

/**
 * Stata 117/118 数据解析器。
 * 提供预览解析、列式解析和单变量汇总功能。
 */
export class DtaParser {
  /**
   * 解析少量行式预览数据
   */
  static parse(buffer: Buffer): DtaData {
    // --- 1. 检测格式版本 ---
    // 文件开头是 ASCII 头部。
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
    else
      throw new Error(`Unsupported Stata release: ${releaseNum || 'unknown'}. Supported: 117, 118.`)

    const byteorderMatch = head.match(/<byteorder>(LSF|MSF)<\/byteorder>/)
    const isLE = !byteorderMatch || byteorderMatch[1] === 'LSF'
    if (!isLE)
      throw new Error('MSF (big-endian) Stata files are not supported yet.')

    // --- 2. 解析 <K>（变量数量） ---
    const kOpen = findTagOpen(buffer, 'K')
    if (kOpen === -1)
      throw new Error('Missing <K> tag.')
    const K = buffer.readUInt16LE(kOpen)

    // --- 3. 解析 <N>（观测数）：117 为 4 字节，118 为 8 字节 ---
    const nOpen = findTagOpen(buffer, 'N')
    if (nOpen === -1)
      throw new Error('Missing <N> tag.')
    let N: number
    if (fmt.nobsBytes === 4) {
      N = buffer.readUInt32LE(nOpen)
    }
    else {
      // Stata 的观测数通常可安全转换为 JS number。
      const big = buffer.readBigUInt64LE(nOpen)
      N = Number(big)
    }

    // --- 4. 解析 <map>：14 个 uint64 LE 偏移量 ---
    // map 中的顺序（按 Stata 文档）：
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
    // 12: </stata_dta>  结束标记
    // 13: 文件结束
    const mapOffsets = readMapOffsets(buffer)
    if (!mapOffsets)
      throw new Error('Missing <map> tag.')

    // 辅助：根据 map 提供的偏移读取 <tag>...</tag> 之间的内容。
    // 标准 map 指向开标签的 '<'；少数非标准 117 文件会回退到实际标签搜索。
    const sliceTagContent = (mapIdx: number, tag: string): { start: number, end: number } => {
      return sliceMappedTagContent(buffer, mapOffsets, mapIdx, tag)
    }

    // --- 5. <variable_types>: K * uint16 LE ---
    const vt = sliceTagContent(2, 'variable_types')
    const types: string[] = []
    const typeSizes: number[] = []
    for (let j = 0; j < K; j++) {
      const code = buffer.readUInt16LE(vt.start + j * 2)
      const dec = decodeTypeCode(code)
      if (!dec) {
        // 未知错误：跳过变量但保持对齐方式，将其视为字节处理
        types.push('byte')
        typeSizes.push(1)
      }
      else {
        types.push(dec.type)
        typeSizes.push(dec.size)
      }
    }

    // --- 6. <varnames>：K * varnameLen，NUL 终止，支持编码 ---
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

    // --- 8. <value_labels>: 解析零个或多个 <lbl> 块 ---
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

        // 块布局：
        //  int32  len           （头部、名称和填充之后的表大小）
        //  char   name[L]       （L = valueLabelNameLen，NUL 终止）
        //  char   pad[3]        （填充）
        //  int32  n             （条目数量）
        //  int32  txtlen        （文本池长度）
        //  int32  off[n]        （每个条目在文本池中的字节偏移）
        //  int32  val[n]        （每个条目的值）
        //  char   txt[txtlen]   （NUL 分隔的标签字符串）
        let off = blockStart
        if (off + 4 > blockEnd)
          continue
        off += 4 // 跳过 len

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
    catch { /* 值标签缺失或格式异常时跳过 */ }

    // Stata 通过 <value_label_names> 为每个变量关联一个标签名（K 个 varnameLen），
    // 该标签名对应 valueLabels 中的标签表。将每个变量映射到它的标签表。
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
    catch { /* 跳过值标签绑定 */ }

    const strls = readStrLs(buffer, fmt, resolveMappedTagStart(buffer, mapOffsets, 10, 'strls'))

    // --- 9. <data>: 读取行数据 ---
    const dataTagStart = resolveMappedTagStart(buffer, mapOffsets, 9, 'data')
    if (dataTagStart === -1)
      throw new Error('Missing <data> tag.')
    const dataContentStart = dataTagStart + '<data>'.length
    const rowSize = typeSizes.reduce((a, b) => a + b, 0)
    // 预览解析只读取前 1000 行，完整数据由 parseColumnar 处理。
    const limitRows = Math.min(N, 1000)
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
              val = readStrLRef(buffer, offset, strls)
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
   * 使用列式数据为单个变量计算汇总结果。
   * 格式无关（适用于 117/118 和旧版 113-115）。
   * 如果提供 indices，则只汇总指定行。
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
        nMissing++ // strL 或未知类型
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

    // --- 判断是否按离散型输出 ---
    // 1) 若存在值标签，则始终视为离散型。
    // 2) 计算唯一值数量（有上限）。若 <= MAX_DISCRETE_CATEGORIES 则视为离散型。
    //    对于浮点数，只有当所有唯一值均为整数时才视为离散型。
    const uniqueCounter = new Map<any, number>()
    let exceededCap = false
    // 数值型需要识别 21..200 个整数唯一值，以便显示每值柱状图。
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

    // --- 离散型输出 ---
    if (treatDiscrete) {
      // 若已超过上限但存在标签，则仍需完整计数：不使用上限重新计算。
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

    // --- 连续型输出 ---
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

      // 决定图表类型：
      //   - 若唯一值数量已知（未超过上限）、所有值为整数，
      //     且唯一值数量在 MAX_DISCRETE_CATEGORIES+1 到 MAX_INT_BAR_VALUES 之间，
      //     则显示每值柱状图（“类别较多的离散型”）。
      //   - 否则显示分箱直方图。
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

    // --- 字符串输出（高度唯一） ---
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
   * 异步解析完整文件为列式数据
   */
  static async parseColumnarAsync(buffer: Buffer, opts: ParseColumnarAsyncOptions = {}): Promise<DtaColumnar> {
    // 对于 Stata 13 之前的二进制格式，派发给旧版解析器处理。
    if (isLegacyDtaFormat(buffer)) {
      return parseColumnarLegacyAsync(buffer, opts)
    }
    const layout = computeLayout(buffer)
    const { fmt, K, N, headers, types, typeSizes, dataStart, strls, valueLabels } = layout
    const labels: string[] = readVarLabels(buffer, fmt, K)
    const rowSize = typeSizes.reduce((a, b) => a + b, 0)

    const { columns, missing, colOffsets } = createColumnarStorage(headers, types, typeSizes, N)

    const progressStep = opts.progressStep ?? 10000
    const yieldEvery = opts.yieldEvery ?? 20000
    const onProgress = opts.onProgress

    for (let i = 0; i < N; i++) {
      const rowOff = dataStart + i * rowSize
      if (rowOff + rowSize > buffer.length)
        break

      readColumnarRow(buffer, rowOff, i, headers, types, typeSizes, columns, missing, colOffsets, fmt.encoding, strls)

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
   * 同步解析完整文件为列式数据
   */
  static parseColumnar(buffer: Buffer, opts: ParseColumnarOptions = {}): DtaColumnar {
    if (isLegacyDtaFormat(buffer)) {
      return parseColumnarLegacy(buffer)
    }
    const layout = computeLayout(buffer)
    const { fmt, K, N, headers, types, typeSizes, dataStart, strls, valueLabels } = layout
    const labels: string[] = readVarLabels(buffer, fmt, K)

    const rowSize = typeSizes.reduce((a, b) => a + b, 0)

    const { columns, missing, colOffsets } = createColumnarStorage(headers, types, typeSizes, N)

    const progressStep = opts.progressStep ?? 10000
    const onProgress = opts.onProgress

    // 执行单次线性扫描。
    for (let i = 0; i < N; i++) {
      const rowOff = dataStart + i * rowSize
      if (rowOff + rowSize > buffer.length)
        break

      readColumnarRow(buffer, rowOff, i, headers, types, typeSizes, columns, missing, colOffsets, fmt.encoding, strls)

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

// ---------- 内部辅助函数 ----------

/** Stata 117/118 文件布局 */
interface Layout {
  /** 文件格式规格 */
  fmt: FormatSpec
  /** 变量数量 */
  K: number
  /** 观测数 */
  N: number
  /** 变量名列表 */
  headers: string[]
  /** 内部变量类型 */
  types: string[]
  /** 每个变量在单行数据中的字节大小 */
  typeSizes: number[]
  /** 数据区内容起始偏移 */
  dataStart: number
  /** strL 长字符串查找表 */
  strls: StrLMap
  /** 变量到值标签表的映射 */
  valueLabels: { [varName: string]: { [v: number]: string } }
}

/**
 * 读取变量标签列表
 */
function readVarLabels(buffer: Buffer, fmt: FormatSpec, K: number): string[] {
  // 使用 map 重新查找标签偏移（开销小；parseColumnar 仅调用一次）。
  let vl: { start: number, end: number }
  try {
    vl = sliceMappedTagContent(buffer, readMapOffsets(buffer), 7, 'variable_labels')
  }
  catch {
    return Array.from<string>({ length: K }).fill('')
  }

  const labels: string[] = []
  for (let j = 0; j < K; j++) {
    labels.push(readCString(buffer, vl.start + j * fmt.varlabelLen, fmt.varlabelLen, fmt.encoding))
  }
  return labels
}

/**
 * 解析 Stata 117/118 文件布局
 */
function computeLayout(buffer: Buffer): Layout {
  const head = buffer.toString('latin1', 0, 200)
  if (!head.includes('<stata_dta>')) {
    // 旧版二进制格式（Stata 13 之前）以单字节 ds_format 起始。
    // 识别值包括：105、108、110、111、112、113、114、115。
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

  const mapOffsets = readMapOffsets(buffer)
  if (!mapOffsets)
    throw new Error('Missing <map> tag.')

  const sliceTagContent = (mapIdx: number, tag: string): { start: number, end: number } => {
    return sliceMappedTagContent(buffer, mapOffsets, mapIdx, tag)
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

  // 值标签：重建变量到标签映射，逻辑与 parse() 一致
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
  catch { /* 跳过值标签 */ }

  const dataTagStart = resolveMappedTagStart(buffer, mapOffsets, 9, 'data')
  if (dataTagStart === -1)
    throw new Error('Missing <data> tag.')
  const dataStart = dataTagStart + '<data>'.length
  const strls = readStrLs(buffer, fmt, resolveMappedTagStart(buffer, mapOffsets, 10, 'strls'))

  return { fmt, K, N, headers, types, typeSizes, dataStart, strls, valueLabels }
}
