/**
 * Webview 模态框控制器。
 *
 * 统一管理弹窗的显示、隐藏、点击遮罩关闭和关闭按钮行为。
 */

(function () {
  /**
   * 单个模态框实例。
   */
  class ModalController {
    constructor(root) {
      this.root = root
      this.id = root.id
      this.bindEvents()
    }

    /**
     * 显示弹窗。
     */
    show() {
      this.root.classList.add('show')
    }

    /**
     * 隐藏弹窗。
     */
    hide() {
      this.root.classList.remove('show')
    }

    /**
     * 当前弹窗是否打开。
     */
    isOpen() {
      return this.root.classList.contains('show')
    }

    /**
     * 绑定关闭按钮和遮罩点击。
     */
    bindEvents() {
      this.root.querySelectorAll(`[data-modal-close="${this.id}"]`).forEach((button) => {
        button.addEventListener('click', () => this.hide())
      })
      this.root.addEventListener('click', (event) => {
        if (event.target === this.root)
          this.hide()
      })
    }
  }

  /**
   * 创建一组弹窗控制器。
   */
  function createRegistry(ids) {
    const modalMap = new Map()
    ids.forEach((id) => {
      const root = document.getElementById(id)
      if (root)
        modalMap.set(id, new ModalController(root))
    })

    return {
      get(id) {
        return modalMap.get(id)
      },
      closeOpen() {
        for (const modal of modalMap.values()) {
          if (modal.isOpen()) {
            modal.hide()
            return true
          }
        }
        return false
      },
    }
  }

  window.modals = {
    createRegistry,
  }
})()
