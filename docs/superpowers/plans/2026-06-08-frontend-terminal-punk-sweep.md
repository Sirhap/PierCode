# Frontend Terminal-Punk Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the terminal-punk aesthetic to the popup, the in-page content cards, and the corner status panel; delete the unused hub project canvas; reskin + re-layout the hub after canvas removal. Five surfaces → five commits.

**Architecture:** Three implementations of one visual language, dictated by tech boundaries. Popup + Hub are Vite HTML entries with CSS-variable token sheets + bundled IBM Plex Mono (reuse `sidebar/fonts/`). Content scripts are classic MV3 — no Tailwind, DOM built with inline `style.cssText`; a new pure-constant leaf `content/terminal-theme.ts` carries the palette (safe: Vite inlines same-entry modules into `content.js`, only lazy `import()` breaks the `content-build.test.ts` guard, which we don't add). Business logic is preserved everywhere; the canvas is the only deletion.

**Tech Stack:** React 18, TypeScript, Tailwind v4 (popup/hub), Vite, Vitest, MV3.

---

## Shared Terminal Palette (reference for all tasks)

```
--bg #0a0e0a   --panel #0d130d   --panel-2 #0f1810   --line #1a2a1a
--dim #5a6a5a  --txt #c8d8c8     --glow #39FF14       --amber #FFB000   --red #E5484D
font: IBM Plex Mono (popup/hub via @font-face) | "IBM Plex Mono", ui-monospace, Menlo, monospace (content)
glyphs: ◆ ▸ ▌ »   badges: [run] [done] [fail]
```

---

## SURFACE 1 — Popup terminal-punk redesign

### Task 1: popup theme.css + token shell

**Files:**
- Create: `extension/src/popup/theme.css`
- Modify: `extension/src/popup/index.css`
- Modify: `extension/src/popup/index.html`

- [ ] **Step 1: Create `extension/src/popup/theme.css`**

```css
/* Terminal-punk tokens for the popup (mirrors sidebar/theme.css; green only). */
@font-face {
  font-family: 'IBM Plex Mono'; font-weight: 400; font-style: normal; font-display: swap;
  src: url('../sidebar/fonts/IBMPlexMono-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono'; font-weight: 500; font-style: normal; font-display: swap;
  src: url('../sidebar/fonts/IBMPlexMono-Medium.woff2') format('woff2');
}
:root {
  --bg: #0a0e0a; --panel: #0d130d; --panel-2: #0f1810; --line: #1a2a1a;
  --dim: #5a6a5a; --txt: #c8d8c8; --glow: #39FF14; --glow-soft: rgba(57,255,20,.18);
  --amber: #FFB000; --red: #E5484D;
}
html, body { background: var(--bg); color: var(--txt); font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; }
.glow-text { color: var(--glow); text-shadow: 0 0 6px var(--glow-soft); }
.glow-border { border-color: var(--glow); box-shadow: 0 0 0 1px var(--glow-soft), inset 0 0 8px var(--glow-soft); }
@keyframes blink { 0%,49% { opacity: 1 } 50%,100% { opacity: 0 } }
.cursor-blink { animation: blink 1s step-end infinite; }
@keyframes dot-pulse { 0%,100% { opacity:.4; box-shadow:0 0 0 0 var(--glow-soft) } 50% { opacity:1; box-shadow:0 0 6px 1px var(--glow-soft) } }
.dot-live { background: var(--glow); animation: dot-pulse 1.4s ease-in-out infinite; }
```

- [ ] **Step 2: Import theme in `index.css`**

Read `extension/src/popup/index.css` (16 lines: `@import "tailwindcss"` + a `fade-in-down` keyframe). Add `@import "./theme.css";` immediately after the tailwindcss import line. Leave the keyframe.

- [ ] **Step 3: Fix FOUC bg in `index.html`**

Read `extension/src/popup/index.html`. If it has an inline `background:` or `theme-color` using a non-terminal color, change it to `#0a0e0a`. (If none present, skip — note it.)

- [ ] **Step 4: Build to confirm font resolves**

Run from `extension/`: `npm run build` — Expected: succeeds; `dist/assets/` still has the IBM Plex Mono woff2 (shared with sidebar). Run `npx vitest run src/__tests__/content-build.test.ts` — Expected: PASS (popup CSS must not leak into content.js).

- [ ] **Step 5: Commit (partial — full commit at end of Surface 1)**

Do NOT commit yet. Surface 1 is one commit at Task 3. Proceed to Task 2.

### Task 2: Restyle popup sub-components (Toggle / Section / RiskNote)

**Files:** Modify `extension/src/popup/App.tsx` (lines ~120–163).

- [ ] **Step 1: Rewrite `Toggle`**

Replace the `Toggle` function (currently lines ~120–143) with:
```tsx
function Toggle({
  label, checked, onChange, risk = false, desc,
}: {
  label: string; checked: boolean; onChange: (v: boolean) => void; risk?: boolean; desc?: string;
}) {
  const onBg = risk ? 'var(--amber)' : 'var(--glow)'
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span className="text-sm" style={{ color: 'var(--txt)' }}>{label}</span>
        {desc && <div className="text-[11px] leading-snug mt-0.5" style={{ color: 'var(--dim)' }}>{desc}</div>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 mt-0.5"
        style={{ background: checked ? onBg : 'var(--line)' }}
      >
        <span className={`inline-block w-5 h-5 mt-0.5 rounded-full shadow transition-transform duration-200 ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} style={{ background: checked ? '#0a0e0a' : 'var(--dim)' }} />
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Rewrite `Section`**

