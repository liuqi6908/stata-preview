/**
 * DTA 表格导出服务。
 *
 * 负责用户保存位置选择、Excel 尺寸限制校验、导出进度提示和文件写入。
 */

import type * as vscode from 'vscode'
import type { DtaView } from './dtaView'
import type { TableExportProgress } from './tableExporter'
import type { TableExportFormat, VariableDictionaryEntry } from './types'
import * as path from 'node:path'
import { l10n, ProgressLocation, Uri, window, workspace } from 'vscode'
import {
  DtaExportCancelledError,
  EXCEL_MAX_COLUMNS,
  EXCEL_MAX_ROWS,
  exportRowsToCsvAsync,
  exportRowsToXlsxAsync,
  exportViewToCsvAsync,
  exportViewToXlsxAsync,
  isDtaExportCancelledError,
} from './tableExporter'

/** 导出当前表格视图所需的参数。 */
export interface ExportDtaViewOptions {
  /** 源 DTA 文件 URI，用于生成默认导出路径。 */
  sourceUri: vscode.Uri
  /** 当前筛选和排序后的查询视图。 */
  view: DtaView
  /** 导出格式。 */
  format: TableExportFormat
  /** 导出的列名列表，顺序与 Webview 可见列一致。 */
  columns: string[]
}

/** 导出变量字典所需的参数。 */
export interface ExportVariableDictionaryOptions {
  /** 源 DTA 文件 URI，用于生成默认导出路径。 */
  sourceUri: vscode.Uri
  /** 变量字典摘要。 */
  entries: VariableDictionaryEntry[]
  /** 导出格式。 */
  format: TableExportFormat
}

/**
 * 导出当前查询视图，并返回实际保存的 URI；用户取消时返回 null。
 */
export async function exportDtaView(options: ExportDtaViewOptions): Promise<vscode.Uri | null> {
  const { sourceUri, view, format, columns } = options
  if (columns.length === 0)
    throw new Error(l10n.t('No columns selected.'))

  assertExportLimits(view, format, columns)

  const ext = format === 'xlsx' ? 'xlsx' : 'csv'
  const saveUri = await window.showSaveDialog({
    title: l10n.t('Export data'),
    defaultUri: getExportDefaultUri(sourceUri, ext),
    filters: format === 'xlsx'
      ? { [l10n.t('Excel Workbook')]: ['xlsx'] }
      : { [l10n.t('CSV File')]: ['csv'] },
  })
  if (!saveUri)
    return null

  try {
    await window.withProgress({
      location: ProgressLocation.Notification,
      title: l10n.t('Export data'),
      cancellable: true,
    }, async (progress, token) => {
      const reportProgress = createExportProgressReporter(progress)
      const bytes = format === 'xlsx'
        ? await exportViewToXlsxAsync(view, columns, {
            onProgress: reportProgress,
            shouldCancel: () => token.isCancellationRequested,
          })
        : await exportViewToCsvAsync(view, columns, {
            onProgress: reportProgress,
            shouldCancel: () => token.isCancellationRequested,
          })

      if (token.isCancellationRequested)
        throw new DtaExportCancelledError()

      progress.report({ message: l10n.t('Writing file…') })
      await workspace.fs.writeFile(saveUri, bytes)
    })
  }
  catch (e) {
    if (isDtaExportCancelledError(e))
      return null
    throw e
  }

  void window.showInformationMessage(l10n.t(
    'Exported data to {0}',
    formatUriForDisplay(saveUri),
  ))
  return saveUri
}

/**
 * 导出变量字典，并返回实际保存的 URI；用户取消时返回 null。
 */
export async function exportVariableDictionary(options: ExportVariableDictionaryOptions): Promise<vscode.Uri | null> {
  const { sourceUri, entries, format } = options
  const columns = getVariableDictionaryExportColumns()

  assertRowsExportLimits(entries.length, columns.length, format)

  const ext = format === 'xlsx' ? 'xlsx' : 'csv'
  const saveUri = await window.showSaveDialog({
    title: l10n.t('Export variable dictionary'),
    defaultUri: getExportDefaultUri(sourceUri, ext, '.dictionary'),
    filters: format === 'xlsx'
      ? { [l10n.t('Excel Workbook')]: ['xlsx'] }
      : { [l10n.t('CSV File')]: ['csv'] },
  })
  if (!saveUri)
    return null

  try {
    await window.withProgress({
      location: ProgressLocation.Notification,
      title: l10n.t('Export variable dictionary'),
      cancellable: true,
    }, async (progress, token) => {
      const reportProgress = createExportProgressReporter(progress)
      const source = {
        columns,
        totalRows: entries.length,
        getRows: (offset: number, limit: number) => createVariableDictionaryRows(entries, offset, limit),
      }
      const bytes = format === 'xlsx'
        ? await exportRowsToXlsxAsync(source, {
            onProgress: reportProgress,
            shouldCancel: () => token.isCancellationRequested,
          })
        : await exportRowsToCsvAsync(source, {
            onProgress: reportProgress,
            shouldCancel: () => token.isCancellationRequested,
          })

      if (token.isCancellationRequested)
        throw new DtaExportCancelledError()

      progress.report({ message: l10n.t('Writing file…') })
      await workspace.fs.writeFile(saveUri, bytes)
    })
  }
  catch (e) {
    if (isDtaExportCancelledError(e))
      return null
    throw e
  }

  void window.showInformationMessage(l10n.t(
    'Exported variable dictionary to {0}',
    formatUriForDisplay(saveUri),
  ))
  return saveUri
}

