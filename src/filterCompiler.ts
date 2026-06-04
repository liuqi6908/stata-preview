/**
 * 过滤表达式编译器。
 *
 * 将 Stata 风格的筛选表达式（例如：
 *   edad > 30 & (treatment == 1 | y1 < 1000)
 * ）编译为 `(rowIdx) => boolean`，并直接在 DtaColumnar 的列式数据与
 * 缺失值掩码上求值。
 *
 * 运算符（按优先级从低到高）：
 *   |        OR      （也接受 `||`）
 *   &        AND     （也接受 `&&`）
 *   ! / not  NOT     （一元）
 *   ==, !=, ~=, <, <=, >, >= 比较运算
 *   +, -, *, /, ^ 算术运算
 *
 * 操作数：
 *   - 数值字面量：12, 3.5, 1e6
 *   - 字符串字面量："foo" 或 'foo'
 *   - 变量名（必须匹配列头）
 *   - 函数调用：missing(x), inlist(x, ...), contains(s, sub) 等
 *   - 括号表达式
 *
 * 缺失值语义：缺失值参与比较时，该比较结果为 false。
 */

import type { DtaColumnar } from './parser'
import { l10n } from 'vscode'

/** 编译缓存 */
const compileCache: WeakMap<DtaColumnar, Map<string, CompileResult>> = new WeakMap()

/** 编译过滤函数 */
export type CompiledFilter = (rowIdx: number) => boolean

/** 编译结果 */
export interface CompileResult {
  /** 可执行过滤函数 */
  fn: CompiledFilter
  /** 表达式中引用到的变量名 */
  referencedVars: string[]
}

/**
 * 过滤表达式编译错误
 */
export class FilterCompileError extends Error {
  constructor(message: string, public position?: number) {
    super(message)
  }
}

// ---------- 词元解析 ----------

/** 词元类型 */
type TokenType
  = | 'NUMBER' | 'STRING' | 'IDENT'
    | 'LPAREN' | 'RPAREN' | 'COMMA'
    | 'PLUS' | 'MINUS' | 'STAR' | 'SLASH' | 'CARET'
    | 'AND' | 'OR' | 'NOT'
    | 'EQ' | 'NEQ' | 'LT' | 'LE' | 'GT' | 'GE'
    | 'EOF'

/**
 * 词元类型的用户可见名称
 */
function tokenTypeLabel(type: TokenType): string {
  switch (type) {
    case 'NUMBER': return l10n.t('number literal')
    case 'STRING': return l10n.t('string literal')
    case 'IDENT': return l10n.t('variable name')
    case 'LPAREN': return l10n.t('left parenthesis')
    case 'RPAREN': return l10n.t('right parenthesis')
    case 'COMMA': return l10n.t('comma')
    case 'PLUS': return l10n.t('plus operator')
    case 'MINUS': return l10n.t('minus operator')
    case 'STAR': return l10n.t('multiply operator')
    case 'SLASH': return l10n.t('divide operator')
    case 'CARET': return l10n.t('power operator')
    case 'AND': return l10n.t('AND operator')
    case 'OR': return l10n.t('OR operator')
    case 'NOT': return l10n.t('NOT operator')
    case 'EQ': return l10n.t('equality operator')
    case 'NEQ': return l10n.t('inequality operator')
    case 'LT': return l10n.t('less-than operator')
    case 'LE': return l10n.t('less-than-or-equal operator')
    case 'GT': return l10n.t('greater-than operator')
    case 'GE': return l10n.t('greater-than-or-equal operator')
    case 'EOF': return l10n.t('end of expression')
  }
}

/** 词元 */
interface Token {
  /** 类型 */
  type: TokenType
  /** 值 */
  value: string
  /** 位置 */
  pos: number
}

/**
 * 读取当前位置的完整 Unicode 字符。
 */
function codePointAt(src: string, pos: number): string {
  return String.fromCodePoint(src.codePointAt(pos)!)
}

/**
 * 标识符起始字符：下划线或任意 Unicode 字母。
 */
function isIdentifierStart(c: string): boolean {
  return c === '_' || /\p{L}/u.test(c)
}

/**
 * 标识符后续字符：下划线、Unicode 字母、数字或组合标记。
 */