Replace `Section` (lines ~146–155) with:
```tsx
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--dim)' }}>{title}</div>
      <div className="space-y-3 rounded-sm border p-3" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
        {children}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Rewrite `RiskNote`**

Replace `RiskNote` (lines ~158–163) with:
```tsx
function RiskNote({ tone = 'warn', children }: { tone?: 'warn' | 'danger'; children: ReactNode }) {
  const color = tone === 'danger' ? 'var(--red)' : 'var(--amber)'
  return <div className="rounded-sm border px-3 py-2 text-[11px] leading-snug" style={{ borderColor: color, background: 'rgba(0,0,0,.2)', color }}>{children}</div>
}
```

- [ ] **Step 4: Type-check**

Run from `extension/`: `npx tsc --noEmit` — Expected: no errors. (`ReactNode` is already imported in App.tsx.)

### Task 3: Recolor the popup render body + commit Surface 1

**Files:** Modify `extension/src/popup/App.tsx` (the `return (...)` block, ~lines 519–860).

This is a mechanical color-class swap across the render tree. Apply this MAPPING to every element in the returned JSX (and the `statusColor` const at line ~519):

| Old (Tailwind) | New |
|---|---|
| `bg-gray-950` (root) | `style={{ background: 'var(--bg)', color: 'var(--txt)' }}`, drop `bg-gray-950 text-gray-100` |
| `bg-gray-900` / `bg-gray-900/50` / `bg-gray-800` | `style={{ background: 'var(--panel)' }}` or `'var(--panel-2)'` for inputs |
| `border-gray-800` / `border-gray-700` | `style={{ borderColor: 'var(--line)' }}` |
| `text-white` / `text-gray-100`/`200` | `style={{ color: 'var(--txt)' }}` |
| `text-gray-400`/`500`/`600` | `style={{ color: 'var(--dim)' }}` |
| `bg-blue-600 hover:bg-blue-500` (connect btn) | `glow-border` + `style={{ color: 'var(--glow)' }}` |
| `bg-emerald-400`/status dot connected | `dot-live` class (drop bg) |
| `bg-yellow-400` checking dot | `style={{ background: 'var(--amber)' }}` + keep `animate-pulse` |
| `bg-red-400` disconnected dot | `style={{ background: 'var(--red)' }}` |
| emerald provider pills (`bg-emerald-900/40 border-emerald-700/40 text-emerald-300`) | `style={{ background: 'var(--panel-2)', borderColor: 'var(--line)', color: 'var(--glow)' }}` |
| indigo quick-launch (`border-indigo-700 bg-indigo-900/40 text-indigo-100`) | `style={{ borderColor: 'var(--line)', background: 'var(--panel-2)', color: 'var(--txt)' }}` |
| emerald quick-launch (`border-emerald-700 bg-emerald-900/40 text-emerald-100`) | same terminal panel style |
| `text-amber-300` (running tasks) | `style={{ color: 'var(--amber)' }}` |
| `text-red-300` (relay error) | `style={{ color: 'var(--red)' }}` |
| indigo stealth info box (`border-indigo-500/30 bg-indigo-500/10 text-indigo-100`) | `style={{ borderColor: 'var(--line)', background: 'var(--panel-2)', color: 'var(--txt)' }}` |
| toast `bg-emerald-600`/`bg-red-600` | `style={{ background: type==='success' ? 'var(--glow)' : 'var(--red)', color: '#0a0e0a' }}` |

Also: emoji `🔗` (header, line ~527) → `⌁` wrapped in `glow-text`; `🗂️`/`💬` quick-launch icons may stay (semantic) or become `▸`; `📁`/`🌐`/`⚡` in the status card → keep (semantic data labels). `PierCode` title → add `glow-text`.

`statusColor` const (line ~519): change from class string to a hex/var the dot consumes via `style`. Replace:
```tsx
const statusColor = status === 'connected' ? 'bg-emerald-400' : status === 'checking' ? 'bg-yellow-400' : 'bg-red-400'
```
with:
```tsx
const statusDotStyle = status === 'connected'
  ? undefined  // use dot-live class
  : { background: status === 'checking' ? 'var(--amber)' : 'var(--red)' }
