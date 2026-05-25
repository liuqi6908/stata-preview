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

The plugin is not intended to replace Stata, but to enable quick viewing, lightweight exploration, and verification of data within the editor.

## Core Features

### Implemented Features

* Open .dta files in a read-only tabular view
* Display progress during data loading for intuitive feedback on loading status
* Support paginated loading to adapt to large-capacity datasets
* Support Stata-like boolean expressions for filtering row data
* Support single-column / multi-column combined sorting
* Display variable labels and value labels
* Hide/show specified columns via the sidebar
* Built-in Variable Explorer: support for univariate frequency analysis and descriptive statistics
* Automatically refresh the view when the underlying file is updated

### Unsupported Features

* No data editing capabilities
* Does not support writing modified content back to .dta files
* Cannot replace Stata for model estimation, script writing, or full-process data management

## Usage Guide

### Table View Operations

* Click on a .dta file to open it directly
* Enter conditions in the top toolbar to filter row data
* Click column headers to sort
* The sidebar supports searching for variables and hiding/showing specified columns
* Toggle label display mode to view variable labels more clearly

### Data Filtering

The filter box supports boolean expressions based on variables, with examples as follows:

* `edad > 30` (Age greater than 30)
* `treatment == 1` (Treatment group = 1)
* `edad > 30 & treatment == 1` (Age greater than 30 and treatment group = 1)
* `sexo == "M"` (Gender = Male)
* `ingreso >= 500000` (Income greater than or equal to 500,000)

If the expression format is incorrect, the viewer will prompt an error message directly instead of failing silently.

### Data Sorting

* Single-click column header: sort in ascending order
* Click again: sort in descending order
* Support multi-column combined sorting (sort by the first column first, then refine sorting by the second column)

### Variable Explorer

For each variable, the explorer can:

* Generate frequency tables for categorical variables / labeled variables
* Generate descriptive statistics for numerical variables
* Support setting separate filter conditions for frequency analysis
* Allow overlaying filter conditions for frequency analysis with global table filter conditions

### Applicable Scenarios

* Verify datasets in research repositories without opening Stata
* Check if generated .dta files meet expectations
* View labels, coded variables, and value label mapping relationships
* Perform quick quality assurance (QA) on exported data
* Explore data content synchronously when writing code, documents, or analysis scripts

### Performance Notes

* The plugin supports large files, but parsing speed is still affected by file size and available memory
* To optimize the viewing experience, the plugin uses paginated rendering instead of loading all data at once