/**
 * Filter expression compiler.
 *
 * Compiles a Stata-flavored expression like
 *     edad > 30 & (treatment == 1 | y1 < 1000)
 * into a function `(rowIdx) => boolean` that operates directly on a DtaColumnar's
 * TypedArrays + missing masks.
 *
 * Operators (in precedence order, low to high):
 *   |        OR       (also accepts `||`)
 *   &        AND      (also accepts `&&`)
 *   ! / not  NOT (unary)
 *   ==, !=, ~=, <, <=, >, >=     comparisons
 *
 * Operands:
 *   - numeric literals: 12, -3.5, 1e6
 *   - string literals: "foo" or 'foo'
 *   - bare variable names (must match a column header)
 *   - parenthesized sub-expressions
 *
 * Missing semantics: any comparison involving a missing operand is FALSE
 * (Stata's behavior is more nuanced — missing > all numbers — but for filtering
 * "give me rows where edad > 30" it's almost never what users want to include
 * missings, so we exclude them).
 */

import type { DtaColumnar } from './parser'

export type CompiledFilter = (rowIdx: number) => boolean

export interface CompileResult {
  fn: CompiledFilter
  referencedVars: string[]
}

export class FilterCompileError extends Error {
  constructor(message: string, public position?: number) {
    super(message)
  }
}

// ---------- Tokenizer ----------

type TokenType
  = | 'NUMBER' | 'STRING' | 'IDENT'
    | 'LPAREN' | 'RPAREN'
    | 'AND' | 'OR' | 'NOT'
    | 'EQ' | 'NEQ' | 'LT' | 'LE' | 'GT' | 'GE'
    | 'EOF'

interface Token {
  type: TokenType
  value: string
  pos: number
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    const start = i

    // Strings
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
        throw new FilterCompileError('Unterminated string literal', start)
      i++ // closing quote
      tokens.push({ type: 'STRING', value: s, pos: start })
      continue
    }

    // Numbers (including leading minus is handled at parse-time as unary)
    if (c >= '0' && c <= '9') {
      let s = ''
      while (i < src.length && /[0-9.e+\-]/i.test(src[i])) {
        // Stop if + or - is not part of an exponent.
        if ((src[i] === '+' || src[i] === '-') && !(s.endsWith('e') || s.endsWith('E')))
          break
        s += src[i++]
      }
      const n = Number(s)
      if (Number.isNaN(n))
        throw new FilterCompileError(`Invalid number: ${s}`, start)
      tokens.push({ type: 'NUMBER', value: s, pos: start })
      continue
    }

    // Operators
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

    // Identifiers (variable names). Stata-valid: letters, digits, _, must not start with digit.
    if (/[A-Z_]/i.test(c)) {
      let s = ''
      while (i < src.length && /\w/.test(src[i])) s += src[i++]
      if (s === 'and') {
        tokens.push({ type: 'AND', value: 'and', pos: start })
        continue
      }
      if (s === 'or') {
        tokens.push({ type: 'OR', value: 'or', pos: start })
        continue
      }
      if (s === 'not') {
        tokens.push({ type: 'NOT', value: 'not', pos: start })
        continue
      }
      tokens.push({ type: 'IDENT', value: s, pos: start })
      continue
    }

    throw new FilterCompileError(`Unexpected character '${c}'`, start)
  }
  tokens.push({ type: 'EOF', value: '', pos: src.length })
  return tokens
}

// ---------- Parser → AST ----------

type Node
  = | { kind: 'num', value: number }
    | { kind: 'str', value: string }
    | { kind: 'var', name: string }
    | { kind: 'not', expr: Node }
    | { kind: 'cmp', op: 'eq' | 'neq' | 'lt' | 'le' | 'gt' | 'ge', a: Node, b: Node }
    | { kind: 'and', a: Node, b: Node }
    | { kind: 'or', a: Node, b: Node }

class Parser {
  private p = 0
  constructor(private tokens: Token[]) { }

  private peek(): Token { return this.tokens[this.p] }
  private consume(): Token { return this.tokens[this.p++] }
  private expect(type: TokenType): Token {
    const t = this.peek()
    if (t.type !== type)
      throw new FilterCompileError(`Expected ${type}, got ${t.type} '${t.value}'`, t.pos)
    return this.consume()
  }

  parse(): Node {
    const expr = this.parseOr()
    if (this.peek().type !== 'EOF') {
      const t = this.peek()
      throw new FilterCompileError(`Unexpected token '${t.value}'`, t.pos)
    }
    return expr
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
    const a = this.parseUnary()
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
      const b = this.parseUnary()
      return { kind: 'cmp', op: cmpMap[t.type], a, b }
    }
    return a
  }

  private parseUnary(): Node {
    if (this.peek().type === 'NOT') {
      this.consume()
      return { kind: 'not', expr: this.parseUnary() }
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
      return { kind: 'var', name: t.value }
    }
    throw new FilterCompileError(`Unexpected token '${t.value}'`, t.pos)
  }
}

// ---------- Compiler: AST → CompiledFilter ----------

type Resolver = (rowIdx: number) =>
  | { v: number | string, missing: false }
  | { v: null, missing: true }

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
  if (node.kind === 'var') {
    const arr = data.columns[node.name]
    const miss = data.missing[node.name]
    if (!arr) {
      throw new FilterCompileError(`Unknown variable: ${node.name}`)
    }
    referenced.add(node.name)
    const isString = Array.isArray(arr)
    if (isString) {
      const sa = arr as string[]
      return (i: number) => miss[i] ? { v: null, missing: true } : { v: sa[i], missing: false }
    }
    else {
      const na = arr as { [k: number]: number }
      return (i: number) => miss[i] ? { v: null, missing: true } : { v: na[i] as number, missing: false }
    }
  }
  throw new FilterCompileError(`Expected a value, got expression of kind '${node.kind}'`)
}

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
      const va = A.v as any
      const vb = B.v as any
      switch (op) {
        case 'eq': return va === vb
        case 'neq': return va !== vb
        case 'lt': return va < vb
        case 'le': return va <= vb
        case 'gt': return va > vb
        case 'ge': return va >= vb
      }
    }
  }
  // A bare var/num/str expression at the top level: truthy if non-zero / non-empty / not missing.
  if (node.kind === 'num') {
    const truthy = node.value !== 0
    return () => truthy
  }
  if (node.kind === 'str') {
    const truthy = node.value.length > 0
    return () => truthy
  }
  if (node.kind === 'var') {
    const r = compileVal(node, data, referenced)
    return (i) => {
      const x = r(i)
      if (x.missing)
        return false
      if (typeof x.v === 'number')
        return x.v !== 0
      return (x.v as string).length > 0
    }
  }
  // Unreachable
  throw new FilterCompileError(`Cannot evaluate node`)
}

/**
 * Public entry point. Throws FilterCompileError on syntax/semantic errors.
 */
export function compileFilter(expression: string, data: DtaColumnar): CompileResult {
  const trimmed = expression.trim()
  if (!trimmed) {
    return { fn: () => true, referencedVars: [] }
  }
  const tokens = tokenize(trimmed)
  const ast = new Parser(tokens).parse()
  const referenced = new Set<string>()
  const fn = compileBool(ast, data, referenced)
  return { fn, referencedVars: [...referenced] }
}
