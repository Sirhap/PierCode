# Phase 3: Write/High-Risk Tools + Final Go Teardown

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Port the final 11 write/high-risk `browser_*` tools to TS, then completely remove the Go browser controller, delete the `/exec` browser route, clean up the WS browser channel, and move browser audit logging to the SW side. After this phase, `browser_*` never touches Go.

**Write/high-risk tools (11):** `browser_evaluate`, `browser_upload`, `browser_clipboard`, `browser_cookies`, `browser_set_cookie`, `browser_storage`, `browser_form_input`, `browser_zoom`, `browser_finalize_tabs`, `browser_downloads`, `browser_batch`.

**Architecture:** Add the 11 methods to `controller.ts` (high-risk ones go through the evaluate/cookie/clipboard/upload action-class approval already built in Phase 2). `browser_batch` re-dispatches sub-calls in-process via `dispatchBrowserTool`. `browser_upload` degrades to in-page DataTransfer/drop (SW has no filesystem; local-path arg unsupported). Then tear down all Go browser code, the `BrowserController` interface, the `/exec` browser branch, and the WS `browser_cmd`/`browser_result`/`browser_event`/`browser_approval_*` handlers.

**Prerequisite:** [Phase 2](2026-06-17-browser-sw-direct-03-phase2-interactive.md) complete and green.

---

## File Structure (this phase)

- Modify: `extension/src/background/browser/controller.ts` — add 11 methods
- Modify: `extension/src/background/browser/in-page-js.ts` — add `storageExpr`/`formInputExpr`/`selectExpr`/`clipboardExpr`/`uploadDataTransferExpr`
- Modify: `extension/src/background/browser/dispatch.ts` — register the 11
- Modify: `extension/src/content/index.ts` + `browser-agent.ts` — final SW-routed set = all 44
- **Delete (Go teardown):** `internal/browser/*.go` (all), `internal/tool/browser_tools*.go`, `BrowserController` interface + browser fields in `tool.go`, browser registration in `executor.go`, browser branch in `/exec` + WS handlers in `internal/server/`
- Modify: audit — SW emits browser actions to extension console / sidebar `ActionTimeline.tsx`

---

## Task 3.1: in-page-js additions for write tools

**Files:**
- Modify: `extension/src/background/browser/in-page-js.ts`
- Test: extend `extension/src/__tests__/browser-sw/in-page-js.test.ts`

Port `storageExpression` (controller_state.go:13), the `FormInput` setter JS (controller_find.go:206, native-setter for checkbox/radio/text/contenteditable), the `Select` setter (controller_ext.go:300), the clipboard async-API read/write (controller.go:669), and a DataTransfer-based upload injector (replacing the filesystem upload).

- [ ] **Step 1: Add failing tests**

```ts
// extension/src/__tests__/browser-sw/in-page-js.test.ts  (append)
import { storageExpr, formInputExpr, clipboardReadExpr } from '../../background/browser/in-page-js'

it('storageExpr: get/set/remove/clear/keys for local|session', () => {
  expect(storageExpr('local', 'get', 'k')).toContain('localStorage')
  expect(storageExpr('session', 'set', 'k', 'v')).toContain('sessionStorage')
})
it('formInputExpr: uses native value setter (React-safe)', () => {
  expect(formInputExpr('#in', 'text', 'hi')).toContain('nativeInputValueSetter')
})
it('clipboardReadExpr: navigator.clipboard.readText', () => {
  expect(clipboardReadExpr()).toContain('navigator.clipboard')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/in-page-js.test.ts`
Expected: FAIL — new exports not found.

- [ ] **Step 3: Implement**

```ts
// extension/src/background/browser/in-page-js.ts  (append)
export function storageExpr(area: 'local' | 'session', op: string, key?: string, value?: string): string {
  const store = area === 'session' ? 'sessionStorage' : 'localStorage'
  switch (op) {
    case 'get': return `(() => ${store}.getItem(${JSON.stringify(key)}))()`
    case 'set': return `(() => { ${store}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); return 'ok'; })()`
    case 'remove': return `(() => { ${store}.removeItem(${JSON.stringify(key)}); return 'ok'; })()`
    case 'clear': return `(() => { ${store}.clear(); return 'ok'; })()`
    case 'keys': return `(() => Object.keys(${store}))()`
    default: return `(() => { throw new Error('bad storage op'); })()`
  }
}

export function formInputExpr(selector: string, kind: 'text' | 'checkbox' | 'radio' | 'contenteditable', value: string): string {
  // Port controller_find.go FormInput: use the native setter so React/Vue see the change.
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not found';
    const kind = ${JSON.stringify(kind)}; const value = ${JSON.stringify(value)};
    if (kind === 'checkbox' || kind === 'radio') { el.checked = (value === 'true' || value === '1');
      el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; }
    if (kind === 'contenteditable') { el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    nativeInputValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`
}

