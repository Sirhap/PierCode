// AiTabBar — AI 平台标签条：切换活跃 AI + ＋ 加新 AI。
// 纯展示组件，状态由 props 驱动（切换只改哪个 AiFrame 可见，iframe 不销毁）。

export function AiTabBar(props: {
  tabs: { id: string; label: string }[]
  active: string
  onSelect: (id: string) => void
  onAdd: () => void
}): JSX.Element {
  const { tabs, active, onSelect, onAdd } = props
  return (
    <div
      className="boot boot-2 flex items-center gap-2 px-3 py-1.5 border-b flex-shrink-0 overflow-x-auto text-xs"
      style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}
    >
      {tabs.map(t => {
        const on = active === t.id
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`whitespace-nowrap cursor-pointer pb-0.5 border-b-2 ${on ? 'glow-text' : ''}`}
            style={{ borderColor: on ? 'var(--glow)' : 'transparent', color: on ? undefined : 'var(--dim)' }}
            title={t.label}
          >
            {on ? '> ' : ''}{t.label.toLowerCase()}
          </button>
        )
      })}
      <button
        onClick={onAdd}
        className="ml-auto cursor-pointer flex-shrink-0"
        style={{ color: 'var(--dim)' }}
        title="添加 AI"
      >＋</button>
    </div>
  )
}
