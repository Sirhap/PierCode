// Content data for the dynamically-rendered sections.

// Core capabilities — the big differentiators, rendered as large cards.
// `icon` is a short mono tag (terminal aesthetic, not an emoji). Each entry
// maps to i18n keys core.Nt / core.Nd / core.Nh (title / desc / highlight).
export const coreCapabilities: { icon: string; i18nKey: string }[] = [
  { icon: '[ orchestrate ]', i18nKey: 'core.1' },
  { icon: '[ workspace ]', i18nKey: 'core.2' },
  { icon: '[ compress ]', i18nKey: 'core.3' },
  { icon: '[ memory ]', i18nKey: 'core.4' },
]

// Model modes — a compact strip; each maps to i18n keys mode.Nt / mode.Nd.
// `tag` is a literal mono badge (model capability), never translated.
export const modes: { tag: string; i18nKey: string }[] = [
  { tag: 'thinking', i18nKey: 'mode.1' },
  { tag: 'fast', i18nKey: 'mode.2' },
  { tag: 'auto', i18nKey: 'mode.3' },
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

// Platforms — rendered as a process-list. `status` is a literal mono label.
export const platforms: { name: string; color: string; status: string }[] = [
  { name: 'ChatGPT', color: '#10a37f', status: 'ready' },
  { name: 'Claude', color: '#d97757', status: 'ready' },
  { name: 'Gemini', color: '#4285f4', status: 'ready' },
  { name: 'Qwen', color: '#615ced', status: 'ready' },
  { name: 'Kimi', color: '#6b8afd', status: 'ready' },
  { name: 'AI Studio', color: '#a142f4', status: 'ready' },
  { name: 'Chat Z', color: '#22c55e', status: 'ready' },
  { name: 'Mimo', color: '#f59e0b', status: 'ready' },
]