export function selectExpr(selector: string, by: 'value' | 'label' | 'index', target: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not found';
    const by = ${JSON.stringify(by)}; const t = ${JSON.stringify(target)};
    const opts = Array.from(el.options);
    let opt = by === 'index' ? opts[parseInt(t, 10)]
      : by === 'label' ? opts.find(o => o.text.trim() === t)
      : opts.find(o => o.value === t);
    if (!opt) return 'option not found';
    el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok';
  })()`
}

export function clipboardReadExpr(): string { return `(async () => await navigator.clipboard.readText())()` }
export function clipboardWriteExpr(text: string): string {
  return `(async () => { await navigator.clipboard.writeText(${JSON.stringify(text)}); return 'ok'; })()`
}

// Upload via in-page DataTransfer (replaces filesystem upload; bytes come as base64 from caller).
export function uploadDataTransferExpr(selector: string, fileName: string, base64: string, mime: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'not found';
    const bin = atob(${JSON.stringify(base64)}); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mime)} });
    const dt = new DataTransfer(); dt.items.add(file);
    el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok';
  })()`
}
```

- [ ] **Step 4: Run test + type-check**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/in-page-js.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/browser/in-page-js.ts extension/src/__tests__/browser-sw/in-page-js.test.ts
git commit -m "feat(ext/browser): write-tool in-page JS (storage/form/select/clipboard/upload)"
```

---

## Task 3.2: 11 write/high-risk controller methods + register

**Files:**
- Modify: `extension/src/background/browser/controller.ts`
- Modify: `extension/src/background/browser/dispatch.ts`
- Test: `extension/src/__tests__/browser-sw/controller-write.test.ts`

Add the 11 methods. High-risk ones (`evaluate`/`clipboard`/`cookies`/`set_cookie`/`upload`) approval-gate via their action-class (built in Phase 2 `runGates`/`APPROVAL_TOOLS`). `evaluate` wraps the expression + serializes (port controller_ext.go:183). `cookies`/`set_cookie`/`downloads`/`finalize_tabs` use the `PierCode` native commands via `chrome.cookies`/`chrome.downloads`/`chrome.tabs` directly. `zoom` captures a region screenshot → base64 (port controller_find.go:61, write to filesystem replaced by dataURL). `batch` re-dispatches.

- [ ] **Step 1: Write the failing test (batch + evaluate)**

```ts
// extension/src/__tests__/browser-sw/controller-write.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
beforeEach(() => {
  ;(globalThis as any).chrome = {
    debugger: { sendCommand: vi.fn(), attach: vi.fn(async () => {}), getTargets: vi.fn(async () => []) },
    tabs: { query: vi.fn(async () => [{ id: 1, url: 'https://x.com', title: 'X' }]),
            get: vi.fn(async () => ({ id: 1, url: 'https://x.com', title: 'X' })) },
    cookies: { getAll: vi.fn(async () => [{ name: 'a', value: '1' }]) },
    runtime: { sendMessage: vi.fn() },
  }
})

describe('controller write', () => {
  it('evaluate returns the serialized result', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async (_t: any, method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value: { sum: 3 } } }
      return {}
    })
    const ctl = makeController({ send })
    const out = await ctl.evaluate({ tabId: 1, expression: '({sum:1+2})' })
    expect(out).toContain('sum')
  })
  it('batch re-dispatches sub-calls in order', async () => {
    const { makeController } = await import('../../background/browser/controller')
    const send = vi.fn(async () => ({ result: { value: 'ok' } }))
    const ctl = makeController({ send })
    const out = await ctl.batch({ tabId: 1, actions: [{ name: 'browser_get_page_text', input: {} }] })
    expect(out).toContain('browser_get_page_text')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/controller-write.test.ts`
Expected: FAIL — `evaluate`/`batch` not defined.

- [ ] **Step 3: Implement (templates; port the rest 1:1)**

