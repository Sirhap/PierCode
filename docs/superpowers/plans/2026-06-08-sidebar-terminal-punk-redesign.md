# Sidebar Terminal-Punk Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the PierCode chat sidebar (`extension/src/sidebar/`) to a dark CRT terminal-punk aesthetic, restructure its layout, and add five features (command palette, message search, message pin, worker radar, status HUD) plus a switchable phosphor glow color — all without altering the existing fetch/WS/stream/exec/session business logic.

**Architecture:** The sidebar is a standalone Vite HTML entry (`src/sidebar/index.html` → `dist/sidebar.html`, loaded by MV3 `side_panel`). All business logic lives in `App.tsx` (1248 lines). This plan extracts the render layer (message view, tool card, sub-agent) into focused files, adds new presentational components fed by existing state (`messages`, `subAgents`, `connected`, token counts), introduces a CSS-variable design-token system in a new `theme.css`, and threads a single new `pinned?: boolean` field through `ChatMessage`/`StoredSession`. New state added to `App.tsx`: palette open/mode, search query. The font (IBM Plex Mono) is bundled locally as woff2 (CSP forbids external font CDNs); CSS `url()` references resolve through the sidebar HTML entry's asset pipeline.

**Tech Stack:** React 18, TypeScript, Tailwind CSS v4 (`@import "tailwindcss"`), Vite, Vitest. Chrome extension MV3 (`chrome.storage.local`).

---

## File Structure

```
new:
  src/sidebar/theme.css            design tokens (CSS vars) + scanline/grain/glow/boot keyframes + @font-face
  src/sidebar/use-glow.ts          glow-color hook: read/write storage, apply data-glow attr
  src/sidebar/glow.ts              pure helpers (GLOW_COLORS list, normalizeGlow) — unit-testable, no chrome
  src/sidebar/ToolCard.tsx         tool card render, extracted from App.tsx (terminal restyle)
  src/sidebar/MessageView.tsx      message render (was MessageBubble) + ThinkingBlock + helpers, extracted
  src/sidebar/WorkerRadar.tsx      sub-agent status chips bar (consumes subAgents)
  src/sidebar/StatusHUD.tsx        bottom status bar (connection / root / token bar / active-agent count)
  src/sidebar/CommandPalette.tsx   Cmd/Ctrl+K overlay; command mode + search mode
  src/sidebar/commands.ts          pure command-list builder + fuzzy filter (unit-testable, no React)
  src/sidebar/fonts/               IBMPlexMono-Regular.woff2, IBMPlexMono-Medium.woff2 (downloaded)
  src/__tests__/sidebar-glow.test.ts        unit tests for glow.ts
  src/__tests__/sidebar-commands.test.ts    unit tests for commands.ts
change:
  src/sidebar/App.tsx              new layout skeleton; import extracted components; add pinned/palette/search state + handlers
  src/sidebar/index.css            import './theme.css'; recolor scrollbar + .msg-content markdown to terminal palette
  src/sidebar/index.html           FOUC background → #0a0e0a
  src/sidebar/session-store.ts     persist `pinned` on StoredMessage
  src/__tests__/sidebar-session-store.test.ts   extend to cover pinned round-trip
```

**Responsibility boundaries:**
- `theme.css` owns ALL visual tokens + texture/animation. No component hardcodes hex colors that belong to the palette; use `var(--glow)` etc. (Tailwind utility classes that map to gray are replaced by token-based classes defined in theme.css or inline `style`.)
- `glow.ts` / `commands.ts` are pure (no `chrome`, no React) so they're unit-testable in vitest without mocks.
- `use-glow.ts` is the only glow code touching `chrome.storage`.
- `App.tsx` keeps ALL effects (WS listener, persistence, model fetch) and handlers; it only gains presentational state and passes props down.

---

## Task 1: Bundle IBM Plex Mono font

**Files:**
- Create: `extension/src/sidebar/fonts/IBMPlexMono-Regular.woff2`
- Create: `extension/src/sidebar/fonts/IBMPlexMono-Medium.woff2`

- [ ] **Step 1: Download the two woff2 weights**

Run from `extension/`:
```bash
mkdir -p src/sidebar/fonts
curl -fSL -o src/sidebar/fonts/IBMPlexMono-Regular.woff2 \
  https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-mono@latest/latin-400-normal.woff2
curl -fSL -o src/sidebar/fonts/IBMPlexMono-Medium.woff2 \
  https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-mono@latest/latin-500-normal.woff2
```
Expected: two files created, each non-empty.

- [ ] **Step 2: Verify the files are real woff2 (not an HTML error page)**

Run:
```bash
file src/sidebar/fonts/*.woff2 && ls -l src/sidebar/fonts/*.woff2
```
Expected: `file` reports "Web Open Font Format (Version 2)"; both sizes > 20 KB. If `file` says HTML/ASCII, the CDN path changed — find a working IBM Plex Mono woff2 URL (e.g. from `https://www.fontsource.org/fonts/ibm-plex-mono`) and re-download before proceeding.

- [ ] **Step 3: Commit**

```bash
git add extension/src/sidebar/fonts/
git commit -m "feat(sidebar): bundle IBM Plex Mono woff2 for terminal theme"
```

---

## Task 2: Glow helpers (pure) + tests

**Files:**
- Create: `extension/src/sidebar/glow.ts`
- Test: `extension/src/__tests__/sidebar-glow.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/src/__tests__/sidebar-glow.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { GLOW_COLORS, isGlow, normalizeGlow, type Glow } from '../sidebar/glow'

describe('glow helpers', () => {
  it('lists exactly the four supported glow colors', () => {
    expect(GLOW_COLORS.map(g => g.key)).toEqual(['green', 'amber', 'cyan', 'magenta'])
  })

  it('isGlow accepts valid keys and rejects others', () => {
    expect(isGlow('green')).toBe(true)
    expect(isGlow('magenta')).toBe(true)
    expect(isGlow('purple')).toBe(false)
    expect(isGlow(undefined)).toBe(false)
    expect(isGlow(42)).toBe(false)
  })

  it('normalizeGlow falls back to green for invalid input', () => {
    expect(normalizeGlow('cyan')).toBe<Glow>('cyan')
    expect(normalizeGlow('nope')).toBe<Glow>('green')
    expect(normalizeGlow(null)).toBe<Glow>('green')
  })

  it('every glow color has a hex swatch for the picker UI', () => {
    for (const g of GLOW_COLORS) {
      expect(g.hex).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `extension/`:
```bash
npx vitest run src/__tests__/sidebar-glow.test.ts
```
Expected: FAIL — cannot resolve module `../sidebar/glow`.

- [ ] **Step 3: Write the implementation**

Create `extension/src/sidebar/glow.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/__tests__/sidebar-glow.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/sidebar/glow.ts extension/src/__tests__/sidebar-glow.test.ts
git commit -m "feat(sidebar): pure glow-color helpers + tests"
```

---

## Task 3: use-glow hook

**Files:**
- Create: `extension/src/sidebar/use-glow.ts`

(No unit test: this hook only wires `chrome.storage` + a DOM attribute; jsdom + chrome-mock would test the mock, not behavior. It's verified manually in Task 12. Logic worth testing already lives in `glow.ts`.)

- [ ] **Step 1: Write the hook**

Create `extension/src/sidebar/use-glow.ts`:
```ts
import { useEffect, useState, useCallback } from 'react'
import { type Glow, normalizeGlow, DEFAULT_GLOW, GLOW_STORAGE_KEY } from './glow'

