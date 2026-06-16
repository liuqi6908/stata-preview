/**
 * 变量字典弹窗与导出入口。
 */

// ---------- 弹窗入口 ----------

/**
 * 打开变量字典弹窗
 */
async function openVariableDictionary() {
  dictionaryDialog.show()
  if (variableDictionaryEntries) {
    renderVariableDictionary()
    return
  }

  dictionaryBody.innerHTML = `<div class="dictionary-loading">${bootstrap.l10n.LoadingVariableDictionary}</div>`
  try {
    const res = await postRequest('getVariableDictionary', {})
    variableDictionaryEntries = Array.isArray(res.entries) ? res.entries : []
    renderVariableDictionary()
  }
  catch (e) {
    if (e.stale)
      return
    dictionaryBody.innerHTML = `<div class="dictionary-error">${bootstrap.l10n.ErrorPrefix} ${escapeHtml(String(e.message || e))}</div>`
  }
}

/**
 * 渲染变量字典外壳和当前搜索结果
 */
function renderVariableDictionary() {
  const query = escapeHtml(dictionarySearchQuery)
  dictionaryBody.innerHTML = `
    <div class="dictionary-control-panel">
      <input id="dictionary-search" class="bordered" type="text" placeholder="${bootstrap.l10n.FilterDictionary}" value="${query}">
      <div class="dictionary-actions">
        <button id="dictionary-export-csv" class="outline" title="${bootstrap.l10n.ExportAsCsv}">${bootstrap.l10n.ExportAsCsv}</button>
        <button id="dictionary-export-xlsx" class="outline" title="${bootstrap.l10n.ExportAsExcel}">${bootstrap.l10n.ExportAsExcel}</button>
      </div>
    </div>
    <div id="dictionary-result"></div>
  `

  bindVariableDictionaryControls()
  renderVariableDictionaryResult()
}

/**
 * 绑定变量字典搜索与导出按钮
 */
function bindVariableDictionaryControls() {
  const input = document.getElementById('dictionary-search')
  const exportCsv = document.getElementById('dictionary-export-csv')
  const exportXlsx = document.getElementById('dictionary-export-xlsx')
  input.addEventListener('input', handleDictionarySearchInput)
  exportCsv.addEventListener('click', () => void exportVariableDictionaryData('csv'))
  exportXlsx.addEventListener('click', () => void exportVariableDictionaryData('xlsx'))
}

/**
 * 更新变量字典搜索条件
 */
function handleDictionarySearchInput(e) {
  dictionarySearchQuery = e.target.value.trim().toLowerCase()
  renderVariableDictionaryResult()
}

// ---------- 结果渲染 ----------

/**
 * 渲染变量字典表格
 */
function renderVariableDictionaryResult() {
  const resultEl = document.getElementById('dictionary-result')
  if (!resultEl)
    return
  const entries = variableDictionaryEntries || []
  const filtered = filterVariableDictionaryEntries(entries)
  const summary = formatL10n(
    bootstrap.l10n.VariableDictionarySummary,
    formatInt(filtered.length),
    formatInt(entries.length),
  )

  if (filtered.length === 0) {
    resultEl.innerHTML = renderVariableDictionaryEmpty(summary)
    return
  }

  resultEl.innerHTML = renderVariableDictionaryTable(summary, filtered)
}

/**
 * 渲染变量字典空状态
 */
function renderVariableDictionaryEmpty(summary) {
  return `
    <div class="dictionary-summary">${summary}</div>
    <div class="dictionary-empty-state">${bootstrap.l10n.NoData}</div>
  `
}

/**
 * 渲染变量字典结果表
 */
function renderVariableDictionaryTable(summary, entries) {
  return `
    <div class="dictionary-summary">${summary}</div>
    <div class="dictionary-table-wrap">
      <table class="flat">
        <thead>
          <tr>
            <th>${bootstrap.l10n.Number}</th>
            <th>${bootstrap.l10n.Variable}</th>
            <th>${bootstrap.l10n.VariableLabel}</th>
            <th>${bootstrap.l10n.Type}</th>
            <th>${bootstrap.l10n.StatisticalType}</th>
            <th class="cell-right">${bootstrap.l10n.ValidN}</th>
            <th class="cell-right">${bootstrap.l10n.Missing}</th>
            <th class="cell-right">${bootstrap.l10n.Unique}</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map(renderVariableDictionaryRow).join('')}
        </tbody>
      </table>
    </div>
  `
}

// ---------- 搜索与格式化 ----------

/**
 * 按弹窗搜索条件过滤变量字典
 */
function filterVariableDictionaryEntries(entries) {
  const query = dictionarySearchQuery.trim().toLowerCase()
  if (!query)
    return entries

  return entries.filter((entry) => {
    const text = [
      entry.index,
      entry.name,
      entry.label,
      entry.type,
      getDictionaryStatTypeLabel(entry.statType),
    ].filter(Boolean).join(' ').toLowerCase()
    return text.includes(query)
  })
}

/**
 * 渲染变量字典中的一行
 */
function renderVariableDictionaryRow(entry) {
  return `<tr>
    <td>${formatNum(entry.index)}</td>
    <td>${renderDictionaryText(entry.name)}</td>
    <td>${renderDictionaryText(entry.label, '')}</td>
    <td>${renderDictionaryText(entry.type)}</td>
    <td>${escapeHtml(getDictionaryStatTypeLabel(entry.statType))}</td>
    <td class="cell-right">${formatNum(entry.nValid)}</td>
    <td class="cell-right">${renderDictionaryMissing(entry)}</td>
    <td class="cell-right">${formatNum(entry.nUnique)}</td>
  </tr>`
}

/**
 * 本地化变量字典中的统计类型
 */
function getDictionaryStatTypeLabel(statType) {
  if (statType === 'continuous')
    return bootstrap.l10n.Continuous
  if (statType === 'discrete')
    return bootstrap.l10n.Discrete
  return bootstrap.l10n.StringType
}

/**
 * 渲染缺失数和缺失率
 */
function renderDictionaryMissing(entry) {
  const nMissing = Number.isFinite(entry.nMissing) ? entry.nMissing : 0
  const nValid = Number.isFinite(entry.nValid) ? entry.nValid : 0
  const total = nMissing + nValid
  const pct = total > 0 ? (nMissing / total) * 100 : 0
  return formatL10n(bootstrap.l10n.MissingSummary, formatNum(nMissing), pct.toFixed(1))
}

/**
 * 渲染字典普通文本单元格
 */
function renderDictionaryText(value, emptyText = '—') {
  if (value === null || value === undefined || String(value).length === 0)
    return emptyText
  return escapeHtml(value)
}

// ---------- 导出 ----------

/**
 * 导出变量字典
 */
async function exportVariableDictionaryData(format) {
  setDictionaryExportBusy(true)
  try {
    await postRequest('exportVariableDictionary', { format })
  }
  catch (e) {
    if (!e.stale)
      console.error('export variable dictionary failed', e)
  }
  finally {
    setDictionaryExportBusy(false)
  }
}

/**
 * 导出期间禁用字典导出按钮
 */
function setDictionaryExportBusy(busy) {
  dictionaryBody.querySelectorAll('#dictionary-export-csv, #dictionary-export-xlsx').forEach((button) => {
    button.disabled = busy
  })
}
