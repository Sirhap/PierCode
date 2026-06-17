// ActionTimeline — 实时动作时间线（boxed 工具卡片）。
//
// 消费 store 的 TimelineEntry[]（由 BROWSER_AGENT_TOOL / TOOL_DONE 归约）：每个
// browser_* 动作渲染成一张带边框卡片——图标 + 中文标题 + 关键参数 + 状态药丸 +
// 可展开的完整参数/结果。镜像内容路由 content/tool-card.ts 与 sidebar ToolCard 的
// ⏺/⎿ 卡片观感，让用户清楚看到 AI 在浏览器上做了什么（取代原先难读的无边框小行）。

import { useState } from 'react'
import type { TimelineEntry } from './browser-agent-store'

// ── 工具元信息：name → 图标 + 中文标题。覆盖常用 browser_* 工具，未知名安全兜底。
interface ToolMeta { icon: string; label: string }
function toolMeta(name: string): ToolMeta {
  const M: Record<string, ToolMeta> = {
    browser_snapshot: { icon: '🗺', label: '读取页面快照' },
    browser_get_page_text: { icon: '📄', label: '读取页面文本' },
    browser_get_content: { icon: '📄', label: '读取内容' },
    browser_click: { icon: '🖱', label: '点击' },
    browser_type: { icon: '⌨', label: '输入文本' },
    browser_form_input: { icon: '⌨', label: '填写表单' },
    browser_navigate: { icon: '🧭', label: '导航' },
    browser_go_back: { icon: '◀', label: '后退' },
    browser_go_forward: { icon: '▶', label: '前进' },
    browser_reload: { icon: '🔄', label: '刷新' },
    browser_scroll: { icon: '↕', label: '滚动' },
    browser_press_key: { icon: '⏎', label: '按键' },
    browser_wait: { icon: '⏳', label: '等待' },
    browser_wait_for_navigation: { icon: '⏳', label: '等待跳转' },
    browser_screenshot: { icon: '📸', label: '截图' },
    browser_mark: { icon: '🔖', label: '标注元素' },
    browser_find: { icon: '🔍', label: '查找元素' },
    browser_new_tab: { icon: '➕', label: '新建标签页' },
    browser_use_tab: { icon: '🪟', label: '接管标签页' },
    browser_tabs: { icon: '🪟', label: '列出标签页' },
    browser_select: { icon: '▾', label: '下拉选择' },
    browser_hover: { icon: '🖱', label: '悬停' },
    browser_drag: { icon: '✋', label: '拖拽' },
    browser_upload: { icon: '📎', label: '上传文件' },
    browser_attachment_upload: { icon: '📎', label: '上传附件' },
    browser_evaluate: { icon: '⚙', label: '执行脚本' },
    browser_set_cookie: { icon: '🍪', label: '设置 Cookie' },
    browser_cookies: { icon: '🍪', label: 'Cookie' },
    browser_clipboard: { icon: '📋', label: '剪贴板' },
    browser_handle_dialog: { icon: '💬', label: '处理弹窗' },
    browser_batch: { icon: '⚡', label: '批量动作' },
    browser_console: { icon: '🖥', label: '控制台日志' },
    browser_network: { icon: '🌐', label: '网络请求' },
    question: { icon: '❓', label: '提问' },
  }
  return M[name] || { icon: '🔧', label: name.replace(/^browser_/, '').replace(/_/g, ' ') }
}