// Reads the saved glow color, applies it to <html data-glow="...">, and returns
// a setter that persists + re-applies. theme.css keys all --glow off that attr.
export function useGlow(): [Glow, (g: Glow) => void] {
  const [glow, setGlowState] = useState<Glow>(DEFAULT_GLOW)

  useEffect(() => {
    chrome.storage.local.get([GLOW_STORAGE_KEY], (res) => {
      const g = normalizeGlow(res[GLOW_STORAGE_KEY])
      setGlowState(g)
      document.documentElement.setAttribute('data-glow', g)
    })
  }, [])

  const setGlow = useCallback((g: Glow) => {
    setGlowState(g)
    document.documentElement.setAttribute('data-glow', g)
    chrome.storage.local.set({ [GLOW_STORAGE_KEY]: g })
  }, [])

  return [glow, setGlow]
}
```

- [ ] **Step 2: Type-check**

Run from `extension/`:
```bash
npx tsc --noEmit
```
Expected: no new errors from `use-glow.ts`. (Pre-existing errors elsewhere, if any, are out of scope — but there should be none introduced by this file.)

- [ ] **Step 3: Commit**

```bash
git add extension/src/sidebar/use-glow.ts
git commit -m "feat(sidebar): useGlow hook (storage + data-glow attr)"
```

---

## Task 4: theme.css — design tokens, texture, animations, font

**Files:**
- Create: `extension/src/sidebar/theme.css`
- Modify: `extension/src/sidebar/index.css`
- Modify: `extension/src/sidebar/index.html:10`

- [ ] **Step 1: Create the theme stylesheet**

Create `extension/src/sidebar/theme.css`:
```css
/* Terminal-punk design tokens for the PierCode sidebar.
   --glow switches via [data-glow="..."] set by use-glow.ts. */

