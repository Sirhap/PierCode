# Multi-AI Hub — in-browser foreground multi-tab manager

## Context

PierCode's worker agents run in **background browser tabs**. Chrome throttles
background tabs and AI sites pause their streaming response when
`document.hidden` fires, so a dispatched worker often can't generate — the
"后台无法响应" problem. The current keep-alive visibility shim only patches this
partially, and multiple workers fight over the single foreground tab.

The user wants a **single in-browser manager page** that embeds multiple AI sites
side-by-side, all **visible and streaming at once**, with no foreground
switching, plus a data dashboard (P2). This stays a Chrome extension — no
desktop/Electron app. Existing extension behavior and the Go server are
untouched; the Hub is an additive, optional entry point.

**Feasibility is proven by a shipping production extension**, Simple Chat Hub
(`/tmp/sch-unpack/ext`, Chrome/Edge/Firefox, MV3). Its mechanism, verified
against ChatGPT/Claude/Gemini/Qwen/Kimi including Cloudflare-gated Claude:

1. A `chatHub.html` extension page hosts one `<iframe>` per AI site, all in one
   active tab (so every frame is `visibilityState:visible` → unthrottled →
   simultaneous streaming).
2. **Dynamic `declarativeNetRequest` rules**, scoped to requests *initiated by
   the extension page* (`condition.initiatorDomains:[<extension hostname>]`),
   that on the AI hosts:
   - remove `X-Frame-Options` and `Content-Security-Policy` response headers
     (lifts the iframe ban — all AI sites send `X-Frame-Options: SAMEORIGIN`);
   - set request headers `Sec-Fetch-Dest: document`, `Sec-Fetch-Site:
     same-origin` (disguises the sub-frame load as a top-level navigation so the
     site's own frame/Cloudflare checks pass — the piece a naive header-strip
     misses);
   - Firefox compat: also set the legacy `domains` field when the UA is old.
3. **Dynamic `chrome.scripting.registerContentScripts`** injects the operating
   scripts into the embedded sites (`allFrames:true`): one `world:MAIN`
   `document_start` script (early page-context shim) and one `document_idle`
   isolated-world content script (the operator).

This maps almost 1:1 onto PierCode's existing `page-bridge` (MAIN-world early
shim) and `content.js` (isolated-world operator). The Hub reuses them verbatim.

## Decisions (from brainstorming)

- **Form**: in-browser only. No Electron/desktop. (Electron path explored and
  dropped.)
- **Layout**: a dedicated extension Hub page (`hub.html`) with N side-by-side
  iframes + dashboard. Opened from the action icon / a control.
- **Embedding**: DNR header-strip + Sec-Fetch disguise, exactly as Simple Chat
  Hub. Dynamic rules scoped to the extension's own initiator.
- **content reuse**: keep the existing isolated-world `content.js` and
  `page-bridge.js`; register them dynamically via `registerContentScripts`
  (`allFrames:true`) so they run inside Hub iframes. The static
  `content_scripts` declaration stays for the normal-tab flow — **old behavior
  unchanged**.
- **chrome.* availability**: content scripts keep `chrome.runtime/storage` even
  inside iframes, so no shim is needed (unlike the abandoned Electron path).
  `getConversationKey`/exec-dedup already tolerate sub-frames.
- **worker binding**: unchanged `?piercode_agent=<id>` URL mechanism — a worker
  becomes an iframe whose `src` carries the query; `workerAgentId()` reads it as
  today.
- **Go server**: zero changes. Hub connects the same way (WS `/ws`, `/exec`).

## Architecture

New, isolated under `extension/src/hub/` plus a small DNR module. Nothing in
`internal/` (Go) or the existing content/background entry contracts changes
semantically.

```
extension/
  public/manifest.json   # +declarativeNetRequest perm, +hub.html page + Vite entry,
                          # web_accessible adds hub-injected frame resources.
                          # Static content_scripts stays top-frame-only (old flow);
                          # iframe injection is done dynamically, not via all_frames.
  src/
    hub/                  # NEW — the Hub page (own Vite entry, like popup/)
      index.tsx           # React: tab/pane grid, add/remove/reorder AI panes
      hub.html
      pane-manager.ts     # iframe lifecycle, lazy-load + keep resident
      dashboard.ts        # P2 data dashboard (agent/tool/token status)
    background/
      frame-unlock.ts     # NEW — dynamic DNR rules (strip XFO/CSP, set Sec-Fetch)
                          #        + dynamic registerContentScripts(allFrames)
    content/, page-bridge/  # REUSED unchanged; now also injected into hub iframes
```

