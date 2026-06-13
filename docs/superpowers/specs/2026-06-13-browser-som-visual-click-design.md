# Browser Set-of-Marks Visual Click + Tool Augmentation — Design

Date: 2026-06-13
Scope: add 6 new browser capabilities on top of the just-landed input-fidelity
fixes (commits eed62f7..4e4272d). Builds the Set-of-Marks visual-click suite plus
two independent tool augmentations.

Spec follows-on from: `2026-06-13-browser-input-fidelity-design.md` (coordinate
alignment + visible cursor + interpolation are prerequisites — now done).

## Decisions (locked by user; technical details delegated to implementer)

- Do all 6: D1, A1, A2 (SoM suite, serial chain) + D2 + D3. A4 (OCR) SKIPPED.
- A1/A2 rendering: BOTH inject a live overlay AND return a numbered screenshot.
- A2 interface: extend the existing `browser_click` (add a `mark` param), no new tool.
- D3: keep the GIF burst-frame recorder, only ENHANCE it (configurable rate/duration/
  quality + webp/mp4 output). No CDP screencast streaming.
- D1: reuse `findElementsExpression` DOM-walk for bbox, not the AX tree.
- Execution: single-repo serial scheduling (no worktrees — all tracks touch
  `browser_tools*.go` / `controller*.go`, worktree merges would collide).

## Track A — Set-of-Marks visual-click suite (serial: D1 → A1 → A2)

### D1 — interactive-element enumeration with bbox

**Problem**: `browser_snapshot` returns an AX-tree text dump whose refs carry no
coordinates; clicking a ref does an on-demand `getBoxModel`. SoM needs every
clickable element's box up front, and snapshot would benefit from carrying coords.

**Design**: factor the in-page DOM walk already inside `findElementsExpression`
(`controller_find.go` — it walks the DOM, tests visibility via `visible()`, detects
interactive roles, computes `getBoundingClientRect` center + iframe offsets) into a
reusable enumeration that returns, per interactive element:

```go
// internal/browser/marks.go (new)
type MarkedElement struct {
    Index            int     // 1-based, stable within one enumeration
    X, Y, W, H       float64 // CSS-px bbox (iframe-offset-corrected)
    CenterX, CenterY float64 // click point
    Role             string  // button / link / textbox / ...
    Text             string  // trimmed accessible/visible label, <=80 chars
    Ref              string  // stableSelector, reused from findElements
}
```

New controller method `enumerateInteractive(ctx, tabID) ([]MarkedElement, error)`
that runs an in-page JS expression (extend/reuse the `findElementsExpression`
collector with no query filter → return ALL interactive elements with box+center+
index). Same-origin iframes get offset-summed coords exactly as findElements does;
cross-origin iframe elements are enumerated best-effort (skip if unreachable).

`browser_snapshot` gains an opt-in `withCoordinates bool` param (default false to
preserve current output): when true, each ref line is suffixed
`@(x,y wxh)` from the enumeration. Default-off keeps existing snapshot tests green.

**Files**: new `internal/browser/marks.go` (type + enumerateInteractive + the JS
collector string), `controller_find.go` (extract shared collector if cleanly
factorable; otherwise marks.go has its own collector to avoid destabilizing find),
`browser_tools.go` (snapshot `withCoordinates` param).

**Test**: mock CDP returns a DOM-walk JSON for 3 elements → assert 3 MarkedElements
with non-zero bbox, sequential 1-based Index, center = bbox center.

### A1 — Set-of-Marks overlay + numbered screenshot

**Problem**: greenfield. No numbered overlay exists.

**Design**: two outputs from one enumeration (D1):

