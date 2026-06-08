/**
 * DTA 预览 Webview HTML 模板。
 *
 * Provider 只负责传入资源 URI 和启动数据，页面结构在这里单独维护。
 */

import type * as vscode from 'vscode'
import type { DtaFileInfo } from '../dta/documentSession'
import { env, l10n, Uri } from 'vscode'
import { DEFAULT_PAGE_SIZE } from '../constants'
import { getWebviewBootstrapL10n } from './bootstrapL10n'
import { renderModal } from './components/modal'
import { renderSwitch } from './components/switch'
import { icon } from './icons'
import { renderUsageGuideHtml } from './usageGuide'

/** Webview 初始化数据。 */
export interface DtaWebviewInitData extends DtaFileInfo {
  /** 默认分页大小。 */
  pageSize: number
}

/** 渲染 Webview HTML 所需参数。 */
export interface RenderDtaWebviewHtmlOptions {
  /** VS Code Webview 实例。 */
  webview: vscode.Webview
  /** 扩展根 URI。 */
  extensionUri: vscode.Uri
  /** 文件和分页启动数据。 */
  initData: DtaWebviewInitData
}

/**
 * 构建 DTA 预览 Webview 完整 HTML。
 */
export function renderDtaWebviewHtml(options: RenderDtaWebviewHtmlOptions): string {
  const { webview, extensionUri, initData } = options
  const scriptUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'main.js'))
  const modalScriptUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'components', 'modal.js'))
  const styleUri = webview.asWebviewUri(Uri.joinPath(extensionUri, 'media', 'main.css'))
  const closeTitle = l10n.t('Close')
  const htmlLang = getHtmlLang()

  return `<!DOCTYPE html>
    <html lang="${htmlLang}">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link href="${styleUri}" rel="stylesheet">
      <title>${l10n.t('Stata Preview')}</title>
    </head>
    <body>
      <div id="layout-container">
        <div id="main-panel">
          ${renderToolbar()}
          ${renderGrid()}
          ${renderPagination()}
        </div>

        <div id="resize-handle"></div>
        ${renderSidebar()}
      </div>

      ${renderInitialLoading()}
      ${renderModal({
        id: 'file-info-modal',
        title: l10n.t('File information'),
        bodyId: 'file-info-body',
        closeButtonId: 'close-file-info',
        closeTitle,
      })}
      ${renderModal({
        id: 'usage-guide-modal',
        title: l10n.t('Usage guide'),
        bodyId: 'usage-guide-body',
        bodyHtml: renderUsageGuideHtml(),
        closeButtonId: 'close-usage-guide',
        closeTitle,
      })}
      ${renderModal({
        id: 'explorer-modal',
        title: '',
        titleId: 'explorer-variable',
        bodyId: 'explorer-body',
        closeButtonId: 'close-explorer',
        closeTitle,
      })}

      <script>
        const bootstrap = ${JSON.stringify({
          ...initData,
          pageSize: initData.pageSize ?? DEFAULT_PAGE_SIZE,
          l10n: getWebviewBootstrapL10n(),
        })};
        const vscode = acquireVsCodeApi();
      </script>
      <script src="${modalScriptUri}"></script>
      <script src="${scriptUri}"></script>
    </body>
    </html>`
}

/**
 * 根据当前 VS Code 语言环境生成 HTML lang 属性值。
 */
function getHtmlLang(): string {
  const language = env.language || 'en'
  return language
    .replace(/_/g, '-')
    .split('-')
    .map((part, index) => index === 1 && part.length === 2 ? part.toUpperCase() : part.toLowerCase())
    .join('-')
}

/**
 * 渲染顶部工具栏。
 */
