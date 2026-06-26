# spawn_agent worker-tab creation via SW-direct channel — design

**Date:** 2026-06-26
**Status:** approved (pending spec review)

## Problem

`spawn_agent` is broken end-to-end (reproduced live):

- `spawn_agent` creates an agent record, then immediately marks it `failed`, `seeded=false`.
- Actual error: `open worker tab: browser tools run in the extension service worker now; the Go relay path is disabled (set SW_DIRECT_BROWSER=false to re-enable legacy relay)`.

### Root cause — two browser-execution architectures out of sync

1. Normal `browser_*` tools now execute **natively in the extension service worker**: `EXEC_BROWSER_TOOL → dispatchBrowserTool → chrome.tabs.create` (`extension/src/background/browser/controller.ts:468`).
2. But `spawn_agent` still calls the **Go side**: `ctx.Browser.NewTab()` (`internal/tool/agent_tools.go:109`).
3. `NewTab()` sends a Go→WS `browser_cmd` relay command (`internal/browser/controller.go:166-208` → `sendNativeWithTimeout("createTab")` → `relay.go` sets `cmd.Type = "browser_cmd"`).
4. The extension has `SW_DIRECT_BROWSER = true` and **actively rejects** every `browser_cmd` (`extension/src/background/index.ts:392-406`) because a Go `/exec` browser command with an unknown tabId **broadcasts to every connected browser-relay** — so one browser's `browser_new_tab` would open a tab in *all* connected browsers (Chrome + Edge etc.).
5. spawn_agent therefore fails at "open worker tab", before binding / seed / execution.

Re-enabling the legacy relay (`SW_DIRECT_BROWSER=false`) is **rejected** — it reintroduces multi-browser broadcast and cross-browser duplicate-tab opening.

### What is NOT broken (important)

The **seed/inject flow is fully intact and independent of tab creation.** It triggers off the worker page's *own* WS connection:

- Worker tab URL carries `?piercode_agent=<id>` (`resolvePlatformURL`, `agent_tools.go:38-54`).
- Worker content script connects WS with `?agent=<id>`.
- Go `handleWS` detects `?agent=` (`server.go:571-576`) → `bindAndSeedWorker` (`server.go:611-651`) → `SendToID(workerClientID, {type:"inject", text: seed, await_ready:true})`.

So only the **tab-creation hop** needs rerouting. Once any browser opens the worker tab, everything downstream already works.

## Approach

Make the **dispatcher's browser** open the worker tab via the SW-direct path that already works, instead of having Go open it via the dead relay. Go stays the orchestrator but delegates the one `chrome.tabs.create` to the dispatcher content script over an existing, already-proven WS push channel.

### Why this is the right shape

- Go already pushes targeted WS messages to the initiating client: `s.ws.SendToID(req.SourceClientID, payload)` (`server.go:514`, used for `tool_stream`). The Context exposes this as `ctx.Client.BroadcastToClient(clientID, payload) bool` (`context_client.go:26`) — already used by `send_to_agent` (`agent_tools.go:199`). **No new plumbing.**
- The dispatcher content script already calls `EXEC_BROWSER_TOOL browser_new_tab` (`content/index.ts:1495`) → SW `dispatchBrowserTool` → `controller.newTab` → `chrome.tabs.create({active:false})`. That path **targets only this one browser** — no broadcast, so the duplicate-tab hazard is structurally absent.
- `controller.newTab` is already worker-tab-aware (`controller.ts:472`): a URL with `?piercode_agent=` is detected (`isWorker`) and kept **non-default / uncontrolled**, so the coordinator's tabId-less `browser_*` calls never re-point at the worker's chat page.

### Rejected alternatives

- **Re-enable `SW_DIRECT_BROWSER=false`** — brings back multi-browser broadcast + duplicate tabs (user constraint).
- **Change spawn_agent's tool contract** to return the worker URL for the content script to open as part of result handling — pushes orchestration into the content layer, breaks the "Go owns dispatch" model, and needs more content-side state. The WS-push keeps Go in charge.
- **Round-trip the created tabId back to Go before returning** — restores the cosmetic tab number but reintroduces a wait/await and extra plumbing for no functional gain.

## Changes

### 1. Go: `internal/tool/agent_tools.go` (spawn_agent execute)

Replace the `ctx.Browser.NewTab(...)` block (lines ~109-113) with a fire-and-forget WS push to the dispatcher:

