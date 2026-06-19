/**
 * browser-agent.ts — 浏览器操作 Agent 的 SW 端编排器
 *
 * 与 chat-api.ts 的 API 子 agent 引擎**完全独立**：那套走 API（runSubAgent /
 * runIsolatedConversation），这套走「侧边栏内嵌的 AI 网页 iframe」。本文件持有一个
 * 活跃任务的闭环：
 *   取被操作 tab 快照 → BROWSER_AGENT_INJECT 进 AI iframe → 等 BROWSER_AGENT_TOOLS
 *   →（autopilot 直跑 / 高危 BROWSER_AGENT_APPROVAL 往返）→ execTool(browser_*) →
 *   重新取快照 + 注回结果 → 循环，直到 tools 为空 / 用户停止 / 深度上限。
 *
 * 复用而非重写：execTool / extractToolCalls / processSSEStream / PLATFORMS 都从
 * chat-api 复用（已 export）；execTool 未 export，故这里复制同形的 ~30 行 /exec
 * POST helper（与 chat-api execTool 行为一致），并作为 DI 注入 runBrowserAgentLoop，
 * 使单测可喂 mock（spec §6）。不注册第二个 installApiListenReceiver，不引用
 * chat-api 的 sidebar reducer。
 *
 * 消息隔离：全部 BROWSER_AGENT_ 前缀消息与 CHAT_ / CHAT_AGENT_ 前缀完全不相交。
 */

import { extractToolCalls } from './chat-api'
import { dispatchBrowserTool, TOOL_TABLE } from './browser/dispatch'
import { formatToolResults } from '../parser'
import { buildPageSnapshot, composeTurnPrompt } from './page-snapshot'

// ── Types ──────────────────────────────────────────────────────────────────
// 与 sidebar/ToolCard.tsx 导出的 ToolCall/ToolResult 同形（契约要求复用其形状）。
// chat-api.ts 里的同名 interface 是模块私有，不能 import；这里本地重声明同一形状。

interface ToolCall {
  name: string
  args: Record<string, unknown>
  call_id: string
}

interface ToolResult {
  call_id: string
  name: string
  output: string
  success: boolean
}

/** runBrowserAgentLoop 的终止结果。 */
type LoopReason = 'completed' | 'stopped' | 'max-depth' | 'tab-gone'

/** 一轮闭环最多迭代次数（每轮 = 一次注入 + 一次 AI 回复 + 其工具执行）。 */
export const MAX_BROWSER_AGENT_STEPS = 24

/** 被操作 tab 上每个动作的展示输出截断长度（喂回 AI 与时间线复用）。 */
const TOOL_OUTPUT_DISPLAY_LIMIT = 4000

// ── 高危分类器（纯函数，单测覆盖） ─────────────────────────────────────────

/** 高危动作文本特征（购买/支付/删除/发送/确认/下单…）。 */
const DESTRUCTIVE_TEXT_RE =
  /(buy|pay|purchase|checkout|order|place\s*order|subscribe|confirm|delete|remove|删除|购买|支付|下单|结算|提交订单|确认|发送)/i

/** 提交/发送类按键。 */
const SUBMIT_KEY_RE = /^(enter|ctrl\+enter|cmd\+enter|meta\+enter)$/i

