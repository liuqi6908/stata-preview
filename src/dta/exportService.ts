/**
 * DTA 表格导出服务。
 *
 * 负责用户保存位置选择、Excel 尺寸限制校验、导出进度提示和文件写入。
 */

import type * as vscode from 'vscode'
import type { DtaView } from './dtaView'
import type { TableExportFormat } from './types'
import * as path from 'node:path'
import { l10n, ProgressLocation, Uri, window, workspace } from 'vscode'
import { EXCEL_MAX_COLUMNS, EXCEL_MAX_ROWS, exportViewToCsv, exportViewToXlsx } from './tableExporter'

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

  const bytes = await window.withProgress({
    location: ProgressLocation.Notification,
    title: l10n.t('Exporting data…'),
    cancellable: false,
  }, async () => {
    return format === 'xlsx'
      ? exportViewToXlsx(view, columns)
      : exportViewToCsv(view, columns)
  })

  await workspace.fs.writeFile(saveUri, bytes)
  void window.showInformationMessage(l10n.t(
    'Exported data to {0}',
    formatUriForDisplay(saveUri),
  ))
  return saveUri
}

/**
 * 检查目标格式的容量限制。
 */
function assertExportLimits(view: DtaView, format: TableExportFormat, columns: string[]): void {
  if (format !== 'xlsx')
    return

  if (view.totalFiltered + 1 > EXCEL_MAX_ROWS) {
    throw new Error(l10n.t(
      'Excel export supports up to {0} rows. Use CSV for larger datasets.',
      EXCEL_MAX_ROWS.toLocaleString(),
    ))
  }
  if (columns.length > EXCEL_MAX_COLUMNS) {
    throw new Error(l10n.t(
      'Excel export supports up to {0} columns. Use CSV for wider datasets.',
      EXCEL_MAX_COLUMNS.toLocaleString(),
    ))
  }
}

/**
 * 生成导出文件默认路径。
 */
function getExportDefaultUri(sourceUri: vscode.Uri, ext: string): vscode.Uri | undefined {
  const sourcePath = sourceUri.scheme === 'file' ? sourceUri.fsPath : sourceUri.path
  const baseName = path.basename(sourcePath, path.extname(sourcePath)) || 'stata-data'
  const fileName = `${baseName}.${ext}`

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
