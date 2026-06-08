// Pure accent-color helpers for the sidebar theme (modern dark-tech palette).
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
  { key: 'green', label: '蓝', hex: '#4da3ff' },
  { key: 'amber', label: '琥珀', hex: '#e8a23d' },
  { key: 'cyan', label: '青', hex: '#2dd4bf' },
  { key: 'magenta', label: '紫', hex: '#a78bfa' },
]

const KEYS = new Set<string>(GLOW_COLORS.map(g => g.key))

export function isGlow(v: unknown): v is Glow {
  return typeof v === 'string' && KEYS.has(v)
}

export function normalizeGlow(v: unknown): Glow {
  return isGlow(v) ? v : 'green'
}

export const DEFAULT_GLOW: Glow = 'green'
export const GLOW_STORAGE_KEY = 'sidebarGlow'