```ts
// extension/src/background/browser/controller.ts  (add inside makeController return)
    async evaluate(args: { tabId?: number; expression: string }): Promise<string> {
      const tab = await ensureTab(args)
      // approval handled by dispatch gate (actionClass 'evaluate')
      const wrapped = `(() => { const __r = (${args.expression}); return JSON.stringify(__r); })()`
      const r = await cdp.runtimeEvaluate(target(tab.tabId), wrapped)
      registry.markStale(tab.tabId)
      return typeof r === 'string' ? r : JSON.stringify(r)
    },

    async storage(args: { tabId?: number; area?: 'local'|'session'; op: string; key?: string; value?: string }): Promise<string> {
      const tab = await ensureTab(args)
      const r = await cdp.runtimeEvaluate(target(tab.tabId), storageExpr(args.area ?? 'local', args.op, args.key, args.value))
      return typeof r === 'string' ? r : JSON.stringify(r)
    },

    async formInput(args: { tabId?: number; selector: string; kind: 'text'|'checkbox'|'radio'|'contenteditable'; value: string }): Promise<string> {
      const tab = await ensureTab(args)
      const r = await cdp.runtimeEvaluate(target(tab.tabId), formInputExpr(args.selector, args.kind, args.value))
      registry.markStale(tab.tabId)
      return String(r)
    },

    async clipboard(args: { tabId?: number; op: 'read'|'write'; text?: string }): Promise<string> {
      const tab = await ensureTab(args)
      const expr = args.op === 'write' ? clipboardWriteExpr(args.text ?? '') : clipboardReadExpr()
      return String(await cdp.runtimeEvaluate(target(tab.tabId), expr))
    },

    async cookies(args: { tabId?: number; url?: string }): Promise<string> {
      const tab = await ensureTab(args)
      const list = await chrome.cookies.getAll({ url: args.url ?? tab.url })
      return list.map(c => `${c.name}=${c.value}`).join('\n') || '(no cookies)'
    },

    async setCookie(args: { url: string; name: string; value: string }): Promise<string> {
      await chrome.cookies.set({ url: args.url, name: args.name, value: args.value })
      return 'ok'
    },

    async downloads(_args: {}): Promise<string> {
      const items = await chrome.downloads.search({ limit: 20 })
      return items.map(d => `${d.filename} (${d.state})`).join('\n') || '(no downloads)'
    },

    async upload(args: { tabId?: number; selector: string; fileName: string; base64: string; mime?: string }): Promise<string> {
      // SW has no filesystem: caller must supply base64 bytes (no local path).
      const tab = await ensureTab(args)
      const r = await cdp.runtimeEvaluate(target(tab.tabId),
        uploadDataTransferExpr(args.selector, args.fileName, args.base64, args.mime ?? 'application/octet-stream'))
      registry.markStale(tab.tabId)
      return String(r)
    },

    async zoom(args: { tabId?: number; ref?: string; selector?: string; x?: number; y?: number; width?: number; height?: number }): Promise<string> {
      const tab = await ensureTab(args)
      // resolve a clip rect (port controller_find.go Zoom), capture, return dataURL
      const out = await cdp.sendCommand(target(tab.tabId), 'Page', 'captureScreenshot', { format: 'png' })
      return await budgetScreenshot(out.data, 'image/png', 1200)
    },

    async finalizeTabs(args: { tabId?: number; close?: number[] }): Promise<string> {
      const ids = args.close ?? []
      for (const id of ids) { try { await chrome.tabs.remove(id) } catch {} ; registry.clearDefault(id) }
      return `finalized ${ids.length} tabs`
    },

    async batch(args: { tabId?: number; actions: Array<{ name: string; input: Record<string, unknown> }> }): Promise<string> {
      const out: string[] = []
      for (const a of args.actions) {
        const r = await dispatchBrowserTool(a.name, { tabId: args.tabId, ...a.input }, '')
        out.push(`### ${a.name}\n${r.output}`)
      }
      return out.join('\n\n')
    },
