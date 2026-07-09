# Dedicated Sidebar Prompt Profiles

**Date:** 2026-06-29
**Status:** Design — pending implementation

## Problem

The chat sidebar (`extension/src/sidebar/`) talks to AI platforms directly via API
(`background/chat-api.ts`) but reuses prompts written for the **web-tab** route. Two
concrete problems:

### 1. Coordinator prompt is the generic default

The sidebar main turn fetches `GET /prompt` with **no profile** → `init_prompt.txt`
(`App.tsx` `fetchInitPrompt`, [App.tsx:719](extension/src/sidebar/App.tsx:719)). That
prompt is shared with five web-tab default-profile platforms (Claude/Gemini/Kimi/Chat
Z/Mimo). Its `§12 Multi-Agent Policy` is written for the web-tab worker model:
"dispatched into AI tabs", results arrive as `<task-notification>` blocks. The sidebar's
sub-agents are **in-memory API sub-conversations with no tab** and results arrive as an
injected summary turn, so that section is factually wrong for the sidebar coordinator.
(Not catastrophic — the behavioral rules still mostly read correctly — but misleading.)

### 2. Sub-agent prompt is wrong — a real bug

The sidebar's API sub-agent (`runSubAgent`) builds its first message from
`fetchWorkerPrompt()` → `GET /prompt?profile=worker` = `worker_append.txt`
([chat-api.ts:1535](extension/src/background/chat-api.ts:1535),
[chat-api.ts:889](extension/src/background/chat-api.ts:889)). That prompt tells the
sub-agent:

- "You are running as a PierCode worker **in your own browser AI tab**" — **false**, there
  is no tab; it is an in-memory `runIsolatedConversation`.
- "Finish by emitting **exactly one** `piercode-agent-result` fenced JSON packet and
  nothing else" — **nobody parses that packet on the sidebar path**. The result handler
  `shapeSubAgentResult` takes the sub-agent's **raw final assistant text**
  ([chat-api.ts:1567](extension/src/background/chat-api.ts:1567),
  [chat-api.ts:867](extension/src/background/chat-api.ts:867)).

So an obedient sidebar sub-agent ends its turn with a `piercode-agent-result` JSON blob,
and that blob is shoved verbatim into the parent conversation as the sub-agent's "result"
— instead of a clean prose conclusion. The web-tab worker route DOES parse the packet
(content script → WS `agent_result`), so the contract is correct there; it is only wrong
for the sidebar's API path.

## Approach

Mirror the existing dedicated-profile pattern (`qwen`, `browser-agent`): give the sidebar
its own profile + prompt file for **both** the coordinator and the sub-agent, leaving the
web-tab routes (`default`, `worker`) untouched. Chosen over "tune init_prompt in place"
because init_prompt is shared by five other platforms — sidebar-specific edits (drop
`<task-notification>` language, change the sub-agent result contract) would be wrong for
them. The profile system exists precisely for this.

## Changes

### A. `sidebar` profile (coordinator)

**New file `prompts/sidebar_base.txt`** — forked from `init_prompt.txt`, with only these
deltas (everything else copied verbatim so it stays in lockstep with the default contract):

- **§1 Transport Rule:** keep the core rule (emit a visible `piercode-tool` block, never a
  host-native/function-call channel — the API model, e.g. gpt-5/claude/qwen, still has its
  own tool-calling it could wrongly reach for). Trim the long web-tab framing about host
  sandboxes returning placeholder output; the sidebar speaks the API directly, so the
  shorter rule is enough.
- **§12 Multi-Agent Policy:** rewrite for API sub-agents. Spawn = parallel **in-memory
  sub-conversations** (no tab, no page). Results come back as an **injected summary turn**
  in this same conversation when the batch finishes — NOT as `<task-notification>` blocks
  the coordinator must wait on. Keep the channel-agnostic rules: coordinator-is-not-a-worker,
  spawn all independent workers in ONE response (parallel), don't dispatch trivial one-step
  tasks, synthesize results yourself, no need to clean up finished workers. Remove the
  `<task-id>/<task-description>/<status>` packet anatomy (that's the worker-tab callback
  format).
- **§16 First Reply — Handshake:** keep. The sidebar injects the prompt as a real system
  field on the first turn only and never as a bare contract (a user message always
  accompanies it), so the "contract only → reply `PierCode 已就绪`" branch simply never
  fires; it's harmless. Leave the section intact to minimize the fork delta.
- **§4–§11** (core operating model, scope, safety, risk/confirmation, editing/verification,
  git floor, skills routing, tool selection + the 1-4-block batching guidance): copied
  **verbatim**. These are channel-agnostic and already correct, including the batching +
  dependency-hazard text added earlier this session.

