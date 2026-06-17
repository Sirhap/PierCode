// BrowserAgentApp — 浏览器操作 Agent 侧边栏根组件（取代旧 App.tsx 的入口角色）。
//
// 旧 App.tsx 的 API 聊天 UI 在 v1 下线（chat-api.ts 的 API 子 agent 引擎仍保留，
// 是独立子系统）。本组件持有唯一一个 createBrowserAgentStore()，经
// useSyncExternalStore 消费。
//
// 布局：AI iframe 全屏铺底（side panel 太窄，不再上下分区把 chatgpt 挤扁），
// 所有控件（标签条 / 动作时间线 / 批准卡 / 被操作页 / 任务输入）都做成叠在
// iframe 之上的可收起浮层。头部「⤢ 弹出」把同一 UI 在独立全屏 tab 打开（宽屏，
// chatgpt 桌面版舒展）——靠 ?fullpage=1 query 区分，逻辑同源、仅尺寸不同。
//
// 所有消息名严格用契约里的 BROWSER_AGENT_*；不 import chat-api 的侧边栏归约器。

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AiTabBar } from './AiTabBar'
import { AiFrame } from './AiFrame'
import { ActionTimeline } from './ActionTimeline'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'
import { TargetTabBar } from './TargetTabBar'
import { createBrowserAgentStore, AI_PLATFORMS } from './browser-agent-store'
import { useGlow } from './use-glow'
import { GLOW_COLORS } from './glow'

// 当前是否运行在「弹出全屏 tab」里（vs side panel）。
function isFullPage(): boolean {
  try { return new URLSearchParams(location.search).has('fullpage') } catch { return false }
}

