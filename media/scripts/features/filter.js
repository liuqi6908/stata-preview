/**
 * 通用筛选与筛选输入助手。
 */

// ---------- 主筛选初始化 ----------

initializeMainFilter()

/**
 * 初始化主筛选输入框和筛选助手
 */
function initializeMainFilter() {
  mainFilterAssistTarget = createFilterAssistTarget({
    input: searchInput,
    panel: filterAssist,
    clearError: clearFilterError,
    onApply: applyFilterAndReload,
    updateControls: updateFilterMemoryControls,
  })
  filterAssistState = loadFilterAssistState()
  updateFilterMemoryControls()
  bindMainFilterEvents()
}

/**
 * 绑定主筛选输入框事件
 */
function bindMainFilterEvents() {
  searchInput.addEventListener('keydown', e => handleFilterInputKeydown(mainFilterAssistTarget, e))
  searchInput.addEventListener('input', handleMainFilterInput)
  searchInput.addEventListener('click', () => updateFilterAutocomplete(mainFilterAssistTarget, false))
  searchApply.addEventListener('click', applyFilterAndReload)
  searchClear.addEventListener('click', handleMainFilterClearClick)
  filterTools.addEventListener('click', handleFilterToolsClick)
}

/**
 * 主筛选输入变化后刷新助手状态
 */
function handleMainFilterInput() {
  clearFilterError()
  updateFilterMemoryControls()
  updateFilterAutocomplete(mainFilterAssistTarget, false)
}

/**
 * 清空主筛选并重新加载页面
 */
function handleMainFilterClearClick() {
  searchInput.value = ''
  filterQuery = ''
  hideFilterAssist(mainFilterAssistTarget)
  updateFilterMemoryControls()
  applyFilterAndReload()
}

/**
 * 打开主筛选工具菜单
 */
function handleFilterToolsClick(e) {
  e.stopPropagation()
  showFilterToolsMenu(mainFilterAssistTarget, filterTools)
}

// ---------- 主筛选应用 ----------

/**
 * 应用通用过滤表达式并回到第一页
 */
async function applyFilterAndReload() {
  filterQuery = searchInput.value
  clearFilterError()
  hideFilterAssist(mainFilterAssistTarget)
  updateFilterMemoryControls()
  showOverlay(true, bootstrap.l10n.applyingFilter)
  try {
    const spec = filterQuery.trim() ? { query: filterQuery } : null
    await postLatest('filter', 'setFilter', { spec })
    if (spec)
      rememberFilterExpression(filterQuery)
    await loadPage(0)
  }
  catch (e) {
    if (e.stale)
      return
    showFilterError(e.message || String(e))
    showOverlay(false)
  }
}

/**
 * 清除通用过滤错误提示
 */
function clearFilterError() {
  searchInput.classList.remove('error')
  filterError.textContent = ''
}

/**
 * 显示通用过滤错误提示
 */
function showFilterError(msg) {
  searchInput.classList.add('error')
  filterError.textContent = msg
}

// ---------- 输入助手目标 ----------

/**
 * 创建可复用的筛选输入助手目标
 */
function createFilterAssistTarget(options) {
  return {
    input: options.input,
    panel: options.panel,
    clearError: options.clearError || (() => {}),
    onApply: options.onApply || (() => {}),
    updateControls: options.updateControls || (() => {}),
    mode: null,
    items: [],
    activeIndex: -1,
  }
}

/**
 * 处理筛选输入框的快捷键
 */
function handleFilterInputKeydown(target, e) {
  if (isFilterAssistOpen(target)) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      moveFilterAssistActive(target, e.key === 'ArrowDown' ? 1 : -1)
      e.preventDefault()
      return
    }
    if (e.key === 'Tab' && target.activeIndex >= 0) {
      acceptFilterAssistItem(target, target.items[target.activeIndex])
      e.preventDefault()
      return
    }
    if (e.key === 'Enter') {
      if (target.mode !== 'suggestions' && target.activeIndex >= 0)
        acceptFilterAssistItem(target, target.items[target.activeIndex])
      else
        target.onApply()
      e.preventDefault()
      return
    }
    if (e.key === 'Escape') {
      hideFilterAssist(target)
      e.preventDefault()
      return
    }
  }

  if (e.key === 'Enter') {
    target.onApply()
    e.preventDefault()
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
    updateFilterAutocomplete(target, true)
    e.preventDefault()
  }
}