/** http/https origin 提取；非法或非 http(s) 返回 null。 */
function httpOrigin(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

/**
 * classifyRisk：判定一个 browser_* 动作是否高危（需用户批准）。纯函数 —— 不碰
 * chrome/CDP；规则 3（点击目标文本）所需的 ref→文本解析作为 refText 注入，保持可测。
 * autopilot 默认放行，仅以下谓词命中返回 highRisk:true（除非本任务已置「全程放行」）：
 *  1. 跨域导航 / 非 http(s) scheme 的 browser_navigate
 *  2. browser_type{submit:true} 或 browser_press_key 的提交键
 *  3. browser_click 且目标文本命中危险词（refText(ref) 优先，否则 selector）
 *  4. browser_file_input（上传文件）
 *  5. browser_evaluate（执行页面脚本）
 *  6. browser_batch 内任一动作高危（递归）
 *
 * 受控页 origin（同源导航放行用）经独立的 currentOrigin 形参传入，**绝不**写进 args
 * —— args 里的嵌套对象（尤其 browser_batch 的 action.input）与调用方持有的 call.args
 * 是同一引用，会被原样下发给 Go server；往里塞 __currentOrigin 会污染下发载荷（契约：
 * __currentOrigin 不下发）。为兼容历史调用形状，currentOrigin 缺省时回落到 args.__currentOrigin，
 * 但本函数自身不再注入该键。
 */
export function classifyRisk(
  name: string,
  args: Record<string, unknown>,
  refText?: (ref: string) => string,
  currentOrigin?: string,
): { highRisk: boolean; reason: string } {
  const safe = { highRisk: false, reason: '' }
  // 受控页 origin：优先显式形参；为兼容历史调用回落到 args.__currentOrigin（只读，不写）。
  const current =
    typeof currentOrigin === 'string' && currentOrigin
      ? currentOrigin
      : typeof args.__currentOrigin === 'string'
        ? (args.__currentOrigin as string)
        : ''

  switch (name) {
    case 'browser_navigate': {
      const url = String(args.url || '')
      const origin = httpOrigin(url)
      if (origin === null) {
        return { highRisk: true, reason: `非 http(s) 导航：${url}` }
      }
      // 受控页 origin 未知（about:blank / 解析失败 / 首解析前）时**保守 gate**而非按同源
      // 放行：原来 `if (current && ...)` 在 current 为空时短路放行，使 about:blank 等状态
      // 下到任意跨域 URL 的导航逃过审批（审计 Bug #19）。只有 current 已知且与目标同源
      // 才免提示。
      if (origin !== current) {
        let host = origin
        try { host = new URL(url).host } catch { /* keep origin */ }
        return { highRisk: true, reason: current ? `cross-origin navigate to ${host}` : `navigate to ${host} (current origin unknown)` }
      }
      return safe
    }

    case 'browser_type': {
      if (args.submit === true) return { highRisk: true, reason: 'submits the form / sends' }
      return safe
    }

    case 'browser_press_key': {
      if (SUBMIT_KEY_RE.test(String(args.key || ''))) {
        return { highRisk: true, reason: 'submits the form / sends' }
      }
      return safe
    }

    case 'browser_click': {
      const ref = String(args.ref || '')
      const text = ref && refText ? refText(ref) : String(args.selector || '')
      if (text && DESTRUCTIVE_TEXT_RE.test(text)) {
        return { highRisk: true, reason: 'destructive/purchase action' }
      }
      // mark 点击（browser_click {mark:<n>}）既无 ref 也无 selector，destructive 文本
      // 检查拿不到目标文本，会误判 safe —— AI 可借 mark 编号点到 购买/Delete 按钮绕过
      // 门控（审计 Bug #13）。SW 端不持 mark→标签映射（快照走 text 模式），故保守处理：
      // 凡标签未知的 mark 点击一律 gate，让用户确认。
      if (args.mark !== undefined && args.mark !== null && !text) {
        return { highRisk: true, reason: 'click by mark (target label unknown)' }
      }
      return safe
    }

    // 真实注册的工具名才列（审计 Bug #20：原来还列了 browser_file_input /
    // browser_upload_file / browser_exec 三个**不存在**的工具名，是照猜测清单写的，
    // 给人"已覆盖"的错觉，正是 set_cookie/form_input 等真工具漏 gate 的同源问题）。
    case 'browser_upload':
      return { highRisk: true, reason: 'uploads a file' }

    case 'browser_evaluate':
      return { highRisk: true, reason: 'runs page script' }

    // 服务端会 gate 但 classifyRisk 原先漏掉的真实可变工具（cookie 写 / 剪贴板 / 弹窗
    // 处理 / 表单值设置）：补进高危集，让侧边栏 agent 路径也弹批准卡，不再仅靠服务端
    // ask（那条可被站点级 grant 或自动批准旁路）。
    case 'browser_set_cookie':
    case 'browser_cookies':
      return { highRisk: true, reason: 'reads/writes cookies' }
    case 'browser_storage':
      return { highRisk: true, reason: 'reads/writes site storage' }
    case 'browser_clipboard':
      return { highRisk: true, reason: 'accesses clipboard' }
    case 'browser_handle_dialog':
      return { highRisk: true, reason: 'handles a page dialog' }
    case 'browser_attachment_upload':
      return { highRisk: true, reason: 'uploads a file' }

    case 'browser_batch': {
      const actions = Array.isArray(args.actions) ? args.actions : []
      for (const raw of actions) {
        if (!raw || typeof raw !== 'object') continue
        const a = raw as { name?: unknown; input?: unknown }
        const childName = String(a.name || '')
        const childArgs = (a.input && typeof a.input === 'object' ? a.input : {}) as Record<string, unknown>
        // 子动作继承父的受控 origin（经形参传递，绝不写进 childArgs —— 那是会下发给
        // Go server 的同一引用对象）。
        const r = classifyRisk(childName, childArgs, refText, current)
        if (r.highRisk) return r
      }
      return safe
    }

    default:
      return safe
  }
}

// ── 编排循环（DI 接缝，spec §6 让 vitest 用 mock 驱动） ─────────────────────

interface LoopOpts {
  platform: string
  task: string
  targetTabId: number | null
  signal: AbortSignal
  emit: (msg: Record<string, unknown>) => void
  inject: (prompt: string, agentTurnId: string) => Promise<{ ok: boolean; error?: string }>
  awaitTools: (agentTurnId: string) => Promise<{ tools: ToolCall[]; rawContent: string }>
  exec: (name: string, args: Record<string, unknown>, callId?: string) => Promise<ToolResult>
  gate: (call: ToolCall) => Promise<'approve' | 'skip'>
  /** 向用户提问（question 工具）：弹侧边栏提问卡，resolve 为用户回答文本（空=未答）。 */
  askQuestion: (callId: string, question: string, options: string[]) => Promise<string>
  /** 可选：解析当前受控页的 origin（同源导航放行）。production 注入实时值；
   *  测试省略时按空（同源处理，跨域规则只对非 http(s) 触发）。 */
  currentOrigin?: () => string
  /** 可选：解析最近一次快照里 ref 的可见文本（classifyRisk 规则 3 用）。
   *  production 由 startBrowserAgentTask 用每轮快照刷新；测试可省略（返回空）。 */
  refText?: (ref: string) => string
}

/** 生成本任务内唯一的 turn id（注入/回读/流式都带它，丢弃过期回读）。 */
let turnSeq = 0
function nextTurnId(): string {
  turnSeq += 1
  return `bat-${Date.now().toString(36)}-${turnSeq}`
}

/** 给某调用补上 call_id（缺失时生成），返回稳定 id。 */
function callIdOf(call: ToolCall): string {
  return call.call_id || `bat-call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** browser_* 工具（操作浏览器）+ question（向用户提问）在浏览器 agent 回合里有意义；
 *  其余（文件/shell 工具）丢弃，防止 AI 误吐的 write_file/exec_cmd 经 rawContent
 *  reparse 原样下发执行（Bug #5）。question 不走 /exec，由 loop 路由成侧边栏提问卡。 */
function isBrowserToolName(name: string): boolean {
  return typeof name === 'string' && (name.startsWith('browser_') || name === 'question')
}

/** 截断展示输出（喂回 AI 与时间线均用此）。 */
function clampOutput(output: string): string {
  if (output.length <= TOOL_OUTPUT_DISPLAY_LIMIT) return output
  return output.slice(0, TOOL_OUTPUT_DISPLAY_LIMIT) + '\n…（已截断）'
}

/**
 * runBrowserAgentLoop：纯编排（IO 全经 DI 接缝）。负责注入→等工具→高危门控→
 * 执行→注回，循环到 tools 为空 / abort / 步数上限 / tab 丢失。每轮的页面快照在
 * inject 接缝内部取（startBrowserAgentTask 的 injectTurn 实现），这里只把 prompt
 * body 拼好（首轮=任务，后续轮=上一步结果）再交 inject；ref→文本与受控页 origin
 * 经可选 refText()/currentOrigin() 接缝读取（production 由 injectTurn 每轮刷新，
 * 测试可省略）。lastResultsBody 是闭包局部，绝不跨任务共享。
 */
export async function runBrowserAgentLoop(opts: LoopOpts): Promise<{ reason: LoopReason; summary?: string }> {
  const { signal, emit, inject, awaitTools, exec, gate, askQuestion } = opts
  const refText = opts.refText || (() => '')
  const currentOrigin = opts.currentOrigin || (() => '')

  // 后续轮的 prompt body（上一步工具结果）。闭包局部 —— 多任务并发也互不串台。
  let lastResultsBody = ''

  for (let step = 0; step < MAX_BROWSER_AGENT_STEPS; step++) {
    if (signal.aborted) return { reason: 'stopped' }

    const agentTurnId = nextTurnId()

    // inject 内部完成「取新快照 + 拼 prompt（首轮带 profile 前缀）→ 写 composer →
    // 等 send 按钮 enabled 后提交 → 等 INJECT_ACK」，回 {ok,error}。
    const body = step === 0 ? opts.task : lastResultsBody
    const injected = await inject(body, agentTurnId)
    if (signal.aborted) return { reason: 'stopped' }
    if (!injected.ok) {
      emit({ type: 'BROWSER_AGENT_ERROR', agentTurnId, error: injected.error || '注入 AI 网页失败' })
      return { reason: 'tab-gone' }
    }

    // 等 AI 回复被桥解析出的工具调用。
    let reply: { tools: ToolCall[]; rawContent: string }
    try {
      reply = await awaitTools(agentTurnId)
    } catch (e) {
      if (signal.aborted) return { reason: 'stopped' }
      emit({ type: 'BROWSER_AGENT_ERROR', agentTurnId, error: e instanceof Error ? e.message : String(e) })
      return { reason: 'tab-gone' }
    }
    if (signal.aborted) return { reason: 'stopped' }

    // 桥优先回 tools；为兜底也从 rawContent 再解析一次（桥漏解析时仍能拿到工具）。
    // 只保留 browser_* —— extractToolCalls 不带前缀过滤（桥的 isBrowserToolName 才过滤），
    // 若不在此再过滤，AI 误吐的 write_file/exec_cmd 等会经 execBrowserTool 原样 POST 到
    // /exec 真执行（审计 Bug #5 第二层：prompt 收紧后仍需 SW 侧守门）。browser-agent
    // 回合里只有 browser_* 有意义，其余一律丢弃。
    let tools = reply.tools
    if ((!tools || tools.length === 0) && reply.rawContent) {
      const reparsed = extractToolCalls(reply.rawContent).filter(t => isBrowserToolName(t.name))
      if (reparsed.length > 0) tools = reparsed
    }

    if (!tools || tools.length === 0) {
      // 无工具块 = AI 自然语言收尾。
      const summary = (reply.rawContent || '').trim()
      emit({ type: 'BROWSER_AGENT_DONE', agentTurnId, reason: 'completed', summary })
      return { reason: 'completed', summary }
    }

    // 顺序执行本轮工具（autopilot 直跑，高危先门控）。
    const results: ToolResult[] = []
    for (const call of tools) {
      if (signal.aborted) return { reason: 'stopped' }
      const callId = callIdOf(call)

      // question 工具：不走 /exec —— 路由成侧边栏提问卡，等用户回答，把回答作为工具
      // 结果喂回 AI，循环继续（之前 question 被丢，AI 想问用户却无处可答）。
      if (call.name === 'question') {
        const q = typeof call.args.question === 'string' ? call.args.question
          : typeof call.args.prompt === 'string' ? call.args.prompt : '（AI 需要你的确认）'
        const opts = Array.isArray(call.args.options) ? call.args.options.map(String) : []
        emit({ type: 'BROWSER_AGENT_TOOL', callId, name: call.name, args: call.args, agentTurnId })
        let answer: string
        try {
          answer = await askQuestion(callId, q, opts)
        } catch {
          answer = ''
        }
        if (signal.aborted) return { reason: 'stopped' }
        const out = answer ? `用户回答：${answer}` : '用户未回答'
        results.push({ call_id: callId, name: call.name, output: out, success: !!answer })
        emit({ type: 'BROWSER_AGENT_TOOL_DONE', callId, name: call.name, output: out, success: !!answer, agentTurnId })
        continue
      }

      // 受控页 origin 经形参传给 classifyRisk 判同源导航，绝不写进 call.args
      // （call.args 及其嵌套 input 会原样下发给 Go server；契约：__currentOrigin 不下发）。
      const risk = classifyRisk(call.name, call.args, refText, currentOrigin())
      if (risk.highRisk) {
        const decision = await gate({ name: call.name, args: call.args, call_id: callId })
        if (signal.aborted) return { reason: 'stopped' }
        if (decision === 'skip') {
          const skipped: ToolResult = { call_id: callId, name: call.name, output: '用户跳过此动作', success: false }
          results.push(skipped)
          emit({ type: 'BROWSER_AGENT_TOOL_DONE', callId, name: call.name, output: skipped.output, success: false, agentTurnId })
          continue
        }
      }

      emit({ type: 'BROWSER_AGENT_TOOL', callId, name: call.name, args: call.args, agentTurnId })
      let res: ToolResult
      try {
        res = await exec(call.name, call.args, callId)
      } catch (e) {
        res = { call_id: callId, name: call.name, output: `执行失败: ${e instanceof Error ? e.message : String(e)}`, success: false }
      }
      const display = clampOutput(res.output || '')
      results.push({ ...res, output: display })
      emit({ type: 'BROWSER_AGENT_TOOL_DONE', callId, name: call.name, output: display, success: res.success, agentTurnId })

      // tab 关闭/不可达：browser_* 会回错误字串，这里检测后终止整轮闭环。
      if (!res.success && isTabGoneError(res.output)) {
        emit({ type: 'BROWSER_AGENT_DONE', agentTurnId, reason: 'tab-gone' })
        return { reason: 'tab-gone' }
      }
    }

    // 序列化本轮结果作为下一轮 prompt 的 body（"上一步结果："）。
    lastResultsBody = formatToolResults(
      results.map(r => ({ name: r.name, call_id: r.call_id, output: r.output })),
    )
  }

  // 步数上限。
  emit({ type: 'BROWSER_AGENT_DONE', reason: 'max-depth' })
  return { reason: 'max-depth' }
}

/** browser_* 错误是否表示 tab 关闭/不可达。 */
function isTabGoneError(output: string): boolean {
  const o = output || ''
  return (
    /No tab with id/i.test(o) ||
    /tab .* (closed|gone|unreachable)/i.test(o) ||
    /No controlled tab/i.test(o) ||
    /controlled tab .* not found/i.test(o)
  )
}

// ── /exec POST helper（复制 chat-api execTool 行为；execTool 未 export） ──────

async function execBrowserTool(
  name: string,
  args: Record<string, unknown>,
  callId?: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const cid = callId || `bagent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  // Browser tools that have been migrated to in-SW execution run here (same process,
  // no /exec): they work with the Go server down and never traverse the cross-browser
  // WS. dispatchBrowserTool applies the same per-tab lock + sensitivity/approval gates.
  // Tools not yet migrated fall through to the /exec POST below.
  if (TOOL_TABLE.has(name)) {
    const r = await dispatchBrowserTool(name, args, cid)
    return { call_id: cid, name, output: r.output, success: r.success }
  }
  try {
    const { apiUrl, authToken } = await chrome.storage.local.get(['apiUrl', 'authToken'])
    if (!apiUrl || !authToken) {
      return { call_id: cid, name, output: '错误：未连接 PierCode 服务', success: false }
    }
    // signal 串到 fetch：任务被 STOP/抢占 abort 时，正在飞行的 /exec 立即取消，
    // 循环的下一个 signal.aborted 守卫即时返回 stopped，释放受控 tab 给抢占任务
    // （Bug #6；同时收窄 Bug #1 的危险窗口）。
    const res = await fetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ name, call_id: cid, args }),
      signal,
    })
    if (!res.ok) {
      const text = await res.text()
      return { call_id: cid, name, output: `HTTP ${res.status}: ${text}`, success: false }
    }
    const data = await res.json()
    return {
      call_id: cid,
      name,
      output: data.output || data.error || JSON.stringify(data),
      success: !data.error,
    }
  } catch (error) {
    return {
      call_id: cid,
      name,
      output: `执行失败: ${error instanceof Error ? error.message : String(error)}`,
      success: false,
    }
  }
}

