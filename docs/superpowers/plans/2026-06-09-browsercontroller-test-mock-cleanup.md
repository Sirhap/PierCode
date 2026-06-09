# BrowserController Test-Mock Cleanup (C3-alt) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill ~270 LOC of duplicated 40-method stub boilerplate in the BrowserController test fakes by introducing one shared no-op base, without touching the interface, the real Controller, or any production behavior.

**Architecture:** The original architecture report's C3 ("collapse the 40-method `BrowserController` to a command bus") was REJECTED — each method carries real, method-specific logic (security checks, approval prompts, typed request structs) and a command bus would trade compile-time type safety for runtime type-switch failures. The genuine, low-risk win underneath C3 is the *test-mock pain*: three separate test fakes (`fakeBrowserController`, the recorder in `browser_tools_user_test.go`, and `countingBrowser`) each hand-stub all 40 interface methods. We add one `noopBrowserController` struct that implements every method as a safe default (returns a "not implemented in test" error / zero value), and refactor the fakes to embed it and override only the methods they exercise. This is a TEST-ONLY change. The interface, the real `*browser.Controller`, and all production code stay untouched. `countingBrowser` already uses the embed pattern (it embeds the `BrowserController` interface as nil) — this generalizes that idiom to a safe, shared base.

**Tech Stack:** Go 1.24, testify. Package: `internal/tool` (test files only, plus one new non-test helper file usable by tests).

---

## Background facts (verified on disk)

- `BrowserController` interface (`internal/tool/tool.go:214`) has 40 methods: ListTabs, NewTab, UseTab, Navigate, NavigateWithBeforeunload, Snapshot, Click, Type, Screenshot, Wait, WaitForFunction, Hover, Scroll, Evaluate, GetContent, Select, GoBack, GoForward, Reload, Focus, PressKey, Drag, PDF, Upload, HandleDialog, Find, Zoom, Resize, FormInput, ReadConsole, ReadNetwork, Cookies, FinalizeTabs, Viewport, Downloads, Storage, SetCookie, WaitForNavigation, Emulate, GetAttributes.
- `fakeBrowserController` (`internal/tool/browser_tools_test.go:171`): stubs all 40, ~134 LOC. Only `Screenshot` + `Upload` carry real test logic (capture request, return fixture).
- `browser_tools_user_test.go`: a second full-interface recorder fake (~51 method funcs).
- `countingBrowser` (`internal/tool/agent_spawn_test.go:11`): embeds `BrowserController` (nil) + overrides only `NewTab`. Already minimal — but panics if an un-overridden method is called (nil interface dispatch).
- `browser_tools_stability_test.go`: also references BrowserController.

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `internal/tool/browser_noop.go` | NEW — `noopBrowserController` implementing all 40 methods with safe defaults (panic-free; returns `errNoopBrowser`). Non-`_test.go` so any test in the package can embed it. | Create |
| `internal/tool/browser_tools_test.go` | Refactor `fakeBrowserController` to embed `noopBrowserController`, keep only Screenshot + Upload overrides | Modify |
| `internal/tool/browser_tools_user_test.go` | Refactor the recorder fake to embed `noopBrowserController`, keep only the methods it records | Modify |
| `internal/tool/agent_spawn_test.go` | Switch `countingBrowser` from nil-interface embed to `noopBrowserController` embed (panic-safety), keep `NewTab` override | Modify |