// browser_* 工具的关键参数摘要：优先 ref/mark/选择器/坐标/url/text/key。
function argSummary(name: string, args: Record<string, unknown>): string {
  const parts: string[] = []
  const ref = args.ref ?? args.selector ?? (args.mark != null ? `mark=${args.mark}` : undefined)
  const hasXY = args.x != null && args.y != null
  if (ref != null) parts.push(String(ref))
  else if (hasXY) parts.push(`@${args.x},${args.y}`)

  if (typeof args.url === 'string' && args.url) parts.push(truncate(args.url, 48))
  if (typeof args.key === 'string' && args.key) parts.push(String(args.key))
  if (typeof args.text === 'string' && args.text) parts.push(`"${truncate(args.text, 32)}"`)
  if (args.submit === true) parts.push('submit')
  if (typeof args.direction === 'string' && args.direction) parts.push(String(args.direction))

  if (name === 'browser_batch' && Array.isArray(args.actions)) {
    parts.push(`${args.actions.length} 步`)
  }

  return parts.join(' ')
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// 状态药丸文案 + 颜色类。
function statusPill(entry: TimelineEntry): { text: string; cls: string } {
  if (entry.status === 'pending' || entry.status === 'running') return { text: '执行中', cls: 'cc-pill-run' }
  if (entry.status === 'error' || entry.success === false) return { text: '失败', cls: 'cc-pill-err' }
  return { text: '完成', cls: 'cc-pill-ok' }
}

function TimelineCard({ entry, current }: { entry: TimelineEntry; current: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const running = entry.status === 'pending' || entry.status === 'running'
  const meta = toolMeta(entry.name)
  const summary = argSummary(entry.name, entry.args)
  const output = entry.output ?? ''
  const lines = output ? output.split('\n') : []
  const firstLine = lines[0] || ''
  const hasMore = lines.length > 1 || output.length > 120 || Object.keys(entry.args || {}).length > 0
  const pill = statusPill(entry)
  const dotCls = running ? 'cc-dot-run' : entry.success === false || entry.status === 'error' ? 'cc-dot-err' : 'cc-dot-ok'

  return (
    <div className={`cc-card ${current ? 'cc-card-current' : ''}`}>
      {/* 头：状态点 + 图标 + 中文标题 + 参数 + 状态药丸 + 展开箭头 */}
      <button
        className="cc-card-head"
        onClick={() => hasMore && setOpen(o => !o)}
        style={{ cursor: hasMore ? 'pointer' : 'default' }}
      >
        <span className={`cc-dot ${dotCls} ${running ? 'animate-pulse-dot' : ''}`} />
        <span className="cc-card-icon">{meta.icon}</span>
        <span className="cc-card-title">{meta.label}</span>
        {summary && <span className="cc-card-arg">{summary}</span>}
        <span className="cc-card-spacer" />
        <span className={`cc-pill ${pill.cls}`}>{pill.text}</span>
        {hasMore && <span className="cc-card-chevron">{open ? '▾' : '▸'}</span>}
      </button>

      {/* 结果行（未展开时只显示首行摘要）*/}
      {!running && firstLine && (
        <div className="cc-card-result" style={{ color: entry.success === false ? 'var(--red)' : 'var(--dim)' }}>
          {entry.success === false ? '✗ ' : '✓ '}{open ? '' : truncate(firstLine, 80)}
          {!open && lines.length > 1 && <span style={{ opacity: 0.6 }}> … {lines.length} 行</span>}
        </div>
      )}
      {running && (
        <div className="cc-card-result animate-pulse-dot" style={{ color: 'var(--dim)' }}>执行中…</div>
      )}

      {/* 展开：完整参数 + 完整结果 */}
      {open && (
        <div className="cc-card-detail">
          {Object.keys(entry.args || {}).length > 0 && (
            <pre className="cc-card-pre">{JSON.stringify(entry.args, null, 2)}</pre>
          )}
          {output && <pre className="cc-card-pre">{output}</pre>}
        </div>
      )}
    </div>
  )
}

export function ActionTimeline(props: { entries: TimelineEntry[]; streamPreview?: string }): JSX.Element {
  const { entries, streamPreview } = props
  const lastIdx = entries.length - 1

  if (entries.length === 0 && !streamPreview) {
    return (
      <div className="flex-1 flex items-center justify-center text-[11px] px-4 text-center" style={{ color: 'var(--dim)' }}>
        <div className="space-y-1">
          <p>下方输入任务，AI 看页面快照自主操作浏览器</p>
          <p className="text-[10px]">每个动作会以卡片显示在这里</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto chat-scroll px-2 py-2 space-y-1.5">
      {streamPreview && (
        <div
          className="mb-1 text-[11px] whitespace-pre-wrap break-all rounded-sm px-2 py-1.5 border"
          style={{ borderColor: 'var(--line)', background: 'var(--panel-2)', color: 'var(--dim)' }}
        >
          <span className="glow-text">↳ </span>{streamPreview}
        </div>
      )}
      {entries.map((e, i) => (
        <TimelineCard key={e.callId} entry={e} current={i === lastIdx} />
      ))}
    </div>
  )
}
