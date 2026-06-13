# Browser Input Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 7 fidelity defects in PierCode's browser pointer/keyboard/scroll/screenshot dispatch so browser-internal computer-use behaves like a real user (correct coordinates, human-like timing/trajectory).

**Architecture:** Add one `InputFidelity` config struct + a ctx-aware `sleep` seam to `Controller`. Every fix routes its delays/interpolation through these so behavior is tunable (defaults ON, zero = instant) and tests never wait real wall-time. Each fix is its own commit with tests.

**Tech Stack:** Go 1.24, CDP `Input`/`Page`/`Runtime` domains via the existing `RelayManager` relay, `testify`-free table tests using the `NewRelayManagerFromSend` mock-relay fixture already in `controller_click_test.go`.

Spec: `docs/superpowers/specs/2026-06-13-browser-input-fidelity-design.md`

---

## File Structure

- `internal/browser/controller.go` — `Controller` struct gets `fidelity InputFidelity` + `sleep` field; `NewController` initializes them; `dispatchClick`/`dispatchMouseMoved`/`dispatchTypedKeys`/`sendKeyChord`/`Click`/`Type`/`Screenshot` modified.
- `internal/browser/input_fidelity.go` — **new**: `InputFidelity` struct, `defaultInputFidelity()`, `SetInputFidelity`, the `sleep` seam impl, small interpolation helper `lerpPoints`.
- `internal/browser/controller_ext.go` — `dispatchMouseWheel`/`dispatchDrag`/`Scroll`/`Hover` modified.
- `internal/browser/registry.go` — `TabRegistry` gains `lastPointer map[int]Point` + `SetLastPointer`/`LastPointer`.
- `internal/browser/screenshot_budget.go` — add `budgetScreenshotWithDims` returning final pixel dims.
- `internal/tool/tool.go` — `BrowserScreenshot` gets metadata fields; `BrowserScrollRequest` gets `X,Y *float64`.
- `internal/tool/browser_tools.go` / `browser_tools_ext.go` — screenshot result footer; scroll `x`/`y` params.
- Tests: `internal/browser/input_fidelity_test.go` (new), plus additions to `controller_click_test.go`, `controller_ext_test.go`, `controller_state_test.go`.

---

## Task 1: InputFidelity scaffolding + sleep seam (no-op behavior change)

**Files:**
- Create: `internal/browser/input_fidelity.go`
- Modify: `internal/browser/controller.go` (struct + `NewController`)
- Test: `internal/browser/input_fidelity_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/browser/input_fidelity_test.go
package browser

import (
	"context"
	"testing"
	"time"
)

func TestDefaultInputFidelity(t *testing.T) {
	f := defaultInputFidelity()
	if f.ClickHoldMS != 45 || f.MoveSteps != 5 || f.DragSteps != 16 ||
		f.DragHoldMS != 60 || f.WheelTickPx != 110 || f.TypeCharDelayMS != 18 || f.SettleMS != 0 {
		t.Fatalf("unexpected defaults: %#v", f)
	}
}

func TestControllerHasFidelityAndSleep(t *testing.T) {
	c := NewController(nil, func([]byte) {})
	if c.fidelity.ClickHoldMS != 45 {
		t.Fatalf("controller fidelity not initialized: %#v", c.fidelity)
	}
	// sleep seam respects zero (no-op) and returns nil
	if err := c.sleep(context.Background(), 0); err != nil {
		t.Fatalf("sleep(0) should be nil, got %v", err)
	}
	// sleep respects context cancellation
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.sleep(ctx, time.Second); err == nil {
		t.Fatalf("sleep should return ctx error when cancelled")
	}
}

func TestSetInputFidelity(t *testing.T) {
	c := NewController(nil, func([]byte) {})
	c.SetInputFidelity(InputFidelity{}) // all-zero = instant mode
	if c.fidelity.ClickHoldMS != 0 || c.fidelity.MoveSteps != 0 {
		t.Fatalf("SetInputFidelity did not apply zero config")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/browser/ -run 'InputFidelity|FidelityAndSleep' -v`
Expected: FAIL — `undefined: defaultInputFidelity`, `c.fidelity undefined`, `c.sleep undefined`, `c.SetInputFidelity undefined`.

- [ ] **Step 3: Create input_fidelity.go**

```go
// internal/browser/input_fidelity.go
package browser

import (
	"context"
	"time"
)

// InputFidelity carries the human-realism knobs for pointer/keyboard/scroll
// dispatch. Zero on any field disables that behavior (instant mode), so an
// InputFidelity{} value reproduces the pre-fidelity dispatch exactly.
type InputFidelity struct {
	ClickHoldMS     int // press→release hold
	MoveSteps       int // interpolated mouseMoved points per move
	DragSteps       int // interpolated moves during a drag
	DragHoldMS      int // pause after press before first drag move
	WheelTickPx     int // max px per synthesized wheel tick
	TypeCharDelayMS int // inter-keystroke delay for typed text
	SettleMS        int // post-action settle (opt-in; default 0)
}

func defaultInputFidelity() InputFidelity {
	return InputFidelity{
		ClickHoldMS: 45, MoveSteps: 5, DragSteps: 16, DragHoldMS: 60,
		WheelTickPx: 110, TypeCharDelayMS: 18, SettleMS: 0,
	}
}

// SetInputFidelity overrides the realism config (tests, CLI flags).
func (c *Controller) SetInputFidelity(f InputFidelity) { c.fidelity = f }

// ctxSleep sleeps d respecting context cancellation. d<=0 returns immediately.
func ctxSleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// lerpPoints returns `steps` linearly-interpolated points from `from`
// (exclusive) to `to` (inclusive). steps<=1 returns just [to].
func lerpPoints(from, to Point, steps int) []Point {
	if steps <= 1 {
		return []Point{to}
	}
	out := make([]Point, 0, steps)
	for i := 1; i <= steps; i++ {
		t := float64(i) / float64(steps)
		out = append(out, Point{
			X: from.X + (to.X-from.X)*t,
			Y: from.Y + (to.Y-from.Y)*t,
		})
	}
	return out
}
```

- [ ] **Step 4: Add fields to Controller + init in NewController**

