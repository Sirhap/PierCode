# tool.Context Capability Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 14-field `tool.Context` junk-drawer into a core context plus named capability groups (`ClientIO`, `TaskAccess`), so each tool's dependencies are visible and testable through a small seam — without breaking the ~40 struct-literal test sites.

**Architecture:** `Context` keeps its struct-literal construction (tests rely on `&Context{...}`). The 5 client-IO fields (`Streamer`, `Broadcast`, `BroadcastToClient`, `SourceClientID`, `ConversationURL`) move into an embedded-by-value `ClientIO` value; the task field (`TaskRunner`) moves into an embedded-by-value `TaskAccess` value. `Browser` (already a clean 40-method interface) and `Agents` (already a pointer) stay top-level — they are out of scope here (deferred to candidates C3/C6). Migration is incremental: introduce the groups + **temporary accessor shims** that read the new groups, migrate the single assembly point in the executor, migrate consumers and their tests group-by-group, then delete the old top-level fields and the shims. Every commit leaves `go test ./...` green.

**Tech Stack:** Go 1.24, testify. Packages touched: `internal/tool`, `internal/executor`. No new dependencies.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `internal/tool/context_client.go` | NEW — `ClientIO` struct (Streamer/Broadcast/BroadcastToClient/SourceClientID/ConversationURL) + its zero-value nil-semantics | Create |
| `internal/tool/context_tasks.go` | NEW — `TaskAccess` struct wrapping `TaskRunner` | Create |
| `internal/tool/tool.go:30-81` | `Context` struct: embed `Client ClientIO` + `Tasks TaskAccess`, drop the 6 migrated top-level fields at the end | Modify |
| `internal/executor/executor.go:241-264` | Single assembly point — populate the new groups | Modify |
| `internal/tool/exec_cmd.go` | Reads Streamer/TaskRunner/SourceClientID/ConversationURL → new groups | Modify |
| `internal/tool/task_list.go`, `task_stop.go`, `task_output.go`, `send_stdin.go` | TaskRunner → `ctx.Tasks.Runner` | Modify |
| `internal/tool/question.go` | Broadcast/BroadcastToClient/SourceClientID → `ctx.Client.*` | Modify |
| `internal/tool/browser_tools.go` | BroadcastToClient/SourceClientID → `ctx.Client.*` | Modify |
| `internal/tool/agent_tools.go` | SourceClientID/ConversationURL → `ctx.Client.*` | Modify |
| `internal/tool/*_test.go` (11 files) | Struct-literal `&Context{...}` field names → grouped form, migrated alongside each consumer | Modify |

**Out of scope (separate PRs):** `Browser` interface shrink (C3), `Executor` event-sink / guidance extraction (C6). Do NOT touch `Browser` or `Agents` field placement.

---

## Design reference (the target shape)

After the full migration, `Context` looks like this. Keep this in view across all tasks — field names here are the contract:

```go
// ClientIO groups everything tied to the WebSocket client that initiated the
// call: live output, broadcast channels, and the client's identity. Zero value
// is fully usable — every field is nil/"" and consumers nil-check as before.
type ClientIO struct {
	Streamer          func(stream, text string)
	Broadcast         func(payload []byte)
	BroadcastToClient func(clientID string, payload []byte) bool
	SourceClientID    string
	ConversationURL   string
}

// TaskAccess groups background-task handoff. Zero value has a nil Runner;
// consumers nil-check Runner exactly as they did ctx.TaskRunner.
type TaskAccess struct {
	Runner TaskRunner
}

type Context struct {
	Context               context.Context
	Args                  map[string]interface{}
	Config                *types.Config
	Browser               BrowserController // unchanged — out of scope
	RootDir               string
	AdditionalAllowedDirs []string
	PermissionMode        string
	Agents                *AgentRegistry // unchanged — out of scope

	Client ClientIO   // embedded by value
	Tasks  TaskAccess // embedded by value
}
```

