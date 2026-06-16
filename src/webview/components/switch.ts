/**
 * Webview 通用开关 HTML 组件。
 *
 * 只负责静态结构；选中状态和业务行为由调用方脚本接管。
 */

// ---------- 类型 ----------

/** 开关模板参数 */
interface SwitchTemplateOptions {
  /** 输入框 id */
  id: string
  /** 外层容器 id */
  wrapperId?: string
  /** 可见文本标签 */
  label: string
  /** 鼠标悬停提示文本 */
  title?: string
  /** 初始选中状态 */
  checked?: boolean
}

// ---------- 渲染 ----------

/**
 * 渲染基于 checkbox 的开关
 */
export function renderSwitch(options: SwitchTemplateOptions): string {
  const wrapperId = options.wrapperId ? ` id="${options.wrapperId}"` : ''
  const title = options.title ? ` title="${options.title}"` : ''
  const checked = options.checked ? ' checked' : ''

  return `
    <div${wrapperId} class="toolbar-switch"${title}>
      <div class="switch">
        <input class="switch-input" id="${options.id}" type="checkbox"${checked}>
        <label class="switch-label" for="${options.id}"></label>
      </div>
      <label class="toolbar-switch-label" for="${options.id}">${options.label}</label>
    </div>
  `
}
