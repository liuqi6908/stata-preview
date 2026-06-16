/**
 * 变量统计弹窗、局部过滤与统计图表渲染。
 */

// ---------- 状态 ----------

/** 当前汇总变量名 */
let explorerVar = null
/** 变量统计局部过滤表达式 */
let explorerExpr = ''
/** 是否继承表格通用过滤 */
let explorerInheritGeneral = false

// ---------- 统计请求 ----------

/**
 * 打开变量统计弹窗
 */
async function openExplorer(varIndex) {
  explorerVar = meta.headers[varIndex]
  const varLabel = meta.labels[varIndex]
  explorerExpr = ''
  explorerInheritGeneral = false
  explorerVariable.textContent = explorerVar + (varLabel ? ` - ${varLabel}` : '')
  explorerDialog.show()
  await runTabulate()
}

/**
 * 请求并渲染变量统计结果
 */
async function runTabulate() {
  // 先渲染过滤面板和结果占位，让用户能继续编辑过滤表达式
  explorerBody.innerHTML = `${renderExplorerFilterPanel()}<div id="explorer-result"><div class="explorer-loading">${bootstrap.l10n.Computing}</div></div>`
  wireExplorerFilterPanel()

  const resultEl = document.getElementById('explorer-result')
  try {
    const res = await postRequest('tabulate', {
      varName: explorerVar,
      explorerExpr,
      inheritGeneral: explorerInheritGeneral,
    })
    if (res.kind === 'filterError') {
      showExplorerFilterError(res.error)
      resultEl.innerHTML = `<div class="explorer-error">${bootstrap.l10n.FixFilterToComputeResults}</div>`
      return
    }
    clearExplorerFilterError()
    if (explorerExpr.trim())
      rememberFilterExpression(explorerExpr)
    resultEl.innerHTML = renderTabulateResult(res.result, explorerVar, res.scopeN)
    hydrateBarWidths(resultEl)
  }
  catch (e) {
    if (e.stale)
      return
    resultEl.innerHTML = `<div class="explorer-error">${bootstrap.l10n.ErrorPrefix} ${escapeHtml(String(e.message || e))}</div>`
  }
}

// ---------- 过滤面板 ----------

/**
 * 渲染变量统计过滤面板
 */
function renderExplorerFilterPanel() {
  const generalActive = totalFiltered !== totalAll
  const inheritDisabled = !generalActive
  const inheritChecked = explorerInheritGeneral && generalActive
  const generalNote = generalActive
    ? formatL10n(bootstrap.l10n.GeneralFilterNote, formatInt(totalFiltered), formatInt(totalAll))
    : bootstrap.l10n.NoGeneralFilterActive
  return `
    <div class="explorer-filter-panel">
      <div class="explorer-filter-row">
        <div class="explorer-filter-field">
          <input id="explorer-filter-input" class="bordered" type="text" placeholder="${bootstrap.l10n.filterForTabulationPlaceholder}" value="${escapeHtml(explorerExpr)}">
          <button id="explorer-filter-tools" class="icon" title="${bootstrap.l10n.FilterTools}">${FILTER_ICON_SVG}</button>
          <div id="explorer-filter-assist" class="filter-assist" hidden></div>
        </div>
        <button id="explorer-filter-apply" title="${bootstrap.l10n.ApplyFilterTitle}">${bootstrap.l10n.Apply}</button>
        <button id="explorer-filter-clear" title="${bootstrap.l10n.ClearFilterTitle}">${bootstrap.l10n.Clear}</button>
      </div>
      <div class="explorer-filter-row explorer-filter-options">
        <label>
          <input id="explorer-inherit" type="checkbox" ${inheritChecked ? 'checked' : ''} ${inheritDisabled ? 'disabled' : ''}>
          <span>${bootstrap.l10n.combineWithGeneralFilter}</span>
          <span class="explorer-inherit-note">${generalNote}</span>
        </label>
        <span id="explorer-filter-error"></span>
      </div>
    </div>
  `
}

