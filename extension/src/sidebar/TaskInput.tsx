// TaskInput — 底部任务输入框。
//
// textarea + ▶ 跑 / ■ 停（由 running 切换）。Enter 发送、Shift+Enter 换行、
// IME 安全（组合态 keyCode 229 / isComposing 兜底，复刻旧 App.tsx 的发送守卫）。

import { useEffect, useRef, useState } from 'react'

export function TaskInput(props: {
  running: boolean
  onSubmit: (task: string) => void
  onStop: () => void
}): JSX.Element {
  const { running, onSubmit, onStop } = props
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // 自适应高度（与旧 App 一致，最高 120px）。
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [text])

  useEffect(() => { ref.current?.focus() }, [])

  const submit = () => {
    const t = text.trim()
    if (!t || running) return
    onSubmit(t)
    setText('')
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // IME 组合态的 Enter 是选字确认，不是发送（keyCode 229 兜底旧 WebKit）。
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      submit()
    }
  }

  return (
    <div
      className="boot boot-4 flex-shrink-0 border-t p-2"
      style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
    >
      <div className="flex gap-2 items-end">
        <span className="glow-text pb-2 select-none">▌</span>
        <textarea
          ref={ref}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={running ? 'AI 正在操作浏览器…' : '下达任务，例如：帮我登录这个站并截图'}
          rows={1}
          disabled={running}
          className="flex-1 rounded-sm px-2 py-2 text-sm outline-none resize-none overflow-hidden border disabled:opacity-60"
          style={{ background: 'var(--panel-2)', borderColor: 'var(--line)', color: 'var(--txt)', maxHeight: '120px' }}
        />
        {running ? (
          <button
            onClick={onStop}
            className="px-3 py-2 text-sm rounded-sm cursor-pointer flex-shrink-0 red-text border"
            style={{ borderColor: 'var(--red)' }}
            title="停止任务"
          >■</button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim()}
            className="px-3 py-2 text-sm rounded-sm cursor-pointer flex-shrink-0 glow-border disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--glow)' }}
            title="运行任务 (Enter)"
          >▶</button>
        )}
      </div>
    </div>
  )
}
