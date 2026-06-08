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

const TOOL_ICON: Record<string, string> = {
  list_dir: 'ls', read_file: 'cat', write_file: 'wr', edit: 'ed',
  exec_cmd: 'sh', grep: 're', glob: 'gl', web_fetch: 'net',
  skill: 'sk', apply_patch: 'patch', question: '?',
}
function toolTag(name: string): string { return TOOL_ICON[name] || 'fn' }

export default function ToolCard({ tool, result, streams }: {
  tool: ToolCall; result?: ToolResult; streams?: string[]
}) {
  const [open, setOpen] = useState(false)
  const warning = getDestructiveWarning(tool.args)
  const output = result?.output || ''
  const outLines = output ? output.split('\n') : []
  const preview = outLines.slice(0, 5).join('\n')
  const truncated = outLines.length > 5 || output.length > 500

  const status = result ? (result.success ? '[done]' : '[fail]') : '[run]'
  const statusCls = result ? (result.success ? 'glow-text' : 'text-red-400') : 'text-amber-400'

  return (
    <div className="my-1.5 text-[12px]">
      {warning && (
        <div className="text-[10px] text-red-300 flex items-center gap-1 mb-1 px-2 py-1 border border-red-800/50 rounded-sm" style={{ background: 'rgba(120,20,20,.15)' }}>
          <span>⚠</span><span>危险操作: {warning}</span>
        </div>
      )}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-sm cursor-pointer border"
        style={{ background: 'var(--panel-2)', borderColor: 'var(--line)' }}
        onClick={() => setOpen(o => !o)}
      >
        <span className="glow-text">◆</span>
        <span style={{ color: 'var(--dim)' }}>{toolTag(tool.name)}</span>
        <span className="font-medium" style={{ color: 'var(--txt)' }}>{tool.name}</span>
        <span className={`${statusCls} ml-1`}>{status}</span>
        {!result && <span className="cursor-blink glow-text">▌</span>}
        <span className="ml-auto" style={{ color: 'var(--dim)' }}>{open ? '▾' : '▸'}</span>
      </div>

      {open && (
        <div className="mt-1 ml-2 pl-2.5 space-y-1.5 border-l" style={{ borderColor: 'var(--line)' }}>
          {Object.keys(tool.args).length > 0 && (
            <div>
              <div className="text-[10px] mb-0.5" style={{ color: 'var(--dim)' }}>args</div>
              <pre className="text-[11px] rounded-sm px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all" style={{ background: '#0d1017', color: 'var(--txt)' }}>
                {JSON.stringify(tool.args, null, 2)}
              </pre>
            </div>
          )}
          {streams && streams.length > 0 && (
            <div>
              <div className="text-[10px] mb-0.5" style={{ color: 'var(--dim)' }}>stdout</div>
              <pre className="text-[11px] rounded-sm px-2 py-1 max-h-32 overflow-y-auto whitespace-pre-wrap glow-text" style={{ background: '#0d1017' }}>
                {streams.join('')}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <div className="text-[10px] mb-0.5" style={{ color: 'var(--dim)' }}>result</div>
              <pre className={`text-[11px] rounded-sm px-2 py-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-all ${result.success ? '' : 'text-red-300'}`} style={{ background: '#0d1017', color: result.success ? 'var(--txt)' : undefined }}>
                {output}
              </pre>
            </div>
          )}
        </div>
      )}

      {!open && result && (
        <div className="mt-0.5 ml-2 pl-2.5 border-l" style={{ borderColor: 'var(--line)' }}>
          <pre className={`text-[11px] whitespace-pre-wrap break-all max-h-16 overflow-hidden ${result.success ? '' : 'text-red-400/70'}`} style={{ color: result.success ? 'var(--dim)' : undefined }}>
            {truncated ? preview + ' …' : output}
          </pre>
        </div>
      )}
    </div>
  )
}