```

(Import `dispatchBrowserTool` from `./dispatch` — note this creates a controller↔dispatch cycle; break it by having `batch` take an injected dispatch fn, or move `dispatchBrowserTool` to not import controller at module top. Simplest: `batch` imports lazily `const { dispatchBrowserTool } = await import('./dispatch')`.)

- [ ] **Step 4: Register the 11**

```ts
// extension/src/background/browser/dispatch.ts  (append)
const WRITE_METHODS: Array<[string, (a: any) => Promise<string>]> = [
  ['browser_evaluate', a => controller.evaluate(a)],
  ['browser_storage', a => controller.storage(a)],
  ['browser_form_input', a => controller.formInput(a)],
  ['browser_clipboard', a => controller.clipboard(a)],
  ['browser_cookies', a => controller.cookies(a)],
  ['browser_set_cookie', a => controller.setCookie(a)],
  ['browser_downloads', a => controller.downloads(a)],
  ['browser_upload', a => controller.upload(a)],
  ['browser_zoom', a => controller.zoom(a)],
  ['browser_finalize_tabs', a => controller.finalizeTabs(a)],
  ['browser_batch', a => controller.batch(a)],
]
for (const [name, fn] of WRITE_METHODS) TOOL_TABLE.set(name, fn)
```

- [ ] **Step 5: Run test + type-check**

Run: `cd extension && npx vitest run src/__tests__/browser-sw/controller-write.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/background/browser/controller.ts extension/src/background/browser/dispatch.ts extension/src/__tests__/browser-sw/controller-write.test.ts
git commit -m "feat(ext/browser): 11 write/high-risk controller methods + register"
```

---

## Task 3.3: Flip remaining routes — all 44 SW-native

**Files:**
- Modify: `extension/src/content/index.ts` — `SW_BROWSER_TOOLS` = all 44 (or: any name starting `browser_`)
- Modify: `extension/src/background/browser-agent.ts` — already routes all `TOOL_TABLE` entries (Phase 2); confirm 11 new names are in `TOOL_TABLE`

- [ ] **Step 1: content — route all browser_* to SW**

Replace the explicit set with a prefix check (all browser tools now SW-native):

```ts
// extension/src/content/index.ts  (executeToolCallRaw)
  if (typeof toolCall.name === 'string' && toolCall.name.startsWith('browser_')) {
    const callId = getToolCallId(toolCall)
    const r: any = await new Promise(res => chrome.runtime.sendMessage(
      { type: 'EXEC_BROWSER_TOOL', name: toolCall.name, args: toolCall.args || {}, callId, conversationUrl: location.href }, res))
    if (!r) return `[PierCode] 浏览器工具无响应`
    return `### ${toolCall.name} #${callId}\n${r.output || r.error || '[PierCode] 空响应'}`
  }
```

- [ ] **Step 2: Type-check + build + content-build**

Run: `cd extension && npx tsc --noEmit && npm test`
Expected: green incl. content-build.

- [ ] **Step 3: Commit**

```bash
git add extension/src/content/index.ts
git commit -m "feat(ext/browser): route all browser_* to SW (none hit /exec)"
```

---

## Task 3.4: E2E verification — full Go-less browser automation

- [ ] **Step 1: Build + load.** Stop the Go server entirely.
- [ ] **Step 2:** In the browser-agent sidebar, run a task exercising write tools: `browser_evaluate`, `browser_storage` set/get, `browser_form_input`, `browser_cookies` (approve), `browser_batch` of 3 actions. Confirm all work with NO server running.
- [ ] **Step 3:** High-risk approval — `browser_evaluate` and `browser_cookies` each prompt their own action-class; granting `evaluate` "always" does not silently authorize `cookies`.
- [ ] **Step 4:** `browser_upload` with base64 bytes lands in a file input; confirm local-path arg is rejected with a clear message.
- [ ] **Step 5:** Cross-browser write tasks on two Chromes — no cross-talk.
- [ ] **Step 6:** Record divergences, fix in TS, re-run `npm test`.

---

## Task 3.5: Go teardown — delete the browser controller

**Files:** delete/modify across `internal/`. Do this incrementally with `go build` after each step.

- [ ] **Step 1: Unregister all browser tools in executor.go**

Remove all remaining `reg.Register(...)` for `browser_*` in `New()`. Remove `e.browser`/`SetBrowserController` and the `toolCtx.Browser = e.browser` wiring. Remove `isBrowserToolName`/`browserTabKey`/`sharedPlusKeyed` browser branches from `lockForTool` (file/shell keep their `path:*` keyed locks). Remove browser tools from `isReadOnlyTool`.

- [ ] **Step 2: Delete the tool layer**

Delete `internal/tool/browser_tools.go`, `browser_tools_ext.go`, `browser_tools_find.go`, `browser_tools_state.go`, `browser_tools_stability.go`, `browser_batch.go`. Remove the `BrowserController` interface + all browser request/response structs + `BrowserTab`/`SafeTitle`/`MarkedElement`/`SnapshotOptions` etc. from `tool.go`, and the `Browser BrowserController` field from `Context`.

- [ ] **Step 3: Delete the browser package**

Delete the entire `internal/browser/` directory (controller*.go, relay.go, registry.go, events.go, approval.go, security.go, snapshot.go, marks.go, input_fidelity.go, screenshot_*.go, types.go, and all `*_test.go`).

- [ ] **Step 4: Remove server wiring**

In `internal/server/`: remove the `browser` field, its construction, `AllowSensitiveHost`/`DeliverApproval`/`DeliverResult` calls, the `/exec` browser-dispatch branch, and the WS handlers for `browser_cmd`/`browser_result`/`browser_event`/`browser_approval_ask`/`browser_approval_answer`/`browser_approval_done`. Remove `WSManager` `tabOwners`/`RecordTabOwner`/`SendBrowserCommand`/`SendCommandFanout`/`preferSuccess` (browser-only routing). **Keep** the WS for `inject`/`agent`/`agent_result` (worker callbacks) and any non-browser use.

- [ ] **Step 5: Fix compile**

Run: `go build ./cmd/server`
Fix every reference the deletions broke (imports, types). Repeat until it builds.

- [ ] **Step 6: Go tests**

Run: `go test ./...`
Delete or update any remaining Go tests that referenced browser types. Expected: green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(server): remove Go browser controller + /exec browser route + WS browser channel"
```