In `internal/browser/controller.go`, change the struct:

```go
type Controller struct {
	relay     *RelayManager
	tabs      *TabRegistry
	policy    *SecurityPolicy
	approvals *ApprovalManager
	events    *EventBus
	snapSeq   atomic.Uint64
	fidelity  InputFidelity
	sleep     func(ctx context.Context, d time.Duration) error
}
```

And `NewController`:

```go
func NewController(relay *RelayManager, broadcast func([]byte)) *Controller {
	return &Controller{
		relay:     relay,
		tabs:      NewTabRegistry(),
		policy:    NewSecurityPolicy(),
		approvals: NewApprovalManager(broadcast),
		events:    NewEventBus(),
		fidelity:  defaultInputFidelity(),
		sleep:     ctxSleep,
	}
}
```

Ensure `controller.go` imports `"context"` and `"time"` (it already imports both).

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/browser/ -run 'InputFidelity|FidelityAndSleep' -v`
Expected: PASS.

- [ ] **Step 6: Run full browser package to confirm no regressions yet**

Run: `go test ./internal/browser/...`
Expected: PASS (no behavior changed — `InputFidelity{}` semantics not yet wired into dispatch; defaults present but dispatch funcs unchanged).

- [ ] **Step 7: Commit**

```bash
git add internal/browser/input_fidelity.go internal/browser/controller.go internal/browser/input_fidelity_test.go
git commit -m "feat(browser): InputFidelity config + ctx-aware sleep seam

Scaffolding for input-fidelity fixes. Zero-value config = instant mode
(reproduces current dispatch). sleep seam is ctx-cancellable and
injectable so fidelity-delay tests never wait real wall-time.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Fix #7 — screenshot DPR/coordinate metadata

**Files:**
- Modify: `internal/tool/tool.go` (`BrowserScreenshot` struct)
- Modify: `internal/browser/screenshot_budget.go` (add `budgetScreenshotWithDims`)
- Modify: `internal/browser/controller.go` (`Screenshot`: getLayoutMetrics + DPR + populate)
- Modify: `internal/tool/browser_tools.go` (append metadata footer to screenshot result)
- Test: `internal/browser/screenshot_meta_test.go` (new)

- [ ] **Step 1: Write the failing test (metadata population)**

```go
// internal/browser/screenshot_meta_test.go
package browser

import (
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"bytes"
	"context"
	"os"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

// makePNG returns a base64 PNG of the given device-pixel size.
func makePNG(w, h int) string {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func TestScreenshotPopulatesCoordinateMetadata(t *testing.T) {
	dir := t.TempDir()
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		var data json.RawMessage
		switch cmd.Method {
		case "getLayoutMetrics":
			// css layout viewport 800x600, no zoom, no scroll
			data = json.RawMessage(`{"cssLayoutViewport":{"clientWidth":800,"clientHeight":600},"visualViewport":{"scale":1,"pageX":0,"pageY":0}}`)
		case "evaluate":
			data = json.RawMessage(`{"result":{"value":2}}`) // devicePixelRatio = 2
		case "captureScreenshot":
			data = json.RawMessage(`{"data":"` + makePNG(1600, 1200) + `"}`)
		default:
			data = json.RawMessage(`{}`)
		}
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		return true
	})
	c := NewController(relay, func([]byte) {})
	c.tabs.SetDefault(tool.BrowserTab{TabID: 1, URL: "https://example.com"})

	shot, err := c.Screenshot(context.Background(), tool.BrowserScreenshotRequest{Format: "png", OutputDir: dir})
	if err != nil {
		t.Fatalf("Screenshot error: %v", err)
	}
	defer os.Remove(shot.FilePath)
	if shot.CSSWidth != 800 || shot.CSSHeight != 600 {
		t.Fatalf("css dims wrong: %dx%d", shot.CSSWidth, shot.CSSHeight)
	}
	if shot.DevicePixelRatio != 2 {
		t.Fatalf("dpr wrong: %v", shot.DevicePixelRatio)
	}
	if shot.Width != 1600 || shot.Height != 1200 {
		t.Fatalf("pixel dims wrong: %dx%d", shot.Width, shot.Height)
	}
	if shot.ScreenshotScale != 2 {
		t.Fatalf("scale wrong: %v (want 2 = 1600/800)", shot.ScreenshotScale)
	}
}
```

