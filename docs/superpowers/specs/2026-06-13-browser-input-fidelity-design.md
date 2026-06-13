# Browser Input Fidelity — Design

Date: 2026-06-13
Scope: fix 7 fidelity defects in PierCode's browser pointer/keyboard/scroll/screenshot
dispatch so the browser-internal computer-use behaves like a real user (correct
coordinates, human-like timing/trajectory) before any new capability (Set-of-Marks)
is layered on top.

All changes are server-side in `internal/browser/` plus a small struct change in
`internal/tool/tool.go`. No extension changes required except the screenshot metadata
plumbing (#7), which is read from CDP, not the extension.

## Decisions (locked)

- Fix **all 7** defects in one batch, each its own commit, each with a test.
- Realism defaults **ON, overridable OFF** — hold/interpolation/per-char delay are
  applied by default (more human, steadier past anti-bot), but every knob is tunable
  to 0 for an instant mode. A single `InputFidelity` config struct on `Controller`
  carries the defaults; per-request params (where they exist) override per call.

## Config carrier

Add an `InputFidelity` struct and a field on `Controller`:

```go
// internal/browser/controller.go
type InputFidelity struct {
    ClickHoldMS    int // press→release hold; default 45
    MoveSteps      int // interpolated mouseMoved points per move; default 5
    DragSteps      int // interpolated moves during a drag; default 16
    DragHoldMS     int // pause after press before first drag move; default 60
    WheelTickPx    int // max px per synthesized wheel tick; default 110
    TypeCharDelayMS int // inter-keystroke delay for typed text; default 18
    SettleMS       int // post-action settle before returning/next screenshot; default 0 (opt-in per tool)
}

func defaultInputFidelity() InputFidelity {
    return InputFidelity{ClickHoldMS: 45, MoveSteps: 5, DragSteps: 16,
        DragHoldMS: 60, WheelTickPx: 110, TypeCharDelayMS: 18, SettleMS: 0}
}
```

`Controller` gains `fidelity InputFidelity`. Constructor sets `defaultInputFidelity()`.
A setter `SetInputFidelity(InputFidelity)` allows tests/CLI to override. Zero on any
field means "skip that behavior" (instant), so `InputFidelity{}` = current behavior —
this keeps every fix bisectable and lets a future `--instant-input` flag disable all.

`SettleMS` defaults 0 because a blanket post-click sleep slows everything; it is opt-in:
tools that benefit (click, type, drag) call `settle()` which is a no-op at 0.

---

## Fix #7 — DPR / screenshot↔click coordinate alignment  🔴🔴🔴 (do first)

**Defect**: clicks use CSS-pixel viewport coords; `Page.captureScreenshot` returns a
device-pixel bitmap (Retina ≈2×) and `budgetScreenshot` may further downscale. The
`BrowserScreenshot.Width/Height` fields are never populated. So an AI reading a point
off the screenshot cannot map it back to the click coordinate space — on Retina it
clicks at half the intended position.

**Fix**: make the screenshot self-describing so the model (and any grounding code) can
convert screenshot-px → CSS-px.

1. Before `captureScreenshot`, call CDP `Page.getLayoutMetrics` once; read
   `cssLayoutViewport` (`clientWidth/clientHeight`, in CSS px) and `visualViewport`
   (`scale`, `pageX/pageY` for scroll offset). Read `devicePixelRatio` via a cheap
   `Runtime.evaluate("window.devicePixelRatio")` (getLayoutMetrics does not expose DPR
   directly).
2. Capture as today. Record the **decoded image's real pixel dims** (decode header, or
   reuse the `image.Decode` already done inside `budgetScreenshot`) BEFORE and AFTER the
   budget pass so we know the final downscale factor.
