// browser-agent-store.ts — 浏览器操作 Agent 侧边栏的轻量可观察状态。
//
// 与 chat-api.ts 的 API 子 agent 引擎完全隔离：本 store 只订阅 BROWSER_AGENT_*
// runtime 消息，忽略一切 CHAT_*/CHAT_AGENT_*，避免两套侧边栏 UI 串台。
//
// 设计为框架无关的外部 store（无 React import），由 BrowserAgentApp 经
// useSyncExternalStore 消费，从而单元可测（vitest 里 mock chrome.runtime 即可）。

import type { ToolCall, ToolResult } from './ToolCard'

// 时间线上的一个 browser_* 动作：从 BROWSER_AGENT_TOOL（pending/running）开始，
// 由 BROWSER_AGENT_TOOL_DONE（done/error）补完，按 callId 去重/更新。
export interface TimelineEntry {
  callId: string
  name: string
  args: Record<string, unknown>
  status: 'pending' | 'running' | 'done' | 'error'
  output?: string
  success?: boolean
}

export interface BrowserAgentState {
  // 当前活跃的 AI 平台（决定哪个 AiFrame 可见）。
  platform: string
  // 已挂载的 AI iframe（全部常驻，非活跃 display:none 以保留对话）。
  aiTabs: { id: string; platform: string; src: string }[]
  // 被操作页（page-under-control）。tabId=null 表示尚未解析（SW 用 ensureTab 兜底）。
  targetTab: { tabId: number | null; title?: string; url?: string }
  // 本回合的动作时间线，按 callId 顺序累计。
  timeline: TimelineEntry[]
  // 高危动作待批准（非 null 时弹 ApprovalCard）。
  pendingApproval: { callId: string; name: string; args: Record<string, unknown>; risk: string } | null
  // AI 提问待回答（非 null 时弹 QuestionCard）。AI emit question 工具时，SW 路由此处。
  pendingQuestion: { callId: string; question: string; options: string[] } | null
  // 运行态：idle 空闲 / running 任务循环中 / awaiting-approval 等用户批准。
  status: 'idle' | 'running' | 'awaiting-approval'
  // 可选的实时回复预览（BROWSER_AGENT_STREAM，best-effort）。
  streamPreview?: string
  lastError?: string
  lastSummary?: string
}

// 内嵌 AI 平台清单：iframe src 带 ?piercode_browser_agent=<platform> 哨兵，
// content/index.ts 的 isBrowserAgentFrame() 据此识别并只跑 bridge（见契约 notes#5）。
export const AI_PLATFORMS: { id: string; label: string; iframeSrc: string }[] = [
  { id: 'chatgpt', label: 'ChatGPT', iframeSrc: 'https://chatgpt.com/?piercode_browser_agent=chatgpt' },
  { id: 'qwen', label: 'Qwen', iframeSrc: 'https://chat.qwen.ai/?piercode_browser_agent=qwen' },
]

// 本 store 关心的消息类型；其余（含全部 CHAT_*）一律忽略。
const BROWSER_AGENT_TYPES = new Set([
  'BROWSER_AGENT_TOOL',
  'BROWSER_AGENT_TOOL_DONE',
  'BROWSER_AGENT_APPROVAL',
  'BROWSER_AGENT_QUESTION',
  'BROWSER_AGENT_STREAM',
  'BROWSER_AGENT_DONE',
  'BROWSER_AGENT_ERROR',
  'BROWSER_AGENT_TARGET',
])

interface RuntimeMessage {
  type?: string
  // 发起本任务的 store 标识（SW 回戳在每条任务广播上）；用于多 store 按身份过滤。
  taskId?: string
  // BROWSER_AGENT_TOOL / TOOL_DONE / APPROVAL
  callId?: string
  name?: string
  args?: Record<string, unknown>
  agentTurnId?: string
  // TOOL_DONE
  output?: string
  success?: boolean
  // APPROVAL
  risk?: string
  // QUESTION
  question?: string
  options?: string[]
  // STREAM
  chunk?: string
  // DONE
  reason?: string
  summary?: string
  // ERROR
  error?: string
  // TARGET
  tabId?: number | null
  title?: string
  url?: string
}

