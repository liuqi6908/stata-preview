/**
 * 使用说明弹窗内容。
 *
 * 内容以结构化数据维护，渲染时统一调用 vscode.l10n，保证中英双语可提取。
 */

import { l10n } from 'vscode'

/** 使用说明中的示例分组。 */
interface UsageExampleGroup {
  /** 分组标题。 */
  title: string
  /** 分组说明。 */
  description: string
  /** 代码示例。 */
  examples: string[]
}

/**
 * 渲染使用说明弹窗内容。
 */
export function renderUsageGuideHtml(): string {
  return `
    <section class="usage-section">
      <h3>${l10n.t('Filtering')}</h3>
      <div class="usage-subsection">
        <h4>${l10n.t('Basic syntax')}</h4>
        <ul>
          <li>${l10n.t('Enter an expression in the filter box, then apply it to show matching rows.')}</li>
          <li>${l10n.t('Use variable names directly, including Unicode names such as Chinese column names.')}</li>
          <li>${l10n.t('Wrap string values in single or double quotes.')}</li>
          <li>${l10n.t('Use parentheses to group conditions and control evaluation order.')}</li>
        </ul>
      </div>
      <div class="usage-subsection">
        <h4>${l10n.t('Operators and functions')}</h4>
        <ul>
          <li>${l10n.t('Supported comparisons: ==, !=, ~=, <, <=, >, >=.')}</li>
          <li>${l10n.t('Combine conditions with &, |, !, or the words and, or, not.')}</li>
          <li>${l10n.t('Use arithmetic operators +, -, *, /, and ^ in numeric filters.')}</li>
          <li>${l10n.t('Use missing(), inlist(), and inrange() for missing values, sets, and inclusive ranges.')}</li>
          <li>${l10n.t('Use contains(), strpos(), regexm(), lower(), upper(), trim(), and length() for string filters.')}</li>
          <li>${l10n.t('Use year(), month(), and day() with Stata numeric dates/datetimes or parseable date strings.')}</li>
        </ul>
      </div>
      <div class="usage-subsection">
        <h4>${l10n.t('Filter examples')}</h4>
        <div class="usage-example-groups">
          ${renderExampleGroups()}
        </div>
      </div>
    </section>
    <section class="usage-section">
      <h3>${l10n.t('Table')}</h3>
      <ul>
        <li>${l10n.t('Click a column header to sort by that column.')}</li>
        <li>${l10n.t('Hold Shift while clicking column headers to sort by multiple columns.')}</li>
        <li>${l10n.t('Drag the handle on the right edge of a header to resize the column.')}</li>
        <li>${l10n.t('Right-click a column header to copy names, sort, hide columns, reset width, or open variable statistics.')}</li>
        <li>${l10n.t('Use the pager to move through rows and change the page size.')}</li>
      </ul>
    </section>
    <section class="usage-section">
      <h3>${l10n.t('Variables panel')}</h3>
      <ul>
        <li>${l10n.t('Use checkboxes to show or hide columns without changing the data file.')}</li>
        <li>${l10n.t('Search variable names to quickly find columns in wide datasets.')}</li>
        <li>${l10n.t('Use Highlight missing to mark missing cells in the table without marking blank strings.')}</li>
        <li>${l10n.t('Open variable statistics to inspect missing values, unique values, distributions, and numeric summaries.')}</li>
        <li>${l10n.t('Whitespace-only strings in variable statistics are shown with visible markers such as ␠×2, so different blank-looking values remain distinguishable.')}</li>
        <li>${l10n.t('Variable statistics can inherit the table filter or use a temporary filter for that calculation.')}</li>
      </ul>
    </section>
    <section class="usage-section">
      <h3>${l10n.t('Data and file')}</h3>
      <ul>
        <li>${l10n.t('Refresh data to re-read the current .dta file from disk.')}</li>
        <li>${l10n.t('Export data as CSV or Excel using the current filter, sort order, and visible columns.')}</li>
        <li>${l10n.t('Open file information to view path, size, update time, Stata release, byte order, data volume, and variable count.')}</li>
      </ul>
    </section>
  `
}

/**
 * 渲染全部示例分组。
 */
function renderExampleGroups(): string {
  const groups: UsageExampleGroup[] = [
    {
      title: l10n.t('Numeric filters'),
      description: l10n.t('Compare numbers directly or compute derived values before comparing.'),
      examples: [
        'edad &gt; 30 &amp; treatment == 1',
        'income / 10000 &gt; 5',
      ],
    },
    {
      title: l10n.t('Grouped conditions'),
      description: l10n.t('Use parentheses when mixing AND and OR conditions.'),
      examples: [
        '(year &gt;= 2020 &amp; year &lt;= 2024) | missing(year)',
      ],
    },
    {
      title: l10n.t('Missing values, sets, and ranges'),
      description: l10n.t('Use helper functions for common categorical and interval checks.'),
      examples: [
        'missing(score)',
        'inlist(city, "昆明市", "大理市")',
        'inrange(year, 2020, 2024)',
      ],
    },
    {
      title: l10n.t('String filters'),
      description: l10n.t('Search text, normalize values, or match regular expressions.'),
      examples: [
        'contains(城市名称, "市")',
        'regexm(code, "^[0-9]+$")',
        'lower(trim(name)) == "abc"',
      ],
    },
    {
      title: l10n.t('Date filters'),
      description: l10n.t('Extract date parts from Stata numeric dates/datetimes or parseable date strings.'),
      examples: [
        'year(date) == 2024',
        'month(date) == 6 &amp; day(date) == 3',
      ],
    },
  ]

  return groups.map(group => `
    <div class="usage-example-group">
      <h5>${group.title}</h5>
      <p>${group.description}</p>
      <div class="usage-examples">
        ${group.examples.map(example => `<code>${example}</code>`).join('')}
      </div>
    </div>
  `).join('')
}