// ---------- 补全上下文 ----------

/**
 * 是否正在显示筛选助手
 */
function isFilterAssistOpen(target = activeFilterAssistTarget) {
  return !!target && !!target.mode && !target.panel.hidden
}

/**
 * 根据光标位置刷新变量和函数补全
 */
function updateFilterAutocomplete(target, force, ignoreFocus = false) {
  if (!meta || (!ignoreFocus && document.activeElement !== target.input))
    return
  const context = getFilterCompletionContext(target, force)
  if (!context) {
    hideFilterAssist(target)
    return
  }

  const items = buildFilterCompletionItems(context)
  if (items.length === 0 && !force) {
    hideFilterAssist(target)
    return
  }
  showFilterAssistPanel(target, 'suggestions', bootstrap.l10n.FilterSuggestions, items, bootstrap.l10n.NoData)
}

/**
 * 获取当前补全上下文
 */
function getFilterCompletionContext(target, force) {
  const value = target.input.value
  const cursor = getFilterInputSelection(target.input).start
  if (isCursorInsideString(value, cursor))
    return null

  let start = cursor
  while (start > 0 && isFilterIdentifierChar(value[start - 1]))
    start--
  let end = cursor
  while (end < value.length && isFilterIdentifierChar(value[end]))
    end++

  const prefix = value.slice(start, cursor)
  if (!force && prefix.length === 0)
    return null
  return { prefix, replaceStart: start, replaceEnd: end }
}

/**
 * 筛选表达式标识符字符
 */
function isFilterIdentifierChar(char) {
  return /[\p{L}\p{N}_]/u.test(char)
}

/**
 * 简单判断光标是否位于字符串字面量中
 */
function isCursorInsideString(value, cursor) {
  let quote = ''
  for (let i = 0; i < cursor; i++) {
    const char = value[i]
    if (char !== '"' && char !== '\'')
      continue
    if (i > 0 && value[i - 1] === '\\')
      continue
    if (!quote)
      quote = char
    else if (quote === char)
      quote = ''
  }
  return !!quote
}

// ---------- 补全候选 ----------

/**
 * 构建变量名与函数候选项
 */
function buildFilterCompletionItems(context) {
  const prefix = context.prefix.toLowerCase()
  const memoryItems = buildFilterMemoryCompletionItems(prefix)
  const variableItems = []
  const functionItems = []

  if (meta) {
    for (let i = 0; i < meta.headers.length; i++) {
      const header = meta.headers[i]
      const label = meta.labels[i] || ''
      const headerText = header.toLowerCase()
      const searchText = `${header} ${label}`.toLowerCase()
      if (prefix && !headerText.startsWith(prefix) && !searchText.includes(prefix))
        continue
      variableItems.push({
        kind: 'variable',
        label: header,
        detail: label,
        badge: bootstrap.l10n.VariableSuggestion,
        insertText: header,
        replaceStart: context.replaceStart,
        replaceEnd: context.replaceEnd,
        score: headerText.startsWith(prefix) ? 0 : 1,
        index: i,
      })
    }
  }

  for (const fn of FILTER_FUNCTION_COMPLETIONS) {
    const fnText = `${fn.name} ${fn.signature}`.toLowerCase()
    if (prefix && !fn.name.startsWith(prefix) && !fnText.includes(prefix))
      continue
    functionItems.push({
      kind: 'function',
      label: fn.signature,
      detail: fn.description,
      badge: bootstrap.l10n.FunctionSuggestion,
      insertText: fn.template,
      cursorOffset: fn.cursorOffset,
      replaceStart: context.replaceStart,
      replaceEnd: context.replaceEnd,
      score: fn.name.startsWith(prefix) ? 0 : 1,
      sortName: fn.name,
    })
  }

  variableItems.sort((a, b) => a.score - b.score || a.index - b.index)
  functionItems.sort((a, b) => a.score - b.score || a.sortName.localeCompare(b.sortName))
  return memoryItems.concat(variableItems.slice(0, 8), functionItems.slice(0, 8))
}

