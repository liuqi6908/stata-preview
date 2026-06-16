import type { ByteOrder } from '../src/dta/types'
import type { LegacyFixtureRelease, ModernFixtureRelease } from './helpers/dtaBinaryFixtures'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { DtaParser } from '../src/dta/parser'
import {
  createLegacyDtaBuffer,
  createModernDtaBuffer,
  fixtureByteOrders,
  legacyFixtureReleases,
  modernFixtureReleases,
} from './helpers/dtaBinaryFixtures'

// ---------- 二进制格式覆盖 ----------

test('旧版 DTA 113/114/115 的 LSF/MSF 可以解析数值、字符串和值标签', () => {
  for (const release of legacyFixtureReleases) {
    for (const byteOrder of fixtureByteOrders) {
      const columnar = DtaParser.parseColumnar(createLegacyDtaBuffer(release, byteOrder))
      assertLegacyColumnar(columnar, release, byteOrder)
    }
  }
})

test('现代 DTA 117/118/119 的 LSF/MSF 可以解析 strL、数值和值标签', () => {
  for (const release of modernFixtureReleases) {
    for (const byteOrder of fixtureByteOrders) {
      const columnar = DtaParser.parseColumnar(createModernDtaBuffer(release, byteOrder))
      assertModernColumnar(columnar, release, byteOrder)
    }
  }
})

// ---------- 公共入口 ----------

test('DtaParser.parse 会返回预览行、总行数和值标签', () => {
  const preview = DtaParser.parse(createModernDtaBuffer(119, 'MSF'))

  assert.deepEqual(preview.headers, ['id', 'score', 'group', 'note'])
  assert.equal(preview.nobs, 2)
  assert.deepEqual(preview.valueLabels?.group, { 0: 'Control', 1: 'Treatment' })
  assert.deepEqual(preview.rows, [
    [1, 12.5, 1, 'long text 119 MSF'],
    [2, Number.POSITIVE_INFINITY, 0, ''],
  ])
})

test('DtaParser 会对识别到但不支持的旧格式给出明确错误', () => {
  assert.throws(
    () => DtaParser.parse(Buffer.from([112, 0, 0, 0])),
    /Unsupported file: Stata 8\/9 \(format 112\)/,
  )
})

/**
 * 校验旧版 113/114/115 fixture 的解析结果
 */
function assertLegacyColumnar(
  columnar: ReturnType<typeof DtaParser.parseColumnar>,
  release: LegacyFixtureRelease,
  byteOrder: ByteOrder,
): void {
  assert.equal(columnar.meta.release, release)
  assert.equal(columnar.meta.byteOrder, byteOrder)
  assert.deepEqual(columnar.meta.headers, ['id', 'score', 'name', 'group'])
  assert.deepEqual(columnar.meta.labels, ['Identifier', 'Score', 'Name', 'Group'])
  assert.deepEqual(columnar.meta.types, ['long', 'double', 'str8', 'byte'])
  assert.deepEqual(columnar.meta.valueLabels.group, { 0: 'Control', 1: 'Treatment' })

  assert.deepEqual(Array.from(columnar.columns.id as Int32Array), [1, 2])
  assert.equal((columnar.columns.score as Float64Array)[0], 12.5)
  assert.deepEqual(Array.from(columnar.missing.score), [0, 1])
  assert.deepEqual(columnar.columns.name, ['Alpha', ''])
  assert.deepEqual(Array.from(columnar.missing.name), [0, 1])
  assert.deepEqual(Array.from(columnar.columns.group as Int8Array), [1, 0])
}

/**
 * 校验现代 117/118/119 fixture 的解析结果
 */
function assertModernColumnar(
  columnar: ReturnType<typeof DtaParser.parseColumnar>,
  release: ModernFixtureRelease,
  byteOrder: ByteOrder,
): void {
  assert.equal(columnar.meta.release, release)
  assert.equal(columnar.meta.byteOrder, byteOrder)
  assert.deepEqual(columnar.meta.headers, ['id', 'score', 'group', 'note'])
  assert.deepEqual(columnar.meta.labels, ['Identifier', 'Score', 'Group', 'Long note'])
  assert.deepEqual(columnar.meta.types, ['long', 'double', 'byte', 'strL'])
  assert.deepEqual(columnar.meta.valueLabels.group, { 0: 'Control', 1: 'Treatment' })

  assert.deepEqual(Array.from(columnar.columns.id as Int32Array), [1, 2])
  assert.equal((columnar.columns.score as Float64Array)[0], 12.5)
  assert.deepEqual(Array.from(columnar.missing.score), [0, 1])
  assert.deepEqual(Array.from(columnar.columns.group as Int8Array), [1, 0])
  assert.deepEqual(columnar.columns.note, [`long text ${release} ${byteOrder}`, ''])
  assert.deepEqual(Array.from(columnar.missing.note), [0, 1])
}
