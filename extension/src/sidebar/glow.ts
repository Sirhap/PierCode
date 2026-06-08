// Pure glow-color helpers for the terminal-punk sidebar theme. No chrome / React
// here so it stays unit-testable. The actual CSS variable swap happens in
// theme.css via the [data-glow="..."] attribute that use-glow.ts sets.

export type Glow = 'green' | 'amber' | 'cyan' | 'magenta'

export interface GlowColor {
  key: Glow
  label: string
  hex: string // swatch shown in the picker; mirrors --glow in theme.css
}

export const GLOW_COLORS: GlowColor[] = [
  { key: 'green', label: '荧光绿', hex: '#39FF14' },
  { key: 'amber', label: '琥珀', hex: '#FFB000' },
  { key: 'cyan', label: '青', hex: '#00E5FF' },
  { key: 'magenta', label: '品红', hex: '#FF2D95' },
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
