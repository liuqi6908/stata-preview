import assert from 'node:assert/strict'
import test from 'node:test'
import { DtaView, StaleDtaViewUpdateError } from '../src/dta/dtaView'
import { createColumnarFixture } from './helpers/dtaFixture'

test('DtaView 能筛选、排序和分页，并把缺失值输出为空值', async () => {
  const view = new DtaView(createColumnarFixture())

  await view.setFilterAsync({ query: 'age >= 28 & group == 1' }, { yieldEvery: 1 })
  assert.equal(view.totalFiltered, 3)

  // score 降序时缺失值应排在有效值之后。
  await view.setSortAsync([{ col: 'score', dir: 'desc' }], { yieldEvery: 1 })
  const page = view.getPage({ offset: 0, limit: 3, columns: ['id', 'score', 'city'] })

  assert.equal(page.totalAll, 5)
  assert.equal(page.totalFiltered, 3)
  assert.deepEqual(page.rowIndices, [0, 4, 2])
  assert.deepEqual(page.rows, [
    [1, 88.123457, 'Kunming'],
    [5, 88.123457, '  '],
    [3, null, null],
  ])
})

test('DtaView 会忽略未知排序列并修正分页范围', async () => {
  const view = new DtaView(createColumnarFixture())

  await view.setSortAsync([{ col: 'does_not_exist', dir: 'asc' }], { yieldEvery: 1 })
  const page = view.getPage({ offset: -10, limit: 2, columns: ['id'] })

  assert.equal(page.offset, 0)
  assert.equal(page.limit, 2)
  assert.deepEqual(page.rows, [[1], [2]])
})

test('DtaView 异步筛选和排序会得到稳定结果', async () => {
  const view = new DtaView(createColumnarFixture())

  await view.setFilterAsync({ query: 'age >= 28 & group == 1' }, { yieldEvery: 1 })
  await view.setSortAsync([{ col: 'score', dir: 'desc' }], { yieldEvery: 1 })
  const page = view.getPage({ offset: 0, limit: 3, columns: ['id', 'score', 'city'] })

  assert.equal(page.totalFiltered, 3)
  assert.deepEqual(page.rowIndices, [0, 4, 2])
  assert.deepEqual(page.rows, [
    [1, 88.123457, 'Kunming'],
    [5, 88.123457, '  '],
    [3, null, null],
  ])
})

test('DtaView 会阻止过期的异步重建覆盖新视图', async () => {
  const view = new DtaView(createColumnarFixture())

  const first = view
    .setFilterAsync({ query: 'id >= 1' }, { yieldEvery: 1 })
    .catch(e => e)
  await view.setFilterAsync({ query: 'id == 2' }, { yieldEvery: 1 })
  const firstError = await first

  assert.ok(firstError instanceof StaleDtaViewUpdateError)
  assert.equal(view.totalFiltered, 1)
  assert.deepEqual(view.getPage({ offset: 0, limit: 5, columns: ['id'] }).rows, [[2]])
})