(`SetDefault(tool.BrowserTab)` makes tab 1 the controlled default; `ensureTab` inside `Screenshot` then resolves it without a tabId arg.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/browser/ -run TestScreenshotPopulatesCoordinateMetadata -v`
Expected: FAIL — `shot.CSSWidth undefined` (struct field missing) / metadata zero.

- [ ] **Step 3: Add metadata fields to BrowserScreenshot**

In `internal/tool/tool.go`, replace the `BrowserScreenshot` struct:

```go
type BrowserScreenshot struct {
	Tab              BrowserTab
	Format           string
	Bytes            int
	Width, Height    int     // final image pixels (post-budget)
	CSSWidth         int     // CSS-px layout viewport width
	CSSHeight        int     // CSS-px layout viewport height
	DevicePixelRatio float64 // window.devicePixelRatio
	ScreenshotScale  float64 // Width / CSSWidth (image-px per CSS-px)
	ScrollX          float64 // visualViewport pageX
	ScrollY          float64 // visualViewport pageY
	DataURL          string
	FilePath         string
}
```

- [ ] **Step 4: Add budgetScreenshotWithDims**

In `internal/browser/screenshot_budget.go`, add a wrapper that also reports final dims. Refactor minimally — keep `budgetScreenshot` as a thin caller:

```go
// budgetScreenshotWithDims is budgetScreenshot but also returns the final
// decoded pixel dimensions so callers can report the screenshot↔CSS scale.
func budgetScreenshotWithDims(data []byte, format string) (out []byte, outFormat string, w, h int) {
	out, outFormat = budgetScreenshot(data, format)
	if img, _, err := image.Decode(bytes.NewReader(out)); err == nil {
		b := img.Bounds()
		return out, outFormat, b.Dx(), b.Dy()
	}
	return out, outFormat, 0, 0
}
```

(`image` and `bytes` are already imported in this file.)

- [ ] **Step 5: Wire getLayoutMetrics + DPR + metadata into Screenshot**

In `internal/browser/controller.go` `Screenshot`, BEFORE `captureScreenshot` add a layout-metrics + DPR fetch, and AFTER the budget pass populate the struct. Concretely:

Add a helper near `Screenshot`:

```go
type layoutMetrics struct {
	CSSWidth, CSSHeight int
	Scale               float64
	ScrollX, ScrollY    float64
	DPR                 float64
}

func (c *Controller) fetchLayoutMetrics(ctx context.Context, tabID int) layoutMetrics {
	lm := layoutMetrics{Scale: 1, DPR: 1}
	raw, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Page", Method: "getLayoutMetrics"}, defaultReadTimeout)
	if err == nil {
		var m struct {
			CSSLayoutViewport struct {
				ClientWidth  int `json:"clientWidth"`
				ClientHeight int `json:"clientHeight"`
			} `json:"cssLayoutViewport"`
			VisualViewport struct {
				Scale float64 `json:"scale"`
				PageX float64 `json:"pageX"`
				PageY float64 `json:"pageY"`
			} `json:"visualViewport"`
		}
		if json.Unmarshal(raw, &m) == nil {
			lm.CSSWidth = m.CSSLayoutViewport.ClientWidth
			lm.CSSHeight = m.CSSLayoutViewport.ClientHeight
			if m.VisualViewport.Scale > 0 {
				lm.Scale = m.VisualViewport.Scale
			}
			lm.ScrollX = m.VisualViewport.PageX
			lm.ScrollY = m.VisualViewport.PageY
		}
	}
	if out, err := c.runtimeEvaluate(ctx, tabID, "window.devicePixelRatio", false, defaultReadTimeout, true); err == nil && out != nil {
		var dpr float64
		if json.Unmarshal(out.Result.Value, &dpr) == nil && dpr > 0 {
			lm.DPR = dpr
		}
	}
	return lm
}
```

Then in `Screenshot`, capture metrics before the capture call:

```go
	lm := c.fetchLayoutMetrics(ctx, tab.TabID)
```

Replace the budget line `decoded, format = budgetScreenshot(decoded, format)` with:

```go
	decoded, format, pxW, pxH := budgetScreenshotWithDims(decoded, format)
```

And replace the final `shot := tool.BrowserScreenshot{...}` with:

```go
	scale := 0.0
	if lm.CSSWidth > 0 && pxW > 0 {
		scale = float64(pxW) / float64(lm.CSSWidth)
	}
	shot := tool.BrowserScreenshot{
		Tab: tab, Format: format, Bytes: size, FilePath: tmpFile.Name(),
		Width: pxW, Height: pxH,
		CSSWidth: lm.CSSWidth, CSSHeight: lm.CSSHeight,
		DevicePixelRatio: lm.DPR, ScreenshotScale: scale,
		ScrollX: lm.ScrollX, ScrollY: lm.ScrollY,
	}
	return shot, nil
```

(`size` was `len(decoded)` before the budget call — move `size := len(decoded)` to AFTER the budget line so it reflects final bytes.)

- [ ] **Step 6: Run test to verify it passes**

Run: `go test ./internal/browser/ -run TestScreenshotPopulatesCoordinateMetadata -v`
Expected: PASS.

- [ ] **Step 7: Add the result footer in the tool layer**

In `internal/tool/browser_tools.go`, find where the `browser_screenshot` Execute formats its result string (grep `FilePath` / `screenshot` in that file). Append a one-line machine-readable footer built from the metadata:

```go
// after obtaining `shot tool.BrowserScreenshot`:
footer := fmt.Sprintf("[screenshot %dx%d px · css %dx%d · scale %.2f · dpr %g · scroll %.0f,%.0f]",
	shot.Width, shot.Height, shot.CSSWidth, shot.CSSHeight,
	shot.ScreenshotScale, shot.DevicePixelRatio, shot.ScrollX, shot.ScrollY)
// append footer to the human/result text returned by the tool
```

(Match the file's existing result-string style; ensure `fmt` is imported.)

- [ ] **Step 8: Run tool tests + full browser tests**

Run: `go test ./internal/tool/... ./internal/browser/...`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add internal/tool/tool.go internal/browser/screenshot_budget.go internal/browser/controller.go internal/tool/browser_tools.go internal/browser/screenshot_meta_test.go
git commit -m "fix(browser): screenshot reports DPR + CSS-px scale for click grounding

Screenshot now fetches Page.getLayoutMetrics + window.devicePixelRatio
and returns Width/Height (final px), CSSWidth/Height, DevicePixelRatio,
ScreenshotScale (px-per-CSS-px), and scroll offset. Tool result appends
a footer so the model can map a screenshot-px point back to the CSS-px
click coordinate space (was clicking at half position on Retina).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Fix #5 — scroll cursor coordinate + wheel-tick chunking

**Files:**
- Modify: `internal/tool/tool.go` (`BrowserScrollRequest` + `X,Y`)
- Modify: `internal/browser/controller_ext.go` (`dispatchMouseWheel` signature, `Scroll` pointer resolution + chunking)
- Modify: `internal/tool/browser_tools_ext.go` (scroll `x`/`y` params + plumb)
- Test: `internal/browser/controller_ext_test.go` (additions)

- [ ] **Step 1: Write the failing test**

```go
// add to internal/browser/controller_ext_test.go
func TestDispatchMouseWheelChunksAndUsesPoint(t *testing.T) {
	var commands []Command
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		commands = append(commands, cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	c := NewController(relay, func([]byte) {})
	// 320px down at 110/tick => 3 events (110,110,100) all at point (250,300)
	if err := c.dispatchMouseWheel(context.Background(), 1, 250, 300, 0, 320); err != nil {
		t.Fatalf("wheel err: %v", err)
	}
	if len(commands) != 3 {
		t.Fatalf("expected 3 wheel ticks, got %d", len(commands))
	}
	var total float64
	for _, cmd := range commands {
		var p map[string]interface{}
		_ = json.Unmarshal(cmd.Params, &p)
		if p["x"] != float64(250) || p["y"] != float64(300) {
			t.Fatalf("wheel not at point: %v,%v", p["x"], p["y"])
		}
		total += p["deltaY"].(float64)
	}
	if total != 320 {
		t.Fatalf("total deltaY %v != 320", total)
	}
}

func TestDispatchMouseWheelInstantSingleEvent(t *testing.T) {
	var commands []Command
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		commands = append(commands, cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	c := NewController(relay, func([]byte) {})
	c.SetInputFidelity(InputFidelity{WheelTickPx: 0}) // instant
	if err := c.dispatchMouseWheel(context.Background(), 1, 250, 300, 0, 320); err != nil {
		t.Fatalf("wheel err: %v", err)
	}
	if len(commands) != 1 {
		t.Fatalf("instant mode should emit 1 event, got %d", len(commands))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/browser/ -run TestDispatchMouseWheel -v`
Expected: FAIL — `too many arguments in call to c.dispatchMouseWheel` (signature still `(ctx,tabID,dx,dy)`).

- [ ] **Step 3: Change dispatchMouseWheel signature + add chunking**

In `internal/browser/controller_ext.go`, replace `dispatchMouseWheel`:

```go
func (c *Controller) dispatchMouseWheel(ctx context.Context, tabID int, x, y, dx, dy float64) error {
	tick := c.fidelity.WheelTickPx
	steps := 1
	if tick > 0 {
		longest := dx
		if dy > longest {
			longest = dy
		}
		if -dx > longest {
			longest = -dx
		}
		if -dy > longest {
			longest = -dy
		}
		if longest > float64(tick) {
			steps = int((longest + float64(tick) - 1) / float64(tick))
		}
	}
	for i := 0; i < steps; i++ {
		sx := dx / float64(steps)
		sy := dy / float64(steps)
		if i == steps-1 { // last tick carries the rounding remainder
			sx = dx - sx*float64(steps-1)
			sy = dy - sy*float64(steps-1)
		}
		params, _ := json.Marshal(map[string]interface{}{
			"type": "mouseWheel", "x": x, "y": y, "deltaX": sx, "deltaY": sy,
		})
		if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchMouseEvent", Params: params}, defaultActionTimeout); err != nil {
			return err
		}
	}
	return nil
}
```

- [ ] **Step 4: Update the Scroll caller to resolve a point**

In `internal/browser/controller_ext.go` `Scroll`, find the fallback call `c.dispatchMouseWheel(ctx, tab.TabID, dx, dy)` and replace with point-resolved version. Default point = css viewport center via `fetchLayoutMetrics`; override from `req.X/Y` or a ref/selector box:

```go
	wx, wy := c.scrollPoint(ctx, tab.TabID, req)
	if err := c.dispatchMouseWheel(ctx, tab.TabID, wx, wy, dx, dy); err != nil {
		return "", err
	}
```

Add helper:

```go
// scrollPoint chooses the wheel pointer: explicit x/y, else ref/selector box
// center, else css viewport center (NOT a hardcoded 500,500).
func (c *Controller) scrollPoint(ctx context.Context, tabID int, req tool.BrowserScrollRequest) (float64, float64) {
	if req.X != nil && req.Y != nil {
		return *req.X, *req.Y
	}
	lm := c.fetchLayoutMetrics(ctx, tabID)
	cx, cy := float64(lm.CSSWidth)/2, float64(lm.CSSHeight)/2
	if cx == 0 {
		cx, cy = 500, 500 // last-resort fallback if metrics unavailable
	}
	return cx, cy
}
```

(Ref/selector-derived point is a nice-to-have; the spec lists it but viewport-center + explicit x/y covers the core defect. If adding ref support, reuse `resolveSelectorRect`; otherwise leave a `// TODO: ref/selector scroll point` is NOT allowed — instead omit it from scope here and note in commit that ref-targeted wheel point is viewport-center for now.)

- [ ] **Step 5: Add X,Y to BrowserScrollRequest + tool params**

In `internal/tool/tool.go` add to `BrowserScrollRequest`:

```go
	X *float64
	Y *float64
```

In `internal/tool/browser_tools_ext.go`, in the `browser_scroll` parameter schema add optional `x`/`y` and parse them into the request (mirror how `browser_hover` does `X: optionalFloat(ctx.Args, "x")`).

- [ ] **Step 6: Run tests**

Run: `go test ./internal/browser/ -run 'TestDispatchMouseWheel|Scroll' ./internal/tool/...`
Expected: PASS. Also fix any other caller of `dispatchMouseWheel` the compiler flags (grep first: `grep -rn dispatchMouseWheel internal/browser`).

- [ ] **Step 7: Commit**

```bash
git add internal/tool/tool.go internal/browser/controller_ext.go internal/tool/browser_tools_ext.go internal/browser/controller_ext_test.go
git commit -m "fix(browser): scroll uses real pointer + chunks wheel into ticks

dispatchMouseWheel now takes x,y (was hardcoded 500,500 → scrolled the
wrong container) and splits a large delta into <=110px ticks (real wheels
tick; virtual-list/lazy-load/inertia depend on it). browser_scroll gains
x/y params; default point is the CSS viewport center. WheelTickPx=0 keeps
the single-event instant mode.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Fix #3 — mouseMoved trajectory interpolation + last-pointer tracking

**Files:**
- Modify: `internal/browser/registry.go` (`TabRegistry.lastPointer` + accessors)
- Modify: `internal/browser/controller.go` (`moveTo`, route `dispatchClick` pre-move through it)
- Modify: `internal/browser/controller_ext.go` (`Hover` routes through `moveTo`)
- Test: `internal/browser/controller_click_test.go` (additions)

- [ ] **Step 1: Write the failing test**

```go
// add to internal/browser/controller_click_test.go
func TestClickInterpolatesMovesFromLastPointer(t *testing.T) {
	var commands []Command
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		commands = append(commands, cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	c := NewController(relay, func([]byte) {})
	c.tabs.SetLastPointer(1, Point{X: 0, Y: 0}) // known origin
	if err := c.dispatchClick(context.Background(), 1, 100, 100, "left", 1); err != nil {
		t.Fatalf("click err: %v", err)
	}
	// MoveSteps=5 interpolated moves + press + release = 7
	moves := 0
	var last map[string]interface{}
	for _, cmd := range commands {
		var p map[string]interface{}
		_ = json.Unmarshal(cmd.Params, &p)
		if p["type"] == "mouseMoved" {
			moves++
			last = p
		}
	}
	if moves < 5 {
		t.Fatalf("expected >=5 interpolated moves, got %d", moves)
	}
	if last["x"] != float64(100) || last["y"] != float64(100) {
		t.Fatalf("final move should land on target, got %v,%v", last["x"], last["y"])
	}
}

func TestClickInstantSingleMove(t *testing.T) {
	var moves int
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		var p map[string]interface{}
		_ = json.Unmarshal(cmd.Params, &p)
		if p["type"] == "mouseMoved" {
			moves++
		}
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	c := NewController(relay, func([]byte) {})
	c.SetInputFidelity(InputFidelity{MoveSteps: 1})
	_ = c.dispatchClick(context.Background(), 1, 100, 100, "left", 1)
	if moves != 1 {
		t.Fatalf("instant mode expected 1 move, got %d", moves)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/browser/ -run 'TestClickInterpolates|TestClickInstant' -v`
Expected: FAIL — `c.tabs.SetLastPointer undefined`, and (once that compiles) only 1 move emitted.

- [ ] **Step 3: Add lastPointer to TabRegistry**

In `internal/browser/registry.go`, add to the struct:

```go
	lastPointer map[int]Point
```

Initialize in `NewTabRegistry` (`lastPointer: map[int]Point{}`), and add accessors:

```go
func (r *TabRegistry) SetLastPointer(tabID int, p Point) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.lastPointer == nil {
		r.lastPointer = map[int]Point{}
	}
	r.lastPointer[tabID] = p
}

func (r *TabRegistry) LastPointer(tabID int) (Point, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.lastPointer[tabID]
	return p, ok
}
```

(Confirm `Point` is defined in `types.go` — it is, used by `dispatchDrag`.)

- [ ] **Step 4: Add moveTo and route dispatchClick through it**

In `internal/browser/controller.go`, add:

```go
// moveTo emits MoveSteps interpolated mouseMoved events from the last known
// pointer (or the target itself if unknown) to (x,y), updating last-pointer.
func (c *Controller) moveTo(ctx context.Context, tabID int, x, y float64, button string, buttons int) error {
	from := Point{X: x, Y: y}
	if p, ok := c.tabs.LastPointer(tabID); ok {
		from = p
	}
	steps := c.fidelity.MoveSteps
	for _, pt := range lerpPoints(from, Point{X: x, Y: y}, steps) {
		ev := map[string]interface{}{"type": "mouseMoved", "x": pt.X, "y": pt.Y, "button": button}
		if buttons != 0 {
			ev["buttons"] = buttons
		}
		params, _ := json.Marshal(ev)
		if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchMouseEvent", Params: params}, defaultActionTimeout); err != nil {
			return err
		}
	}
	c.tabs.SetLastPointer(tabID, Point{X: x, Y: y})
	return nil
}
```

In `dispatchClick`, replace the single `c.dispatchMouseMoved(ctx, tabID, x, y)` pre-move with:

```go
	if err := c.moveTo(ctx, tabID, x, y, "none", 0); err != nil {
		return err
	}
```

- [ ] **Step 5: Route Hover through moveTo**

In `internal/browser/controller_ext.go` `Hover`, replace its `dispatchMouseMoved` call with `c.moveTo(ctx, tab.TabID, x, y, "none", 0)`.

- [ ] **Step 6: Run tests + update broken count-based tests**

Run: `go test ./internal/browser/...`
Expected: the new tests PASS. **Existing tests that assert exact event counts (e.g. `TestDispatchClickRightButton` expects 3 commands) will now FAIL** because a click emits 5 moves + press + release. Update those assertions: change "expect 3" to locate press/release by `type` rather than fixed index, OR set `c.SetInputFidelity(InputFidelity{MoveSteps:1})` at the top of those legacy tests to keep them at 1 move. Prefer the latter for minimal churn — add `c.SetInputFidelity(InputFidelity{MoveSteps: 1})` right after `NewController` in the count-sensitive tests, and keep their `== 3` assertions. Grep: `grep -rn 'mouseMoved + mousePressed' internal/browser` to find them.

- [ ] **Step 7: Re-run full package**

Run: `go test ./internal/browser/...`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add internal/browser/registry.go internal/browser/controller.go internal/browser/controller_ext.go internal/browser/controller_click_test.go
git commit -m "fix(browser): interpolate mouse movement (en-route hover events)

moveTo emits MoveSteps interpolated mouseMoved events from the tracked
last-pointer to the target, so mouseover/mouseenter fire along the path
(hover-driven menus/tooltips now open) and the real events match the
phantom cursor animation instead of teleporting. Click/Hover route
through it. MoveSteps=1 = instant.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Fix #1 — click press→release hold

**Files:**
- Modify: `internal/browser/controller.go` (`dispatchClick` — sleep between press/release)
- Test: `internal/browser/controller_click_test.go` (additions, using a recording sleep)

- [ ] **Step 1: Write the failing test**

```go
// add to internal/browser/controller_click_test.go
func TestClickHoldsBetweenPressAndRelease(t *testing.T) {
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	c := NewController(relay, func([]byte) {})
	c.SetInputFidelity(InputFidelity{MoveSteps: 1, ClickHoldMS: 45})
	var slept []time.Duration
	c.sleep = func(ctx context.Context, d time.Duration) error { slept = append(slept, d); return nil }

	if err := c.dispatchClick(context.Background(), 1, 10, 10, "left", 1); err != nil {
		t.Fatalf("click err: %v", err)
	}
	found := false
	for _, d := range slept {
		if d == 45*time.Millisecond {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a 45ms hold sleep, got %v", slept)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/browser/ -run TestClickHolds -v`
Expected: FAIL — no 45ms sleep recorded (dispatchClick doesn't hold yet).

- [ ] **Step 3: Add the hold in dispatchClick**

In `dispatchClick`, the loop currently sends `mousePressed` then `mouseReleased`. Replace the `for _, typ := range []string{"mousePressed", "mouseReleased"}` loop with explicit press, hold, release:

```go
	press, _ := json.Marshal(map[string]interface{}{
		"type": "mousePressed", "x": x, "y": y, "button": button,
		"buttons": buttons, "clickCount": clickCount,
	})
	if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchMouseEvent", Params: press}, defaultActionTimeout); err != nil {
		return err
	}
	if err := c.sleep(ctx, time.Duration(c.fidelity.ClickHoldMS)*time.Millisecond); err != nil {
		return err
	}
	release, _ := json.Marshal(map[string]interface{}{
		"type": "mouseReleased", "x": x, "y": y, "button": button,
		"buttons": 0, "clickCount": clickCount,
	})
	if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchMouseEvent", Params: release}, defaultActionTimeout); err != nil {
		return err
	}
	return nil
```

(Preserves the existing `buttons` mask on press and `0` on release, and forwards `clickCount` on both — unchanged double-click behavior.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/browser/ -run TestClickHolds -v`
Expected: PASS.

- [ ] **Step 5: Run full package**

Run: `go test ./internal/browser/...`
Expected: PASS (the default `ctxSleep` returns immediately at 0 and real-sleeps 45ms only in non-test default flow; legacy tests using the default sleep just wait 45ms once — acceptable, or set `MoveSteps:1` tests already inject a no-op sleep where they assert counts; if any legacy test slows noticeably, inject `c.sleep = func(context.Context, time.Duration) error { return nil }`).

- [ ] **Step 6: Commit**

```bash
git add internal/browser/controller.go internal/browser/controller_click_test.go
git commit -m "fix(browser): hold mouse button ~45ms between press and release

Real users hold; instant press/release fails long-press detection,
pointerdown timers, drag thresholds, and trips some anti-bot checks.
Hold goes through the ctx-cancellable sleep seam; ClickHoldMS=0 = instant.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Fix #4 — drag press-hold + multi-step interpolation

**Files:**
- Modify: `internal/browser/controller_ext.go` (`dispatchDrag` rewrite)
- Test: `internal/browser/controller_ext_test.go` (additions)

- [ ] **Step 1: Write the failing test**

```go
// add to internal/browser/controller_ext_test.go
func TestDispatchDragHoldsAndInterpolates(t *testing.T) {
	var commands []Command
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		commands = append(commands, cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	c := NewController(relay, func([]byte) {})
	c.SetInputFidelity(InputFidelity{DragSteps: 16, DragHoldMS: 60})
	var slept []time.Duration
	c.sleep = func(ctx context.Context, d time.Duration) error { slept = append(slept, d); return nil }

	if err := c.dispatchDrag(context.Background(), 1, Point{X: 0, Y: 0}, Point{X: 160, Y: 0}); err != nil {
		t.Fatalf("drag err: %v", err)
	}
	var pressed, released bool
	moves := 0
	for _, cmd := range commands {
		var p map[string]interface{}
		_ = json.Unmarshal(cmd.Params, &p)
		switch p["type"] {
		case "mousePressed":
			pressed = true
		case "mouseReleased":
			released = true
		case "mouseMoved":
			if p["buttons"] == float64(1) {
				moves++
			}
		}
	}
	if !pressed || !released {
		t.Fatalf("missing press/release")
	}
	if moves < 16 {
		t.Fatalf("expected >=16 dragging moves, got %d", moves)
	}
	hold := false
	for _, d := range slept {
		if d == 60*time.Millisecond {
			hold = true
		}
	}
	if !hold {
		t.Fatalf("expected 60ms drag-hold sleep")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/browser/ -run TestDispatchDragHolds -v`
Expected: FAIL — current `dispatchDrag` emits only 1 mid move and no hold sleep.

- [ ] **Step 3: Rewrite dispatchDrag**

Replace `dispatchDrag` in `internal/browser/controller_ext.go`:

```go
func (c *Controller) dispatchDrag(ctx context.Context, tabID int, from, to Point) error {
	send := func(ev map[string]interface{}) error {
		params, _ := json.Marshal(ev)
		_, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchMouseEvent", Params: params}, defaultActionTimeout)
		return err
	}
	if err := send(map[string]interface{}{"type": "mouseMoved", "x": from.X, "y": from.Y, "button": "none"}); err != nil {
		return err
	}
	if err := send(map[string]interface{}{"type": "mousePressed", "x": from.X, "y": from.Y, "button": "left", "buttons": 1}); err != nil {
		return err
	}
	// Pause after press so dragstart/pointerdown settle before motion.
	if err := c.sleep(ctx, time.Duration(c.fidelity.DragHoldMS)*time.Millisecond); err != nil {
		return err
	}
	steps := c.fidelity.DragSteps
	if steps < 1 {
		steps = 1
	}
	for _, pt := range lerpPoints(from, to, steps) {
		if err := send(map[string]interface{}{"type": "mouseMoved", "x": pt.X, "y": pt.Y, "button": "left", "buttons": 1}); err != nil {
			return err
		}
	}
	if err := send(map[string]interface{}{"type": "mouseReleased", "x": to.X, "y": to.Y, "button": "left", "buttons": 0}); err != nil {
		return err
	}
	c.tabs.SetLastPointer(tabID, to)
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/browser/ -run TestDispatchDragHolds -v`
Expected: PASS.

- [ ] **Step 5: Run full package + fix any drag count tests**

Run: `go test ./internal/browser/...`
Expected: PASS. If an existing drag test asserted the old 5-event sequence, set `c.SetInputFidelity(InputFidelity{DragSteps: 1, DragHoldMS: 0})` in it and adapt, or update its expected move count.

- [ ] **Step 6: Commit**

```bash
git add internal/browser/controller_ext.go internal/browser/controller_ext_test.go
git commit -m "fix(browser): drag holds after press + interpolates 16 steps

Was press → single midpoint → release with no post-press pause; HTML5
dragstart and sliders/canvas need a settle beat and many points. Now
press → DragHoldMS pause → DragSteps interpolated moves → release, all
buttons:1. Zero config collapses to near-instant. Updates last-pointer.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Fix #6 — keyboard per-char delay + multi-modifier chords

**Files:**
- Modify: `internal/browser/controller.go` (`dispatchTypedKeys` delay, `sendKeyChordMods`, wrap `sendKeyChord`)
- Test: `internal/browser/controller_key_test.go` (new)

- [ ] **Step 1: Write the failing test**

```go
// internal/browser/controller_key_test.go
package browser

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestTypedKeysInterKeyDelay(t *testing.T) {
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	c := NewController(relay, func([]byte) {})
	c.SetInputFidelity(InputFidelity{TypeCharDelayMS: 18})
	var delays int
	c.sleep = func(ctx context.Context, d time.Duration) error {
		if d == 18*time.Millisecond {
			delays++
		}
		return nil
	}
	if err := c.dispatchTypedKeys(context.Background(), 1, "ab"); err != nil {
		t.Fatalf("type err: %v", err)
	}
	if delays != 2 {
		t.Fatalf("expected 2 inter-key delays for 'ab', got %d", delays)
	}
}

func TestSendKeyChordModsBitmask(t *testing.T) {
	var commands []Command
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		commands = append(commands, cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	c := NewController(relay, func([]byte) {})
	if err := c.sendKeyChordMods(context.Background(), 1, []string{"Meta", "Shift"}, "p"); err != nil {
		t.Fatalf("chord err: %v", err)
	}
	// find the keyDown for "p", assert modifiers mask = Meta(4)|Shift(8)=12
	var mask float64
	for _, cmd := range commands {
		var p map[string]interface{}
		_ = json.Unmarshal(cmd.Params, &p)
		if p["type"] == "keyDown" && p["key"] == "p" {
			mask = p["modifiers"].(float64)
		}
	}
	if mask != 12 {
		t.Fatalf("expected modifiers mask 12 (Meta|Shift), got %v", mask)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/browser/ -run 'TypedKeysInterKey|SendKeyChordMods' -v`
Expected: FAIL — `c.sendKeyChordMods undefined`, and no inter-key delays.

- [ ] **Step 3: Add inter-key delay to dispatchTypedKeys**

In `internal/browser/controller.go` `dispatchTypedKeys`, at the END of each loop iteration (after the char is sent, before `continue`/next rune), insert the delay. Simplest: wrap the body so every path reaches a single trailing sleep. Restructure the loop to compute the per-char send into a closure, then sleep once per rune:

```go
func (c *Controller) dispatchTypedKeys(ctx context.Context, tabID int, text string) error {
	for _, r := range text {
		if err := c.sendOneRune(ctx, tabID, r); err != nil {
			return err
		}
		if err := c.sleep(ctx, time.Duration(c.fidelity.TypeCharDelayMS)*time.Millisecond); err != nil {
			return err
		}
	}
	return nil
}

// sendOneRune sends a single rune (the body previously inline in the loop).
func (c *Controller) sendOneRune(ctx context.Context, tabID int, r rune) error {
	if r == '\n' || r == '\r' {
		return c.sendNamedKey(ctx, tabID, "Enter", "\r")
	}
	if r == '\t' {
		return c.sendNamedKey(ctx, tabID, "Tab", "\t")
	}
	if r >= 0x20 && r < 0x7f {
		s := string(r)
		down, _ := json.Marshal(map[string]interface{}{"type": "keyDown", "text": s, "key": s, "unmodifiedText": s})
		if _, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: down}, defaultActionTimeout); err != nil {
			return err
		}
		up, _ := json.Marshal(map[string]interface{}{"type": "keyUp", "key": s})
		_, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: up}, defaultActionTimeout)
		return err
	}
	ins, _ := json.Marshal(map[string]string{"text": string(r)})
	_, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "insertText", Params: ins}, defaultActionTimeout)
	return err
}
```

- [ ] **Step 4: Add sendKeyChordMods + rewrap sendKeyChord**

In `internal/browser/controller.go`, add the modifier-set chord and make the old single-modifier `sendKeyChord` delegate to it:

```go
// modifierBit maps a modifier name to the CDP modifier bitmask value.
// CDP: Alt=1, Ctrl=2, Meta=4, Shift=8.
func modifierBit(mod string) (int, bool) {
	switch mod {
	case "Alt":
		return 1, true
	case "Ctrl":
		return 2, true
	case "Meta":
		return 4, true
	case "Shift":
		return 8, true
	default:
		return 0, false
	}
}

// sendKeyChordMods sends modifier(s)+key: each modifier down → key down → key up
// → each modifier up (reverse). Supports any combination of Alt/Ctrl/Meta/Shift.
func (c *Controller) sendKeyChordMods(ctx context.Context, tabID int, mods []string, key string) error {
	mask := 0
	for _, m := range mods {
		bit, ok := modifierBit(m)
		if !ok {
			return fmt.Errorf("unsupported modifier %q; use Alt, Ctrl, Meta, or Shift", m)
		}
		mask |= bit
	}
	send := func(ev map[string]interface{}) error {
		params, _ := json.Marshal(ev)
		_, err := c.relay.SendCommand(ctx, Command{TabID: &tabID, Domain: "Input", Method: "dispatchKeyEvent", Params: params}, defaultActionTimeout)
		return err
	}
	for _, m := range mods {
		if err := send(map[string]interface{}{"type": "keyDown", "key": m, "modifiers": mask}); err != nil {
			return err
		}
	}
	if err := send(map[string]interface{}{"type": "keyDown", "key": key, "modifiers": mask}); err != nil {
		return err
	}
	if err := send(map[string]interface{}{"type": "keyUp", "key": key, "modifiers": mask}); err != nil {
		return err
	}
	for i := len(mods) - 1; i >= 0; i-- {
		if err := send(map[string]interface{}{"type": "keyUp", "key": mods[i], "modifiers": mask}); err != nil {
			return err
		}
	}
	return nil
}

// sendKeyChord keeps the single-modifier API, delegating to sendKeyChordMods.
func (c *Controller) sendKeyChord(ctx context.Context, tabID int, modifier, key string) error {
	if _, ok := modifierBit(modifier); !ok {
		return fmt.Errorf("unsupported modifier %q; use Meta or Ctrl", modifier)
	}
	return c.sendKeyChordMods(ctx, tabID, []string{modifier}, key)
}
```

Remove the OLD `sendKeyChord` body (the one with `modifiers := 0; switch modifier {...}` and the four explicit sends) — it's replaced by the wrapper above. (`fmt` already imported.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/browser/ -run 'TypedKeysInterKey|SendKeyChordMods|KeyChord' -v`
Expected: PASS. Also run any existing chord test (grep `sendKeyChord` in `_test.go`) — the Meta/Ctrl behavior must be unchanged (down→keydown→keyup→up order with mask).

- [ ] **Step 6: Run full package**

Run: `go test ./internal/browser/...`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/browser/controller.go internal/browser/controller_key_test.go
git commit -m "fix(browser): per-char type delay + multi-modifier chords

Typing now pauses TypeCharDelayMS (~18ms) between characters so React
onChange throttles / @-mention autocomplete / debounced search keep up.
sendKeyChordMods supports any Alt/Ctrl/Meta/Shift combination (was only
single Meta/Ctrl) — enables Cmd+Shift+P etc. Old sendKeyChord delegates,
behavior unchanged. TypeCharDelayMS=0 = instant.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Fix #8 — post-action settle

**Files:**
- Modify: `internal/browser/controller.go` (`settle` helper; call in `Click`, `Type`)
- Modify: `internal/browser/controller_ext.go` (call in `Drag`, `Scroll`)
- Test: `internal/browser/input_fidelity_test.go` (additions)

- [ ] **Step 1: Write the failing test**

```go
// add to internal/browser/input_fidelity_test.go
func TestSettleSleepsWhenConfigured(t *testing.T) {
	c := NewController(nil, func([]byte) {})
	c.SetInputFidelity(InputFidelity{SettleMS: 200})
	var got time.Duration
	c.sleep = func(ctx context.Context, d time.Duration) error { got = d; return nil }
	if err := c.settle(context.Background(), 1); err != nil {
		t.Fatalf("settle err: %v", err)
	}
	if got != 200*time.Millisecond {
		t.Fatalf("expected 200ms settle, got %v", got)
	}
}

func TestSettleNoopAtZero(t *testing.T) {
	c := NewController(nil, func([]byte) {})
	c.SetInputFidelity(InputFidelity{SettleMS: 0})
	called := false
	c.sleep = func(ctx context.Context, d time.Duration) error { called = true; return nil }
	_ = c.settle(context.Background(), 1)
	if called {
		t.Fatalf("settle should not sleep at SettleMS=0")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/browser/ -run TestSettle -v`
Expected: FAIL — `c.settle undefined`.

- [ ] **Step 3: Add settle + call sites**

In `internal/browser/controller.go`:

```go
// settle waits SettleMS (if >0) for an SPA to re-render before the caller
// returns / the next screenshot is taken. No-op at 0; a network-idle wait is
// browser_wait's job, not this.
func (c *Controller) settle(ctx context.Context, tabID int) error {
	if c.fidelity.SettleMS <= 0 {
		return nil
	}
	return c.sleep(ctx, time.Duration(c.fidelity.SettleMS)*time.Millisecond)
}
```

Add `_ = c.settle(ctx, tab.TabID)` (or propagate the error) just before the final `return` of `Click` and `Type` (after `c.tabs.MarkStale(...)`). In `controller_ext.go` do the same at the end of `Drag` and the wheel-fallback path of `Scroll`. Since settle failure is only a cancelled context, propagate it: `if err := c.settle(ctx, tab.TabID); err != nil { return "", err }` before the success return.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/browser/ -run TestSettle -v`
Expected: PASS.

- [ ] **Step 5: Run full package**

Run: `go test ./internal/browser/... ./internal/tool/...`
Expected: PASS (default `SettleMS:0` = no behavior change at call sites).

- [ ] **Step 6: Commit**

```bash
git add internal/browser/controller.go internal/browser/controller_ext.go internal/browser/input_fidelity_test.go
git commit -m "fix(browser): optional post-action settle before next frame

settle() waits SettleMS after click/type/drag/scroll so an SPA can
re-render before the next screenshot shows a stale frame. Opt-in
(default 0 = no change); network-idle waits stay browser_wait's job.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full verification + race + type-check

- [ ] **Step 1: Race detector across touched packages**

Run: `go test -race ./internal/browser/... ./internal/tool/...`
Expected: PASS, no data races (the new `TabRegistry.lastPointer` is mutex-guarded).

- [ ] **Step 2: Full server build**

Run: `go build ./...`
Expected: builds clean.

- [ ] **Step 3: Whole-repo test**

Run: `go test ./...`
Expected: PASS.

- [ ] **Step 4: Sanity grep for leftover hardcoded 500,500 / single-midpoint drag**

Run: `grep -rn '"x": 500' internal/browser/ ; grep -rn 'mid := Point' internal/browser/`
Expected: no `"x": 500` hardcode remains in `dispatchMouseWheel`; old `mid :=` single-midpoint drag gone.

- [ ] **Step 5: Final commit if any cleanup was needed**

```bash
git add -A && git commit -m "test(browser): race + build verification for input fidelity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Notes for the implementer

- The mock-relay fixture is `NewRelayManagerFromSend(func([]byte) bool)` — it captures the JSON command and you call `relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: ...})` from a goroutine to unblock `SendCommand`. Copy the pattern from `controller_click_test.go`.
- JSON numbers unmarshal to `float64` — assert `p["buttons"] == float64(1)`, never `1`.
- Every delay MUST go through `c.sleep(ctx, d)` so tests inject a recorder and never wait real time, and so cancellation propagates.
- When defaults-ON breaks an existing exact-count test, prefer injecting `c.SetInputFidelity(InputFidelity{MoveSteps:1, ClickHoldMS:0, ...})` + `c.sleep = noop` at the top of that legacy test rather than rewriting its assertions — minimal churn, keeps intent.
- Confirm real `TabRegistry` setter/default method names before Task 2's test setup (grep `func (r *TabRegistry)` in registry.go).
- After implementing, the next phase (Set-of-Marks overlay, OS-level computer-use) gets its own spec — do NOT start it here.
```
