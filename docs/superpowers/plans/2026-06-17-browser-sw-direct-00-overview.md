# browser_* SW-Direct Migration — Overview & Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each phase plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Move all 44 `browser_*` tools from Go-server execution (`/exec` → WS → CDP) to direct execution inside the Chrome extension Service Worker (SW), then delete the Go browser controller.

**Architecture:** The WS protocol is confirmed **low-level CDP** — Go just ships `{domain,method,params}` to `chrome.debugger.sendCommand`. So ~4,900 LOC of orchestration in `internal/browser/controller*.go` must be ported to TS in a new `extension/src/background/browser/` module tree. The SW already owns `chrome.debugger`, so RelayManager (~220 LOC) and multi-browser routing disappear. Each SW only sees its own browser's tabs → cross-browser race is solved structurally.

**Strategy: A (full migration, no Go fallback).** Discipline: per phase, port TS + vitest coverage FIRST, then flip the route, then `tsc + vitest + go test + build` all green, THEN delete the corresponding Go. Never delete Go before TS coverage lands.

**Tech Stack:** TypeScript, Chrome MV3 SW, `chrome.debugger` CDP, Vitest (mock `chrome.debugger.sendCommand`), `tldts` (JS public-suffix), `OffscreenCanvas` (image downscale), a JS GIF encoder.

**Spec:** [2026-06-17-browser-sw-direct-execution-design.md](../specs/2026-06-17-browser-sw-direct-execution-design.md)

---

## Phase Plans (execute in order)

| Phase | Plan | Scope | Gate |
|---|---|---|---|
| 0 | [01-phase0-infra](2026-06-17-browser-sw-direct-01-phase0-infra.md) | Core infra: cdp/registry/ref-resolve/security/events/approval/dispatch/types. No route flip. | tsc+vitest+go test+build green (Go untouched) |
| 1 | [02-phase1-readonly](2026-06-17-browser-sw-direct-02-phase1-readonly.md) | 13 read-only tools end-to-end on new chain (snapshot/screenshot/find/console/network/get_content/get_page_text/pdf/record/wait/wait_for_function/get_attributes/tabs). Flip both routes for these. Delete their Go. | 4 green + cross-browser + Go-less manual verify |
| 2 | [03-phase2-interactive](2026-06-17-browser-sw-direct-03-phase2-interactive.md) | 20 interactive tools + approval-flow SW-ification (click/type/hover/scroll/select/press_key/drag/focus/navigate/new_tab/use_tab/go_back/go_forward/reload/mark/handle_dialog/wait_for_navigation/resize/viewport/emulate). | 4 green + approval-card verify |
| 3 | [04-phase3-write](2026-06-17-browser-sw-direct-04-phase3-write.md) | 11 write/high-risk tools (evaluate/upload/clipboard/cookies/set_cookie/storage/form_input/zoom/finalize_tabs/downloads/batch) + final Go deletion + audit move. | 4 green + full E2E Go-less |

**Tool count check:** 13 + 20 + 11 = 44. ✓

---

## Shared Conventions (all phases follow these)

### Message contract: content/sidebar → SW
```ts
// content/index.ts and background/browser-agent.ts send:
chrome.runtime.sendMessage({ type: 'EXEC_BROWSER_TOOL', name, args, callId, conversationUrl })
// SW responds via sendResponse:
{ output: string, error?: string, name: string, callId: string }
```
The handler lives in the `chrome.runtime.onMessage.addListener` chain at `extension/src/background/index.ts:1024+` (alongside existing `if (msg.type === 'FETCH')` blocks). It returns `true` to keep the channel open for the async response.

### Module tree (created across phases)
```
extension/src/background/browser/
  dispatch.ts        # tool name → controller method + per-tab lock + security/approval gates   [Phase 0]
  controller.ts      # 44 tool methods                                                          [Phase 0 skeleton, filled 1-3]
  cdp.ts             # runtimeEvaluate / callFunctionOn / sendCommand wrappers                   [Phase 0]
  registry.ts        # TabRegistry: defaultID/tabs/snapshots(refs,staleness)/approved/...        [Phase 0]
  ref-resolve.ts     # resolveRef/resolveSelector/resolvePoint/boxModelBounds/OOPIF             [Phase 0]
  security.ts        # CheckNavigate/IsAIPage/IsSensitive/registrableDomain                      [Phase 0]
  events.ts          # EventBus console/network ring + dialog/nav waiters                        [Phase 0]
  approval.ts        # ApprovalManager pending-Promise map + grants + action-class               [Phase 0]
  types.ts           # request/response interfaces                                              [Phase 0]
  snapshot.ts        # AX tree → compact text                                                   [Phase 1]
  find.ts            # element scoring                                                           [Phase 1]
  image.ts           # screenshot budget (OffscreenCanvas) + GIF + PDF base64                   [Phase 1]
  in-page-js.ts      # embedded page JS strings (getContent/storage/form/select/attr/waitFor)   [Phase 1-3]
  input.ts           # dispatchClick/moveTo/typedKeys/keyChord/wheel/drag + fidelity            [Phase 2]
  marks.ts           # enumerateInteractive + SVG overlay                                        [Phase 2]
```

### Go behavior is the spec
The Go controller tests (`internal/browser/controller_*_test.go`, ~3500 LOC) are the **behavioral spec** for the port. When porting a method, open its Go test and mirror the assertions in vitest. Never delete a Go test until its TS vitest equivalent passes.

### Per-phase deletion checklist
After a phase's tools work on the new chain and all 4 checks are green:
1. Remove those tools from `executor.go` registration (`New()`).
2. Delete the corresponding `internal/tool/browser_tools*.go` tool structs.
3. Delete the corresponding controller methods + their now-unused Go helpers.
4. Delete the corresponding `internal/browser/*_test.go` (replaced by vitest).
5. Re-run `go test ./... && go build ./cmd/server` — green.

The final `BrowserController` interface removal + `internal/browser/` directory deletion + WS `browser_cmd` cleanup happens in Phase 3.

### Three confirmed decisions (from spec review)
- `browser_upload` local-path upload → degraded to in-page DataTransfer/drop (SW has no filesystem). Local-path arg becomes unsupported.
- Guidance injection (every-N-calls) → **not** ported in v1 (browser turns carry no operating reminder). Noted as follow-up.
- WS browser channel cleanup → conservative; delete only browser-related (`browser_cmd`/`browser_result`/`browser_event`/`browser_approval_*`). Keep WS for inject/agent callbacks.
