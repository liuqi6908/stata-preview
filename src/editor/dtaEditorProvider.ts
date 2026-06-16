/**
 * .dta 自定义只读编辑器 Provider。
 *
 * Provider 只处理 VS Code/Webview 生命周期和消息路由；
 * DTA 文件读取、查询、汇总和导出分别交给 dta/ 与 webview/ 模块。
 */

import type { DtaFileInfo } from '../dta/documentSession'
import type { DtaView } from '../dta/dtaView'
import type { FilterSpec, SortSpec, TableExportFormat } from '../dta/types'
import * as vscode from 'vscode'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants'
import { DtaDocumentSession, isStaleDtaLoadError } from '../dta/documentSession'
import { isStaleDtaViewUpdateError } from '../dta/dtaView'
import { exportDtaView, exportVariableDictionary, formatUriForDisplay } from '../dta/exportService'
import { FilterCompileError } from '../dta/filterCompiler'
import { renderDtaWebviewHtml } from '../webview/html'

// ---------- 工具函数 ----------

/**
 * 将未知错误转换为可展示文本
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 过期的加载或视图计算都已被更新请求取代，不需要向用户展示
 */
function isStaleDtaWorkError(error: unknown): boolean {
  return isStaleDtaLoadError(error) || isStaleDtaViewUpdateError(error)
}

/**
 * 生成当前文档对应的精确文件监听模式
 */
function createDocumentFilePattern(uri: vscode.Uri): vscode.RelativePattern {
  return new vscode.RelativePattern(parentUri(uri), escapeGlobSegment(uriBasename(uri)))
}

/**
 * 获取 URI 的父目录
 */
function parentUri(uri: vscode.Uri): vscode.Uri {
  const path = uri.path.replace(/\/+$/, '')
  const slash = path.lastIndexOf('/')
  const parentPath = slash <= 0 ? '/' : path.slice(0, slash)
  return uri.with({ path: parentPath })
}

/**
 * 获取 URI 的文件名
 */
function uriBasename(uri: vscode.Uri): string {
  const path = uri.path.replace(/\/+$/, '')
  const slash = path.lastIndexOf('/')
  return slash >= 0 ? path.slice(slash + 1) : path
}

/**
 * 将文件名转成单段 glob 字面量，避免特殊字符被当成通配符
 */
function escapeGlobSegment(segment: string): string {
  return segment.replace(/[*?[\]{}]/g, char => `[${char}]`)
}

/**
 * 发送加载错误；过期任务会被更新请求取代，不需要展示
 */
function postLoadError(webviewPanel: vscode.WebviewPanel, error: unknown): void {
  if (isStaleDtaWorkError(error))
    return
  webviewPanel.webview.postMessage({
    command: 'loadError',
    error: errorMessage(error),
  })
}

// ---------- Provider ----------

/**
 * Stata .dta 自定义只读编辑器
 */
export class DtaEditorProvider implements vscode.CustomReadonlyEditorProvider {
  // ---------- 注册 ----------

  /** 自定义编辑器 viewType，需要与 package.json contributes.customEditors 对齐 */
  private static readonly viewType = 'stataPreview.dta'

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

  // ---------- 初始化 ----------

  constructor(
    /** VS Code 扩展上下文，用于定位 media 资源 */
    private readonly context: vscode.ExtensionContext,
  ) {}

