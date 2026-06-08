// Modern dark-tech palette constants for content-script injected UI. Plain string
// exports only (no chrome/DOM/lazy-import) so Vite inlines this into content.js
// without emitting a static import — keeps content-build.test.ts green.
// (T_ names kept for minimal call-site churn; values are the modern blue palette.)

export const T_BG = '#0b0d10'
export const T_PANEL = '#141821'
export const T_PANEL2 = '#1a1f2b'
export const T_LINE = '#232a36'
export const T_DIM = '#6b7686'
export const T_TXT = '#cdd4de'
export const T_GLOW = '#4da3ff'
export const T_GLOW_SOFT = 'rgba(77,163,255,0.16)'
export const T_AMBER = '#e8a23d'
export const T_RED = '#E5484D'
export const T_FONT = `'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace`

// A glowing panel cssText fragment (compose with position/size by the caller).
export const T_PANEL_BOX = `background:${T_PANEL};color:${T_TXT};border:1px solid ${T_LINE};border-radius:6px;box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 4px 16px rgba(0,0,0,0.5);font-family:${T_FONT};`