Embedding **by value** (not pointer) is deliberate: a bare `&Context{}` in a test must not panic when a consumer reads `ctx.Client.Streamer`. The zero `ClientIO` has all-nil fields, preserving the existing "nil means capability unavailable" semantics.

---

### Task 1: Add ClientIO and TaskAccess groups with executor wiring (both old + new fields valid)

This task adds the new groups and populates them at the executor assembly point **in addition to** the existing top-level fields. Nothing reads the new groups yet. After this task the old code path is untouched and green; the new groups carry identical values, ready for consumers to migrate onto.

**Files:**
- Create: `internal/tool/context_client.go`
- Create: `internal/tool/context_tasks.go`
- Modify: `internal/tool/tool.go:30-81` (add two embedded fields, keep the old ones)
- Modify: `internal/executor/executor.go:241-264` (populate both)
- Test: `internal/tool/context_group_test.go` (new)

- [ ] **Step 1: Write the failing test**

Create `internal/tool/context_group_test.go`:

```go
package tool

import "testing"

func TestClientIOZeroValueIsNilSafe(t *testing.T) {
	var c ClientIO
	if c.Streamer != nil || c.Broadcast != nil || c.BroadcastToClient != nil {
		t.Fatal("zero ClientIO must have nil callbacks")
	}
	if c.SourceClientID != "" || c.ConversationURL != "" {
		t.Fatal("zero ClientIO must have empty identity strings")
	}
}

func TestTaskAccessZeroValueHasNilRunner(t *testing.T) {
	var ta TaskAccess
	if ta.Runner != nil {
		t.Fatal("zero TaskAccess must have nil Runner")
	}
}

func TestContextEmbedsGroupsByValue(t *testing.T) {
	// A bare Context must allow reading group fields without panicking.
	ctx := &Context{}
	_ = ctx.Client.Streamer
	_ = ctx.Tasks.Runner
	if ctx.Client.SourceClientID != "" {
		t.Fatal("bare Context must have empty Client.SourceClientID")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/tool/ -run 'TestClientIO|TestTaskAccess|TestContextEmbedsGroups' -v`
Expected: FAIL — `undefined: ClientIO`, `undefined: TaskAccess`.

- [ ] **Step 3: Create the group structs**

Create `internal/tool/context_client.go`:

```go
package tool

// ClientIO groups everything tied to the WebSocket client that initiated the
// tool call: live stdout/stderr streaming, broadcast channels, and the client's
// own identity. Grouping these keeps the surrounding Context honest about which
// tools touch the client at all — filesystem tools take a zero ClientIO and
// never reach for it.
//
// The zero value is fully usable: nil callbacks and empty identity strings mean
// "this capability is not available in this invocation", exactly as the previous
// top-level nil fields did. Consumers nil-check the same way.
type ClientIO struct {
	// Streamer, if set, receives incremental stdout/stderr chunks from a
	// long-running tool (currently only exec_cmd). stream is "stdout" or
	// "stderr". Nil means the caller does not want live output.
	Streamer func(stream, text string)

	// Broadcast, if set, sends an arbitrary JSON payload to every connected
	// WebSocket client. The question tool uses it to push question_ask. Nil
	// means broadcast is not available.
	Broadcast func(payload []byte)

	// BroadcastToClient, if set, sends a JSON payload to one WebSocket client.
	// Browser-page side effects (screenshot attachment upload) use it so
	// multi-tab sessions do not all receive the same event.
	BroadcastToClient func(clientID string, payload []byte) bool

	// SourceClientID is the WebSocket client id of the AI page that initiated
	// this call, when it came through the browser extension. Empty otherwise.
	SourceClientID string

	// ConversationURL is the canonical conversation URL of the initiating page.
	ConversationURL string
}
```

Create `internal/tool/context_tasks.go`:

```go
package tool

// TaskAccess groups background-task handoff. A tool that wants to run its work
// out-of-band (currently only exec_cmd with background:true, plus the task_*
// management tools) reaches through here. The zero value has a nil Runner,
// meaning background mode is not available in this invocation — consumers
// nil-check Runner exactly as they did the old top-level ctx.TaskRunner.
type TaskAccess struct {
	Runner TaskRunner
}
```