/** SW → 侧边栏广播（runtime.sendMessage，sidebar 关闭时静默）。 */
function broadcast(msg: Record<string, unknown>) {
  chrome.runtime.sendMessage(msg).catch(() => {})
}

/** 取 browser-agent profile prompt（一次性，预置到首轮注入文本前；镜像 fetchWorkerPrompt）。 */
let browserAgentPromptCache: string | null = null
async function fetchBrowserAgentPrompt(): Promise<string> {
  if (browserAgentPromptCache !== null) return browserAgentPromptCache
  try {
    const { apiUrl, authToken } = await chrome.storage.local.get(['apiUrl', 'authToken'])
    if (apiUrl && authToken) {
      const res = await fetch(`${apiUrl}/prompt?profile=browser-agent`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
      if (res.ok) {
        browserAgentPromptCache = await res.text()
        return browserAgentPromptCache
      }
    }
  } catch {
    // 落到内联兜底
  }
  browserAgentPromptCache =
    '你是浏览器操作 agent，通过 browser_* 工具驱动用户的真实浏览器页面。每轮你会收到一段 ' +
    '<page-snapshot>，里面是带 e<N> ref（e0/e1/…）的可交互元素。只对快照中真实存在的 ref 操作，' +
    '不要臆造。每轮只输出一个 piercode-tool 块（或 browser_batch 串联多步）。操作完等结果 + 新快照' +
    '再继续；任务完成时输出不含工具块的自然语言总结作为收尾信号。'
  return browserAgentPromptCache
}

// ── 运行时状态：单活跃任务 + 桥端口 + 待决 promise ───────────────────────────

interface ActiveTask {
  agentTurnId: string // 当前轮（注入/回读匹配用），随每轮更新
  /**
   * 发起本任务的 store 生成的稳定标识（随 BROWSER_AGENT_TASK 传入）。SW 把它回戳到
   * 本任务的每一条广播上，让多 store（side-panel + 弹出全屏 tab 并存）按身份过滤：
   * 一个 store 只认自己 taskId 的终止/工具信号，被抢占的旧任务的 DONE 不会误翻新任务。
   */
  taskId: string
  platform: string
  targetTabId: number | null
  abort: AbortController
  allowAll: boolean
  /** 已注入的轮次计数；0 表示下一次是首轮（带 profile 前缀）。 */
  injectedTurns: number
  /** 最近一次快照的 ref → 可见文本（classifyRisk 规则 3）。 */
  refText: Map<string, string>
  /** 最近一次受控页 origin（同源导航放行）。 */
  currentOrigin: string
  /** 已确认控制 tab 的 url/title（注入快照属性用）。 */
  tabInfo: { tabId: number | null; title?: string; url?: string }
  /**
   * 本任务是否已向侧边栏广播过终止信号（DONE/ERROR）。契约：store 一旦置 running，
   * 必须且只能收到 **恰好一次** DONE/ERROR，否则 UI 永久卡在「AI 正在操作浏览器…」。
   * 由 emitForTask 包装设置；startBrowserAgentTask 的 finally 据此补发兜底 DONE。
   */
  terminalEmitted: boolean
  /**
   * 本任务在三个全局待决表（pendingInjectAcks/pendingTools/pendingApprovals）里
   * 注册过的 turnId / callId。cleanupTaskPending 据此**只**清理本任务自己的待决项
   * （Bug #1）：被抢占任务的 finally 跑全局 clear() 会误伤刚启动的新任务正在等待的
   * inject/tools/approval，导致新任务被旧任务的清理静默杀死。改为 task-scoped 后，
   * 每个任务只 settle 自己登记的 turnId/callId，互不干扰。
   */
  ownedTurnIds: Set<string>
  ownedCallIds: Set<string>
}

let activeTask: ActiveTask | null = null

// ── MV3 SW 存活与崩溃恢复 ───────────────────────────────────────────────────
//
// 根因（诊断 PRIMARY）：MV3 SW 空闲 ~30s 即被击杀；本任务的循环在 sendResponse 后
// detached 运行，loop 会阻塞在 INJECT_ACK(30s) / awaitTools(180s) 上而无任何东西
// 维持 SW 存活。SW 一死，activeTask/pendingTools/pendingInjectAcks 全部蒸发，被阻塞
// 的 promise 不会 resolve/reject、finally 不跑 → 永不 emit DONE/ERROR → UI 永久卡
// "AI 正在操作浏览器…"。
//
// 双管齐下：
//  ① 保活：任务活跃期间用 chrome.alarms 周期性唤醒 SW（每次唤醒重置空闲计时器），
//     让 loop 的长 await 得以存活到结束。alarms 最小周期受平台限制，但反复唤醒足以
//     把 SW 维持在 alive 状态。
//  ② 崩溃恢复：每次起任务把 {taskId,status:'running'} 写进 chrome.storage.session；
//     finally 清除。SW 下次启动（installBrowserAgent）若发现残留 'running' 标记，说明
//     上个 SW 在任务中途被杀——此时无法复活已死的 promise，但必须广播一条
//     BROWSER_AGENT_ERROR(taskId) 让 UI 解锁回 idle，而非静默永挂。
const KEEP_ALIVE_ALARM = 'piercode-browser-agent-keepalive'
const ORPHAN_TASK_STORAGE_KEY = 'piercodeBrowserAgentActiveTask'

/** 启动任务保活闹钟（幂等）。periodInMinutes 取平台允许的最小值附近。 */
function startKeepAlive(): void {
  try {
    chrome.alarms?.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.4 })
  } catch {
    // 无 alarms 权限 / 测试环境：忽略（保活退化为无，但不影响功能正确性）。
  }
}