**Register in `internal/prompt/profile.go`** `DefaultProfileRegistry`:

```go
registry.Register(Profile{
    ID:     "sidebar",
    Prompt: prompts.SidebarBasePrompt,
})
```

No `ToolNames`/`ToolNamePrefixes` (full tool surface, like default). No `ContextHandoff`
(the sidebar manages its own context compression client-side).

**Embed in `prompts/prompts.go`:** `//go:embed sidebar_base.txt` → `var SidebarBasePrompt []byte`.

**Repoint the fetch** in `App.tsx` `fetchInitPrompt`: `GET /prompt` → `GET /prompt?profile=sidebar`.

### B. `sidebar-worker` profile (sub-agent)

**New file `prompts/sidebar_worker_append.txt`** — forked from `worker_append.txt`, with:

- Role reframed: "You are an **in-memory PierCode sub-agent**" — no tab, no host page of
  your own; you run as an isolated API sub-conversation.
- **Result contract replaced:** your **final assistant message (plain prose) IS your
  result** — return a concise text conclusion (what you did, key findings, what the
  coordinator needs to know). **Do NOT emit a `piercode-agent-result` packet** or any
  fenced result block; there is no packet parser on this path, so a packet would be
  dumped verbatim into the coordinator. Just write the conclusion as your last message and
  stop.
- Keep verbatim (channel-agnostic): `piercode-tool` transport rule, "host-native tools
  can't see local files", scope discipline (don't expand the task), self-verification with
  evidence, no-nested-spawn ("workers do not spawn workers" — already enforced in code,
  [chat-api.ts](extension/src/background/chat-api.ts) rejects nested spawn).
- Drop the "you may be continued with a follow-up" packet-loop language; keep a short
  "if the coordinator continues you, treat it as the next task" note without the packet.

This profile uses `PromptAppend` only (inherits the default base prompt as the worker does
today) — the engineering contract is identical; only the role + result handoff differ. So:

```go
registry.Register(Profile{
    ID:           "sidebar-worker",
    PromptAppend: prompts.SidebarWorkerPromptAppend,
})
```

**Embed:** `//go:embed sidebar_worker_append.txt` → `var SidebarWorkerPromptAppend []byte`.

**Repoint the fetch** in `chat-api.ts` `fetchWorkerPrompt`: `GET /prompt?profile=worker`
→ `GET /prompt?profile=sidebar-worker`. (This function is only called by `runSubAgent`,
the sidebar path — verified by grep; the web-tab `spawn_agent` worker seeding is server-side
and keeps `profile=worker`.)

The inline fallback string in `fetchWorkerPrompt` (used when the server is unreachable)
already says "用纯文本简明汇报结论" (report in plain text) and "不要再派生新的子 agent" — it
is already correct for the API path and stays as-is.

## What stays untouched

- `init_prompt.txt` (default profile) — still served to the five web-tab default platforms.
  The session's already-applied edits (1-4-block batching, `question` field fix) stay.
- `worker_append.txt` + `worker` profile — still seeds web-tab `spawn_agent` workers, whose
  `piercode-agent-result` packet IS parsed. Unchanged.
- `qwen` / `chatgpt` / `browser-agent` profiles — unrelated, untouched.
- `shapeSubAgentResult` / `runSubAgent` / `runIsolatedConversation` Go-side and TS-side
  control flow — no code-path change, only the prompt bytes the sub-agent receives change.

## Testing

- `go test ./internal/prompt/...` — add a `TestSidebarProfile` mirroring the browser-agent
  test: assert `sidebar` profile renders, does NOT contain web-tab worker phrases
  (`<task-notification>`, "dispatched into.*tab"), still renders `{{TOOLS}}`; assert
  `sidebar-worker` append renders and does NOT contain `piercode-agent-result`.
- `go test ./internal/server/...` — existing `/prompt` route tests should still pass;
  optionally add `GET /prompt?profile=sidebar` returns the sidebar base.
- `go build ./cmd/server` — confirms the new `//go:embed` files resolve.
- `cd extension && npx tsc --noEmit` — the two fetch-URL string edits are type-trivial but
  confirm no breakage.
- Manual smoke (optional): open sidebar, spawn a sub-agent, confirm the parent receives a
  prose conclusion rather than a raw JSON packet.

## Risk / non-goals

- Forking prompt text duplicates the channel-agnostic sections between `init_prompt.txt` and
  `sidebar_base.txt`. Accepted: it's the established pattern (qwen/browser-agent already
  fork), and the profile system has no include mechanism. A future refactor could template
  shared sections, but that's out of scope (YAGNI).
- Not changing the sidebar's compression / idle-injection / recoverable-batch machinery —
  this is purely a prompt-content + two-fetch-URL change.