function isIdentifierPart(c: string): boolean {
  return c === '_' || /[\p{L}\p{N}\p{M}]/u.test(c)
}

/**
 * 将表达式字符串拆分为词元序列
 */
function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const L = src.length
  while (i < L) {
    const c = codePointAt(src, i)
    // 空白字符
    if (/\s/.test(c)) {
      i += c.length
      continue
    }
    const start = i

    // 字符串字面量
    if (c === '"' || c === '\'') {
      const quote = c
      i++
      let s = ''
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          s += src[i + 1]
          i += 2
        }
        else {
          s += src[i++]
        }
      }
      if (i >= src.length)
        throw new FilterCompileError(l10n.t('Unterminated string literal'), start)
      i++
      tokens.push({ type: 'STRING', value: s, pos: start })
      continue
    }

    // 数字字面量
    if (c >= '0' && c <= '9') {
      let s = ''
      while (i < src.length && /[0-9.e+\-]/i.test(src[i])) {
        if ((src[i] === '+' || src[i] === '-') && !(s.endsWith('e') || s.endsWith('E')))
          break
        s += src[i++]
      }
      const n = Number(s)
      if (Number.isNaN(n))
        throw new FilterCompileError(l10n.t('Invalid number: {0}', s), start)
      tokens.push({ type: 'NUMBER', value: s, pos: start })
      continue
    }

    // 操作符与标点
    if (c === '(') {
      tokens.push({ type: 'LPAREN', value: '(', pos: start })
      i++
      continue
    }
    if (c === ')') {
      tokens.push({ type: 'RPAREN', value: ')', pos: start })
      i++
      continue
    }
    if (c === ',') {
      tokens.push({ type: 'COMMA', value: ',', pos: start })
      i++
      continue
    }
    if (c === '+') {
      tokens.push({ type: 'PLUS', value: '+', pos: start })
      i++
      continue
    }
    if (c === '-') {
      tokens.push({ type: 'MINUS', value: '-', pos: start })
      i++
      continue
    }
    if (c === '*') {
      tokens.push({ type: 'STAR', value: '*', pos: start })
      i++
      continue
    }
    if (c === '/') {
      tokens.push({ type: 'SLASH', value: '/', pos: start })
      i++
      continue
    }
    if (c === '^') {
      tokens.push({ type: 'CARET', value: '^', pos: start })
      i++
      continue
    }
    if (c === '&') {
      tokens.push({ type: 'AND', value: '&', pos: start })
      i += (src[i + 1] === '&' ? 2 : 1)
      continue
    }
    if (c === '|') {
      tokens.push({ type: 'OR', value: '|', pos: start })
      i += (src[i + 1] === '|' ? 2 : 1)
      continue
    }

    if (c === '=' && src[i + 1] === '=') {
      tokens.push({ type: 'EQ', value: '==', pos: start })
      i += 2
      continue
    }
    if (c === '!' && src[i + 1] === '=') {
      tokens.push({ type: 'NEQ', value: '!=', pos: start })
      i += 2
      continue
    }
    if (c === '~' && src[i + 1] === '=') {
      tokens.push({ type: 'NEQ', value: '~=', pos: start })
      i += 2
      continue
    }
    if (c === '<' && src[i + 1] === '=') {
      tokens.push({ type: 'LE', value: '<=', pos: start })
      i += 2
      continue
    }
    if (c === '>' && src[i + 1] === '=') {
      tokens.push({ type: 'GE', value: '>=', pos: start })
      i += 2
      continue
    }
    if (c === '<') {
      tokens.push({ type: 'LT', value: '<', pos: start })
      i++
      continue
    }
    if (c === '>') {
      tokens.push({ type: 'GT', value: '>', pos: start })
      i++
      continue
    }
    if (c === '!') {
      tokens.push({ type: 'NOT', value: '!', pos: start })
      i++
      continue
    }

    // 标识符（变量名）：字母、数字、下划线，不能以数字开头；支持 Unicode 变量名。
    if (isIdentifierStart(c)) {
      let s = ''
      while (i < src.length) {
        const ch = codePointAt(src, i)
        if (!isIdentifierPart(ch))
          break
        s += ch
        i += ch.length
      }
      const keyword = s.toLowerCase()
      if (keyword === 'and') {
        tokens.push({ type: 'AND', value: 'and', pos: start })
        continue
      }
      if (keyword === 'or') {
        tokens.push({ type: 'OR', value: 'or', pos: start })
        continue
      }
      if (keyword === 'not') {
        tokens.push({ type: 'NOT', value: 'not', pos: start })
        continue
      }
      tokens.push({ type: 'IDENT', value: s, pos: start })
      continue
    }

    throw new FilterCompileError(l10n.t('Unexpected character "{0}"', c), start)
  }
  tokens.push({ type: 'EOF', value: '', pos: src.length })
  return tokens
}

