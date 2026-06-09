import assert from 'node:assert/strict'
import test from 'node:test'
import { tabulateColumnar } from '../src/dta/tabulator'
import { createColumnarFixture } from './helpers/dtaFixture'

test('变量统计能返回带值标签的离散变量汇总', () => {
  const result = tabulateColumnar(createColumnarFixture(), 'group')

  assert.equal(result.kind, 'discrete')
  assert.equal(result.nValid, 5)
  assert.equal(result.nMissing, 0)
  assert.deepEqual(result.entries.map(entry => [entry.value, entry.label, entry.freq]), [
    [0, 'Control', 2],
    [1, 'Treatment', 3],
  ])
})

test('变量统计能返回连续变量描述统计和缺失数量', () => {
  const result = tabulateColumnar(createColumnarFixture(), 'score')

  assert.equal(result.kind, 'continuous')
  assert.equal(result.nValid, 4)
  assert.equal(result.nMissing, 1)
  assert.equal(result.min, 77.25)
  assert.equal(result.max, 92.5)
  assert.ok(Math.abs(result.mean - 86.49922835) < 1e-9)
  assert.equal(result.chart.type, 'histogram')
})

test('变量统计会把空字符串视为缺失，同时保留纯空白字符串', () => {
  const result = tabulateColumnar(createColumnarFixture(), 'city')

  assert.equal(result.kind, 'discrete')
  assert.equal(result.nValid, 4)
  assert.equal(result.nMissing, 1)
  assert.ok(result.entries.some(entry => entry.value === '  '))
})