### Data flow

```
User opens Hub (action click) → hub.html tab
  ↓ hub renders <iframe src="https://chat.qwen.ai/"> × N  (+ worker iframes carry ?piercode_agent)
background/frame-unlock: DNR strips XFO/CSP + sets Sec-Fetch for extension-initiated AI requests
  ↓ iframes load the real AI sites (unblocked)
registerContentScripts injects page-bridge (MAIN) + content.js (isolated) into each frame
  ↓ content.js runs exactly as in a normal tab: detects piercode-tool, WS → Go server
All frames live in one active Hub tab → none hidden → all stream simultaneously
Worker iframes auto-execute (existing workerAgentId path) — true foreground, no tab-switching
```

### Components (each independently testable)

- **frame-unlock.ts** — pure rule builder `buildFrameUnlockRules(aiHosts, extHostname, uaMajor)` →
  DNR rule array (unit-testable, no chrome.* in the builder); a thin applier
  calls `updateDynamicRules` / `registerContentScripts`. Mirrors Simple Chat
  Hub's `S()`/`l()`/`u()`.
- **pane-manager.ts** — owns the iframe pool: create/lazy-load/keep-resident,
  reorder, remove, map pane → AI host (and worker agent_id). No reload on
  reorder (resident frames), matching ai-gate's "global webview pool".
- **hub/index.tsx** — React grid UI (reuse existing Tailwind setup); pane
  add/remove/reorder, "send to all" composer is **out of scope for v1**
  (YAGNI — PierCode drives sends via tool protocol, not a compare composer).
- **dashboard.ts (P2)** — reads agent/tool/token state already exposed
  (`status-panel`, `/stats`, AgentRegistry via WS) and renders a board.

### What is explicitly NOT in v1 (YAGNI)

- No shared "send one prompt to all panes" composer (that's Simple Chat Hub's
  use case, not PierCode's tool-driven flow).
- No screenshot/long-screenshot, prompt library, theme i18n (Simple Chat Hub
  extras).
- Dashboard is P2 — ship the multi-iframe foreground manager first.

## Error handling / edge cases

- **DNR scope safety**: rules use `initiatorDomains:[extension hostname]` so the
  header strip only affects requests the Hub page makes — a user browsing
  claude.ai normally keeps full XFO/CSP. This is the security-critical
  invariant; assert it in tests.
- **Login**: some sites need a prior normal-tab login (Simple Chat Hub documents
  this; Gemini/passkey caveats). Hub shows a "open in tab to log in" affordance
  when a frame reports unauthenticated.
- **Frame that still refuses** (future site change): pane shows an error state +
  "open as real tab" fallback (degrades to the existing tab flow).
- **Double injection**: keep the static `content_scripts` registration
  top-frame-only (no `all_frames`), so Hub iframes are injected *only* by the
  dynamic `registerContentScripts` — no overlap. Dynamic scripts use distinct
  ids; content.js is already idempotent per frame (`processed`/`isExecuted`,
  `pageBridgeInjected` guard) as a backstop.

## Verification

1. **Unit (vitest)**: `buildFrameUnlockRules` — asserts XFO+CSP removed,
   Sec-Fetch set, `initiatorDomains` is the extension only (never broad),
   resourceTypes include `sub_frame`, Firefox legacy `domains` when uaMajor<101.
2. **Build**: `npm run build` produces `hub.html` + chunks; `npx tsc --noEmit`
   clean; existing `content-build.test.ts` still green (content.js unchanged).
3. **Manual E2E (real Chrome)**: load unpacked, open Hub, embed
   Qwen+Claude+ChatGPT; confirm all render, log in, and stream **simultaneously**
   while the Hub tab is active; confirm a normal claude.ai tab outside the Hub
   still has XFO/CSP intact (DNR scope check).
4. **Worker E2E**: coordinator `spawn_agent` → worker appears as a Hub iframe and
   executes in foreground (no background throttling); result callback arrives
   (ties into the just-fixed agent-result path).
5. **Regression**: existing Chrome-tab flow unaffected — run a tool in a normal
   AI tab; old single-tab behavior identical.

## Reference

Simple Chat Hub unpacked at `/tmp/sch-unpack/ext` — SW `assets/chunk-1a97cdcf.js`
holds the verified DNR (`S`/`l`) + `registerContentScripts` (`u`) logic this
design mirrors. ai-gate / Multi-AI-Wrapper informed the resident-pane UX only
(their Electron embedding is not used).
