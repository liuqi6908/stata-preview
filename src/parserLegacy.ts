/**
 * Parser for legacy Stata .dta formats: 113 (Stata 8/9), 114 (Stata 10/11), 115 (Stata 12).
 * These predate the XML-wrapped 117/118 format and use a fixed-size binary header.
 *
 * Layout (LSF byteorder; we reject MSF for now):
 *   header (109 bytes):
 *     0      ds_format    (113 | 114 | 115)
 *     1      byteorder    (1 = HILO/MSF, 2 = LOLO/LSF)
 *     2      filetype     (1 = .dta)
 *     3      unused
 *     4..5   nvar         (uint16)
 *     6..9   nobs         (int32)
 *     10..90 data_label   (81 bytes, NUL-terminated)
 *     91..108 timestamp   (18 bytes, NUL-terminated)
 *
 *   typlist:    nvar bytes (1..244 = strN; 251=byte; 252=int; 253=long; 254=float; 255=double)
 *   varlist:    nvar * 33 bytes (variable names)
 *   srtlist:    (nvar+1) * 2 bytes
 *   fmtlist:    nvar * 12 bytes (113/114) or 49 bytes (115)
 *   lbllist:    nvar * 33 bytes
 *   variable_labels: nvar * 81 bytes
 *   expansion fields: variable size, terminated by byte 0 + 4 zero bytes
 *   data:       nobs * rowSize bytes
 *   value_labels: variable size, optional
 *
 * References: Stata Corp .dta format spec for releases 113–115.
 */

import type { Buffer } from 'node:buffer'
import type { ColumnArray, DtaColumnar } from './parser'

// ---------- Helpers (mirror parser.ts) ----------

function readCString(buf: Buffer, offset: number, maxLen: number): string {
  let end = offset
  const limit = Math.min(offset + maxLen, buf.length)
  while (end < limit && buf[end] !== 0) end++
  return buf.toString('latin1', offset, end)
}

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

// ---------- Layout extraction ----------

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
  valueLabelsStart: number // -1 if absent
  valueLabels: { [varName: string]: { [v: number]: string } }
}