  // ---------- Webview 生命周期 ----------

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
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media'),
      ],
    }

    const session = new DtaDocumentSession(document.uri)
    let webviewReady = false
    let webviewReadyResolve: (() => void) | null = null

    /**
     * 等待当前 Webview 脚本完成初始化
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
     * 准备重新渲染 Webview HTML
     */
    const prepareWebviewReload = (): Promise<void> => {
      webviewReady = false
      return waitForWebviewReady()
    }

    /**
     * 发送当前视图的初始页面
     */
    const postInitData = (view: DtaView) => {
      this.postInitData(webviewPanel, view, session.fileInfo)
    }

    /**
     * 标记当前 Webview 已经注册消息监听
     */
    const markWebviewReady = () => {
      webviewReady = true
      if (webviewReadyResolve) {
        webviewReadyResolve()
        return
      }

      // VS Code 可能在标签页切换时重建 webview。扩展侧已有数据时，
      // 主动补发 initData，让新脚本恢复页面
      if (session.hasLoadedData) {
        void session.getView()
          .then(postInitData)
          .catch((e) => {
            postLoadError(webviewPanel, e)
          })
      }
    }

    /**
     * 重新读取数据并下发给现有 Webview，不重建 HTML
     */
    const reloadData = async () => {
      const { view } = await session.reload((rowsRead, totalRows) => {
        webviewPanel.webview.postMessage({
          command: 'loadProgress',
          rowsRead,
          totalRows,
        })
      })
      postInitData(view)
    }

    // 文件变更后清空缓存并重新加载
    const watcher = vscode.workspace.createFileSystemWatcher(
      createDocumentFilePattern(document.uri),
    )
    const reloadChangedFile = async () => {
      try {
        if (!await session.hasFileContentChanged())
          return

        webviewPanel.webview.postMessage({ command: 'showLoading' })
        await reloadData()
      }
      catch (e) {
        postLoadError(webviewPanel, e)
      }
    }
    watcher.onDidChange(reloadChangedFile)
    watcher.onDidCreate(reloadChangedFile)

    // Webview 消息入口：处理刷新、分页、排序、筛选、变量统计、变量字典和导出
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'ready') {
        markWebviewReady()
        return
      }

      try {
        if (message.command === 'refresh') {
          webviewPanel.webview.postMessage({ command: 'showLoading' })
          await reloadData()
        }
        else if (message.command === 'tabulate') {
          await this.handleTabulateMessage(webviewPanel, session, message)
        }
        else if (message.command === 'getVariableDictionary') {
          const entries = await session.getVariableDictionary()
          webviewPanel.webview.postMessage({
            command: 'variableDictionaryResult',
            requestId: message.requestId,
            entries,
          })
        }
        else if (message.command === 'getPage') {
          const { offset, limit } = this.normalizePageRequest(message)
          const page = await session.getPage(offset, limit)
          webviewPanel.webview.postMessage({
            command: 'pageResult',
            requestId: message.requestId,
            page,
          })
        }
        else if (message.command === 'setSort') {
          const spec: SortSpec[] = Array.isArray(message.spec) ? message.spec : []
          const view = await session.setSort(spec)
          webviewPanel.webview.postMessage({
            command: 'sortApplied',
            requestId: message.requestId,
            totalFiltered: view.totalFiltered,
          })
        }
        else if (message.command === 'setFilter') {
          await this.handleFilterMessage(webviewPanel, session, message)
        }
        else if (message.command === 'exportData') {
          await this.handleExportMessage(document.uri, webviewPanel, session, message)
        }
        else if (message.command === 'exportVariableDictionary') {
          await this.handleExportVariableDictionaryMessage(document.uri, webviewPanel, session, message)
        }
      }
      catch (e) {
        if (isStaleDtaWorkError(e)) {
          if (message.requestId) {
            webviewPanel.webview.postMessage({
              command: 'error',
              requestId: message.requestId,
              error: errorMessage(e),
              stale: true,
            })
          }
          return
        }

        // 所有命令共享的兜底错误响应，避免 Webview 请求悬空
        const msg = errorMessage(e)
        if (message.command === 'exportData' || message.command === 'exportVariableDictionary')
          void vscode.window.showErrorMessage(msg)
        webviewPanel.webview.postMessage({
          command: 'error',
          requestId: message.requestId,
          error: msg,
        })
      }
    })

    // 释放文件监听和文档缓存
    webviewPanel.onDidDispose(() => {
      watcher.dispose()
      session.invalidate()
    })

    void this.loadData(session, webviewPanel, prepareWebviewReload)
      .catch((e) => {
        postLoadError(webviewPanel, e)
      })
  }

  // ---------- Webview 消息 ----------

  /**
   * 处理变量统计消息
   */
  private async handleTabulateMessage(
    webviewPanel: vscode.WebviewPanel,
    session: DtaDocumentSession,
    message: any,
  ): Promise<void> {
    try {
      const response = await session.tabulate({
        varName: message.varName,
        explorerExpr: message.explorerExpr,
        inheritGeneral: !!message.inheritGeneral,
      })
      webviewPanel.webview.postMessage({
        command: 'tabulateResult',
        requestId: message.requestId,
        ...response,
      })
    }
    catch (e) {
      if (!(e instanceof FilterCompileError))
        throw e
      webviewPanel.webview.postMessage({
        command: 'tabulateResult',
        requestId: message.requestId,
        error: e.message,
        kind: 'filterError',
      })
    }
  }

  /**
   * 处理通用筛选消息
   */
  private async handleFilterMessage(
    webviewPanel: vscode.WebviewPanel,
    session: DtaDocumentSession,
    message: any,
  ): Promise<void> {
    const spec: FilterSpec | null = message.spec || null
    try {
      const view = await session.setFilter(spec)
      webviewPanel.webview.postMessage({
        command: 'filterApplied',
        requestId: message.requestId,
        totalFiltered: view.totalFiltered,
      })
    }
    catch (e) {
      if (isStaleDtaWorkError(e))
        throw e
      const msg = e instanceof FilterCompileError ? e.message : errorMessage(e)
      webviewPanel.webview.postMessage({
        command: 'filterError',
        requestId: message.requestId,
        error: msg,
      })
    }
  }

  /**
   * 处理导出消息
   */
  private async handleExportMessage(
    sourceUri: vscode.Uri,
    webviewPanel: vscode.WebviewPanel,
    session: DtaDocumentSession,
    message: any,
  ): Promise<void> {
    const view = await session.getView()
    const format = this.normalizeExportFormat(message.format)
    const columns = this.resolveExportColumns(view, message.columns)

    const savedUri = await exportDtaView({
      sourceUri,
      view,
      format,
      columns,
    })
    webviewPanel.webview.postMessage({
      command: 'exportResult',
      requestId: message.requestId,
      cancelled: !savedUri,
      path: savedUri ? formatUriForDisplay(savedUri) : null,
    })
  }

  /**
   * 处理变量字典导出消息
   */
  private async handleExportVariableDictionaryMessage(
    sourceUri: vscode.Uri,
    webviewPanel: vscode.WebviewPanel,
    session: DtaDocumentSession,
    message: any,
  ): Promise<void> {
    const entries = await session.getVariableDictionary()
    const format = this.normalizeExportFormat(message.format)

    const savedUri = await exportVariableDictionary({
      sourceUri,
      entries,
      format,
    })
    webviewPanel.webview.postMessage({
      command: 'exportResult',
      requestId: message.requestId,
      cancelled: !savedUri,
      path: savedUri ? formatUriForDisplay(savedUri) : null,
    })
  }

  /**
   * 标准化分页请求参数
   */
  private normalizePageRequest(message: any): { offset: number, limit: number } {
    return {
      offset: Math.max(0, message.offset | 0),
      limit: Math.max(1, Math.min(MAX_PAGE_SIZE, message.limit | 0 || DEFAULT_PAGE_SIZE)),
    }
  }

  /**
   * 标准化导出格式
   */
  private normalizeExportFormat(format: unknown): TableExportFormat {
    return format === 'xlsx' ? 'xlsx' : 'csv'
  }

  /**
   * 从 Webview 传入列名中筛出当前视图可导出的列
   */
  private resolveExportColumns(view: DtaView, columns: unknown): string[] {
    if (!Array.isArray(columns))
      return view.meta.headers

    const validHeaders = new Set(view.meta.headers)
    return columns.filter((column): column is string => typeof column === 'string' && validHeaders.has(column))
  }

  // ---------- 初始化数据 ----------

  /**
   * 发送当前视图的初始页面
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
        valueLabels: meta.valueLabels,
        nobs: meta.nobs,
        release: meta.release,
        byteOrder: meta.byteOrder,
      },
      page: initialPage,
      fileInfo,
    })
  }

  /**
   * 初始化 Webview 并加载数据
   */
  private async loadData(
    session: DtaDocumentSession,
    webviewPanel: vscode.WebviewPanel,
    prepareWebviewReload: () => Promise<void>,
  ) {
    const fileInfo = await session.refreshFileInfo()

    // 第一步：先渲染加载界面，再等待脚本注册消息监听
    const webviewReadyPromise = prepareWebviewReload()
    webviewPanel.webview.html = renderDtaWebviewHtml({
      webview: webviewPanel.webview,
      extensionUri: this.context.extensionUri,
      initData: {
        ...fileInfo,
        pageSize: DEFAULT_PAGE_SIZE,
      },
    })
    await webviewReadyPromise

    // 第二步：执行真实解析，并在完成后发送初始元数据和第一页数据
    try {
      const { view } = await session.loadAll((rowsRead, totalRows) => {
        webviewPanel.webview.postMessage({
          command: 'loadProgress',
          rowsRead,
          totalRows,
        })
      })
      this.postInitData(webviewPanel, view, fileInfo)
    }
    catch (e) {
      postLoadError(webviewPanel, e)
    }
  }
}
