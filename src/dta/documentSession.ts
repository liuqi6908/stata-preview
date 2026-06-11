/**
 * DTA 文档会话。
 *
 * 每个打开的 .dta Webview 对应一个会话，负责：
 *   - 读取文件与文件信息；
 *   - 缓存列式数据和查询视图；
 *   - 执行筛选、排序、分页；
 *   - 组合变量汇总的通用筛选与临时筛选。
 */

import type { DtaColumnar, FilterSpec, PageResult, SortSpec, TabulateResult, VariableDictionaryEntry } from './types'
import { Buffer } from 'node:buffer'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { DtaView } from './dtaView'
import { compileFilter } from './filterCompiler'
import { DtaParser } from './parser'
import { buildVariableDictionaryAsync, tabulateColumnar } from './tabulator'

/** 文件信息弹窗和 Webview 初始化所需的文件元数据。 */
export interface DtaFileInfo {
  /** 文件名。 */
  fileName: string
  /** 本地路径或远程 URI。 */
  filePath: string
  /** 文件大小，单位字节。 */
  fileSize: number
  /** 本地化后的最后修改时间。 */
  lastModified: string
}

/** 用于判断文件内容是否可能变化的轻量签名。 */
interface DtaFileSignature {
  /** 文件大小，单位字节。 */
  size: number
  /** 文件最后修改时间戳。 */
  mtime: number
}

/** 文件解析进度回调。 */
export type LoadProgressReporter = (rowsRead: number, totalRows: number) => void

/** 完整加载后的数据与查询视图。 */
export interface LoadedDtaDocument {
  /** 列式数据集。 */
  columnar: DtaColumnar
  /** 基于列式数据的有状态查询视图。 */
  view: DtaView
}

/** 变量汇总请求。 */
export interface TabulateRequest {
  /** 需要汇总的变量名。 */
  varName: string
  /** 是否继承表格当前通用过滤。 */
  inheritGeneral: boolean
  /** 变量汇总弹窗中的临时过滤表达式。 */
  explorerExpr?: string
}

/** 变量汇总结果及本次使用的范围信息。 */
export interface TabulateResponse {
  /** 汇总统计结果。 */
  result: TabulateResult
  /** 本次实际参与汇总的行数。 */
  scopeN: number
  /** 是否使用了变量汇总临时过滤。 */
  usedExplorerFilter: boolean
  /** 是否继承了表格通用过滤。 */
  usedGeneralFilter: boolean
}

/**
 * 某次加载已经被更新的刷新请求取代。
 */
export class StaleDtaLoadError extends Error {
  constructor() {
    super('数据加载已被新的刷新请求取代。')
  }
}

/**
 * 判断错误是否来自过期加载。
 */
export function isStaleDtaLoadError(error: unknown): error is StaleDtaLoadError {
  return error instanceof StaleDtaLoadError
}

/**
 * 单个 DTA 文件的解析和查询会话。
 */
export class DtaDocumentSession {
  /** 已解析的列式数据。 */
  private columnar: DtaColumnar | null = null
  /** 当前查询视图。 */
  private view: DtaView | null = null
  /** 缓存后的变量字典摘要。 */
  private variableDictionary: VariableDictionaryEntry[] | null = null
  /** 正在构建的变量字典任务，用于合并并发请求。 */
  private variableDictionaryPromise: Promise<VariableDictionaryEntry[]> | null = null
  /** 正在进行的加载任务，用于合并并发请求。 */
  private loadingPromise: Promise<LoadedDtaDocument> | null = null
  /** 最近一次读取到的文件信息。 */
  private currentFileInfo: DtaFileInfo | null = null
  /** 最近一次读取到的文件内容签名。 */
  private currentFileSignature: DtaFileSignature | null = null
  /** 加载世代号，刷新时递增，用于识别已经过期的解析任务。 */
  private loadGeneration = 0

  constructor(
    /** 当前自定义编辑器打开的文档 URI。 */
    private readonly uri: vscode.Uri,
  ) {}

  /**
   * 当前缓存的文件信息。
   */
  public get fileInfo(): DtaFileInfo | null {
    return this.currentFileInfo
  }

  /**
   * 是否已经解析并缓存了列式数据。
   */
  public get hasLoadedData(): boolean {
    return this.columnar !== null
  }

  /**
   * 清空解析缓存。
   *
   * 文件发生变化或用户手动刷新时调用，下一次访问会重新读取文件。
   */
  public invalidate(): void {
    this.loadGeneration++
    this.columnar = null
    this.view = null
    this.variableDictionary = null
    this.variableDictionaryPromise = null
    this.loadingPromise = null
  }

  /**
   * 读取并缓存当前文件信息。
   */
  public async refreshFileInfo(): Promise<DtaFileInfo> {
    const { info, signature } = await this.readFileInfo()
    this.currentFileInfo = info
    this.currentFileSignature = signature
    return this.currentFileInfo
  }

  /**
   * 文件内容是否可能已经变化。
   *
   * macOS/Finder 有时会触发非内容变化的文件事件；这里用大小和 mtime
   * 过滤掉这类噪声，避免仅聚焦/失焦文件就重新解析数据。
   */
  public async hasFileContentChanged(): Promise<boolean> {
    if (!this.currentFileSignature)
      return true

    const signature = await this.readFileSignature()
    return signature.size !== this.currentFileSignature.size
      || signature.mtime !== this.currentFileSignature.mtime
  }

