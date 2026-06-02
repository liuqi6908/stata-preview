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
import type { DtaColumnar, DtaMeta } from './parser'
import { compileFilter } from './filterCompiler'

/** 排序配置 */
export interface SortSpec {
  /** 排序列 */
  col: string
  /** 排序方式 */
  dir: 'asc' | 'desc'
}

/** 筛选配置 */
export interface FilterSpec {
  /** 筛选表达式，例如 `edad > 30 & treatment == 1`。 */
  query: string
}

/** 分页请求参数 */
interface PageRequest {
  /** 在（过滤 + 排序后）视图中的起始位置 */
  offset: number
  /** 分页大小 */
  limit: number
}

/** 分页结果 */
interface PageResult {
  /** 行数组，每行与 meta.headers 对齐 */
  rows: any[][]
  /** 行在原始文件中的行索引 */
  rowIndices: number[]
  /** 在（过滤 + 排序后）视图中的起始位置 */
  offset: number
  /** 分页大小 */
  limit: number
  /** 当前视图大小（过滤后） */
  totalFiltered: number
  /** 原始总观测数（未过滤） */
  totalAll: number
}

/**
 * 针对 DtaColumnar 数据集的有状态查询服务
 */
export class DtaView {
  private data: DtaColumnar
  private sortSpec: SortSpec[] = []
  private filterSpec: FilterSpec | null = null
  private indices: Uint32Array
  private compiledFilter: CompiledFilter | null = null

  constructor(data: DtaColumnar) {
    this.data = data
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
   * 设置排序配置
   */
  public setSort(spec: SortSpec[]): void {
    this.sortSpec = spec.filter(s => this.data.columns[s.col] !== undefined)
    this.rebuildView()
  }

  /**
   * 设置筛选配置
   */
  public setFilter(spec: FilterSpec | null): void {
    if (spec && spec.query.trim().length > 0) {
      const compiled = compileFilter(spec.query, this.data)
      this.filterSpec = spec
      this.compiledFilter = compiled.fn
    }
    else {
      this.filterSpec = null
      this.compiledFilter = null
    }
    this.rebuildView()
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
    const K = headers.length

    const cols = headers.map((h, j) => ({
      col: this.data.columns[h],
      miss: this.data.missing[h],
      type: types[j],
      isString: Array.isArray(this.data.columns[h]),
    }))

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
   * 重新构建视图
   */
  private rebuildView(): void {
    const N = this.data.meta.nobs
    let arr: number[]

    if (this.compiledFilter) {
      arr = []
      for (let i = 0; i < N; i++) {
        if (this.compiledFilter(i))
          arr.push(i)
      }
    }
    else {
      arr = Array.from<number>({ length: N })
      for (let i = 0; i < N; i++)
        arr[i] = i
    }

    if (this.sortSpec.length > 0) {
      const columns = this.data.columns
      const missing = this.data.missing
      const cols = this.sortSpec.map(s => ({
        col: columns[s.col],
        miss: missing[s.col],
        sign: s.dir === 'asc' ? 1 : -1,
        isString: Array.isArray(columns[s.col]),
      }))

      arr.sort((a, b) => {
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
      })
    }

    this.indices = Uint32Array.from(arr)
  }
}
