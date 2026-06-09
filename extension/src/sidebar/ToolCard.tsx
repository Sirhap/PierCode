import { useState } from 'react'

export interface ToolCall { name: string; args: Record<string, unknown>; call_id: string }
export interface ToolResult { call_id: string; name: string; output: string; success: boolean }

const DESTRUCTIVE_PATTERNS = [
  { pattern: /rm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r[a-zA-Z]*\s+-[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*\s+-[a-zA-Z]*r)/, label: 'rm -rf（递归强制删除）' },
  { pattern: /rm\s+-rf\s+\//, label: 'rm -rf /（删除根目录）' },
  { pattern: /git\s+reset\s+--hard/, label: 'git reset --hard（不可逆重置）' },
  { pattern: /git\s+clean\s+-fd/, label: 'git clean -fd（强制清理）' },
  { pattern: /git\s+push\s+.*--force/, label: 'git push --force（强制推送）' },
  { pattern: /DROP\s+(TABLE|DATABASE|SCHEMA)/i, label: 'DROP TABLE/DATABASE（删除数据库对象）' },
  { pattern: /DELETE\s+FROM.*WHERE\s+1\s*=\s*1/i, label: 'DELETE FROM（清空表数据）' },
  { pattern: /mkfs/, label: 'mkfs（格式化磁盘）' },
  { pattern: /dd\s+if=/, label: 'dd（低级磁盘写入）' },
  { pattern: />\s*\/dev\/sd[a-z]/, label: '写入磁盘设备' },
]

export function getDestructiveWarning(args: Record<string, unknown>): string | null {
  const cmd = String(args.command || args.cmd || '')
  if (!cmd) return null
  for (const { pattern, label } of DESTRUCTIVE_PATTERNS) if (pattern.test(cmd)) return label
  return null
}

function argSummary(args: Record<string, unknown>): string {
  const val =
    args.path ?? args.pattern ?? args.command ?? args.query ?? args.cmd ?? args.url ?? null
  if (val == null) return ''
  const s = String(val)
  const truncated = s.length > 40 ? s.slice(0, 37) + '…' : s
  // find the key we matched
  const key = ['path', 'pattern', 'command', 'query', 'cmd', 'url'].find(k => args[k] != null) ?? ''
  return `(${key}:${truncated})`
}

export default function ToolCard({ tool, result, streams }: {
  tool: ToolCall; result?: ToolResult; streams?: string[]
}) {
  const [open, setOpen] = useState(false)
  const warning = getDestructiveWarning(tool.args)
  const output = result?.output || ''
  const outLines = output ? output.split('\n') : []
  const firstLine = outLines[0] || ''
  const lineCount = outLines.length
  const truncated = lineCount > 1 || output.length > 500

  // Determine ⏺ color
  const running = !result
  const dotColor = running
    ? 'var(--glow)'
    : result!.success
      ? 'var(--dim)'
      : 'var(--red, #e06c75)'

  const summary = argSummary(tool.args)
  const hasContent = (result && output) || (streams && streams.length > 0)

  return (
    <div className="cc-tool my-1 text-[12px]" style={{ fontFamily: 'inherit' }}>
      {warning && (
        <div className="text-[11px] mb-0.5" style={{ color: 'var(--red, #e06c75)' }}>
          ⚠ 危险操作: {warning}
        </div>
      )}

      {/* Header row: ⏺ tool_name(arg) */}
      <div
        className="flex items-baseline gap-1 cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
      >
        <span
          className={running ? 'animate-pulse-dot' : ''}
          style={{ color: dotColor, fontSize: '0.85em', lineHeight: 1 }}
        >⏺</span>
        <span className="font-medium" style={{ color: 'var(--txt)' }}>{tool.name}</span>
        {summary && (
          <span style={{ color: 'var(--dim)' }}>{summary}</span>
        )}
      </div>

      {/* Result / stream tree rows — always shown (collapsed = 1-line summary) */}
      {hasContent && (
        <div className="cc-result-tree">
          {/* Streams */}
          {streams && streams.length > 0 && (
            <div className="cc-result-row">
              <span className="cc-corner" style={{ color: 'var(--dim)' }}>⎿ </span>
              <span style={{ color: 'var(--dim)' }}>
                {open ? streams.join('') : streams.join('').split('\n')[0]}
              </span>
            </div>
          )}

          {/* Result */}
          {result && output && (
            <div className="cc-result-row">
              <span className="cc-corner" style={{ color: 'var(--dim)' }}>⎿ </span>
              {open ? (
                <pre
                  className="whitespace-pre-wrap break-all flex-1"
                  style={{ color: result.success ? 'var(--txt)' : 'var(--red, #e06c75)' }}
                >
                  {output}
                </pre>
              ) : (
                <span style={{ color: result.success ? 'var(--dim)' : 'var(--red, #e06c75)' }}>
                  {firstLine}{truncated ? ` … (${lineCount} 行)` : ''}
                </span>
              )}
            </div>
          )}

          {/* Expanded: args sub-row */}
          {open && Object.keys(tool.args).length > 0 && (
            <div className="cc-result-row">
              <span className="cc-corner" style={{ color: 'var(--dim)' }}>⎿ </span>
              <span style={{ color: 'var(--dim)' }}>args</span>
              <pre
                className="text-[11px] rounded-sm px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all mt-0.5 ml-4"
                style={{ background: '#161615', color: 'var(--txt)' }}
              >
                {JSON.stringify(tool.args, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Expanded without any result yet: show args */}
      {open && !hasContent && Object.keys(tool.args).length > 0 && (
        <div className="cc-result-tree">
          <div className="cc-result-row">
            <span className="cc-corner" style={{ color: 'var(--dim)' }}>⎿ </span>
            <span style={{ color: 'var(--dim)' }}>args</span>
          </div>
          <pre
            className="text-[11px] rounded-sm px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all ml-6 mt-0.5"
            style={{ background: '#161615', color: 'var(--txt)' }}
          >
            {JSON.stringify(tool.args, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
