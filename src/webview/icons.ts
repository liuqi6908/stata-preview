/**
 * Webview 内联图标。
 *
 * Webview 不能直接使用 VS Code 产品图标 API，这里集中维护少量 SVG，
 * 便于 HTML 模板复用和后续替换。
 */

/** Webview 图标名称。 */
export type WebviewIcon
  = | 'help'
    | 'refresh'
    | 'download'
    | 'firstPage'
    | 'prevPage'
    | 'nextPage'
    | 'lastPage'
    | 'close'

/**
 * 渲染指定图标的 SVG 字符串。
 */
export function icon(name: WebviewIcon, size = 18): string {
  const d = iconPath(name)
  if (name === 'help') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24">
      <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">${d}</g>
    </svg>`
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24">
    <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${d}"/>
  </svg>`
}

/**
 * 返回图标 path 内容。
 */
function iconPath(name: WebviewIcon): string {
  switch (name) {
    case 'help':
      return '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0-18 0m9 4v.01"/><path d="M12 13a2 2 0 0 0 .914-3.782a1.98 1.98 0 0 0-2.414.483"/>'
    case 'refresh':
      return 'M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4m-4 4a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4'
    case 'download':
      return 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 11l5 5l5-5m-5-7v12'
    case 'firstPage':
      return 'm11 7l-5 5l5 5m6-10l-5 5l5 5'
    case 'prevPage':
      return 'm15 6l-6 6l6 6'
    case 'nextPage':
      return 'm9 6l6 6l-6 6'
    case 'lastPage':
      return 'm7 7l5 5l-5 5m6-10l5 5l-5 5'
    case 'close':
      return 'M18 6L6 18M6 6l12 12'
  }
}
