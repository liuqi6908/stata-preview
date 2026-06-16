/**
 * 文件信息弹窗。
 */

// ---------- 文件信息弹窗 ----------

/**
 * 打开文件信息弹窗
 */
function openFileInfo() {
  renderFileInfo()
  fileInfoDialog.show()
}

/**
 * 渲染文件信息弹窗内容
 */
function renderFileInfo() {
  const details = buildFileInfoDetails()
  fileInfoBody.innerHTML = `
    <div class="file-info-grid">
      ${details.map(renderFileInfoRow).join('')}
    </div>
  `
}

/**
 * 构建文件信息字段
 */
function buildFileInfoDetails() {
  const variableCount = meta ? meta.headers.length : 0
  const release = meta && meta.release ? meta.release : bootstrap.l10n.Unknown
  const byteOrder = meta && meta.byteOrder ? meta.byteOrder : bootstrap.l10n.Unknown
  return [
    [bootstrap.l10n.FileName, fileInfoState.fileName],
    [bootstrap.l10n.FilePath, fileInfoState.filePath],
    [bootstrap.l10n.FileSize, formatBytes(fileInfoState.fileSize, bootstrap.l10n.Unknown)],
    [bootstrap.l10n.LastUpdated, fileInfoState.lastModified],
    [bootstrap.l10n.StataRelease, release],
    [bootstrap.l10n.ByteOrder, byteOrder],
    [bootstrap.l10n.DataVolume, formatInt(totalAll)],
    [bootstrap.l10n.VariablesCount, formatInt(variableCount)],
  ]
}

/**
 * 渲染文件信息字段行
 */
function renderFileInfoRow([label, value]) {
  return `
    <div class="file-info-label">${escapeHtml(label)}</div>
    <div class="file-info-value" title="${escapeHtml(value)}">${escapeHtml(value)}</div>
  `
}