@font-face {
  font-family: 'IBM Plex Mono';
  font-weight: 400;
  font-style: normal;
  font-display: swap;
  src: url('./fonts/IBMPlexMono-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono';
  font-weight: 500;
  font-style: normal;
  font-display: swap;
  src: url('./fonts/IBMPlexMono-Medium.woff2') format('woff2');
}

:root {
  --bg: #0a0e0a;
  --panel: #0d130d;
  --panel-2: #0f1810;
  --line: #1a2a1a;
  --dim: #5a6a5a;
  --txt: #c8d8c8;
  --glow: #39FF14;
  --glow-soft: rgba(57, 255, 20, 0.18);
}
:root[data-glow="green"]   { --glow: #39FF14; --glow-soft: rgba(57,255,20,.18); }
:root[data-glow="amber"]   { --glow: #FFB000; --glow-soft: rgba(255,176,0,.18); }
:root[data-glow="cyan"]    { --glow: #00E5FF; --glow-soft: rgba(0,229,255,.18); }
:root[data-glow="magenta"] { --glow: #FF2D95; --glow-soft: rgba(255,45,149,.18); }

html, body {
  background: var(--bg);
  color: var(--txt);
  font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* Scanline overlay — fixed, faint, non-interactive. */
.crt-scanlines::before {
  content: '';
  position: fixed; inset: 0; pointer-events: none; z-index: 50;
  background: repeating-linear-gradient(
    to bottom, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,0.12) 3px, rgba(0,0,0,0) 4px
  );
  mix-blend-mode: multiply;
}

/* Grain overlay — SVG turbulence as a data URI, very low opacity. */
.crt-grain::after {
  content: '';
  position: fixed; inset: 0; pointer-events: none; z-index: 49; opacity: 0.025;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}

/* Glow text/elements. */
.glow-text { color: var(--glow); text-shadow: 0 0 6px var(--glow-soft); }
.glow-border { border-color: var(--glow); box-shadow: 0 0 0 1px var(--glow-soft), inset 0 0 8px var(--glow-soft); }

/* Blinking block cursor. */
@keyframes blink { 0%,49% { opacity: 1 } 50%,100% { opacity: 0 } }
.cursor-blink { animation: blink 1s step-end infinite; }

/* Boot reveal — staggered top→bottom on mount. */
@keyframes boot-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.boot { animation: boot-in 0.28s ease-out both; }
.boot-1 { animation-delay: 0.00s; }
.boot-2 { animation-delay: 0.06s; }
.boot-3 { animation-delay: 0.12s; }
.boot-4 { animation-delay: 0.18s; }

/* Streaming afterglow on the live assistant text. */
@keyframes afterglow { 0%,100% { text-shadow: none } 50% { text-shadow: 0 0 5px var(--glow-soft) } }
.afterglow { animation: afterglow 1.6s ease-in-out infinite; }

/* Connection dot pulse in glow color. */
@keyframes dot-pulse { 0%,100% { opacity: .4; box-shadow: 0 0 0 0 var(--glow-soft) } 50% { opacity: 1; box-shadow: 0 0 6px 1px var(--glow-soft) } }
.dot-live { background: var(--glow); animation: dot-pulse 1.4s ease-in-out infinite; }
```

- [ ] **Step 2: Import theme + recolor markdown/scrollbar in index.css**

Replace the entire contents of `extension/src/sidebar/index.css` with:
```css
@import "tailwindcss";
@import "./theme.css";

/* ── Animations (kept from original) ─────────────────────────────────────── */
@keyframes fade-in-down { 0% { opacity: 0; transform: translateY(-8px); } 100% { opacity: 1; transform: translateY(0); } }
.animate-fade-in-down { animation: fade-in-down 0.2s ease-out; }
@keyframes pulse-dot { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
.animate-pulse-dot { animation: pulse-dot 1.2s ease-in-out infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.animate-spin { animation: spin 1s linear infinite; }

/* ── Scrollbar (terminal palette) ────────────────────────────────────────── */
.chat-scroll::-webkit-scrollbar { width: 5px; }
.chat-scroll::-webkit-scrollbar-track { background: transparent; }
.chat-scroll::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
.chat-scroll::-webkit-scrollbar-thumb:hover { background: var(--dim); }

/* ── Code blocks inside messages ─────────────────────────────────────────── */
.msg-content pre { background: #06120a; border-radius: 4px; padding: 10px 12px; margin: 8px 0; overflow-x: auto; font-size: 12px; line-height: 1.5; border: 1px solid var(--line); }
.msg-content code { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 0.9em; }
.msg-content :not(pre) > code { background: rgba(57,255,20,0.08); padding: 1px 5px; border-radius: 3px; color: var(--glow); }
.msg-content h1, .msg-content h2, .msg-content h3 { font-weight: 500; margin: 12px 0 6px; line-height: 1.3; color: var(--txt); }
.msg-content h1 { font-size: 1.2em; } .msg-content h2 { font-size: 1.08em; } .msg-content h3 { font-size: 1em; }
.msg-content ul, .msg-content ol { padding-left: 1.5em; margin: 6px 0; }
.msg-content li { margin: 2px 0; }
.msg-content blockquote { border-left: 3px solid var(--line); padding-left: 12px; margin: 8px 0; color: var(--dim); }
.msg-content a { color: var(--glow); text-decoration: none; }
.msg-content a:hover { text-decoration: underline; }
.msg-content hr { border: 0; border-top: 1px solid var(--line); margin: 12px 0; }
.msg-content table { border-collapse: collapse; margin: 8px 0; font-size: 0.9em; width: 100%; }
.msg-content th, .msg-content td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; }
.msg-content th { background: rgba(57,255,20,0.06); font-weight: 500; }
```

- [ ] **Step 3: Fix FOUC background in index.html**

In `extension/src/sidebar/index.html`, change line 6 and line 10:
- `<meta name="theme-color" content="#030712">` → `<meta name="theme-color" content="#0a0e0a">`
- `html, body { margin: 0; padding: 0; background: #030712; }` → `html, body { margin: 0; padding: 0; background: #0a0e0a; }`

- [ ] **Step 4: Verify the build resolves the font + theme**

Run from `extension/`:
```bash
npm run build
```
Expected: build succeeds; `dist/assets/` contains the two woff2 files (hashed names) and the sidebar CSS references them.

- [ ] **Step 5: Confirm content.js guard still passes**

Run:
```bash
npx vitest run src/__tests__/content-build.test.ts
```
Expected: PASS — the new sidebar CSS/font must NOT leak a static import into `content.js`. (Sidebar is a separate HTML entry; this should hold, but verify.)

- [ ] **Step 6: Commit**

```bash
git add extension/src/sidebar/theme.css extension/src/sidebar/index.css extension/src/sidebar/index.html
git commit -m "feat(sidebar): terminal-punk theme tokens, CRT texture, boot/glow animations"
```

---

## Task 5: Extract ToolCard component (terminal restyle)

**Files:**
- Create: `extension/src/sidebar/ToolCard.tsx`
- Modify: `extension/src/sidebar/App.tsx` (remove inline `ToolCard`, `toolIcon`, `getDestructiveWarning`, `DESTRUCTIVE_PATTERNS`; import from new file)

The extracted module owns the tool-card render, its icon map, and the destructive-command detection (which only ToolCard uses).

- [ ] **Step 1: Create ToolCard.tsx**

Create `extension/src/sidebar/ToolCard.tsx`:
```tsx
import { useState } from 'react'

export interface ToolCall { name: string; args: Record<string, unknown>; call_id: string }
export interface ToolResult { call_id: string; name: string; output: string; success: boolean }

const DESTRUCTIVE_PATTERNS = [
  { pattern: /rm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r[a-zA-Z]*\s+-[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*\s+-[a-zA-Z]*r)/, label: 'rm -rf（递归强制删除）' },
  { pattern: /rm\s+-rf\s+\//, label: 'rm -rf /（删除根目录）' },
  { pattern: /git\s+reset\s+--hard/, label: 'git reset --hard（不可逆重置）' },
  { pattern: /git\s+clean\s+-fd/, label: 'git clean -fd（强制清理）' },
  { pattern: /git\s+push\s+.*--force/, label: 'git push --force（强制推送）' },
  { pattern: /DROP\s+(TABLE|DATABASE|SCHEMA)/i, label: 'DROP TABLE/DATABASE（删除数据库对象）' },
  { pattern: /DELETE\s+FROM.*WHERE\s+1\s*=\s*1/i, label: 'DELETE FROM（清空表数据）' },
  { pattern: /mkfs/, label: 'mkfs（格式化磁盘）' },
  { pattern: /dd\s+if=/, label: 'dd（低级磁盘写入）' },
  { pattern: />\s*\/dev\/sd[a-z]/, label: '写入磁盘设备' },
]

export function getDestructiveWarning(args: Record<string, unknown>): string | null {
  const cmd = String(args.command || args.cmd || '')
  if (!cmd) return null
  for (const { pattern, label } of DESTRUCTIVE_PATTERNS) if (pattern.test(cmd)) return label
  return null
}

const TOOL_ICON: Record<string, string> = {
  list_dir: 'ls', read_file: 'cat', write_file: 'wr', edit: 'ed',
  exec_cmd: 'sh', grep: 're', glob: 'gl', web_fetch: 'net',
  skill: 'sk', apply_patch: 'patch', question: '?',
}
function toolTag(name: string): string { return TOOL_ICON[name] || 'fn' }

export default function ToolCard({ tool, result, streams }: {
  tool: ToolCall; result?: ToolResult; streams?: string[]
}) {
  const [open, setOpen] = useState(false)
  const warning = getDestructiveWarning(tool.args)
  const output = result?.output || ''
  const outLines = output ? output.split('\n') : []
  const preview = outLines.slice(0, 5).join('\n')
  const truncated = outLines.length > 5 || output.length > 500

  const status = result ? (result.success ? '[done]' : '[fail]') : '[run]'
  const statusCls = result ? (result.success ? 'glow-text' : 'text-red-400') : 'text-amber-400'

  return (
    <div className="my-1.5 text-[12px]">
      {warning && (
        <div className="text-[10px] text-red-300 flex items-center gap-1 mb-1 px-2 py-1 border border-red-800/50 rounded-sm" style={{ background: 'rgba(120,20,20,.15)' }}>
          <span>⚠</span><span>危险操作: {warning}</span>
        </div>
      )}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-sm cursor-pointer border"
        style={{ background: 'var(--panel-2)', borderColor: 'var(--line)' }}
        onClick={() => setOpen(o => !o)}
      >
        <span className="glow-text">◆</span>
        <span style={{ color: 'var(--dim)' }}>{toolTag(tool.name)}</span>
        <span className="font-medium" style={{ color: 'var(--txt)' }}>{tool.name}</span>
        <span className={`${statusCls} ml-1`}>{status}</span>
        {!result && <span className="cursor-blink glow-text">▌</span>}
        <span className="ml-auto" style={{ color: 'var(--dim)' }}>{open ? '▾' : '▸'}</span>
      </div>

      {open && (
        <div className="mt-1 ml-2 pl-2.5 space-y-1.5 border-l" style={{ borderColor: 'var(--line)' }}>
          {Object.keys(tool.args).length > 0 && (
            <div>
              <div className="text-[10px] mb-0.5" style={{ color: 'var(--dim)' }}>args</div>
              <pre className="text-[11px] rounded-sm px-2 py-1 overflow-x-auto whitespace-pre-wrap break-all" style={{ background: '#06120a', color: 'var(--txt)' }}>
                {JSON.stringify(tool.args, null, 2)}
              </pre>
            </div>
          )}
          {streams && streams.length > 0 && (
            <div>
              <div className="text-[10px] mb-0.5" style={{ color: 'var(--dim)' }}>stdout</div>
              <pre className="text-[11px] rounded-sm px-2 py-1 max-h-32 overflow-y-auto whitespace-pre-wrap glow-text" style={{ background: '#06120a' }}>
                {streams.join('')}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <div className="text-[10px] mb-0.5" style={{ color: 'var(--dim)' }}>result</div>
              <pre className={`text-[11px] rounded-sm px-2 py-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-all ${result.success ? '' : 'text-red-300'}`} style={{ background: '#06120a', color: result.success ? 'var(--txt)' : undefined }}>
                {output}
              </pre>
            </div>
          )}
        </div>
      )}

      {!open && result && (
        <div className="mt-0.5 ml-2 pl-2.5 border-l" style={{ borderColor: 'var(--line)' }}>
          <pre className={`text-[11px] whitespace-pre-wrap break-all max-h-16 overflow-hidden ${result.success ? '' : 'text-red-400/70'}`} style={{ color: result.success ? 'var(--dim)' : undefined }}>
            {truncated ? preview + ' …' : output}
          </pre>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Wire App.tsx to the extracted ToolCard**

In `extension/src/sidebar/App.tsx`:
1. Add at top (after existing imports): `import ToolCard, { type ToolCall, type ToolResult } from './ToolCard'`
2. Delete the inline `interface ToolCall {...}` and `interface ToolResult {...}` (lines ~16–27) — now imported.
3. Delete the inline `DESTRUCTIVE_PATTERNS`, `getDestructiveWarning`, `toolIcon`, and the inline `ToolCard` function (the block from `// ── Destructive command detection ──` through the end of the old `ToolCard`, i.e. the original lines ~209–361). Keep `ThinkingBlock` for now (moves in Task 6).

- [ ] **Step 3: Type-check**

Run from `extension/`:
```bash
npx tsc --noEmit
```
Expected: no errors. (`ChatMessage.toolCalls` now references the imported `ToolCall` — same shape, so it resolves.)

- [ ] **Step 4: Run sidebar tests + build**

Run:
```bash
npx vitest run src/__tests__/sidebar-subagent.test.ts src/__tests__/sidebar-session-store.test.ts
npm run build
```
Expected: tests PASS, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add extension/src/sidebar/ToolCard.tsx extension/src/sidebar/App.tsx
git commit -m "refactor(sidebar): extract ToolCard to own file, terminal restyle"
```

---

## Task 6: Extract MessageView (was MessageBubble) — terminal log style + pin field

**Files:**
- Create: `extension/src/sidebar/MessageView.tsx`
- Modify: `extension/src/sidebar/App.tsx`

This moves `ChatMessage`, `ToolCall`/`ToolResult` (re-exported from ToolCard), `ThinkingStep`, the markdown renderer, `stripToolBlocks`, `ThinkingBlock`, `ActionBtn`, `MessageBubble`, `formatTime`, `copyToClipboard` into the view module. Adds `pinned?: boolean` to `ChatMessage` and a pin toggle button.

- [ ] **Step 1: Create MessageView.tsx**

Create `extension/src/sidebar/MessageView.tsx` containing the message types, markdown renderer, thinking block, and the renamed `MessageView` component:
```tsx
import { useState } from 'react'
import ToolCard, { type ToolCall, type ToolResult } from './ToolCard'

export type { ToolCall, ToolResult }

export interface ThinkingStep { title: string; thought: string }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool_result'
  content: string
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  toolStreams?: Record<string, string[]>
  thinking?: ThinkingStep[]
  streaming?: boolean
  ts?: number
  pinned?: boolean
}

export function formatTime(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea')
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
  })
}

const TOOL_FENCE_RE = /```piercode-tool\s*\n[\s\S]*?\n```/gi
function stripToolBlocks(text: string): string {
  return text.replace(TOOL_FENCE_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function renderMarkdown(text: string): string {
  if (!text) return ''
  let src = text.replace(/\r\n/g, '\n')
  const codeBlocks: string[] = []
  src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : ''
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
    return `\x00CODE${idx}\x00`
  })
  src = escapeHtml(src)
  src = src.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  src = src.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  src = src.replace(/^# (.+)$/gm, '<h1>$1</h1>')
  src = src.replace(/^---+$/gm, '<hr/>')
  src = src.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
  src = src.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_m, header, _sep, body) => {
    const ths = header.split('|').filter(Boolean).map((c: string) => `<th>${c.trim()}</th>`).join('')
    const rows = body.trim().split('\n').map((row: string) => {
      const tds = row.split('|').filter(Boolean).map((c: string) => `<td>${c.trim()}</td>`).join('')
      return `<tr>${tds}</tr>`
    }).join('')
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`
  })
  src = src.replace(/^[\s]*[-*+] (.+)$/gm, '<li>$1</li>')
  src = src.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
  src = src.replace(/^[\s]*\d+\. (.+)$/gm, '<li>$1</li>')
  src = src.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  src = src.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  src = src.replace(/\*(.+?)\*/g, '<em>$1</em>')
  src = src.replace(/~~(.+?)~~/g, '<del>$1</del>')
  src = src.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  src = src.replace(/`([^`]+)`/g, '<code>$1</code>')
  src = src.replace(/\n\n+/g, '</p><p>')
  src = src.replace(/\n/g, '<br/>')
  src = `<p>${src}</p>`
  src = src.replace(/<p>\s*<\/p>/g, '')
  src = src.replace(/<p>(<(?:h[1-3]|ul|ol|pre|blockquote|hr|table))/g, '$1')
  src = src.replace(/(<\/(?:h[1-3]|ul|ol|pre|blockquote|hr|table)>)<\/p>/g, '$1')
  src = src.replace(/<p>(<hr\/?>)/g, '$1')
  src = src.replace(/\x00CODE(\d+)\x00/g, (_m, idx) => codeBlocks[Number(idx)] || '')
  return src
}

function ThinkingBlock({ steps, streaming }: { steps: ThinkingStep[]; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null
  const last = steps[steps.length - 1]
  return (
    <div className="mb-1.5 text-[11px]">
      <div className="flex items-center gap-1.5 cursor-pointer" style={{ color: 'var(--dim)' }} onClick={() => setOpen(o => !o)}>
        <span>≡</span>
        <span className="italic truncate flex-1">{last.title || '思考中…'}</span>
        {streaming && <span className="animate-pulse-dot">·</span>}
        <span>{open ? '▾' : `${steps.length} 步 ▸`}</span>
      </div>
      {open && (
        <div className="mt-1 pl-4 border-l space-y-1.5" style={{ borderColor: 'var(--line)' }}>
          {steps.map((s, i) => (
            <div key={i}>
              {s.title && <div style={{ color: 'var(--dim)' }}>{s.title}</div>}
              {s.thought && <div className="whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--dim)' }}>{s.thought}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ActionBtn({ icon, title, onClick, active }: { icon: string; title: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick} title={title}
      className={`px-1 rounded-sm text-[11px] cursor-pointer ${active ? 'glow-text' : ''}`}
      style={{ color: active ? undefined : 'var(--dim)' }}>
      {icon}
    </button>
  )
}

export default function MessageView({ msg, onRegenerate, onTogglePin }: {
  msg: ChatMessage
  onRegenerate?: () => void
  onTogglePin?: () => void
}) {
  const isUser = msg.role === 'user'
  const isTool = msg.role === 'tool_result'

  if (isTool) {
    return (
      <div className="msg-row px-4 py-1">
        <div className="rounded-sm border p-2.5 text-xs" style={{ background: 'var(--panel-2)', borderColor: 'var(--line)', color: 'var(--dim)' }}>
          <div className="flex items-center gap-1.5 mb-1"><span>»</span><span>tool result</span></div>
          <pre className="whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
            {msg.content.slice(0, 500)}{msg.content.length > 500 ? '...' : ''}
          </pre>
        </div>
      </div>
    )
  }

  return (
    <div className={`msg-row px-4 py-1.5 ${isUser ? 'flex justify-end' : ''}`}>
      <div className="relative group max-w-[94%] w-full">
        <div className="flex items-start gap-1.5">
          <span className="select-none mt-0.5" style={{ color: isUser ? 'var(--dim)' : 'var(--glow)' }}>
            {isUser ? '◂' : '▸'}
          </span>
          <div className="flex-1 min-w-0 text-sm leading-relaxed" style={{ color: 'var(--txt)' }}>
            {msg.thinking && msg.thinking.length > 0 && (
              <ThinkingBlock steps={msg.thinking} streaming={msg.streaming && !msg.content} />
            )}
            {msg.toolCalls?.map((tc, i) => (
              <ToolCard key={tc.call_id || i} tool={tc}
                result={msg.toolResults?.find(r => r.call_id === tc.call_id)}
                streams={msg.toolStreams?.[tc.call_id]} />
            ))}
            {msg.content && (() => {
              const displayText = msg.toolCalls?.length ? stripToolBlocks(msg.content) : msg.content
              if (!displayText) return null
              return (
                <div className={`msg-content ${msg.toolCalls?.length ? 'mt-2' : ''} ${msg.streaming ? 'afterglow' : ''}`}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(displayText) }} />
              )
            })()}
            {msg.streaming && <span className="cursor-blink glow-text ml-0.5">▌</span>}
          </div>
        </div>

        <div className={`flex items-center gap-1 mt-1 pl-4 ${isUser ? 'justify-end' : ''}`}>
          {msg.ts && <span className="text-[10px] mr-1" style={{ color: 'var(--dim)' }}>{formatTime(msg.ts)}</span>}
          <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
            {msg.content && !msg.streaming && (
              <ActionBtn icon="copy" title="复制" onClick={() => copyToClipboard(msg.content)} />
            )}
            {onTogglePin && !msg.streaming && (
              <ActionBtn icon={msg.pinned ? '★ unpin' : '☆ pin'} title="置顶" active={msg.pinned} onClick={onTogglePin} />
            )}
            {!isUser && !msg.streaming && onRegenerate && (
              <ActionBtn icon="regen" title="重新生成" onClick={onRegenerate} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire App.tsx to MessageView**

In `extension/src/sidebar/App.tsx`:
1. Replace the ToolCard import with: `import MessageView, { type ChatMessage, type ToolCall, type ToolResult, type ThinkingStep } from './MessageView'`
2. Delete from App.tsx (now in MessageView): `interface ThinkingStep`, `interface ChatMessage`, `formatTime`, `copyToClipboard`, `stripToolBlocks`, `escapeHtml`, `renderMarkdown`, `ThinkingBlock`, `ActionBtn`, and `MessageBubble`. (Keep `appendAgentChunk`, `genId`, `SubAgent`, `QuestionCard`, `ConnectionInfo`, `SubAgentCard` — they stay or move later.)
3. In the message list render (around old line 1177), replace `MessageBubble` usage with `MessageView` and pass the pin handler:
```tsx
{messages.map((msg, i) => (
  <MessageView
    key={i}
    msg={msg}
    onRegenerate={msg.role === 'assistant' && !msg.streaming ? handleRegenerate : undefined}
    onTogglePin={() => togglePin(i)}
  />
))}
```

- [ ] **Step 3: Add the togglePin handler in App.tsx**

Add near the other handlers (e.g. after `handleRegenerate`):
```tsx
const togglePin = useCallback((idx: number) => {
  setMessages(prev => prev.map((m, i) => i === idx ? { ...m, pinned: !m.pinned } : m))
}, [])
```

- [ ] **Step 4: Type-check**

Run from `extension/`:
```bash
npx tsc --noEmit
```
Expected: no errors. If `ChatMessage` is referenced anywhere else in App.tsx (it is — heavily), the import covers it since it's the same shape plus the optional `pinned`.

- [ ] **Step 5: Run tests + build**

Run:
```bash
npx vitest run src/__tests__/sidebar-subagent.test.ts src/__tests__/sidebar-session-store.test.ts src/__tests__/sidebar-token-panel.test.tsx
npm run build
```
Expected: PASS, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add extension/src/sidebar/MessageView.tsx extension/src/sidebar/App.tsx
git commit -m "refactor(sidebar): extract MessageView, terminal log style, add pin toggle"
```

---

## Task 7: Persist `pinned` through session-store

**Files:**
- Modify: `extension/src/sidebar/session-store.ts`
- Modify: `extension/src/sidebar/App.tsx` (persistence + load mapping)
- Modify: `extension/src/__tests__/sidebar-session-store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `extension/src/__tests__/sidebar-session-store.test.ts` a test that saves a session with a pinned message and reloads it. First inspect the file's existing setup (it already mocks `chrome.storage.local`). Add:
```ts
it('round-trips the pinned flag on a message', async () => {
  const s = {
    id: 'p1', platform: 'qwen', model: 'm', chatId: null, lastResponseId: null,
    messages: [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'yo', pinned: true },
    ],
    ts: 1,
  }
  await saveSession(s)
  const got = await loadSession('p1')
  expect(got?.messages[1].pinned).toBe(true)
  expect(got?.messages[0].pinned).toBeUndefined()
})
```
(Use whatever import names the existing test file already uses for `saveSession`/`loadSession`.)

- [ ] **Step 2: Run test to verify it fails**

Run from `extension/`:
```bash
npx vitest run src/__tests__/sidebar-session-store.test.ts
```
Expected: FAIL — `got.messages[1].pinned` is `undefined` because `StoredMessage` drops the field (type doesn't include it; and even if stored, the type omits it).

- [ ] **Step 3: Add `pinned` to StoredMessage**

In `extension/src/sidebar/session-store.ts`, change the `StoredMessage` interface:
```ts
export interface StoredMessage {
  role: 'user' | 'assistant' | 'tool_result' | 'system'
  content: string
  pinned?: boolean
}
```

- [ ] **Step 4: Include `pinned` when persisting in App.tsx**

In `extension/src/sidebar/App.tsx`, the persistence effect maps messages (around old line 644). Change:
```ts
messages: messages.map(m => ({ role: m.role, content: m.content })),
```
to:
```ts
messages: messages.map(m => ({ role: m.role, content: m.content, pinned: m.pinned })),
```
(Load already does `setMessages(s.messages as ChatMessage[])`, so `pinned` flows back automatically.)

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
npx vitest run src/__tests__/sidebar-session-store.test.ts
```
Expected: PASS.

- [ ] **Step 6: Type-check + commit**

```bash
npx tsc --noEmit
git add extension/src/sidebar/session-store.ts extension/src/sidebar/App.tsx extension/src/__tests__/sidebar-session-store.test.ts
git commit -m "feat(sidebar): persist message pin flag across sessions"
```

---

## Task 8: WorkerRadar component

**Files:**
- Create: `extension/src/sidebar/WorkerRadar.tsx`
- Modify: `extension/src/sidebar/App.tsx`

Replaces the bottom `subAgents` stack with a compact top status-chip bar; clicking a chip scrolls to that sub-agent's detail card (the existing `SubAgentCard` stack stays as the detail view, kept at the bottom). `SubAgent` type moves to a shared spot: export it from `App.tsx` is awkward; instead define it in WorkerRadar and import back into App.

- [ ] **Step 1: Create WorkerRadar.tsx**

Create `extension/src/sidebar/WorkerRadar.tsx`:
```tsx
import type { ChatMessage } from './MessageView'

export interface SubAgent {
  id: string
  label: string
  task: string
  status: 'running' | 'done' | 'error'
  messages: ChatMessage[]
}

const STATUS_MARK: Record<SubAgent['status'], { mark: string; cls: string }> = {
  running: { mark: '▸▸', cls: 'text-amber-400' },
  done: { mark: '✓', cls: 'glow-text' },
  error: { mark: '✗', cls: 'text-red-400' },
}

export default function WorkerRadar({ agents, onJump }: {
  agents: SubAgent[]
  onJump: (id: string) => void
}) {
  if (agents.length === 0) return null
  return (
    <div className="flex items-center gap-2 px-3 py-1 border-b overflow-x-auto flex-shrink-0 text-[11px]"
      style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
      <span className="select-none" style={{ color: 'var(--dim)' }}>radar:</span>
      {agents.map(a => {
        const s = STATUS_MARK[a.status]
        return (
          <button key={a.id} onClick={() => onJump(a.id)}
            title={a.task}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm whitespace-nowrap cursor-pointer border"
            style={{ borderColor: 'var(--line)', background: 'var(--panel-2)' }}>
            <span className="glow-text">@{a.label}</span>
            <span className={`${s.cls} ${a.status === 'running' ? 'animate-pulse-dot' : ''}`}>{s.mark}</span>
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Wire App.tsx — import SubAgent from WorkerRadar, render the bar, add jump handler**

In `extension/src/sidebar/App.tsx`:
1. Delete the inline `interface SubAgent {...}` (old lines ~126–132).
2. Add import: `import WorkerRadar, { type SubAgent } from './WorkerRadar'`
3. Give each `SubAgentCard` wrapper a DOM id for scroll targeting. In the bottom sub-agent stack render, wrap each card:
```tsx
{subAgents.map(a => (
  <div key={a.id} id={`agent-${a.id}`}>
    <SubAgentCard agent={a} />
  </div>
))}
```
4. Add the jump handler near other handlers:
```tsx
const jumpToAgent = useCallback((id: string) => {
  document.getElementById(`agent-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}, [])
```
5. Render `<WorkerRadar agents={subAgents} onJump={jumpToAgent} />` directly under the platform rail (above the message list).

- [ ] **Step 3: Type-check + tests + build**

Run from `extension/`:
```bash
npx tsc --noEmit
npx vitest run src/__tests__/sidebar-subagent.test.ts
npm run build
```
Expected: no type errors (the subagent test references `SubAgent`-shaped data via App's runtime, unaffected by the type's new home); PASS; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add extension/src/sidebar/WorkerRadar.tsx extension/src/sidebar/App.tsx
git commit -m "feat(sidebar): worker radar status-chip bar with jump-to-agent"
```

---

## Task 9: StatusHUD component

**Files:**
- Create: `extension/src/sidebar/StatusHUD.tsx`
- Modify: `extension/src/sidebar/App.tsx`

A single bottom line: connection dot, root dir, token mini-bar (reuses `token-count`), active-agent count. Replaces the separate `ConnectionInfo` (top) — fold its `/health`+`/config` fetch into the HUD. Keep the full `TokenPanel` as-is above the input (HUD's token piece is a compact mirror; user keeps the detailed panel). To avoid double fetching, HUD does its own lightweight fetch (same pattern as `ConnectionInfo`).

- [ ] **Step 1: Create StatusHUD.tsx**

Create `extension/src/sidebar/StatusHUD.tsx`:
```tsx
import { useEffect, useState, useMemo } from 'react'
import { computeMeter, type MeterMessage } from './token-count'

interface HudMsg { role: 'user' | 'assistant' | 'tool_result'; content: string }

function toMeterRole(role: HudMsg['role']): MeterMessage['role'] {
  return role === 'assistant' ? 'assistant' : 'user'
}
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export default function StatusHUD({ connected, messages, platform, threshold, activeAgents }: {
  connected: boolean
  messages: HudMsg[]
  platform: string
  threshold: number
  activeAgents: number
}) {
  const [rootDir, setRootDir] = useState('')

  useEffect(() => {
    if (!connected) { setRootDir(''); return }
    chrome.storage.local.get(['apiUrl', 'authToken'], (result) => {
      if (!result.apiUrl || !result.authToken) return
      const headers = { Authorization: `Bearer ${result.authToken}` }
      fetch(`${result.apiUrl}/config`, { headers }).then(r => r.json())
        .then(cfg => setRootDir(cfg?.rootDir || '')).catch(() => {})
    })
  }, [connected])

  const total = useMemo(() => {
    const m = computeMeter(messages.map(x => ({ role: toMeterRole(x.role), content: x.content })), platform)
    return m.total
  }, [messages, platform])

  const ratio = threshold > 0 ? Math.min(1, total / threshold) : 0
  const segs = 10
  const filled = Math.round(ratio * segs)
  const bar = '▓'.repeat(filled) + '░'.repeat(segs - filled)

  return (
    <div className="flex items-center gap-2 px-3 py-1 border-t text-[10px] flex-shrink-0 overflow-hidden"
      style={{ borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--dim)' }}>
      <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'dot-live' : ''}`} style={{ background: connected ? undefined : '#7a2a2a' }} />
      <span>{connected ? 'ck' : 'off'}</span>
      {rootDir && <span className="truncate max-w-[120px]" title={rootDir}>📁{rootDir.replace(/^.*\//, '')}</span>}
      <span className="glow-text font-mono">{bar}</span>
      <span>{fmt(total)}/{fmt(threshold)}</span>
      {activeAgents > 0 && <span className="ml-auto glow-text">⚙{activeAgents}</span>}
    </div>
  )
}
```

- [ ] **Step 2: Wire App.tsx**

In `extension/src/sidebar/App.tsx`:
1. Add import: `import StatusHUD from './StatusHUD'`
2. Remove the `<ConnectionInfo connected={connected} />` render (top) and delete the `ConnectionInfo` function definition.
3. At the very bottom of the layout (after the input block, last child of the root flex column) add:
```tsx
<StatusHUD
  connected={connected}
  messages={messages}
  platform={platform}
  threshold={tokenThreshold || 200_000}
  activeAgents={subAgents.filter(a => a.status === 'running').length}
/>
```

- [ ] **Step 3: Type-check + build**

Run from `extension/`:
```bash
npx tsc --noEmit
npm run build
```
Expected: no errors; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add extension/src/sidebar/StatusHUD.tsx extension/src/sidebar/App.tsx
git commit -m "feat(sidebar): bottom status HUD (conn/root/token bar/agent count)"
```

---

## Task 10: Command list + fuzzy filter (pure) + tests

**Files:**
- Create: `extension/src/sidebar/commands.ts`
- Test: `extension/src/__tests__/sidebar-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/src/__tests__/sidebar-commands.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { fuzzyFilter, type Command } from '../sidebar/commands'

const cmds: Command[] = [
  { id: 'new', title: '新对话', hint: 'new chat', run: () => {} },
  { id: 'clear', title: '清屏', hint: 'clear messages', run: () => {} },
  { id: 'plat-qwen', title: '切换到 Qwen', hint: 'platform', run: () => {} },
]

describe('fuzzyFilter', () => {
  it('returns all commands for an empty query', () => {
    expect(fuzzyFilter(cmds, '')).toHaveLength(3)
  })
  it('matches on title substring', () => {
    expect(fuzzyFilter(cmds, '清屏').map(c => c.id)).toEqual(['clear'])
  })
  it('matches on hint (case-insensitive)', () => {
    expect(fuzzyFilter(cmds, 'PLATFORM').map(c => c.id)).toEqual(['plat-qwen'])
  })
  it('matches subsequence across title', () => {
    // "qw" is a subsequence of "切换到 Qwen" via the hint/title chars
    expect(fuzzyFilter(cmds, 'qwen').map(c => c.id)).toEqual(['plat-qwen'])
  })
  it('returns empty when nothing matches', () => {
    expect(fuzzyFilter(cmds, 'zzz')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `extension/`:
```bash
npx vitest run src/__tests__/sidebar-commands.test.ts
```
Expected: FAIL — cannot resolve `../sidebar/commands`.

- [ ] **Step 3: Write commands.ts**

Create `extension/src/sidebar/commands.ts`:
```ts
// Pure command model + fuzzy filter for the Cmd+K palette. No React/chrome so
// it's unit-testable. App.tsx builds the concrete Command[] (with closures over
// its handlers) and passes them to CommandPalette.

export interface Command {
  id: string
  title: string
  hint?: string
  run: () => void
}

// Case-insensitive: substring on title OR hint, else subsequence on title+hint.
export function fuzzyFilter(cmds: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase()
  if (!q) return cmds
  return cmds.filter(c => {
    const hay = `${c.title} ${c.hint || ''}`.toLowerCase()
    if (hay.includes(q)) return true
    // subsequence
    let i = 0
    for (const ch of hay) { if (ch === q[i]) i++; if (i === q.length) return true }
    return false
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/__tests__/sidebar-commands.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/sidebar/commands.ts extension/src/__tests__/sidebar-commands.test.ts
git commit -m "feat(sidebar): command model + fuzzy filter for palette"
```

---

## Task 11: CommandPalette component + search mode + Cmd+K wiring

**Files:**
- Create: `extension/src/sidebar/CommandPalette.tsx`
- Modify: `extension/src/sidebar/App.tsx`

Palette has two modes: `command` (default — runs a `Command`) and `search` (typing filters `messages`, Enter/click scrolls to a match). Mode toggles with a leading `>` for commands vs plain text for search — simpler: a small tab toggle at top (cmd | search). Opened by `Cmd/Ctrl+K`, closed by `Esc` or backdrop click.

- [ ] **Step 1: Create CommandPalette.tsx**

Create `extension/src/sidebar/CommandPalette.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react'
import { fuzzyFilter, type Command } from './commands'

export interface SearchHit { index: number; preview: string }

export default function CommandPalette({ commands, onClose, onSearch, onPickSearch }: {
  commands: Command[]
  onClose: () => void
  onSearch: (q: string) => SearchHit[]
  onPickSearch: (index: number) => void
}) {
  const [mode, setMode] = useState<'command' | 'search'>('command')
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setSel(0) }, [query, mode])

  const cmdResults = mode === 'command' ? fuzzyFilter(commands, query) : []
  const searchResults = mode === 'search' ? onSearch(query) : []
  const count = mode === 'command' ? cmdResults.length : searchResults.length

  function exec(i: number) {
    if (mode === 'command') { cmdResults[i]?.run(); onClose() }
    else { const hit = searchResults[i]; if (hit) { onPickSearch(hit.index); onClose() } }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(count - 1, s + 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); return }
    if (e.key === 'Enter') { e.preventDefault(); exec(sel); return }
    if (e.key === 'Tab') { e.preventDefault(); setMode(m => m === 'command' ? 'search' : 'command'); setQuery('') }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-16" style={{ background: 'rgba(0,0,0,.55)' }} onClick={onClose}>
      <div className="w-[88%] max-w-md rounded-sm border glow-border" style={{ background: 'var(--panel)', borderColor: 'var(--line)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--line)' }}>
          <span className="glow-text">{mode === 'command' ? '>' : '/'}</span>
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKey}
            placeholder={mode === 'command' ? '输入命令…  (Tab 切到搜索)' : '搜索消息…  (Tab 切回命令)'}
            className="flex-1 bg-transparent outline-none text-sm" style={{ color: 'var(--txt)' }} />
          <button onClick={() => { setMode(m => m === 'command' ? 'search' : 'command'); setQuery('') }}
            className="text-[10px] px-1.5 py-0.5 rounded-sm border" style={{ borderColor: 'var(--line)', color: 'var(--dim)' }}>
            {mode === 'command' ? 'cmd' : 'search'}
          </button>
        </div>
        <div className="max-h-72 overflow-y-auto chat-scroll py-1">
          {mode === 'command' && cmdResults.map((c, i) => (
            <div key={c.id} onMouseEnter={() => setSel(i)} onClick={() => exec(i)}
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm"
              style={{ background: i === sel ? 'var(--glow-soft)' : 'transparent', color: 'var(--txt)' }}>
              <span className={i === sel ? 'glow-text' : ''}>▸</span>
              <span className="flex-1">{c.title}</span>
              {c.hint && <span className="text-[10px]" style={{ color: 'var(--dim)' }}>{c.hint}</span>}
            </div>
          ))}
          {mode === 'search' && searchResults.map((h, i) => (
            <div key={h.index} onMouseEnter={() => setSel(i)} onClick={() => exec(i)}
              className="px-3 py-1.5 cursor-pointer text-xs truncate"
              style={{ background: i === sel ? 'var(--glow-soft)' : 'transparent', color: 'var(--txt)' }}>
              <span style={{ color: 'var(--dim)' }}>#{h.index} </span>{h.preview}
            </div>
          ))}
          {count === 0 && <div className="px-3 py-3 text-xs" style={{ color: 'var(--dim)' }}>无匹配</div>}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire palette state + Cmd+K + command list into App.tsx**

In `extension/src/sidebar/App.tsx`:
1. Add import: `import CommandPalette, { type SearchHit } from './CommandPalette'` and `import { type Command } from './commands'`
2. Add state: `const [paletteOpen, setPaletteOpen] = useState(false)`
3. Add a global key listener effect:
```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      setPaletteOpen(o => !o)
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}, [])
```
4. Build the command list (memoized) referencing existing handlers/state:
```tsx
const paletteCommands = useMemo<Command[]>(() => {
  const list: Command[] = [
    { id: 'new', title: '新对话', hint: 'new', run: () => startNewSession() },
    { id: 'clear', title: '清空当前消息', hint: 'clear', run: () => setMessages([]) },
  ]
  for (const p of PLATFORMS) {
    list.push({ id: `plat-${p.key}`, title: `切换到 ${p.label}`, hint: 'platform', run: () => setPlatform(p.key) })
  }
  for (const s of sessions) {
    if (s.id === sessionIdRef.current) continue
    list.push({ id: `sess-${s.id}`, title: `会话: ${s.title || '新对话'}`, hint: 'switch', run: () => switchSession(s.id) })
  }
  return list
}, [sessions, startNewSession, switchSession])
```
5. Search callbacks:
```tsx
const searchMessages = useCallback((q: string): SearchHit[] => {
  const query = q.trim().toLowerCase()
  if (!query) return []
  const hits: SearchHit[] = []
  messages.forEach((m, index) => {
    if (m.content.toLowerCase().includes(query)) {
      const at = m.content.toLowerCase().indexOf(query)
      hits.push({ index, preview: m.content.slice(Math.max(0, at - 12), at + 40).replace(/\n/g, ' ') })
    }
  })
  return hits
}, [messages])

const scrollToMessage = useCallback((index: number) => {
  const el = listRef.current?.children[index] as HTMLElement | undefined
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el?.animate([{ background: 'var(--glow-soft)' }, { background: 'transparent' }], { duration: 1200 })
}, [])
```
6. Render the palette (anywhere in the root, e.g. just before the closing `</div>` of the root flex column):
```tsx
{paletteOpen && (
  <CommandPalette
    commands={paletteCommands}
    onClose={() => setPaletteOpen(false)}
    onSearch={searchMessages}
    onPickSearch={scrollToMessage}
  />
)}
```

Note: `scrollToMessage` uses `listRef.current?.children[index]`. The message list maps `messages` directly to `MessageView` (one child per message, plus the empty-state placeholder ONLY when `messages.length === 0`). Since the placeholder and the list are mutually exclusive, child index === message index. Verify this holds after Task 12's layout (the empty-state block is inside the same scroll container only when there are no messages).

- [ ] **Step 3: Type-check + build**

Run from `extension/`:
```bash
npx tsc --noEmit
npm run build
```
Expected: no errors; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add extension/src/sidebar/CommandPalette.tsx extension/src/sidebar/App.tsx
git commit -m "feat(sidebar): Cmd+K command palette with command + search modes"
```

---

## Task 12: Reskin the App.tsx layout shell + glow picker + boot animation

**Files:**
- Modify: `extension/src/sidebar/App.tsx`

Final pass: replace the root container + header + platform rail + empty state + input with terminal-punk styling, add the glow picker dropdown to the header, apply CRT overlay classes, and wire `useGlow`.

- [ ] **Step 1: Wire useGlow + import GLOW_COLORS**

In `extension/src/sidebar/App.tsx`:
1. Add imports: `import { useGlow } from './use-glow'` and `import { GLOW_COLORS } from './glow'`
2. Inside `App()`, near the top with other hooks: `const [glow, setGlow] = useGlow()`
3. Add local state for the picker dropdown: `const [glowMenuOpen, setGlowMenuOpen] = useState(false)`

- [ ] **Step 2: Replace the root container**

Change the root `<div>` (old line 1093) from:
```tsx
<div className="flex flex-col h-screen bg-gray-950 text-gray-100 font-sans">
```
to:
```tsx
<div className="flex flex-col h-screen crt-scanlines crt-grain" style={{ background: 'var(--bg)', color: 'var(--txt)' }}>
```

- [ ] **Step 3: Replace the header**

Replace the entire header block (old lines 1094–1118) with:
```tsx
{/* ── Header ── */}
<div className="boot boot-1 flex items-center justify-between px-3 py-2 border-b flex-shrink-0" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
  <div className="flex items-center gap-2 min-w-0">
    <span className="glow-text">⌁</span>
    <span className="text-sm font-medium glow-text">PIERCODE</span>
    <span className="text-[11px] truncate" style={{ color: 'var(--dim)' }}>
      //{sessions.find(s => s.id === sessionIdRef.current)?.title || 'new'}
    </span>
  </div>
  <div className="flex items-center gap-2 relative">
    {sessions.length > 0 && (
      <select value={sessionIdRef.current} onChange={e => switchSession(e.target.value)}
        className="rounded-sm px-1 py-0.5 text-[10px] outline-none max-w-[110px] border"
        style={{ background: 'var(--panel-2)', borderColor: 'var(--line)', color: 'var(--txt)' }} title="切换会话">
        {sessions.map(s => <option key={s.id} value={s.id}>{s.title || '新对话'}</option>)}
      </select>
    )}
    <button onClick={startNewSession} className="text-[12px] cursor-pointer" style={{ color: 'var(--dim)' }} title="新对话">＋</button>
    {/* glow picker */}
    <button onClick={() => setGlowMenuOpen(o => !o)} className="w-3 h-3 rounded-full border" style={{ background: 'var(--glow)', borderColor: 'var(--line)' }} title="主题色" />
    {glowMenuOpen && (
      <div className="absolute right-0 top-6 z-[55] rounded-sm border p-1 flex gap-1" style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
        {GLOW_COLORS.map(g => (
          <button key={g.key} onClick={() => { setGlow(g.key); setGlowMenuOpen(false) }}
            className={`w-4 h-4 rounded-full border ${glow === g.key ? 'glow-border' : ''}`}
            style={{ background: g.hex, borderColor: 'var(--line)' }} title={g.label} />
        ))}
      </div>
    )}
    <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'dot-live' : ''}`} style={{ background: connected ? undefined : '#7a2a2a' }} />
    <span className="text-[10px]" style={{ color: 'var(--dim)' }}>{connected ? 'live' : 'off'}</span>
    {messages.length > 0 && (
      <button onClick={removeCurrentSession} className="text-[11px] cursor-pointer" style={{ color: 'var(--dim)' }} title="删除当前对话">✕</button>
    )}
  </div>
</div>
```
(The old `<ConnectionInfo connected={connected} />` line was already removed in Task 9.)

- [ ] **Step 4: Replace the platform rail**

Replace the platform selector block (old lines 1124–1154) with:
```tsx
{/* ── Platform rail ── */}
<div className="boot boot-2 flex items-center gap-2 px-3 py-1.5 border-b flex-shrink-0 overflow-x-auto text-xs" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
  {PLATFORMS.map(p => {
    const on = platform === p.key
    return (
      <button key={p.key} onClick={() => setPlatform(p.key)}
        className={`whitespace-nowrap cursor-pointer pb-0.5 border-b-2 ${on ? 'glow-text' : ''}`}
        style={{ borderColor: on ? 'var(--glow)' : 'transparent', color: on ? undefined : 'var(--dim)' }}>
        {on ? '> ' : ''}{p.label.toLowerCase()}
      </button>
    )
  })}
  {models.length > 0 ? (
    <select value={model} onChange={e => handleModelChange(e.target.value)}
      className="ml-auto w-40 rounded-sm px-1 py-0.5 text-[11px] outline-none border"
      style={{ background: 'var(--panel-2)', borderColor: 'var(--line)', color: 'var(--txt)' }}>
      {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  ) : (
    <input value={model} onChange={e => handleModelChange(e.target.value)} placeholder="model"
      className="ml-auto w-36 rounded-sm px-2 py-0.5 text-[11px] outline-none border"
      style={{ background: 'var(--panel-2)', borderColor: 'var(--line)', color: 'var(--txt)' }} />
  )}
</div>
```

- [ ] **Step 5: Restyle the empty state + pinned region in the message list**

Replace the empty-state block (old lines 1158–1176) and add a pinned region above the message map. The scroll container becomes:
```tsx
{/* ── Messages ── */}
<div ref={listRef} className="boot boot-3 flex-1 overflow-y-auto chat-scroll py-2">
  {messages.length === 0 && (
    <div className="flex flex-col items-center justify-center h-full text-xs gap-3 px-4" style={{ color: 'var(--dim)' }}>
      <pre className="glow-text text-[10px] leading-tight select-none">{`  ___ _           ___         _
 | _ (_)___ _ _ / __|___  __| |___
 |  _/ / -_) '_| (__/ _ \\/ _\` / -_)
 |_| |_\\___|_|  \\___\\___/\\__,_\\___|`}</pre>
      <span>选择平台，输入命令开始</span>
      <div className="text-center space-y-1 max-w-[260px] text-[11px]">
        <p>⌁ 首条消息自动注入系统提示词</p>
        <p>/skills · @文件 · @@子agent</p>
        <p>Cmd/Ctrl+K 打开指令面板</p>
        <p className="text-[10px] mt-2">Enter 发送 · Shift+Enter 换行</p>
      </div>
      {!connected && (
        <div className="mt-2 text-[10px] text-amber-500 text-center">⚠ 未连接 PierCode 服务<br/>请在扩展弹窗配置 Token</div>
      )}
    </div>
  )}
  {messages.map((msg, i) => (
    <MessageView key={i} msg={msg}
      onRegenerate={msg.role === 'assistant' && !msg.streaming ? handleRegenerate : undefined}
      onTogglePin={() => togglePin(i)} />
  ))}
</div>
```
Pinned region — render ABOVE the scroll container (so it stays fixed), only when pins exist:
```tsx
{messages.some(m => m.pinned) && (
  <div className="flex-shrink-0 px-3 py-1 border-b text-[11px] space-y-0.5 max-h-24 overflow-y-auto chat-scroll" style={{ borderColor: 'var(--line)', background: 'var(--panel-2)' }}>
    {messages.map((m, i) => m.pinned ? (
      <button key={i} onClick={() => scrollToMessage(i)} className="block w-full text-left truncate cursor-pointer" style={{ color: 'var(--dim)' }}>
        <span className="glow-text">★</span> {m.content.slice(0, 50).replace(/\n/g, ' ')}
      </button>
    ) : null)}
  </div>
)}
```
Place this pinned region between the WorkerRadar and the message scroll container.

- [ ] **Step 6: Restyle the input block**

Replace the input container (old lines 1219–1245) with:
```tsx
{/* ── Input ── */}
<div className="boot boot-4 flex-shrink-0 border-t p-2 relative" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
  {pickerItems.length > 0 && (
    <Picker items={pickerItems} onSelect={handlePickerSelect} onClose={handlePickerClose} />
  )}
  <div className="flex gap-2 items-end">
    <span className="glow-text pb-2 select-none">▌</span>
    <textarea ref={inputRef} value={input} onChange={handleInputChange} onKeyDown={handleKeyDown}
      placeholder={connected ? 'type command…  / @ 技能文件' : '请先连接 PierCode 服务'} rows={1}
      className="flex-1 rounded-sm px-2 py-2 text-sm outline-none resize-none overflow-hidden border"
      style={{ background: 'var(--panel-2)', borderColor: 'var(--line)', color: 'var(--txt)', maxHeight: '120px' }} />
    {streaming ? (
      <button onClick={handleCancel} className="px-3 py-2 text-sm rounded-sm cursor-pointer flex-shrink-0 text-red-300 border border-red-800/50" title="停止生成">■</button>
    ) : (
      <button onClick={handleSend} disabled={!input.trim() || !connected}
        className="px-3 py-2 text-sm rounded-sm cursor-pointer flex-shrink-0 glow-border disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ color: 'var(--glow)' }} title="发送 (Enter)">⏎</button>
    )}
  </div>
</div>
```

- [ ] **Step 7: Restyle remaining inline pieces (sub-agent stack, question card, error bar)**

- The error bar (old lines 1207–1213): change `bg-red-900/30 border-t border-red-800/40 text-red-300` container to keep red semantics but swap base classes for `style={{ background: 'rgba(120,20,20,.2)' }}` + `border-t` with `borderColor: 'var(--line)'`. Keep the `✕` dismiss.
- The sub-agent bottom stack wrapper (old lines 1187–1193, already given DOM ids in Task 8): change `bg-gray-950/60 border-gray-800/40` to `style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}` + `border-t`.
- `SubAgentCard` (definition ~541): swap `bg-gray-900/60 border-gray-800` → inline `style={{ background: 'var(--panel-2)', borderColor: 'var(--line)' }}`, `text-purple-300` → `glow-text`, gray text → `var(--dim)`.
- `QuestionCard` (~379): swap amber/gray Tailwind for terminal palette — `border-amber-600/40 bg-amber-900/10` → keep amber accent via `style={{ borderColor: 'var(--line)', background: 'var(--panel-2)' }}`; option buttons `bg-gray-800 border-gray-700` → `style={{ background: 'var(--panel)', borderColor: 'var(--line)', color: 'var(--txt)' }}`; submit button amber → `glow-border` + `style={{ color: 'var(--glow)' }}`.

- [ ] **Step 8: Type-check + full test suite + build**

Run from `extension/`:
```bash
npx tsc --noEmit
npm test
npm run build
```
Expected: tsc clean; ALL vitest suites pass (no regression in sidebar-*, content-build, token-*, etc.); build succeeds.

- [ ] **Step 9: Commit**

```bash
git add extension/src/sidebar/App.tsx
git commit -m "feat(sidebar): terminal-punk layout shell, glow picker, boot animation"
```

---

## Task 13: Manual verification

**Files:** none (load the unpacked extension).

- [ ] **Step 1: Build + load**

Run from `extension/`:
```bash
npm run build
```
Load `extension/dist/` as an unpacked extension in Chrome (or reload it), open the side panel on a supported AI tab.

- [ ] **Step 2: Verify visuals**

Confirm: IBM Plex Mono renders (monospace everywhere); scanline + grain overlays visible but subtle; boot stagger plays on open; connection dot pulses in glow color; cursor `▌` blinks in the input.

- [ ] **Step 3: Verify glow picker**

Click the glow swatch in the header → pick each of the 4 colors → all glow elements (text, borders, dot, tool `◆`) recolor live. Reload the panel → the chosen color persists.

- [ ] **Step 4: Verify command palette + search**

Press `Cmd/Ctrl+K` → palette opens, input focused. Type a platform name → filtered → Enter switches platform. `Tab` → search mode → type a word present in a message → results list → Enter scrolls + flashes the message. `Esc` closes.

- [ ] **Step 5: Verify pin**

Hover a message → click `☆ pin` → a pinned region appears above the stream with that message; click it → scrolls to the message. Reload → pin persists (session-store). Unpin → region updates.

- [ ] **Step 6: Verify worker radar + HUD**

Trigger a sub-agent (`@@review` or a `spawn_agent` flow). Confirm the radar chip bar appears under the platform rail with `@label` + status mark; running shows pulsing `▸▸`; clicking a chip scrolls to its detail card. Bottom HUD shows `live`, root dir basename, token mini-bar filling, and `⚙N` while an agent runs.

- [ ] **Step 7: Verify no functional regression**

Send a normal message → streaming works, tool cards execute and show `[run]`→`[done]`, results inject, token panel updates, regenerate works, new/switch/delete session works.

- [ ] **Step 8: Final commit (if any tweaks made during manual verify)**

```bash
git add -A
git commit -m "fix(sidebar): manual-verification polish for terminal-punk redesign"
```

---

## Self-Review Notes (completed during planning)

- **Spec coverage:** terminal aesthetic (T4), font bundle (T1), glow picker + 4 colors + persistence (T2/T3/T12), command palette (T10/T11), search (T11), pin + persistence (T6/T7), worker radar (T8), status HUD (T9), App.tsx extraction into MessageView/ToolCard/WorkerRadar/StatusHUD (T5/T6/T8/T9), CSS isolation guard re-checked (T4 step 5). All spec sections mapped.
- **Type consistency:** `ChatMessage` defined once in `MessageView.tsx` (with `pinned?`), re-imported by App; `ToolCall`/`ToolResult` defined in `ToolCard.tsx`, re-exported via MessageView; `SubAgent` in `WorkerRadar.tsx`; `Command`/`SearchHit` in `commands.ts`/`CommandPalette.tsx`. `Glow` from `glow.ts`. No name drift across tasks.
- **Placeholder scan:** every code step shows full code; no TBD/TODO.
- **Risk — child-index === message-index** for `scrollToMessage`: noted inline in T11 step 2; holds because empty-state and message map are mutually exclusive children of `listRef`.
```