function computeLegacyLayout(buf: Buffer): LegacyLayout {
  const ds = buf[0]
  if (ds !== 113 && ds !== 114 && ds !== 115) {
    throw new Error(`Not a legacy Stata dta (format ${ds}).`)
  }
  const release = ds as 113 | 114 | 115
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

  let off = 109 // after header

  // typlist
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

  // varlist (33 bytes each)
  const headers: string[] = []
  for (let j = 0; j < nvar; j++) {
    headers.push(readCString(buf, off + j * 33, 33))
  }
  off += nvar * 33

  // srtlist: (nvar+1) * 2 bytes
  off += (nvar + 1) * 2

  // fmtlist: 12 bytes (113/114) or 49 bytes (115) per variable
  const fmtLen = release === 115 ? 49 : 12
  off += nvar * fmtLen

  // lbllist (value-label name attached to each var): 33 bytes each
  const lblNames: string[] = []
  for (let j = 0; j < nvar; j++) {
    lblNames.push(readCString(buf, off + j * 33, 33))
  }
  off += nvar * 33

  // variable_labels: 81 bytes each
  const labels: string[] = []
  for (let j = 0; j < nvar; j++) {
    labels.push(readCString(buf, off + j * 81, 81))
  }
  off += nvar * 81

  // expansion fields: list of (1-byte tag, 4-byte length, payload). Terminated by tag=0 with len=0.
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

  // Value labels live after the data block (optional). We parse them to map each
  // variable's lbllist[j] to a set of {value: label} entries.
  const valueLabels: { [name: string]: { [v: number]: string } } = {}
  if (dataEnd <= buf.length) {
    let vlOff = dataEnd
    // Each value-label table:
    //   int32   len (size of the rest of the table after this header? — actually total len of n,txtlen,off[],val[],txt minus 5? See spec.)
    //   char[33] labname
    //   char[3]  pad
    //   int32   n
    //   int32   txtlen
    //   int32   off[n]
    //   int32   val[n]
    //   char[txtlen] txt
    while (vlOff + 4 + 33 + 3 + 4 + 4 <= buf.length) {
      const tableLen = buf.readInt32LE(vlOff) // length of the table that follows (after this 4-byte field's purpose differs by version, but we'll trust n/txtlen)
      vlOff += 4
      const lblName = readCString(buf, vlOff, 33)
      vlOff += 33
      vlOff += 3 // padding
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
      // tableLen tells us total bytes consumed from "lblName" onward; we already
      // advanced by exactly that, so trust our cursor and move on.
      void tableLen
    }
  }

  // Map each variable to its value-label table via lblNames.
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

// ---------- Public entry points ----------

export function parseColumnarLegacy(buf: Buffer): DtaColumnar {
  const layout = computeLegacyLayout(buf)
  const { nvar, nobs, headers, types, typeSizes, rowSize, dataStart } = layout

  const columns: { [name: string]: ColumnArray } = {}
  const missing: { [name: string]: Uint8Array } = {}
  const colOffsets: number[] = []
  {
    let acc = 0
    for (let j = 0; j < nvar; j++) {
      colOffsets.push(acc)
      acc += typeSizes[j]
    }
  }
  for (let j = 0; j < nvar; j++) {
    columns[headers[j]] = allocColumn(types[j], nobs)
    missing[headers[j]] = new Uint8Array(nobs)
  }

  for (let i = 0; i < nobs; i++) {
    const rowOff = dataStart + i * rowSize
    if (rowOff + rowSize > buf.length)
      break
    for (let j = 0; j < nvar; j++) {
      const off = rowOff + colOffsets[j]
      const t = types[j]
      const size = typeSizes[j]
      const col = columns[headers[j]]
      const miss = missing[headers[j]]
      try {
        if (t === 'byte') {
          const v = buf.readInt8(off)
          if (isMissingNumeric(v, 'byte'))
            miss[i] = 1
          else (col as Int8Array)[i] = v
        }
        else if (t === 'int') {
          const v = buf.readInt16LE(off)
          if (isMissingNumeric(v, 'int'))
            miss[i] = 1
          else (col as Int16Array)[i] = v
        }
        else if (t === 'long') {
          const v = buf.readInt32LE(off)
          if (isMissingNumeric(v, 'long'))
            miss[i] = 1
          else (col as Int32Array)[i] = v
        }
        else if (t === 'float') {
          const v = buf.readFloatLE(off)
          if (isMissingNumeric(v, 'float')) {
            miss[i] = 1;
            (col as Float32Array)[i] = Number.NaN
          }
          else {
            (col as Float32Array)[i] = v
          }
        }
        else if (t === 'double') {
          const v = buf.readDoubleLE(off)
          if (isMissingNumeric(v, 'double')) {
            miss[i] = 1;
            (col as Float64Array)[i] = Number.NaN
          }
          else {
            (col as Float64Array)[i] = v
          }
        }
        else if (t.startsWith('str')) {
          const s = readCString(buf, off, size)
          if (s.length === 0)
            miss[i] = 1;
          (col as string[])[i] = s
        }
      }
      catch {
        miss[i] = 1
      }
    }
  }

  return {
    meta: {
      headers,
      labels: layout.labels,
      types,
      typeSizes,
      valueLabels: layout.valueLabels,
      nobs,
      // We reuse 117 as the meta release marker for downstream code that branches on it;
      // legacy formats don't influence anything beyond the parser. If a caller really needs
      // the original release, add a separate field — but right now nothing does.
      release: 117,
    },
    columns,
    missing,
  }
}

export async function parseColumnarLegacyAsync(
  buf: Buffer,
  opts: {
    onProgress?: (rowsRead: number, totalRows: number) => void
    progressStep?: number
    yieldEvery?: number
  } = {},
): Promise<DtaColumnar> {
  const layout = computeLegacyLayout(buf)
  const { nvar, nobs, headers, types, typeSizes, rowSize, dataStart } = layout

  const columns: { [name: string]: ColumnArray } = {}
  const missing: { [name: string]: Uint8Array } = {}
  const colOffsets: number[] = []
  {
    let acc = 0
    for (let j = 0; j < nvar; j++) {
      colOffsets.push(acc)
      acc += typeSizes[j]
    }
  }
  for (let j = 0; j < nvar; j++) {
    columns[headers[j]] = allocColumn(types[j], nobs)
    missing[headers[j]] = new Uint8Array(nobs)
  }

  const progressStep = opts.progressStep ?? 10000
  const yieldEvery = opts.yieldEvery ?? 20000
  const onProgress = opts.onProgress

  for (let i = 0; i < nobs; i++) {
    const rowOff = dataStart + i * rowSize
    if (rowOff + rowSize > buf.length)
      break
    for (let j = 0; j < nvar; j++) {
      const off = rowOff + colOffsets[j]
      const t = types[j]
      const size = typeSizes[j]
      const col = columns[headers[j]]
      const miss = missing[headers[j]]
      try {
        if (t === 'byte') {
          const v = buf.readInt8(off)
          if (isMissingNumeric(v, 'byte'))
            miss[i] = 1
          else (col as Int8Array)[i] = v
        }
        else if (t === 'int') {
          const v = buf.readInt16LE(off)
          if (isMissingNumeric(v, 'int'))
            miss[i] = 1
          else (col as Int16Array)[i] = v
        }
        else if (t === 'long') {
          const v = buf.readInt32LE(off)
          if (isMissingNumeric(v, 'long'))
            miss[i] = 1
          else (col as Int32Array)[i] = v
        }
        else if (t === 'float') {
          const v = buf.readFloatLE(off)
          if (isMissingNumeric(v, 'float')) {
            miss[i] = 1;
            (col as Float32Array)[i] = Number.NaN
          }
          else {
            (col as Float32Array)[i] = v
          }
        }
        else if (t === 'double') {
          const v = buf.readDoubleLE(off)
          if (isMissingNumeric(v, 'double')) {
            miss[i] = 1;
            (col as Float64Array)[i] = Number.NaN
          }
          else {
            (col as Float64Array)[i] = v
          }
        }
        else if (t.startsWith('str')) {
          const s = readCString(buf, off, size)
          if (s.length === 0)
            miss[i] = 1;
          (col as string[])[i] = s
        }
      }
      catch {
        miss[i] = 1
      }
    }
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
 * Tabulate over a single column for a legacy file. Mirrors DtaParser.tabulate
 * but reads from the legacy header layout. We don't need this if the caller
 * already has a DtaColumnar (which they do, because parseColumnarLegacy gives
 * them one) — so we just expose that path through the existing tabulate by
 * delegating column reads. For now, the editor calls DtaParser.tabulate with
 * the already-parsed buffer; legacy files require a different code path, so
 * we add it here only if we hit that need. (See dispatch in editorProvider.)
 */
export function isLegacyDtaFormat(buf: Buffer): boolean {
  if (buf.length < 4)
    return false
  const ds = buf[0]
  return ds === 113 || ds === 114 || ds === 115
}
