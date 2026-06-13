/**
 * offscreen/index.ts — 隐藏 offscreen 文档,托管 chat.qwen.ai iframe。
 *
 * 为何存在: qwen completions 风控要 baxia 在真页面 page-context 当场注入 bx-ua,
 * 并共享浏览器 cookie(含过滑块后的 x5sec)。SW/Node 直发或复制 bx-ua 都撞 RGV587
 * (实测 2026-06-13)。offscreen 文档无窗口、无 tab、用户不可见,但有完整 DOM,
 * 可嵌跨域 iframe → 把"已验证可用的网页 fetch 环境"塞进后台。
 *
 * 中继链:
 *   SW  --chrome.runtime.sendMessage-->  offscreen.js
 *   offscreen.js  --iframe.postMessage-->  qwen-iframe content.js (OFFSCREEN_PF_*)
 *   content.js  --window.postMessage-->  page-bridge  (原生 fetch, baxia 注入 bx-ua)
 *   page-bridge  -->  content.js  -->  offscreen.js  -->  SW
 *
 * offscreen 只能用 chrome.runtime 消息(无 tabs.connect),所以流式分块经
 * runtime.sendMessage 逐块回传给 SW(见 background/offscreen-manager.ts 的收端)。
 */

const QWEN_IFRAME_URL = 'https://chat.qwen.ai/'

// SW ↔ offscreen (chrome.runtime). target:'offscreen' 区分给本文档的消息。
const MSG_PING = 'PIERCODE_OFFSCREEN_PING'
const MSG_FETCH = 'PIERCODE_OFFSCREEN_FETCH'        // SW → offscreen: 发一个 qwen 请求
const MSG_ABORT = 'PIERCODE_OFFSCREEN_ABORT'        // SW → offscreen: 取消
const MSG_HEAD = 'PIERCODE_OFFSCREEN_HEAD'          // offscreen → SW
const MSG_CHUNK = 'PIERCODE_OFFSCREEN_CHUNK'
const MSG_DONE = 'PIERCODE_OFFSCREEN_DONE'
const MSG_ERROR = 'PIERCODE_OFFSCREEN_ERROR'
const MSG_READY = 'PIERCODE_OFFSCREEN_READY'        // offscreen → SW: iframe content 就绪

// offscreen ↔ iframe content.js (window.postMessage)
const OFFSCREEN_PF = 'PIERCODE_OFFSCREEN_PF'             // offscreen → iframe: 执行 fetch
const OFFSCREEN_PF_ABORT = 'PIERCODE_OFFSCREEN_PF_ABORT' // offscreen → iframe: 取消
const OFFSCREEN_PF_HEAD = 'PIERCODE_OFFSCREEN_PF_HEAD'   // iframe → offscreen
const OFFSCREEN_PF_CHUNK = 'PIERCODE_OFFSCREEN_PF_CHUNK'
const OFFSCREEN_PF_DONE = 'PIERCODE_OFFSCREEN_PF_DONE'
const OFFSCREEN_PF_ERROR = 'PIERCODE_OFFSCREEN_PF_ERROR'
const OFFSCREEN_READY = 'PIERCODE_OFFSCREEN_IFRAME_READY' // iframe → offscreen: content 已加载

let iframe: HTMLIFrameElement | null = null
let iframeReady = false
const readyWaiters: Array<() => void> = []

function buildIframe(): void {
  if (iframe) return
  iframe = document.createElement('iframe')
  iframe.src = QWEN_IFRAME_URL
  // 不可见即可;offscreen 文档本身已不显示,但给个尺寸让 baxia 的布局相关指纹正常。
  iframe.style.cssText = 'position:absolute;width:1280px;height:800px;border:0;left:-99999px;top:0;'
  document.body.appendChild(iframe)
}

// iframe 内 content.js 加载后会 postMessage(OFFSCREEN_READY)。在此前发来的请求排队。
function whenIframeReady(): Promise<void> {
  if (iframeReady) return Promise.resolve()
  return new Promise(resolve => readyWaiters.push(resolve))
}

window.addEventListener('message', (event: MessageEvent) => {
  const d = event.data
  if (!d || typeof d.type !== 'string') return

  if (d.type === OFFSCREEN_READY) {
    iframeReady = true
    readyWaiters.splice(0).forEach(fn => fn())
    chrome.runtime.sendMessage({ target: 'sw', type: MSG_READY }).catch(() => {})
    return
  }

  // iframe → offscreen → SW 流式回传
  const requestId = d.requestId
  if (typeof requestId !== 'string') return
  switch (d.type) {
    case OFFSCREEN_PF_HEAD:
      chrome.runtime.sendMessage({ target: 'sw', type: MSG_HEAD, requestId, ok: d.ok, status: d.status }).catch(() => {})
      break
    case OFFSCREEN_PF_CHUNK:
      chrome.runtime.sendMessage({ target: 'sw', type: MSG_CHUNK, requestId, b64: d.b64 }).catch(() => {})
      break
    case OFFSCREEN_PF_DONE:
      chrome.runtime.sendMessage({ target: 'sw', type: MSG_DONE, requestId }).catch(() => {})
      break
    case OFFSCREEN_PF_ERROR:
      chrome.runtime.sendMessage({ target: 'sw', type: MSG_ERROR, requestId, error: d.error }).catch(() => {})
      break
  }
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return
  switch (msg.type) {
    case MSG_PING:
      sendResponse({ ok: true, ready: iframeReady })
      return
    case MSG_FETCH:
      void (async () => {
        await whenIframeReady()
        iframe?.contentWindow?.postMessage({
          type: OFFSCREEN_PF,
          requestId: msg.requestId,
          url: msg.url,
          method: msg.method,
          headers: msg.headers,
          body: msg.body,
          stream: msg.stream,
        }, '*')
      })()
      sendResponse({ ok: true })
      return
    case MSG_ABORT:
      iframe?.contentWindow?.postMessage({ type: OFFSCREEN_PF_ABORT, requestId: msg.requestId }, '*')
      sendResponse({ ok: true })
      return
  }
})

buildIframe()
