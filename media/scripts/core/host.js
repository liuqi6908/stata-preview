/**
 * Webview 与扩展宿主的请求通道。
 */

// ---------- 请求状态 ----------

/** 最新请求 id */
let lastRequestId = 0
/** 等待宿主响应的请求 */
const pending = new Map()
/** 各通道最近一次请求，用于实现“最新请求优先” */
const latestByChannel = new Map()

// ---------- 请求发送 ----------

/**
 * 生成新的请求 id
 */
function nextRequestId() {
  return ++lastRequestId
}

/**
 * 发送普通宿主请求
 */
function postRequest(command, payload) {
  const requestId = nextRequestId()
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    vscode.postMessage({ command, requestId, ...payload })
  })
}

/**
 * 发送同通道仅保留最新结果的宿主请求
 */
async function postLatest(channel, command, payload) {
  const requestId = nextRequestId()
  latestByChannel.set(channel, requestId)
  const result = await new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    vscode.postMessage({ command, requestId, ...payload })
  })
  // 同通道已有更新请求，调用方会忽略该哨兵错误
  if (latestByChannel.get(channel) !== requestId)
    throw new StaleRequestError(channel)
  return result
}

// ---------- 请求错误 ----------

/**
 * 过期请求错误
 */
class StaleRequestError extends Error {
  constructor(channel) {
    super(`stale request on ${channel}`)
    this.stale = true
  }
}
