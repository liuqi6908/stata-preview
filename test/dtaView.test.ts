import assert from 'node:assert/strict'
import test from 'node:test'
import { DtaView } from '../src/dta/dtaView'
import { createColumnarFixture } from './helpers/dtaFixture'

test('DtaView 能筛选、排序和分页，并把缺失值输出为空值', () => {
  const view = new DtaView(createColumnarFixture())

  view.setFilter({ query: 'age >= 28 & group == 1' })
  assert.equal(view.totalFiltered, 3)

  // score 降序时缺失值应排在有效值之后。
  view.setSort([{ col: 'score', dir: 'desc' }])
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

test('DtaView 会忽略未知排序列并修正分页范围', () => {
  const view = new DtaView(createColumnarFixture())

  view.setSort([{ col: 'does_not_exist', dir: 'asc' }])
  const page = view.getPage({ offset: -10, limit: 2, columns: ['id'] })

  assert.equal(page.offset, 0)
  assert.equal(page.limit, 2)
  assert.deepEqual(page.rows, [[1], [2]])
})
