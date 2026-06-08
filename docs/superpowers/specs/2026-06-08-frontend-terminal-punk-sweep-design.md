# PierCode Frontend Terminal-Punk Sweep — Design

**Date:** 2026-06-08
**Status:** Approved (design), pending implementation plan
**Scope:** Reskin popup + in-page content cards + corner status panel to terminal-punk; delete the unused hub project canvas; reskin/re-layout the hub after canvas removal. Five surfaces, five commits.

## Goal

Extend the terminal-punk aesthetic established for the sidebar
(`docs/superpowers/specs/2026-06-08-sidebar-terminal-punk-redesign-design.md`) across
the remaining PierCode frontend surfaces, remove dead UI (the hub project canvas the
user no longer uses), and consolidate three overlapping corner indicators into one.
Preserve all business logic; change render layers only (except the canvas, which is
deleted).

## Shared Design Language

One visual language, three implementations (forced by tech boundaries):

```
color:  bg #0a0e0a · panel #0d130d (and #1c1c1e→#0d130d for content) · line #1a2a1a
        dim #5a6a5a · txt #c8d8c8 · glow #39FF14 (green) · amber #FFB000 (risk/running)
font:   IBM Plex Mono — bundled for popup + hub (reuse sidebar/fonts/ woff2);
        content scripts use a `ui-monospace, IBM Plex Mono, Menlo, monospace` stack
        (cannot @font-face an extension-relative woff2 reliably from an injected
        inline style without web_accessible_resources; the system mono stack is fine).
texture: glowing borders, terminal glyphs ◆ ▸ ▌ », status badges [run]/[done]/[fail],
        scanlines only on popup + hub (full HTML pages); content cards stay flat
        (injected into hostile host pages — no full-viewport overlays).
```

### Technical boundaries (why three implementations)

- **Popup / Hub**: real Vite HTML entries with their own CSS. Use a CSS-variable
  token sheet like the sidebar's `theme.css`. Can `@import "tailwindcss"` + `@font-face`.
