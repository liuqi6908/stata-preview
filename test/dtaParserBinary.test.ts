import type { LegacyFixtureRelease, ModernFixtureRelease } from './helpers/dtaBinaryFixtures'
import assert from 'node:assert/strict'
import test from 'node:test'
import { DtaParser } from '../src/dta/parser'
import {
  createLegacyDtaBuffer,
  createModernDtaBuffer,
} from './helpers/dtaBinaryFixtures'

const byteOrders = ['LSF', 'MSF'] as const
const legacyReleases = [113, 114, 115] as const
const modernReleases = [117, 118, 119] as const

for (const release of legacyReleases) {
  for (const byteOrder of byteOrders) {
    test(`旧版 DTA ${release} ${byteOrder} 可以解析数值、字符串和值标签`, () => {
      const columnar = DtaParser.parseColumnar(createLegacyDtaBuffer(release, byteOrder))
      assertLegacyColumnar(columnar, release, byteOrder)
    })
  }
}

for (const release of modernReleases) {
  for (const byteOrder of byteOrders) {
    test(`现代 DTA ${release} ${byteOrder} 可以解析 strL、数值和值标签`, () => {
      const columnar = DtaParser.parseColumnar(createModernDtaBuffer(release, byteOrder))
      assertModernColumnar(columnar, release, byteOrder)
    })
  }
}

/**
 * 校验旧版 113/114/115 fixture 的解析结果。
 */
function assertLegacyColumnar(
  columnar: ReturnType<typeof DtaParser.parseColumnar>,
  release: LegacyFixtureRelease,
  byteOrder: 'LSF' | 'MSF',
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
 * 校验现代 117/118/119 fixture 的解析结果。
 */
function assertModernColumnar(
  columnar: ReturnType<typeof DtaParser.parseColumnar>,
  release: ModernFixtureRelease,
  byteOrder: 'LSF' | 'MSF',
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