---

## Task 3.6: Move browser audit to SW side

**Files:**
- Modify: `extension/src/background/browser/dispatch.ts` — log each tool call
- Modify: `extension/src/sidebar/ActionTimeline.tsx` — already shows browser actions for the browser-agent route; confirm it captures the SW-dispatched calls

- [ ] **Step 1: Emit an audit line per dispatched tool**

In `dispatchBrowserTool`, after the method resolves, `console.debug` + broadcast a lifecycle event the sidebar timeline already consumes:

```ts
// extension/src/background/browser/dispatch.ts  (in dispatchBrowserTool, after method runs)
  try { chrome.runtime.sendMessage({ type: 'BROWSER_AGENT_TOOL_AUDIT', name, args, callId, ok: true }) } catch {}
```

- [ ] **Step 2: Confirm the sidebar timeline renders it**

`ActionTimeline.tsx` / `browser-agent-store.ts` already track `BROWSER_AGENT_TOOL` events; ensure the audit event is reflected (or fold into the existing event). No new UI needed if the existing timeline covers it.

- [ ] **Step 3: Type-check + build + commit**

```bash
cd extension && npx tsc --noEmit && npm run build
cd .. && git add extension/src/background/browser/dispatch.ts extension/src/sidebar/ActionTimeline.tsx
git commit -m "feat(ext/browser): SW-side browser audit to sidebar timeline"
```

---

## Task 3.7: Final gate — everything green, browser fully SW-native

- [ ] **Step 1:** `go test ./... && go build ./cmd/server` — green (no browser code left in Go).
- [ ] **Step 2:** `cd extension && npx tsc --noEmit && npm test` — green (all `browser-sw/*` suites + content-build).
- [ ] **Step 3:** `git grep -n "browser_cmd\|BrowserController\|internal/browser" -- '*.go'` — no matches (Go browser code gone).
- [ ] **Step 4:** `git grep -n "/exec" extension/src/background/browser-agent.ts extension/src/content/index.ts` — no browser tool POSTs `/exec` (file/shell still may, which is correct).
- [ ] **Step 5: Update CLAUDE.md** — reflect the new architecture (browser_* runs in SW; `internal/browser/` removed; WS no longer carries browser traffic; cross-browser solved structurally). Commit.

```bash
git add CLAUDE.md
git commit -m "docs: browser_* now SW-native (CLAUDE.md)"
```

- [ ] **Step 6: Update memory** — mark the migration done in the memory note.

**Phase 3 done.** All 44 `browser_*` tools execute in the Service Worker. Go has no browser code. Cross-browser race solved structurally; plugin does browser automation without the Go server. File/shell tools unchanged (still Go `/exec`).

---

## Deferred / follow-up (out of scope, noted)

- **Guidance injection for browser turns** — not ported (browser turns carry no operating reminder). If wanted, add a SW-side per-conversation counter that renders ONLY from an embedded prompt string (never from sandbox files), mirroring the security note in `executor.go:322`.
- **Full input-fidelity parity** — confirm the 7 fidelity knobs + HTML5 drag + read-back verification ported faithfully (Phase 2 port-notes).
- **`browser_upload` ergonomics** — base64-only is a regression from local-path; consider a file-picker bridge if users need local files.