1. **Live injected overlay** — reuse the `phantom-cursor.ts` injection pattern:
   `chrome.debugger Runtime.evaluate` injects a closed-shadow-root SVG layer onto a
   neutral host (debugger-scoped, no host_permissions needed, self-heals via
   MutationObserver). For each MarkedElement draw a numbered badge near its box.
   Label placement: port cua's `som/visualization.py` 8-candidate-position +
   collision-avoidance algorithm (NOT its YOLO/OCR vision stack — boxes come from
   the DOM, not detection). WCAG-contrast palette. The overlay's JS lives in a Go
   string constant in `marks.go` (mirrors `buildPhantomCursorExpression`).
2. **Numbered screenshot** — after injecting the overlay, call the existing
   `Screenshot` path so the returned image already shows the numbers; the screenshot
   metadata footer (DPR/scale from the fidelity batch) lets the model map back.

New tool `browser_mark` (read-only-ish: it injects an overlay + screenshots, no
page mutation beyond the overlay): params `tabId?`, `clear bool` (remove overlay).
Returns the MarkedElement list as text (index → role/text/center) AND a screenshot
(saved to .piercode/screenshots) with the overlay baked in. A registry of the last
enumeration per tab (`tabs.SetMarks(tabID, []MarkedElement)` / `Marks(tabID)`) so
A2's `mark` lookup resolves index → center without re-enumerating.

**Files**: `marks.go` (overlay JS builder + Mark/SetMarks on registry — or a small
`marksByTab map[int][]MarkedElement` on TabRegistry with mutex, mirroring
lastPointer), new `browser_mark` tool in `browser_tools_ext.go`, registration in
`executor.go`.

**Test**: mock CDP (Runtime.evaluate for overlay + captureScreenshot + the
enumeration) → assert tool returns N marks + a screenshot FilePath; assert
`clear:true` issues a removal Runtime.evaluate. Overlay JS string is asserted to
contain the badge-draw + shadow-root markers (mirror phantom-cursor test style).

### A2 — visual click by mark number

**Problem**: close the loop — AI reads the numbered screenshot, says "click N",
cursor goes there.

**Design**: extend `browser_click` with a `mark int` param. When `mark>0`:
resolve index → center via `tabs.Marks(tabID)` (the last enumeration from
`browser_mark`); feed that center into the EXISTING `resolvePoint` raw-x,y path →
existing approval + phantom cursor + interpolated move + hold. If marks are stale/
absent for that index, return a clear error telling the model to call
`browser_mark` first. `mark` is mutually exclusive with ref/selector/x,y
(validateClickTarget extended).

**Files**: `tool.go` (`BrowserClickRequest.Mark *int`), `browser_tools.go`
(`mark` param + plumb + validation), `controller.go` (`Click` resolves mark →
center before resolvePoint; or `resolvePoint` gains a mark branch).

**Test**: seed `tabs.SetMarks(1, [...])`, call Click with `mark:7` → assert it
dispatches a click at element 7's center (reuses dispatchClick path). Stale-mark
case → assert error.

## Track B — D2: drag start-move through moveTo + HTML5 last-pointer

**Problem** (final-review leftover): `dispatchDrag`'s opening `mouseMoved` teleports
to `from` (no interpolation, ignores last-pointer), inconsistent with click; and
`dispatchHTML5Drag`'s success path never updates last-pointer (a following click
interpolates from a stale point).

**Design**:
- In `dispatchDrag`, replace the bare opening `mouseMoved(from)` with
  `c.moveTo(ctx, tabID, from.X, from.Y, "none", 0)` so the approach to the drag
  origin is interpolated and last-pointer-aware (consistent with click). The press
  and the buttons:1 interpolated drag-moves stay as the fidelity batch built them.
- In `dispatchHTML5Drag`, on the success branch add
  `c.tabs.SetLastPointer(tabID, to)` so a subsequent move/click starts from the
  real drop point.

**Files**: `controller_ext.go` (`dispatchDrag`, `dispatchHTML5Drag`).

**Test**: drag with seeded last-pointer → assert >1 interpolated moves BEFORE the
press (the approach), not a single teleport; HTML5-drag success → assert
last-pointer == `to`.