/** 停止保活闹钟（无活跃任务时）。 */
function stopKeepAlive(): void {
  try {
    chrome.alarms?.clear(KEEP_ALIVE_ALARM)
  } catch {
    /* ignore */
  }
}

/** 写崩溃恢复标记（best-effort，不阻塞主流程）。 */
function persistActiveTaskMarker(task: ActiveTask): void {
  try {
    void chrome.storage?.session?.set({
      [ORPHAN_TASK_STORAGE_KEY]: {
        taskId: task.taskId,
        platform: task.platform,
        agentTurnId: task.agentTurnId,
        status: 'running',
      },
    })
  } catch {
    /* ignore */
  }
}

/** 清崩溃恢复标记（任务正常终止时）。 */
function clearActiveTaskMarker(): void {
  try {
    void chrome.storage?.session?.remove(ORPHAN_TASK_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * SW 启动时调用：若存在上一个 SW 留下的 'running' 任务标记，说明它在任务中途被
 * idle-kill，对应的 loop promise 已随 SW 一同蒸发、永不会自行 emit 终止信号。这里
 * 补发一条 BROWSER_AGENT_ERROR(taskId)，让仍卡在 running 的侧边栏 store 解锁回 idle
 * 并提示重试，然后清除标记。promise 本身无法复活——这是"失败必定 emit、UI 绝不静默
 * 永挂"契约在 SW 重启边界上的兜底。
 */
async function recoverOrphanedTask(): Promise<void> {
  try {
    const got = await chrome.storage?.session?.get(ORPHAN_TASK_STORAGE_KEY)
    const marker = got?.[ORPHAN_TASK_STORAGE_KEY] as
      | { taskId?: string; status?: string; platform?: string }
      | undefined
    if (marker && marker.status === 'running') {
      broadcast({
        type: 'BROWSER_AGENT_ERROR',
        taskId: marker.taskId,
        error: '后台被浏览器回收，任务中断。请重试（已自动解锁）。',
      })
    }
    // 守卫式删除（审计 Bug #16）：SW 启动后侧边栏常立刻发 TASK，startBrowserAgentTask
    // → persistActiveTaskMarker(新 marker) 可能插在本函数 get 与 remove 之间。无条件
    // remove 会把刚写入的**新活跃任务**标记删掉，使其若再被 idle-kill 时无 marker →
    // 下次重启不补发解锁 ERROR → UI 永卡。故仅在仍无活跃任务、且存储里的 taskId 仍是
    // 我们刚读到的那个（未被新任务覆盖）时才删。
    if (activeTask === null) {
      const cur = await chrome.storage?.session?.get(ORPHAN_TASK_STORAGE_KEY)
      const curMarker = cur?.[ORPHAN_TASK_STORAGE_KEY] as { taskId?: string } | undefined
      const sameAsRead = (curMarker?.taskId ?? undefined) === (marker?.taskId ?? undefined)
      if (activeTask === null && sameAsRead) {
        await chrome.storage?.session?.remove(ORPHAN_TASK_STORAGE_KEY)
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * platform → 桥的长连 runtime.connect port 集合（INJECT 下行，ACK/TOOLS 上行）。
 *
 * 同一平台可能有多个 iframe 同时挂载（side-panel + 弹出全屏 tab 各自 seed 一套；
 * chatgpt SPA 重载剥 query 后重装 bridge）。旧实现按平台单键覆写（last-ready wins），
 * 若最后就绪的是 display:none 的隐藏帧，INJECT 就打到看不见的 composer 上，
 * waitForEditor 30s 找不到可见编辑器 → 注入失败 / AI 永远收不到任务 → 时间线空。
 * 改为按平台持有一个 **Set**：注入时向该平台所有活端口 **扇出** INJECT，每个桥自门控
 * （只有真正可见 composer 的帧能成功，隐藏帧回 ok:false 被忽略），首个 ok:true 即采纳
 * （镜像 server 端 preferSuccess）。
 */
const bridgePorts = new Map<string, Set<chrome.runtime.Port>>()

/** 取某平台当前所有活端口（无则空数组）。 */
function bridgePortsFor(platform: string): chrome.runtime.Port[] {
  const set = bridgePorts.get(platform)
  return set ? Array.from(set) : []
}

/**
 * 等某平台至少有一个活桥端口就绪（带退避轮询）。
 *
 * 根因（诊断 [high]）：iframe 是跨域、异步加载的——content.js 跑到 document_start、
 * 命中 isBrowserAgentFrame()、connectPort() 发 BRIDGE_READY 整条链路要数秒；而
 * BROWSER_AGENT_TASK 一来 startBrowserAgentTask 立刻进 loop 调 injectTurn。若那一刻
 * bridgePortsFor() 为空就立即 {ok:false} → loop emit ERROR 退出 → 工具永不执行。
 * 同理 SW 被 idle-kill 重启后桥端口要 ~500ms 才重连，这窗口内的注入也会扑空。
 * 故首轮注入前在此轮询等待端口（abort / 超时即放弃，由调用方落 ERROR）。
 */
async function waitForBridgePort(
  platform: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<chrome.runtime.Port[]> {
  const deadline = Date.now() + timeoutMs
  let delay = 150
  for (;;) {
    if (signal.aborted) return []
    const ports = bridgePortsFor(platform)
    if (ports.length > 0) return ports
    if (Date.now() >= deadline) return []
    await new Promise<void>(r => setTimeout(r, Math.min(delay, deadline - Date.now())))
    delay = Math.min(delay * 1.5, 1000)
  }
}

/** 桥端口就绪等待上限（覆盖跨域 iframe 首次加载 + SW 重连窗口）。 */
const BRIDGE_PORT_WAIT_MS = 25000

/** 登记某平台的一个桥端口（BRIDGE_READY）。 */
function addBridgePort(platform: string, port: chrome.runtime.Port): void {
  let set = bridgePorts.get(platform)
  if (!set) {
    set = new Set()
    bridgePorts.set(platform, set)
  }
  set.add(port)
}

/** 注销某平台的一个桥端口（onDisconnect），集合空后删平台键。 */
function removeBridgePort(platform: string, port: chrome.runtime.Port): void {
  const set = bridgePorts.get(platform)
  if (!set) return
  set.delete(port)
  if (set.size === 0) bridgePorts.delete(platform)
}

/**
 * agentTurnId → 等 BROWSER_AGENT_INJECT_ACK 的接收器。
 *
 * 因 INJECT 向某平台所有桥端口扇出，同一 turn 会收到多个 ACK（每帧一条）。
 * onAck 收一条；首个 ok:true 立即采纳（preferSuccess），其余忽略；全为 ok:false 时
 * 在收齐 expected 条后才以最后一个错误落地（隐藏帧的 "composer not found" 不抢答）。
 */
interface InjectAwaiter {
  onAck(ok: boolean, error?: string): void
  /** 任务清理时强制以错误落地（cleanupTaskPending），避免 inject() 永久挂起。 */
  forceFail(error: string): void
}
const pendingInjectAcks = new Map<string, InjectAwaiter>()
/**
 * agentTurnId → 等 BROWSER_AGENT_TOOLS 的 settle 接口。
 *
 * 桥回工具 → settle({ tools, rawContent })（resolve 正常回复）；任务清理时 →
 * settle({ aborted: true })（reject，让 loop 走 stopped/error 分支而非误判 'completed'）。
 */
type ToolsSettlement = { tools: ToolCall[]; rawContent: string } | { aborted: true }
const pendingTools = new Map<string, (s: ToolsSettlement) => void>()
/** callId → 等 BROWSER_AGENT_APPROVAL_ANSWER 的 resolve。 */
const pendingApprovals = new Map<string, (decision: 'approve' | 'skip' | 'allow-all') => void>()
/** callId → 等 BROWSER_AGENT_QUESTION_ANSWER 的 resolve（值=用户回答文本，空=未答）。 */
const pendingQuestions = new Map<string, (answer: string) => void>()

const INJECT_ACK_TIMEOUT_MS = 30000
const TOOLS_TIMEOUT_MS = 180000
/** 高危批准的最长等待：超时按"跳过"放行循环，避免侧边栏崩溃/关闭时永久挂死。 */
const APPROVAL_TIMEOUT_MS = 300000
/** browser_use_tab 接管被操作 tab 的最长等待：超时按非致命跳过，避免 attach 久挂卡死起步。 */
const USE_TAB_TIMEOUT_MS = 12000

/** 给任一 promise 套硬超时；超时以 Error 落地（用于不可久挂的接管/探测）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    p.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}

/** 解析当前控制 tab 的 url/title（注入快照属性 + 同源导航判定）。失败回 null。 */
// 「自动（活跃标签页）」解析：targetTabId 为 null 时，把被操作页定位到用户当前
// 真正可见的活跃 tab —— 而不是 browser 注册表里那个可能陈旧的默认受控 tab
// （否则 browser_* 会去操作上一次留下的 about:blank，截图/点击全打空）。
// 跳过扩展页 / chrome:// / about: / 空白页这些不可操作的目标。
// AI 对话宿主清单（镜像 internal/browser/security.go aiPageHosts）。自动解析被操作页
// 时**排除**这些 host：否则 targetTabId=null 会自动选中用户自己开着的 ChatGPT/Claude/
// Qwen 对话 tab，随后 browser_use_tab 把它 MarkApproved 永久接管 → agent 开始点击/输入
// 进而污染用户真实对话（审计 Bug #14）。用户仍可经 TargetTabBar 显式选 AI tab。
const AI_PAGE_HOSTS = [
  'gemini.google.com', 'aistudio.google.com', 'qwen.ai', 'qwenlm.ai', 'chat.z.ai',
  'kimi.com', 'claude.ai', 'free.easychat.top', 'aistudio.xiaomimimo.com',
  'chatgpt.com', 'chat.openai.com',
]

function isAiPageUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const h = new URL(url).hostname
    return AI_PAGE_HOSTS.some(ai => h === ai || h.endsWith('.' + ai))
  } catch {
    return false
  }
}

function isOperableUrl(url: string | undefined): boolean {
  if (!url) return false
  // 必须是 http(s) 且非 AI 对话页（自动解析不碰用户的 AI 会话 tab，Bug #14）。
  return /^https?:\/\//i.test(url) && !isAiPageUrl(url)
}

async function resolveActiveTabId(): Promise<number | null> {
  try {
    // 优先最近聚焦窗口的活跃 tab。
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    let cand = tabs.find(t => isOperableUrl(t.url) && typeof t.id === 'number')
    if (!cand) {
      // 退化：任意普通窗口的活跃 tab（侧边栏聚焦时 lastFocusedWindow 可能是它自己）。
      tabs = await chrome.tabs.query({ active: true })
      cand = tabs.find(t => isOperableUrl(t.url) && typeof t.id === 'number')
    }
    if (!cand) {
      // 再退化：先在所有普通窗口的**活跃** tab 里挑可操作的（优先用户正看着的页面，
      // 而非任意后台 tab）；仍无才回落到全局 lastAccessed（Bug #22：fullpage 模式下
      // 活跃 tab 是扩展页自身，前两档全落空，第三档原来直接抓全局最近访问的后台 tab，
      // 可能是用户根本没在看的页面）。
      const activeTabs = await chrome.tabs.query({ active: true })
      cand = activeTabs
        .filter(t => isOperableUrl(t.url) && typeof t.id === 'number')
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0]
      if (!cand) {
        const all = await chrome.tabs.query({})
        cand = all
          .filter(t => isOperableUrl(t.url) && typeof t.id === 'number')
          .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0]
        // 最后兜底：仍没有非 AI 的真页面时，放宽 AI-host 排除，只要是 http(s) 真页面
        // （非 about:blank / chrome:// / 扩展页）就选——绝不返回 null 让服务端回落到
        // 陈旧 about:blank 默认 tab 去操作空白页（about:blank 操作根因）。这一档可能选中
        // 用户自己的 AI 对话 tab，但有 BROWSER_AGENT_TARGET 广播让用户看到选了哪个并可停。
        if (!cand) {
          cand = all
            .filter(t => isRealHttpTab(t.url) && typeof t.id === 'number')
            .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0]
        }
      }
    }
    return cand?.id ?? null
  } catch {
    return null
  }
}

// 真实 http(s) 页面（非 about:blank / chrome:// / chrome-extension:// / devtools://）。
// 比 isOperableUrl 宽：不排除 AI host —— 仅用于 resolveActiveTabId 的最后兜底，宁可
// 操作用户的 AI 对话页也绝不回落到 about:blank 空白页。
function isRealHttpTab(url: string | undefined): boolean {
  if (!url) return false
  return /^https?:\/\//i.test(url)
}

async function resolveTabInfo(tabId: number | null): Promise<{ tabId: number | null; title?: string; url?: string }> {
  if (tabId == null) return { tabId: null }
  try {
    const tab = await chrome.tabs.get(tabId)
    return { tabId, title: tab.title || '', url: tab.url || '' }
  } catch {
    return { tabId }
  }
}

/** 从 url 取 http(s) origin（同源导航判定）。 */
function originOf(url: string | undefined): string {
  if (!url) return ''
  return httpOrigin(url) || ''
}

/**
 * 解析 browser_snapshot 的 ref 行，建 ref → 可见文本表，供 classifyRisk 规则 3。
 * 行形如：`  [e1] button "登录" disabled`，文本取首个 %q 引号内内容。
 */
function parseRefText(snapshotText: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /^\s*\[(e\d+)\]\s+\S+(?:\s+"((?:[^"\\]|\\.)*)")?/
  for (const line of (snapshotText || '').split('\n')) {
    const m = line.match(re)
    if (m) map.set(m[1], (m[2] || '').replace(/\\"/g, '"'))
  }
  return map
}

/**
 * 取本轮快照 → 拼 prompt → 下发 BROWSER_AGENT_INJECT 到桥端口 → 等 INJECT_ACK。
 * 同时把快照的 ref→文本表 + 受控 origin 回写到 activeTask（供下轮 classifyRisk）。
 * 这是注入到 runBrowserAgentLoop 的 inject 闭包的实体。
 */
async function injectTurn(
  task: ActiveTask,
  body: string,
  agentTurnId: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  task.agentTurnId = agentTurnId
  const firstTurn = task.injectedTurns === 0
  task.injectedTurns += 1
  // 刷新崩溃恢复标记，使其 agentTurnId 反映当前轮（恢复广播带最新轮 id）。
  persistActiveTaskMarker(task)

  // 刷新受控 tab 元数据（url/title），用于快照属性 + 同源导航。
  task.tabInfo = await resolveTabInfo(task.targetTabId)
  task.currentOrigin = originOf(task.tabInfo.url)

  // 取快照（text 模式，a11y ref 树）。失败也照样注入错误文本，让 AI 重试/换页。
  const snap = await buildPageSnapshot(
    async (name, args) => {
      const r = await execBrowserTool(name, args)
      return { output: r.output, success: r.success }
    },
    { tabId: task.targetTabId, url: task.tabInfo.url, title: task.tabInfo.title, mode: 'text' },
  )

  // 解析 ref → 文本（snap.text 是已裹标签的快照；从中提取 [eN] 行）。
  task.refText = parseRefText(snap.text)

  const profilePrefix = firstTurn ? await fetchBrowserAgentPrompt() : undefined
  const prompt = composeTurnPrompt({ snapshot: snap.text, body, firstTurn, profilePrefix })

  // 端口可能尚未就绪（跨域 iframe 首次加载 / SW 重启后重连窗口）：退避轮询等待，
  // 而非立刻判失败（诊断 [high]：原立即 {ok:false} 是工具永不执行的主因之一）。
  const ports = await waitForBridgePort(task.platform, signal, BRIDGE_PORT_WAIT_MS)
  if (signal.aborted) return { ok: false, error: 'aborted' }
  if (ports.length === 0) {
    return { ok: false, error: `AI 网页（${task.platform}）的注入通道未就绪（bridge 未连接，已等待 ${Math.round(BRIDGE_PORT_WAIT_MS / 1000)}s）` }
  }

  return await new Promise<{ ok: boolean; error?: string }>(resolve => {
    let settled = false
    let acksSeen = 0
    let lastError = '注入失败：所有 AI 网页帧均未确认（composer 不可见？）'
    const done = (r: { ok: boolean; error?: string }) => {
      if (settled) return
      settled = true
      pendingInjectAcks.delete(agentTurnId)
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(r)
    }
    // 听 abort：任务被 STOP/抢占时，阻塞在 ACK 等待上的 inject 立即以 aborted 落地，
    // 而非干等 30s 超时或仰赖全局 cleanupTaskPending（Bug #17）。循环的 :231
    // `if (signal.aborted) return stopped` 守卫会吞掉这条 ok:false，不发 ERROR。
    const onAbort = () => done({ ok: false, error: 'aborted' })
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort)
    const timer = setTimeout(
      () => done({ ok: false, error: '注入超时：AI 网页 composer 未在限定时间内确认' }),
      INJECT_ACK_TIMEOUT_MS,
    )
    // 实际成功投递的端口数（postMessage 抛错的死端口不计入 expected，否则收不齐永远等超时）。
    let expected = 0
    // 向所有活端口扇出，收 ACK：首个 ok:true 即采纳；全 ok:false 收齐后以最后错误落地。
    pendingInjectAcks.set(agentTurnId, {
      onAck(ok, error) {
        if (settled) return
        if (ok) {
          done({ ok: true })
          return
        }
        acksSeen += 1
        if (error) lastError = error
        if (acksSeen >= expected) done({ ok: false, error: lastError })
      },
      forceFail(error) {
        done({ ok: false, error })
      },
    })
    for (const port of ports) {
      try {
        port.postMessage({ type: 'BROWSER_AGENT_INJECT', prompt, platform: task.platform, agentTurnId })
        expected += 1
      } catch {
        // 死端口（SW 重连窗口）：跳过，不计入应收 ACK 数。
      }
    }
    if (expected === 0) {
      done({ ok: false, error: `AI 网页（${task.platform}）的注入通道未就绪（bridge 未连接）` })
    }
  })
}

/** 等本轮 BROWSER_AGENT_TOOLS（桥解析好的工具 + rawContent）。 */
function awaitToolsForTurn(agentTurnId: string, signal: AbortSignal): Promise<{ tools: ToolCall[]; rawContent: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      pendingTools.delete(agentTurnId)
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => finish(() => reject(new Error('aborted')))
    const timer = setTimeout(() => finish(() => reject(new Error('等待 AI 回复超时'))), TOOLS_TIMEOUT_MS)
    // settle：桥回工具 → resolve；cleanupTaskPending 的 {aborted:true} → reject
    // （避免 resolve({tools:[]}) 被 loop 误判为正常完成而在已推进的 turnId 上发 DONE）。
    pendingTools.set(agentTurnId, settlement =>
      finish(() => {
        if ('aborted' in settlement) reject(new Error('aborted'))
        else resolve(settlement)
      }),
    )
    signal.addEventListener('abort', onAbort)
  })
}