/**
 * 绑定变量统计过滤面板事件
 */
function wireExplorerFilterPanel() {
  const input = document.getElementById('explorer-filter-input')
  const tools = document.getElementById('explorer-filter-tools')
  const assist = document.getElementById('explorer-filter-assist')
  const apply = document.getElementById('explorer-filter-apply')
  const clear = document.getElementById('explorer-filter-clear')
  const inherit = document.getElementById('explorer-inherit')
  let target = null
  const onApply = () => {
    explorerExpr = input.value
    hideFilterAssist(target)
    runTabulate()
  }
  target = createFilterAssistTarget({
    input,
    panel: assist,
    clearError: clearExplorerFilterError,
    onApply,
  })
  apply.addEventListener('click', onApply)
  input.addEventListener('keydown', e => handleFilterInputKeydown(target, e))
  input.addEventListener('input', () => {
    clearExplorerFilterError()
    updateFilterAutocomplete(target, false)
  })
  input.addEventListener('click', () => updateFilterAutocomplete(target, false))
  tools.addEventListener('click', (e) => {
    e.stopPropagation()
    showFilterToolsMenu(target, tools)
  })
  clear.addEventListener('click', () => {
    explorerExpr = ''
    hideFilterAssist(target)
    runTabulate()
  })
  if (inherit && !inherit.disabled) {
    inherit.addEventListener('change', (e) => {
      explorerInheritGeneral = e.target.checked
      runTabulate()
    })
  }
}

/**
 * 显示变量统计局部过滤错误
 */
function showExplorerFilterError(msg) {
  const input = document.getElementById('explorer-filter-input')
  const err = document.getElementById('explorer-filter-error')
  if (input)
    input.classList.add('error')
  if (err)
    err.textContent = msg
}

/**
 * 清除变量统计局部过滤错误
 */
function clearExplorerFilterError() {
  const input = document.getElementById('explorer-filter-input')
  const err = document.getElementById('explorer-filter-error')
  if (input)
    input.classList.remove('error')
  if (err)
    err.textContent = ''
}

// ---------- 结果渲染 ----------

/**
 * 渲染变量统计结果
 */
function renderTabulateResult(r, varName, scopeN) {
  let html = renderTabulateScopeInfo(r, scopeN)
  html += renderTabulateGeneralStats(r)
  if (r.kind === 'discrete')
    html += renderDiscrete(r)
  else if (r.kind === 'continuous')
    html += renderContinuous(r)
  else
    html += renderStringTop(r)
  return html
}

/**
 * 渲染变量统计范围和类型
 */
function renderTabulateScopeInfo(r, scopeN) {
  const badge = getExplorerKindBadge(r.kind)
  let html = `<div class="explorer-scope-info"><span class="badge ${badge.className}">${badge.label}</span>`
  if (typeof scopeN === 'number')
    html += `<span>${formatL10n(bootstrap.l10n.TabulatingScope, formatNum(scopeN), formatNum(totalAll))}</span>`
  html += '</div>'
  return html
}

/**
 * 获取变量统计类型徽标
 */
function getExplorerKindBadge(kind) {
  if (kind === 'continuous')
    return { label: bootstrap.l10n.Continuous, className: 'primary' }
  if (kind === 'discrete')
    return { label: bootstrap.l10n.Discrete, className: 'secondary' }
  return { label: bootstrap.l10n.StringType, className: 'tertiary' }
}

/**
 * 渲染变量统计通用指标
 */