/**
 * 生成 VS Code 进度通知回调。
 */
function createExportProgressReporter(
  progress: vscode.Progress<{ message?: string, increment?: number }>,
): (state: TableExportProgress) => void {
  let lastPercent = 0
  return (state) => {
    if (state.phase === 'packaging') {
      progress.report({ message: l10n.t('Packaging workbook…') })
      return
    }

    const percent = state.totalRows > 0
      ? Math.min(100, (state.processedRows / state.totalRows) * 100)
      : 100
    progress.report({
      increment: Math.max(0, percent - lastPercent),
      message: l10n.t(
        '{0}% · {1} / {2} rows',
        percent.toFixed(0),
        state.processedRows.toLocaleString(),
        state.totalRows.toLocaleString(),
      ),
    })
    lastPercent = percent
  }
}

/**
 * 检查目标格式的容量限制。
 */
function assertExportLimits(view: DtaView, format: TableExportFormat, columns: string[]): void {
  assertRowsExportLimits(view.totalFiltered, columns.length, format)
}

/**
 * 检查行源导出的容量限制。
 */
function assertRowsExportLimits(totalRows: number, columnCount: number, format: TableExportFormat): void {
  if (format !== 'xlsx')
    return

  if (totalRows + 1 > EXCEL_MAX_ROWS) {
    throw new Error(l10n.t(
      'Excel export supports up to {0} rows. Use CSV for larger datasets.',
      EXCEL_MAX_ROWS.toLocaleString(),
    ))
  }
  if (columnCount > EXCEL_MAX_COLUMNS) {
    throw new Error(l10n.t(
      'Excel export supports up to {0} columns. Use CSV for wider datasets.',
      EXCEL_MAX_COLUMNS.toLocaleString(),
    ))
  }
}

/**
 * 生成导出文件默认路径。
 */
function getExportDefaultUri(sourceUri: vscode.Uri, ext: string, suffix = ''): vscode.Uri | undefined {
  const sourcePath = sourceUri.scheme === 'file' ? sourceUri.fsPath : sourceUri.path
  const baseName = path.basename(sourcePath, path.extname(sourcePath)) || 'stata-data'
  const fileName = `${baseName}${suffix}.${ext}`

  if (sourceUri.scheme === 'file')
    return Uri.file(path.join(path.dirname(sourceUri.fsPath), fileName))

  const workspaceFolder = workspace.workspaceFolders?.[0]
  return workspaceFolder ? Uri.joinPath(workspaceFolder.uri, fileName) : undefined
}

/**
 * 格式化 URI 以便展示给用户。
 */
export function formatUriForDisplay(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.toString(true)
}

/**
 * 变量字典导出的表头。
 */
function getVariableDictionaryExportColumns(): string[] {
  return [
    l10n.t('Number'),
    l10n.t('Variable name'),
    l10n.t('Variable label'),
    l10n.t('Type'),
    l10n.t('Statistical type'),
    l10n.t('Valid N'),
    l10n.t('Missing'),
    l10n.t('Unique'),
  ]
}

/**
 * 将变量字典摘要转换为导出行。
 */
function createVariableDictionaryRows(
  entries: VariableDictionaryEntry[],
  offset: number,
  limit: number,
): unknown[][] {
  return entries.slice(offset, offset + limit).map(entry => [
    entry.index,
    entry.name,
    entry.label,
    entry.type,
    formatDictionaryStatType(entry.statType),
    entry.nValid,
    formatMissingSummary(entry.nMissing, entry.nValid),
    entry.nUnique,
  ])
}

/**
 * 导出变量字典时本地化统计类型。
 */
function formatDictionaryStatType(statType: VariableDictionaryEntry['statType']): string {
  if (statType === 'continuous')
    return l10n.t('Continuous')
  if (statType === 'discrete')
    return l10n.t('Discrete')
  return l10n.t('String')
}

/**
 * 格式化缺失数与缺失率。
 */
function formatMissingSummary(nMissing: number, nValid: number): string {
  const total = nMissing + nValid
  const pct = total > 0 ? (nMissing / total) * 100 : 0
  return l10n.t('{0} ({1}%)', nMissing.toLocaleString(), pct.toFixed(1))
}