// ---------- 语法解析 ----------

/** AST 节点 */
type Node
  = | { kind: 'num', value: number }
    | { kind: 'str', value: string }
    | { kind: 'var', name: string }
    | { kind: 'unary', op: 'pos' | 'neg', expr: Node }
    | { kind: 'binary', op: 'add' | 'sub' | 'mul' | 'div' | 'pow', a: Node, b: Node }
    | { kind: 'call', name: string, args: Node[] }
    | { kind: 'not', expr: Node }
    | { kind: 'cmp', op: 'eq' | 'neq' | 'lt' | 'le' | 'gt' | 'ge', a: Node, b: Node }
    | { kind: 'and', a: Node, b: Node }
    | { kind: 'or', a: Node, b: Node }

/**
 * 简单递归下降解析器，将词元序列解析为 AST
 */
class Parser {
  private p = 0

  constructor(private tokens: Token[]) {}

  public parse(): Node {
    const expr = this.parseOr()
    if (this.peek().type !== 'EOF') {
      const t = this.peek()
      throw new FilterCompileError(l10n.t('Unexpected token "{0}"', t.value), t.pos)
    }
    return expr
  }

  private peek(): Token {
    return this.tokens[this.p]
  }

  private consume(): Token {
    return this.tokens[this.p++]
  }

  private expect(type: TokenType): Token {
    const t = this.peek()
    if (t.type !== type)
      throw new FilterCompileError(l10n.t('Expected {0}, got {1} "{2}"', tokenTypeLabel(type), tokenTypeLabel(t.type), t.value), t.pos)
    return this.consume()
  }

  private parseOr(): Node {
    let left = this.parseAnd()
    while (this.peek().type === 'OR') {
      this.consume()
      left = { kind: 'or', a: left, b: this.parseAnd() }
    }
    return left
  }

  private parseAnd(): Node {
    let left = this.parseCmp()
    while (this.peek().type === 'AND') {
      this.consume()
      left = { kind: 'and', a: left, b: this.parseCmp() }
    }
    return left
  }

  private parseCmp(): Node {
    const a = this.parseAdd()
    const t = this.peek()
    const cmpMap: { [k: string]: 'eq' | 'neq' | 'lt' | 'le' | 'gt' | 'ge' } = {
      EQ: 'eq',
      NEQ: 'neq',
      LT: 'lt',
      LE: 'le',
      GT: 'gt',
      GE: 'ge',
    }
    if (cmpMap[t.type]) {
      this.consume()
      const b = this.parseAdd()
      return { kind: 'cmp', op: cmpMap[t.type], a, b }
    }
    return a
  }

  private parseAdd(): Node {
    let left = this.parseMul()
    while (this.peek().type === 'PLUS' || this.peek().type === 'MINUS') {
      const t = this.consume()
      left = {
        kind: 'binary',
        op: t.type === 'PLUS' ? 'add' : 'sub',
        a: left,
        b: this.parseMul(),
      }
    }
    return left
  }

  private parseMul(): Node {
    let left = this.parsePower()
    while (this.peek().type === 'STAR' || this.peek().type === 'SLASH') {
      const t = this.consume()
      left = {
        kind: 'binary',
        op: t.type === 'STAR' ? 'mul' : 'div',
        a: left,
        b: this.parsePower(),
      }
    }
    return left
  }

  private parsePower(): Node {
    const left = this.parseUnary()
    if (this.peek().type === 'CARET') {
      this.consume()
      return { kind: 'binary', op: 'pow', a: left, b: this.parsePower() }
    }
    return left
  }

