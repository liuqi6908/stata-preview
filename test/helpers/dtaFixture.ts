import type { DtaColumnar } from '../../src/dta/types'

// ---------- 小型数据集 ----------

/**
 * 构造小型列式数据集，供筛选、分页、统计和导出单测复用
 *
 * 数据刻意包含：
 *   - 数值缺失值；
 *   - 空字符串缺失值；
 *   - 仅包含空格的非缺失字符串；
 *   - 带值标签的分组变量。
 */
export function createColumnarFixture(): DtaColumnar {
  const headers = ['id', 'age', 'score', 'city', 'group']
  return {
    meta: {
      headers,
      labels: ['Identifier', 'Age', 'Score', 'City', 'Treatment group'],
      types: ['long', 'int', 'double', 'str20', 'byte'],
      typeSizes: [4, 2, 8, 20, 1],
      valueLabels: {
        group: {
          0: 'Control',
          1: 'Treatment',
        },
      },
      nobs: 5,
      release: 118,
      byteOrder: 'LSF',
    },
    columns: {
      id: new Int32Array([1, 2, 3, 4, 5]),
      age: new Int16Array([34, 28, 41, 28, 52]),
      score: new Float64Array([88.1234567, 92.5, Number.NaN, 77.25, 88.1234567]),
      city: ['Kunming', 'Dali', '', 'Beijing', '  '],
      group: new Int8Array([1, 0, 1, 0, 1]),
    },
    missing: {
      id: new Uint8Array([0, 0, 0, 0, 0]),
      age: new Uint8Array([0, 0, 0, 0, 0]),
      score: new Uint8Array([0, 0, 1, 0, 0]),
      city: new Uint8Array([0, 0, 1, 0, 0]),
      group: new Uint8Array([0, 0, 0, 0, 0]),
    },
  }
}

// ---------- 高基数数据集 ----------

/**
 * 构造唯一值超过 200 的数值列，用于验证统计和变量字典不会降级为近似计数
 */
export function createHighCardinalityFixture(nobs = 250): DtaColumnar {
  return {
    meta: {
      headers: ['x'],
      labels: ['High cardinality'],
      types: ['double'],
      typeSizes: [8],
      valueLabels: {},
      nobs,
      release: 118,
      byteOrder: 'LSF',
    },
    columns: {
      x: Float64Array.from({ length: nobs }, (_, i) => i + 0.5),
    },
    missing: {
      x: new Uint8Array(nobs),
    },
  }
}
