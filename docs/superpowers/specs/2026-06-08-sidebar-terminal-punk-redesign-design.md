# PierCode Sidebar — Terminal-Punk Redesign

**Date:** 2026-06-08
**Status:** Approved (design), pending implementation plan
**Scope:** Visual reskin + layout restructure + new features (maximum scope)

## Goal

Replace the generic dark-gray/blue "AI slop" chat sidebar (`extension/src/sidebar/`)
with a distinctive, production-grade **terminal-punk** interface: monospace, phosphor
glow, CRT/scanline texture, hacker-tool aesthetic that fits PierCode's code-proxy
identity. Add four new capabilities. Preserve all existing business logic (fetch / WS /
streaming / exec / sessions); change only the render layer and add new components.

## Non-Goals

- No change to data flow: HTTP/WS proxy, stream handling, tool execution, session
  persistence logic stay as-is.
- No new platform adapters, no server-side changes.
- No light theme (dark-only, per decision).

## Aesthetic Direction — Terminal-Punk

Chosen over editorial / glass-aurora / neo-brutalist. Dark CRT terminal with a
switchable phosphor glow color.

### Design tokens (CSS variables, in `theme.css`)

```
font:   IBM Plex Mono (display + body, all monospace) — bundled locally as woff2
        (CSP forbids external font CDNs).
color:  --bg #0a0e0a   --panel #0d130d   --line #1a2a1a
        --dim #5a6a5a  --txt #c8d8c8
        --glow (switchable via data-glow attr on root):
          green   #39FF14  (default)
          amber   #FFB000
          cyan    #00E5FF
          magenta #FF2D95
texture: scanline overlay (faint repeating-linear-gradient)
         CRT micro-glow (text-shadow on --glow elements)
         grain noise (inline SVG turbulence, ~2% opacity, fixed-position)
         glowing borders (inset + outer box-shadow on focus/active)
motion:  boot sequence (staggered top→bottom reveal on mount)
         blinking cursor ▌, slow scanline sweep
         streaming "typing" afterglow on the active assistant message
```

### Glow color picker

Header dropdown, 4 colors. Persists to `chrome.storage.local` key `sidebarGlow`.
Sets `data-glow="green|amber|cyan|magenta"` on the root element; CSS variable
`--glow` switches accordingly. New `use-glow.ts` hook reads/writes storage and
applies the attribute.

## Layout (top → bottom)

```
HEADER BAR     ⌁PIERCODE //<session>   ◉live   [glow▾]
WORKER RADAR   @worker-1 ▸▸run  @scan ✓done  @fix ✗fail     (only when subAgents present)
PLATFORM RAIL  > qwen · gpt · claude · openai      model▾
MESSAGE STREAM user ▸ … / ◆ tool cards / 📌 pinned-pin region / streaming afterglow
TODO / TOKEN   collapsible panels (existing)
INPUT          ▌_ type command…                     ⏎ send
STATUS HUD     ◉ck · 📁<root> · ▓▓▓░ 12.4k/200k · ⚙<n active agents>
```

Command Palette overlays the whole sidebar on `Cmd/Ctrl+K`.

- **User messages:** drop the chat bubble; use a `▸` prefix and right/left alignment
  with monospace, terminal-log feel.
- **Tool cards:** diamond `◆` marker, monospace, `[run]`/`[done]`/`[fail]` status
  badge; keep collapse/expand.
- **Connection dot:** pulses in the current glow color.

## New Features

| Feature | Implementation | Hooks into existing |
|---|---|---|
| **Command Palette** | New `CommandPalette.tsx`; `Cmd/Ctrl+K` listener; fuzzy-filter a command list; Enter executes. Has a `search` sub-mode. | Calls existing `startNewSession`, `setPlatform`, session switch, `setMessages([])` (clear). |
| **Search & Pin** | Search: palette `mode='search'` filters `messages`, highlights + scrolls to match. Pin: add `pinned?: boolean` to `ChatMessage`; render a pinned region at top of stream; toggle from message hover actions. | Reuses `messages` state; persists via `session-store`. |
| **Worker Radar** | New `WorkerRadar.tsx` consumes existing `subAgents` state; status pulse chips (run/done/fail); click scrolls to that agent's card. | Consumes `subAgents` (already exists). |
| **Status HUD** | New `StatusHUD.tsx` aggregates `connected`, rootDir (from SystemInfo), token count, `subAgents.length`. Live-updating bottom bar. | Reuses `connected`, SystemInfo fetch, `token-count`, `subAgents`. |
| **Glow picker** | Header dropdown, writes `storage.sidebarGlow`, root `data-glow`, CSS var switch. | New small storage key; `use-glow.ts`. |

## Architecture & Boundaries

`App.tsx` is 1248 lines — too large. Use this redesign to extract render-layer units
into focused files, each with one clear purpose, so the main file holds orchestration
only. Business logic (fetch/WS/stream/exec/session effects) stays in `App.tsx`.

### Constraints

- Do **not** touch `App.tsx` business logic (fetch / WS / stream / exec / session
  effects); only restructure the render layer and add new state for `pinned` + palette
  open/mode.
- Font bundled locally as woff2 (no external link — CSP).
- Keep `.msg-content` markdown styles (recolor to terminal palette, keep structure).
- New components are separate files (improves boundaries: message / tool / worker /
  HUD render extracted from `App.tsx`).

## File Changes

```
new:
  sidebar/theme.css            design tokens + scanline/grain/glow/boot animations
  sidebar/CommandPalette.tsx   Cmd+K palette (incl. search mode)
  sidebar/WorkerRadar.tsx      sub-agent status chips
  sidebar/StatusHUD.tsx        bottom status bar
  sidebar/MessageView.tsx      message render extracted from App.tsx
  sidebar/ToolCard.tsx         tool card extracted from App.tsx
  sidebar/use-glow.ts          glow color hook + storage
  sidebar/fonts/               IBM Plex Mono woff2 files
change:
  sidebar/App.tsx              new layout skeleton; wire new components; add pinned + palette state
  sidebar/index.css            import theme.css; recolor to terminal palette
  sidebar/session-store.ts     persist `pinned` on StoredSession (minor)
```

## Data Model Changes

- `ChatMessage` gains `pinned?: boolean`.
- `StoredSession` persists `pinned` flags (no migration needed — absent = false).
- New `chrome.storage.local` key `sidebarGlow: 'green'|'amber'|'cyan'|'magenta'`
  (default `green` when absent).

## Testing / Acceptance

- `npx tsc --noEmit` passes.
- `npm test` (vitest) — existing suites unbroken (conversation-scope, token-count, etc.).
- `npm run build` succeeds.
- Manual: `Cmd+K` opens palette; glow color switch persists; worker radar updates with
  `subAgents`; token HUD live; scanline + boot animations render; pin/search work.

## Risks

- **Font bundle size:** ship only the weights used (regular + medium/bold) to keep
  `sidebar.js`/assets lean.
- **CSS leak:** sidebar is its own Vite entry; `theme.css` scoped to the sidebar entry,
  must not bleed into classic `content.js` (prior incident: tiktoken/css chunk leak —
  see memory). Keep sidebar CSS self-contained.
- **App.tsx extraction:** extracting render units must not alter closure access to
  state/handlers — pass via props, verify with tsc + tests.
