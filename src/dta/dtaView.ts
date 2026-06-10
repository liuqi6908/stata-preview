/**
 * DtaView：针对 DtaColumnar 数据集的有状态查询服务。
 *
 * 维护内容：
 *   - 列式数据（TypedArrays + 缺失值掩码），
 *   - 当前过滤器配置，
 *   - 当前多列排序配置，
 *   - 一个 `indices` Uint32Array，用来表示过滤 + 排序后的行顺序。
 *
 * Webview 不直接读取全部数据，而是通过 getPage() 请求分页结果。
 */

import type { CompiledFilter } from './filterCompiler'
import type { ColumnArray, DtaColumnar, DtaMeta, FilterSpec, PageRequest, PageResult, SortSpec } from './types'
import { compileFilter } from './filterCompiler'

/** 异步重建视图时默认每处理多少行让出一次事件循环。 */
const DEFAULT_REBUILD_YIELD_EVERY = 50000

/** 分块排序时每个小块的默认行数。 */
const DEFAULT_SORT_CHUNK_SIZE = 50000

/** 分页时读取单列所需的缓存信息。 */
interface PageColumn {
  /** 列数据。 */
  col: ColumnArray
  /** 缺失值掩码。 */
  miss: Uint8Array
  /** DTA 变量类型。 */
  type: string
  /** 是否为字符串列。 */
  isString: boolean
}

/** 视图重建配置。 */
export interface RebuildViewOptions {
  /** 处理多少行后让出事件循环。 */
  yieldEvery?: number
}

/** 某次异步视图重建已经被更新的筛选或排序请求取代。 */
export class StaleDtaViewUpdateError extends Error {
  constructor() {
    super('视图更新已被新的筛选或排序请求取代。')
  }
}

/** 判断错误是否来自过期视图重建。 */
export function isStaleDtaViewUpdateError(error: unknown): error is StaleDtaViewUpdateError {
  return error instanceof StaleDtaViewUpdateError
}

/**
 * 针对 DtaColumnar 数据集的有状态查询服务
 */
export class DtaView {
  private data: DtaColumnar
  private readonly headerIndex: Map<string, number>
  private sortSpec: SortSpec[] = []
  private filterSpec: FilterSpec | null = null
  private indices: Uint32Array
  private compiledFilter: CompiledFilter | null = null
  private rebuildGeneration = 0

  constructor(data: DtaColumnar) {
    this.data = data
    this.headerIndex = new Map(data.meta.headers.map((h, j) => [h, j]))
    const N = data.meta.nobs
    this.indices = new Uint32Array(N)
    for (let i = 0; i < N; i++)
      this.indices[i] = i
  }

  /**
   * 数据集的元数据（表头、类型、标签等）
   */
  get meta(): DtaMeta {
    return this.data.meta
  }

  /**
   * 当前视图大小（过滤后）
   */
  get totalFiltered(): number {
    return this.indices.length
  }

  /**
   * 原始总观测数（未过滤）
   */
  get totalAll(): number {
    return this.data.meta.nobs
  }

  /**
   * 获取当前视图索引
   */
  public getIndices(): Uint32Array {
    return this.indices
  }

  /**
   * 是否存在有效过滤
   */
  public hasFilter(): boolean {
    return this.filterSpec !== null && this.filterSpec.query.trim().length > 0
  }

  /**
   * 异步设置排序配置。
   *
   * 大文件排序会分块执行，避免长时间占用扩展宿主事件循环。
   */
  public async setSortAsync(spec: SortSpec[], options?: RebuildViewOptions): Promise<void> {
    const generation = this.setSortSpec(spec)
    await this.rebuildViewAsync(generation, options)
  }

  /**
   * 异步设置筛选配置。
   *
   * 大文件筛选会按行分批让出事件循环，新的筛选/排序会让旧任务自动过期。
   */
  public async setFilterAsync(spec: FilterSpec | null, options?: RebuildViewOptions): Promise<void> {
    const generation = this.setFilterSpec(spec)
    await this.rebuildViewAsync(generation, options)
  }