function renderToolbar(): string {
  return `
    <div id="toolbar">
      <div id="toolbar-left">
        <div id="search-field">
          <input id="search-input" type="text" placeholder="${l10n.t('Filter: e.g., edad > 30 & treatment == 1')}">
          <span id="filter-error"></span>
        </div>
        <button id="search-apply" title="${l10n.t('Apply filter (or press Enter)')}">${l10n.t('Apply')}</button>
        <button id="search-clear" title="${l10n.t('Clear filter')}">${l10n.t('Clear')}</button>
      </div>
      <div id="toolbar-right">
        ${renderSwitch({
          id: 'toggle-sidebar',
          wrapperId: 'toggle-sidebar-control',
          label: l10n.t('Variables panel'),
          title: l10n.t('Hide variables panel'),
          checked: true,
        })}
        <span class="toolbar-separator"></span>
        <button id="refresh-data" class="icon" title="${l10n.t('Refresh data')}">${icon('refresh')}</button>
        <button id="export-data" class="icon" title="${l10n.t('Export data')}">${icon('download')}</button>
        <span class="toolbar-separator"></span>
        <button id="help-menu" class="icon" title="${l10n.t('Help')}">${icon('help')}</button>
      </div>
    </div>
  `
}

/**
 * 渲染数据网格容器。
 */
function renderGrid(): string {
  return `
    <div id="grid-wrapper">
      <div id="grid-container">
        <table id="data-table">
          <thead id="table-head"></thead>
          <tbody id="table-body"></tbody>
        </table>
      </div>
      <div id="grid-overlay" style="display: none">
        <div id="grid-overlay-message">${l10n.t('Computing…')}</div>
      </div>
    </div>
  `
}

/**
 * 渲染分页器。
 */
function renderPagination(): string {
  return `
    <div id="pagination">
      <div id="pagination-left">
        <button id="page-first" class="icon outline" title="${l10n.t('First page')}">${icon('firstPage', 16)}</button>
        <button id="page-prev" class="icon outline" title="${l10n.t('Previous page')}">${icon('prevPage', 16)}</button>
        <span id="page-info">${l10n.t('Page {0} / {1}', 1, 1)}</span>
        <button id="page-next" class="icon outline" title="${l10n.t('Next page')}">${icon('nextPage', 16)}</button>
        <button id="page-last" class="icon outline" title="${l10n.t('Last page')}">${icon('lastPage', 16)}</button>
        <span id="page-size-wrap">
          ${l10n.t('Page size:')}
          <select id="page-size" class="bordered">
            <option value="1000" selected>1,000</option>
            <option value="5000">5,000</option>
            <option value="10000">10,000</option>
            <option value="20000">20,000</option>
          </select>
        </span>
      </div>
      <div id="pagination-right">
        <span id="page-summary"></span>
      </div>
    </div>
  `
}

/**
 * 渲染变量侧边栏。
 */
function renderSidebar(): string {
  return `
    <div id="sidebar">
      <div id="sidebar-header">
        <h3>${l10n.t('Variables')}</h3>
        <button id="sidebar-position" class="icon" title="${l10n.t('Move variables panel to bottom')}">
          <span class="sidebar-position-icon sidebar-position-bottom">${icon('panelBottom')}</span>
          <span class="sidebar-position-icon sidebar-position-right">${icon('panelRight')}</span>
        </button>
      </div>
      <div id="sidebar-search">
        <input id="variable-search" type="text" placeholder="${l10n.t('Filter variables...')}">
      </div>
      <div id="sidebar-options">
        <label id="highlight-missing-wrap" title="${l10n.t('Highlight missing values')}">
          <input id="highlight-missing" type="checkbox">
          <span>${l10n.t('Highlight missing')}</span>
        </label>
      </div>
      <div id="variable-batch-actions">
        <button id="select-all-variables">${l10n.t('Select all')}</button>
        <button id="deselect-all-variables">${l10n.t('Deselect all')}</button>
      </div>
      <div id="variable-list"></div>
    </div>
  `
}

/**
 * 渲染初始加载界面。
 */
function renderInitialLoading(): string {
  return `
    <div id="initial-loading">
      <div id="initial-loading-card">
        <h2>${l10n.t('Loading dataset…')}</h2>
        <div id="progress-track">
          <div id="progress-fill" style="width: 0%"></div>
        </div>
        <div id="progress-text">${l10n.t('Reading file…')}</div>
      </div>
    </div>
  `
}