  private parseUnary(): Node {
    if (this.peek().type === 'NOT') {
      this.consume()
      return { kind: 'not', expr: this.parseUnary() }
    }
    if (this.peek().type === 'PLUS') {
      this.consume()
      return { kind: 'unary', op: 'pos', expr: this.parseUnary() }
    }
    if (this.peek().type === 'MINUS') {
      this.consume()
      return { kind: 'unary', op: 'neg', expr: this.parseUnary() }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Node {
    const t = this.peek()
    if (t.type === 'LPAREN') {
      this.consume()
      const e = this.parseOr()
      this.expect('RPAREN')
      return e
    }
    if (t.type === 'NUMBER') {
      this.consume()
      return { kind: 'num', value: Number(t.value) }
    }
    if (t.type === 'STRING') {
      this.consume()
      return { kind: 'str', value: t.value }
    }
    if (t.type === 'IDENT') {
      this.consume()
      if (this.peek().type === 'LPAREN') {
        this.consume()
        const args: Node[] = []
        if (this.peek().type !== 'RPAREN') {
          while (true) {
            args.push(this.parseOr())
            if (this.peek().type !== 'COMMA')
              break
            this.consume()
          }
        }
        this.expect('RPAREN')
        return { kind: 'call', name: t.value, args }
      }
      return { kind: 'var', name: t.value }
    }
    throw new FilterCompileError(l10n.t('Unexpected token "{0}"', t.value), t.pos)
  }
}

// ---------- 表达式编译 ----------

/** 标量值 */
type Scalar = number | string | boolean

/** 值解析结果 */
type ValueResult
  = | { v: Scalar, missing: false }
    | { v: null, missing: true }

/** 值解析器 */
type Resolver = (rowIdx: number) => ValueResult

const MISSING_VALUE: ValueResult = { v: null, missing: true }

/**
 * 判断标量是否按筛选语义为真。
 */
function isTruthyValue(x: ValueResult): boolean {
  if (x.missing)
    return false
  if (typeof x.v === 'number')
    return x.v !== 0 && !Number.isNaN(x.v)
  if (typeof x.v === 'string')
    return x.v.length > 0
  return x.v
}

/**
 * 判断两个非缺失值是否相等。
 */
function scalarEquals(a: Scalar, b: Scalar): boolean {
  return a === b
}

/**
 * 判断值是否支持大小比较。
 */
function isComparable(v: Scalar): v is number | string {
  return typeof v === 'number' || typeof v === 'string'
}

/**
 * 比较两个非缺失值。
 */
function compareScalars(a: Scalar, b: Scalar, op: 'lt' | 'le' | 'gt' | 'ge'): boolean {
  if (!isComparable(a) || !isComparable(b) || typeof a !== typeof b)
    return false
  switch (op) {
    case 'lt': return a < b
    case 'le': return a <= b
    case 'gt': return a > b
    case 'ge': return a >= b
  }
}

/**
 * 将值转换为用于字符串函数的文本。
 */
function scalarToString(v: Scalar): string {
  return String(v)
}

/**
 * 读取数值参数。
 */
function expectNumber(v: Scalar, label: string): number {
  if (typeof v === 'number')
    return v
  throw new FilterCompileError(l10n.t('{0} expects numeric values', label))
}

/**
 * 检查函数参数个数。
 */
function expectArgCount(name: string, got: number, expected: number): void {
  if (got !== expected)
    throw new FilterCompileError(l10n.t('Function "{0}" expects {1} arguments, got {2}', name, expected, got))
}

/**
 * 检查函数参数个数下限。
 */
function expectMinArgCount(name: string, got: number, min: number): void {
  if (got < min)
    throw new FilterCompileError(l10n.t('Function "{0}" expects at least {1} arguments, got {2}', name, min, got))
}

/**
 * 将 Stata 数值日期/日期时间或日期字符串转换为 Date。
 */
function toDate(value: Scalar): Date | null {
  if (typeof value === 'number') {
    const stataEpoch = Date.UTC(1960, 0, 1)
    const ms = Math.abs(value) > 1_000_000
      ? stataEpoch + value
      : stataEpoch + value * 86_400_000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof value === 'string') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

/**
 * 编译值表达式，并记录引用到的变量名
 */
function compileVal(
  node: Node,
  data: DtaColumnar,
  referenced: Set<string>,
): Resolver {
  if (node.kind === 'num') {
    const v = node.value
    return () => ({ v, missing: false })
  }
  if (node.kind === 'str') {
    const v = node.value
    return () => ({ v, missing: false })
  }
  if (node.kind === 'unary') {
    const r = compileVal(node.expr, data, referenced)
    const label = node.op === 'neg' ? '-' : '+'
    return (i: number) => {
      const x = r(i)
      if (x.missing)
        return MISSING_VALUE
      const n = expectNumber(x.v, label)
      return { v: node.op === 'neg' ? -n : n, missing: false }
    }
  }
  if (node.kind === 'binary') {
    const ra = compileVal(node.a, data, referenced)
    const rb = compileVal(node.b, data, referenced)
    const opLabel: Record<'add' | 'sub' | 'mul' | 'div' | 'pow', string> = {
      add: '+',
      sub: '-',
      mul: '*',
      div: '/',
      pow: '^',
    }
    return (i: number) => {
      const A = ra(i)
      if (A.missing)
        return MISSING_VALUE
      const B = rb(i)
      if (B.missing)
        return MISSING_VALUE
      if (node.op === 'add' && typeof A.v === 'string' && typeof B.v === 'string')
        return { v: A.v + B.v, missing: false }
      const label = opLabel[node.op]
      const a = expectNumber(A.v, label)
      const b = expectNumber(B.v, label)
      const v = node.op === 'add'
        ? a + b
        : node.op === 'sub'
          ? a - b
          : node.op === 'mul'
            ? a * b
            : node.op === 'div'
              ? a / b
              : a ** b
      return Number.isFinite(v) ? { v, missing: false } : MISSING_VALUE
    }
  }
  if (node.kind === 'call') {
    return compileCall(node, data, referenced)
  }
  if (node.kind === 'var') {
    const arr = data.columns[node.name]
    const miss = data.missing[node.name]
    if (!arr) {
      throw new FilterCompileError(l10n.t('Unknown variable: {0}', node.name))
    }
    referenced.add(node.name)
    if (Array.isArray(arr)) {
      const sa = arr
      return (i: number) => miss[i] ? { v: null, missing: true } : { v: sa[i], missing: false }
    }
    else {
      const na = arr
      return (i: number) => miss[i] ? { v: null, missing: true } : { v: na[i], missing: false }
    }
  }
  throw new FilterCompileError(l10n.t('Expected a value, got expression of kind "{0}"', node.kind))
}

/**
 * 编译内置函数调用。
 */
function compileCall(
  node: Extract<Node, { kind: 'call' }>,
  data: DtaColumnar,
  referenced: Set<string>,
): Resolver {
  const name = node.name.toLowerCase()
  const args = node.args.map(arg => compileVal(arg, data, referenced))

  if (name === 'missing') {
    expectMinArgCount(name, args.length, 1)
    return (i: number) => ({ v: args.some(arg => arg(i).missing), missing: false })
  }

  if (name === 'inlist') {
    expectMinArgCount(name, args.length, 2)
    return (i: number) => {
      const needle = args[0](i)
      if (needle.missing)
        return { v: false, missing: false }
      for (let k = 1; k < args.length; k++) {
        const item = args[k](i)
        if (!item.missing && scalarEquals(needle.v, item.v))
          return { v: true, missing: false }
      }
      return { v: false, missing: false }
    }
  }

  if (name === 'inrange') {
    expectArgCount(name, args.length, 3)
    return (i: number) => {
      const value = args[0](i)
      const lo = args[1](i)
      const hi = args[2](i)
      if (value.missing || lo.missing || hi.missing)
        return { v: false, missing: false }
      return {
        v: compareScalars(value.v, lo.v, 'ge') && compareScalars(value.v, hi.v, 'le'),
        missing: false,
      }
    }
  }

  if (name === 'contains') {
    expectArgCount(name, args.length, 2)
    return (i: number) => {
      const text = args[0](i)
      const part = args[1](i)
      if (text.missing || part.missing)
        return { v: false, missing: false }
      return { v: scalarToString(text.v).includes(scalarToString(part.v)), missing: false }
    }
  }

  if (name === 'strpos') {
    expectArgCount(name, args.length, 2)
    return (i: number) => {
      const text = args[0](i)
      const part = args[1](i)
      if (text.missing || part.missing)
        return { v: 0, missing: false }
      const pos = scalarToString(text.v).indexOf(scalarToString(part.v))
      return { v: pos < 0 ? 0 : pos + 1, missing: false }
    }
  }

  if (name === 'regexm') {
    expectArgCount(name, args.length, 2)
    const regexCache = new Map<string, RegExp>()
    const getRegex = (pattern: string) => {
      let re = regexCache.get(pattern)
      if (!re) {
        try {
          re = new RegExp(pattern)
        }
        catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          throw new FilterCompileError(l10n.t('Invalid regular expression: {0}', msg))
        }
        regexCache.set(pattern, re)
      }
      return re
    }
    return (i: number) => {
      const text = args[0](i)
      const pattern = args[1](i)
      if (text.missing || pattern.missing)
        return { v: false, missing: false }
      return { v: getRegex(scalarToString(pattern.v)).test(scalarToString(text.v)), missing: false }
    }
  }

  if (name === 'lower' || name === 'upper' || name === 'trim' || name === 'length') {
    expectArgCount(name, args.length, 1)
    return (i: number) => {
      const value = args[0](i)
      if (value.missing)
        return MISSING_VALUE
      const text = scalarToString(value.v)
      if (name === 'lower')
        return { v: text.toLowerCase(), missing: false }
      if (name === 'upper')
        return { v: text.toUpperCase(), missing: false }
      if (name === 'trim')
        return { v: text.trim(), missing: false }
      return { v: text.length, missing: false }
    }
  }

  if (name === 'year' || name === 'month' || name === 'day') {
    expectArgCount(name, args.length, 1)
    return (i: number) => {
      const value = args[0](i)
      if (value.missing)
        return MISSING_VALUE
      const date = toDate(value.v)
      if (!date)
        return MISSING_VALUE
      if (name === 'year')
        return { v: date.getUTCFullYear(), missing: false }
      if (name === 'month')
        return { v: date.getUTCMonth() + 1, missing: false }
      return { v: date.getUTCDate(), missing: false }
    }
  }

  throw new FilterCompileError(l10n.t('Unknown function: {0}', node.name))
}

/**
 * 编译布尔表达式节点
 */
function compileBool(
  node: Node,
  data: DtaColumnar,
  referenced: Set<string>,
): CompiledFilter {
  if (node.kind === 'not') {
    const inner = compileBool(node.expr, data, referenced)
    return i => !inner(i)
  }
  if (node.kind === 'and') {
    const a = compileBool(node.a, data, referenced)
    const b = compileBool(node.b, data, referenced)
    return i => a(i) && b(i)
  }
  if (node.kind === 'or') {
    const a = compileBool(node.a, data, referenced)
    const b = compileBool(node.b, data, referenced)
    return i => a(i) || b(i)
  }
  if (node.kind === 'cmp') {
    const ra = compileVal(node.a, data, referenced)
    const rb = compileVal(node.b, data, referenced)
    const op = node.op
    return (i) => {
      const A = ra(i)
      if (A.missing)
        return false
      const B = rb(i)
      if (B.missing)
        return false
      const va = A.v
      const vb = B.v
      switch (op) {
        case 'eq': return va === vb
        case 'neq': return va !== vb
        case 'lt':
        case 'le':
        case 'gt':
        case 'ge': return compareScalars(va, vb, op)
      }
    }
  }
  // 顶层值表达式按非零、非空、非缺失、布尔 true 判断真值。
  const r = compileVal(node, data, referenced)
  return i => isTruthyValue(r(i))
}

/**
 * 编译过滤表达式
 */
export function compileFilter(expression: string, data: DtaColumnar): CompileResult {
  const trimmed = expression.trim()
  if (!trimmed) {
    return { fn: () => true, referencedVars: [] }
  }
  // 以数据集对象为弱键缓存编译结果
  let dataCache = compileCache.get(data)
  if (dataCache) {
    const cached = dataCache.get(trimmed)
    if (cached)
      return cached
  }
  else {
    dataCache = new Map()
    compileCache.set(data, dataCache)
  }

  const tokens = tokenize(trimmed)
  const ast = new Parser(tokens).parse()
  const referenced = new Set<string>()
  const fn = compileBool(ast, data, referenced)
  const result: CompileResult = { fn, referencedVars: [...referenced] }
  dataCache.set(trimmed, result)
  return result
}