/**
 * 构建历史和常用筛选补全候选
 */
function buildFilterMemoryCompletionItems(prefix) {
  const saved = filterAssistState.saved
    .filter(expr => filterMemoryMatches(expr, prefix))
    .map(expr => createFilterMemoryItem('saved', expr, prefix))
    .sort(compareFilterMemoryItems)
    .slice(0, 4)
  const savedSet = new Set(filterAssistState.saved)
  const history = filterAssistState.history
    .filter(expr => !savedSet.has(expr) && filterMemoryMatches(expr, prefix))
    .map(expr => createFilterMemoryItem('history', expr, prefix))
    .sort(compareFilterMemoryItems)
    .slice(0, 4)
  return saved.concat(history)
}

/**
 * 判断历史/常用筛选是否匹配当前补全前缀
 */
function filterMemoryMatches(expr, prefix) {
  return !prefix || expr.toLowerCase().includes(prefix)
}

/**
 * 构建历史/常用筛选候选项
 */
function createFilterMemoryItem(kind, expr, prefix) {
  const text = expr.toLowerCase()
  return {
    kind,
    label: expr,
    detail: '',
    expression: expr,
    badge: kind === 'history' ? bootstrap.l10n.FilterHistory : bootstrap.l10n.SavedFilters,
    score: prefix && text.startsWith(prefix) ? 0 : 1,
  }
}

/**
 * 排序历史/常用筛选候选项
 */
function compareFilterMemoryItems(a, b) {
  return a.score - b.score
}

/**
 * 渲染历史或常用筛选列表
 */
function showFilterMemoryPanel(target, mode, title, expressions, emptyMessage) {
  const items = expressions.map(expr => ({
    kind: mode,
    label: expr,
    detail: '',
    expression: expr,
    badge: mode === 'history' ? bootstrap.l10n.FilterHistory : bootstrap.l10n.SavedFilters,
  }))
  showFilterAssistPanel(target, mode, title, items, emptyMessage)
}

// ---------- 面板渲染 ----------

/**
 * 显示筛选助手面板
 */
function showFilterAssistPanel(target, mode, title, items, emptyMessage) {
  if (activeFilterAssistTarget && activeFilterAssistTarget !== target)
    hideFilterAssist(activeFilterAssistTarget)
  activeFilterAssistTarget = target
  target.mode = mode
  target.items = items
  target.activeIndex = items.length > 0 ? 0 : -1
  target.panel.innerHTML = ''

  const titleEl = document.createElement('div')
  titleEl.className = 'filter-assist-title'
  const titleText = document.createElement('span')
  titleText.textContent = title
  titleEl.appendChild(titleText)
  const titleAction = buildFilterAssistTitleAction(target, mode, items.length)
  if (titleAction)
    titleEl.appendChild(titleAction)
  target.panel.appendChild(titleEl)

  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'filter-assist-empty'
    empty.textContent = emptyMessage
    target.panel.appendChild(empty)
  }
  else {
    const list = document.createElement('div')
    list.className = 'filter-assist-list'
    items.forEach((item, index) => list.appendChild(buildFilterAssistRow(target, item, index)))
    target.panel.appendChild(list)
    syncFilterAssistActiveRow(target)
  }

  target.panel.hidden = false
}

/**
 * 构建筛选助手候选行
 */
function buildFilterAssistRow(target, item, index) {
  const row = document.createElement('div')
  row.className = 'filter-assist-row'
  if (!item.detail)
    row.classList.add('single-line')
  row.dataset.index = String(index)

  const pick = document.createElement('div')
  pick.className = 'filter-assist-pick'
  pick.title = item.kind === 'history' || item.kind === 'saved'
    ? `${bootstrap.l10n.UseFilter}: ${item.label}`
    : item.label
  pick.addEventListener('mousemove', () => setFilterAssistActive(target, index, false))
  pick.addEventListener('click', () => acceptFilterAssistItem(target, item))

  const main = document.createElement('span')
  main.className = 'filter-assist-main'
  main.textContent = item.label
  pick.appendChild(main)

  if (item.detail) {
    const detail = document.createElement('span')
    detail.className = 'filter-assist-detail'
    detail.textContent = item.detail
    pick.appendChild(detail)
  }

  if (item.badge) {
    const badge = document.createElement('span')
    badge.className = 'filter-assist-badge'
    badge.textContent = item.badge
    pick.appendChild(badge)
  }

  row.appendChild(pick)
  const actions = buildFilterAssistActions(target, item)
  if (actions)
    row.appendChild(actions)
  return row
}

