import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVariableDictionaryAsync, tabulateColumnar } from '../src/dta/tabulator'
import { createColumnarFixture, createHighCardinalityFixture } from './helpers/dtaFixture'

// ---------- 变量统计 ----------

test('变量统计能返回带值标签的离散变量统计', () => {
  const result = tabulateColumnar(createColumnarFixture(), 'group')

  assert.equal(result.kind, 'discrete')
  assert.equal(result.nValid, 5)
  assert.equal(result.nMissing, 0)
  assert.equal(result.nUnique, 2)
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
  assert.equal(result.nUnique, 3)
  assert.equal(result.min, 77.25)
  assert.equal(result.max, 92.5)
  assert.ok(Math.abs(result.mean - 86.49922835) < 1e-9)
  assert.equal(result.chart.type, 'histogram')
})

// ---------- 缺失值 ----------

test('变量统计会把空字符串视为缺失，同时保留纯空白字符串', () => {
  const result = tabulateColumnar(createColumnarFixture(), 'city')

  assert.equal(result.kind, 'discrete')
  assert.equal(result.nValid, 4)
  assert.equal(result.nMissing, 1)
  assert.ok(result.entries.some(entry => entry.value === '  '))
})

// ---------- 变量字典 ----------

test('变量字典会汇总序号、统计类型、有效数、缺失数和唯一值', async () => {
  const dictionary = await buildVariableDictionaryAsync(createColumnarFixture(), { yieldEvery: 1 })
  const byName = new Map(dictionary.map(entry => [entry.name, entry]))

  assert.equal(dictionary.length, 5)
  assert.deepEqual(byName.get('score'), {
    index: 3,
    name: 'score',
    label: 'Score',
    type: 'double',
    statType: 'continuous',
    nValid: 4,
    nMissing: 1,
    nUnique: 3,
  })
  assert.deepEqual(byName.get('group'), {
    index: 5,
    name: 'group',
    label: 'Treatment group',
    type: 'byte',
    statType: 'discrete',
    nValid: 5,
    nMissing: 0,
    nUnique: 2,
  })
  assert.equal(byName.get('city')?.nUnique, 4)
  assert.equal(byName.get('city')?.statType, 'discrete')
})

// ---------- 高基数 ----------

test('变量统计和变量字典都会返回超过 200 的精确唯一值', async () => {
  const data = createHighCardinalityFixture()

  const result = tabulateColumnar(data, 'x')
  const dictionary = await buildVariableDictionaryAsync(data, { yieldEvery: 50 })

  assert.equal(result.kind, 'continuous')
  assert.equal(result.nUnique, 250)
  assert.equal(dictionary[0].statType, result.kind)
  assert.equal(dictionary[0].nValid, result.nValid)
  assert.equal(dictionary[0].nMissing, result.nMissing)
  assert.equal(dictionary[0].nUnique, result.nUnique)
})
