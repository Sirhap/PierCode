// Content data for the dynamically-rendered sections.

// Core capabilities — the big differentiators, rendered as large cards.
// Each entry maps to i18n keys core.Nt / core.Nd / core.Nh (title / desc / highlight).
export const coreCapabilities: { icon: string; i18nKey: string }[] = [
  { icon: '🕸️', i18nKey: 'core.1' },
  { icon: '🗂️', i18nKey: 'core.2' },
  { icon: '📦', i18nKey: 'core.3' },
  { icon: '🧠', i18nKey: 'core.4' },
]

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