3. Populate `BrowserScreenshot`:
   - `Width`, `Height` = final image pixel dims (post-budget).
   - new `CSSWidth`, `CSSHeight int` = layout viewport in CSS px.
   - new `DevicePixelRatio float64`.
   - new `ScreenshotScale float64` = `Width / CSSWidth` (the single multiplier the AI
     needs: `cssX = screenshotX / ScreenshotScale`). Combines DPR and budget downscale
     into one number.
   - new `ScrollX, ScrollY float64` = visualViewport page offset (so a full-page or
     scrolled capture maps correctly).
4. The tool layer (`browser_tools.go` screenshot result formatting) appends a one-line
   machine-readable footer to the tool result, e.g.
   `[screenshot 1512x982 px · css 756x491 · scale 2.00 · dpr 2 · scroll 0,0]`
   so the AI is explicitly told the conversion factor. This is the crucial detail —
   the number must reach the model, not just live in the struct.

**Alternative considered**: capture with `clip + scale:1 + fromSurface:true` (the
`browser_zoom` pattern at `controller_find.go:144`) to force a 1:1 CSS-px screenshot.
Rejected as the default because it discards Retina sharpness the model can use for small
text, and `captureBeyondViewport`/full-page interacts awkwardly with `clip`. Instead we
**report** the scale rather than force it. We MAY expose `scale:"css"` as an opt-in
screenshot param later (out of scope here).

**Struct change** (`internal/tool/tool.go`):
```go
type BrowserScreenshot struct {
    Tab BrowserTab; Format string; Bytes int
    Width, Height int           // final image pixels (populated now)
    CSSWidth, CSSHeight int     // NEW: CSS-px layout viewport
    DevicePixelRatio float64    // NEW
    ScreenshotScale float64     // NEW: Width/CSSWidth
    ScrollX, ScrollY float64    // NEW
    DataURL, FilePath string
}
```

**Test**: `controller_state_test.go` (or new `screenshot_meta_test.go`) — mock CDP to
return `getLayoutMetrics` (css 800×600, visualViewport scale 1, scroll 0,0), a 2×
device-pixel PNG (1600×1200), assert `ScreenshotScale==2`, `CSSWidth==800`,
`DevicePixelRatio==2`, and that the footer string is correct. A second case with a
budget downscale to 1200px wide asserts `ScreenshotScale==1.5`.

---

## Fix #5 — scroll: cursor coordinate + tick chunking  🔴🔴

**Defect**: `dispatchMouseWheel` hardcodes pointer `(500,500)` and sends the entire
delta in one event. Wrong scroll container if (500,500) isn't over the target; virtual
lists / lazy-load (IntersectionObserver) / inertial scroll behave differently from a
real multi-tick wheel.

**Fix**:
1. `dispatchMouseWheel(ctx, tabID, x, y, dx, dy)` — add `x,y`. Default when caller has
   no point: viewport center from `getLayoutMetrics` cssLayoutViewport (not a magic 500),
   computed once and cached per tab is unnecessary — just compute per scroll.
2. Add optional `X,Y *float64` to `BrowserScrollRequest` + `x`/`y` tool params, plumbed
   through `Scroll`. When a `ref`/`selector` is given, derive the pointer from that
   element's box center (reuse `resolvePoint`/`resolveSelectorRect`) so the wheel lands
   over the intended scroller.
3. Chunk: split `dx,dy` into ticks of at most `fidelity.WheelTickPx` (110) each, emit
   sequential `mouseWheel` events at the same point. `WheelTickPx<=0` → single event
   (instant mode). Keep total delta exact (last tick carries remainder).

**Test**: `controller_ext_test.go` — assert N wheel events for a 320px scroll at 110/tick
(= 3 events: 110,110,100), each carrying the resolved `x,y` (not 500,500). Instant-mode
(`WheelTickPx:0`) asserts a single event.

---

## Fix #3 — mouseMoved trajectory interpolation  🔴🔴

