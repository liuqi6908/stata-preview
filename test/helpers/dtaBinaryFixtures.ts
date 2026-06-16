import type { ByteOrder } from '../../src/dta/types'
import { Buffer } from 'node:buffer'

// ---------- 类型与常量 ----------

/** 旧版二进制 .dta fixture 支持的 release */
export type LegacyFixtureRelease = 113 | 114 | 115

/** 现代 XML 包装 .dta fixture 支持的 release */
export type ModernFixtureRelease = 117 | 118 | 119

/** fixture 覆盖的字节序 */
export const fixtureByteOrders = ['LSF', 'MSF'] as const

/** fixture 覆盖的旧版 release */
export const legacyFixtureReleases = [113, 114, 115] as const

/** fixture 覆盖的现代 release */
export const modernFixtureReleases = [117, 118, 119] as const

interface ModernFormatSpec {
  /** 变量名字段长度 */
  varnameLen: number
  /** 变量标签字段长度 */
  varlabelLen: number
  /** 显示格式字段长度 */
  formatLen: number
  /** 值标签名称字段长度 */
  valueLabelNameLen: number
  /** 观测数字段字节数 */
  nobsBytes: 4 | 8
  /** 变量数量字段字节数 */
  kBytes: 2 | 4
  /** 字符串编码 */
  encoding: BufferEncoding
}

// ---------- fixture 入口 ----------

/**
 * 创建覆盖旧版 113/114/115 格式的最小二进制 .dta
 *
 * 数据包含 long、double、str8、byte 四类变量，并绑定一个值标签表
 */
export function createLegacyDtaBuffer(release: LegacyFixtureRelease, byteOrder: ByteOrder): Buffer {
  const variables = [
    { name: 'id', label: 'Identifier', code: 253, size: 4, labelName: '' },
    { name: 'score', label: 'Score', code: 255, size: 8, labelName: '' },
    { name: 'name', label: 'Name', code: 8, size: 8, labelName: '' },
    { name: 'group', label: 'Group', code: 251, size: 1, labelName: 'grp' },
  ]
  const nobs = 2
  const header = Buffer.alloc(109)
  header[0] = release
  header[1] = byteOrder === 'MSF' ? 1 : 2
  header[2] = 1
  writeUInt16(header, 4, variables.length, byteOrder)
  writeInt32(header, 6, nobs, byteOrder)
  fixedString('Synthetic legacy fixture', 81, 'latin1').copy(header, 10)
  fixedString('01 Jan 2026 00:00', 18, 'latin1').copy(header, 91)

  const typlist = Buffer.from(variables.map(variable => variable.code))
  const varlist = Buffer.concat(variables.map(variable => fixedString(variable.name, 33, 'latin1')))
  const srtlist = Buffer.alloc((variables.length + 1) * 2)
  const fmtLen = release === 113 ? 12 : 49
  const fmtlist = Buffer.concat(variables.map(() => fixedString('', fmtLen, 'latin1')))
  const lbllist = Buffer.concat(variables.map(variable => fixedString(variable.labelName, 33, 'latin1')))
  const variableLabels = Buffer.concat(variables.map(variable => fixedString(variable.label, 81, 'latin1')))
  const expansionEnd = Buffer.concat([Buffer.from([0]), int32(0, byteOrder)])

  const rows = Buffer.concat([
    legacyRow({ id: 1, score: 12.5, name: 'Alpha', group: 1 }, byteOrder),
    legacyRow({ id: 2, score: Number.POSITIVE_INFINITY, name: '', group: 0 }, byteOrder),
  ])
  const valueLabels = legacyValueLabelTable('grp', { 0: 'Control', 1: 'Treatment' }, byteOrder)

  return Buffer.concat([
    header,
    typlist,
    varlist,
    srtlist,
    fmtlist,
    lbllist,
    variableLabels,
    expansionEnd,
    rows,
    valueLabels,
  ])
}