export default function BrowserAgentApp(): JSX.Element {
  // 唯一 store 实例：组件生命周期内稳定，卸载时 dispose 注销监听。
  const store = useMemo(() => createBrowserAgentStore(), [])
  useEffect(() => () => store.dispose(), [store])

  const state = useSyncExternalStore(store.subscribe, store.getState)
  const fullPage = useMemo(isFullPage, [])

  // 应用保存的主题色（data-glow → theme.css 的 --glow）。
  const [glow, setGlow] = useGlow()
  const [glowMenuOpen, setGlowMenuOpen] = useState(false)

  // 连接态：探测本地 PierCode 服务（执行 browser_* 都要它在）。
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const check = () => {
      chrome.storage.local.get(['authToken', 'apiUrl'], result => {
        if (result.authToken && result.apiUrl) {
          fetch(`${result.apiUrl}/health`).then(r => setConnected(r.ok)).catch(() => setConnected(false))
        } else {
          setConnected(false)
        }
      })
    }
    check()
    const timer = setInterval(check, 10_000)
    return () => clearInterval(timer)
  }, [])

  const running = state.status === 'running' || state.status === 'awaiting-approval'

  // 动作时间线浮层：默认收起把空间全给 iframe；任务一跑自动弹出。
  const [timelineOpen, setTimelineOpen] = useState(false)
  useEffect(() => { if (running) setTimelineOpen(true) }, [running])

  // AiTabBar 的标签来自已挂载的 aiTabs，标题取已知平台清单的 label。
  const tabs = useMemo(
    () => state.aiTabs.map(t => ({
      id: t.id,
      label: AI_PLATFORMS.find(p => p.id === t.id)?.label ?? t.platform,
    })),
    [state.aiTabs],
  )

  // ＋：把还没挂载的下一个已知平台补挂上（chatgpt → qwen）。
  const addNextAi = () => {
    const next = AI_PLATFORMS.find(p => !state.aiTabs.some(t => t.id === p.id))
    if (next) store.addAiTab(next.id)
  }

  // ⤢ 弹出全屏：在独立 tab 打开同一 UI（带 ?fullpage=1，宽屏舒展）。
  const popOutFullPage = () => {
    try {
      const url = chrome.runtime.getURL('sidebar.html?fullpage=1')
      chrome.tabs.create({ url })
    } catch {
      // 极少数无 tabs 权限/上下文：退化为当前页跳转。
      location.href = 'sidebar.html?fullpage=1'
    }
  }

  return (
    <div className="relative flex flex-col h-screen overflow-hidden" style={{ background: 'var(--bg)', color: 'var(--txt)' }}>
      {/* ── Header（细条）─────────────────────────────────────────────────── */}
      <div
        className="boot boot-1 flex items-center justify-between px-3 py-1.5 border-b flex-shrink-0 z-20"
        style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="glow-text">⌁</span>
          <span className="text-sm font-medium glow-text">PIERCODE</span>
          <span className="text-[11px] truncate" style={{ color: 'var(--dim)' }}>
            // 浏览器 Agent{fullPage ? ' · 全屏' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2 relative">
          {/* ⤢ 弹出全屏 tab（side panel 模式才显示；全屏 tab 里无意义）*/}
          {!fullPage && (
            <button
              onClick={popOutFullPage}
              className="text-[12px] cursor-pointer"
              style={{ color: 'var(--dim)' }}
              title="在独立全屏标签页打开（宽屏，AI 界面更舒展）"
            >⤢</button>
          )}
          {/* 主题色选择 */}
          <button
            onClick={() => setGlowMenuOpen(o => !o)}
            className="w-3 h-3 rounded-full border"
            style={{ background: 'var(--glow)', borderColor: 'var(--line)' }}
            title="主题色"
          />
          {glowMenuOpen && (
            <div
              className="absolute right-0 top-6 z-[55] rounded-sm border p-1 flex gap-1"
              style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}
            >
              {GLOW_COLORS.map(g => (
                <button
                  key={g.key}
                  onClick={() => { setGlow(g.key); setGlowMenuOpen(false) }}
                  className={`w-4 h-4 rounded-full border ${glow === g.key ? 'glow-border' : ''}`}
                  style={{ background: g.hex, borderColor: 'var(--line)' }}
                  title={g.label}
                />
              ))}
            </div>
          )}
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'dot-live' : ''}`} style={{ background: connected ? undefined : '#7a2a2a' }} />
          <span className="text-[10px]" style={{ color: 'var(--dim)' }}>{connected ? 'live' : 'off'}</span>
          {running && (
            <span className="text-[10px] amber-text animate-pulse-dot" title="任务运行中">●</span>
          )}
        </div>
      </div>

      {/* ── AI 标签条（细条）──────────────────────────────────────────────── */}
      <AiTabBar tabs={tabs} active={state.platform} onSelect={store.setActivePlatform} onAdd={addNextAi} />

      {/* ── 主区：AI iframe 全屏铺底 + 控件浮层 ─────────────────────────────── */}
      <div className="flex-1 min-h-0 relative" style={{ background: 'var(--bg)' }}>
        {/* iframe 栈：全部常驻，display 切显隐，铺满主区 */}
        {state.aiTabs.map(t => (
          <div
            key={t.id}
            className="absolute inset-0"
            style={{ display: t.id === state.platform ? 'block' : 'none' }}
          >
            <AiFrame platform={t.platform} src={t.src} active={t.id === state.platform} />
          </div>
        ))}

        {/* 动作时间线浮层：从底部滑出，叠在 iframe 上，可收起 */}
        <div className="absolute left-0 right-0 bottom-0 z-10 pointer-events-none flex flex-col">
          {/* 错误条（始终在浮层顶，靠上不挡 iframe 太多）*/}
          {state.lastError && (
            <div
              className="mx-2 mb-1 px-3 py-1.5 rounded-sm border text-xs flex items-center gap-2 red-text pointer-events-auto"
              style={{ borderColor: 'var(--line)', background: 'var(--panel-2)' }}
            >
              <span>⚠</span>
              <span className="flex-1 truncate" title={state.lastError}>{state.lastError}</span>
            </div>
          )}

          {/* 完成摘要 */}
          {state.lastSummary && state.status === 'idle' && !state.lastError && (
            <div
              className="mx-2 mb-1 px-3 py-1.5 rounded-sm border text-[11px] flex items-start gap-2 pointer-events-auto"
              style={{ borderColor: 'var(--line)', background: 'var(--panel-2)' }}
            >
              <span className="glow-text flex-shrink-0">✓</span>
              <span className="flex-1 whitespace-pre-wrap break-all" style={{ color: 'var(--dim)' }}>{state.lastSummary}</span>
            </div>
          )}

          {/* 高危批准卡（仅 pendingApproval 时）*/}
          {state.pendingApproval && (
            <div className="pointer-events-auto">
              <ApprovalCard
                callId={state.pendingApproval.callId}
                name={state.pendingApproval.name}
                args={state.pendingApproval.args}
                risk={state.pendingApproval.risk}
                onDecision={(decision) => store.answerApproval(state.pendingApproval!.callId, decision)}
              />
            </div>
          )}

          {/* AI 提问卡（仅 pendingQuestion 时）*/}
          {state.pendingQuestion && (
            <QuestionCard
              question={state.pendingQuestion.question}
              options={state.pendingQuestion.options}
              onAnswer={(answer) => store.answerQuestion(state.pendingQuestion!.callId, answer)}
            />
          )}

          {/* 时间线面板（展开时）：半透明覆盖，紧凑限高可滚 —— 用固定像素 maxHeight
              而非 vh，不随视口放大、永不占屏过半；内容超出则在内部滚动 */}
          {timelineOpen && (
            <div
              className="mx-2 mb-1 rounded-sm border flex flex-col pointer-events-auto"
              style={{ borderColor: 'var(--line)', background: 'color-mix(in srgb, var(--panel) 94%, transparent)', maxHeight: fullPage ? 320 : 260, minHeight: 80, backdropFilter: 'blur(2px)' }}
            >
              <div className="flex items-center gap-2 px-3 py-1 border-b flex-shrink-0 text-[10px]" style={{ borderColor: 'var(--line)' }}>
                <span className="glow-text">⏱</span>
                <span style={{ color: 'var(--dim)' }}>动作时间线</span>
                {state.timeline.length > 0 && (
                  <span style={{ color: 'var(--dim)' }}>· {state.timeline.length} 个动作</span>
                )}
                <button onClick={() => setTimelineOpen(false)} className="ml-auto cursor-pointer" style={{ color: 'var(--dim)' }} title="收起">▾ 收起</button>
              </div>
              <ActionTimeline entries={state.timeline} streamPreview={state.streamPreview} />
            </div>
          )}
        </div>
      </div>

      {/* ── 底部控件条：被操作页选择 + 时间线开关（无任务输入框 —— 用户直接在内嵌
          AI 自己的输入框说话，AI 出工具自动执行；侧边栏只做被操作页选择与动作展示）── */}
      <div className="flex-shrink-0 z-20" style={{ background: 'var(--panel)' }}>
        <div className="flex items-stretch">
          <div className="flex-1 min-w-0">
            <TargetTabBar target={state.targetTab} onSetTarget={store.setTarget} />
          </div>
          {!timelineOpen && (
            <button
              onClick={() => setTimelineOpen(true)}
              className="flex-shrink-0 px-3 text-[10px] border-l cursor-pointer flex items-center gap-1"
              style={{ borderColor: 'var(--line)', color: 'var(--dim)' }}
              title="展开动作时间线"
            >
              ⏱{state.timeline.length > 0 ? ` ${state.timeline.length}` : ''} ▸
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
