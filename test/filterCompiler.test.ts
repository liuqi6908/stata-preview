import assert from 'node:assert/strict'
import test from 'node:test'
import { compileFilter, FilterCompileError } from '../src/dta/filterCompiler'
import { createColumnarFixture } from './helpers/dtaFixture'

// ---------- 表达式能力 ----------

test('筛选编译器支持比较、逻辑、函数和字符串处理', () => {
  const data = createColumnarFixture()

  // 验证比较运算、逻辑运算和集合判断能组合工作
  const adultsInNamedCities = compileFilter('age >= 28 & inlist(city, "Kunming", "Beijing")', data)
  assert.deepEqual(adultsInNamedCities.referencedVars.sort(), ['age', 'city'])
  assert.deepEqual([0, 1, 2, 3, 4].filter(adultsInNamedCities.fn), [0, 3])

  // 验证字符串标准化、包含判断和正则匹配
  const normalized = compileFilter('lower(trim(city)) == "dali" | contains(city, "ming")', data)
  assert.deepEqual([0, 1, 2, 3, 4].filter(normalized.fn), [0, 1])
  assert.deepEqual([0, 1, 2, 3, 4].filter(compileFilter('regexm(city, "^Bei")', data).fn), [3])

  // 验证缺失值判断、闭区间判断和算术表达式
  const missingOrRange = compileFilter('missing(score) | inrange(score, 88, 90)', data)
  assert.deepEqual([0, 1, 2, 3, 4].filter(missingOrRange.fn), [0, 2, 4])
  assert.deepEqual([0, 1, 2, 3, 4].filter(compileFilter('!(age < 30) & score / 2 > 40', data).fn), [0, 4])
})

// ---------- 错误路径 ----------

test('筛选编译器会报告未知变量和未知函数', () => {
  const data = createColumnarFixture()

  assert.throws(
    () => compileFilter('unknown_var == 1', data),
    (error: unknown) => error instanceof FilterCompileError && /Unknown variable/.test(error.message),
  )

  assert.throws(
    () => compileFilter('madeup(age)', data),
    (error: unknown) => error instanceof FilterCompileError && /Unknown function/.test(error.message),
  )
})
