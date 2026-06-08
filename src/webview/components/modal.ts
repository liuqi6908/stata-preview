/**
 * Webview 通用模态框 HTML 组件。
 *
 * 只负责静态结构；打开、关闭和 ESC 行为由 media/components/modal.js 接管。
 */

import { icon } from '../icons'

/** 模态框模板参数。 */
export interface ModalTemplateOptions {
  /** 模态框根节点 id。 */
  id: string
  /** 标题文本；如果 titleId 存在，可传空字符串并由前端动态填充。 */
  title: string
  /** 标题节点 id。 */
  titleId?: string
  /** 内容区 id。 */
  bodyId: string
  /** 内容区初始 HTML。 */
  bodyHtml?: string
  /** 关闭按钮 id，保留给旧选择器或测试使用。 */
  closeButtonId: string
  /** 关闭按钮提示文本。 */
  closeTitle: string
}

/**
 * 渲染通用模态框。
 */
export function renderModal(options: ModalTemplateOptions): string {
  const titleId = options.titleId ?? `${options.id}-title`
  const titleAttrs = ` id="${titleId}"`
  return `
    <div id="${options.id}" class="modal">
      <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
        <div class="modal-header">
          <h2${titleAttrs}>${options.title}</h2>
          <button id="${options.closeButtonId}" class="icon" data-modal-close="${options.id}" title="${options.closeTitle}">
            ${icon('close')}
          </button>
        </div>
        <div id="${options.bodyId}" class="modal-body">${options.bodyHtml ?? ''}</div>
      </div>
    </div>
  `
}
