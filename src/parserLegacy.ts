/**
 * 旧版 Stata .dta 解析器。
 *
 * 支持 113（Stata 8/9）、114（Stata 10/11）和 115（Stata 12）。
 * 这些格式早于 XML 封装的 117/118，使用固定大小的二进制头部。
 *
 * 文件布局（LSF 字节序；当前不支持 MSF）：
 *   header（109 字节）：
 *     0        ds_format     (113 | 114 | 115)
 *     1        byteorder     (1 = HILO/MSF, 2 = LOLO/LSF)
 *     2        filetype      (1 = .dta)
 *     3        unused
 *     4..5     nvar          (uint16)
 *     6..9     nobs          (int32)
 *     10..90   data_label    (81 字节，NUL 终止)
 *     91..108  timestamp     (18 字节，NUL 终止)
 *
 *   typlist:           nvar 字节（1..244=strN；251=byte；252=int；253=long；254=float；255=double）
 *   varlist:           nvar * 33 字节（变量名）
 *   srtlist:           (nvar+1) * 2 字节
 *   fmtlist:           nvar * 12 字节（113/114）或 49 字节（115）
 *   lbllist:           nvar * 33 字节
 *   variable_labels:   nvar * 81 字节
 *   expansion fields:  可变长度，以 tag=0 且 len=0 终止
 *   data:              nobs * rowSize 字节
 *   value_labels:      可变长度，可选
 *
 * 参考：Stata Corp 113-115 版本 .dta 格式规范。
 */

import type { Buffer } from 'node:buffer'
import type { ColumnArray, DtaColumnar } from './parser'

// ---------- 辅助函数 ----------

/**
 * 读取 NUL 终止字符串
 */
function readCString(buf: Buffer, offset: number, maxLen: number): string {
  let end = offset
  const limit = Math.min(offset + maxLen, buf.length)
  while (end < limit && buf[end] !== 0)
    end++
  return buf.toString('latin1', offset, end)
}

/**
 * 判断旧版数值是否为 Stata 缺失值
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
function allocColumn(type: string, n: number): ColumnArray {
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
 * 解码旧版类型代码
 */
function decodeLegacyType(code: number): { type: string, size: number } | null {
  if (code === 251)
    return { type: 'byte', size: 1 }
  if (code === 252)
    return { type: 'int', size: 2 }
  if (code === 253)
    return { type: 'long', size: 4 }
  if (code === 254)
    return { type: 'float', size: 4 }
  if (code === 255)
    return { type: 'double', size: 8 }
  if (code >= 1 && code <= 244)
    return { type: `str${code}`, size: code }
  return null
}

/**
 * 初始化列存储、缺失值掩码与行内列偏移
 */
function createLegacyColumns(headers: string[], types: string[], typeSizes: number[], nobs: number) {
  const columns: { [name: string]: ColumnArray } = {}
  const missing: { [name: string]: Uint8Array } = {}
  const colOffsets: number[] = []
  let acc = 0
  for (let j = 0; j < types.length; j++) {
    colOffsets.push(acc)
    acc += typeSizes[j]
  }
  for (let j = 0; j < headers.length; j++) {
    columns[headers[j]] = allocColumn(types[j], nobs)
    missing[headers[j]] = new Uint8Array(nobs)
  }
  return { columns, missing, colOffsets }
}

/**
 * 读取一行数据并写入列式存储
 */
function readLegacyRow(
  buf: Buffer,
  rowOff: number,
  i: number,
  headers: string[],
  types: string[],
  typeSizes: number[],
  columns: { [name: string]: ColumnArray },
  missing: { [name: string]: Uint8Array },
  colOffsets: number[],
) {
  const nvar = headers.length
  for (let j = 0; j < nvar; j++) {
    const off = rowOff + colOffsets[j]
    const t = types[j]
    const size = typeSizes[j]
    const col = columns[headers[j]]
    const miss = missing[headers[j]]
    try {
      switch (t) {
        case 'byte': {
          const v = buf.readInt8(off)
          if (isMissingNumeric(v, 'byte'))
            miss[i] = 1
          else
            col[i] = v
          break
        }
        case 'int': {
          const v = buf.readInt16LE(off)
          if (isMissingNumeric(v, 'int'))
            miss[i] = 1
          else
            col[i] = v
          break
        }
        case 'long': {
          const v = buf.readInt32LE(off)
          if (isMissingNumeric(v, 'long'))
            miss[i] = 1
          else
            col[i] = v
          break
        }
        case 'float': {
          const v = buf.readFloatLE(off)
          if (isMissingNumeric(v, 'float')) {
            miss[i] = 1
            col[i] = Number.NaN
          }
          else {
            col[i] = v
          }
          break
        }
        case 'double': {
          const v = buf.readDoubleLE(off)
          if (isMissingNumeric(v, 'double')) {
            miss[i] = 1
            col[i] = Number.NaN
          }
          else {
            col[i] = v
          }
          break
        }
        default: {
          if (t.startsWith('str')) {
            const s = readCString(buf, off, size)
            if (s.length === 0)
              miss[i] = 1
            col[i] = s
          }
          break
        }
      }
    }
    catch {
      miss[i] = 1
    }
  }
}

