// Claude Code palette constants for content-script injected UI. Plain string
// exports only (no chrome/DOM/lazy-import) so Vite inlines this into content.js
// without emitting a static import — keeps content-build.test.ts green.
// (T_ names kept for minimal call-site churn; values are the Claude Code palette.)

export const T_BG = '#1a1a1a'
export const T_PANEL = '#1f1f1f'
export const T_PANEL2 = '#262625'
export const T_LINE = '#2e2e2c'
export const T_DIM = '#8a8580'
export const T_TXT = '#e8e6e3'
export const T_GLOW = '#d77757'
export const T_GLOW_SOFT = 'rgba(215,119,87,0.16)'
export const T_AMBER = '#b8842a'
export const T_RED = '#c0394e'
export const T_FONT = `'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace`

// A glowing panel cssText fragment (compose with position/size by the caller).
export const T_PANEL_BOX = `background:${T_PANEL};color:${T_TXT};border:1px solid ${T_LINE};border-radius:6px;box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 4px 16px rgba(0,0,0,0.5);font-family:${T_FONT};`