  /**
   * 更新排序配置并推进视图重建世代。
   */
  private setSortSpec(spec: SortSpec[]): number {
    this.sortSpec = spec
      .filter(s => this.data.columns[s.col] !== undefined)
      .map(s => ({ col: s.col, dir: s.dir }))
    return ++this.rebuildGeneration
  }

  /**
   * 更新筛选配置并推进视图重建世代。
   */
  private setFilterSpec(spec: FilterSpec | null): number {
    if (spec && spec.query.trim().length > 0) {
      const compiled = compileFilter(spec.query, this.data)
      this.filterSpec = { query: spec.query }
      this.compiledFilter = compiled.fn
    }
    else {
      this.filterSpec = null
      this.compiledFilter = null
    }
    return ++this.rebuildGeneration
  }

  /**
   * 获取分页结果
   */
  public getPage(req: PageRequest): PageResult {
    const total = this.indices.length
    const offset = Math.max(0, Math.min(req.offset, total))
    const limit = Math.max(0, Math.min(req.limit, total - offset))

    const headers = this.data.meta.headers
    const types = this.data.meta.types
    const selectedHeaders = req.columns
      ? req.columns.filter(h => this.headerIndex.has(h))
      : headers
    const K = selectedHeaders.length

    const cols: PageColumn[] = selectedHeaders.map((h) => {
      const j = this.headerIndex.get(h)!
      return {
        col: this.data.columns[h],
        miss: this.data.missing[h],
        type: types[j],
        isString: Array.isArray(this.data.columns[h]),
      }
    })

    const rows = Array.from<any[]>({ length: limit })
    const rowIndices = Array.from<number>({ length: limit })
    for (let r = 0; r < limit; r++) {
      const rowIdx = this.indices[offset + r]
      rowIndices[r] = rowIdx
      const row = Array.from<any>({ length: K })
      for (let j = 0; j < K; j++) {
        const c = cols[j]
        if (c.miss[rowIdx]) {
          row[j] = null
        }
        else if (c.isString) {
          row[j] = c.col[rowIdx]
        }
        else {
          let v = c.col[rowIdx]
          if (c.type === 'float' || c.type === 'double') {
            if (typeof v === 'number' && Number.isFinite(v))
              v = Math.round(v * 1e6) / 1e6
          }
          row[j] = v
        }
      }
      rows[r] = row
    }

    return {
      rows,
      rowIndices,
      offset,
      limit,
      totalFiltered: total,
      totalAll: this.data.meta.nobs,
    }
  }

  /**
   * 异步重新构建视图。
   */
  private async rebuildViewAsync(generation: number, options: RebuildViewOptions = {}): Promise<void> {
    const yieldEvery = normalizeChunkSize(options.yieldEvery, DEFAULT_REBUILD_YIELD_EVERY)
    const compiledFilter = this.compiledFilter
    const sortSpec = this.sortSpec.map(s => ({ col: s.col, dir: s.dir }))

    let arr = await this.collectRowsAsync(compiledFilter, generation, yieldEvery)
    this.assertFreshRebuild(generation)
    arr = await this.sortRowsAsync(arr, sortSpec, generation, yieldEvery)
    this.assertFreshRebuild(generation)
    this.indices = Uint32Array.from(arr)
  }

  /**
   * 异步按当前筛选器收集行索引。
   */
  private async collectRowsAsync(
    compiledFilter: CompiledFilter | null,
    generation: number,
    yieldEvery: number,
  ): Promise<number[]> {
    const N = this.data.meta.nobs
    let arr: number[]

    if (compiledFilter) {
      arr = []
      for (let i = 0; i < N; i++) {
        if (compiledFilter(i))
          arr.push(i)
        if ((i + 1) % yieldEvery === 0) {
          await yieldToEventLoop()
          this.assertFreshRebuild(generation)
        }
      }
    }
    else {
      arr = Array.from<number>({ length: N })
      for (let i = 0; i < N; i++) {
        arr[i] = i
        if ((i + 1) % yieldEvery === 0) {
          await yieldToEventLoop()
          this.assertFreshRebuild(generation)
        }
      }
    }

    return arr
  }