- [ ] **Step 4: Embed the groups in Context (keep old fields)**

In `internal/tool/tool.go`, inside the `Context` struct (after the `Agents *AgentRegistry` field, before the closing brace at line 81), add:

```go
	// Client groups WebSocket-client IO + identity. During migration its
	// fields are populated alongside the legacy top-level fields below; the
	// legacy fields are removed in the final task once all consumers read
	// through Client.
	Client ClientIO

	// Tasks groups background-task handoff. Populated alongside the legacy
	// TaskRunner field during migration.
	Tasks TaskAccess
```

Leave the existing `Streamer`, `TaskRunner`, `Broadcast`, `BroadcastToClient`, `SourceClientID`, `ConversationURL` fields exactly as they are for now.

- [ ] **Step 5: Populate both groups at the executor assembly point**

In `internal/executor/executor.go`, replace the assembly block at lines 241-264 with one that fills both the legacy fields and the new groups. The full replacement:

```go
	callCtx := tool.ContextWithSourceClientID(ctx, req.SourceClientID)
	toolCtx := &tool.Context{
		Context:               callCtx,
		Args:                  toolArgs,
		Config:                e.config,
		RootDir:               rootSnapshot,
		AdditionalAllowedDirs: additionalRootsSnapshot,
		PermissionMode:        permissionModeSnapshot,
		TaskRunner:            e.tasks,
		Agents:                e.agents,
	}
	// New capability groups carry identical values; consumers migrate onto
	// these group-by-group, then the legacy fields above are removed.
	toolCtx.Tasks = tool.TaskAccess{Runner: e.tasks}
	toolCtx.Client = tool.ClientIO{
		SourceClientID:  req.SourceClientID,
		ConversationURL: req.ConversationURL,
	}
	e.browserMu.RLock()
	toolCtx.Browser = e.browser
	e.browserMu.RUnlock()
	if streamer != nil {
		s := func(stream, text string) { streamer(stream, text) }
		toolCtx.Streamer = s
		toolCtx.Client.Streamer = s
	}
	if bp := e.broadcast.Load(); bp != nil {
		toolCtx.Broadcast = *bp
		toolCtx.Client.Broadcast = *bp
	}
	if bp := e.broadcastToClient.Load(); bp != nil {
		toolCtx.BroadcastToClient = *bp
		toolCtx.Client.BroadcastToClient = *bp
	}
	toolCtx.SourceClientID = req.SourceClientID
	toolCtx.ConversationURL = req.ConversationURL
```

- [ ] **Step 6: Run the new test and the full suite**

Run: `go test ./internal/tool/ -run 'TestClientIO|TestTaskAccess|TestContextEmbedsGroups' -v`
Expected: PASS.

Run: `go test ./...`
Expected: PASS — no existing test changed; legacy fields still populated.

- [ ] **Step 7: Commit**

```bash
git add internal/tool/context_client.go internal/tool/context_tasks.go internal/tool/tool.go internal/tool/context_group_test.go internal/executor/executor.go
git commit -m "refactor(tool): add ClientIO + TaskAccess groups alongside legacy Context fields"
```

---

### Task 2: Migrate the task family onto ctx.Tasks.Runner

Move `task_list`, `task_stop`, `task_output`, `send_stdin` off `ctx.TaskRunner` onto `ctx.Tasks.Runner`, and update their tests. exec_cmd's TaskRunner use migrates in Task 3 (it also touches Streamer/identity, so keep it together).

