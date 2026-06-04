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

interface DtaFileInfo {
  fileName: string
  filePath: string
  fileSize: number
  lastModified: string
}

/**
 * Stata .dta 自定义只读编辑器
 */
export class DtaEditorProvider implements vscode.CustomReadonlyEditorProvider {
  /**
   * 注册自定义编辑器 Provider
   */
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new DtaEditorProvider(context)
    return vscode.window.registerCustomEditorProvider(DtaEditorProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
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
    let currentFileInfo: DtaFileInfo | null = null
    // 复用进行中的加载任务，避免并发消息触发重复解析。
    let loadingPromise: Promise<{ columnar: DtaColumnar, view: DtaView }> | null = null
    let webviewReady = false
    let webviewReadyResolve: (() => void) | null = null

    /**
     * 等待当前 Webview 脚本完成初始化。
     */
    const waitForWebviewReady = (): Promise<void> => {
      if (webviewReady)
        return Promise.resolve()
      return new Promise((resolve) => {
        let done = false
        const finish = () => {
          if (done)
            return
          done = true
          if (webviewReadyResolve === finish)
            webviewReadyResolve = null
          resolve()
        }
        webviewReadyResolve = finish
        setTimeout(finish, 3000)
      })
    }

    /**
     * 准备重新渲染 Webview HTML。
     */
    const prepareWebviewReload = (): Promise<void> => {
      webviewReady = false
      return waitForWebviewReady()
    }

    /**
     * 发送当前视图的初始页面。
     */
    const postInitData = (v: DtaView) => {
      this.postInitData(webviewPanel, v, currentFileInfo)
    }

    /**
     * 标记当前 Webview 已经注册消息监听。
     */
    const markWebviewReady = () => {
      webviewReady = true
      if (webviewReadyResolve) {
        webviewReadyResolve()
        return
      }
      // VS Code 可能在标签页切换时重建 webview。此时 HTML 回到初始
      // loading shell，但扩展侧已有缓存数据，需要主动补发一次 initData。
      if (columnar) {
        view = new DtaView(columnar)
        postInitData(view)
      }
    }

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

    /**
     * 重新读取数据并下发给现有 Webview，不重建 HTML。
     */
    const reloadData = async () => {
      currentFileInfo = await this.getFileInfo(document.uri)
      const { view: v } = await loadAll()
      postInitData(v)
    }

    // 文件变更后清空缓存并重新加载。
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(document.uri, '*'),
    )
    watcher.onDidChange(async () => {
      invalidate()
      webviewPanel.webview.postMessage({ command: 'showLoading' })
      try {
        await reloadData()
      }
      catch (e) {
        webviewPanel.webview.postMessage({
          command: 'loadError',
          error: String(e),
        })
      }
    })

