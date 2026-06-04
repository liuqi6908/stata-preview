# Stata Preview

<p align="center">
  <img src="media/logo.png" alt="Stata Preview" width="100" />
</p>

<p align='center'>
  <a href='./README.md'>简体中文</a> | English
</p>

Open Stata-formatted .dta files in VSCode and preview their contents in a tabular format without leaving the editor.

## Motivation for Plugin Development

When working with .dta files, we often have to switch to Stata software just to view variables, verify labels, filter row data, or perform quick frequency analysis on individual variables.

This plugin is designed specifically for such lightweight needs:

* Open dataset files
* Organize data structure
* View row data details
* Quickly filter and sort data
* Verify variable labels and value labels
* Generate frequency tables or descriptive statistics for individual variables quickly
* Export the current table view to common tabular formats

The plugin is not intended to replace Stata, but to enable quick viewing, lightweight exploration, and verification of data within the editor.

## Core Features

### Implemented Features

* Open .dta files in a read-only tabular view
* Display progress during data loading for intuitive feedback on loading status
* Support paginated loading to adapt to large-capacity datasets
* Support Stata-like filter expressions, including Unicode variable names such as Chinese column names
* Support parentheses, arithmetic operators, missing-value checks, set/range checks, string functions, regular expressions, and date functions
* Support single-column sorting and Shift-click multi-column sorting
* Support resizing columns by dragging the handle on the right edge of a header
* Support a header context menu for copying variable names/labels, sorting, hiding columns, resetting width, and opening variable statistics
* Display variable labels and value labels
* Hide/show specified columns via the sidebar
* Built-in Variable Explorer: support for univariate frequency analysis and descriptive statistics
* Export the current table view as CSV or Excel
* Built-in file information dialog for path, size, update time, Stata release, row count, and variable count
* Built-in usage guide dialog for filter expressions and table operations
* Automatically refresh the view when the underlying file is updated

### Unsupported Features

* No data editing capabilities
* Does not support writing modified content back to .dta files
* Cannot replace Stata for model estimation, script writing, or full-process data management

## Usage Guide

### Table View Operations

* Click on a .dta file to open it directly
* Enter conditions in the top toolbar to filter row data
* Click column headers to sort; hold Shift while clicking headers to sort by multiple columns
* Drag the handle on the right edge of a header to resize the column
* Right-click a column header to open column actions
* The sidebar supports searching for variables and hiding/showing specified columns
* Use the toolbar to open file information, usage guide, refresh data, or export data

### Data Filtering

The filter box supports variable-based expressions. Variable names can be written directly, including Chinese and other Unicode names.

Common syntax:

* Comparisons: `==`, `!=`, `~=`, `<`, `<=`, `>`, `>=`
* Logic: `&`, `|`, `!`, plus `and`, `or`, `not`
* Arithmetic: `+`, `-`, `*`, `/`, `^`
* Grouping: use parentheses to control precedence
* Helpers: `missing()`, `inlist()`, `inrange()`, `contains()`, `strpos()`, `regexm()`, `lower()`, `upper()`, `trim()`, `length()`, `year()`, `month()`, `day()`

Examples:

* `edad > 30` (Age greater than 30)
* `treatment == 1` (Treatment group = 1)
* `edad > 30 & treatment == 1` (Age greater than 30 and treatment group = 1)
* `(year >= 2020 & year <= 2024) | missing(year)` (Year is in range, or year is missing)
* `inlist(city, "昆明市", "大理市")` (City is in a specified set)
* `contains(城市名称, "市")` (Filter using a Chinese variable name)
* `regexm(code, "^[0-9]+$")` (Regular expression match)
* `lower(trim(name)) == "abc"` (Normalize a string before comparison)
* `year(date) == 2024` (Filter by date year)

If the expression format is incorrect, the viewer shows an error message below the filter box instead of failing silently.

### Data Sorting

* Single-click column header: sort in ascending order
* Click again: sort in descending order
* Click a third time: clear sorting
* Hold Shift while clicking headers: add or toggle multi-column sorting

### Header Context Menu

Right-click a column header to quickly run column actions:

* Copy variable name or variable label
* Sort ascending/descending, or clear sorting for the current column
* Hide the current column, or show only the current column
* Reset the current column width
* Open statistics for the current variable

### Data Export

The download button in the toolbar can export the current table view as:

* CSV
* Excel (.xlsx)

Exports preserve the current filter result, sort order, and visible-column configuration. Hidden columns are not exported.

### Variable Explorer

For each variable, the explorer can:

* Generate frequency tables for categorical variables / labeled variables
* Generate descriptive statistics for numerical variables
* Support setting separate filter conditions for frequency analysis
* Allow overlaying filter conditions for frequency analysis with global table filter conditions
* Support parsing and statistics for long text variables such as strL

### Applicable Scenarios

* Verify datasets in research repositories without opening Stata
* Check if generated .dta files meet expectations
* View labels, coded variables, and value label mapping relationships
* Perform quick quality assurance (QA) on exported data
* Explore data content synchronously when writing code, documents, or analysis scripts
* Export the filtered current view for teammates, documents, or downstream tools

### Performance Notes

* The plugin supports large files, but parsing speed is still affected by file size and available memory
* To optimize the viewing experience, the plugin uses paginated rendering instead of loading all data at once
* Filtering, sorting, pagination, statistics, and export are processed through a columnar data view in the extension host