function renderTabulateGeneralStats(r) {
  const total = r.nValid + r.nMissing
  const missingPct = total > 0 ? (r.nMissing / total * 100).toFixed(1) : '0.0'
  let html = `<div class="explorer-section"><h3>${bootstrap.l10n.General}</h3><div class="stats-grid">`
  html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.ValidN}</div><div class="stat-value">${formatNum(r.nValid)}</div></div>`
  html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Missing}</div><div class="stat-value">${formatNum(r.nMissing)} (${missingPct}%)</div></div>`
  if (r.nUnique !== undefined)
    html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Unique}</div><div class="stat-value">${formatNum(r.nUnique)}</div></div>`
  html += '</div></div>'
  return html
}

// ---------- 结果表格 ----------

/**
 * 渲染离散变量频数表
 */
function renderDiscrete(r) {
  const maxFreq = r.entries.reduce((m, e) => Math.max(m, e.freq), 0)
  let html = `<div class="explorer-section"><h3>${bootstrap.l10n.FrequencyDistribution}</h3>`
  html += '<table class="flat">'
  html += `<thead><tr><th>${bootstrap.l10n.Value}</th><th>${bootstrap.l10n.ValueLabel}</th><th class="cell-right">${bootstrap.l10n.Freq}</th><th class="cell-right">${bootstrap.l10n.Percent}</th><th class="cell-right">${bootstrap.l10n.CumPercent}</th><th class="bar-cell">${bootstrap.l10n.Bar}</th></tr></thead><tbody>`
  for (const e of r.entries) {
    const pctOfMax = maxFreq > 0 ? (e.freq / maxFreq * 100) : 0
    const lbl = e.label !== undefined && e.label !== null ? escapeHtml(e.label) : ''
    html += `<tr>
        <td>${renderValueCell(e.value)}</td>
        <td>${lbl}</td>
        <td class="cell-right">${formatNum(e.freq)}</td>
        <td class="cell-right">${e.pct.toFixed(2)}</td>
        <td class="cell-right">${e.cum.toFixed(2)}</td>
        <td class="bar-cell"><div class="bar-chart"><div class="bar-fill" data-width="${barWidthValue(pctOfMax)}"></div></div></td>
      </tr>`
  }
  html += '</tbody></table></div>'
  return html
}

/**
 * 渲染连续变量统计表与图表
 */
function renderContinuous(r) {
  let html = ''
  html += `<div class="explorer-section"><h3>${bootstrap.l10n.DescriptiveStatistics}</h3><div class="stats-grid">`
  html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Mean}</div><div class="stat-value">${formatNum(r.mean)}</div></div>`
  html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.StdDev}</div><div class="stat-value">${formatNum(r.sd)}</div></div>`
  html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Min}</div><div class="stat-value">${formatNum(r.min)}</div></div>`
  html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Max}</div><div class="stat-value">${formatNum(r.max)}</div></div>`
  html += '</div></div>'
  html += `<div class="explorer-section"><h3>${bootstrap.l10n.Percentiles}</h3><div class="stats-grid">`
  html += `<div class="stat-item"><div class="stat-label">P1</div><div class="stat-value">${formatNum(r.p1)}</div></div>`
  html += `<div class="stat-item"><div class="stat-label">P25</div><div class="stat-value">${formatNum(r.p25)}</div></div>`
  html += `<div class="stat-item"><div class="stat-label">${bootstrap.l10n.Median}</div><div class="stat-value">${formatNum(r.median)}</div></div>`
  html += `<div class="stat-item"><div class="stat-label">P75</div><div class="stat-value">${formatNum(r.p75)}</div></div>`
  html += `<div class="stat-item"><div class="stat-label">P99</div><div class="stat-value">${formatNum(r.p99)}</div></div>`
  html += '</div></div>'
  const chart = r.chart
  if (chart) {
    const title = chart.type === 'bars' ? bootstrap.l10n.DistributionPerValue : bootstrap.l10n.Histogram
    html += `<div class="explorer-section"><h3>${title}</h3>`
    if (chart.type === 'bars')
      html += renderValueBarsSVG(chart.bars)
    else
      html += renderHistogramSVG(chart.bins)
    html += '</div>'
  }
  return html
}

// ---------- 图表 ----------

/**
 * 渲染整数离散值柱状 SVG
 */
function renderValueBarsSVG(bars) {
  if (!bars || bars.length === 0)
    return `<div>${bootstrap.l10n.NoData}</div>`
  const maxCount = bars.reduce((m, b) => Math.max(m, b.count), 0)
  const plotW = EXPLORER_CHART_WIDTH - EXPLORER_CHART_PAD_LEFT - EXPLORER_CHART_PAD_RIGHT
  const plotH = EXPLORER_CHART_HEIGHT - EXPLORER_CHART_PAD_TOP - EXPLORER_CHART_PAD_BOTTOM
  const slot = plotW / bars.length
  const barW = Math.max(1, slot - 1)
  let svg = `<svg class="histogram" viewBox="0 0 ${EXPLORER_CHART_WIDTH} ${EXPLORER_CHART_HEIGHT}" preserveAspectRatio="xMidYMid meet">`
  for (let i = 0; i <= EXPLORER_CHART_GRID_STEPS; i++) {
    const y = EXPLORER_CHART_PAD_TOP + plotH - (plotH * i / EXPLORER_CHART_GRID_STEPS)
    const v = Math.round(maxCount * i / EXPLORER_CHART_GRID_STEPS)
    svg += `<line x1="${EXPLORER_CHART_PAD_LEFT}" y1="${y}" x2="${EXPLORER_CHART_WIDTH - EXPLORER_CHART_PAD_RIGHT}" y2="${y}" class="hist-grid"/>`
    svg += `<text x="${EXPLORER_CHART_PAD_LEFT - 6}" y="${y + 4}" class="hist-axis" text-anchor="end">${v}</text>`
  }
  bars.forEach((b, i) => {
    const h = maxCount > 0 ? (b.count / maxCount) * plotH : 0
    const x = EXPLORER_CHART_PAD_LEFT + i * slot + (slot - barW) / 2
    const y = EXPLORER_CHART_PAD_TOP + plotH - h
    const tt = formatL10n(bootstrap.l10n.ValueCountTitle, formatNum(b.value), formatNum(b.count))
    svg += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" class="hist-bar"><title>${escapeHtml(tt)}</title></rect>`
  })
  const nLabels = Math.min(6, bars.length)
  const step = bars.length > 1 ? (bars.length - 1) / Math.max(1, nLabels - 1) : 0
  for (let k = 0; k < nLabels; k++) {
    const i = Math.round(k * step)
    const x = EXPLORER_CHART_PAD_LEFT + i * slot + slot / 2
    svg += `<text x="${x}" y="${EXPLORER_CHART_HEIGHT - 8}" class="hist-axis" text-anchor="middle">${formatNum(bars[i].value)}</text>`
  }
  svg += '</svg>'
  return svg
}

