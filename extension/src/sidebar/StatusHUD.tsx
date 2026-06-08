import { useEffect, useState } from 'react'
import { type TokenMeter } from './token-count'

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export default function StatusHUD({ connected, meter, platform: _platform, threshold, activeAgents }: {
  connected: boolean
  meter: TokenMeter
  platform: string
  threshold: number
  activeAgents: number
}) {
  const [rootDir, setRootDir] = useState('')
  const [version, setVersion] = useState('')

  useEffect(() => {
    if (!connected) { setRootDir(''); setVersion(''); return }
    chrome.storage.local.get(['apiUrl', 'authToken'], (result) => {
      if (!result.apiUrl || !result.authToken) return
      const headers = { Authorization: `Bearer ${result.authToken}` }
      fetch(`${result.apiUrl}/config`, { headers }).then(r => r.json())
        .then(cfg => setRootDir(cfg?.rootDir || '')).catch(() => {})
      fetch(`${result.apiUrl}/health`, { headers }).then(r => r.json())
        .then(h => setVersion(h?.version || '')).catch(() => {})
    })
  }, [connected])

  const total = meter.total

  const ratio = threshold > 0 ? Math.min(1, total / threshold) : 0
  const segs = 10
  const filled = Math.round(ratio * segs)
  const bar = '▓'.repeat(filled) + '░'.repeat(segs - filled)

  return (
    <div className="flex items-center gap-2 px-3 py-1 border-t text-[10px] flex-shrink-0 overflow-hidden"
      style={{ borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--dim)' }}>
      <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'dot-live' : ''}`} style={{ background: connected ? undefined : '#7a2a2a' }} />
      <span>{connected ? 'ck' : 'off'}</span>
      {rootDir && <span className="truncate max-w-[120px]" title={rootDir}>📁{rootDir.replace(/^.*\//, '')}</span>}
      {version && <span style={{ color: 'var(--dim)' }}>v{version}</span>}
      <span className="glow-text font-mono">{bar}</span>
      <span>{fmt(total)}/{fmt(threshold)}</span>
      {activeAgents > 0 && <span className="ml-auto glow-text">⚙{activeAgents}</span>}
    </div>
  )
}
