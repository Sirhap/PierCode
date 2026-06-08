import { useEffect, useRef, useState } from 'react'
import { fuzzyFilter, type Command } from './commands'

export interface SearchHit { index: number; preview: string }

export default function CommandPalette({ commands, onClose, onSearch, onPickSearch }: {
  commands: Command[]
  onClose: () => void
  onSearch: (q: string) => SearchHit[]
  onPickSearch: (index: number) => void
}) {
  const [mode, setMode] = useState<'command' | 'search'>('command')
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setSel(0) }, [query, mode])

  const cmdResults = mode === 'command' ? fuzzyFilter(commands, query) : []
  const searchResults = mode === 'search' ? onSearch(query) : []
  const count = mode === 'command' ? cmdResults.length : searchResults.length

  function exec(i: number) {
    if (mode === 'command') { cmdResults[i]?.run(); onClose() }
    else { const hit = searchResults[i]; if (hit) { onPickSearch(hit.index); onClose() } }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(count - 1, s + 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); return }
    if (e.key === 'Enter') { e.preventDefault(); exec(sel); return }
    if (e.key === 'Tab') { e.preventDefault(); setMode(m => m === 'command' ? 'search' : 'command'); setQuery('') }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-16" style={{ background: 'rgba(0,0,0,.55)' }} onClick={onClose}>
      <div className="w-[88%] max-w-md rounded-sm border glow-border" style={{ background: 'var(--panel)', borderColor: 'var(--line)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--line)' }}>
          <span className="glow-text">{mode === 'command' ? '>' : '/'}</span>
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKey}
            placeholder={mode === 'command' ? '输入命令…  (Tab 切到搜索)' : '搜索消息…  (Tab 切回命令)'}
            className="flex-1 bg-transparent outline-none text-sm" style={{ color: 'var(--txt)' }} />
          <button onClick={() => { setMode(m => m === 'command' ? 'search' : 'command'); setQuery('') }}
            className="text-[10px] px-1.5 py-0.5 rounded-sm border" style={{ borderColor: 'var(--line)', color: 'var(--dim)' }}>
            {mode === 'command' ? 'cmd' : 'search'}
          </button>
        </div>
        <div className="max-h-72 overflow-y-auto chat-scroll py-1">
          {mode === 'command' && cmdResults.map((c, i) => (
            <div key={c.id} onMouseEnter={() => setSel(i)} onClick={() => exec(i)}
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm"
              style={{ background: i === sel ? 'var(--glow-soft)' : 'transparent', color: 'var(--txt)' }}>
              <span className={i === sel ? 'glow-text' : ''}>▸</span>
              <span className="flex-1">{c.title}</span>
              {c.hint && <span className="text-[10px]" style={{ color: 'var(--dim)' }}>{c.hint}</span>}
            </div>
          ))}
          {mode === 'search' && searchResults.map((h, i) => (
            <div key={h.index} onMouseEnter={() => setSel(i)} onClick={() => exec(i)}
              className="px-3 py-1.5 cursor-pointer text-xs truncate"
              style={{ background: i === sel ? 'var(--glow-soft)' : 'transparent', color: 'var(--txt)' }}>
              <span style={{ color: 'var(--dim)' }}>#{h.index} </span>{h.preview}
            </div>
          ))}
          {count === 0 && <div className="px-3 py-3 text-xs" style={{ color: 'var(--dim)' }}>无匹配</div>}
        </div>
      </div>
    </div>
  )
}