function send(msg: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(msg).catch?.(() => {})
  } catch {
    // SW 不可达（弹窗未连服务等）——静默；UI 状态自洽即可。
  }
}

export function createBrowserAgentStore(): {
  getState(): BrowserAgentState
  subscribe(fn: () => void): () => void
  startTask(platform: string, task: string): void
  stop(): void
  setTarget(tabId: number): void
  answerApproval(callId: string, decision: 'approve' | 'skip' | 'allow-all'): void
  answerQuestion(callId: string, answer: string): void
  setActivePlatform(p: string): void
  addAiTab(platform: string): void
  dispose(): void
} {
  // 去重 seed：按 id 唯一化（防御 AI_PLATFORMS 出现重复项导致同平台挂多个 iframe，
  // 多 iframe = SW 侧 bridgePorts 同平台多端口的来源之一）。
  const seenSeed = new Set<string>()
  const aiTabs = AI_PLATFORMS
    .filter(p => (seenSeed.has(p.id) ? false : (seenSeed.add(p.id), true)))
    .map(p => ({ id: p.id, platform: p.id, src: p.iframeSrc }))

  let state: BrowserAgentState = {
    platform: AI_PLATFORMS[0]?.id ?? 'chatgpt',
    aiTabs,
    targetTab: { tabId: null },
    timeline: [],
    pendingApproval: null,
    pendingQuestion: null,
    status: 'idle',
  }

  const subscribers = new Set<() => void>()

  // 本 store 当前任务的标识（startTask 生成，随 BROWSER_AGENT_TASK 上送，SW 回戳到广播）。
  // 多 store 并存（side-panel + 弹出全屏 tab）时，被抢占的旧任务的 DONE/工具事件带的是
  // 旧 taskId，这里据此丢弃，避免误翻本 store 刚启动的任务 / 把别人的动作塞进本时间线。
  let currentTaskId = ''
  function newTaskId(): string {
    return `bat-task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  }

  // 自愈看门狗：store 一旦置 running，必须在限定时间内收到 SW 的活动（TOOL/DONE/…）。
  // SW 端已保证每个任务恰好补发一次 DONE/ERROR（见 browser-agent.ts），但若该终止信号
  // 因 SW 被击杀 / 消息丢失而从未抵达，这里兜底把 UI 拉回 idle，避免永久卡 running
  // （Bug 2 的纯前端防御）。任何活动消息都会续命；首条注入+回复预算放宽到注入超时之上。
  const WATCHDOG_IDLE_MS = 200_000 // > SW 端 INJECT_ACK(30s) + TOOLS(180s) 之和留余量
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined
  function clearWatchdog(): void {
    if (watchdogTimer !== undefined) {
      clearTimeout(watchdogTimer)
      watchdogTimer = undefined
    }
  }
  function armWatchdog(): void {
    clearWatchdog()
    watchdogTimer = setTimeout(() => {
      watchdogTimer = undefined
      if (state.status === 'running' || state.status === 'awaiting-approval') {
        // 看门狗触发=SW 长时间零活动（被回收 / 桥从未连上 / 卡死）。主动发一条 STOP
        // 让 SW 端若仍有残留 loop 立即 abort（幂等：无活跃任务时是 no-op），再把 UI
        // 拉回 idle 解锁输入。错误文案点明可重试。
        send({ type: 'BROWSER_AGENT_STOP' })
        setState({
          status: 'idle',
          pendingApproval: null,
          streamPreview: undefined,
          lastError:
            state.lastError ??
            'AI 网页长时间无响应（后台可能被浏览器回收，或 AI 页未加载/未登录）。已自动结束，请重试。',
        })
      }
    }, WATCHDOG_IDLE_MS)
  }
  /** 收到任何 SW 活动 → 若仍在 running 则续命看门狗。 */
  function petWatchdog(): void {
    if (state.status === 'running' || state.status === 'awaiting-approval') armWatchdog()
    else clearWatchdog()
  }

  function emit(): void {
    for (const fn of subscribers) fn()
  }

  // 不可变更新：useSyncExternalStore 靠引用相等判定是否重渲染，必须换 state 引用。
  function setState(patch: Partial<BrowserAgentState>): void {
    state = { ...state, ...patch }
    emit()
  }

  // 按 callId upsert 一条时间线，保持顺序稳定（已存在则原地更新，否则追加）。
  function upsertEntry(callId: string, patch: Partial<TimelineEntry>, base?: Partial<TimelineEntry>): void {
    const idx = state.timeline.findIndex(e => e.callId === callId)
    let next: TimelineEntry[]
    if (idx >= 0) {
      next = state.timeline.slice()
      next[idx] = { ...next[idx], ...patch }
    } else {
      const entry: TimelineEntry = {
        callId,
        name: base?.name ?? patch.name ?? '',
        args: base?.args ?? patch.args ?? {},
        status: patch.status ?? base?.status ?? 'pending',
        output: patch.output ?? base?.output,
        success: patch.success ?? base?.success,
      }
      next = [...state.timeline, entry]
    }
    setState({ timeline: next })
  }

  function reduce(msg: RuntimeMessage): void {
    // 任何 SW 活动都续命看门狗（终止信号会在各自分支里清掉它）。
    petWatchdog()
    switch (msg.type) {
      case 'BROWSER_AGENT_TOOL': {
        // 一个动作开始执行（时间线 ⏺ running）。
        if (!msg.callId) return
        upsertEntry(
          msg.callId,
          { status: 'running' },
          { name: msg.name ?? '', args: msg.args ?? {}, status: 'running' },
        )
        if (state.status === 'idle') setState({ status: 'running' })
        break
      }
      case 'BROWSER_AGENT_TOOL_DONE': {
        // 动作完成（时间线 ⎿ ✓/✗）。
        if (!msg.callId) return
        const success = msg.success === true
        upsertEntry(
          msg.callId,
          { status: success ? 'done' : 'error', output: msg.output ?? '', success, name: msg.name },
          { name: msg.name ?? '', args: {}, status: success ? 'done' : 'error', output: msg.output ?? '', success },
        )
        break
      }
      case 'BROWSER_AGENT_APPROVAL': {
        // 高危动作待批准。
        if (!msg.callId) return
        setState({
          pendingApproval: {
            callId: msg.callId,
            name: msg.name ?? '',
            args: msg.args ?? {},
            risk: msg.risk ?? '',
          },
          status: 'awaiting-approval',
        })
        break
      }
      case 'BROWSER_AGENT_QUESTION': {
        // AI emit question 工具向用户提问 —— 弹 QuestionCard 收集回答。
        if (!msg.callId) return
        setState({
          pendingQuestion: {
            callId: msg.callId,
            question: typeof msg.question === 'string' ? msg.question : '',
            options: Array.isArray(msg.options) ? msg.options.map(String) : [],
          },
          status: 'awaiting-approval',
        })
        break
      }
      case 'BROWSER_AGENT_STREAM': {
        // 可选实时预览：累计回复文本片段。
        if (typeof msg.chunk !== 'string') return
        setState({ streamPreview: (state.streamPreview ?? '') + msg.chunk })
        break
      }
      case 'BROWSER_AGENT_DONE': {
        // 任务循环终止——清运行态/预览，记最终摘要。
        clearWatchdog()
        setState({
          status: 'idle',
          pendingApproval: null,
          pendingQuestion: null,
          streamPreview: undefined,
          lastSummary: typeof msg.summary === 'string' ? msg.summary : state.lastSummary,
        })
        break
      }
      case 'BROWSER_AGENT_ERROR': {
        clearWatchdog()
        setState({
          status: 'idle',
          pendingApproval: null,
          pendingQuestion: null,
          streamPreview: undefined,
          lastError: typeof msg.error === 'string' ? msg.error : '未知错误',
        })
        break
      }
      case 'BROWSER_AGENT_TARGET': {
        // SW 回复当前/新被操作 tab。
        setState({
          targetTab: {
            tabId: msg.tabId ?? null,
            title: msg.title,
            url: msg.url,
          },
        })
        break
      }
    }
  }

  const listener = (msg: unknown): void => {
    const m = msg as RuntimeMessage | null
    if (!m || typeof m.type !== 'string' || !BROWSER_AGENT_TYPES.has(m.type)) return
    // 身份过滤：任务作用域的广播带 taskId；若与本 store 当前任务不符则丢弃（被抢占的
    // 旧任务串到别的 store）。TARGET 现在分两类：任务起始的 TARGET 带 taskId（受过滤，
    // 防被抢占旧任务的晚到 TARGET clobber 新 store 显示——审计 Bug #21）；用户 query/set
    // 的 TARGET 回复不带 taskId（非任务作用域），始终放行。
    if (m.taskId && currentTaskId && m.taskId !== currentTaskId) return
    // STREAM 是回复预览，必须严格属于当前任务：旧/无 taskId 的 STREAM（如 bridge 路径
    // 早期裸 broadcast 不带 taskId）会把旧任务文本拼进新任务的 streamPreview（审计 #9）。
    // 故当本 store 有活跃任务时，只接受带匹配 taskId 的 STREAM。
    if (m.type === 'BROWSER_AGENT_STREAM' && currentTaskId && m.taskId !== currentTaskId) return
    reduce(m)
  }

  try {
    chrome.runtime.onMessage.addListener(listener)
  } catch {
    // 测试环境可能无 chrome.runtime.onMessage——store 仍可用（dispatch 为 no-op）。
  }

  return {
    getState() {
      return state
    },

    subscribe(fn: () => void) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },

    startTask(platform: string, task: string) {
      const t = task.trim()
      if (!t) return
      // 本轮任务身份：新 taskId，SW 会回戳在本任务广播上，listener 据此过滤。
      currentTaskId = newTaskId()
      // 开新任务：清上一轮时间线/预览/错误，进入 running，立刻乐观置位。
      setState({
        platform,
        timeline: [],
        pendingApproval: null,
        streamPreview: undefined,
        lastError: undefined,
        lastSummary: undefined,
        status: 'running',
      })
      // targetTabId=null 让 SW 经现有 browser 默认 tab / ensureTab 解析被操作页。
      send({ type: 'BROWSER_AGENT_TASK', platform, task: t, targetTabId: state.targetTab.tabId, taskId: currentTaskId })
      // 武装看门狗：若 SW 始终不回任何活动/终止信号，到点自愈回 idle，解锁输入。
      armWatchdog()
    },

    stop() {
      send({ type: 'BROWSER_AGENT_STOP' })
      // 乐观回 idle；SW 也会回 BROWSER_AGENT_DONE reason:'stopped' 确认。
      clearWatchdog()
      setState({ status: 'idle', pendingApproval: null })
    },

    setTarget(tabId: number) {
      send({ type: 'BROWSER_AGENT_TARGET', tabId })
      // 不乐观改 targetTab：等 SW 回 BROWSER_AGENT_TARGET 带回标题/URL 再落地。
    },

    answerApproval(callId: string, decision: 'approve' | 'skip' | 'allow-all') {
      send({ type: 'BROWSER_AGENT_APPROVAL_ANSWER', callId, decision })
      // 清待批准卡；恢复 running（动作仍在 SW 端继续/跳过）。
      setState({ pendingApproval: null, status: 'running' })
    },

    answerQuestion(callId: string, answer: string) {
      send({ type: 'BROWSER_AGENT_QUESTION_ANSWER', callId, answer })
      // 清提问卡；恢复 running（SW 把回答作为 question 工具结果喂回 AI，循环继续）。
      setState({ pendingQuestion: null, status: 'running' })
    },

    setActivePlatform(p: string) {
      if (p === state.platform) return
      setState({ platform: p })
    },

    addAiTab(platform: string) {
      // 已挂载则仅切到它；否则按已知平台清单补挂一个常驻 iframe。
      if (state.aiTabs.some(t => t.id === platform)) {
        setState({ platform })
        return
      }
      const def = AI_PLATFORMS.find(p => p.id === platform)
      if (!def) return
      setState({
        aiTabs: [...state.aiTabs, { id: def.id, platform: def.id, src: def.iframeSrc }],
        platform: def.id,
      })
    },

    dispose() {
      clearWatchdog()
      try {
        chrome.runtime.onMessage.removeListener(listener)
      } catch {
        /* ignore */
      }
      subscribers.clear()
    },
  }
}

export type { ToolCall, ToolResult }
