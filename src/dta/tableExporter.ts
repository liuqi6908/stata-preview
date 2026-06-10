/**
 * 表格导出工具。
 *
 * 输入为 DtaView 的当前视图，并按调用方传入的列顺序导出：
 *   - CSV：UTF-8 BOM + 逗号分隔文本；
 *   - XLSX：不依赖第三方库，直接生成一个最小 OpenXML 工作簿。
 */

import type { DtaView } from './dtaView'
import { Buffer } from 'node:buffer'
import { l10n } from 'vscode'

/** Excel 单工作表最大行数 */
export const EXCEL_MAX_ROWS = 1048576
/** Excel 单工作表最大列数 */
export const EXCEL_MAX_COLUMNS = 16384

/** 分批从 DtaView 读取数据，避免一次性构造过大的行数组。 */
const EXPORT_PAGE_SIZE = 10000

/** 计算大块 CRC 时每处理多少字节让出一次事件循环。 */
const CRC_YIELD_BYTES = 1024 * 1024

/** ZIP 文件条目 */
interface ZipEntry {
  /** ZIP 内部路径 */
  name: string
  /** 条目原始内容 */
  data: Buffer
}

/** ZIP 构建中的临时状态。 */
interface ZipBuildState {
  /** 本地文件头和内容。 */
  localParts: Buffer[]
  /** 中央目录条目。 */
  centralParts: Buffer[]
  /** 当前 ZIP 写入偏移。 */
  offset: number
}

/** 导出进度信息。 */
export interface TableExportProgress {
  /** 已写入的数据行数，不包含表头。 */
  processedRows: number
  /** 需要导出的总数据行数，不包含表头。 */
  totalRows: number
  /** 当前导出阶段。 */
  phase: 'rows' | 'packaging'
}

/** 导出配置。 */
export interface TableExportOptions {
  /** 单次从视图读取的行数。 */
  pageSize?: number
  /** 进度回调。 */
  onProgress?: (progress: TableExportProgress) => void
  /** 返回 true 时取消导出。 */
  shouldCancel?: () => boolean
}

/** 导出已被用户取消。 */
export class DtaExportCancelledError extends Error {
  constructor() {
    super('导出已取消。')
  }
}

/** 判断错误是否来自导出取消。 */
export function isDtaExportCancelledError(error: unknown): error is DtaExportCancelledError {
  return error instanceof DtaExportCancelledError
}

/**
 * 异步将当前视图导出为 CSV。
 *
 * CSV 使用 UTF-8 BOM，方便 Excel/WPS 直接识别中文编码。
 */
export async function exportViewToCsvAsync(
  view: DtaView,
  columns: string[],
  options: TableExportOptions = {},
): Promise<Uint8Array> {
  const pageSize = normalizeExportPageSize(options.pageSize)
  const chunks: string[] = ['\uFEFF', columns.map(formatCsvCell).join(',')]
  const totalRows = view.totalFiltered
  let processedRows = 0
  reportExportProgress(options, processedRows, totalRows, 'rows')

  for (let offset = 0; offset < totalRows; offset += pageSize) {
    assertExportNotCancelled(options)
    const limit = Math.min(pageSize, totalRows - offset)
    const page = view.getPage({ offset, limit, columns })
    for (const row of page.rows) {
      chunks.push('\r\n')
      chunks.push(row.map(formatCsvCell).join(','))
    }
    processedRows += page.rows.length
    reportExportProgress(options, processedRows, totalRows, 'rows')
    await yieldToEventLoop()
  }

  assertExportNotCancelled(options)
  return Buffer.from(chunks.join(''), 'utf8')
}

/**
 * 异步将当前视图导出为 XLSX。
 *
 * 这里手动生成最小 OpenXML 工作簿，避免为导出功能引入额外依赖。
 */
export async function exportViewToXlsxAsync(
  view: DtaView,
  columns: string[],
  options: TableExportOptions = {},
): Promise<Uint8Array> {
  const pageSize = normalizeExportPageSize(options.pageSize)
  const columnRefs = columns.map((_, i) => xlsxColumnName(i))
  const sheetParts = createXlsxSheetParts(columns, columnRefs)
  const totalRows = view.totalFiltered
  let processedRows = 0
  let sheetRow = 2
  reportExportProgress(options, processedRows, totalRows, 'rows')

  for (let offset = 0; offset < totalRows; offset += pageSize) {
    assertExportNotCancelled(options)
    const limit = Math.min(pageSize, totalRows - offset)
    const page = view.getPage({ offset, limit, columns })
    for (const row of page.rows) {
      sheetParts.push(formatXlsxRow(sheetRow, row, columnRefs))
      sheetRow++
    }
    processedRows += page.rows.length
    reportExportProgress(options, processedRows, totalRows, 'rows')
    await yieldToEventLoop()
  }

  assertExportNotCancelled(options)
  sheetParts.push('</sheetData></worksheet>')
  reportExportProgress(options, totalRows, totalRows, 'packaging')
  await yieldToEventLoop()

  return createZipAsync(createXlsxWorkbookEntries(sheetParts.join('')), options)
}

