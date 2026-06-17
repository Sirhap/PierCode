// TargetTabBar — 被操作页（page-under-control）指示 + 换页。
//
// 显示当前被操作 tab 的 title/url，点「换页」懒查 chrome.tabs 列出候选，
// 选中后 onSetTarget(tabId)（store 发 BROWSER_AGENT_TARGET，SW 回带标题/URL 落地）。
// 默认被操作页 = 任务启动时 SW 解析的活跃 tab（targetTab.tabId 仍为 null 时显示「自动」）。

import { useEffect, useRef, useState } from 'react'

interface TabCandidate {
  tabId: number
  title: string
  url: string
}

// 过滤掉本扩展自己的页面（侧边栏/弹窗）与无效 tab。
function isOperableUrl(url: string): boolean {
  if (!url) return false
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://') || url.startsWith('about:')) {
    return false
  }
  return /^https?:/.test(url)
}

export function TargetTabBar(props: {
  target: { tabId: number | null; title?: string; url?: string }
  onSetTarget: (tabId: number) => void
}): JSX.Element {
  const { target, onSetTarget } = props
  const [open, setOpen] = useState(false)
  const [candidates, setCandidates] = useState<TabCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // 打开时懒查候选 tab。
  useEffect(() => {
    if (!open) return
    setLoading(true)
    try {
      chrome.tabs.query({}, tabs => {
        const list: TabCandidate[] = (tabs || [])
          .filter(t => t.id != null && isOperableUrl(t.url || ''))
          .map(t => ({ tabId: t.id as number, title: t.title || '(无标题)', url: t.url || '' }))
        setCandidates(list)
        setLoading(false)
      })
    } catch {
      setCandidates([])
      setLoading(false)
    }
  }, [open])

  // 点外部关闭下拉。
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const label = target.tabId == null
    ? '自动（活跃标签页）'
    : (target.title || target.url || `tab #${target.tabId}`)
  const host = (() => {
    if (!target.url) return ''
    try { return new URL(target.url).host } catch { return target.url }
  })()

  return (
    <div
      ref={boxRef}
      className="relative flex items-center gap-2 px-3 py-1.5 border-t flex-shrink-0 text-[11px]"
      style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
    >
      <span className="flex-shrink-0" style={{ color: 'var(--dim)' }}>被操作页</span>
      <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--txt)' }} title={target.url || label}>
        <span className="glow-text">▸ </span>{label}
        {host && <span className="ml-1" style={{ color: 'var(--dim)' }}>· {host}</span>}
      </span>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex-shrink-0 cursor-pointer px-2 py-0.5 rounded-sm border"
        style={{ borderColor: 'var(--line)', color: 'var(--dim)' }}
        title="切换被操作的标签页"
      >换页</button>

      {open && (
        <div
          className="absolute right-2 bottom-8 z-[60] w-72 max-h-72 overflow-y-auto chat-scroll rounded-sm border shadow-lg"
          style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
        >
          <div className="px-2 py-1.5 border-b" style={{ borderColor: 'var(--line)' }}>
            <span style={{ color: 'var(--dim)' }}>选择要操作的标签页{loading ? '（加载中…）' : `（${candidates.length}）`}</span>
          </div>
          {!loading && candidates.length === 0 && (
            <div className="px-2 py-3" style={{ color: 'var(--dim)' }}>没有可操作的标签页</div>
          )}
          {candidates.map(c => {
            const on = c.tabId === target.tabId
            let h = c.url
            try { h = new URL(c.url).host } catch { /* keep raw */ }
            return (
              <div
                key={c.tabId}
                className="px-2 py-1.5 cursor-pointer hover:opacity-80 border-b last:border-b-0"
                style={{ borderColor: 'var(--line)', background: on ? 'var(--panel-2)' : 'transparent' }}
                onClick={() => { onSetTarget(c.tabId); setOpen(false) }}
                title={c.url}
              >
                <div className={`truncate ${on ? 'glow-text' : ''}`} style={{ color: on ? undefined : 'var(--txt)' }}>
                  {on ? '> ' : ''}{c.title}
                </div>
                <div className="text-[10px] truncate" style={{ color: 'var(--dim)' }}>{h}</div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
