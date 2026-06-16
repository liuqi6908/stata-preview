/**
 * Webview 脚本统一入口。
 *
 * 子脚本按职责拆分到 scripts/ 目录下。
 * 它们是经典脚本并共享顶层状态，因此这里必须串行加载并保持顺序稳定。
 */

(function () {
  const scriptPaths = [
    'components/modal.js',
    'scripts/core/constants.js',
    'scripts/core/utils.js',
    'scripts/core/state.js',
    'scripts/core/host.js',
    'scripts/core/dom.js',
    'scripts/app/loading.js',
    'scripts/features/pagination.js',
    'scripts/features/filter.js',
    'scripts/features/menus.js',
    'scripts/features/table.js',
    'scripts/features/sidebar.js',
    'scripts/features/toolbar.js',
    'scripts/features/fileInfo.js',
    'scripts/features/dictionary.js',
    'scripts/features/explorer.js',
    'scripts/features/resize.js',
  ]

  const entryScript = document.currentScript
  const entryUrl = entryScript && entryScript.src ? entryScript.src : document.baseURI
  const nonce = entryScript && entryScript.nonce ? entryScript.nonce : ''

  void startWebview().catch((error) => {
    console.error('Webview script bootstrap failed', error)
    renderScriptLoadError(error)
  })

  /**
   * 加载所有功能脚本后完成启动初始化
   */
  async function startWebview() {
    await loadWebviewScripts()
    initializeWebview()
    vscode.postMessage({ command: 'ready' })
  }

  /**
   * 串行加载子脚本，保证经典脚本共享状态的初始化顺序
   */
  async function loadWebviewScripts() {
    for (const scriptPath of scriptPaths)
      await loadScript(scriptPath)
  }

  /**
   * 加载单个子脚本
   */
  function loadScript(scriptPath) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = new URL(scriptPath, entryUrl).toString()
      script.async = false
      if (nonce)
        script.nonce = nonce
      script.addEventListener('load', resolve, { once: true })
      script.addEventListener('error', () => reject(new Error(`Failed to load ${scriptPath}`)), { once: true })
      document.head.appendChild(script)
    })
  }

  /**
   * 初始化入口级状态和一次性事件绑定
   */
  function initializeWebview() {
    pageSizeSelect.value = String(pageSize)
    initResizeHandle()
    initRowDetailResizeHandle()
    initRowDetailColumnResize()
    syncRowDetailColumnLayout()
    updateValueLabelModeControl()
    updateSidebarToggle()
    updateSidebarPositionButton()
  }

  /**
   * 入口脚本加载失败时，复用初始加载层给出可见错误
   */
  function renderScriptLoadError(error) {
    // 子脚本可能尚未加载到 dom.js，这里的兜底错误不能依赖共享 DOM 引用
    const loadingEl = document.getElementById('initial-loading')
    if (!loadingEl)
      return

    const card = loadingEl.querySelector('#initial-loading-card')
    if (!card)
      return

    const l10n = typeof bootstrap === 'object' && bootstrap ? bootstrap.l10n : null
    const title = l10n ? l10n.couldNotOpenFile : 'Could not open file'
    const titleEl = document.createElement('h2')
    titleEl.textContent = title
    const messageEl = document.createElement('div')
    messageEl.id = 'loading-error-message'
    messageEl.textContent = error.message || String(error)
    card.classList.add('error')
    card.replaceChildren(titleEl, messageEl)
  }
})()
