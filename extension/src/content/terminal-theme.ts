// Terminal-punk palette constants for content-script injected UI. Plain string
// exports only (no chrome/DOM/lazy-import) so Vite inlines this into content.js
// without emitting a static import — keeps content-build.test.ts green.

export const T_BG = '#0a0e0a'
export const T_PANEL = '#0d130d'
export const T_PANEL2 = '#0f1810'
export const T_LINE = '#1a2a1a'
export const T_DIM = '#5a6a5a'
export const T_TXT = '#c8d8c8'
export const T_GLOW = '#39FF14'
export const T_GLOW_SOFT = 'rgba(57,255,20,0.18)'
export const T_AMBER = '#FFB000'
export const T_RED = '#E5484D'
export const T_FONT = `'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace`

// A glowing panel cssText fragment (compose with position/size by the caller).
export const T_PANEL_BOX = `background:${T_PANEL};color:${T_TXT};border:1px solid ${T_LINE};border-radius:6px;box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 4px 16px rgba(0,0,0,0.5);font-family:${T_FONT};`