```
and at the header dot (line ~532) render:
```tsx
<span className={`w-2 h-2 rounded-full ${status === 'connected' ? 'dot-live' : ''} ${status === 'checking' ? 'animate-pulse' : ''}`} style={statusDotStyle} />
```

- [ ] **Step 1: Apply the mapping across the return body**

Work through the returned JSX (lines ~522–858) replacing every Tailwind color/border/bg class per the table. Keep ALL layout classes (flex, gap, padding, rounded sizing, w-72, etc.) and ALL handlers/props/conditionals unchanged. Use inline `style` with CSS vars (matching the sidebar's established pattern). For inputs (password/number), use `background: 'var(--panel-2)'`, `borderColor: 'var(--line)'`, `color: 'var(--txt)'`, add `outline: none` via existing classes.

- [ ] **Step 2: Type-check**

Run from `extension/`: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 3: Run popup tests**

Run from `extension/`: `npx vitest run src/__tests__/popup-advanced-options.test.tsx src/__tests__/popup-auth.test.ts` — Expected: all 9 PASS. These assert behavior (collapsed-by-default, stealth default, numeric thresholds, normalizeAuthUrl), not colors. If a test pins a removed class, the test is wrong to pin styling — but FIRST verify it's actually a styling pin and not a behavior assertion; if behavior, your reskin broke something — fix the reskin, not the test.

- [ ] **Step 4: Build**

Run from `extension/`: `npm run build` — Expected: succeeds.

- [ ] **Step 5: Commit Surface 1**

```bash
git add extension/src/popup/theme.css extension/src/popup/index.css extension/src/popup/index.html extension/src/popup/App.tsx
git commit -m "feat(popup): terminal-punk redesign"
```

---

## SURFACE 2 — Delete the hub project canvas (+ keep hub building)

### Task 4: Delete canvas files + their tests

**Files:** Delete 4 source + 2 test files.

- [ ] **Step 1: Delete the canvas module + tests**

```bash
git rm extension/src/hub/canvas/Canvas.tsx extension/src/hub/canvas/CanvasNodeCard.tsx extension/src/hub/canvas/Edges.tsx extension/src/hub/canvas/canvas-math.ts
git rm extension/src/__tests__/canvas-math.test.ts extension/src/__tests__/canvas-node-card.test.tsx
```
(Do NOT commit yet — Surface 2 is one commit after the App.tsx + project-store edits compile.)

### Task 5: Simplify project-store.ts (strip canvas geometry)

**Files:** Modify `extension/src/hub/project-store.ts`, `extension/src/__tests__/project-store.test.ts`.

- [ ] **Step 1: Read project-store.ts fully** to see exact symbols/lines.

- [ ] **Step 2: Remove canvas-only exports**

Delete from `project-store.ts`: the `Viewport` interface, `DEFAULT_VIEWPORT`, geometry/zoom constants (`DEFAULT_NODE_W`, `DEFAULT_NODE_H`, `MIN_NODE_W`, `MIN_NODE_H`, `NODE_SIZE_PRESETS`, `DEFAULT_CONTENT_ZOOM`, `MIN_CONTENT_ZOOM`, `MAX_CONTENT_ZOOM`, and tree-gap consts `TREE_H_GAP`/`TREE_V_GAP`, `CHILD_DROP_Y`/`CHILD_SPREAD_X` if present), and the functions `moveNode`, `resizeNode`, `setContentZoom`, `setViewport`, `layoutTree`, `applyTreeLayout`. Strip the `x`, `y`, `w`, `h`, `contentZoom` fields from the `CanvasNode` interface and the `viewport` field from `Project`. KEEP: `CanvasNode` (now `{ id, providerId, agentId?, parentNodeId? }` plus any non-geometry fields already there), `Project` (id/name/createdAt/nodes), and ALL CRUD: `createProject`, `addNode`, `addChildNode`, `removeNode`, `deleteProject`, `findNodeByAgentId`, `migrateLegacyPanes`, `normalizeProjects`, and the storage save/load helpers.

CAUTION: `addNode`/`addChildNode` may currently set `x/y/w/h` defaults on new nodes. Remove those field assignments too (they no longer exist on the type). `normalizeProjects`/`migrateLegacyPanes` may reference geometry — strip those references so they only normalize id/provider/parent fields.

- [ ] **Step 3: Trim project-store.test.ts**

Read `extension/src/__tests__/project-store.test.ts`. Remove the imports of the deleted symbols (`moveNode`, `resizeNode`, `setContentZoom`, `layoutTree`, `applyTreeLayout`, `MIN_NODE_W`, `MIN_NODE_H`, etc.) and DELETE the test cases that exercise them (the ~6 geometry/layout tests). Keep the CRUD tests. If a CRUD test asserts an `x`/`y` field on a created node, remove just that assertion (the field is gone), keeping the rest of the test.

- [ ] **Step 4: Type-check (expect hub/App.tsx errors — fixed in Task 6)**

Run from `extension/`: `npx tsc --noEmit` — Expected: errors ONLY in `hub/App.tsx` (it still imports the removed symbols + renders `<Canvas>`). project-store.ts and project-store.test.ts must be error-free on their own. Task 6 fixes App.tsx. (If errors appear in pane-manager/dashboard, STOP and report — those should not depend on canvas geometry.)

### Task 6: Rewire hub/App.tsx — remove canvas, add a minimal terminal pane grid

**Files:** Modify `extension/src/hub/App.tsx`, `extension/src/hub/index.css`.

Deleting `<Canvas>` removes the ONLY pane renderer (Canvas rendered the iframes per node). To keep the hub functional in THIS commit, replace it with a minimal pane grid (Surface 5 polishes it). The grid renders one iframe per node of the active project.

- [ ] **Step 1: Fix imports (lines 3–20)**

Change the `project-store` import to drop removed symbols — keep only:
```tsx
import {
  Project,
  createProject,
  deleteProject,
  addNode,
  addChildNode,
  removeNode,
  findNodeByAgentId,
  migrateLegacyPanes,
  normalizeProjects,
} from './project-store';
```
DELETE line 20 `import Canvas from './canvas/Canvas';`. Add the pane-src helpers from pane-manager. CONFIRMED API: `paneSrc(pane: Pane): string` where `Pane = { key: string; providerId: string; agentId?: string }`, and `PROVIDERS_BY_ID: Record<string, AIProvider>` is exported. Update line 2 import to: `import { PROVIDERS, PROVIDERS_BY_ID, providerIdForPlatform, paneSrc, type Pane } from './pane-manager';`

- [ ] **Step 2: Remove canvas state + callbacks**

Delete line 69 `const [freeLayout, setFreeLayout] = useState(false);`. Delete the entire `// ── canvas ops ──` block (lines ~185–226): `onMoveNode`, `onSetViewport`, `onResizeNode`, `onContentZoom`, `onTidy`, `onCloseNode`, and `focusAgent` (the canvas-focus dispatcher). Keep `addAi`, `stopAgent`, `retryAgent`, `removeProject`, `newProject`.

