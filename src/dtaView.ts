/**
 * DtaView: stateful query service over a DtaColumnar dataset.
 *
 * Holds:
 *   - the columnar data (typed arrays + missing masks),
 *   - a current filter (none yet — added in a later commit),
 *   - a current multi-column sort spec,
 *   - an `indices` Uint32Array that is the permutation of rows after applying filter+sort.
 *
 * The webview never sees the full data; it asks for pages via getPage().
 */

import type { CompiledFilter } from './filterCompiler'
import type { DtaColumnar, DtaMeta } from './parser'
import { compileFilter } from './filterCompiler'

export interface SortSpec {
  col: string
  dir: 'asc' | 'desc'
}

export interface FilterSpec {
  /** Stata-style expression, e.g. `edad > 30 & treatment == 1`. */
  query: string
}

export interface PageRequest {
  offset: number // index into the (filtered+sorted) view
  limit: number
}

export interface PageResult {
  rows: any[][] // limit rows, each is an array aligned with meta.headers
  rowIndices: number[] // original row index in the file for each returned row
  offset: number
  limit: number
  totalFiltered: number // size of the current view (after filter)
  totalAll: number // meta.nobs
}

export class DtaView {
  private data: DtaColumnar
  private sortSpec: SortSpec[] = []
  private filterSpec: FilterSpec | null = null
  // indices is the current view: a permutation of [0..N-1] after filter+sort.
  private indices: Uint32Array

  constructor(data: DtaColumnar) {
    this.data = data
    const N = data.meta.nobs
    this.indices = new Uint32Array(N)
    for (let i = 0; i < N; i++) this.indices[i] = i
  }

  /** Returns the current view indices (read-only). Used by tabulate to respect the filter. */
  getIndices(): Uint32Array {
    return this.indices
  }

  hasFilter(): boolean {
    return this.filterSpec !== null && this.filterSpec.query.trim().length > 0
  }

  get meta(): DtaMeta {
    return this.data.meta
  }

  get totalAll(): number {
    return this.data.meta.nobs
  }

  get totalFiltered(): number {
    return this.indices.length
  }

  getSort(): SortSpec[] {
    return [...this.sortSpec]
  }

  /**
   * Set the multi-column sort. Empty array = restore natural row order.
   * V8's Array.prototype.sort is stable since Node 12.
   */
  setSort(spec: SortSpec[]): void {
    const valid = spec.filter(s => this.data.columns[s.col] !== undefined)
    this.sortSpec = valid
    this.rebuildView()
  }

  /**
   * Set the active filter. Throws FilterCompileError on invalid expressions.
   * Empty / whitespace-only query clears the filter.
   */
  setFilter(spec: FilterSpec | null): void {
    if (spec && spec.query.trim().length > 0) {
      // Validate now so caller sees the error before we touch state.
      compileFilter(spec.query, this.data) // throws on syntax error
      this.filterSpec = spec
    }
    else {
      this.filterSpec = null
    }
    this.rebuildView()
  }

  private rebuildView(): void {
    // Step 1: filter — produce the set of row indices that pass.
    const N = this.data.meta.nobs
    let passing: number[] | null = null

    if (this.filterSpec && this.filterSpec.query.trim().length > 0) {
      const fn: CompiledFilter = compileFilter(this.filterSpec.query, this.data).fn
      passing = []
      for (let i = 0; i < N; i++) {
        if (fn(i))
          passing.push(i)
      }
    }

    // Step 2: build base indices (filtered or full).
    let arr: number[]
    if (passing) {
      arr = passing
    }
    else {
      arr = Array.from({ length: N })
      for (let i = 0; i < N; i++) arr[i] = i
    }

    // Step 3: sort if needed.
    if (this.sortSpec.length > 0) {
      const cols = this.sortSpec.map(s => ({
        arr: this.data.columns[s.col],
        miss: this.data.missing[s.col],
        sign: s.dir === 'asc' ? 1 : -1,
        isString: Array.isArray(this.data.columns[s.col]),
      }))
      arr.sort((a, b) => {
        for (let k = 0; k < cols.length; k++) {
          const { arr: col, miss, sign, isString } = cols[k]
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
            const sa = (col as string[])[a]
            const sb = (col as string[])[b]
            if (sa === sb)
              cmp = 0
            else cmp = sa < sb ? -1 : 1
          }
          else {
            const va = (col as any)[a]
            const vb = (col as any)[b]
            if (va === vb)
              cmp = 0
            else cmp = va < vb ? -1 : 1
          }
          if (cmp !== 0)
            return cmp * sign
        }
        return 0
      })
    }

    this.indices = Uint32Array.from(arr)
  }

  /**
   * Read a slice of the current view as row-of-arrays (aligned with meta.headers).
   * Numeric values come out as plain numbers; missing values come out as null.
   */
  getPage(req: PageRequest): PageResult {
    const total = this.indices.length
    const offset = Math.max(0, Math.min(req.offset, total))
    const limit = Math.max(0, Math.min(req.limit, total - offset))

    const headers = this.data.meta.headers
    const types = this.data.meta.types
    const K = headers.length

    // Pre-resolve columns once for this page.
    const cols: ColumnRef[] = headers.map((h, j) => ({
      arr: this.data.columns[h],
      miss: this.data.missing[h],
      type: types[j],
      isString: Array.isArray(this.data.columns[h]),
    }))

    const rows: any[][] = Array.from({ length: limit })
    const rowIndices: number[] = Array.from({ length: limit })
    for (let r = 0; r < limit; r++) {
      const rowIdx = this.indices[offset + r]
      rowIndices[r] = rowIdx
      const row: any[] = Array.from({ length: K })
      for (let j = 0; j < K; j++) {
        const c = cols[j]
        if (c.miss[rowIdx]) {
          row[j] = null
        }
        else if (c.isString) {
          row[j] = (c.arr as string[])[rowIdx]
        }
        else {
          let v = (c.arr as any)[rowIdx] as number
          if (c.type === 'float' || c.type === 'double') {
            // Match the rounding parse() used so the UI looks the same.
            if (Number.isFinite(v))
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
}

interface ColumnRef {
  arr: any
  miss: Uint8Array
  type: string
  isString: boolean
}
