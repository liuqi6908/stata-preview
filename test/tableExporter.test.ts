import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { DtaView } from '../src/dta/dtaView'
import { exportViewToCsv, exportViewToXlsx } from '../src/dta/tableExporter'
import { createColumnarFixture } from './helpers/dtaFixture'

test('CSV 导出会写入 BOM、表头和缺失单元格', () => {
  const view = new DtaView(createColumnarFixture())
  view.setFilter({ query: 'id <= 3' })

  const csv = Buffer.from(exportViewToCsv(view, ['id', 'city', 'score'])).toString('utf8')

  assert.ok(csv.startsWith('\uFEFFid,city,score'))
  assert.match(csv, /1,Kunming,88\.123457/)
  assert.match(csv, /2,Dali,92\.5/)
  assert.match(csv, /3,,/)
})

test('XLSX 导出会生成基于 ZIP 的工作簿包', () => {
  const view = new DtaView(createColumnarFixture())

  const xlsx = Buffer.from(exportViewToXlsx(view, ['id', 'city']))
  const text = xlsx.toString('utf8')

  assert.equal(xlsx.readUInt32LE(0), 0x04034B50)
  assert.ok(text.includes('[Content_Types].xml'))
  assert.ok(text.includes('xl/workbook.xml'))
  assert.ok(text.includes('xl/worksheets/sheet1.xml'))
  assert.ok(text.includes('Kunming'))
})
