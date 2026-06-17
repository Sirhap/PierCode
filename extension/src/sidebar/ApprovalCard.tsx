// ApprovalCard — 高危动作批准卡。
//
// BROWSER_AGENT_APPROVAL 到达时显示：工具名 + 关键参数 + 风险原因（classifyRisk
// 给的人类可读理由）+ 三个按钮 → onDecision('approve'|'skip'|'allow-all')：
//   执行         = 仅本动作放行
//   跳过         = 回 AI 一条 skipped 结果
//   本会话全程放行 = 翻 autopilot-all 标志，本任务余下动作不再拦
// 用 .amber-*/.red-* 主题工具类做警示样式，不用裸 Tailwind amber-*/red-*。

export function ApprovalCard(props: {
  callId: string
  name: string
  args: Record<string, unknown>
  risk: string
  onDecision: (decision: 'approve' | 'skip' | 'allow-all') => void
}): JSX.Element {
  const { name, args, risk, onDecision } = props
  return (
    <div
      className="flex-shrink-0 mx-2 my-2 rounded-sm border p-3 animate-fade-in-down"
      style={{ borderColor: 'var(--amber)', background: 'var(--panel-2)' }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="amber-text">⚠</span>
        <span className="text-sm font-medium amber-text">高危动作待批准</span>
      </div>

      <div className="text-[12px] mb-1.5">
        <span className="font-medium" style={{ color: 'var(--txt)' }}>{name}</span>
        {risk && <span className="ml-2 amber-text">· {risk}</span>}
      </div>

      <pre
        className="text-[11px] rounded-sm px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all mb-3"
        style={{ background: 'var(--panel)', color: 'var(--dim)' }}
      >
        {JSON.stringify(args, null, 2)}
      </pre>

      <div className="flex gap-2">
        <button
          onClick={() => onDecision('approve')}
          className="flex-1 px-3 py-1.5 text-sm rounded-sm cursor-pointer glow-border"
          style={{ color: 'var(--glow)' }}
          title="仅执行此动作"
        >执行</button>
        <button
          onClick={() => onDecision('skip')}
          className="flex-1 px-3 py-1.5 text-sm rounded-sm cursor-pointer border"
          style={{ borderColor: 'var(--line)', color: 'var(--dim)' }}
          title="跳过此动作"
        >跳过</button>
        <button
          onClick={() => onDecision('allow-all')}
          className="flex-1 px-3 py-1.5 text-sm rounded-sm cursor-pointer border amber-text"
          style={{ borderColor: 'var(--amber)' }}
          title="本任务余下动作全部放行"
        >全程放行</button>
      </div>
    </div>
  )
}