// ---------- 布局提取 ----------

/** 旧版 Stata 文件的布局信息 */
interface LegacyLayout {
  release: 113 | 114 | 115
  nvar: number
  nobs: number
  headers: string[]
  labels: string[]
  types: string[]
  typeSizes: number[]
  rowSize: number
  dataStart: number
  valueLabelsStart: number
  valueLabels: { [varName: string]: { [v: number]: string } }
}

/**
 * 解析文件头与元数据
 */
function computeLegacyLayout(buf: Buffer): LegacyLayout {
  const ds = buf[0]
  if (ds !== 113 && ds !== 114 && ds !== 115) {
    throw new Error(`Not a legacy Stata dta (format ${ds}).`)
  }
  const release = ds
  const byteorder = buf[1]
  if (byteorder !== 2) {
    throw new Error('Big-endian (MSF) legacy Stata files are not supported.')
  }
  const filetype = buf[2]
  if (filetype !== 1) {
    throw new Error(`Unexpected filetype byte: ${filetype}`)
  }

  const nvar = buf.readUInt16LE(4)
  const nobs = buf.readInt32LE(6)
  if (nobs < 0 || nobs > 1e9)
    throw new Error(`Implausible nobs: ${nobs}`)
  if (nvar < 0 || nvar > 32767)
    throw new Error(`Implausible nvar: ${nvar}`)

  let off = 109

  // 类型列表
  const types: string[] = []
  const typeSizes: number[] = []
  for (let j = 0; j < nvar; j++) {
    const code = buf[off + j]
    const dec = decodeLegacyType(code)
    if (!dec)
      throw new Error(`Unknown type code ${code} at variable ${j}`)
    types.push(dec.type)
    typeSizes.push(dec.size)
  }
  off += nvar

  // 变量名列表
  const headers: string[] = []
  for (let j = 0; j < nvar; j++) {
    headers.push(readCString(buf, off + j * 33, 33))
  }
  off += nvar * 33

  // 排序列表
  off += (nvar + 1) * 2

  // 显示格式列表
  const fmtLen = release === 115 ? 49 : 12
  off += nvar * fmtLen

  // 每个变量绑定的值标签名称
  const lblNames: string[] = []
  for (let j = 0; j < nvar; j++) {
    lblNames.push(readCString(buf, off + j * 33, 33))
  }
  off += nvar * 33

  // 变量标签
  const labels: string[] = []
  for (let j = 0; j < nvar; j++) {
    labels.push(readCString(buf, off + j * 81, 81))
  }
  off += nvar * 81

  // 扩展字段：由 tag、长度和 payload 组成，以 tag=0 且 len=0 终止
  while (off + 5 <= buf.length) {
    const tag = buf[off]
    const len = buf.readInt32LE(off + 1)
    if (tag === 0 && len === 0) {
      off += 5
      break
    }
    off += 5 + len
    if (len < 0 || off > buf.length)
      throw new Error('Malformed expansion field.')
  }

  const rowSize = typeSizes.reduce((a, b) => a + b, 0)
  const dataStart = off
  const dataEnd = dataStart + nobs * rowSize

  // 值标签表位于数据块之后，可选
  const valueLabels: { [name: string]: { [v: number]: string } } = {}
  if (dataEnd <= buf.length) {
    let vlOff = dataEnd
    // 值标签表结构：
    //   int32        len（后续表内容长度）
    //   char[33]     labname
    //   char[3]      填充
    //   int32        n
    //   int32        txtlen
    //   int32        off[n]
    //   int32        val[n]
    //   char[txtlen] txt
    while (vlOff + 4 + 33 + 3 + 4 + 4 <= buf.length) {
      // 不同版本对 tableLen 的解释略有差异，这里以 n/txtlen 校验为准
      const tableLen = buf.readInt32LE(vlOff)
      vlOff += 4
      const lblName = readCString(buf, vlOff, 33)
      vlOff += 33
      vlOff += 3
      if (vlOff + 8 > buf.length)
        break
      const n = buf.readInt32LE(vlOff)
      vlOff += 4
      const txtlen = buf.readInt32LE(vlOff)
      vlOff += 4
      if (n < 0 || n > 1_000_000 || txtlen < 0 || txtlen > 100_000_000)
        break
      if (vlOff + 8 * n + txtlen > buf.length)
        break

      const offs: number[] = []
      for (let k = 0; k < n; k++) {
        offs.push(buf.readInt32LE(vlOff))
        vlOff += 4
      }
      const vals: number[] = []
      for (let k = 0; k < n; k++) {
        vals.push(buf.readInt32LE(vlOff))
        vlOff += 4
      }
      const txtStart = vlOff
      const txtEnd = txtStart + txtlen

      const map: { [v: number]: string } = {}
      for (let k = 0; k < n; k++) {
        const s = txtStart + offs[k]
        if (s < txtStart || s >= txtEnd)
          continue
        map[vals[k]] = readCString(buf, s, txtEnd - s)
      }
      if (lblName)
        valueLabels[lblName] = map
      vlOff = txtEnd
      // tableLen 不直接参与游标计算
      void tableLen
    }
  }

  // 将变量绑定到对应的值标签表
  const varValueLabels: { [varName: string]: { [v: number]: string } } = {}
  for (let j = 0; j < nvar; j++) {
    const ln = lblNames[j]
    if (ln && valueLabels[ln])
      varValueLabels[headers[j]] = valueLabels[ln]
  }

  return {
    release,
    nvar,
    nobs,
    headers,
    labels,
    types,
    typeSizes,
    rowSize,
    dataStart,
    valueLabelsStart: dataEnd,
    valueLabels: varValueLabels,
  }
}

