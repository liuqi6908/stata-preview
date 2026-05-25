import type { FilterSpec, SortSpec } from './dtaView'
import type { DtaColumnar } from './parser'
import { Buffer } from 'node:buffer'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { DtaView } from './dtaView'
import { compileFilter, FilterCompileError } from './filterCompiler'
import { DtaParser } from './parser'

const DEFAULT_PAGE_SIZE = 5000

export class DtaEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new DtaEditorProvider(context)
    return vscode.window.registerCustomEditorProvider(DtaEditorProvider.viewType, provider)
  }

  private static readonly viewType = 'stataPreview.dta'

  constructor(
    private readonly context: vscode.ExtensionContext,
  ) { }

  public async openCustomDocument(
    uri: vscode.Uri,
  ): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => { } }
  }

  public async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
    }

    // Per-document state. Note we do NOT keep the raw file buffer around:
    // it is only needed during parsing. After parseColumnarAsync builds the
    // columnar structures, nothing (filters, sort, paging, tabulate) reads
    // the raw bytes again, so holding it would waste ~1 file's worth of RAM
    // (e.g. ~1.6 GB for casen_2024.dta) for the lifetime of the tab.
    let columnar: DtaColumnar | null = null
    let view: DtaView | null = null
    let loadingPromise: Promise<{ columnar: DtaColumnar, view: DtaView }> | null = null

    const loadAll = async (): Promise<{ columnar: DtaColumnar, view: DtaView }> => {
      if (columnar && view)
        return { columnar, view }
      if (loadingPromise)
        return loadingPromise
      loadingPromise = (async () => {
        if (!columnar) {
          // Read the file only to parse it; the buffer is local and
          // becomes eligible for GC as soon as this scope exits.
          let buf: Buffer
          // vscode.workspace.fs.readFile marshals the whole file through
          // the extension-host RPC layer and effectively hangs on very
          // large files (>1 GB). Node fs reads the same file in <300ms.
          // For non-file schemes, fall back to the workspace FS API.
          if (document.uri.scheme === 'file') {
            buf = await fs.promises.readFile(document.uri.fsPath)
          }
          else {
            const fileData = await vscode.workspace.fs.readFile(document.uri)
            // Wrap without copying (avoids a full second copy of the buffer).
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
          // `buf` goes out of scope here -> the raw file bytes are freed.
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

    const invalidate = () => {
      columnar = null
      view = null
    }

    // File watcher
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(document.uri, '*'),
    )
    watcher.onDidChange(async () => {
      invalidate()
      webviewPanel.webview.postMessage({ command: 'showLoading' })
      await this.loadData(document.uri, webviewPanel, loadAll)
    })

    // Webview message handlers
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message.command === 'refresh') {
          invalidate()
          webviewPanel.webview.postMessage({ command: 'showLoading' })
          await this.loadData(document.uri, webviewPanel, loadAll)
        }
        else if (message.command === 'tabulate') {
          const { columnar, view: v } = await loadAll()
          // Two independent filters can apply:
          //   - inheritGeneral: combine with the table's general filter (view.indices)
          //   - explorerExpr: an ad-hoc expression scoped to this tabulation
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
        webviewPanel.webview.postMessage({
          command: 'error',
          requestId: message.requestId,
          error: String(e),
        })
      }
    })

    webviewPanel.onDidDispose(() => {
      watcher.dispose()
      invalidate()
    })

    await this.loadData(document.uri, webviewPanel, loadAll)
  }

  private async loadData(
    uri: vscode.Uri,
    webviewPanel: vscode.WebviewPanel,
    loadAll: () => Promise<{ columnar: DtaColumnar, view: DtaView }>,
  ) {
    const stats = await vscode.workspace.fs.stat(uri)
    const lastModified = new Date(stats.mtime)

    // Step 1: paint the loading screen immediately. The webview script wires up
    // its UI, listens for `loadProgress` updates, and asks for the dataset via
    // a `requestInit` postMessage when it's ready.
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, {
      lastModified: lastModified.toLocaleString(),
      pageSize: DEFAULT_PAGE_SIZE,
    })

    // Step 2: actually do the parse. Progress events are posted by `loadAll`
    // via the `onProgress` callback configured in resolveCustomEditor.
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

  private getHtmlForWebview(webview: vscode.Webview, initData: { lastModified: string, pageSize: number }): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'main.js')))
    const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'main.css')))

    return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet">
                <title>Stata Preview</title>
            </head>
            <body>
                <div id="layout-container">

                    <div id="main-panel">
                        <div id="toolbar">
                            <div class="search-container">
                                <input type="text" id="search" placeholder="Filter: e.g., edad > 30 & treatment == 1">
                                <button id="search-btn" class="btn-search" title="Apply filter (or press Enter)">Apply</button>
                                <button id="clear-filter-btn" class="btn-toggle" title="Clear filter">Clear</button>
                                <span id="filter-error" class="filter-error"></span>
                            </div>
                            <span id="stats">Rows: 0</span>
                            <button id="toggle-labels-btn" class="btn-toggle">Labels: OFF</button>
                            <button id="toggle-sidebar-btn" class="btn-toggle">Toggle Sidebar</button>
                            <div class="toolbar-right">
                                <button id="refresh-btn" class="btn-icon" title="Refresh data">
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                                        <path d="M13.65 2.35C12.2 0.9 10.21 0 8 0 3.58 0 0 3.58 0 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z"/>
                                    </svg>
                                </button>
                                <span id="last-updated">Last updated: ${escapeHtml(initData.lastModified)}</span>
                            </div>
                        </div>
                        <div id="grid-wrapper">
                            <table id="data-table">
                                <thead id="table-head"></thead>
                                <tbody id="table-body"></tbody>
                            </table>
                            <div id="grid-overlay" class="grid-overlay" style="display:none">
                                <div class="grid-overlay-msg">Computing…</div>
                            </div>
                        </div>
                        <div id="pagination-bar">
                            <button id="page-first" class="btn-page" title="First page">&laquo;</button>
                            <button id="page-prev" class="btn-page" title="Previous page">&lsaquo;</button>
                            <span id="page-info">Page 1 / 1</span>
                            <button id="page-next" class="btn-page" title="Next page">&rsaquo;</button>
                            <button id="page-last" class="btn-page" title="Last page">&raquo;</button>
                            <span class="page-size-wrap">
                                Page size:
                                <select id="page-size">
                                    <option value="1000">1,000</option>
                                    <option value="5000" selected>5,000</option>
                                    <option value="10000">10,000</option>
                                    <option value="25000">25,000</option>
                                </select>
                            </span>
                            <span id="page-summary"></span>
                        </div>
                    </div>

                    <div id="resize-handle"></div>

                    <div id="sidebar">
                        <div class="sidebar-header">
                            <h3>Variables</h3>
                            <button id="sidebar-position-btn" class="btn-toggle" title="Switch sidebar position">Position</button>
                        </div>
                        <div class="sidebar-search">
                             <input type="text" id="var-search" placeholder="Filter variables...">
                        </div>
                        <div class="var-bulk-actions">
                            <button id="select-all-vars" class="btn-bulk">Select all</button>
                            <button id="deselect-all-vars" class="btn-bulk">Deselect all</button>
                        </div>
                        <div id="var-list"></div>
                    </div>

                </div>

                <!-- Initial loading screen (covers the whole panel) -->
                <div id="initial-loading" class="initial-loading">
                    <div class="initial-loading-card">
                        <h2>Loading dataset…</h2>
                        <div class="progress-track">
                            <div id="progress-fill" class="progress-fill" style="width: 0%"></div>
                        </div>
                        <div id="progress-text" class="progress-text">Reading file…</div>
                    </div>
                </div>

                <!-- Variable Explorer Modal -->
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
                    const bootstrap = ${JSON.stringify(initData)};
                    const vscode = acquireVsCodeApi();
                </script>
                <script src="${scriptUri}"></script>
            </body>
            </html>`
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  } as { [k: string]: string })[c])
}
