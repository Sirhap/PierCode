// Pure accent-color helpers for the sidebar theme (Claude Code palette).
// No chrome / React here so it stays unit-testable. The CSS variable swap happens
// in theme.css via the [data-glow="..."] attribute that use-glow.ts sets.
// NB: the key strings are kept ('green'/'amber'/'cyan'/'magenta') for storage
// backward-compat; the displayed colors are the modern palette below.

export type Glow = 'green' | 'amber' | 'cyan' | 'magenta'

export interface GlowColor {
  key: Glow
  label: string
  hex: string // swatch shown in the picker; mirrors --glow in theme.css
}

export const GLOW_COLORS: GlowColor[] = [
  { key: 'cyan', label: '蓝', hex: '#5b8cff' },
  { key: 'green', label: '绿', hex: '#56c08d' },
  { key: 'amber', label: '琥珀', hex: '#e0a44b' },
  { key: 'magenta', label: '紫', hex: '#a986ff' },
]

const KEYS = new Set<string>(GLOW_COLORS.map(g => g.key))

export function isGlow(v: unknown): v is Glow {
  return typeof v === 'string' && KEYS.has(v)
}

export function normalizeGlow(v: unknown): Glow {
  return isGlow(v) ? v : 'cyan'
}

export const DEFAULT_GLOW: Glow = 'cyan'
export const GLOW_STORAGE_KEY = 'sidebarGlow'
