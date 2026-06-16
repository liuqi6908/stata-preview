/**
 * Webview 前端脚本启动时需要的本地化文案。
 *
 * media 下的前端脚本不能直接调用 VS Code l10n，因此所有动态 UI 文案都从这里注入。
 */

import { l10n } from 'vscode'

/**
 * 构建注入 Webview 的 l10n 字典
 */
export function getWebviewBootstrapL10n() {
  return {
    // 加载与状态
    readingFile: l10n.t('Reading file…'),
    LoadingRowsProgress: l10n.t('Loading rows: {0} / {1} ({2}%)'),
    couldNotOpenFile: l10n.t('Could not open file'),
    Explore: l10n.t('Explore'),
    loadingPage: l10n.t('Loading page…'),
    applyingFilter: l10n.t('Applying filter…'),
    sorting: l10n.t('Sorting…'),
    exportingData: l10n.t('Exporting data…'),

    // 变量字典
    LoadingVariableDictionary: l10n.t('Loading variable dictionary…'),
    VariableDictionary: l10n.t('Variable dictionary'),
    FilterDictionary: l10n.t('Filter dictionary...'),
    VariableDictionarySummary: l10n.t('Showing {0} of {1} variables'),
    Number: l10n.t('Number'),
    Variable: l10n.t('Variable'),
    VariableLabel: l10n.t('Variable label'),
    Type: l10n.t('Type'),
    StatisticalType: l10n.t('Statistical type'),
    MissingSummary: l10n.t('{0} ({1}%)'),
    ValueLabelModeTitle: l10n.t('Value label display mode'),
    NoValueLabelsInDataset: l10n.t('No value labels in this dataset'),
    RowDetailSummary: l10n.t('View row {0} · source row {1}'),
    RowDetailViewSummary: l10n.t('View row {0}'),

    // 筛选助手
    FilterSuggestions: l10n.t('Filter suggestions'),
    FilterSuggestionTabHint: l10n.t('Tab to accept'),
    FilterTools: l10n.t('Filter tools'),
    FilterHistory: l10n.t('Filter history'),
    SavedFilters: l10n.t('Saved filters'),
    Save: l10n.t('Save'),
    SaveFilter: l10n.t('Save filter'),
    UseFilter: l10n.t('Use filter'),
    Delete: l10n.t('Delete'),
    RemoveSavedFilter: l10n.t('Unsave'),
    ClearAll: l10n.t('Clear all'),
    NoFilterHistory: l10n.t('No filter history yet'),
    NoSavedFilters: l10n.t('No saved filters yet'),
    VariableSuggestion: l10n.t('Variable'),
    FunctionSuggestion: l10n.t('Function'),
    MissingFunctionDescription: l10n.t('Check whether one or more values are missing.'),
    InlistFunctionDescription: l10n.t('Check whether a value matches any listed value.'),
    InrangeFunctionDescription: l10n.t('Check whether a value is inside an inclusive range.'),
    ContainsFunctionDescription: l10n.t('Check whether text contains a substring.'),
    StrposFunctionDescription: l10n.t('Return the 1-based substring position, or 0 when absent.'),
    RegexmFunctionDescription: l10n.t('Check whether text matches a regular expression.'),
    LowerFunctionDescription: l10n.t('Convert text to lowercase before comparing.'),
    UpperFunctionDescription: l10n.t('Convert text to uppercase before comparing.'),
    TrimFunctionDescription: l10n.t('Remove leading and trailing whitespace.'),
    LengthFunctionDescription: l10n.t('Return the text length.'),
    YearFunctionDescription: l10n.t('Extract the year from a date value.'),
    MonthFunctionDescription: l10n.t('Extract the month from a date value.'),
    DayFunctionDescription: l10n.t('Extract the day from a date value.'),

    // 表头菜单
    InsertVariableInFilter: l10n.t('Insert variable in filter'),
    InsertVariableName: l10n.t('Insert variable name'),
    InsertFunctionTemplate: l10n.t('Insert function template'),
    CopyVariableName: l10n.t('Copy variable name'),
    CopyVariableLabel: l10n.t('Copy variable label'),
    CopyCell: l10n.t('Copy cell'),
    CopyCurrentRow: l10n.t('Copy current row'),
    SortAscending: l10n.t('Sort ascending'),
    SortDescending: l10n.t('Sort descending'),
    ClearColumnSort: l10n.t('Clear column sort'),
    HideColumn: l10n.t('Hide column'),
    ShowOnlyThisColumn: l10n.t('Show only this column'),
    ResetColumnWidth: l10n.t('Reset column width'),
    ExploreVariableStatistics: l10n.t('Explore variable statistics'),

    // 顶部菜单与布局
    ExportAsCsv: l10n.t('Export as CSV'),
    ExportAsExcel: l10n.t('Export as Excel'),
    Help: l10n.t('Help'),
    UsageGuide: l10n.t('Usage guide'),
    FileInformation: l10n.t('File information'),
    ShowVariablesPanel: l10n.t('Show variables panel'),
    HideVariablesPanel: l10n.t('Hide variables panel'),
    MoveVariablesPanelToBottom: l10n.t('Move variables panel to bottom'),
    MoveVariablesPanelToRight: l10n.t('Move variables panel to right'),

    // 变量统计过滤
    filterForTabulationPlaceholder: l10n.t('Filter for this tabulation, e.g. edad == 30 & treatment == 1'),
    combineWithGeneralFilter: l10n.t('Combine with general filter'),
    TabulatingScope: l10n.t('Tabulating {0} of {1} rows.'),

    // 筛选与分页
    Apply: l10n.t('Apply'),
    ApplyFilterTitle: l10n.t('Apply filter (or press Enter)'),
    Clear: l10n.t('Clear'),
    ClearFilterTitle: l10n.t('Clear filter'),
    FilterError: l10n.t('Filter error'),
    PageInfo: l10n.t('Page {0} / {1}'),
    PageSummaryAll: l10n.t('Showing {0}-{1} of {2}'),
    PageSummaryFiltered: l10n.t('Showing {0}-{1} of {2} filtered (of {3} total)'),

    // 文件信息
    FileName: l10n.t('File name'),
    FilePath: l10n.t('File path'),
    FileSize: l10n.t('File size'),
    LastUpdated: l10n.t('Last updated'),
    StataRelease: l10n.t('Stata release'),
    ByteOrder: l10n.t('Byte order'),
    DataVolume: l10n.t('Data volume'),
    VariablesCount: l10n.t('Variables'),
    Unknown: l10n.t('Unknown'),

    // 变量统计结果
    Computing: l10n.t('Computing…'),
    FixFilterToComputeResults: l10n.t('Fix the filter to compute results.'),
    ErrorPrefix: l10n.t('Error:'),
    GeneralFilterNote: l10n.t('(general filter: {0} / {1} rows)'),
    NoGeneralFilterActive: l10n.t('(no general filter active)'),
    General: l10n.t('General'),
    ValidN: l10n.t('Valid N'),
    Missing: l10n.t('Missing'),
    Unique: l10n.t('Unique'),
    Discrete: l10n.t('Discrete'),
    Continuous: l10n.t('Continuous'),
    StringType: l10n.t('String'),
    FrequencyDistribution: l10n.t('Frequency Distribution'),
    Value: l10n.t('Value'),
    ValueLabel: l10n.t('Value label'),
    Freq: l10n.t('Freq'),
    Percent: l10n.t('%'),
    CumPercent: l10n.t('Cum %'),
    Bar: l10n.t('Bar'),
    DescriptiveStatistics: l10n.t('Descriptive Statistics'),
    Mean: l10n.t('Mean'),
    StdDev: l10n.t('Std Dev'),
    Min: l10n.t('Min'),
    Max: l10n.t('Max'),
    Percentiles: l10n.t('Percentiles'),
    Median: l10n.t('Median'),
    DistributionPerValue: l10n.t('Distribution (per value)'),
    Histogram: l10n.t('Histogram'),
    ValueCountTitle: l10n.t('{0}  n={1}'),
    HistogramBinCountTitle: l10n.t('[{0}, {1})  n={2}'),
    Top10Values: l10n.t('Top 10 Values'),
    NoData: l10n.t('No data'),
  }
}