/**
 * 构建历史和常用筛选行的操作按钮
 */
function buildFilterAssistActions(target, item) {
  if (item.kind !== 'history' && item.kind !== 'saved')
    return null

  const actions = document.createElement('div')
  actions.className = 'filter-assist-actions'
  if (item.kind === 'history') {
    const saved = filterAssistState.saved.includes(item.expression)
    const action = createFilterAssistAction(saved ? bootstrap.l10n.RemoveSavedFilter : bootstrap.l10n.Save)
    action.title = saved ? bootstrap.l10n.RemoveSavedFilter : bootstrap.l10n.SaveFilter
    action.addEventListener('click', (e) => {
      e.stopPropagation()
      if (saved)
        deleteSavedFilter(item.expression)
      else
        addSavedFilter(item.expression)
      refreshCurrentFilterAssistPanel(target)
    })
    actions.appendChild(action)
    const remove = createFilterAssistAction(bootstrap.l10n.Delete)
    remove.addEventListener('click', (e) => {
      e.stopPropagation()
      deleteFilterHistory(item.expression)
      refreshCurrentFilterAssistPanel(target)
    })
    actions.appendChild(remove)
  }
  else {
    const remove = createFilterAssistAction(bootstrap.l10n.Delete)
    remove.addEventListener('click', (e) => {
      e.stopPropagation()
      deleteSavedFilter(item.expression)
      refreshCurrentFilterAssistPanel(target)
    })
    actions.appendChild(remove)
  }
  return actions
}

/**
 * 构建筛选助手标题栏操作
 */
function buildFilterAssistTitleAction(target, mode, itemCount) {
  if (itemCount === 0)
    return null
  if (mode === 'suggestions') {
    const hint = document.createElement('span')
    hint.className = 'filter-assist-hint'
    hint.textContent = bootstrap.l10n.FilterSuggestionTabHint
    return hint
  }
  if (mode !== 'history' && mode !== 'saved')
    return null
  const clear = createFilterAssistAction(bootstrap.l10n.ClearAll)
  clear.classList.add('filter-assist-clear')
  clear.addEventListener('click', (e) => {
    e.stopPropagation()
    if (mode === 'history')
      clearFilterHistory()
    else
      clearSavedFilters()
    refreshCurrentFilterAssistPanel(target)
  })
  return clear
}

/**
 * 构建轻量筛选记录操作按钮
 */
function createFilterAssistAction(label) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'filter-assist-action text link small'
  button.textContent = label
  return button
}

/**
 * 根据当前面板类型刷新筛选助手
 */
function refreshCurrentFilterAssistPanel(target = activeFilterAssistTarget) {
  if (!target)
    return
  if (target.mode === 'history') {
    showFilterMemoryPanel(target, 'history', bootstrap.l10n.FilterHistory, filterAssistState.history, bootstrap.l10n.NoFilterHistory)
    return
  }
  if (target.mode === 'saved') {
    showFilterMemoryPanel(target, 'saved', bootstrap.l10n.SavedFilters, filterAssistState.saved, bootstrap.l10n.NoSavedFilters)
    return
  }
  if (target.mode === 'suggestions')
    updateFilterAutocomplete(target, true, true)
}

// ---------- 输入写入 ----------

/**
 * 接受当前候选项
 */
function acceptFilterAssistItem(target, item) {
  if (!item)
    return
  if (item.kind === 'history' || item.kind === 'saved') {
    setFilterInputValue(target, item.expression)
    return
  }
  insertFilterSnippet(
    target,
    item.insertText,
    item.cursorOffset ?? item.insertText.length,
    item.replaceStart,
    item.replaceEnd,
  )
}

