// Content data for the dynamically-rendered sections.

// Tool names for the feature cards (literal, never translated). Card title and
// description come from i18n keys feat.1t/feat.1d … in the same order.
export const featureTools: string[] = [
  'read_file · write_file',
  'edit · apply_patch',
  'exec_cmd',
  'glob · grep',
  'browser_*',
  'todo_write · skill',
]

export const platforms: { name: string; color: string }[] = [
  { name: 'ChatGPT', color: '#10a37f' },
  { name: 'Claude', color: '#d97757' },
  { name: 'Gemini', color: '#4285f4' },
  { name: 'Qwen', color: '#615ced' },
  { name: 'Kimi', color: '#6b8afd' },
  { name: 'AI Studio', color: '#a142f4' },
  { name: 'Chat Z', color: '#22c55e' },
  { name: 'Mimo', color: '#f59e0b' },
]

// Terminal "demo" lines. Each segment has a class for coloring.
export type TermSeg = { t: string; c?: 'cmd' | 'ok' | 'dim' | 'out' }
export const termScript: TermSeg[][] = [
  [{ t: '$ ', c: 'dim' }, { t: 'grep "func main" cmd/', c: 'cmd' }],
  [{ t: 'cmd/server/main.go:12', c: 'out' }],
  [{ t: '$ ', c: 'dim' }, { t: 'read_file cmd/server/main.go', c: 'cmd' }],
  [{ t: 'func main() { startServer() }', c: 'out' }],
  [{ t: '$ ', c: 'dim' }, { t: 'edit  -port 8080 → 39527', c: 'cmd' }],
  [{ t: '✓ edit applied', c: 'ok' }],
  [{ t: '$ ', c: 'dim' }, { t: 'exec_cmd "go test ./..."', c: 'cmd' }],
  [{ t: 'ok  github.com/sirhap/piercode', c: 'ok' }],
  [{ t: '$ ', c: 'dim' }, { t: 'browser_snapshot', c: 'cmd' }],
  [{ t: '✓ page captured · 42 nodes', c: 'ok' }],
]