/**
 * 高危动作门控：emit APPROVAL，等 APPROVAL_ANSWER；'allow-all' 置任务标志并视作 approve。
 * 与本文件的另两个等待者（awaitToolsForTurn / injectTurn）同款，必须有逃生口，否则
 * 侧边栏崩溃/关闭/不应答时整个 runBrowserAgentLoop 会永久挂在 await gate 上：
 *  - signal abort（用户 STOP / 新任务抢占）→ 立即按 'skip' 解，让循环走 stopped 分支。
 *  - APPROVAL_TIMEOUT_MS 超时 → 删待决项并按 'skip' 解，循环继续而非死锁。
 * resolve 时统一清掉 timer + abort 监听 + 待决项，避免泄漏与重复触发。
 */
function gateApproval(task: ActiveTask, call: ToolCall, signal: AbortSignal): Promise<'approve' | 'skip'> {
  if (task.allowAll) return Promise.resolve('approve')
  if (signal.aborted) return Promise.resolve('skip')
  // origin 经形参传入，不写进 call.args（call.args 会下发给 Go / 回显到 UI；契约：__currentOrigin 不下发）。
  const risk = classifyRisk(call.name, call.args, ref => task.refText.get(ref) || '', task.currentOrigin)
  return new Promise<'approve' | 'skip'>(resolve => {
    let settled = false
    const finish = (decision: 'approve' | 'skip') => {
      if (settled) return
      settled = true
      pendingApprovals.delete(call.call_id)
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(decision)
    }
    const onAbort = () => finish('skip')
    const timer = setTimeout(() => finish('skip'), APPROVAL_TIMEOUT_MS)
    pendingApprovals.set(call.call_id, decision => {
      if (decision === 'allow-all') {
        task.allowAll = true
        finish('approve')
      } else {
        finish(decision)
      }
    })
    signal.addEventListener('abort', onAbort)
    broadcast({
      type: 'BROWSER_AGENT_APPROVAL',
      callId: call.call_id,
      name: call.name,
      args: call.args,
      risk: risk.reason || '高危动作',
      agentTurnId: task.agentTurnId,
      taskId: task.taskId,
    })
  })
}