  /**
   * 异步排序行索引。
   */
  private async sortRowsAsync(
    arr: number[],
    sortSpec: SortSpec[],
    generation: number,
    yieldEvery: number,
  ): Promise<number[]> {
    if (sortSpec.length === 0)
      return arr

    const compareRows = this.createRowComparator(sortSpec)
    const chunkSize = normalizeChunkSize(yieldEvery, DEFAULT_SORT_CHUNK_SIZE)
    if (arr.length <= chunkSize) {
      arr.sort(compareRows)
      return arr
    }

    let chunks: number[][] = []
    for (let start = 0; start < arr.length; start += chunkSize) {
      const chunk = arr.slice(start, start + chunkSize)
      chunk.sort(compareRows)
      chunks.push(chunk)
      await yieldToEventLoop()
      this.assertFreshRebuild(generation)
    }

    while (chunks.length > 1) {
      const merged: number[][] = []
      for (let i = 0; i < chunks.length; i += 2) {
        if (i + 1 >= chunks.length)
          merged.push(chunks[i])
        else
          merged.push(mergeSortedRows(chunks[i], chunks[i + 1], compareRows))
        await yieldToEventLoop()
        this.assertFreshRebuild(generation)
      }
      chunks = merged
    }

    return chunks[0] ?? []
  }

  /**
   * 创建行比较函数。
   */
  private createRowComparator(sortSpec: SortSpec[]): (a: number, b: number) => number {
    const columns = this.data.columns
    const missing = this.data.missing
    const cols = sortSpec.map(s => ({
      col: columns[s.col],
      miss: missing[s.col],
      sign: s.dir === 'asc' ? 1 : -1,
      isString: Array.isArray(columns[s.col]),
    }))

    return (a, b) => {
      for (let k = 0; k < cols.length; k++) {
        const { col, miss, sign, isString } = cols[k]
        const ma = miss[a]
        const mb = miss[b]
        if (ma && !mb)
          return 1
        if (!ma && mb)
          return -1
        if (ma && mb)
          continue

        let cmp: number
        if (isString) {
          const sa = col[a]
          const sb = col[b]
          cmp = sa === sb ? 0 : (sa < sb ? -1 : 1)
        }
        else {
          const va = col[a]
          const vb = col[b]
          cmp = va === vb ? 0 : (va < vb ? -1 : 1)
        }
        if (cmp !== 0)
          return cmp * sign
      }
      return 0
    }
  }

  /**
   * 确认当前视图重建仍然是最新任务。
   */
  private assertFreshRebuild(generation: number): void {
    if (generation !== this.rebuildGeneration)
      throw new StaleDtaViewUpdateError()
  }
}

/**
 * 归一化分块大小。
 */
function normalizeChunkSize(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0)
    return fallback
  return Math.max(1, Math.floor(value))
}

/**
 * 让出一次事件循环，让 VS Code 能处理 UI 与后续消息。
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * 合并两个已排序的行索引块。
 */
function mergeSortedRows(
  left: number[],
  right: number[],
  compareRows: (a: number, b: number) => number,
): number[] {
  const out = Array.from<number>({ length: left.length + right.length })
  let i = 0
  let j = 0
  let k = 0

  while (i < left.length && j < right.length) {
    if (compareRows(left[i], right[j]) <= 0)
      out[k++] = left[i++]
    else
      out[k++] = right[j++]
  }
  while (i < left.length)
    out[k++] = left[i++]
  while (j < right.length)
    out[k++] = right[j++]

  return out
}