**Defect**: `dispatchMouseMoved` jumps straight to target — no intermediate points. En-route
`mouseover/mouseenter` never fire (hover-driven menus/tooltips don't open); the phantom
cursor animates visually but the **real events teleport**, so visual≠event.

**Fix**: add `moveTo(ctx, tabID, fromX,fromY, toX,toY)` that emits `fidelity.MoveSteps`
linearly-interpolated `mouseMoved` events (ease-out optional, linear is fine) ending at
target. Track last cursor position per tab (`tabs` registry gains `lastPointer map[int]Point`,
or a field on the tab) so `from` is known; default `from` = target (single event) when
unknown — i.e. first move after attach is still a jump, subsequent moves interpolate from
the real last point. `MoveSteps<=1` → single event (instant).

`dispatchClick`'s pre-move and `Hover` both route through `moveTo`. Drag (#4) uses its own
stepping.

**Test**: `controller_click_test.go` — assert that a click after a known last-pointer emits
>1 `mouseMoved` events with monotonic interpolated coords ending exactly at target;
`MoveSteps:1` asserts exactly one.

---

## Fix #1 — click press→release hold  🔴

**Defect**: `mousePressed` and `mouseReleased` sent back-to-back, 0ms apart. Long-press
detection, pointerdown timers, drag thresholds, and some anti-bot checks distinguish this
from a human.

**Fix**: in `dispatchClick`, between press and release sleep `fidelity.ClickHoldMS` (45ms,
context-cancellable). `ClickHoldMS<=0` → no sleep. For multi-click (clickCount=2/3) keep the
single dispatch carrying `clickCount` (already correct) but ensure the hold applies per the
press; double-click correctness (CDP coalescing) is preserved because we still send one
press/release pair with `clickCount:2` — see note.

**Note on double-click**: verify the current `clickCount==2` path sends `clickCount:2` in the
CDP params (it does — `dispatchClick` forwards `clickCount`), so Chromium synthesizes
`dblclick`. We do NOT change that. We only add the hold. (No 80ms inter-pair logic needed
since CDP `clickCount:2` is the supported path; the manual two-pair approach is not used.)

**Test**: `controller_click_test.go` — record timestamps of press vs release events, assert
gap ≥ ClickHoldMS−slack; `ClickHoldMS:0` asserts no enforced gap. (Use an injectable clock
or just assert the sleep call count via a seam — prefer a `sleep func(d) ` field on Controller
defaulting to `time.Sleep`, overridable in tests to record durations without real waiting.)

---

## Fix #4 — drag: press-hold + multi-step interpolation  🔴

**Defect**: `dispatchDrag` does press → ONE midpoint → release, with no pause after press.
HTML5 `dragstart` often needs a small initial move past threshold AND a beat after
mousedown; sliders/canvas need many points.

**Fix**: rewrite `dispatchDrag`:
1. `mouseMoved`(from, button none) → `mousePressed`(from, left).
2. sleep `fidelity.DragHoldMS` (60ms) — lets `dragstart`/pointerdown settle.
3. `fidelity.DragSteps` (16) linearly-interpolated `mouseMoved`(button left, buttons 1)
   from→to. First step is a small offset from `from` so threshold-based `dragstart` fires.
4. `mouseReleased`(to).
`DragSteps<=1` and `DragHoldMS<=0` reproduce a near-instant drag. `dispatchHTML5Drag`'s
fallback to `dispatchDrag` inherits this automatically.

**Test**: `controller_ext_test.go` — assert event order press → (sleep) → ≥DragSteps moves →
release, all `buttons:1` during the moves, coords interpolated from→to; instant config
collapses to the minimal sequence.

---

## Fix #6 — keyboard: per-char delay + richer chords  🟡

**Defect**: (a) `dispatchTypedKeys` types whole string with no inter-key delay — React
onChange throttle / @-mention autocomplete / debounced search can drop input. (b)
`sendKeyChord` supports only single `Meta`/`Ctrl`; no Shift/Alt, no multi-modifier
(Cmd+Shift+P).

**Fix**:
1. In `dispatchTypedKeys`, after each char's keyUp (and after each `insertText`), sleep
   `fidelity.TypeCharDelayMS` (18ms, cancellable). `<=0` → no delay (instant).
2. Generalize chords: replace the `modifier string` single-value API with a modifier SET.
   New `sendKeyChordMods(ctx, tabID, mods []string, key string)` building the CDP modifier
   bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8) from any combination, sending
   modifierDown(each) → keyDown(key, mask) → keyUp(key, mask) → modifierUp(each, reverse).
   Keep the old `sendKeyChord(modifier, key)` as a thin wrapper (single-mod) for callers,
   so behavior is additive. Add `Shift` and `Alt` to the accepted set; reject unknown.