/**
 * 渲染连续变量直方图 SVG
 */
function renderHistogramSVG(bins) {
  if (!bins || bins.length === 0)
    return `<div>${bootstrap.l10n.NoData}</div>`
  const maxCount = bins.reduce((m, b) => Math.max(m, b.count), 0)
  const plotW = EXPLORER_CHART_WIDTH - EXPLORER_CHART_PAD_LEFT - EXPLORER_CHART_PAD_RIGHT
  const plotH = EXPLORER_CHART_HEIGHT - EXPLORER_CHART_PAD_TOP - EXPLORER_CHART_PAD_BOTTOM
  const barW = plotW / bins.length
  let svg = `<svg class="histogram" viewBox="0 0 ${EXPLORER_CHART_WIDTH} ${EXPLORER_CHART_HEIGHT}" preserveAspectRatio="xMidYMid meet">`
  for (let i = 0; i <= EXPLORER_CHART_GRID_STEPS; i++) {
    const y = EXPLORER_CHART_PAD_TOP + plotH - (plotH * i / EXPLORER_CHART_GRID_STEPS)
    const v = Math.round(maxCount * i / EXPLORER_CHART_GRID_STEPS)
    svg += `<line x1="${EXPLORER_CHART_PAD_LEFT}" y1="${y}" x2="${EXPLORER_CHART_WIDTH - EXPLORER_CHART_PAD_RIGHT}" y2="${y}" class="hist-grid"/>`
    svg += `<text x="${EXPLORER_CHART_PAD_LEFT - 6}" y="${y + 4}" class="hist-axis" text-anchor="end">${v}</text>`
  }
  bins.forEach((b, i) => {
    const h = maxCount > 0 ? (b.count / maxCount) * plotH : 0
    const x = EXPLORER_CHART_PAD_LEFT + i * barW
    const y = EXPLORER_CHART_PAD_TOP + plotH - h
    const tt = formatL10n(bootstrap.l10n.HistogramBinCountTitle, formatNum(b.lo), formatNum(b.hi), formatNum(b.count))
    svg += `<rect x="${x + 0.5}" y="${y}" width="${Math.max(0, barW - 1)}" height="${h}" class="hist-bar"><title>${escapeHtml(tt)}</title></rect>`
  })
  const xLabels = [0, Math.floor(bins.length / 2), bins.length - 1]
  xLabels.forEach((i) => {
    const x = EXPLORER_CHART_PAD_LEFT + i * barW + barW / 2
    svg += `<text x="${x}" y="${EXPLORER_CHART_HEIGHT - 8}" class="hist-axis" text-anchor="middle">${formatNum(bins[i].lo)}</text>`
  })
  svg += '</svg>'
  return svg
}