/**
 * 创建 XLSX 工作表 XML 片段。
 */
function createXlsxSheetParts(columns: string[], columnRefs: string[]): string[] {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetData>',
    formatXlsxRow(1, columns, columnRefs),
  ]
}

/**
 * 创建最小 XLSX 工作簿的 ZIP 条目。
 */
function createXlsxWorkbookEntries(sheetXml: string): ZipEntry[] {
  return [
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
      data: xmlBuffer(sheetXml),
    },
  ]
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
 * 归一化导出分页大小。
 */
function normalizeExportPageSize(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0)
    return EXPORT_PAGE_SIZE
  return Math.max(1, Math.floor(value))
}

/**
 * 汇报导出进度。
 */
function reportExportProgress(
  options: TableExportOptions,
  processedRows: number,
  totalRows: number,
  phase: TableExportProgress['phase'],
): void {
  options.onProgress?.({
    processedRows,
    totalRows,
    phase,
  })
}

/**
 * 检查导出是否已经取消。
 */
function assertExportNotCancelled(options: TableExportOptions): void {
  if (options.shouldCancel?.())
    throw new DtaExportCancelledError()
}

/**
 * 让出一次事件循环，避免大文件导出长期占用扩展宿主。
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * 异步创建一个不压缩的 ZIP 文件。
 *
 * XLSX 本质上是 ZIP 包。这里使用 store 模式写入本地文件头、
 * 中央目录和结束记录，足够承载当前导出的几个 XML 部件。
 */
async function createZipAsync(entries: ZipEntry[], options: TableExportOptions): Promise<Uint8Array> {
  const state = createZipBuildState()

  for (const entry of entries) {
    assertExportNotCancelled(options)
    appendZipEntry(state, entry, await crc32Async(entry.data, options))
    await yieldToEventLoop()
  }

  assertExportNotCancelled(options)
  return finishZip(state, entries.length)
}

/**
 * 创建 ZIP 构建状态。
 */
function createZipBuildState(): ZipBuildState {
  return {
    localParts: [],
    centralParts: [],
    offset: 0,
  }
}

/**
 * 写入单个 ZIP 条目。
 */
function appendZipEntry(state: ZipBuildState, entry: ZipEntry, crc: number): void {
  const name = Buffer.from(entry.name, 'utf8')
  const data = entry.data
  assertZip32(entry.name, data.length)

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
  state.localParts.push(local, name, data)

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
  central.writeUInt32LE(state.offset, 42)
  state.centralParts.push(central, name)

  state.offset += local.length + name.length + data.length
}

/**
 * 写入 ZIP 中央目录和结束记录。
 */
function finishZip(state: ZipBuildState, entryCount: number): Uint8Array {
  const centralOffset = state.offset
  const centralSize = state.centralParts.reduce((sum, part) => sum + part.length, 0)
  assertZip32(l10n.t('central directory'), centralSize)
  assertZip32(l10n.t('central directory offset'), centralOffset)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entryCount, 8)
  end.writeUInt16LE(entryCount, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...state.localParts, ...state.centralParts, end])
}

/**
 * 检查 ZIP32 字段范围。
 */
function assertZip32(label: string, value: number): void {
  if (value > 0xFFFFFFFF)
    throw new Error(l10n.t('ZIP entry is too large: {0}', label))
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
 * 异步计算 ZIP 条目 CRC32。
 */
async function crc32Async(data: Uint8Array, options: TableExportOptions): Promise<number> {
  let crc = 0xFFFFFFFF
  for (let start = 0; start < data.length; start += CRC_YIELD_BYTES) {
    assertExportNotCancelled(options)
    crc = crc32Update(crc, data, start, Math.min(start + CRC_YIELD_BYTES, data.length))
    await yieldToEventLoop()
  }
  assertExportNotCancelled(options)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/**
 * 增量更新 CRC32。
 */
function crc32Update(crc: number, data: Uint8Array, start: number, end: number): number {
  for (let i = start; i < end; i++)
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
  return crc
}