  /**
   * 按需加载完整数据并创建查询视图。
   */
  public async loadAll(onProgress?: LoadProgressReporter): Promise<LoadedDtaDocument> {
    if (this.columnar && this.view)
      return { columnar: this.columnar, view: this.view }
    if (this.loadingPromise)
      return this.loadingPromise

    const generation = this.loadGeneration
    const loadingPromise = (async () => {
      let columnar = this.columnar
      if (!columnar) {
        const buf = await this.readFileBuffer()
        columnar = await DtaParser.parseColumnarAsync(buf, { onProgress })
        this.assertFreshLoad(generation)
        this.columnar = columnar
      }
      this.assertFreshLoad(generation)

      let view = this.view
      if (!view) {
        view = new DtaView(columnar)
        this.assertFreshLoad(generation)
        this.view = view
      }
      return { columnar, view }
    })()
    this.loadingPromise = loadingPromise

    try {
      return await loadingPromise
    }
    finally {
      if (this.loadingPromise === loadingPromise)
        this.loadingPromise = null
    }
  }

  /**
   * 重新读取文件信息和完整数据。
   */
  public async reload(onProgress?: LoadProgressReporter): Promise<LoadedDtaDocument> {
    this.invalidate()
    await this.refreshFileInfo()
    return this.loadAll(onProgress)
  }

  /**
   * 获取指定范围的数据页。
   */
  public async getPage(offset: number, limit: number): Promise<PageResult> {
    const { view } = await this.loadAll()
    return view.getPage({ offset, limit })
  }

  /**
   * 设置排序配置。
   */
  public async setSort(spec: SortSpec[]): Promise<DtaView> {
    const { view } = await this.loadAll()
    await view.setSortAsync(spec)
    return view
  }

  /**
   * 设置通用筛选配置。
   */
  public async setFilter(spec: FilterSpec | null): Promise<DtaView> {
    const { view } = await this.loadAll()
    await view.setFilterAsync(spec)
    return view
  }

  /**
   * 获取当前查询视图。
   */
  public async getView(): Promise<DtaView> {
    const { view } = await this.loadAll()
    return view
  }

  /**
   * 汇总单个变量，可叠加通用筛选和变量汇总临时筛选。
   */
  public async tabulate(req: TabulateRequest): Promise<TabulateResponse> {
    const { columnar, view } = await this.loadAll()
    const inheritGeneral = req.inheritGeneral && view.hasFilter()
    const explorerExpr = req.explorerExpr
    let indices: Uint32Array | undefined

    if (explorerExpr && explorerExpr.trim().length > 0) {
      const fn = compileFilter(explorerExpr, columnar).fn
      const base = inheritGeneral ? view.getIndices() : null
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
      indices = view.getIndices()
    }

    return {
      result: tabulateColumnar(columnar, req.varName, indices),
      scopeN: indices ? indices.length : view.totalAll,
      usedExplorerFilter: !!(explorerExpr && explorerExpr.trim()),
      usedGeneralFilter: inheritGeneral,
    }
  }

  /**
   * 获取完整变量字典摘要。
   */
  public async getVariableDictionary(): Promise<VariableDictionaryEntry[]> {
    if (this.variableDictionary)
      return this.variableDictionary
    if (this.variableDictionaryPromise)
      return this.variableDictionaryPromise

    const generation = this.loadGeneration
    const { columnar } = await this.loadAll()
    this.assertFreshLoad(generation)

    const dictionaryPromise = buildVariableDictionaryAsync(columnar, {
      checkCancelled: () => this.assertFreshLoad(generation),
    }).then((entries) => {
      this.assertFreshLoad(generation)
      this.variableDictionary = entries
      return entries
    })
    this.variableDictionaryPromise = dictionaryPromise

    try {
      return await dictionaryPromise
    }
    finally {
      if (this.variableDictionaryPromise === dictionaryPromise)
        this.variableDictionaryPromise = null
    }
  }

  /**
   * 读取文件基础信息。
   */
  private async readFileInfo(): Promise<{ info: DtaFileInfo, signature: DtaFileSignature }> {
    const stats = await this.statFile()
    const lastModified = new Date(stats.mtime)
    const filePath = this.uri.scheme === 'file' ? this.uri.fsPath : this.uri.toString(true)
    return {
      info: {
        fileName: path.basename(filePath),
        filePath,
        fileSize: stats.size,
        lastModified: lastModified.toLocaleString(),
      },
      signature: {
        size: stats.size,
        mtime: stats.mtime,
      },
    }
  }

  /**
   * 读取文件内容签名。
   */
  private async readFileSignature(): Promise<DtaFileSignature> {
    const stats = await this.statFile()
    return {
      size: stats.size,
      mtime: stats.mtime,
    }
  }

  /**
   * 读取文件 stat 信息。
   */
  private async statFile(): Promise<vscode.FileStat> {
    return vscode.workspace.fs.stat(this.uri)
  }

  /**
   * 读取原始文件字节。
   *
   * file scheme 直接走 Node fs，避免大文件通过 extension-host RPC 产生额外复制。
   */
  private async readFileBuffer(): Promise<Buffer> {
    if (this.uri.scheme === 'file')
      return fs.promises.readFile(this.uri.fsPath)

    const fileData = await vscode.workspace.fs.readFile(this.uri)
    return Buffer.from(fileData.buffer, fileData.byteOffset, fileData.byteLength)
  }

  /**
   * 确认当前加载任务仍然是最新一代。
   */
  private assertFreshLoad(generation: number): void {
    if (generation !== this.loadGeneration)
      throw new StaleDtaLoadError()
  }
}