NOTE on file naming: `browser_noop.go` is NOT a `_test.go` file, so `noopBrowserController` ships in the non-test build. That is acceptable and idiomatic for shared test helpers that multiple `_test.go` files in the package need (Go test files in the same package can't share types defined in a sibling `_test.go` unless that sibling is compiled — it is, but keeping the base in a normal file avoids ordering/`go vet` quirks and makes it reusable). Mark the type clearly as a test helper in its doc comment. If the reviewer prefers test-only scope, an alternative is `browser_noop_test.go` — but since THREE different `_test.go` files embed it, a plain file is cleaner.

---

### Task 1: Add the no-op base

**Files:**
- Create: `internal/tool/browser_noop.go`
- Test: `internal/tool/browser_noop_test.go` (new — verifies the base satisfies the interface + panic-free)

- [ ] **Step 1: Write the failing test** — create `internal/tool/browser_noop_test.go`:

```go
package tool

import (
	"context"
	"testing"
)

// The base must satisfy the full BrowserController interface at compile time.
var _ BrowserController = (*noopBrowserController)(nil)

func TestNoopBrowserControllerReturnsErrorNotPanic(t *testing.T) {
	var b noopBrowserController
	// A representative sampling across the interface: each must return an
	// error (or zero value) rather than panic, so a fake that forgets to
	// override a method gets a clean failure instead of a nil-deref crash.
	if _, err := b.Click(context.Background(), BrowserClickRequest{}); err == nil {
		t.Error("Click on noop base must return an error")
	}
	if _, err := b.ListTabs(context.Background(), false); err == nil {
		t.Error("ListTabs on noop base must return an error")
	}
	if _, err := b.Evaluate(context.Background(), BrowserEvaluateRequest{}); err == nil {
		t.Error("Evaluate on noop base must return an error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/tool/ -run TestNoopBrowserController -v`
Expected: FAIL — `undefined: noopBrowserController`.

- [ ] **Step 3: Create the base.** Create `internal/tool/browser_noop.go`. Implement EVERY one of the 40 interface methods. Match each signature EXACTLY to the interface in `tool.go` (read `awk '/type BrowserController interface/,/^}/' internal/tool/tool.go` to copy signatures verbatim). Each method returns `errNoopBrowser` for the error and the zero value for any other return. Template (fill in ALL 40 — these are representative; copy the real signatures):

```go
package tool

import (
	"context"
	"errors"
)

// noopBrowserController implements BrowserController with safe, panic-free
// defaults. It is a TEST HELPER: test fakes embed it and override only the
// methods they exercise, so adding a method to BrowserController no longer
// forces every fake to grow a new stub. Un-overridden methods return
// errNoopBrowser rather than panicking (which a nil-interface embed would do).
type noopBrowserController struct{}

var errNoopBrowser = errors.New("noopBrowserController: method not implemented in this test")

func (noopBrowserController) ListTabs(context.Context, bool) ([]BrowserTab, error) {
	return nil, errNoopBrowser
}
func (noopBrowserController) NewTab(context.Context, string) (BrowserTab, error) {
	return BrowserTab{}, errNoopBrowser
}
func (noopBrowserController) UseTab(context.Context, int, string, string) (BrowserTab, error) {
	return BrowserTab{}, errNoopBrowser
}
func (noopBrowserController) Navigate(context.Context, *int, string, string) (BrowserTab, error) {
	return BrowserTab{}, errNoopBrowser
}
func (noopBrowserController) NavigateWithBeforeunload(context.Context, *int, string, string, string) (BrowserTab, error) {
	return BrowserTab{}, errNoopBrowser
}
func (noopBrowserController) Snapshot(context.Context, *int, int) (BrowserSnapshot, error) {
	return BrowserSnapshot{}, errNoopBrowser
}
func (noopBrowserController) Click(context.Context, BrowserClickRequest) (string, error) {
	return "", errNoopBrowser
}
func (noopBrowserController) Type(context.Context, BrowserTypeRequest) (string, error) {
	return "", errNoopBrowser
}
func (noopBrowserController) Screenshot(context.Context, BrowserScreenshotRequest) (BrowserScreenshot, error) {
	return BrowserScreenshot{}, errNoopBrowser
}
func (noopBrowserController) Wait(context.Context, BrowserWaitRequest) (string, error) {
	return "", errNoopBrowser
}
func (noopBrowserController) WaitForFunction(context.Context, BrowserWaitForFunctionRequest) (string, error) {
	return "", errNoopBrowser
}
func (noopBrowserController) Hover(context.Context, BrowserHoverRequest) (string, error) {
	return "", errNoopBrowser
}
func (noopBrowserController) Scroll(context.Context, BrowserScrollRequest) (string, error) {
	return "", errNoopBrowser
}
func (noopBrowserController) Evaluate(context.Context, BrowserEvaluateRequest) (BrowserEvaluateResponse, error) {
	return BrowserEvaluateResponse{}, errNoopBrowser
}
func (noopBrowserController) GetContent(context.Context, BrowserGetContentRequest) (string, error) {
	return "", errNoopBrowser
}
func (noopBrowserController) Select(context.Context, BrowserSelectRequest) (string, error) {
	return "", errNoopBrowser
}
// ... CONTINUE for the remaining methods: GoBack, GoForward, Reload, Focus,
// PressKey, Drag, PDF, Upload, HandleDialog, Find, Zoom, Resize, FormInput,
// ReadConsole, ReadNetwork, Cookies, FinalizeTabs, Viewport, Downloads,
// Storage, SetCookie, WaitForNavigation, Emulate, GetAttributes.
// Copy each signature VERBATIM from the interface in tool.go. For each:
//   - error return -> errNoopBrowser
//   - all other returns -> their zero value
```

CRITICAL: you must implement ALL 40 or the `var _ BrowserController = (*noopBrowserController)(nil)` assertion in the test fails to compile, telling you exactly which method is missing. Use that as your checklist: run the build, read the "missing method X" error, add X, repeat.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/tool/ -run TestNoopBrowserController -v`
Expected: PASS. If the build complains `*noopBrowserController does not implement BrowserController (missing method X)`, add method X and rerun.

- [ ] **Step 5: Commit**

```bash
git add internal/tool/browser_noop.go internal/tool/browser_noop_test.go
git commit -m "test(tool): add noopBrowserController base for browser fakes"
```

---

### Task 2: Refactor fakeBrowserController onto the base

**Files:**
- Modify: `internal/tool/browser_tools_test.go:171-305` (the fake + its 40 methods)

- [ ] **Step 1: Confirm which methods the fake actually needs.** Read `internal/tool/browser_tools_test.go` around the fake. The only methods carrying real test logic are `Screenshot` (captures `screenshotReq`, returns a fixture) and `Upload` (captures `uploadReq`). Verify by grep:

```bash
grep -n "func (f \*fakeBrowserController)" internal/tool/browser_tools_test.go
```
Identify which method bodies are non-trivial (capture a field or return a fixture) vs which just `return zero, nil`. Only the non-trivial ones get kept.

- [ ] **Step 2: Run the browser tests to confirm current green baseline**

Run: `go test ./internal/tool/ -run 'Browser' -v 2>&1 | tail -10`
Expected: PASS (baseline before refactor).

- [ ] **Step 3: Refactor the fake.** Replace the struct definition and DELETE all 40 method stubs, keeping ONLY the methods with real logic. New form:

```go
type fakeBrowserController struct {
	noopBrowserController // safe defaults for the 38 methods this test never calls
	screenshotReq BrowserScreenshotRequest
	uploadReq     BrowserUploadRequest
}

func (f *fakeBrowserController) Screenshot(_ context.Context, req BrowserScreenshotRequest) (BrowserScreenshot, error) {
	f.screenshotReq = req
	return BrowserScreenshot{
		Tab:      BrowserTab{TabID: 7, URL: "https://example.com", Title: "Example"},
		Format:   "png",
		Bytes:    123,
		DataURL:  "data:image/png;base64,SHOULD_NOT_LEAK",
		FilePath: filepath.Join(req.OutputDir, "shot.png"),
	}, nil
}

// (keep the Upload override too, verbatim from the current file — copy its
// existing body; do not rewrite its logic)
```

Keep WHATEVER methods currently have real bodies (Screenshot + Upload, plus any other you found in Step 1 that captures state or returns a fixture). Delete every method that was just `return zeroValue, nil`.

- [ ] **Step 4: Run the browser tests**

Run: `go test ./internal/tool/ -run 'Browser' -v 2>&1 | tail -10`
Expected: PASS — identical behavior, the deleted stubs are now inherited from the base.

Run: `go vet ./internal/tool/` — expected: clean (catches any embedding/shadowing surprise).

- [ ] **Step 5: Commit**

```bash
git add internal/tool/browser_tools_test.go
git commit -m "test(tool): fakeBrowserController embeds noop base (drop 38 stubs)"
```

---

### Task 3: Refactor the user_test recorder + countingBrowser

**Files:**
- Modify: `internal/tool/browser_tools_user_test.go` (the recorder fake)
- Modify: `internal/tool/agent_spawn_test.go:11-19` (`countingBrowser`)

- [ ] **Step 1: Inspect the user_test recorder.** Find its type + which methods carry real recording logic:

```bash
grep -n "type.*struct\|func (.*) [A-Z].*context.Context" internal/tool/browser_tools_user_test.go | head -60
```
Determine the recorder's type name and which methods record state vs which are empty stubs.

- [ ] **Step 2: Baseline green**

Run: `go test ./internal/tool/ -run 'Browser|Spawn|Agent' -v 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 3: Refactor the recorder.** Embed `noopBrowserController` in the recorder struct, DELETE every method that was a bare `return zero, nil` stub, keep only the methods that record/assert. Same pattern as Task 2.

- [ ] **Step 4: Refactor countingBrowser.** In `agent_spawn_test.go`, change the embed from the nil interface to the no-op base for panic-safety:

```go
type countingBrowser struct {
	noopBrowserController // safe defaults; only NewTab is exercised
	newTabs              int
}

func (b *countingBrowser) NewTab(context.Context, string) (BrowserTab, error) {
	b.newTabs++
	return BrowserTab{TabID: b.newTabs}, nil
}
```
(Was `BrowserController // embed nil`. The behavior is identical for tests that only call NewTab, but now an accidental call to another method returns an error instead of panicking.)

- [ ] **Step 5: Run the affected tests**

Run: `go test ./internal/tool/ -run 'Browser|Spawn|Agent' -v 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 6: Full suite + vet**

Run: `go test ./...` — expected: PASS.
Run: `go vet ./internal/tool/` — expected: clean.

- [ ] **Step 7: Commit**

```bash
git add internal/tool/browser_tools_user_test.go internal/tool/agent_spawn_test.go
git commit -m "test(tool): recorder + countingBrowser embed noop base"
```

---

### Task 4: Verify the LOC win + no production impact

**Files:** none (verification only)

- [ ] **Step 1: Confirm no production (non-test) file changed except the new base**

Run:
```bash
git diff --stat <task-1-base-sha>..HEAD -- internal/
```
Expected: only `browser_noop.go` (new, non-test) + `_test.go` files. NO change to `tool.go`, `browser_tools.go` (production), or `internal/browser/`.

- [ ] **Step 2: Confirm the boilerplate reduction**

Run:
```bash
git diff --shortstat <task-1-base-sha>..HEAD -- internal/tool/browser_tools_test.go internal/tool/browser_tools_user_test.go internal/tool/agent_spawn_test.go
```
Expected: net deletions in the test files (the dropped stubs) — should show a substantial negative delta.

- [ ] **Step 3: Final green + race**

Run: `go test ./... && go test -race ./internal/tool/...`
Expected: PASS.

No commit (verification only). If all green, C3-alt is done.

---

## Self-Review

**1. Spec coverage:** Goal = remove duplicated 40-stub boilerplate via a shared no-op base, test-only, no interface/Controller/production change. Covered: base added (Task 1), all 3 fakes refactored (Tasks 2-3), production-untouched verified (Task 4). ✅

**2. Placeholder scan:** The one deliberate "…CONTINUE for the remaining methods" in Task 1 Step 3 is gated by an explicit compile-time checklist (`var _ BrowserController` assertion forces all 40) + the instruction to copy signatures verbatim from the interface. Not a true placeholder — the mechanism to complete it is exact. Every other step has concrete code.

**3. Type consistency:** `noopBrowserController` (value receiver), `errNoopBrowser`, embedded by value in each fake. Consistent across tasks. Fakes keep their existing real-logic method bodies verbatim. ✅

**Risk:** Near-zero. Test-only. The compiler enforces interface satisfaction; behavior of kept methods is copied verbatim; dropped methods were no-op stubs whose inherited base behavior (error) only triggers if a test calls a method it never called before (it won't — same call sites).