// ---------- 字符串结果 ----------

/**
 * 渲染字符串变量 Top 值表
 */
function renderStringTop(r) {
  const maxFreq = r.topValues.reduce((m, e) => Math.max(m, e.freq), 0)
  let html = `<div class="explorer-section"><h3>${bootstrap.l10n.Top10Values}</h3>`
  html += '<table class="flat">'
  html += `<thead><tr><th>${bootstrap.l10n.Value}</th><th class="cell-right">${bootstrap.l10n.Freq}</th><th class="cell-right">${bootstrap.l10n.Percent}</th><th class="bar-cell">${bootstrap.l10n.Bar}</th></tr></thead><tbody>`
  for (const e of r.topValues) {
    const pctOfMax = maxFreq > 0 ? (e.freq / maxFreq * 100) : 0
    html += `<tr>
        <td>${renderValueCell(e.value)}</td>
        <td class="cell-right">${formatNum(e.freq)}</td>
        <td class="cell-right">${e.pct.toFixed(2)}</td>
        <td class="bar-cell"><div class="bar-chart"><div class="bar-fill" data-width="${barWidthValue(pctOfMax)}"></div></div></td>
      </tr>`
  }
  html += '</tbody></table></div>'
  return html
}

// ---------- 图表水合 ----------

/**
 * 将柱状图宽度写入 CSSOM，避免在 HTML 字符串里生成 style 属性
 */
function hydrateBarWidths(root) {
  root.querySelectorAll('.bar-fill[data-width]').forEach((bar) => {
    const width = Number.parseFloat(bar.dataset.width || '0')
    bar.style.width = `${Number.isFinite(width) ? width : 0}%`
    bar.removeAttribute('data-width')
  })
}

/**
 * 生成安全的柱状图百分比
 */
function barWidthValue(value) {
  const width = Number.isFinite(value) ? value : 0
  return Math.max(0, Math.min(100, width)).toFixed(4)
}

// ---------- 值展示 ----------

/**
 * 渲染统计表中的值单元格
 */
function renderValueCell(value) {
  const text = String(value)
  if (isWhitespaceOnlyString(text))
    return `<span class="whitespace-value">${escapeHtml(formatWhitespacePreview(text))}</span>`
  return escapeHtml(text)
}