## Track C — D3: GIF recorder enhancement

**Problem**: `RecordGIF` captures a burst at a fixed JPEG quality (q60 hardcoded at
`controller.go` RecordGIF capture params) and only emits an animated GIF. The
`frames`/`intervalMs` knobs already exist; `quality` does not, and there is no
alternative output for callers that want raw frames.

**Hard constraint (verified)**: PierCode's `go.mod` has ZERO third-party image deps —
GIF encoding is pure stdlib `image/gif`. The Go stdlib and `golang.org/x/image` have
NO animated-WebP or MP4 ENCODER (x/image/webp is decode-only). So webp/mp4 are OUT —
adding them needs a cgo/ffmpeg dependency that violates the project's
dependency-free screenshot/gif philosophy. Do NOT add them.

**Design** (zero new dependencies):
- Add `quality int` to `BrowserRecordRequest` (frame JPEG capture quality, 1–95,
  default 60). Plumb it into RecordGIF's `captureParams` (currently hardcoded
  `"quality": 60`) so the burst frames are captured at the requested quality.
- Add `format string` to `BrowserRecordRequest`: `gif` (default) | `frames`.
  - `gif` → existing `encodeGIF` path, unchanged.
  - `frames` → write the captured JPEG frames into a `.zip` via stdlib
    `archive/zip` (frame-000.jpg, frame-001.jpg, …) and return the zip FilePath.
    Pure stdlib, zero deps, gives callers raw per-frame access (useful for diffing /
    feeding individual frames to vision). New small helper `encodeFramesZip(frames
    [][]byte) ([]byte, error)` in `screenshot_gif.go`.
  - Unknown format → clear error listing the two supported values.
- The `frames`/`intervalMs` clamping (max 60 frames, min 50ms interval) stays.

**Files**: `tool.go` (`BrowserRecordRequest.Quality int`, `.Format string`),
`browser_tools.go` (`browser_record` `quality`/`format` params + plumb),
`screenshot_gif.go` (`encodeFramesZip`), `controller.go` RecordGIF (honor `quality`
in captureParams + dispatch on `format`).

**Test**: record with `quality:30` → assert capture params carry quality 30 (mock CDP
records the captureScreenshot params); `format:"frames"` → assert a `.zip` FilePath
returned containing N entries; unknown `format` → assert graceful error string.

## Cross-cutting

- All new per-tab state (`marksByTab`) is mutex-guarded on TabRegistry and purged in
  `ClearDefault` (same as lastPointer — don't repeat that leak).
- New overlay/enumeration JS strings live as Go constants beside their callers, with
  a short comment crediting the cua `som/visualization.py` algorithm (boxes from DOM,
  not vision).
- Every new tool registered in `executor.go`; read-only ones added to
  `isReadOnlyTool()` if they don't mutate (browser_mark injects an overlay — treat as
  NOT read-only since it changes page DOM, to be safe with the per-tab write lock).

## Sequencing (serial, single repo, one commit per task)

1. D1 — enumeration + bbox + snapshot withCoordinates.
2. A1 — overlay injection + numbered screenshot + browser_mark tool + marksByTab.
3. A2 — browser_click `mark` param → center → existing click path.
4. D2 — drag moveTo opening + HTML5 last-pointer.
5. D3 — record quality + format (gif always, webp/mp4 best-effort).
6. Verify — race + build + repo test; purge-on-close test for marksByTab.

D1→A1→A2 strictly serial (each consumes prior). D2/D3 independent — scheduled after
the chain in the same session (no worktrees). Each task: spec review + (for the
logic-heavy D1/A1/A2) code-quality review, then `go test ./internal/...` green.

## Out of scope (future specs)
- A4 OCR fallback (heavy deps; DOM covers the vast majority).
- CDP screencast true video recording.
- OS-level / desktop computer-use (option B — separate spec, needs platform decision).
- callback middleware / eval harness / trajectory logging (Track C from the cua survey).
