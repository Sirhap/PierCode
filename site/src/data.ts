// Content data for the dynamically-rendered sections.

export const features: { tool: string; title: string; desc: string }[] = [
  { tool: 'read_file · write_file', title: 'Read & write code', desc: 'Inspect and create files inside the sandboxed working directory.' },
  { tool: 'edit · apply_patch', title: 'Surgical edits', desc: 'Exact string replacements and multi-file contextual patches.' },
  { tool: 'exec_cmd', title: 'Run commands', desc: 'Shell execution with path validation and a dangerous-command filter.' },
  { tool: 'glob · grep', title: 'Search the repo', desc: 'Find files by pattern and search contents with regex.' },
  { tool: 'browser_*', title: 'Drive the browser', desc: '~25 CDP tools — navigate, click, type, snapshot, screenshot, with approval.' },
  { tool: 'todo_write · skill', title: 'Plan & extend', desc: 'Track multi-step work and load reusable skills on demand.' },
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