/**
 * 创建覆盖现代 117/118/119 格式的最小二进制 .dta
 *
 * 数据包含 strL 长字符串引用，用于验证 `<strls>` GSO 记录解析
 */
export function createModernDtaBuffer(release: ModernFixtureRelease, byteOrder: ByteOrder): Buffer {
  const fmt = modernFormat(release)
  const note = `long text ${release} ${byteOrder}`
  const variables = [
    { name: 'id', label: 'Identifier', typeCode: 65528, labelName: '' },
    { name: 'score', label: 'Score', typeCode: 65526, labelName: '' },
    { name: 'group', label: 'Group', typeCode: 65530, labelName: 'grp' },
    { name: 'note', label: 'Long note', typeCode: 32768, labelName: '' },
  ]
  const nobs = 2
  const offsets = Array.from<number>({ length: 14 }).fill(0)
  const parts: Buffer[] = []
  let cursor = 0
  let mapContentOffset = 0

  const append = (part: Buffer) => {
    parts.push(part)
    cursor += part.length
  }
  const appendRaw = (text: string) => append(Buffer.from(text, 'latin1'))
  const appendMappedTag = (mapIndex: number, name: string, content: Buffer) => {
    offsets[mapIndex] = cursor
    append(tag(name, content))
  }

  offsets[0] = 0
  appendRaw('<stata_dta>')
  append(tag('header', Buffer.concat([
    tag('release', Buffer.from(String(release), 'latin1')),
    tag('byteorder', Buffer.from(byteOrder, 'latin1')),
    tag('K', fmt.kBytes === 2 ? uint16(variables.length, byteOrder) : uint32(variables.length, byteOrder)),
    tag('N', fmt.nobsBytes === 4 ? uint32(nobs, byteOrder) : uint64(nobs, byteOrder)),
  ])))

  offsets[1] = cursor
  mapContentOffset = cursor + '<map>'.length
  append(tag('map', Buffer.alloc(14 * 8)))

  appendMappedTag(2, 'variable_types', Buffer.concat(variables.map(variable => uint16(variable.typeCode, byteOrder))))
  appendMappedTag(3, 'varnames', Buffer.concat(variables.map(variable => fixedString(variable.name, fmt.varnameLen, fmt.encoding))))
  appendMappedTag(4, 'sortlist', Buffer.alloc((variables.length + 1) * 2))
  appendMappedTag(5, 'formats', Buffer.concat(variables.map(() => fixedString('', fmt.formatLen, fmt.encoding))))
  appendMappedTag(6, 'value_label_names', Buffer.concat(variables.map(variable => fixedString(variable.labelName, fmt.valueLabelNameLen, fmt.encoding))))
  appendMappedTag(7, 'variable_labels', Buffer.concat(variables.map(variable => fixedString(variable.label, fmt.varlabelLen, fmt.encoding))))
  appendMappedTag(8, 'characteristics', Buffer.alloc(0))
  appendMappedTag(9, 'data', Buffer.concat([
    modernRow(release, byteOrder, { id: 1, score: 12.5, group: 1, strLV: 1, strLO: 1 }),
    modernRow(release, byteOrder, { id: 2, score: Number.POSITIVE_INFINITY, group: 0, strLV: 0, strLO: 0 }),
  ]))
  appendMappedTag(10, 'strls', strLRecord(release, byteOrder, 1, 1, note, fmt.encoding))
  appendMappedTag(11, 'value_labels', modernValueLabelBlock('grp', { 0: 'Control', 1: 'Treatment' }, fmt, byteOrder))

  offsets[12] = cursor
  appendRaw('</stata_dta>')
  offsets[13] = cursor

  const out = Buffer.concat(parts)
  for (let i = 0; i < offsets.length; i++)
    writeUInt64(out, mapContentOffset + i * 8, offsets[i], byteOrder)
  return out
}

// ---------- 行数据 ----------