**Files:**
- Modify: `internal/tool/task_list.go:31,40`
- Modify: `internal/tool/task_stop.go:36,45`
- Modify: `internal/tool/task_output.go:38,47`
- Modify: `internal/tool/send_stdin.go:42,60`
- Test: `internal/tool/task_output_semantics_test.go`, `internal/tool/new_tools_test.go`, `internal/tool/remaining_tools_test.go` (whichever build these tools' Context)

- [ ] **Step 1: Update the failing tests first**

Find the test sites that construct `&Context{... TaskRunner: ...}` for these four tools and change them to the group form. Run this to locate them:

```bash
grep -rn "TaskRunner:" internal/tool/*_test.go
```

For each match feeding `task_list` / `task_stop` / `task_output` / `send_stdin`, change:

```go
&Context{Args: args, TaskRunner: fakeRunner}
```
to:
```go
&Context{Args: args, Tasks: TaskAccess{Runner: fakeRunner}}
```

(Leave exec_cmd test sites unchanged — Task 3 handles those.)

- [ ] **Step 2: Run the task-family tests to verify they fail**

Run: `go test ./internal/tool/ -run 'TaskList|TaskStop|TaskOutput|SendStdin' -v`
Expected: FAIL — the tools still read `ctx.TaskRunner` (nil in the new construction), so they return the "no background task runner" error path.

- [ ] **Step 3: Migrate the four tools**

In each file, replace `ctx.TaskRunner` with `ctx.Tasks.Runner`:

- `task_list.go:31` — `if ctx.Tasks.Runner == nil {`
- `task_list.go:40` — `snaps := ctx.Tasks.Runner.Snapshots()`
- `task_stop.go:36` — `if ctx.Tasks.Runner == nil {`
- `task_stop.go:45` — `if err := ctx.Tasks.Runner.Stop(id); err != nil {`
- `task_output.go:38` — `if ctx.Tasks.Runner == nil {`
- `task_output.go:47` — `snap, stdout, stderr, ok := ctx.Tasks.Runner.GetSnapshot(id)`
- `send_stdin.go:42` — `if ctx.Tasks.Runner == nil {`
- `send_stdin.go:60` — `if err := ctx.Tasks.Runner.SendStdin(id, data); err != nil {`

- [ ] **Step 4: Run the task-family tests to verify they pass**

Run: `go test ./internal/tool/ -run 'TaskList|TaskStop|TaskOutput|SendStdin' -v`
Expected: PASS.

Run: `go test ./...`
Expected: PASS (exec_cmd still uses legacy `ctx.TaskRunner`, still populated).

- [ ] **Step 5: Commit**

```bash
git add internal/tool/task_list.go internal/tool/task_stop.go internal/tool/task_output.go internal/tool/send_stdin.go internal/tool/*_test.go
git commit -m "refactor(tool): task family reads ctx.Tasks.Runner"
```

---

### Task 3: Migrate exec_cmd onto ctx.Tasks.Runner + ctx.Client

exec_cmd uses Streamer, TaskRunner, SourceClientID, ConversationURL — migrate all four together.

**Files:**
- Modify: `internal/tool/exec_cmd.go:141,148,207,240,241,246`
- Test: `internal/tool/exec_cmd_test.go`

- [ ] **Step 1: Update exec_cmd tests first**

Locate exec_cmd Context constructions:

```bash
grep -n "Streamer:\|TaskRunner:\|SourceClientID:\|ConversationURL:" internal/tool/exec_cmd_test.go
```

Change each to the group form. Field mapping:
- `Streamer: fn` → `Client: ClientIO{Streamer: fn}`
- `TaskRunner: r` → `Tasks: TaskAccess{Runner: r}`
- `SourceClientID: id` → `Client: ClientIO{SourceClientID: id}` (merge into one `Client` literal if combined with Streamer)
- `ConversationURL: u` → into the same `Client` literal

Example combined form:
```go
&Context{
	Args:  args,
	Tasks: TaskAccess{Runner: fakeRunner},
	Client: ClientIO{
		Streamer:        streamFn,
		SourceClientID:  "client-1",
		ConversationURL: "https://x/chat/1",
	},
}
```

- [ ] **Step 2: Run exec_cmd tests to verify they fail**

Run: `go test ./internal/tool/ -run 'ExecCmd|Exec_' -v`
Expected: FAIL — exec_cmd still reads legacy fields that are now nil/empty in the new construction.

- [ ] **Step 3: Migrate exec_cmd.go**

Replace reads:
- `exec_cmd.go:141` — `if ctx.Client.Streamer == nil {`
- `exec_cmd.go:148` — `combined, err := runWithStreamer(proc, ctx.Client.Streamer)`
- `exec_cmd.go:207` — `if ctx.Tasks.Runner == nil {`
- `exec_cmd.go:240` — `SourceClientID:  ctx.Client.SourceClientID,`
- `exec_cmd.go:241` — `ConversationURL: ctx.Client.ConversationURL,`
- `exec_cmd.go:246` — `id, err := ctx.Tasks.Runner.Start(spec)`

(The comment lines 214/217/220 referencing `ctx.Streamer` are prose — update them to `ctx.Client.Streamer` for accuracy.)

- [ ] **Step 4: Run exec_cmd tests to verify they pass**

Run: `go test ./internal/tool/ -run 'ExecCmd|Exec_' -v`
Expected: PASS.

Run: `go test ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/tool/exec_cmd.go internal/tool/exec_cmd_test.go
git commit -m "refactor(tool): exec_cmd reads ctx.Tasks.Runner + ctx.Client"
```

---

### Task 4: Migrate question + browser_tools onto ctx.Client

**Files:**
- Modify: `internal/tool/question.go:79,83,88,89,91,132,138,142,143,145`
- Modify: `internal/tool/browser_tools.go:329,378`
- Test: `internal/tool/question_test.go`, `internal/tool/browser_tools_test.go`, `internal/tool/browser_tools_user_test.go`

- [ ] **Step 1: Update question + browser_tools tests first**

Locate constructions:

```bash
grep -n "Broadcast:\|BroadcastToClient:\|SourceClientID:" internal/tool/question_test.go internal/tool/browser_tools_test.go internal/tool/browser_tools_user_test.go
```

Change each to the `Client: ClientIO{...}` form. Example:
```go
&Context{Args: args, Broadcast: bc, SourceClientID: "c1"}
```
becomes:
```go
&Context{Args: args, Client: ClientIO{Broadcast: bc, SourceClientID: "c1"}}
```

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./internal/tool/ -run 'Question|Browser' -v`
Expected: FAIL — tools read legacy fields, now empty in new construction.

- [ ] **Step 3: Migrate question.go**

Replace every `ctx.Broadcast` → `ctx.Client.Broadcast`, `ctx.BroadcastToClient` → `ctx.Client.BroadcastToClient`, `ctx.SourceClientID` → `ctx.Client.SourceClientID` at lines 79, 83, 88, 89, 91, 132, 138, 142, 143, 145. The two guard expressions become:

```go
// line 79
if ctx.Client.Broadcast != nil || (ctx.Client.BroadcastToClient != nil && ctx.Client.SourceClientID != "") {
// line 132
if ctx.Client.Broadcast == nil && (ctx.Client.BroadcastToClient == nil || ctx.Client.SourceClientID == "") {
```

- [ ] **Step 4: Migrate browser_tools.go**

- `browser_tools.go:329` — `if ctx == nil || ctx.Client.SourceClientID == "" || ctx.Client.BroadcastToClient == nil {`
- `browser_tools.go:378` — `if !ctx.Client.BroadcastToClient(ctx.Client.SourceClientID, payload) {`

- [ ] **Step 5: Run to verify they pass**

Run: `go test ./internal/tool/ -run 'Question|Browser' -v`
Expected: PASS.

Run: `go test ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/tool/question.go internal/tool/browser_tools.go internal/tool/*_test.go
git commit -m "refactor(tool): question + browser_tools read ctx.Client"
```

---

### Task 5: Migrate agent_tools onto ctx.Client

agent_tools reads `ctx.SourceClientID` and `ctx.ConversationURL` (identity for worker dispatch). It also reads `ctx.Browser` and `ctx.Agents` — leave those untouched (out of scope).

**Files:**
- Modify: `internal/tool/agent_tools.go:83,90,96,100,121,151` (and any other `ctx.SourceClientID` / `ctx.ConversationURL`)
- Test: `internal/tool/agent_spawn_test.go`, `internal/tool/agent_registry_test.go`

- [ ] **Step 1: Find every identity read in agent_tools**

```bash
grep -n "ctx.SourceClientID\|ctx.ConversationURL" internal/tool/agent_tools.go
```

- [ ] **Step 2: Update agent test constructions first**

```bash
grep -n "SourceClientID:\|ConversationURL:" internal/tool/agent_spawn_test.go internal/tool/agent_registry_test.go
```

Change each to `Client: ClientIO{SourceClientID: ..., ConversationURL: ...}`. Note `agent_registry_test.go` builds Context inline at lines ~252 and ~330 — check both.

- [ ] **Step 3: Run to verify they fail**

Run: `go test ./internal/tool/ -run 'Agent|Spawn' -v`
Expected: FAIL — identity now empty in new construction, spawn/list logic sees empty client id.

- [ ] **Step 4: Migrate agent_tools.go**

Replace `ctx.SourceClientID` → `ctx.Client.SourceClientID` and `ctx.ConversationURL` → `ctx.Client.ConversationURL` everywhere in the file. Sample resulting lines:

```go
platform = defaultPlatformFor(ctx.Client.SourceClientID)            // line 83
parentAgentID := ctx.Agents.AgentIDByWorkerClient(ctx.Client.SourceClientID) // line 90
if ctx.Agents.HasActiveWithDescription(ctx.Client.SourceClientID, desc) {    // line 96
rec := ctx.Agents.CreateInProject(ctx.Client.SourceClientID, ctx.Client.ConversationURL, platform, "", desc, task, parentAgentID) // line 100
```

Leave `ctx.Browser` and `ctx.Agents` reads as-is.

- [ ] **Step 5: Run to verify they pass**

Run: `go test ./internal/tool/ -run 'Agent|Spawn' -v`
Expected: PASS.

Run: `go test ./...`
Expected: PASS — all consumers now read the new groups; legacy fields still populated but unread by tools.

- [ ] **Step 6: Commit**

```bash
git add internal/tool/agent_tools.go internal/tool/agent_spawn_test.go internal/tool/agent_registry_test.go
git commit -m "refactor(tool): agent_tools reads ctx.Client identity"
```

---

### Task 6: Delete legacy top-level fields + executor double-population

Now nothing reads `ctx.Streamer`, `ctx.TaskRunner`, `ctx.Broadcast`, `ctx.BroadcastToClient`, `ctx.SourceClientID`, `ctx.ConversationURL`. Delete them and the double-population in the executor. The compiler is the safety net: any missed reader fails the build.

**Files:**
- Modify: `internal/tool/tool.go:30-81` (remove 6 legacy fields)
- Modify: `internal/executor/executor.go:241-264` (remove legacy assignments)
- Modify: any `EffectiveRootDir`-style accessor that references a removed field (none expected; verify)

- [ ] **Step 1: Verify no remaining readers of the legacy fields**

Run each — all must return zero non-test, non-assembly hits:

```bash
grep -rn "ctx\.Streamer\|ctx\.TaskRunner\|ctx\.Broadcast\b\|ctx\.BroadcastToClient\|ctx\.SourceClientID\|ctx\.ConversationURL" internal/ --include='*.go' | grep -v executor.go
```

Expected: only the comment/prose hits already updated in Task 3, or nothing. If a real read appears, migrate it (same pattern) before continuing.

- [ ] **Step 2: Remove the legacy fields from Context**

In `internal/tool/tool.go`, delete these fields and their doc comments from the `Context` struct: `Streamer`, `TaskRunner`, `Broadcast`, `BroadcastToClient`, `SourceClientID`, `ConversationURL`. Keep `Context, Args, Config, Browser, RootDir, AdditionalAllowedDirs, PermissionMode, Agents, Client, Tasks`.

- [ ] **Step 3: Remove the double-population in the executor**

In `internal/executor/executor.go`, the assembly block becomes (no legacy assignments):

```go
	callCtx := tool.ContextWithSourceClientID(ctx, req.SourceClientID)
	toolCtx := &tool.Context{
		Context:               callCtx,
		Args:                  toolArgs,
		Config:                e.config,
		RootDir:               rootSnapshot,
		AdditionalAllowedDirs: additionalRootsSnapshot,
		PermissionMode:        permissionModeSnapshot,
		Agents:                e.agents,
		Tasks:                 tool.TaskAccess{Runner: e.tasks},
		Client: tool.ClientIO{
			SourceClientID:  req.SourceClientID,
			ConversationURL: req.ConversationURL,
		},
	}
	e.browserMu.RLock()
	toolCtx.Browser = e.browser
	e.browserMu.RUnlock()
	if streamer != nil {
		toolCtx.Client.Streamer = func(stream, text string) { streamer(stream, text) }
	}
	if bp := e.broadcast.Load(); bp != nil {
		toolCtx.Client.Broadcast = *bp
	}
	if bp := e.broadcastToClient.Load(); bp != nil {
		toolCtx.Client.BroadcastToClient = *bp
	}
```

- [ ] **Step 4: Build + full suite + race**

Run: `go build ./...`
Expected: PASS — no undefined-field errors. If the build fails on a removed field, that's a missed reader; migrate it (`ctx.X` → `ctx.Client.X` / `ctx.Tasks.Runner`), then rebuild.

Run: `go test ./...`
Expected: PASS.

Run: `go test -race ./internal/tool/... ./internal/executor/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/tool/tool.go internal/executor/executor.go
git commit -m "refactor(tool): drop legacy Context fields; ClientIO + TaskAccess are the only seam"
```

---

### Task 7: Verify field-count reduction + update CLAUDE.md tool-Context note

**Files:**
- Modify: `CLAUDE.md` (the `tool.go` line describing `Context`)

- [ ] **Step 1: Confirm the deepening landed**

Run:
```bash
grep -c "^\s*[A-Z][a-zA-Z]* " internal/tool/tool.go  # sanity, not exact
awk '/^type Context struct/,/^}/' internal/tool/tool.go
```
Expected: `Context` now lists 10 top-level fields (8 core + `Client` + `Tasks`) instead of 14, with the 5 IO fields and TaskRunner behind named groups.

- [ ] **Step 2: Update the CLAUDE.md description**

In `CLAUDE.md`, find the line describing `tool.go`'s `Context` struct (currently: "`Context` struct (carries RootDir snapshot, Streamer, TaskRunner, Agents registry, Broadcast callbacks)") and replace with:

```
- `tool.go`: `Tool` interface, `Context` struct (core: RootDir snapshot, Args, Config; capability groups: `Client ClientIO` for streamer/broadcast/client-identity, `Tasks TaskAccess` for background-task handoff; plus `Browser` + `Agents`), `BrowserController` interface
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe tool.Context capability groups (ClientIO/TaskAccess)"
```

---

## Self-Review

**1. Spec coverage** — Design goal was: regroup the 5 client-IO fields + TaskRunner into named capability groups, keep struct-literal tests, mechanical + TDD, leave Browser/Agents for C3/C6. Covered: ClientIO (Task 1,3,4,5), TaskAccess (Task 1,2,3), executor wiring (Task 1,6), all consumers migrated (Tasks 2-5), legacy removal (Task 6), docs (Task 7). Browser/Agents explicitly untouched. ✅

**2. Placeholder scan** — No TBD/TODO; every code step shows exact lines + resulting code. The `grep` discovery steps are deliberate (test-site locations vary), but each is followed by the exact transform to apply. ✅

**3. Type consistency** — Names used consistently across tasks: `ClientIO{Streamer, Broadcast, BroadcastToClient, SourceClientID, ConversationURL}`, `TaskAccess{Runner}`, accessed as `ctx.Client.X` / `ctx.Tasks.Runner`. Matches the Design reference block. ✅

**Incrementality guarantee:** Tasks 1-5 keep both old and new fields valid (executor double-populates), so every intermediate commit is green and the migration can stop/resume at any task boundary. Task 6 is the only breaking change, gated by a grep-verify of zero remaining readers + the compiler.