/**
 * 移动筛选助手键盘选择
 */
function moveFilterAssistActive(target, delta) {
  if (target.items.length === 0)
    return
  const next = (target.activeIndex + delta + target.items.length) % target.items.length
  setFilterAssistActive(target, next, true)
}

/**
 * 设置筛选助手当前活动项
 */
function setFilterAssistActive(target, index, scrollIntoView = true) {
  if (target.activeIndex === index)
    return
  target.activeIndex = index
  syncFilterAssistActiveRow(target, scrollIntoView)
}

/**
 * 同步筛选助手活动行样式
 */
function syncFilterAssistActiveRow(target, scrollIntoView = true) {
  let activeRow = null
  target.panel.querySelectorAll('.filter-assist-row').forEach((row) => {
    const index = Number.parseInt(row.dataset.index || '-1', 10)
    const active = index === target.activeIndex
    row.classList.toggle('active', active)
    if (active)
      activeRow = row
  })
  if (!activeRow)
    return
  if (!scrollIntoView)
    return
  const list = activeRow.parentElement
  if (!list)
    return
  const rowTop = activeRow.offsetTop - list.offsetTop
  const rowBottom = rowTop + activeRow.offsetHeight
  if (rowTop < list.scrollTop)
    list.scrollTop = rowTop
  else if (rowBottom > list.scrollTop + list.clientHeight)
    list.scrollTop = rowBottom - list.clientHeight
}

/**
 * 隐藏筛选助手
 */
function hideFilterAssist(target = activeFilterAssistTarget) {
  if (!target)
    return
  target.panel.hidden = true
  target.mode = null
  target.items = []
  target.activeIndex = -1
  if (activeFilterAssistTarget === target)
    activeFilterAssistTarget = null
}

/**
 * 设置筛选输入值
 */
function setFilterInputValue(target, value) {
  target.input.value = value
  target.input.focus()
  target.input.setSelectionRange(value.length, value.length)
  target.clearError()
  hideFilterAssist(target)
  target.updateControls()
}

/**
 * 插入筛选表达式片段
 */
function insertFilterSnippet(target, snippet, cursorOffset = snippet.length, replaceStart, replaceEnd) {
  const value = target.input.value
  const selection = getFilterInputSelection(target.input)
  const start = Number.isInteger(replaceStart) ? replaceStart : selection.start
  const end = Number.isInteger(replaceEnd) ? replaceEnd : selection.end
  target.input.value = `${value.slice(0, start)}${snippet}${value.slice(end)}`
  const cursor = start + cursorOffset
  target.input.focus()
  target.input.setSelectionRange(cursor, cursor)
  target.clearError()
  hideFilterAssist(target)
  target.updateControls()
}

/**
 * 获取筛选输入框选区
 */
function getFilterInputSelection(input) {
  const value = input.value
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start
  return { start, end }
}

// ---------- 变量模板 ----------

/**
 * 插入变量名
 */
function insertVariableFilterToken(header) {
  insertFilterSnippet(mainFilterAssistTarget, header)
}

/**
 * 插入带变量名的筛选模板
 */
function insertVariableFilterTemplate(header, fn) {
  const resolved = resolveVariableFunctionSnippet(fn, header)
  insertFilterSnippet(mainFilterAssistTarget, resolved.snippet, resolved.cursorOffset)
}

/**
 * 生成带当前变量名的函数片段
 */
function resolveVariableFunctionSnippet(fn, header) {
  const marker = '{cursor}'
  const template = (fn.variableTemplate || `${fn.name}({var})`).split('{var}').join(header)
  const cursorIndex = template.indexOf(marker)
  if (cursorIndex < 0)
    return { snippet: template, cursorOffset: template.length }
  return {
    snippet: template.slice(0, cursorIndex) + template.slice(cursorIndex + marker.length),
    cursorOffset: cursorIndex,
  }
}

// ---------- 筛选记忆 ----------

/**
 * 保存当前筛选表达式
 */