// ---------- 公共入口 ----------

/**
 * 同步解析旧版 .dta 为列式数据
 */
export function parseColumnarLegacy(buf: Buffer): DtaColumnar {
  const layout = computeLegacyLayout(buf)
  const { nobs, headers, types, typeSizes, rowSize, dataStart } = layout
  const { columns, missing, colOffsets } = createLegacyColumns(headers, types, typeSizes, nobs)

  for (let i = 0; i < nobs; i++) {
    const rowOff = dataStart + i * rowSize
    if (rowOff + rowSize > buf.length)
      break
    readLegacyRow(buf, rowOff, i, headers, types, typeSizes, columns, missing, colOffsets)
  }

  return {
    meta: {
      headers,
      labels: layout.labels,
      types,
      typeSizes,
      valueLabels: layout.valueLabels,
      nobs,
      // 下游按 117/118 分支处理，这里用 117 标记列式结果。
      release: 117,
    },
    columns,
    missing,
  }
}

/**
 * 异步解析旧版 .dta 为列式数据
 */
export async function parseColumnarLegacyAsync(
  buf: Buffer,
  opts: {
    /** 进度回调 */
    onProgress?: (rowsRead: number, totalRows: number) => void
    /** 进度回调间隔 */
    progressStep?: number
    /** 让出事件循环的行数间隔 */
    yieldEvery?: number
  } = {},
): Promise<DtaColumnar> {
  const layout = computeLegacyLayout(buf)
  const { nobs, headers, types, typeSizes, rowSize, dataStart } = layout
  const { columns, missing, colOffsets } = createLegacyColumns(headers, types, typeSizes, nobs)

  const progressStep = opts.progressStep ?? 10000
  const yieldEvery = opts.yieldEvery ?? 20000
  const onProgress = opts.onProgress

  for (let i = 0; i < nobs; i++) {
    const rowOff = dataStart + i * rowSize
    if (rowOff + rowSize > buf.length)
      break
    readLegacyRow(buf, rowOff, i, headers, types, typeSizes, columns, missing, colOffsets)
    if (onProgress && (i + 1) % progressStep === 0)
      onProgress(i + 1, nobs)
    if ((i + 1) % yieldEvery === 0)
      await new Promise<void>(r => setImmediate(r))
  }
  if (onProgress)
    onProgress(nobs, nobs)

  return {
    meta: {
      headers,
      labels: layout.labels,
      types,
      typeSizes,
      valueLabels: layout.valueLabels,
      nobs,
      release: 117,
    },
    columns,
    missing,
  }
}

/**
 * 判断 Buffer 是否为旧版 Stata .dta 格式
 */
export function isLegacyDtaFormat(buf: Buffer): boolean {
  if (buf.length < 4)
    return false
  const ds = buf[0]
  return ds === 113 || ds === 114 || ds === 115
}
