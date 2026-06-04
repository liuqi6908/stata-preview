/**
 * 表格导出工具。
 *
 * 输入为 DtaView 的当前视图，并按调用方传入的列顺序导出：
 *   - CSV：UTF-8 BOM + 逗号分隔文本；
 *   - XLSX：不依赖第三方库，直接生成一个最小 OpenXML 工作簿。
 */

import type { DtaView } from './dtaView'
import { Buffer } from 'node:buffer'

/** 表格导出格式 */
export type TableExportFormat = 'csv' | 'xlsx'

/** Excel 单工作表最大行数 */
export const EXCEL_MAX_ROWS = 1048576
/** Excel 单工作表最大列数 */
export const EXCEL_MAX_COLUMNS = 16384

/** 分批从 DtaView 读取数据，避免一次性构造过大的行数组。 */
const EXPORT_PAGE_SIZE = 10000

/** ZIP 文件条目 */
interface ZipEntry {
  /** ZIP 内部路径 */
  name: string
  /** 条目原始内容 */
  data: Buffer
}

/**
 * 将当前视图导出为 CSV。
 *
 * CSV 使用 UTF-8 BOM，方便 Excel/WPS 直接识别中文编码。
 */
export function exportViewToCsv(view: DtaView, columns: string[]): Uint8Array {
  const chunks: string[] = ['\uFEFF', columns.map(formatCsvCell).join(',')]

  for (let offset = 0; offset < view.totalFiltered; offset += EXPORT_PAGE_SIZE) {
    const limit = Math.min(EXPORT_PAGE_SIZE, view.totalFiltered - offset)
    const page = view.getPage({ offset, limit, columns })
    for (const row of page.rows) {
      chunks.push('\r\n')
      chunks.push(row.map(formatCsvCell).join(','))
    }
  }

  return Buffer.from(chunks.join(''), 'utf8')
}

/**
 * 将当前视图导出为 XLSX。
 *
 * 这里手动生成最小 OpenXML 工作簿，避免为导出功能引入额外依赖。
 */
export function exportViewToXlsx(view: DtaView, columns: string[]): Uint8Array {
  const columnRefs = columns.map((_, i) => xlsxColumnName(i))
  const sheetParts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetData>',
    formatXlsxRow(1, columns, columnRefs),
  ]

  let sheetRow = 2
  for (let offset = 0; offset < view.totalFiltered; offset += EXPORT_PAGE_SIZE) {
    const limit = Math.min(EXPORT_PAGE_SIZE, view.totalFiltered - offset)
    const page = view.getPage({ offset, limit, columns })
    for (const row of page.rows) {
      sheetParts.push(formatXlsxRow(sheetRow, row, columnRefs))
      sheetRow++
    }
  }

  sheetParts.push('</sheetData></worksheet>')

  return createZip([
    {
      name: '[Content_Types].xml',
      data: xmlBuffer(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: xmlBuffer(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: xmlBuffer(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>'
        + '</workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: xmlBuffer(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + '</Relationships>',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: xmlBuffer(sheetParts.join('')),
    },
  ])
}

/**
 * 格式化 CSV 单元格。
 */
function formatCsvCell(value: unknown): string {
  if (value === null || value === undefined)
    return ''
  const text = String(value)
  if (/[",\r\n]/.test(text))
    return `"${text.replace(/"/g, '""')}"`
  return text
}

/**
 * 格式化 XLSX 工作表行。
 */
function formatXlsxRow(rowIndex: number, values: unknown[], columnRefs: string[]): string {
  const cells: string[] = []
  for (let i = 0; i < values.length; i++) {
    const cell = formatXlsxCell(values[i], `${columnRefs[i]}${rowIndex}`)
    if (cell)
      cells.push(cell)
  }
  return `<row r="${rowIndex}">${cells.join('')}</row>`
}

/**
 * 格式化 XLSX 单元格。
 */
function formatXlsxCell(value: unknown, cellRef: string): string {
  if (value === null || value === undefined || value === '')
    return ''
  if (typeof value === 'number' && Number.isFinite(value))
    return `<c r="${cellRef}"><v>${value}</v></c>`

  const text = sanitizeXmlText(String(value))
  if (text.length === 0)
    return ''
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''
  return `<c r="${cellRef}" t="inlineStr"><is><t${preserve}>${escapeXml(text)}</t></is></c>`
}

/**
 * 移除 XML 1.0 不允许出现的控制字符。
 */
function sanitizeXmlText(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31))
      continue
    out += value[i]
  }
  return out
}

/**
 * 转义 XML 文本节点内容。
 */
function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&apos;',
  })[c]!)
}

/**
 * 将从 0 开始的列下标转换为 Excel 列名。
 */
function xlsxColumnName(index: number): string {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

/**
 * 生成 UTF-8 XML Buffer。
 */
function xmlBuffer(xml: string): Buffer {
  return Buffer.from(xml, 'utf8')
}

/**
 * 创建一个不压缩的 ZIP 文件。
 *
 * XLSX 本质上是 ZIP 包。这里使用 store 模式写入本地文件头、
 * 中央目录和结束记录，足够承载当前导出的几个 XML 部件。
 */
function createZip(entries: ZipEntry[]): Uint8Array {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    assertZip32(entry.name, data.length)

    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(33, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(33, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + data.length
  }

  const centralOffset = offset
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  assertZip32('central directory', centralSize)
  assertZip32('central directory offset', centralOffset)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, ...centralParts, end])
}

/**
 * 检查 ZIP32 字段范围。
 */
function assertZip32(label: string, value: number): void {
  if (value > 0xFFFFFFFF)
    throw new Error(`ZIP entry is too large: ${label}`)
}

/** CRC32 查表，用于 ZIP 条目校验和。 */
const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < CRC_TABLE.length; i++) {
  let c = i
  for (let k = 0; k < 8; k++)
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
  CRC_TABLE[i] = c >>> 0
}

/**
 * 计算 ZIP 条目 CRC32。
 */
function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++)
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}
