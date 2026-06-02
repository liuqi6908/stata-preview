/**
 * .dta 自定义只读编辑器 Provider。
 *
 * 负责读取文件、构建列式数据视图，并通过 Webview 消息协议驱动表格分页、
 * 筛选、排序和变量汇总。
 */

import type { FilterSpec, SortSpec } from './dtaView'
import type { DtaColumnar } from './parser'
import { Buffer } from 'node:buffer'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { DtaView } from './dtaView'
import { compileFilter, FilterCompileError } from './filterCompiler'
import { DtaParser } from './parser'

const { l10n } = vscode

/** 默认分页大小 */
const DEFAULT_PAGE_SIZE = 1000

/**
 * Stata .dta 自定义只读编辑器
 */
export class DtaEditorProvider implements vscode.CustomReadonlyEditorProvider {
  /**
   * 注册自定义编辑器 Provider
   */
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new DtaEditorProvider(context)
    return vscode.window.registerCustomEditorProvider(DtaEditorProvider.viewType, provider)
  }

  private static readonly viewType = 'stataPreview.dta'

  constructor(
    /** VS Code 扩展上下文 */
    private readonly context: vscode.ExtensionContext,
  ) {}

  /**
   * 打开只读自定义文档
   */
  public async openCustomDocument(
    uri: vscode.Uri,
  ): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} }
  }

  /**
   * 创建并连接 Webview 编辑器
   */
  public async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
    }

    // 单文档状态。解析完成后不保留原始文件 Buffer：
    // 筛选、排序、分页和汇总都只依赖列式数据，长期持有原始字节会浪费整份文件大小的内存。
    let columnar: DtaColumnar | null = null
    let view: DtaView | null = null
    // 复用进行中的加载任务，避免并发消息触发重复解析。
    let loadingPromise: Promise<{ columnar: DtaColumnar, view: DtaView }> | null = null

    /**
     * 按需加载完整数据并创建视图
     */
    const loadAll = async (): Promise<{ columnar: DtaColumnar, view: DtaView }> => {
      if (columnar && view)
        return { columnar, view }
      if (loadingPromise)
        return loadingPromise
      loadingPromise = (async () => {
        if (!columnar) {
          // 仅为解析读取文件；离开当前作用域后 Buffer 即可被回收。
          let buf: Buffer
          // file scheme 使用 Node fs，避免大文件经过 extension-host RPC 带来的额外开销。
          // 非 file scheme 退回 workspace.fs。
          if (document.uri.scheme === 'file') {
            buf = await fs.promises.readFile(document.uri.fsPath)
          }
          else {
            const fileData = await vscode.workspace.fs.readFile(document.uri)
            // 复用底层 ArrayBuffer，避免再复制一份完整文件。
            buf = Buffer.from(fileData.buffer, fileData.byteOffset, fileData.byteLength)
          }
          columnar = await DtaParser.parseColumnarAsync(buf, {
            onProgress: (rowsRead, totalRows) => {
              webviewPanel.webview.postMessage({
                command: 'loadProgress',
                rowsRead,
                totalRows,
              })
            },
          })
          // buf 在这里离开作用域，原始文件字节可被释放。
        }
        if (!view)
          view = new DtaView(columnar)
        return { columnar: columnar!, view: view! }
      })()
      try {
        return await loadingPromise
      }
      finally {
        loadingPromise = null
      }
    }

    /**
     * 清空当前文档缓存
     */
    const invalidate = () => {
      columnar = null
      view = null
    }

    // 文件变更后清空缓存并重新加载。
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(document.uri, '*'),
    )
    watcher.onDidChange(async () => {
      invalidate()
      webviewPanel.webview.postMessage({ command: 'showLoading' })
      await this.loadData(document.uri, webviewPanel, loadAll)
    })

    // Webview 消息入口：处理刷新、分页、排序、筛选和变量汇总。
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message.command === 'refresh') {
          invalidate()
          webviewPanel.webview.postMessage({ command: 'showLoading' })
          await this.loadData(document.uri, webviewPanel, loadAll)
        }
        else if (message.command === 'tabulate') {
          const { columnar, view: v } = await loadAll()
          // 变量汇总可同时叠加两类过滤：
          //   - inheritGeneral：继承表格当前通用过滤；
          //   - explorerExpr：变量面板中的临时汇总过滤表达式。
          const inheritGeneral = !!message.inheritGeneral && v.hasFilter()
          const explorerExpr: string | undefined = message.explorerExpr
          let indices: Uint32Array | undefined
          try {
            if (explorerExpr && explorerExpr.trim().length > 0) {
              const fn = compileFilter(explorerExpr, columnar).fn
              const base = inheritGeneral ? v.getIndices() : null
              const out: number[] = []
              if (base) {
                for (let k = 0; k < base.length; k++) {
                  const i = base[k]
                  if (fn(i))
                    out.push(i)
                }
              }
              else {
                const N = columnar.meta.nobs
                for (let i = 0; i < N; i++) {
                  if (fn(i))
                    out.push(i)
                }
              }
              indices = Uint32Array.from(out)
            }
            else if (inheritGeneral) {
              indices = v.getIndices()
            }
          }
          catch (e) {
            const msg = e instanceof FilterCompileError ? e.message : String(e)
            webviewPanel.webview.postMessage({
              command: 'tabulateResult',
              requestId: message.requestId,
              error: msg,
              kind: 'filterError',
            })
            return
          }
          const result = DtaParser.tabulate(columnar, message.varName, indices)
          webviewPanel.webview.postMessage({
            command: 'tabulateResult',
            requestId: message.requestId,
            result,
            scopeN: indices ? indices.length : v.totalAll,
            usedExplorerFilter: !!(explorerExpr && explorerExpr.trim()),
            usedGeneralFilter: inheritGeneral,
          })
        }
        else if (message.command === 'getPage') {
          const { view: v } = await loadAll()
          const offset = Math.max(0, message.offset | 0)
          const limit = Math.max(1, Math.min(100000, message.limit | 0 || DEFAULT_PAGE_SIZE))
          const page = v.getPage({ offset, limit })
          webviewPanel.webview.postMessage({
            command: 'pageResult',
            requestId: message.requestId,
            page,
          })
        }
        else if (message.command === 'setSort') {
          const { view: v } = await loadAll()
          const spec: SortSpec[] = Array.isArray(message.spec) ? message.spec : []
          v.setSort(spec)
          webviewPanel.webview.postMessage({
            command: 'sortApplied',
            requestId: message.requestId,
            totalFiltered: v.totalFiltered,
          })
        }
        else if (message.command === 'setFilter') {
          const { view: v } = await loadAll()
          const spec: FilterSpec | null = message.spec || null
          try {
            v.setFilter(spec)
            webviewPanel.webview.postMessage({
              command: 'filterApplied',
              requestId: message.requestId,
              totalFiltered: v.totalFiltered,
            })
          }
          catch (e) {
            const msg = e instanceof FilterCompileError ? e.message : String(e)
            webviewPanel.webview.postMessage({
              command: 'filterError',
              requestId: message.requestId,
              error: msg,
            })
          }
        }
      }
      catch (e) {
        // 所有命令共享的兜底错误响应，避免 Webview 请求悬空。
        webviewPanel.webview.postMessage({
          command: 'error',
          requestId: message.requestId,
          error: String(e),
        })
      }
    })

    // 释放文件监听和文档缓存。
    webviewPanel.onDidDispose(() => {
      watcher.dispose()
      invalidate()
    })

    await this.loadData(document.uri, webviewPanel, loadAll)
  }

  /**
   * 初始化 Webview 并加载数据
   */
  private async loadData(
    uri: vscode.Uri,
    webviewPanel: vscode.WebviewPanel,
    loadAll: () => Promise<{ columnar: DtaColumnar, view: DtaView }>,
  ) {
    const stats = await vscode.workspace.fs.stat(uri)
    const lastModified = new Date(stats.mtime)

    // 第一步：先渲染加载界面，让 Webview 能接收后续进度消息。
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, {
      lastModified: lastModified.toLocaleString(),
      pageSize: DEFAULT_PAGE_SIZE,
    })

    // 第二步：执行真实解析，并在完成后发送初始元数据和第一页数据。
    try {
      const { view } = await loadAll()
      const meta = view.meta
      const initialPage = view.getPage({ offset: 0, limit: DEFAULT_PAGE_SIZE })

      webviewPanel.webview.postMessage({
        command: 'initData',
        meta: {
          headers: meta.headers,
          labels: meta.labels,
          types: meta.types,
          valueLabels: meta.valueLabels,
          nobs: meta.nobs,
          release: meta.release,
        },
        page: initialPage,
      })
    }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      webviewPanel.webview.postMessage({
        command: 'loadError',
        error: msg,
      })
    }
  }

  /**
   * 构建 Webview HTML
   */
  private getHtmlForWebview(webview: vscode.Webview, initData: { lastModified: string, pageSize: number }): string {
    // 将扩展资源路径转换为 Webview 可访问 URI。
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'main.js')))
    const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'main.css')))

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${styleUri}" rel="stylesheet">
        <title>${l10n.t('Stata Preview')}</title>
      </head>
      <body>
        <div id="layout-container">
          <div id="main-panel">
            <div id="toolbar">
              <div class="search-container">
                <input type="text" id="search" placeholder="${l10n.t('Filter: e.g., edad > 30 & treatment == 1')}">
                <button id="search-btn" class="btn-search" title="${l10n.t('Apply filter (or press Enter)')}">${l10n.t('Apply')}</button>
                <button id="clear-filter-btn" class="btn-toggle" title="${l10n.t('Clear filter')}">${l10n.t('Clear')}</button>
                <span id="filter-error" class="filter-error"></span>
              </div>
              <span id="stats">${l10n.t('Rows: {0}', 0)}</span>
              <button id="toggle-labels-btn" class="btn-toggle">${l10n.t('Labels: {0}', l10n.t('OFF'))}</button>
              <button id="toggle-sidebar-btn" class="btn-toggle">${l10n.t('Toggle Sidebar')}</button>
              <div class="toolbar-right">
                <button id="refresh-btn" class="btn-icon" title="${l10n.t('Refresh data')}">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M13.65 2.35C12.2 0.9 10.21 0 8 0 3.58 0 0 3.58 0 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z"/>
                  </svg>
                </button>
                <span id="last-updated">${l10n.t('Last updated: {0}', escapeHtml(initData.lastModified))}</span>
              </div>
            </div>
            <div id="grid-wrapper">
              <table id="data-table">
                <thead id="table-head"></thead>
                <tbody id="table-body"></tbody>
              </table>
              <div id="grid-overlay" class="grid-overlay" style="display:none">
                <div class="grid-overlay-msg">${l10n.t('Computing…')}</div>
              </div>
            </div>
            <div id="pagination-bar">
              <button id="page-first" class="btn-page" title="${l10n.t('First page')}">&laquo;</button>
              <button id="page-prev" class="btn-page" title="${l10n.t('Previous page')}">&lsaquo;</button>
              <span id="page-info">${l10n.t('Page {0} / {1}', 1, 1)}</span>
              <button id="page-next" class="btn-page" title="${l10n.t('Next page')}">&rsaquo;</button>
              <button id="page-last" class="btn-page" title="${l10n.t('Last page')}">&raquo;</button>
              <span class="page-size-wrap">
                ${l10n.t('Page size:')}
                <select id="page-size">
                  <option value="1000" selected>1,000</option>
                  <option value="5000">5,000</option>
                  <option value="10000">10,000</option>
                  <option value="20000">20,000</option>
                </select>
              </span>
              <span id="page-summary"></span>
            </div>
          </div>

          <div id="resize-handle"></div>

          <div id="sidebar">
            <div class="sidebar-header">
              <h3>${l10n.t('Variables')}</h3>
              <button id="sidebar-position-btn" class="btn-toggle" title="${l10n.t('Switch sidebar position')}">${l10n.t('Position')}</button>
            </div>
            <div class="sidebar-search">
              <input type="text" id="var-search" placeholder="${l10n.t('Filter variables...')}">
            </div>
            <div class="var-bulk-actions">
              <button id="select-all-vars" class="btn-bulk">${l10n.t('Select all')}</button>
              <button id="deselect-all-vars" class="btn-bulk">${l10n.t('Deselect all')}</button>
            </div>
            <div id="var-list"></div>
          </div>
        </div>

        <!-- 初始加载界面 -->
        <div id="initial-loading" class="initial-loading">
          <div class="initial-loading-card">
            <h2>${l10n.t('Loading dataset…')}</h2>
            <div class="progress-track">
              <div id="progress-fill" class="progress-fill" style="width: 0%"></div>
            </div>
            <div id="progress-text" class="progress-text">${l10n.t('Reading file…')}</div>
          </div>
        </div>

        <!-- 变量汇总弹窗 -->
        <div id="explorer-modal" class="modal">
          <div class="modal-content">
            <div class="modal-header">
              <h2 id="explorer-var-name"></h2>
              <button id="close-explorer" class="btn-close">&times;</button>
            </div>
            <div class="modal-body" id="explorer-body"></div>
          </div>
        </div>

        <script>
          const bootstrap = ${JSON.stringify({
            ...initData,
            l10n: {
              readingFile: l10n.t('Reading file…'),
              LoadingRowsProgress: l10n.t('Loading rows: {0} / {1} ({2}%)'),
              couldNotOpenFile: l10n.t('Could not open file'),
              Explore: l10n.t('Explore'),
              loadingPage: l10n.t('Loading page…'),
              applyingFilter: l10n.t('Applying filter…'),
              sorting: l10n.t('Sorting…'),
              filterForTabulationPlaceholder: l10n.t('Filter for this tabulation, e.g. edad == 30 & treatment == 1'),
              combineWithGeneralFilter: l10n.t('Combine with general filter'),
              TabulatingScope: l10n.t('Tabulating {0} of {1} rows.'),
              Apply: l10n.t('Apply'),
              Clear: l10n.t('Clear'),
              FilterError: l10n.t('Filter error'),
              PageInfo: l10n.t('Page {0} / {1}'),
              PageSummaryAll: l10n.t('Showing {0}-{1} of {2}'),
              PageSummaryFiltered: l10n.t('Showing {0}-{1} of {2} filtered (of {3} total)'),
              RowsSummary: l10n.t('Rows: {0}'),
              LabelsToggle: l10n.t('Labels: {0}'),
              ON: l10n.t('ON'),
              OFF: l10n.t('OFF'),
              ValueTitle: l10n.t('Value: {0}'),
              Computing: l10n.t('Computing…'),
              FixFilterToComputeResults: l10n.t('Fix the filter to compute results.'),
              ErrorPrefix: l10n.t('Error:'),
              GeneralFilterNote: l10n.t('(general filter: {0} / {1} rows)'),
              NoGeneralFilterActive: l10n.t('(no general filter active)'),
              General: l10n.t('General'),
              ValidN: l10n.t('Valid N'),
              Missing: l10n.t('Missing'),
              Unique: l10n.t('Unique'),
              Discrete: l10n.t('Discrete'),
              Continuous: l10n.t('Continuous'),
              StringType: l10n.t('String'),
              FrequencyDistribution: l10n.t('Frequency Distribution'),
              Value: l10n.t('Value'),
              Label: l10n.t('Label'),
              Freq: l10n.t('Freq'),
              Percent: l10n.t('%'),
              CumPercent: l10n.t('Cum %'),
              Bar: l10n.t('Bar'),
              DescriptiveStatistics: l10n.t('Descriptive Statistics'),
              Mean: l10n.t('Mean'),
              StdDev: l10n.t('Std Dev'),
              Min: l10n.t('Min'),
              Max: l10n.t('Max'),
              Percentiles: l10n.t('Percentiles'),
              Median: l10n.t('Median'),
              DistributionPerValue: l10n.t('Distribution (per value)'),
              Histogram: l10n.t('Histogram'),
              ValueCountTitle: l10n.t('{0}  n={1}'),
              HistogramBinCountTitle: l10n.t('[{0}, {1})  n={2}'),
              Top10Values: l10n.t('Top 10 Values'),
              NoData: l10n.t('No data'),
            },
          })};
          const vscode = acquireVsCodeApi();
        </script>
        <script src="${scriptUri}"></script>
      </body>
      </html>`
  }
}

/**
 * 转义 HTML 文本
 */
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  } as { [k: string]: string })[c])
}