/**
 * 旧版 fixture 的单行数据
 */
function legacyRow(row: { id: number, score: number, name: string, group: number }, byteOrder: ByteOrder): Buffer {
  return Buffer.concat([
    int32(row.id, byteOrder),
    double(row.score, byteOrder),
    fixedString(row.name, 8, 'latin1'),
    Buffer.from([row.group]),
  ])
}

/**
 * 现代 fixture 的单行数据
 */
function modernRow(
  release: ModernFixtureRelease,
  byteOrder: ByteOrder,
  row: { id: number, score: number, group: number, strLV: number, strLO: number },
): Buffer {
  return Buffer.concat([
    int32(row.id, byteOrder),
    double(row.score, byteOrder),
    Buffer.from([row.group]),
    strLRef(release, byteOrder, row.strLV, row.strLO),
  ])
}

// ---------- strL ----------

/**
 * 写入 strL 行内引用，不同 release 对 v/o 字段拆分方式不同
 */
function strLRef(release: ModernFixtureRelease, byteOrder: ByteOrder, v: number, o: number): Buffer {
  if (release === 117)
    return Buffer.concat([packedUInt(v, 4, byteOrder), packedUInt(o, 4, byteOrder)])
  if (release === 118)
    return Buffer.concat([packedUInt(v, 2, byteOrder), packedUInt(o, 6, byteOrder)])
  return Buffer.concat([packedUInt(v, 3, byteOrder), packedUInt(o, 5, byteOrder)])
}

/**
 * 构造 `<strls>` 中的单条 GSO 文本记录
 */
function strLRecord(
  release: ModernFixtureRelease,
  byteOrder: ByteOrder,
  v: number,
  o: number,
  text: string,
  encoding: BufferEncoding,
): Buffer {
  const raw = Buffer.concat([Buffer.from(text, encoding), Buffer.from([0])])
  return Buffer.concat([
    Buffer.from('GSO', 'latin1'),
    uint32(v, byteOrder),
    release === 117 ? uint32(o, byteOrder) : uint64(o, byteOrder),
    Buffer.from([130]),
    uint32(raw.length, byteOrder),
    raw,
  ])
}

// ---------- 值标签 ----------

/**
 * 构造旧版格式的数据尾部值标签表
 */
function legacyValueLabelTable(name: string, labels: Record<number, string>, byteOrder: ByteOrder): Buffer {
  const body = valueLabelBody(name, labels, 33, 'latin1', byteOrder)
  return Buffer.concat([int32(body.length, byteOrder), body])
}

/**
 * 构造现代格式 `<value_labels>` 中的 `<lbl>` 块
 */
function modernValueLabelBlock(
  name: string,
  labels: Record<number, string>,
  fmt: ModernFormatSpec,
  byteOrder: ByteOrder,
): Buffer {
  const body = valueLabelBody(name, labels, fmt.valueLabelNameLen, fmt.encoding, byteOrder)
  return Buffer.concat([
    Buffer.from('<lbl>', 'latin1'),
    int32(body.length, byteOrder),
    body,
    Buffer.from('</lbl>', 'latin1'),
  ])
}

/**
 * 构造值标签表的公共主体
 */
function valueLabelBody(
  name: string,
  labels: Record<number, string>,
  nameLen: number,
  encoding: BufferEncoding,
  byteOrder: ByteOrder,
): Buffer {
  const entries = Object.entries(labels).map(([value, label]) => ({ value: Number(value), label }))
  const textParts: Buffer[] = []
  const offsets: number[] = []
  let textOffset = 0
  for (const entry of entries) {
    const part = Buffer.concat([Buffer.from(entry.label, encoding), Buffer.from([0])])
    offsets.push(textOffset)
    textOffset += part.length
    textParts.push(part)
  }
  const text = Buffer.concat(textParts)
  return Buffer.concat([
    fixedString(name, nameLen, encoding),
    Buffer.alloc(3),
    int32(entries.length, byteOrder),
    int32(text.length, byteOrder),
    Buffer.concat(offsets.map(offset => int32(offset, byteOrder))),
    Buffer.concat(entries.map(entry => int32(entry.value, byteOrder))),
    text,
  ])
}

