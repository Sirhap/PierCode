// QuestionCard — browser-agent 的 AI 提问卡片。
//
// browser-agent 回合里 AI 可能 emit 一个 `question` 工具向用户提问（如"要登录哪个
// 账号？"）。SW 把它路由成 BROWSER_AGENT_QUESTION 广播，store 落 pendingQuestion，
// 本卡片渲染问题 + 选项 + 自定义输入，收集回答经 answerQuestion 回传 SW，作为
// question 工具的结果喂回 AI，循环继续。形状镜像旧 App.tsx 的 QuestionCard。

import { useState } from 'react'

export function QuestionCard({ question, options, onAnswer }: {
  question: string
  options: string[]
  onAnswer: (answer: string) => void
}): JSX.Element {
  const [customInput, setCustomInput] = useState('')

  return (
    <div className="my-1 mx-1 rounded-sm border p-3 pointer-events-auto" style={{ borderColor: 'var(--line)', background: 'var(--panel-2)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="glow-text">❓</span>
        <span className="text-sm font-medium glow-text">AI 需要你的回答</span>
      </div>
      <p className="text-sm mb-3 whitespace-pre-wrap" style={{ color: 'var(--txt)' }}>{question}</p>

      {options.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {options.map((opt, i) => (
            <button
              key={i}
              onClick={() => onAnswer(opt)}
              className="w-full text-left px-3 py-1.5 rounded-sm border text-sm transition-colors cursor-pointer hover:opacity-80"
              style={{ background: 'var(--panel)', borderColor: 'var(--line)', color: 'var(--txt)' }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          value={customInput}
          onChange={e => setCustomInput(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return
            if (customInput.trim()) onAnswer(customInput.trim())
          }}
          placeholder={options.length > 0 ? '或输入自定义回答…' : '输入回答…'}
          className="flex-1 rounded-sm border px-3 py-1.5 text-sm outline-none"
          style={{ background: 'var(--panel)', borderColor: 'var(--line)', color: 'var(--txt)' }}
        />
        <button
          onClick={() => customInput.trim() && onAnswer(customInput.trim())}
          disabled={!customInput.trim()}
          className="px-3 py-1.5 text-sm rounded-sm glow-border cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ color: 'var(--glow)' }}
        >
          提交
        </button>
      </div>
    </div>
  )
}