/**
 * 向用户提问（question 工具）：广播 BROWSER_AGENT_QUESTION 弹侧边栏提问卡，等
 * BROWSER_AGENT_QUESTION_ANSWER。与 gateApproval 同款逃生口：abort（STOP/抢占）→ 以
 * 空答落地让循环继续；APPROVAL_TIMEOUT_MS 超时同样以空答落地，绝不永久挂死。
 */
function gateQuestion(task: ActiveTask, callId: string, question: string, options: string[], signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.resolve('')
  return new Promise<string>(resolve => {
    let settled = false
    const finish = (answer: string) => {
      if (settled) return
      settled = true
      pendingQuestions.delete(callId)
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(answer)
    }
    const onAbort = () => finish('')
    const timer = setTimeout(() => finish(''), APPROVAL_TIMEOUT_MS)
    pendingQuestions.set(callId, answer => finish(answer))
    signal.addEventListener('abort', onAbort)
    broadcast({
      type: 'BROWSER_AGENT_QUESTION',
      callId,
      question,
      options,
      agentTurnId: task.agentTurnId,
      taskId: task.taskId,
    })
  })
}

export interface StartBrowserAgentParams {
  platform: string
  task: string
  targetTabId: number | null
  /** 发起 store 的稳定任务标识，用于多 store 按身份过滤广播（可缺省）。 */
  taskId?: string
}

/**
 * startBrowserAgentTask：BROWSER_AGENT_TASK 的入口。建活跃任务 + AbortController，
 * 跑 runBrowserAgentLoop，结束/出错广播给侧边栏。同一时刻只跑一个任务（新任务先
 * abort 旧任务）。inject/refText/currentOrigin 接缝绑定到本任务的实时状态。
 */