- [ ] **Step 3: Preserve the stop-agent signal on pane removal**

The deleted `onCloseNode` sent `sendAgentControl('stop', agentId)` before `removeNode`. Add a `closeNode` handler that does the same, used by the new grid's close button:
```tsx
const closeNode = useCallback((nodeId: string) => {
  const projectId = activeIdRef.current;
  if (!projectId) return;
  setProjects(prev => {
    const node = prev.find(p => p.id === projectId)?.nodes.find(n => n.id === nodeId);
    if (node?.agentId) wsRef.current?.sendAgentControl('stop', node.agentId);
    return removeNode(prev, projectId, nodeId);
  });
}, []);
```
(The WS `onRemovePane` path at lines 131–136 already handles server-initiated removal — leave it. This `closeNode` is the user-initiated close, replacing onCloseNode.)

For `focusAgent` (drawer → canvas focus): the canvas is gone, so focusing a node has no target. Replace the drawer's `onFocusAgent` with a no-op that's harmless, OR (preferred) scroll the matching pane into view:
```tsx
const focusAgent = (agentId: string) => {
  const loc = findNodeByAgentId(projectsRef.current, agentId);
  if (loc) document.getElementById(`pane-${loc.nodeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
```

- [ ] **Step 4: Replace toolbar canvas buttons (lines ~256–270)**

Remove the `hub-toolbar-sep`, the freeLayout toggle button (lines 258–268), and the `空格+拖动=平移画布` hint (line 269). Keep the `+ AI` label + provider add buttons (lines 252–255).

- [ ] **Step 5: Replace the `<Canvas>` render with a pane grid (lines ~272–296)**

Replace the `<div className="hub-body">` block with:
```tsx
<div className="hub-body">
  {active && active.nodes.length > 0 ? (
    <div className="hub-pane-grid">
      {active.nodes.map(n => {
        const pane: Pane = { key: n.id, providerId: n.providerId, agentId: n.agentId };
        return (
          <div key={n.id} id={`pane-${n.id}`} className="hub-pane">
            <div className="hub-pane-bar">
              <span className="hub-pane-title">{PROVIDERS_BY_ID[n.providerId]?.label ?? n.providerId}{n.agentId ? ` · @${n.agentId.slice(0, 6)}` : ''}</span>
              <button className="hub-pane-close" onClick={() => closeNode(n.id)} title="关闭并停止 agent">✕</button>
            </div>
            <iframe className="hub-pane-frame" src={paneSrc(pane)} title={n.id} />
          </div>
        );
      })}
    </div>
  ) : (
    <div className="canvas-empty">用「+ AI」添加一个 AI 面板</div>
  )}
  <ProjectDrawer
    open={drawerOpen}
    agents={drawerAgents}
    onClose={() => setDrawerOpen(false)}
    onFocusAgent={focusAgent}
    onStop={stopAgent}
    onRetry={retryAgent}
  />
</div>
```
NOTE: `paneSrc` takes a `Pane` object (`{key, providerId, agentId?}`), confirmed in pane-manager.ts — the `pane` adapter above constructs it from the node. `PROVIDERS_BY_ID[providerId]` gives the provider label.

- [ ] **Step 6: Add minimal grid CSS to `hub/index.css`**

Read `hub/index.css`, remove canvas-only rules (anything referencing `.canvas-`, viewport transform, node drag, `.hub-toolbar-sep`, `.hub-toolbar-hint`, freeLayout `[data-active]`). Add:
```css
.hub-pane-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 10px; padding: 10px; height: 100%; overflow-y: auto; align-content: start; }
.hub-pane { display: flex; flex-direction: column; border: 1px solid var(--line, #1a2a1a); border-radius: 4px; background: var(--panel, #0d130d); min-height: 420px; overflow: hidden; }
.hub-pane-bar { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; border-bottom: 1px solid var(--line, #1a2a1a); font-size: 11px; color: var(--dim, #5a6a5a); font-family: 'IBM Plex Mono', ui-monospace, monospace; }
.hub-pane-title { color: var(--glow, #39FF14); }
.hub-pane-close { background: none; border: none; color: var(--dim, #5a6a5a); cursor: pointer; }
.hub-pane-close:hover { color: var(--glow, #39FF14); }
.hub-pane-frame { flex: 1; width: 100%; border: 0; background: #fff; }
```
(Surface 5 adds the full theme tokens; these fallbacks keep it working now.)

- [ ] **Step 7: Type-check + tests + build**

Run from `extension/`:
```bash
npx tsc --noEmit
npx vitest run src/__tests__/project-store.test.ts src/__tests__/pane-manager.test.ts
npm run build
```
Expected: tsc clean, those tests PASS, build succeeds. Run full `npm test` to confirm no dangling references to deleted canvas tests: `npm test 2>&1 | tail -6` — all green (the deleted test files are gone, so no failures).

- [ ] **Step 8: Commit Surface 2**

```bash
git add extension/src/hub/App.tsx extension/src/hub/project-store.ts extension/src/hub/index.css extension/src/__tests__/project-store.test.ts
git commit -m "refactor(hub): remove unused project canvas; minimal pane grid"
```
(The `git rm`'d files from Task 4 are already staged for deletion and get included.)

---

## SURFACE 3 — Terminal-theme leaf + corner status panel (delete token-hud)

### Task 7: Create content/terminal-theme.ts + delete token-hud

**Files:** Create `extension/src/content/terminal-theme.ts`; delete `token-hud.ts` + its test.

- [ ] **Step 1: Create the palette leaf**

Create `extension/src/content/terminal-theme.ts`:
```ts
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
```

- [ ] **Step 2: Delete token-hud + its test**

```bash
git rm extension/src/content/token-hud.ts extension/src/__tests__/token-hud.test.ts
```
First confirm `token-hud` is unreferenced: `grep -rn "token-hud\|tokenHud" extension/src/ --include=*.ts --include=*.tsx | grep -v "__tests__/token-hud"`. Expected: NO matches in non-test source (the investigation found it's not wired into index.ts). If there IS a reference, STOP and report — don't delete a live module.

- [ ] **Step 3: Build guard check (commit at Task 8)**

Run from `extension/`: `npx tsc --noEmit` — Expected: clean (token-hud deletion breaks nothing). Do NOT commit yet — Surface 3 commits after Task 8.

### Task 8: Terminal-style status-panel.ts + visual-indicator dot

**Files:** Modify `extension/src/content/status-panel.ts`, `extension/src/content/visual-indicator.ts`.

- [ ] **Step 1: Read status-panel.ts fully** (244 lines).

- [ ] **Step 2: Restyle status-panel.ts**

Import the palette: add at top `import { T_PANEL, T_LINE, T_DIM, T_TXT, T_GLOW, T_GLOW_SOFT, T_AMBER, T_RED, T_FONT } from './terminal-theme'`.
Apply:
- Expanded panel container `cssText`: change `background:#1c1c1e;color:#f2f2f7` → `background:${T_PANEL};color:${T_TXT}`; add `border:1px solid ${T_LINE};box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 4px 16px rgba(0,0,0,.5)`; set `font-family:${T_FONT}`.
- `OP_COLORS` map: idle `#8E8E93`→`${T_DIM}`, thinking `#0A84FF`→`${T_GLOW}` (or keep a blue if preferred — use `${T_GLOW}` for terminal consistency), executing `#F5A623`→`${T_AMBER}`, done `#30A46C`→`${T_GLOW}`, error `#E5484D`→`${T_RED}`.
- The dot: keep size; color from OP_COLORS (now terminal); when op==='executing' or 'thinking', the existing pulse stays.
- Header "PierCode 状态": prefix with `⌁ ` and color `${T_GLOW}`.
- Token rows / labels: text `${T_TXT}`, dim labels `${T_DIM}`.
- Progress bar track `${T_LINE}`, fill `${T_GLOW}` (or amber/red by ratio if the code already branches — keep the branch, swap hexes to T_AMBER/T_RED/T_GLOW).
- Controlled-tab section border/text → `${T_LINE}`/`${T_DIM}`.
Keep ALL behavior: storage key, click-toggle, click-outside-collapse, stealth hide, the public API (`init`/`configure`/`setOpState`/`setProvider`/`setMeter`/`setControlledTab`/`destroy`).

- [ ] **Step 3: Recolor visual-indicator.ts stealth dot + pulse**

Read `extension/src/content/visual-indicator.ts`. In the stealth mini-dot + its keyframes, change the green hexes to the shared glow: loading/pulse `#4ade80`→`#39FF14`, done `#4CAF50`→`#39FF14`, error `#f44336`→`#E5484D` (or `import { T_GLOW, T_RED } from './terminal-theme'` and use those). Keep the full-viewport pulse border green→`#39FF14` for consistency. Do NOT change behavior (stop button, STOP_BROWSER_OPERATION message, slide animations). The shadow-DOM `<style>` keyframe colors can stay or update to glow — update the dot colors at minimum.

- [ ] **Step 4: Type-check + tests + build**

Run from `extension/`:
```bash
npx tsc --noEmit
npx vitest run src/__tests__/status-panel.test.ts src/__tests__/visual-indicator.test.ts src/__tests__/content-build.test.ts
npm run build
```
Expected: tsc clean; status-panel + visual-indicator tests PASS (if either pins an old hex, update ONLY that color assertion to the new value — confirm it's a color pin, not a behavior check); content-build guard PASS (terminal-theme.ts must not leak a static import into content.js).

- [ ] **Step 5: Commit Surface 3**

```bash
git add extension/src/content/terminal-theme.ts extension/src/content/status-panel.ts extension/src/content/visual-indicator.ts
git commit -m "feat(content): unify + terminal-style corner status panel"
```
(The `git rm`'d token-hud files are staged and included.)

---

## SURFACE 4 — Terminal-style in-page content cards

### Task 9: Recolor the injected cards in content/index.ts

**Files:** Modify `extension/src/content/index.ts`.

All these cards build DOM with inline `style.cssText`. Import the palette and swap colors. The cards (from investigation): tool card (~1806–2121), context packet card (~2125–2228), compression status card (~3166–3218), compression confirm card (~3222–3253), toast (~3255–3261), inline question/approval panel (~1052–1151), init button (~3059–3065). Line numbers are approximate — locate each by its distinctive strings.

- [ ] **Step 1: Import the palette into index.ts**

Add to the import block: `import { T_BG, T_PANEL, T_PANEL2, T_LINE, T_DIM, T_TXT, T_GLOW, T_GLOW_SOFT, T_AMBER, T_RED, T_FONT } from './terminal-theme'`.

- [ ] **Step 2: Recolor the tool card**

Find the tool-card builder (search for the Catppuccin `#1e1e2e` background and `piercode-tool` card construction). Swap: card bg `#1e1e2e`→`${T_PANEL}`; borders → `${T_LINE}`; accent/header → `${T_GLOW}`; the state pill: pending/running → `${T_AMBER}` with text `[run]`, done → `${T_GLOW}` `[done]`, error → `${T_RED}` `[fail]` (match the existing state branches — keep the logic, change label text + color). Tool-name badge prefix with `◆`. Buttons (执行/后台执行/忽略/插入): border `${T_LINE}`, the primary 执行 → glow border + `${T_GLOW}` text; font-family `${T_FONT}`. Keep ALL onclick handlers + ids + state transitions.

- [ ] **Step 3: Recolor the remaining cards**

Apply the same palette to: context packet card (purple `#cba6f7` accent → `${T_GLOW}`; bg → `${T_PANEL}`), compression status card + confirm card (bg → `${T_PANEL}`, border → `${T_LINE}`, accent → `${T_GLOW}`, cancel/skip buttons terminal-styled), toast (bg → `${T_PANEL}`, text → `${T_GLOW}` for success / `${T_RED}` for error), inline question/approval panel (`#1e293b` → `${T_PANEL}`, inputs `${T_PANEL2}`, option buttons `${T_LINE}` border, submit → glow), init button (blue pill `#1677ff` → `background:${T_PANEL};color:${T_GLOW};border:1px solid ${T_GLOW}` glow pill, keep `🔗`→`⌁` or keep label). Set `font-family:${T_FONT}` on each card root. Keep ALL positions, anchoring, handlers, ids.

- [ ] **Step 4: Type-check + tests + build**

Run from `extension/`:
```bash
npx tsc --noEmit
npm test 2>&1 | tail -6
npm run build
npx vitest run src/__tests__/content-build.test.ts
```
Expected: tsc clean; full suite green; build OK; content-build guard PASS.

- [ ] **Step 5: Commit Surface 4**

```bash
git add extension/src/content/index.ts
git commit -m "feat(content): terminal-style in-page cards (tool/context/compression/toast/question/init)"
```

---

## SURFACE 5 — Hub terminal-punk dashboard + pane polish

### Task 10: Hub theme + dashboard restyle

**Files:** Modify `extension/src/hub/index.css`, `extension/src/hub/index.html`, `extension/src/hub/dashboard/OverviewBar.tsx`, `extension/src/hub/dashboard/ProjectDrawer.tsx`, `extension/src/hub/App.tsx` (toolbar/top-bar classes only).

- [ ] **Step 1: Add terminal tokens to hub/index.css**

At the top of `hub/index.css`, add the token block + font (mirror popup theme.css):
```css
@font-face { font-family: 'IBM Plex Mono'; font-weight: 400; font-display: swap; src: url('../sidebar/fonts/IBMPlexMono-Regular.woff2') format('woff2'); }
@font-face { font-family: 'IBM Plex Mono'; font-weight: 500; font-display: swap; src: url('../sidebar/fonts/IBMPlexMono-Medium.woff2') format('woff2'); }
:root { --bg:#0a0e0a; --panel:#0d130d; --panel-2:#0f1810; --line:#1a2a1a; --dim:#5a6a5a; --txt:#c8d8c8; --glow:#39FF14; --glow-soft:rgba(57,255,20,.18); --amber:#FFB000; --red:#E5484D; }
.hub-root { background: var(--bg); color: var(--txt); font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; }
```
Then update existing `.hub-root`, `.hub-toolbar`, `.hub-add-btn`, `.hub-body`, `.canvas-empty` rules to terminal palette (use the vars; replace any prior gray/blue/glass hexes). `.hub-add-btn` → border `var(--line)`, bg `var(--panel-2)`, text `var(--dim)`, hover/active → `var(--glow)` + glow box-shadow. The `.hub-pane*` rules from Surface 2 already use the var fallbacks — they now pick up the real vars; you may drop the fallbacks.

- [ ] **Step 2: Fix hub/index.html FOUC bg** to `#0a0e0a` (read it; change any non-terminal inline bg/theme-color).

- [ ] **Step 3: Restyle OverviewBar.tsx**

Read `dashboard/OverviewBar.tsx` (73 lines). Replace its glass/gray/color classes (or inline styles) with terminal palette: bar bg `var(--panel)`, border-bottom `var(--line)`, KPI numbers `glow` color, project tabs → active tab glow underline (like sidebar platform rail), connection dot `dot-live` when connected. Keep all props/handlers (`onSelectProject`/`onNewProject`/`onDeleteProject`/`onToggleDrawer`). If it uses Tailwind classes, swap colors; if inline styles, swap hexes to `var(--...)`. Add a `.dot-live` keyframe to hub/index.css if referenced (copy from popup theme.css).

- [ ] **Step 4: Restyle ProjectDrawer.tsx**

Read `dashboard/ProjectDrawer.tsx` (74 lines). Same treatment: drawer panel bg `var(--panel)`, border `var(--line)`, agent rows terminal-styled, status marks use glow/amber/red, action buttons (focus/stop/retry) terminal-styled. Keep all props/handlers.

- [ ] **Step 5: Tidy App.tsx top bar classes** (no logic): ensure the toolbar wrapper uses the terminal `.hub-toolbar` (already restyled in CSS); the `+ AI` label `.hub-toolbar-label` → glow color via CSS. No JSX logic changes.

- [ ] **Step 6: Type-check + tests + build**

Run from `extension/`:
```bash
npx tsc --noEmit
npm test 2>&1 | tail -6
npm run build
```
Expected: tsc clean; full suite green; build succeeds; `dist/hub.html` present.

- [ ] **Step 7: Commit Surface 5**

```bash
git add extension/src/hub/index.css extension/src/hub/index.html extension/src/hub/App.tsx extension/src/hub/dashboard/OverviewBar.tsx extension/src/hub/dashboard/ProjectDrawer.tsx
git commit -m "feat(hub): terminal-punk dashboard + pane layout after canvas removal"
```

---

## Final verification (after all 5 surfaces)

- [ ] Run from `extension/`: `npx tsc --noEmit && npm test 2>&1 | tail -8 && npm run build 2>&1 | tail -3`. All green. Confirm dist has popup.html, hub.html, sidebar.html, content.js, and the woff2 in dist/assets.
- [ ] `npx vitest run src/__tests__/content-build.test.ts` — guard green (terminal-theme.ts didn't leak into content.js).
- [ ] Manual (human, loads dist/): popup terminal look + every toggle/connect works; canvas gone; hub shows terminal pane grid + dashboard; ONE corner panel (no duplicate dots); in-page tool/context/compression/toast/question cards terminal-styled; tool execution still works end-to-end.

---

## Self-Review Notes (completed during planning)

- **Spec coverage:** popup (T1-3), canvas delete (T4-6), corner panel + token-hud delete (T7-8), in-page cards (T9), hub dashboard/layout (T10). All 5 surfaces + 5 commits mapped.
- **Coupling caught:** deleting Canvas removes the pane renderer → T6 adds a minimal pane grid so each commit builds; T10 polishes. Stop-agent signal preserved via `closeNode`/`onRemovePane`.
- **Guard risk:** terminal-theme.ts is pure const exports; content-build guard re-checked in T8 & T9.
- **Test deltas explicit:** delete canvas-math/canvas-node-card/token-hud tests; trim project-store geometry tests; keep + verify popup/status-panel/visual-indicator/pane-manager tests; only update color-pin assertions, never behavior assertions.
- **Placeholder scan:** every code step shows code or an exact mapping table; line numbers flagged approximate with "locate by string" guidance where the file is large.
- **API verified:** `paneSrc(pane: Pane): string` + `PROVIDERS_BY_ID` confirmed in pane-manager.ts; T6 uses a `Pane` adapter built from the node.
```