- Build payload: `{"type":"open_worker_tab", "url": workerURL, "agent_id": rec.AgentID, "conversation_url": ctx.Client.ConversationURL}`.
- **No-browser guard:** if `ctx.Client.SourceClientID == ""` OR `ctx.Client.BroadcastToClient == nil` → `ctx.Agents.SetStatus(rec.AgentID, AgentFailed)` and return error: `spawn_agent needs an active browser AI page; no dispatcher client connected.`
- Send: `if !ctx.Client.BroadcastToClient(ctx.Client.SourceClientID, payload) { SetStatus(failed); return error "dispatcher browser is not reachable (tab may be closed)" }`.
- It is **fire-and-forget**: Go does not wait for the tab. The seed fires later off the worker's own WS connect.
- `scheduleAutoConfirmSpawn(ctx, rec.AgentID, task)` stays — it pushes through the same worker channel and is unaffected.

**Reply string (decision: drop tab id):** Go no longer knows the tabId. New reply:

```
Dispatched worker %s on %s: %s
The worker will run autonomously and report back as a <task-notification>. Do not poll or read its tab — end your turn and wait for the callback.%s%s

✅ 已启用自动确认机制（90秒后发送跟进消息确保任务执行）
```

(`%s` = agentID, platform, desc, dupWarn, activeRosterSuffix — same as today minus the `(tab %d)` fragment.)

### 2. Extension: `extension/src/content/ws-linker.ts` (dispatcher WS handler)

Add one branch to the `ws.onmessage` dispatch table (after the existing `agent_control` branch, ~line 729):

```ts
} else if (msg.type === "open_worker_tab" && typeof msg.url === "string") {
  // Coordinator's spawn_agent asks THIS dispatcher's browser to open the worker
  // tab via the SW-direct path (chrome.tabs.create), since the Go relay is dead.
  // Gate on isForThisClient so only the owning dispatcher acts (no duplicate
  // tabs across connected browsers).
  if (!isForThisClient(msg)) return;
  void chrome.runtime.sendMessage({
    type: 'EXEC_BROWSER_TOOL',
    name: 'browser_new_tab',
    args: { url: msg.url },
    callId: `spawn-${msg.agent_id ?? Date.now()}`,
  });
}
```

- `isForThisClient(msg)` is the same client-id gate already used by the `inject` branch — ensures exactly the dispatcher that owns `SourceClientID` opens the tab.
- The SW creates the tab; worker content script boots, connects `?agent=<id>`, Go seeds it. No change to seed path.

### 3. Go: `internal/browser/controller.go` — leave `NewTab` as-is

`Controller.NewTab` is no longer on the spawn_agent path. Not modified (avoids scope creep). Any other caller still hits the rejected relay and gets the existing clear error.

## What stays untouched

- `bindAndSeedWorker`, `buildWorkerSeed`, seed inject payload (`server.go:611-664`).
- `resolvePlatformURL` and `?piercode_agent=` encoding (`agent_tools.go:38-54`).
- Worker prompt / `worker` profile.
- `scheduleAutoConfirmSpawn` (same worker channel).
- `send_to_agent` / `stop_agent` (already use `BroadcastToClient` to the worker, unaffected).

## Error handling

| Condition | Behavior |
|-----------|----------|
| `SourceClientID == ""` / `BroadcastToClient == nil` (TUI/API caller, no browser) | agent → failed; error `spawn_agent needs an active browser AI page; no dispatcher client connected.` |
| `BroadcastToClient` returns false (dispatcher WS gone) | agent → failed; error `dispatcher browser is not reachable (tab may be closed).` |
| Worker tab opens but content script never connects | unchanged from today — agent stays pending/running until `scheduleAutoConfirmSpawn` / timeout; not regressed by this change |
| Multiple browsers connected | only the dispatcher whose client id matches `SourceClientID` opens the tab (isForThisClient gate) — no duplicates |

## Testing

**Go** (`internal/tool/agent_tools_test.go` or sibling):
- spawn_agent with a non-empty `SourceClientID` and a stub `BroadcastToClient` → asserts it was called once with a payload whose `type=="open_worker_tab"`, correct `url` (contains `piercode_agent=<agentID>`) and `agent_id`; asserts `ctx.Browser.NewTab` is NOT called; agent status not failed.
- spawn_agent with empty `SourceClientID` → returns the no-browser error and sets agent failed.
- spawn_agent where `BroadcastToClient` returns false → returns the unreachable error and sets agent failed.

**Extension** (`extension/src/content/__tests__/ws-linker.*` vitest):
- Feeding an `open_worker_tab` WS message whose client id matches → `chrome.runtime.sendMessage` called with `EXEC_BROWSER_TOOL` / `browser_new_tab` / `{url}`.
- Feeding an `open_worker_tab` message whose client id does NOT match (`isForThisClient` false) → `chrome.runtime.sendMessage` NOT called.

**Manual smoke:** coordinator AI emits `spawn_agent` → worker tab opens in the dispatcher's browser → worker connects, gets seeded, runs, reports `<task-notification>` back to coordinator.

## Out of scope

The 18 confirmed security/correctness findings from the prior audit (WS ownership isolation, panic-lock, approval-bypass, etc.) are tracked separately and not addressed here.