function saveCurrentFilter(target = mainFilterAssistTarget) {
  const expr = target.input.value.trim()
  if (!expr)
    return
  addSavedFilter(expr)
  refreshCurrentFilterAssistPanel(target)
}

/**
 * 将表达式加入历史
 */
function rememberFilterExpression(expr) {
  filterAssistState.history = addExpressionToList(filterAssistState.history, expr, FILTER_HISTORY_LIMIT)
  persistFilterAssistState()
  updateFilterMemoryControls()
}

/**
 * 删除单条筛选历史
 */
function deleteFilterHistory(expr) {
  filterAssistState.history = filterAssistState.history.filter(item => item !== expr)
  persistFilterAssistState()
  updateFilterMemoryControls()
}

/**
 * 添加常用筛选
 */
function addSavedFilter(expr) {
  filterAssistState.saved = addExpressionToList(filterAssistState.saved, expr, FILTER_SAVED_LIMIT)
  persistFilterAssistState()
  updateFilterMemoryControls()
}

/**
 * 删除常用筛选
 */
function deleteSavedFilter(expr) {
  filterAssistState.saved = filterAssistState.saved.filter(item => item !== expr)
  persistFilterAssistState()
  updateFilterMemoryControls()
}

/**
 * 清空筛选历史
 */
function clearFilterHistory() {
  filterAssistState.history = []
  persistFilterAssistState()
  updateFilterMemoryControls()
}

/**
 * 清空常用筛选
 */
function clearSavedFilters() {
  filterAssistState.saved = []
  persistFilterAssistState()
  updateFilterMemoryControls()
}

/**
 * 去重并把表达式放到列表首位
 */
function addExpressionToList(list, expr, limit) {
  const normalized = expr.trim()
  if (!normalized)
    return list
  return [normalized, ...list.filter(item => item !== normalized)].slice(0, limit)
}

/**
 * 更新历史/保存按钮状态
 */
function updateFilterMemoryControls() {
  filterTools.disabled = false
}

/**
 * 读取筛选助手持久状态
 */
function loadFilterAssistState() {
  const fromStorage = readFilterAssistStorage()
  if (fromStorage)
    return fromStorage
  try {
    const state = typeof vscode.getState === 'function' ? vscode.getState() : null
    return sanitizeFilterAssistState(state && state.filterAssist)
  }
  catch {
    return { history: [], saved: [] }
  }
}

/**
 * 从 localStorage 读取筛选助手状态
 */
function readFilterAssistStorage() {
  try {
    const raw = window.localStorage && window.localStorage.getItem(FILTER_ASSIST_STORAGE_KEY)
    return raw ? sanitizeFilterAssistState(JSON.parse(raw)) : null
  }
  catch {
    return null
  }
}

/**
 * 持久化筛选助手状态
 */
function persistFilterAssistState() {
  filterAssistState = sanitizeFilterAssistState(filterAssistState)
  try {
    if (window.localStorage)
      window.localStorage.setItem(FILTER_ASSIST_STORAGE_KEY, JSON.stringify(filterAssistState))
  }
  catch {
    // VS Code Webview 可能禁用 localStorage，继续使用 setState 回退
  }
  try {
    if (typeof vscode.setState === 'function') {
      const current = typeof vscode.getState === 'function' ? vscode.getState() || {} : {}
      vscode.setState({ ...current, filterAssist: filterAssistState })
    }
  }
  catch {
    // 状态保存失败不影响筛选功能本身
  }
}

/**
 * 规范化筛选助手状态
 */
function sanitizeFilterAssistState(value) {
  const history = sanitizeExpressionList(value && value.history, FILTER_HISTORY_LIMIT)
  const saved = sanitizeExpressionList(value && value.saved, FILTER_SAVED_LIMIT)
  return { history, saved }
}

/**
 * 规范化表达式数组
 */
function sanitizeExpressionList(value, limit) {
  if (!Array.isArray(value))
    return []
  const result = []
  for (const item of value) {
    if (typeof item !== 'string')
      continue
    const expr = item.trim()
    if (!expr || result.includes(expr))
      continue
    result.push(expr)
    if (result.length >= limit)
      break
  }
  return result
}