- **Content scripts** (`content/*.ts`): classic MV3, no Tailwind, build DOM with inline
  `style.cssText` strings. A guard test (`content-build.test.ts`) asserts `content.js`
  has NO top-level `import`/`from`. A new leaf `content/terminal-theme.ts` exporting
  plain color/style constant strings is safe — Vite inlines same-entry modules into
  `content.js` (only lazy `import()` hoisting breaks the guard, which we don't add).

## Surface 1 — Popup (`extension/src/popup/`)

860-line React/Tailwind component, currently gray-950/blue-600/emerald/amber/indigo +
emoji (🔗🗂️💬📁🌐⚡) — the same "AI slop" palette the sidebar shed.

- New `popup/theme.css`: CSS-variable tokens + `@font-face` for IBM Plex Mono
  (reuse `../sidebar/fonts/IBMPlexMono-*.woff2`). `index.css` imports it.
- Replace all gray/blue/emerald/amber/indigo Tailwind color utilities with terminal
  tokens (inline `style` with CSS vars, mirroring the sidebar approach).
- `Section` / `Toggle` / `RiskNote` sub-components restyled: toggle ON = glow,
  `risk` = amber; `RiskNote` danger = red, normal = amber on terminal panel.
- Emoji → terminal glyphs or kept where semantically clearest (decided per-element).
- Quick-launch buttons (多 AI 工作台 / 聊天侧边栏), connect form, status card, browser
  relay card, toast — all to terminal palette.
- **Logic untouched**: all 23 useState + 16 handlers + 2 effects stay; render only.
- Glow color: popup uses the **default green** (does NOT read `sidebarGlow` — decision:
  not shared, keeps popup self-contained).

**Tests:** `popup-advanced-options.test.tsx` (3 JSDOM tests) + `popup-auth.test.ts`
(6 unit tests) must keep passing. Tests assert behavior (collapsed-by-default, stealth
default, numeric thresholds), not classes — restyle is safe.

## Surface 2 — Delete the hub project canvas (`extension/src/hub/`)

The pan/zoom node canvas with agent-tree edges is unused. Delete it cleanly.

**Delete files:**
- `hub/canvas/Canvas.tsx`, `hub/canvas/CanvasNodeCard.tsx`, `hub/canvas/Edges.tsx`,
  `hub/canvas/canvas-math.ts`
- `__tests__/canvas-math.test.ts`, `__tests__/canvas-node-card.test.tsx`

**Edit `hub/App.tsx`:** remove the `Canvas` import, the `freeLayout` state, the
canvas-ops callbacks block (`onMoveNode`/`onSetViewport`/`onResizeNode`/`onContentZoom`/
`onTidy`/`onCloseNode`), the `<Canvas/>` render branch + `canvas-empty` fallback, and the
freeLayout toolbar button + pan hint. Preserve the stop-agent signal that lived in
`onCloseNode` by folding it into the existing `onRemovePane` WS path (which already calls
`removeNode`); when a pane/node is removed, still send `sendAgentControl('stop', agentId)`.

**Simplify `hub/project-store.ts`:** remove `Viewport`, `DEFAULT_VIEWPORT`, geometry
constants (`DEFAULT_NODE_W/H`, `MIN_NODE_W/H`, `NODE_SIZE_PRESETS`, content-zoom consts),
`moveNode`, `resizeNode`, `setContentZoom`, `setViewport`, `layoutTree`,
`applyTreeLayout`. Strip `x/y/w/h/contentZoom/viewport` from `CanvasNode` (→
`{id, providerId, agentId?, parentNodeId?}`) and the viewport field from `Project`.
Keep all CRUD (`createProject`, `addNode`, `addChildNode`, `removeNode`, `deleteProject`,
`findNodeByAgentId`, `migrateLegacyPanes`, `normalizeProjects`).

**Edit `__tests__/project-store.test.ts`:** drop the 6 geometry/layout tests and their
imports; keep the ~12 CRUD tests.

**Dead CSS:** remove canvas-only rules from `hub/index.css`.

## Surface 3 — Consolidate + terminal-style the corner status panel (`extension/src/content/`)

Today there are THREE overlapping bottom-right indicators:
- `status-panel.ts` — the main panel (op state / provider / token / controlled tab),
  wired into `index.ts`. **Keep, restyle to terminal.**
- `token-hud.ts` — a parallel token-only dot, **NOT wired into `index.ts`** (dead).
  **Delete** it + `__tests__/token-hud.test.ts`.
- `visual-indicator.ts` — different responsibility (stop button + pulse border; a mini
  dot only in stealth mode). **Keep**; recolor its stealth dot + pulse to the shared
  glow green so it reads consistent. Do not merge (distinct purpose).

**New leaf `content/terminal-theme.ts`:** export plain string constants for the
terminal palette (e.g. `T_BG`, `T_PANEL`, `T_LINE`, `T_DIM`, `T_TXT`, `T_GLOW`,
`T_AMBER`, `T_RED`, `T_FONT`) plus a few composed `style.cssText` snippet helpers if
useful. Pure constants, no imports of chrome/DOM. Imported by `status-panel.ts`,
`visual-indicator.ts`, and `content/index.ts` (Surface 4).

**`status-panel.ts` restyle:** dot uses glow-tinted op colors; expanded panel
`#1c1c1e`→`T_PANEL` with a glow border, monospace font, terminal token rows, terminal
progress bar; op labels keep Chinese but with glyph prefixes; stealth still hides.

**Tests:** `status-panel.test.ts`, `visual-indicator.test.ts` keep passing (assert
behavior/DOM presence, not exact colors — confirm during implementation; adjust only if
a test pins a specific hex that we change).

## Surface 4 — Terminal-style the in-page content cards (`extension/src/content/index.ts`)

All injected into the AI page via inline `style.cssText`. Recolor to the shared terminal
palette using `content/terminal-theme.ts` constants:
- **Tool card** (`#1e1e2e` Catppuccin → `T_PANEL`): `◆` marker, `[run]/[done]/[fail]`
  state pill, terminal buttons (执行/后台/忽略/插入).
- **Context packet card** (purple accent → glow accent).
- **Compression status card** + **compression confirm card** (bottom-right fixed).
- **Toast**, **inline question / browser-approval panel**, **init button** (blue pill →
  terminal glow pill).
- Keep all positions/anchoring + all handlers/wiring; only swap colors/fonts/glyphs.

## Surface 5 — Hub terminal-punk dashboard + pane layout (`extension/src/hub/`)

After canvas removal, the hub keeps the multi-pane iframe view + the glass dashboard
(OverviewBar / ProjectDrawer / agent-store / hub-ws). Reskin + re-layout:
- New `hub/theme.css` (or fold into existing `index.css`): terminal tokens + IBM Plex
  Mono + faint scanlines.
- Terminal top bar (replaces the canvas toolbar), terminal-styled pane frames in a
  responsive grid, the glass OverviewBar/ProjectDrawer recolored to terminal panels.
- Preserve pane add/remove/WS wiring (`pane-manager`, `hub-ws`, `agent-store`).

## Testing / Acceptance

- `npx tsc --noEmit` clean.
- `npm test` — all suites pass. Delta: delete `canvas-math.test.ts`,
  `canvas-node-card.test.tsx`, `token-hud.test.ts`; trim 6 tests from
  `project-store.test.ts`; keep popup/status-panel/visual-indicator tests green.
- `npm run build` succeeds; `content-build.test.ts` guard passes (no static import
  leaks into `content.js` from `terminal-theme.ts`).
- Manual (human, loads dist/): popup terminal look + all toggles work; canvas gone, hub
  panes + dashboard render terminal-styled; one corner panel (no duplicate dots); in-page
  tool/context/compression/toast/question cards terminal-styled; tool exec still works.

## Commit Plan (one per surface)

1. `feat(popup): terminal-punk redesign`
2. `refactor(hub): remove unused project canvas`
3. `feat(content): unify + terminal-style corner status panel` (incl. delete token-hud)
4. `feat(content): terminal-style in-page cards (tool/context/compression/toast/question/init)`
5. `feat(hub): terminal-punk dashboard + pane layout after canvas removal`

(Surface 3 and 4 both touch `content/terminal-theme.ts`; do Surface 3 first so the leaf
exists, then Surface 4 consumes it.)

## Risks

- **content-build guard:** `terminal-theme.ts` must be plain const exports (no lazy
  import). Re-run the guard after Surfaces 3 & 4.
- **Canvas removal breaking project-store consumers:** the dashboard + pane-manager don't
  import canvas; verify with grep + tsc after deletion. The stop-agent signal must be
  preserved via `onRemovePane`.
- **Test hex pins:** if status-panel/visual-indicator tests assert specific colors,
  update only those assertions to the new palette (don't weaken behavior tests).
- **Hub re-layout scope creep:** keep Surface 5 to reskin + simple responsive pane grid;
  no new hub features.