export async function startBrowserAgentTask(params: StartBrowserAgentParams): Promise<void> {
  // 新任务到来：先停旧任务，避免两套循环抢同一被操作 tab。仅 abort——**不在此直接广播
  // 旧任务的 DONE**：那会让刚 startTask 置 running 的新任务 store 误收一条 DONE 而翻回
  // idle（两 store 共享 SW 广播，无法按身份区分）。旧任务的终止信号由它自己
  // startBrowserAgentTask 的 finally 兜底补发（loop 被 abort → 返回 stopped → finally
  // 见 terminalEmitted=false → 补发 DONE(stopped)），既保证恰好一次又不串到新任务。
  if (activeTask) {
    try { activeTask.abort.abort() } catch {}
  }

  // 「自动」被操作页：targetTabId 为 null → 解析到当前活跃可见 tab（而非陈旧默认
   // 受控 tab）。解析不到才退回 null（让服务端 ensureTab 兜底）。
  const resolvedTabId = params.targetTabId ?? (await resolveActiveTabId())

  const abort = new AbortController()
  const task: ActiveTask = {
    agentTurnId: '',
    taskId: params.taskId || `bat-task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    platform: params.platform,
    targetTabId: resolvedTabId,
    abort,
    allowAll: false,
    injectedTurns: 0,
    refText: new Map(),
    currentOrigin: '',
    tabInfo: { tabId: resolvedTabId },
    terminalEmitted: false,
    ownedTurnIds: new Set(),
    ownedCallIds: new Set(),
  }
  activeTask = task

  // 保活 + 崩溃恢复标记：从此刻起到 finally，维持 SW 存活并落盘任务标记。
  startKeepAlive()
  persistActiveTaskMarker(task)

  // 本任务专用 emit：①回戳 taskId 让多 store 按身份过滤；②记下是否已发过终止信号
  // （DONE/ERROR），供 finally 决定是否补发兜底 DONE，保证 store 恰好收到一次终止信号。
  const emitForTask = (msg: Record<string, unknown>) => {
    if (msg.type === 'BROWSER_AGENT_DONE' || msg.type === 'BROWSER_AGENT_ERROR') {
      task.terminalEmitted = true
    }
    broadcast({ ...msg, taskId: task.taskId })
  }

  // 关键：先把被操作 tab 用 browser_use_tab **接管为受控 tab**（CDP attach）。
  // 不 attach 直接对它截图/点击会挂起——browser_screenshot 等会一直等 CDP attach
  // 到该 tab，永不返回 → 整个 loop 卡死（"AI 正在操作浏览器…"不动的根因）。
  // attach 后 browser_* 默认就打在这个受控 tab，无需每调再带 tabId。
  if (resolvedTabId != null) {
    try {
      // browser_use_tab 在 debugger 已被别处占用时可能久挂（诊断 [medium]：index.ts
      // 940 "busy" + 8s 超时）。这里再加一层硬超时，超时按非致命继续——后续工具走
      // 服务端 ensureTab 兜底；绝不让 attach 久挂卡住整个 loop 起步。
      await withTimeout(
        execBrowserTool('browser_use_tab', { tabId: resolvedTabId, reason: 'PierCode 浏览器 Agent 接管被操作页' }),
        USE_TAB_TIMEOUT_MS,
      )
    } catch {
      // attach 失败 / 超时不致命：让后续工具走服务端 ensureTab 兜底（可能仍可工作）。
    }
    // 用 emitForTask（带本任务 taskId）而非裸 broadcast：被抢占的旧任务这条 deferred
    // TARGET 若晚到，会带旧 taskId，store 据此丢弃，不再 clobber 新任务的目标显示
    // （审计 Bug #21）。用户发起的 query/set TARGET 仍走 onMessage handler 的无 taskId
    // 点对点 sendResponse，不受影响。
    void resolveTabInfo(resolvedTabId).then(info =>
      emitForTask({ type: 'BROWSER_AGENT_TARGET', tabId: info.tabId, title: info.title, url: info.url }))
  }

  try {
    const result = await runBrowserAgentLoop({
      platform: params.platform,
      task: params.task,
      targetTabId: resolvedTabId,
      signal: abort.signal,
      emit: emitForTask,
      inject: (body, agentTurnId) => {
        // 登记本任务拥有的 turnId（inject + tools 共用同一 turnId），供 task-scoped cleanup。
        task.ownedTurnIds.add(agentTurnId)
        return injectTurn(task, body, agentTurnId, abort.signal)
      },
      awaitTools: agentTurnId => {
        task.ownedTurnIds.add(agentTurnId)
        return awaitToolsForTurn(agentTurnId, abort.signal)
      },
      // 被操作 tab 已在任务开始时 browser_use_tab 接管为受控 tab，故 browser_*
      // 默认就打在它上面，不再每调注入 tabId（注入未 attach 的 tabId 反而会挂起）。
      exec: (name, args, callId) => execBrowserTool(name, args, callId, abort.signal),
      gate: call => {
        if (call.call_id) task.ownedCallIds.add(call.call_id)
        return gateApproval(task, call, abort.signal)
      },
      askQuestion: (callId, question, options) => {
        task.ownedCallIds.add(callId)
        return gateQuestion(task, callId, question, options, abort.signal)
      },
      // classifyRisk 在循环内用：受控页 origin（同源导航放行）+ ref→文本（点击目标判危）
      // 均读本任务最近一轮快照刷新的实时值。
      currentOrigin: () => task.currentOrigin,
      refText: ref => task.refText.get(ref) || '',
    })
    // completed/max-depth/tab-gone 时循环已 emit BROWSER_AGENT_DONE。stopped 路径
    // 循环不自 emit（早返回静默）：原契约靠 BROWSER_AGENT_STOP handler 补发，但 STOP
    // 仅用户点停才有；新任务抢占 / 异常 abort 时没有 STOP → 必须在此兜底，否则 store
    // 卡 running（Bug 1b / Bug 2 根因）。统一规则见下方 finally 的兜底补发。
    void result
  } catch (e) {
    if (!task.terminalEmitted) {
      task.terminalEmitted = true
      emitForTask({ type: 'BROWSER_AGENT_ERROR', agentTurnId: task.agentTurnId, error: e instanceof Error ? e.message : String(e) })
    }
  } finally {
    if (activeTask === task) activeTask = null
    // 兜底：本任务若至此仍未广播过任何终止信号（stopped 早返回 / 静默挂死后被清理），
    // 补发一次 DONE(stopped)，保证置 running 的 store 恰好收到一次终止信号、解锁输入。
    if (!task.terminalEmitted) {
      task.terminalEmitted = true
      emitForTask({ type: 'BROWSER_AGENT_DONE', agentTurnId: task.agentTurnId, reason: 'stopped' })
    }
    // 清掉**本任务**遗留的待决 promise（task-scoped，绝不碰别的任务的待决项）。
    cleanupTaskPending(task)
    // 只有当本任务仍是 activeTask（未被新任务抢占）时才撤保活/清标记，避免误关掉
    // 新任务的保活。被抢占时新任务的 startKeepAlive/persist 已覆盖，这里跳过。
    if (activeTask === null) {
      stopKeepAlive()
      clearActiveTaskMarker()
    }
  }
}

// task-scoped 清理：只 settle/force-fail **本任务**登记过的待决项（按 owned turnId /
// callId），绝不 .clear() 整个全局表（Bug #1）。否则一个被抢占任务的 finally 会误伤
// 刚启动的新任务正在等待的 inject/tools/approval —— 新任务被旧任务的清理静默杀死。
function cleanupTaskPending(task: ActiveTask): void {
  // 注入待决：以一条 ok:false 落地（让仍在等的 inject() 走错误分支）。awaiter.onAck
  // 只在收齐 expected 才落 false，故直接强制 done。仅本任务的 turnId。
  for (const turnId of task.ownedTurnIds) {
    const awaiter = pendingInjectAcks.get(turnId)
    if (awaiter) {
      awaiter.forceFail('task ended')
      pendingInjectAcks.delete(turnId)
    }
  }
  // 工具待决：以 **拒绝**（{aborted:true}）落地，否则 resolve({tools:[]}) 会被 loop
  // 读成 'completed' → 在已推进的 turnId 上误发 DONE。仅本任务的 turnId。
  for (const turnId of task.ownedTurnIds) {
    const settle = pendingTools.get(turnId)
    if (settle) {
      settle({ aborted: true })
      pendingTools.delete(turnId)
    }
  }
  // 批准待决：按 'skip' settle，避免残留的 gateApproval promise 永久挂起。仅本任务的 callId。
  for (const callId of task.ownedCallIds) {
    const resolve = pendingApprovals.get(callId)
    if (resolve) {
      resolve('skip')
      pendingApprovals.delete(callId)
    }
    // 提问待决：以空答 settle，避免残留的 gateQuestion promise 永久挂起。
    const qResolve = pendingQuestions.get(callId)
    if (qResolve) {
      qResolve('')
      pendingQuestions.delete(callId)
    }
  }
}

// ── 桥端口 + 消息处理注册 ───────────────────────────────────────────────────

const BRIDGE_PORT_PREFIX = 'piercode-browser-agent:'

/**
 * registerBrowserAgentHandler：接线 chrome.runtime.onConnect（桥端口：INJECT 下行 /
 * INJECT_ACK + TOOLS 上行）与 chrome.runtime.onMessage（TASK / TARGET / STOP /
 * APPROVAL_ANSWER）。background/index.ts 调一次（不在本文件直接调，Wire 阶段接）。
 */
export function registerBrowserAgentHandler(): void {
  if (typeof chrome === 'undefined' || !chrome.runtime) return

  // 保活闹钟：每次 fire 都唤醒 SW（重置空闲计时器），让活跃任务的长 await 存活。
  // 处理体本身只需"被调用"即足以续命；顺手在仍有活跃任务时刷新崩溃恢复标记当心跳。
  if (chrome.alarms?.onAlarm) {
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name !== KEEP_ALIVE_ALARM) return
      if (activeTask) persistActiveTaskMarker(activeTask)
      else stopKeepAlive()
    })
  }

  // 跟随 click 新开的 tab（target=_blank / OAuth 登录弹窗 / 结算跳新页）：当前
  // 被操作 tab 由它打开（openerTabId === task.targetTabId）时，把被操作页改指到新
  // tab 并接管，否则 agent 会一直对着原（可能已变空白 opener 的）旧 tab 截图操作直到
  // max-depth（审计 Bug #15）。仅活跃任务期间生效；非本任务 opener 的新 tab 不动。
  if (chrome.tabs?.onCreated) {
    chrome.tabs.onCreated.addListener(tab => {
      const task = activeTask
      if (!task) return
      if (typeof tab.id !== 'number') return
      if (task.targetTabId == null || tab.openerTabId !== task.targetTabId) return
      // 重指向被操作页到新 tab；下一轮 injectTurn 的快照就取它。广播 TARGET 让侧边栏
      // 跟着更新显示。接管走 best-effort（失败不致命，服务端 ensureTab 兜底）。
      task.targetTabId = tab.id
      void execBrowserTool('browser_use_tab', { tabId: tab.id, reason: 'PierCode 浏览器 Agent 跟随新开的 tab' }, undefined, task.abort.signal).catch(() => {})
      void resolveTabInfo(tab.id).then(info =>
        broadcast({ type: 'BROWSER_AGENT_TARGET', tabId: info.tabId, title: info.title, url: info.url, taskId: task.taskId }))
    })
  }

  // 桥的长连 port：名为 piercode-browser-agent:<platform>。桥在 iframe 内打开它并发
  // BROWSER_AGENT_BRIDGE_READY；SW 经它 postMessage(INJECT)，并从它收 ACK/TOOLS。
  if (chrome.runtime.onConnect) {
    chrome.runtime.onConnect.addListener(port => {
      if (!port.name.startsWith(BRIDGE_PORT_PREFIX)) return
      let platform = port.name.slice(BRIDGE_PORT_PREFIX.length)

      port.onMessage.addListener((msg: { type?: string; [k: string]: unknown }) => {
        if (!msg || typeof msg.type !== 'string') return
        switch (msg.type) {
          case 'BROWSER_AGENT_BRIDGE_READY': {
            if (typeof msg.platform === 'string' && msg.platform) platform = msg.platform
            // 多帧并存：登记进平台的端口集合（而非覆写），INJECT 时向全集扇出。
            addBridgePort(platform, port)
            break
          }
          case 'BROWSER_AGENT_INJECT_ACK': {
            const turnId = String(msg.agentTurnId || '')
            // 一个 turn 会收到多帧的 ACK；交给 awaiter 做 preferSuccess 归并。
            const awaiter = pendingInjectAcks.get(turnId)
            if (awaiter) awaiter.onAck(msg.ok === true, typeof msg.error === 'string' ? msg.error : undefined)
            break
          }
          case 'BROWSER_AGENT_TOOLS': {
            const turnId = String(msg.agentTurnId || '')
            // 唯一权威门控：是否存在仍在等待此 turn 的 settle。pendingTools 里有项 =
            // 某个 awaitToolsForTurn 正阻塞在这个 turnId 上，必须放行。
            //
            // 不再用 `turnId !== activeTask.agentTurnId` 丢弃（诊断 [medium]）：
            //  ① 桥回读相对 loop 迭代有延迟，activeTask.agentTurnId 可能已推进到下一轮，
            //     却把仍 pending 的上一轮真回读误杀；
            //  ② SW 被 idle-kill 重启后 activeTask=null，但此分支本就要求有 settle 才处理，
            //     无 settle 直接 break，故 activeTask 是否存在都不影响安全性。
            // 用户在可见 iframe 里自己发消息引出的回读不会有对应 pendingTools 项 → 自然忽略。
            const settle = pendingTools.get(turnId)
            if (!settle) break
            const rawTools = Array.isArray(msg.tools) ? (msg.tools as unknown[]) : []
            const tools: ToolCall[] = rawTools
              .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
              .map((t, i) => ({
                name: String((t as { name?: unknown }).name || ''),
                args: ((t as { args?: unknown }).args && typeof (t as { args?: unknown }).args === 'object'
                  ? (t as { args: Record<string, unknown> }).args
                  : {}) as Record<string, unknown>,
                call_id: String((t as { call_id?: unknown }).call_id || `bridge-${i}`),
              }))
              .filter(t => t.name)
            settle({ tools, rawContent: String(msg.rawContent || '') })
            break
          }
          case 'BROWSER_AGENT_STREAM': {
            // 桥若跑了 scoped SSE tee，转发预览给侧边栏（best-effort）。
            broadcast({ type: 'BROWSER_AGENT_STREAM', agentTurnId: msg.agentTurnId, chunk: msg.chunk })
            break
          }
        }
      })

      port.onDisconnect.addListener(() => {
        removeBridgePort(platform, port)
      })
    })
  }

  if (chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return false

      if (msg.type === 'BROWSER_AGENT_TASK') {
        const platform = String(msg.platform || '')
        const taskText = String(msg.task || '')
        const targetTabId = typeof msg.targetTabId === 'number' ? msg.targetTabId : null
        const taskId = typeof msg.taskId === 'string' ? msg.taskId : undefined
        // 异步跑，立即 ack（长开 sendResponse 通道是 MV3 5 分钟 SW 击杀诱因）。
        void startBrowserAgentTask({ platform, task: taskText, targetTabId, taskId })
        sendResponse({ ok: true })
        return false
      }

      if (msg.type === 'BROWSER_AGENT_STOP') {
        if (activeTask) {
          const stopped = activeTask
          const turnId = stopped.agentTurnId
          try { stopped.abort.abort() } catch {}
          // 标记已发终止信号，避免 startBrowserAgentTask 的 finally 兜底重复补发 DONE。
          if (!stopped.terminalEmitted) {
            stopped.terminalEmitted = true
            broadcast({ type: 'BROWSER_AGENT_DONE', agentTurnId: turnId, reason: 'stopped', taskId: stopped.taskId })
          }
        }
        sendResponse({ ok: true })
        return false
      }

      if (msg.type === 'BROWSER_AGENT_APPROVAL_ANSWER') {
        const callId = String(msg.callId || '')
        const decision = String(msg.decision || 'skip') as 'approve' | 'skip' | 'allow-all'
        const resolve = pendingApprovals.get(callId)
        if (resolve) resolve(decision)
        sendResponse({ ok: true })
        return false
      }

      if (msg.type === 'BROWSER_AGENT_QUESTION_ANSWER') {
        const callId = String(msg.callId || '')
        const answer = typeof msg.answer === 'string' ? msg.answer : ''
        const resolve = pendingQuestions.get(callId)
        if (resolve) resolve(answer)
        sendResponse({ ok: true })
        return false
      }

      if (msg.type === 'BROWSER_AGENT_TARGET') {
        // 查 / 设被操作 tab。带 tabId = 设；不带 = 查当前。
        if (typeof msg.tabId === 'number') {
          if (activeTask) activeTask.targetTabId = msg.tabId
          // 新模型（无 orchestrator 起任务）：用户在 TargetTabBar 选 tab 就是「接管这个
          // tab」的显式动作 —— 必须 browser_use_tab 接管（CDP attach + MarkApproved），
          // 否则 AI 随后吐的 browser_snapshot/click 会因 tab 未 attach 而挂起。带硬超时，
          // 失败不致命（后续工具走服务端 ensureTab 兜底）。
          void withTimeout(
            execBrowserTool('browser_use_tab', { tabId: msg.tabId, reason: 'PierCode 侧边栏选定被操作页' }),
            USE_TAB_TIMEOUT_MS,
          ).catch(() => {})
          void resolveTabInfo(msg.tabId).then(info => {
            // 既 sendResponse 也 broadcast：store.setTarget 用 fire-and-forget send() 发本
            // 消息、丢弃响应，只在 onMessage 收到 broadcast 时才落地 targetTab（store
            // 注释明说「等 SW 回 BROWSER_AGENT_TARGET 再落地」）。原来只 sendResponse 不
            // broadcast，store 永远收不到 → 手动选的目标 tab 永不显示、下次 startTask 又
            // 传 null 重新自动解析、丢弃用户选择（审计 Bug #12）。
            const payload = { type: 'BROWSER_AGENT_TARGET', tabId: info.tabId, title: info.title, url: info.url }
            sendResponse(payload)
            broadcast(payload)
          })
          return true
        }
        const tid = activeTask?.targetTabId ?? null
        void resolveTabInfo(tid).then(info => {
          sendResponse({ type: 'BROWSER_AGENT_TARGET', tabId: info.tabId, title: info.title, url: info.url })
        })
        return true
      }

      return false
    })
  }
}

/**
 * installBrowserAgent：SW 启动时调一次（background/index.ts，镜像
 * installApiListenReceiver/registerChatApiHandler 的接线）。当前等价于
 * registerBrowserAgentHandler；保留独立名以匹配契约 + 未来在此做启动期恢复。
 */
export function installBrowserAgent(): void {
  registerBrowserAgentHandler()
  // SW 启动期恢复：若上个 SW 在任务中途被 idle-kill，补发 ERROR 解锁卡住的 UI。
  void recoverOrphanedTask()
}
