// Cold-modern palette constants for content-script injected UI, mirroring
// sidebar/theme.css + popup/theme.css design tokens so on-page cards/buttons
// match the rest of the extension. Plain string exports only (no chrome/DOM/
// lazy-import) so Vite inlines this into content.js without emitting a static
// import — keeps content-build.test.ts green.
// (T_ names kept for minimal call-site churn.)

export const T_BG = '#0e1116'
export const T_PANEL = '#161a21'
export const T_PANEL2 = '#1b212b'
export const T_LINE = '#262d3a'
export const T_DIM = '#8b94a7'
export const T_TXT = '#e6e9ef'
export const T_GLOW = '#5b8cff'
export const T_GLOW_SOFT = 'rgba(91,140,255,0.16)'
export const T_AMBER = '#e0a44b'
export const T_RED = '#e5556e'
export const T_FONT = `'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace`

// A glowing panel cssText fragment (compose with position/size by the caller).
export const T_PANEL_BOX = `background:${T_PANEL};color:${T_TXT};border:1px solid ${T_LINE};border-radius:6px;box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 4px 16px rgba(0,0,0,0.5);font-family:${T_FONT};`
