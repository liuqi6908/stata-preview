/**
 * 侧边栏、表格列与行详情面板拖拽尺寸调整。
 */

// ---------- 变量面板尺寸 ----------

/**
 * 初始化侧边栏拖拽手柄
 */
function initResizeHandle() {
  let isResizing = false
  let startX = 0
  let startY = 0
  let startW = 0
  let startH = 0
  let resizeMode = 'horizontal'
  let pendingSize = 0
  let resizeRaf = 0

  const applyPanelSize = (size) => {
    const prop = resizeMode === 'horizontal' ? '--sidebar-width' : '--sidebar-height'
    layoutContainer.style.setProperty(prop, `${size}px`)
  }

  const queuePanelSize = (size) => {
    pendingSize = size
    if (resizeRaf)
      return
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0
      applyPanelSize(pendingSize)
    })
  }

  const finishResize = () => {
    if (!isResizing)
      return
    if (resizeRaf) {
      cancelAnimationFrame(resizeRaf)
      resizeRaf = 0
      applyPanelSize(pendingSize)
    }
    isResizing = false
    layoutContainer.classList.remove('is-resizing')
  }

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true
    resizeMode = sidebarPosition === 'right' ? 'horizontal' : 'vertical'
    startX = e.clientX
    startY = e.clientY
    if (resizeMode === 'horizontal')
      startW = sidebar.getBoundingClientRect().width
    else
      startH = sidebar.getBoundingClientRect().height
    pendingSize = resizeMode === 'horizontal' ? startW : startH
    layoutContainer.classList.add('is-resizing')
    e.preventDefault()
  })
  document.addEventListener('mousemove', (e) => {
    if (!isResizing)
      return
    if (resizeMode === 'horizontal') {
      const delta = startX - e.clientX
      queuePanelSize(Math.max(150, Math.min(600, startW + delta)))
    }
    else {
      const delta = startY - e.clientY
      queuePanelSize(Math.max(100, Math.min(500, startH + delta)))
    }
  })
  document.addEventListener('mouseup', finishResize)
  window.addEventListener('blur', finishResize)
}

// ---------- 行详情高度 ----------

/**
 * 初始化行详情面板高度拖拽手柄
 */
function initRowDetailResizeHandle() {
  let isResizing = false
  let startY = 0
  let startH = 0
  let pendingHeight = 0
  let resizeRaf = 0

  const normalizeHeight = (height) => {
    const minHeight = 120
    const panelHeight = mainPanel.clientHeight || window.innerHeight || 600
    const maxHeight = Math.max(minHeight, Math.min(panelHeight - 160, panelHeight * 0.75))
    return Math.max(minHeight, Math.min(maxHeight, height))
  }

  const applyHeight = (height) => {
    rowDetailPanel.style.setProperty('--row-detail-height', `${normalizeHeight(height)}px`)
  }

  const queueHeight = (height) => {
    pendingHeight = height
    if (resizeRaf)
      return
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0
      applyHeight(pendingHeight)
    })
  }

  const finishResize = () => {
    if (!isResizing)
      return
    if (resizeRaf) {
      cancelAnimationFrame(resizeRaf)
      resizeRaf = 0
      applyHeight(pendingHeight)
    }
    isResizing = false
    mainPanel.classList.remove('row-detail-resizing')
    requestAnimationFrame(renderBodyWindow)
  }

  rowDetailResizeHandle.addEventListener('mousedown', (e) => {
    if (rowDetailPanel.hidden)
      return
    isResizing = true
    startY = e.clientY
    startH = rowDetailPanel.getBoundingClientRect().height
    pendingHeight = startH
    mainPanel.classList.add('row-detail-resizing')
    e.preventDefault()
  })
  document.addEventListener('mousemove', (e) => {
    if (!isResizing)
      return
    queueHeight(startH - (e.clientY - startY))
  })
  document.addEventListener('mouseup', finishResize)
  window.addEventListener('blur', finishResize)
}

// ---------- 行详情列宽 ----------

/**
 * 初始化行详情表列宽拖拽手柄
 */
function initRowDetailColumnResize() {
  let resizingTh = null
  let resizingIndex = -1
  let startX = 0
  let startWidth = 0

  const finishResize = () => {
    if (!resizingTh)
      return
    resizingTh.classList.remove('is-resizing')
    resizingTh = null
    resizingIndex = -1
  }

  rowDetailTable.querySelectorAll('thead th').forEach((th, index) => {
    if (th.querySelector('.row-detail-column-resize-handle'))
      return
    const handle = document.createElement('div')
    handle.className = 'resize-handle row-detail-column-resize-handle'
    th.appendChild(handle)
    handle.addEventListener('mousedown', (e) => {
      resizingTh = th
      resizingIndex = index
      startX = e.clientX
      startWidth = rowDetailColumnWidths[index] || th.offsetWidth
      th.classList.add('is-resizing')
      e.stopPropagation()
      e.preventDefault()
    })
  })

  document.addEventListener('mousemove', (e) => {
    if (!resizingTh || resizingIndex < 0)
      return
    const width = Math.max(60, startWidth + e.clientX - startX)
    rowDetailColumnWidths[resizingIndex] = width
    syncRowDetailColumnLayout()
  })
  document.addEventListener('mouseup', finishResize)
  window.addEventListener('blur', finishResize)
}

// ---------- 表格列宽 ----------

/** 正在调整宽度的列 */
let resizingCol = null
/** 列宽拖拽起始 X 坐标 */
let resizeStartX = 0
/** 列宽拖拽起始宽度 */
let resizeStartWidth = 0
/** 是否已绑定列宽拖拽全局事件 */
let columnResizeListenersReady = false

/**
 * 结束列宽拖拽
 */
function finishColumnResize() {
  if (!resizingCol)
    return
  resizingCol.classList.remove('is-resizing')
  resizingCol = null
}

/**
 * 初始化列宽拖拽手柄
 */
function initColumnResize() {
  const ths = tableHead.querySelectorAll('th')
  ths.forEach((th) => {
    if (th.querySelector('.resize-handle'))
      return
    const handle = document.createElement('div')
    handle.className = 'resize-handle'
    th.appendChild(handle)
    handle.addEventListener('mousedown', (e) => {
      resizingCol = th
      resizeStartX = e.clientX
      resizeStartWidth = th.offsetWidth
      th.classList.add('is-resizing')
      e.stopPropagation()
      e.preventDefault()
    })
  })
  if (columnResizeListenersReady)
    return
  columnResizeListenersReady = true
  document.addEventListener('mousemove', (e) => {
    if (!resizingCol)
      return
    const delta = e.clientX - resizeStartX
    const w = Math.max(40, resizeStartWidth + delta)
    resizingCol.style.width = `${w}px`
    // 记录用户列宽，避免排序、筛选、分页重绘后丢失
    const col = resizingCol.dataset.col
    if (col != null) {
      colWidths[col] = w
      syncTableColumnLayout()
    }
  })
  document.addEventListener('mouseup', finishColumnResize)
  window.addEventListener('blur', finishColumnResize)
}
