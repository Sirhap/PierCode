import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// Hub-page build marker (separate from content.js's __PIERCODE_BUILD__, which runs
// in the embedded iframes). Check `window.__PIERCODE_HUB_BUILD__` in the HUB page
// console to confirm a fresh hub.js — the zoom controls / scroll-lock / node size
// presets all live here, so a stale Hub tab shows none of them even after the
// extension is reloaded. Reload the Hub TAB (not just the extension) to update it.
;(window as any).__PIERCODE_HUB_BUILD__ = 'hub-tree-default-2026-06-07'
console.log('[PierCode] Hub loaded, build:', (window as any).__PIERCODE_HUB_BUILD__)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