    // Webview 消息入口：处理刷新、分页、排序、筛选和变量汇总。
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'ready') {
        markWebviewReady()
        return
      }
      try {
        if (message.command === 'refresh') {
          invalidate()
          webviewPanel.webview.postMessage({ command: 'showLoading' })
          await reloadData()
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

    void this.loadData(document.uri, webviewPanel, loadAll, prepareWebviewReload, (fileInfo) => {
      currentFileInfo = fileInfo
    })
      .catch((e) => {
        webviewPanel.webview.postMessage({
          command: 'loadError',
          error: String(e),
        })
      })
  }

  /**
   * 读取文件信息。
   */
  private async getFileInfo(uri: vscode.Uri): Promise<DtaFileInfo> {
    const stats = await vscode.workspace.fs.stat(uri)
    const lastModified = new Date(stats.mtime)
    const filePath = uri.scheme === 'file' ? uri.fsPath : uri.toString(true)
    return {
      fileName: path.basename(filePath),
      filePath,
      fileSize: stats.size,
      lastModified: lastModified.toLocaleString(),
    }
  }

  /**
   * 发送当前视图的初始页面。
   */
  private postInitData(
    webviewPanel: vscode.WebviewPanel,
    view: DtaView,
    fileInfo: DtaFileInfo | null,
  ) {
    const meta = view.meta
    const initialPage = view.getPage({ offset: 0, limit: DEFAULT_PAGE_SIZE })

    webviewPanel.webview.postMessage({
      command: 'initData',
      meta: {
        headers: meta.headers,
        labels: meta.labels,
        types: meta.types,
        nobs: meta.nobs,
        release: meta.release,
      },
      page: initialPage,
      fileInfo,
    })
  }

  /**
   * 初始化 Webview 并加载数据
   */
  private async loadData(
    uri: vscode.Uri,
    webviewPanel: vscode.WebviewPanel,
    loadAll: () => Promise<{ columnar: DtaColumnar, view: DtaView }>,
    prepareWebviewReload: () => Promise<void>,
    setCurrentFileInfo: (fileInfo: DtaFileInfo) => void,
  ) {
    const fileInfo = await this.getFileInfo(uri)
    setCurrentFileInfo(fileInfo)

    // 第一步：先渲染加载界面，再等待脚本注册消息监听。
    const webviewReadyPromise = prepareWebviewReload()
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, {
      ...fileInfo,
      pageSize: DEFAULT_PAGE_SIZE,
    })
    await webviewReadyPromise

    // 第二步：执行真实解析，并在完成后发送初始元数据和第一页数据。
    try {
      const { view } = await loadAll()
      this.postInitData(webviewPanel, view, fileInfo)
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
  private getHtmlForWebview(
    webview: vscode.Webview,
    initData: {
      fileName: string
      filePath: string
      fileSize: number
      lastModified: string
      pageSize: number
    },
  ): string {
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
          <!-- 主面板 -->
          <div id="main-panel">
            <!-- 工具栏 -->
            <div id="toolbar">
              <div id="toolbar-left">
                <div id="search-field">
                  <input id="search-input" type="text" placeholder="${l10n.t('Filter: e.g., edad > 30 & treatment == 1')}">
                  <span id="filter-error"></span>
                </div>
                <button id="search-apply" title="${l10n.t('Apply filter (or press Enter)')}">${l10n.t('Apply')}</button>
                <button id="search-clear" title="${l10n.t('Clear filter')}">${l10n.t('Clear')}</button>
              </div>
              <div id="toolbar-right">
                <button id="toggle-sidebar">${l10n.t('Toggle Sidebar')}</button>
                <button id="usage-guide" class="icon" title="${l10n.t('Usage guide')}">
                  <svg width="18" height="18" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0m9 4v.01"/>
                      <path d="M12 13a2 2 0 0 0 .914-3.782a1.98 1.98 0 0 0-2.414.483"/>
                    </g>
                  </svg>
                </button>
                <button id="refresh-data" class="icon" title="${l10n.t('Refresh data')}">
                  <svg width="18" height="18" viewBox="0 0 24 24">
                    <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4m-4 4a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>
                  </svg>
                </button>
                <button id="file-info" class="icon" title="${l10n.t('File information')}">
                  <svg width="18" height="18" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
                      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0m9-3h.01"/>
                      <path d="M11 12h1v4h1"/>
                    </g>
                  </svg>
                </button>
              </div>
            </div>

            <!-- 网格器 -->
            <div id="grid-wrapper">
              <div id="grid-container">
                <table id="data-table">
                  <thead id="table-head"></thead>
                  <tbody id="table-body"></tbody>
                </table>
              </div>
              <div id="grid-overlay" style="display: none">
                <div id="grid-overlay-message">${l10n.t('Computing…')}</div>
              </div>
            </div>

            <!-- 分页器 -->
            <div id="pagination">
              <div id="pagination-left">
                <button id="page-first" class="icon outline" title="${l10n.t('First page')}">
                  <svg width="16" height="16" viewBox="0 0 24 24">
                    <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m11 7l-5 5l5 5m6-10l-5 5l5 5"/>
                  </svg>
                </button>
                <button id="page-prev" class="icon outline" title="${l10n.t('Previous page')}">
                  <svg width="16" height="16" viewBox="0 0 24 24">
                    <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m15 6l-6 6l6 6"/>
                  </svg>
                </button>
                <span id="page-info">${l10n.t('Page {0} / {1}', 1, 1)}</span>
                <button id="page-next" class="icon outline" title="${l10n.t('Next page')}">
                  <svg width="16" height="16" viewBox="0 0 24 24">
                    <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 6l6 6l-6 6"/>
                  </svg>
                </button>
                <button id="page-last" class="icon outline" title="${l10n.t('Last page')}">
                  <svg width="16" height="16" viewBox="0 0 24 24">
                    <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m7 7l5 5l-5 5m6-10l5 5l-5 5"/>
                  </svg>
                </button>
                <span id="page-size-wrap">
                  ${l10n.t('Page size:')}
                  <select id="page-size" class="bordered">
                    <option value="1000" selected>1,000</option>
                    <option value="5000">5,000</option>
                    <option value="10000">10,000</option>
                    <option value="20000">20,000</option>
                  </select>
                </span>
              </div>
              <div id="pagination-right">
                <span id="page-summary"></span>
              </div>
            </div>
          </div>

          <!-- 调整手柄 -->
          <div id="resize-handle"></div>

          <!-- 侧边栏 -->
          <div id="sidebar">
            <div id="sidebar-header">
              <h3>${l10n.t('Variables')}</h3>
              <button id="sidebar-position" title="${l10n.t('Switch sidebar position')}">${l10n.t('Position')}</button>
            </div>
            <div id="sidebar-search">
              <input id="variable-search" type="text" placeholder="${l10n.t('Filter variables...')}">
            </div>
            <div id="variable-batch-actions">
              <button id="select-all-variables">${l10n.t('Select all')}</button>
              <button id="deselect-all-variables">${l10n.t('Deselect all')}</button>
            </div>
            <div id="variable-list"></div>
          </div>
        </div>

        <!-- 初始加载 -->
        <div id="initial-loading">
          <div id="initial-loading-card">
            <h2>${l10n.t('Loading dataset…')}</h2>
            <div id="progress-track">
              <div id="progress-fill" style="width: 0%"></div>
            </div>
            <div id="progress-text">${l10n.t('Reading file…')}</div>
          </div>
        </div>

        <!-- 文件信息弹窗 -->
        <div id="file-info-modal" class="modal">
          <div class="modal-content">
            <div class="modal-header">
              <h2>${l10n.t('File information')}</h2>
              <button id="close-file-info" class="icon">
                <svg width="18" height="18" viewBox="0 0 24 24">
                  <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
            <div id="file-info-body" class="modal-body"></div>
          </div>
        </div>

        <!-- 使用说明弹窗 -->
        <div id="usage-guide-modal" class="modal">
          <div class="modal-content">
            <div class="modal-header">
              <h2>${l10n.t('Usage guide')}</h2>
              <button id="close-usage-guide" class="icon">
                <svg width="18" height="18" viewBox="0 0 24 24">
                  <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
            <div id="usage-guide-body" class="modal-body">
              <section class="usage-section">
                <h3>${l10n.t('Filtering')}</h3>
                <div class="usage-subsection">
                  <h4>${l10n.t('Basic syntax')}</h4>
                  <ul>
                    <li>${l10n.t('Enter an expression in the filter box, then apply it to show matching rows.')}</li>
                    <li>${l10n.t('Use variable names directly, including Unicode names such as Chinese column names.')}</li>
                    <li>${l10n.t('Wrap string values in single or double quotes.')}</li>
                    <li>${l10n.t('Use parentheses to group conditions and control evaluation order.')}</li>
                  </ul>
                </div>
                <div class="usage-subsection">
                  <h4>${l10n.t('Operators and functions')}</h4>
                  <ul>
                    <li>${l10n.t('Supported comparisons: ==, !=, ~=, <, <=, >, >=.')}</li>
                    <li>${l10n.t('Combine conditions with &, |, !, or the words and, or, not.')}</li>
                    <li>${l10n.t('Use arithmetic operators +, -, *, /, and ^ in numeric filters.')}</li>
                    <li>${l10n.t('Use missing(), inlist(), and inrange() for missing values, sets, and inclusive ranges.')}</li>
                    <li>${l10n.t('Use contains(), strpos(), regexm(), lower(), upper(), trim(), and length() for string filters.')}</li>
                    <li>${l10n.t('Use year(), month(), and day() with Stata numeric dates/datetimes or parseable date strings.')}</li>
                  </ul>
                </div>
                <div class="usage-subsection">
                  <h4>${l10n.t('Filter examples')}</h4>
                  <div class="usage-example-groups">
                    <div class="usage-example-group">
                      <h5>${l10n.t('Numeric filters')}</h5>
                      <p>${l10n.t('Compare numbers directly or compute derived values before comparing.')}</p>
                      <div class="usage-examples">
                        <code>edad &gt; 30 &amp; treatment == 1</code>
                        <code>income / 10000 &gt; 5</code>
                      </div>
                    </div>
                    <div class="usage-example-group">
                      <h5>${l10n.t('Grouped conditions')}</h5>
                      <p>${l10n.t('Use parentheses when mixing AND and OR conditions.')}</p>
                      <div class="usage-examples">
                        <code>(year &gt;= 2020 &amp; year &lt;= 2024) | missing(year)</code>
                      </div>
                    </div>
                    <div class="usage-example-group">
                      <h5>${l10n.t('Missing values, sets, and ranges')}</h5>
                      <p>${l10n.t('Use helper functions for common categorical and interval checks.')}</p>
                      <div class="usage-examples">
                        <code>missing(score)</code>
                        <code>inlist(city, "昆明市", "大理市")</code>
                        <code>inrange(year, 2020, 2024)</code>
                      </div>
                    </div>
                    <div class="usage-example-group">
                      <h5>${l10n.t('String filters')}</h5>
                      <p>${l10n.t('Search text, normalize values, or match regular expressions.')}</p>
                      <div class="usage-examples">
                        <code>contains(城市名称, "市")</code>
                        <code>regexm(code, "^[0-9]+$")</code>
                        <code>lower(trim(name)) == "abc"</code>
                      </div>
                    </div>
                    <div class="usage-example-group">
                      <h5>${l10n.t('Date filters')}</h5>
                      <p>${l10n.t('Extract date parts from Stata numeric dates/datetimes or parseable date strings.')}</p>
                      <div class="usage-examples">
                        <code>year(date) == 2024</code>
                        <code>month(date) == 6 &amp; day(date) == 3</code>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
              <section class="usage-section">
                <h3>${l10n.t('Table')}</h3>
                <ul>
                  <li>${l10n.t('Click a column header to sort by that column.')}</li>
                  <li>${l10n.t('Hold Shift while clicking column headers to sort by multiple columns.')}</li>
                  <li>${l10n.t('Drag the handle on the right edge of a header to resize the column.')}</li>
                  <li>${l10n.t('Use the pager to move through rows and change the page size.')}</li>
                </ul>
              </section>
              <section class="usage-section">
                <h3>${l10n.t('Variables panel')}</h3>
                <ul>
                  <li>${l10n.t('Use checkboxes to show or hide columns without changing the data file.')}</li>
                  <li>${l10n.t('Search variable names to quickly find columns in wide datasets.')}</li>
                  <li>${l10n.t('Open variable statistics to inspect missing values, unique values, distributions, and numeric summaries.')}</li>
                  <li>${l10n.t('Variable statistics can inherit the table filter or use a temporary filter for that calculation.')}</li>
                </ul>
              </section>
              <section class="usage-section">
                <h3>${l10n.t('Data and file')}</h3>
                <ul>
                  <li>${l10n.t('Refresh data to re-read the current .dta file from disk.')}</li>
                  <li>${l10n.t('Open file information to view path, size, update time, Stata release, row count, and variable count.')}</li>
                </ul>
              </section>
            </div>
          </div>
        </div>

        <!-- 变量汇总弹窗 -->
        <div id="explorer-modal" class="modal">
          <div class="modal-content">
            <div class="modal-header">
              <h2 id="explorer-variable"></h2>
              <button id="close-explorer" class="icon">
                <svg width="18" height="18" viewBox="0 0 24 24">
                  <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
            <div id="explorer-body" class="modal-body"></div>
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
              FileName: l10n.t('File name'),
              FilePath: l10n.t('File path'),
              FileSize: l10n.t('File size'),
              LastUpdated: l10n.t('Last updated'),
              StataRelease: l10n.t('Stata release'),
              Rows: l10n.t('Rows'),
              VariablesCount: l10n.t('Variables'),
              Unknown: l10n.t('Unknown'),
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