// ---------- 现代格式 ----------

/**
 * 现代 release 的字段长度规格
 */
function modernFormat(release: ModernFixtureRelease): ModernFormatSpec {
  if (release === 117) {
    return {
      varnameLen: 33,
      varlabelLen: 81,
      formatLen: 49,
      valueLabelNameLen: 33,
      nobsBytes: 4,
      kBytes: 2,
      encoding: 'latin1',
    }
  }
  return {
    varnameLen: 129,
    varlabelLen: 321,
    formatLen: 57,
    valueLabelNameLen: 129,
    nobsBytes: 8,
    kBytes: release === 119 ? 4 : 2,
    encoding: 'utf8',
  }
}

// ---------- Buffer 片段 ----------

/**
 * 构造 NUL 终止的固定宽度字符串字段
 */
function fixedString(value: string, len: number, encoding: BufferEncoding): Buffer {
  const out = Buffer.alloc(len)
  Buffer.from(value, encoding).copy(out, 0, 0, Math.max(0, len - 1))
  return out
}

/**
 * 构造 XML 风格标签
 */
function tag(name: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<${name}>`, 'latin1'),
    content,
    Buffer.from(`</${name}>`, 'latin1'),
  ])
}

// ---------- 数值写入 ----------

function uint16(value: number, byteOrder: ByteOrder): Buffer {
  const out = Buffer.alloc(2)
  byteOrder === 'LSF' ? out.writeUInt16LE(value, 0) : out.writeUInt16BE(value, 0)
  return out
}

function uint32(value: number, byteOrder: ByteOrder): Buffer {
  const out = Buffer.alloc(4)
  byteOrder === 'LSF' ? out.writeUInt32LE(value, 0) : out.writeUInt32BE(value, 0)
  return out
}

function uint64(value: number, byteOrder: ByteOrder): Buffer {
  const out = Buffer.alloc(8)
  writeUInt64(out, 0, value, byteOrder)
  return out
}

function int32(value: number, byteOrder: ByteOrder): Buffer {
  const out = Buffer.alloc(4)
  writeInt32(out, 0, value, byteOrder)
  return out
}

function double(value: number, byteOrder: ByteOrder): Buffer {
  const out = Buffer.alloc(8)
  byteOrder === 'LSF' ? out.writeDoubleLE(value, 0) : out.writeDoubleBE(value, 0)
  return out
}

function writeUInt16(buffer: Buffer, offset: number, value: number, byteOrder: ByteOrder): void {
  byteOrder === 'LSF' ? buffer.writeUInt16LE(value, offset) : buffer.writeUInt16BE(value, offset)
}

function writeInt32(buffer: Buffer, offset: number, value: number, byteOrder: ByteOrder): void {
  byteOrder === 'LSF' ? buffer.writeInt32LE(value, offset) : buffer.writeInt32BE(value, offset)
}

function writeUInt64(buffer: Buffer, offset: number, value: number, byteOrder: ByteOrder): void {
  const big = BigInt(value)
  byteOrder === 'LSF' ? buffer.writeBigUInt64LE(big, offset) : buffer.writeBigUInt64BE(big, offset)
}

/**
 * 写入 Stata strL 行引用使用的 2-6 字节无符号整数
 */
function packedUInt(value: number, byteLength: number, byteOrder: ByteOrder): Buffer {
  const out = Buffer.alloc(byteLength)
  let n = value
  for (let i = 0; i < byteLength; i++) {
    const target = byteOrder === 'LSF' ? i : byteLength - 1 - i
    out[target] = n & 0xFF
    n = Math.floor(n / 256)
  }
  return out
}
