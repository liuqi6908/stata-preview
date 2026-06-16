import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { DtaView } from '../src/dta/dtaView'
import {
  DtaExportCancelledError,
  exportRowsToCsvAsync,
  exportViewToCsvAsync,
  exportViewToXlsxAsync,
} from '../src/dta/tableExporter'
import { createColumnarFixture } from './helpers/dtaFixture'

// ---------- CSV ----------

test('CSV 导出会写入 BOM、表头和缺失单元格', async () => {
  const view = new DtaView(createColumnarFixture())
  await view.setFilterAsync({ query: 'id <= 3' }, { yieldEvery: 1 })

  const csv = toUtf8(await exportViewToCsvAsync(view, ['id', 'city', 'score']))

  assert.ok(csv.startsWith('\uFEFFid,city,score'))
  assert.match(csv, /1,Kunming,88\.123457/)
  assert.match(csv, /2,Dali,92\.5/)
  assert.match(csv, /3,,/)
})

test('CSV 异步导出会按分页报告进度', async () => {
  const view = new DtaView(createColumnarFixture())
  const rows: number[] = []

  const csv = toUtf8(await exportViewToCsvAsync(view, ['id'], {
    pageSize: 2,
    onProgress: state => rows.push(state.processedRows),
  }))

  assert.ok(csv.startsWith('\uFEFFid'))
  assert.deepEqual(rows, [0, 2, 4, 5])
})

test('CSV 通用行源导出会按分页读取行', async () => {
  const offsets: number[] = []
  const csv = toUtf8(await exportRowsToCsvAsync({
    columns: ['name', 'unique'],
    totalRows: 3,
    getRows(offset, limit) {
      offsets.push(offset)
      return [
        ['id', 5],
        ['group', 2],
        ['city', 4],
      ].slice(offset, offset + limit)
    },
  }, { pageSize: 2 }))

  assert.ok(csv.startsWith('\uFEFFname,unique'))
  assert.match(csv, /group,2/)
  assert.deepEqual(offsets, [0, 2])
})

// ---------- 取消 ----------

test('导出取消时会抛出取消错误', async () => {
  const view = new DtaView(createColumnarFixture())

  await assert.rejects(
    exportViewToCsvAsync(view, ['id'], {
      shouldCancel: () => true,
    }),
    DtaExportCancelledError,
  )
})

// ---------- XLSX ----------

test('XLSX 导出会生成基于 ZIP 的工作簿包', async () => {
  const view = new DtaView(createColumnarFixture())

  const xlsx = Buffer.from(await exportViewToXlsxAsync(view, ['id', 'city'], { pageSize: 2 }))
  const text = xlsx.toString('utf8')

  assert.equal(xlsx.readUInt32LE(0), 0x04034B50)
  assert.ok(text.includes('[Content_Types].xml'))
  assert.ok(text.includes('xl/workbook.xml'))
  assert.ok(text.includes('xl/worksheets/sheet1.xml'))
  assert.ok(text.includes('Kunming'))
})

// ---------- 辅助函数 ----------

function toUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8')
}