**Test**: `controller_click_test.go`/new `controller_key_test.go` — (a) typing "ab" emits the
delay seam twice; (b) `sendKeyChordMods(["Meta","Shift"],"p")` emits mask `4|8=12` on the
keyDown and releases both modifiers in reverse order.

---

## Fix #8 — post-action settle  🟡

**Defect**: after click/type/drag the controller returns immediately; an SPA may not have
re-rendered, so the next screenshot/snapshot shows a stale frame.

**Fix**: add `settle(ctx, tabID)` — if `fidelity.SettleMS>0`, sleep that long (cancellable).
Call it at the end of `Click`, `Type`, `Drag`, `Scroll` (after `MarkStale`, before return).
Default `SettleMS:0` = no behavior change; opt-in. Optionally a per-tool param later. We do
NOT add a network-idle wait here (that's `browser_wait`/`wait_for_function`'s job) — settle is
just a cheap fixed beat for the common "click then screenshot" pattern.

**Test**: assert `settle` sleeps when SettleMS>0 and is a no-op at 0 (via the same `sleep`
seam as #1).

---

## Cross-cutting: the `sleep` seam

Fixes #1/#4/#6/#8 all need delays that are (a) context-cancellable and (b) testable without
real time. Add one field:
```go
type Controller struct {
    ...
    fidelity InputFidelity
    sleep    func(ctx context.Context, d time.Duration) error // default = ctx-aware sleep
}
```
Default impl selects on `ctx.Done()` vs `time.After(d)`. Tests inject a recorder that logs
durations and returns immediately. Every fix uses `c.sleep(...)` so no test waits real wall
time and every delay respects cancellation.

## Sequencing (commits)

1. scaffolding: `InputFidelity` struct, `Controller.fidelity`+`sleep` seam, defaults, setter.
2. Fix #7 (DPR/screenshot metadata) — struct + getLayoutMetrics + footer + tests.
3. Fix #5 (scroll coord + ticks) — tests.
4. Fix #3 (move interpolation + last-pointer tracking) — tests.
5. Fix #1 (click hold) — tests.
6. Fix #4 (drag hold + steps) — tests.
7. Fix #6 (type delay + chord mods) — tests.
8. Fix #8 (settle) — tests.

Each commit: `go test ./internal/browser/... ./internal/tool/...` green before the next.

## Out of scope (next phase — new capability)

- Set-of-Marks numbered overlay (greenfield; reuses phantom-cursor injection +
  `findElementsExpression` DOM walk).
- `scale:"css"` opt-in 1:1 screenshot param.
- Per-tool `settleMS`/`humanize` request params (config-level only for now).
- OS-level (non-browser) computer-use (option B from earlier — separate spec).

## Risk / compatibility

- `InputFidelity{}` zero value = current behavior, so the scaffolding commit is a no-op.
- Defaults ON means existing tests that count exact event sequences (e.g. "click emits 3
  events") WILL break and must be updated to expect interpolated moves / held timing — this
  is expected; the test updates ship in each fix's commit.
- All delays go through the `sleep` seam → no real-time test slowdown, all cancellable.
- Phantom cursor already animates; interpolated real `mouseMoved` now MATCHES the visual,
  removing the visual≠event mismatch.
