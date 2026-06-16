/**
 * Webview 通用工具函数。
 *
 * 这里只放与具体业务状态无关的文本转义、格式化和值判断等工具。
 */

// ---------- 文本转义 ----------

/**
 * 转义 HTML 文本
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  })[c])
}

// ---------- 格式化 ----------

/**
 * 格式化整数
 */
function formatInt(n) {
  return n.toLocaleString()
}

/**
 * 格式化统计数值
 */
function formatNum(n) {
  if (n === null || n === undefined || Number.isNaN(n))
    return '—'
  if (!Number.isFinite(n))
    return String(n)
  if (Number.isInteger(n) && Math.abs(n) < 1e15)
    return n.toLocaleString()
  const abs = Math.abs(n)
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e9))
    return n.toExponential(3)
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

/**
 * 格式化文件大小
 */
function formatBytes(bytes, unknownText = '') {
  if (!Number.isFinite(bytes) || bytes < 0)
    return unknownText
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < FILE_SIZE_UNITS.length - 1) {
    value /= 1024
    unitIndex++
  }
  const formatted = unitIndex === 0
    ? formatInt(value)
    : value.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return `${formatted} ${FILE_SIZE_UNITS[unitIndex]}`
}

/**
 * 格式化 l10n 模板
 */
function formatL10n(template, ...args) {
  return String(template).replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? '')
}

// ---------- 值判断 ----------

/**
 * 判断单元格是否为真实缺失值
 */
function isMissingCellValue(value) {
  return value === null || value === undefined
}

/**
 * 判断单元格是否为仅包含空白字符的字符串
 */
function isWhitespaceOnlyString(value) {
  return typeof value === 'string' && value.trim().length === 0
}

// ---------- 空白字符展示 ----------

/**
 * 将纯空白字符串转换为可见标记
 */
function formatWhitespacePreview(value) {
  const chars = Array.from(value)
  if (chars.length === 0)
    return ''
  if (chars.every(ch => ch === chars[0]))
    return `${whitespaceSymbol(chars[0])}×${chars.length}`
  return chars.map(whitespaceSymbol).join('')
}

/**
 * 将单个空白字符转换为可见符号
 */
function whitespaceSymbol(ch) {
  if (ch === ' ')
    return '␠'
  if (ch === '\t')
    return '⇥'
  if (ch === '\n')
    return '↵'
  if (ch === '\r')
    return '␍'
  return `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
}
