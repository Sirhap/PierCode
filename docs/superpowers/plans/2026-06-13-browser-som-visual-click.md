# Browser Set-of-Marks Visual Click + Tool Augmentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Set-of-Marks visual clicking (numbered overlay + click-by-number) plus snapshot bbox enumeration, drag-approach interpolation, and a configurable frame recorder to PierCode's browser layer.

**Architecture:** Reuse the existing in-page DOM-walk (`findElementsExpression`) for element enumeration with bounding boxes; reuse the `phantom-cursor.ts` `Runtime.evaluate` closed-shadow-root injection pattern for the numbered overlay; route visual clicks through the existing raw-x,y `Click` path (approval + phantom cursor + interpolated move + hold already built). Per-tab mark state lives on `TabRegistry` (mutex-guarded, purged on tab close). Zero new third-party dependencies.

**Tech Stack:** Go 1.24, CDP `DOM`/`Runtime`/`Page`/`Input` via `RelayManager`, the `NewRelayManagerFromSend` mock-relay test fixture, stdlib `image/gif` + `archive/zip` (no image deps in go.mod — verified).

Spec: `docs/superpowers/specs/2026-06-13-browser-som-visual-click-design.md`

---

## File Structure

- `internal/browser/marks.go` — **new**: `MarkedElement` type, `enumerateInteractive` (controller method + its in-page JS collector string), `buildMarkOverlayExpression` / `buildClearOverlayExpression` (overlay JS builders, mirroring `phantom-cursor.ts`).
- `internal/browser/registry.go` — `marksByTab map[int][]tool.MarkedElement` + `SetMarks`/`Marks`, purge in `ClearDefault`.
- `internal/browser/controller.go` — `Mark` controller method (enumerate → inject overlay → screenshot); `Click` resolves `mark` → center; `RecordGIF` honors quality + format dispatch.
- `internal/browser/screenshot_gif.go` — `encodeFramesZip`.
- `internal/tool/tool.go` — `BrowserClickRequest.Mark *int`; `BrowserRecordRequest.Quality int`/`.Format string`; `BrowserMarkRequest`.
- `internal/tool/browser_tools.go` — snapshot `withCoordinates` param; `browser_click` `mark` param + validation; `browser_record` `quality`/`format`.
- `internal/tool/browser_tools_ext.go` — `NewBrowserMarkTool`.
- `internal/executor/executor.go` — register `NewBrowserMarkTool`.
- Tests: `internal/browser/marks_test.go` (new), `internal/browser/controller_*_test.go` additions, `internal/tool/browser_tools_test.go` additions.

---

## Task 1: D1 — interactive-element enumeration with bbox

**Files:**
- Create: `internal/browser/marks.go`
- Create: `internal/browser/marks_test.go`
- Modify: `internal/tool/tool.go` (snapshot req gets `WithCoordinates bool`)
- Modify: `internal/tool/browser_tools.go` (snapshot `withCoordinates` param)
- Modify: `internal/browser/controller.go` (Snapshot appends coords when requested — only if snapshot already has a ref→box source; otherwise this sub-step is deferred, see Step 7 note)

- [ ] **Step 1: Write the failing test** — `internal/browser/marks_test.go`

```go
package browser

import (
	"context"
	"encoding/json"
	"testing"
)

func TestEnumerateInteractiveReturnsBoxes(t *testing.T) {
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		// enumerateInteractive runs one Runtime.evaluate; return 3 elements.
		data := json.RawMessage(`{"result":{"value":"[` +
			`{\"index\":1,\"x\":10,\"y\":20,\"w\":100,\"h\":30,\"cx\":60,\"cy\":35,\"role\":\"button\",\"text\":\"OK\",\"ref\":\"#ok\"},` +
			`{\"index\":2,\"x\":0,\"y\":60,\"w\":200,\"h\":24,\"cx\":100,\"cy\":72,\"role\":\"link\",\"text\":\"Home\",\"ref\":\"a[name=home]\"},` +
			`{\"index\":3,\"x\":5,\"y\":100,\"w\":150,\"h\":40,\"cx\":80,\"cy\":120,\"role\":\"textbox\",\"text\":\"\",\"ref\":\"#q\"}` +
			`]"}}`)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		return true
	})
	c := NewController(relay, func([]byte) {})
	marks, err := c.enumerateInteractive(context.Background(), 1)
	if err != nil {
		t.Fatalf("enumerate err: %v", err)
	}
	if len(marks) != 3 {
		t.Fatalf("expected 3 marks, got %d", len(marks))
	}
	for i, m := range marks {
		if m.Index != i+1 {
			t.Fatalf("index not 1-based sequential: %#v", m)
		}
		if m.W == 0 || m.H == 0 {
			t.Fatalf("mark %d missing bbox: %#v", m.Index, m)
		}
		if m.CenterX != m.X+m.W/2 || m.CenterY != m.Y+m.H/2 {
			// collector computes center; tolerate the JS-provided cx/cy which equals box center
		}
	}
	if marks[0].Role != "button" || marks[0].Ref != "#ok" {
		t.Fatalf("mark fields wrong: %#v", marks[0])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/browser/ -run TestEnumerateInteractive -v`
Expected: FAIL — `c.enumerateInteractive undefined`, `MarkedElement` undefined.

- [ ] **Step 3a: Define `MarkedElement` in the tool package** (`internal/tool/tool.go`)

It lives in `tool` (not `browser`) so the `BrowserController` interface can
reference it in Task 2 without an import cycle. Add near the other browser
request/response types:
```go
// MarkedElement is one interactive element from browser_mark / enumerateInteractive,
// with its CSS-px bounding box and click center. Indices are 1-based and stable
// within a single enumeration.
type MarkedElement struct {
	Index            int
	X, Y, W, H       float64
	CenterX, CenterY float64
	Role             string
	Text             string
	Ref              string
}
```

- [ ] **Step 3b: Create `internal/browser/marks.go` with the enumeration**

```go
package browser

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/sirhap/piercode/internal/tool"
)

// rawMark mirrors the JSON the in-page collector emits (short keys to keep the
// serialized payload small).
type rawMark struct {
	Index int     `json:"index"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	W     float64 `json:"w"`
	H     float64 `json:"h"`
	CX    float64 `json:"cx"`
	CY    float64 `json:"cy"`
	Role  string  `json:"role"`
	Text  string  `json:"text"`
	Ref   string  `json:"ref"`
}

// enumerateInteractive walks the page DOM (and same-origin iframes) and returns
// every visible interactive element with a 1-based index, bbox, and click
// center. The in-page collector reuses the visibility / stable-selector / iframe
// offset logic proven in findElementsExpression; the marking/numbering approach
// is adapted from cua's som/visualization.py (boxes come from the DOM, not a
// vision model).
func (c *Controller) enumerateInteractive(ctx context.Context, tabID int) ([]tool.MarkedElement, error) {
	out, err := c.runtimeEvaluate(ctx, tabID, markCollectorExpression(), false, defaultReadTimeout, true)
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, fmt.Errorf("enumerate returned no result")
	}
	// The collector returns a JSON string (returnByValue) — value is a quoted string.
	var jsonStr string
	if err := json.Unmarshal(out.Result.Value, &jsonStr); err != nil {
		return nil, fmt.Errorf("enumerate decode outer: %w", err)
	}
	var raws []rawMark
	if err := json.Unmarshal([]byte(jsonStr), &raws); err != nil {
		return nil, fmt.Errorf("enumerate decode marks: %w", err)
	}
	marks := make([]tool.MarkedElement, 0, len(raws))
	for _, r := range raws {
		marks = append(marks, tool.MarkedElement{
			Index: r.Index, X: r.X, Y: r.Y, W: r.W, H: r.H,
			CenterX: r.CX, CenterY: r.CY, Role: r.Role, Text: r.Text, Ref: r.Ref,
		})
	}
	return marks, nil
}

// markCollectorExpression returns the in-page JS that enumerates interactive
// elements. It mirrors findElementsExpression's visible()/stableSelector()/
// same-origin-iframe walk, but emits ALL interactive elements (no query filter)
// with a 1-based index, bbox, and center instead of a relevance score.
func markCollectorExpression() string {
	return `(function(){
  var INTERACTIVE = {a:1,button:1,input:1,select:1,textarea:1,summary:1,label:1,option:1};
  var INTERACTIVE_ROLES = {button:1,link:1,textbox:1,searchbox:1,checkbox:1,radio:1,combobox:1,menuitem:1,tab:1,option:1,switch:1,slider:1};
  function visible(el){
    var r=el.getBoundingClientRect();
    if(r.width<1||r.height<1) return false;
    var s=getComputedStyle(el);
    if(s.visibility==='hidden'||s.display==='none'||parseFloat(s.opacity||'1')===0) return false;
    if(el.closest('[aria-hidden=true]')) return false;
    return true;
  }
  function ownText(el){
    var t='';for(var i=0;i<el.childNodes.length;i++){var n=el.childNodes[i];if(n.nodeType===3)t+=n.textContent;}
    t=t.trim();
    if(!t&&(el.tagName==='BUTTON'||el.tagName==='A'||el.getAttribute('role')))t=(el.textContent||'').trim();
    return t.slice(0,80);
  }
  function stableSelector(el){
    if(el.id) return '#'+CSS.escape(el.id);
    var name=el.getAttribute('name'); if(name) return el.tagName.toLowerCase()+'[name="'+CSS.escape(name)+'"]';
    var al=el.getAttribute('aria-label'); if(al) return el.tagName.toLowerCase()+'[aria-label="'+CSS.escape(al)+'"]';
    var ph=el.getAttribute('placeholder'); if(ph) return el.tagName.toLowerCase()+'[placeholder="'+CSS.escape(ph)+'"]';
    var p=el.parentElement;
    if(p){var same=0,idx=0;for(var i=0;i<p.children.length;i++){if(p.children[i].tagName===el.tagName){same++;if(p.children[i]===el)idx=same;}}
      var base=(p.id?('#'+CSS.escape(p.id)+' >'):'');return (base+' '+el.tagName.toLowerCase()+':nth-of-type('+idx+')').trim();}
    return el.tagName.toLowerCase();
  }
  var out=[]; var idx=0;
  function consider(node,offX,offY){
    var tag=node.tagName.toLowerCase();
    var roleAttr=(node.getAttribute('role')||'').toLowerCase();
    var isInteractive=INTERACTIVE[tag]||INTERACTIVE_ROLES[roleAttr]||node.tabIndex>=0;
    if(!isInteractive) return;
    if(!visible(node)) return;
    var r=node.getBoundingClientRect();
    idx++;
    out.push({index:idx,
      x:Math.round(offX+r.left), y:Math.round(offY+r.top),
      w:Math.round(r.width), h:Math.round(r.height),
      cx:Math.round(offX+r.left+r.width/2), cy:Math.round(offY+r.top+r.height/2),
      role:roleAttr||tag, text:ownText(node), ref:stableSelector(node)});
  }
  function walkDoc(doc,offX,offY,depth){
    if(!doc||depth>4) return;
    var walker=doc.createTreeWalker(doc.body||doc.documentElement,NodeFilter.SHOW_ELEMENT,null,false);
    var node;
    while(node=walker.nextNode()){
      if(node.tagName==='IFRAME'||node.tagName==='FRAME'){
        var idoc=null; try{idoc=node.contentDocument;}catch(e){idoc=null;}
        if(idoc){var ir=node.getBoundingClientRect();
          var cs=null; try{cs=(node.ownerDocument.defaultView||window).getComputedStyle(node);}catch(e){}
          var bl=cs?parseFloat(cs.borderLeftWidth)||0:0, bt=cs?parseFloat(cs.borderTopWidth)||0:0;
          var pl=cs?parseFloat(cs.paddingLeft)||0:0, pt=cs?parseFloat(cs.paddingTop)||0:0;
          walkDoc(idoc,offX+ir.left+bl+pl,offY+ir.top+bt+pt,depth+1);}
        continue;
      }
      consider(node,offX,offY);
    }
  }
  walkDoc(document,0,0,0);
  return JSON.stringify(out);
})()`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/browser/ -run TestEnumerateInteractive -v`
Expected: PASS.

- [ ] **Step 5: Add `WithCoordinates` to snapshot request + tool param**

In `internal/tool/tool.go`, find `BrowserSnapshotRequest` (grep it) and add:
```go
	WithCoordinates bool
```
In `internal/tool/browser_tools.go`, the `browser_snapshot` tool: add to `parameters`:
```go
				"withCoordinates": "boolean (optional, default false) - append @(x,y wxh) per element",
```
and plumb `WithCoordinates: boolArg(ctx.Args, "withCoordinates")` into the request construction.

- [ ] **Step 6: Wire coords into Snapshot output (only the formatting hook)**

In `internal/browser/controller.go` `Snapshot` (grep `func (c *Controller) Snapshot`): when `req.WithCoordinates` is true, after building the normal AX text, call `c.enumerateInteractive(ctx, tab.TabID)` and append a coordinate block to the result:
```go
	if req.WithCoordinates {
		if marks, mErr := c.enumerateInteractive(ctx, tab.TabID); mErr == nil && len(marks) > 0 {
			var b strings.Builder
			b.WriteString("\n\nInteractive elements (index · role · text @ x,y wxh):\n")
			for _, m := range marks {
				b.WriteString(fmt.Sprintf("  [%d] %s %q @ %.0f,%.0f %.0fx%.0f\n", m.Index, m.Role, m.Text, m.CenterX, m.CenterY, m.W, m.H))
			}
			result += b.String()
		}
	}
```
(Adapt `result +=` to the actual variable name the Snapshot function returns; if Snapshot returns via a struct field, append to that. `strings`/`fmt` already imported.)

- [ ] **Step 7: Run full browser + tool tests**

Run: `go test ./internal/browser/... ./internal/tool/...`
Expected: PASS. Existing snapshot tests use default `withCoordinates=false` → unchanged output.

- [ ] **Step 8: Commit**

```bash
git add internal/browser/marks.go internal/browser/marks_test.go internal/tool/tool.go internal/tool/browser_tools.go internal/browser/controller.go
git commit -m "feat(browser): interactive-element enumeration with bbox (D1)

enumerateInteractive walks the DOM (same-origin iframes included) and
returns every visible interactive element with a 1-based index, CSS-px
bbox, and click center — reusing findElementsExpression's visibility /
stable-selector / iframe-offset logic. browser_snapshot gains opt-in
withCoordinates. Foundation for Set-of-Marks.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: A1 — Set-of-Marks overlay + numbered screenshot (browser_mark)

**Files:**
- Modify: `internal/browser/registry.go` (`marksByTab` + `SetMarks`/`Marks` + purge)
- Modify: `internal/browser/marks.go` (`buildMarkOverlayExpression`, `buildClearOverlayExpression`)
- Modify: `internal/browser/controller.go` (`Mark` method)
- Modify: `internal/tool/tool.go` (`BrowserMarkRequest`)
- Modify: `internal/tool/browser_tools_ext.go` (`NewBrowserMarkTool`)
- Modify: `internal/executor/executor.go` (register)
- Modify: `internal/browser/registry_test.go` (purge test), `internal/browser/marks_test.go` (overlay test)

- [ ] **Step 1: Write the failing tests**

Add to `internal/browser/registry_test.go`:
```go
func TestMarksRoundTripAndPurge(t *testing.T) {
	r := NewTabRegistry()
	r.SetMarks(3, []tool.MarkedElement{{Index: 1, CenterX: 10, CenterY: 20}})
	got, ok := r.Marks(3)
	if !ok || len(got) != 1 || got[0].CenterX != 10 {
		t.Fatalf("marks round-trip failed: %#v ok=%v", got, ok)
	}
	r.ClearDefault(3)
	if _, ok := r.Marks(3); ok {
		t.Fatal("ClearDefault should purge marks")
	}
}
```
Add to `internal/browser/marks_test.go` (add imports `"strings"` and the `tool` package `"github.com/sirhap/piercode/internal/tool"` to that file's import block):
```go
func TestMarkOverlayExpressionContainsBadges(t *testing.T) {
	expr := buildMarkOverlayExpression([]tool.MarkedElement{
		{Index: 1, X: 10, Y: 20, W: 40, H: 16, CenterX: 30, CenterY: 28},
	})
	for _, must := range []string{"attachShadow", "mode:'closed'", "__piercode_som__"} {
		if !strings.Contains(expr, must) {
			t.Fatalf("overlay expr missing %q", must)
		}
	}
	clr := buildClearOverlayExpression()
	if !strings.Contains(clr, "remove") {
		t.Fatalf("clear expr should remove the overlay host")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/browser/ -run 'Marks|MarkOverlay' -v`
Expected: FAIL — `SetMarks`/`Marks`/`buildMarkOverlayExpression`/`buildClearOverlayExpression` undefined.

- [ ] **Step 3: Add marks state to TabRegistry**

In `internal/browser/registry.go` struct add:
```go
	marksByTab map[int][]tool.MarkedElement
```
(`registry.go` already imports `internal/tool` — it uses `tool.BrowserTab`.) `NewTabRegistry` add `marksByTab: make(map[int][]tool.MarkedElement),`. Accessors:
```go
func (r *TabRegistry) SetMarks(tabID int, marks []tool.MarkedElement) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.marksByTab == nil {
		r.marksByTab = map[int][]tool.MarkedElement{}
	}
	r.marksByTab[tabID] = marks
}

func (r *TabRegistry) Marks(tabID int) ([]tool.MarkedElement, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	m, ok := r.marksByTab[tabID]
	return m, ok
}
```
In `ClearDefault` add `delete(r.marksByTab, tabID)`.

- [ ] **Step 4: Add overlay JS builders to marks.go**

```go
// buildMarkOverlayExpression returns JS that injects a closed-shadow-root SVG
// overlay drawing a numbered badge at the top-left of each mark's box. It mirrors
// the phantom-cursor.ts injection pattern (closed shadow root on a neutral host,
// self-contained, idempotent — re-injecting replaces the prior overlay). Label
// placement is a simplified port of cua som/visualization.py: badge sits just
// above-left of the box, clamped into the viewport.
func buildMarkOverlayExpression(marks []tool.MarkedElement) string {
	// Marshal to the lowercase shape the overlay JS reads (tool.MarkedElement has
	// no json tags, so map explicitly).
	type ovl struct {
		Index int     `json:"index"`
		X     float64 `json:"x"`
		Y     float64 `json:"y"`
		W     float64 `json:"w"`
		H     float64 `json:"h"`
	}
	ovls := make([]ovl, 0, len(marks))
	for _, m := range marks {
		ovls = append(ovls, ovl{Index: m.Index, X: m.X, Y: m.Y, W: m.W, H: m.H})
	}
	data, _ := json.Marshal(ovls)
	return `(function(){
  var MARKS = ` + string(data) + `;
  var HOST_ID = '__piercode_som__';
  var prev = document.getElementById(HOST_ID); if(prev) prev.remove();
  var host = document.createElement('div'); host.id = HOST_ID;
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646';
  (document.body||document.documentElement).appendChild(host);
  var root = host.attachShadow ? host.attachShadow({mode:'closed'}) : host;
  var ns='http://www.w3.org/2000/svg';
  var svg=document.createElementNS(ns,'svg');
  svg.setAttribute('width','100%'); svg.setAttribute('height','100%');
  svg.style.cssText='position:absolute;inset:0';
  for(var i=0;i<MARKS.length;i++){
    var m=MARKS[i];
    var rect=document.createElementNS(ns,'rect');
    rect.setAttribute('x',m.x); rect.setAttribute('y',m.y);
    rect.setAttribute('width',m.w); rect.setAttribute('height',m.h);
    rect.setAttribute('fill','none'); rect.setAttribute('stroke','#22d3ee');
    rect.setAttribute('stroke-width','2'); rect.setAttribute('rx','3');
    svg.appendChild(rect);
    var lx=Math.max(0,m.x-2), ly=Math.max(12,m.y-2);
    var bg=document.createElementNS(ns,'rect');
    var label=''+m.index; var bw=8+label.length*8;
    bg.setAttribute('x',lx); bg.setAttribute('y',ly-12);
    bg.setAttribute('width',bw); bg.setAttribute('height',14);
    bg.setAttribute('fill','#0e7490'); bg.setAttribute('rx','3');
    svg.appendChild(bg);
    var txt=document.createElementNS(ns,'text');
    txt.setAttribute('x',lx+4); txt.setAttribute('y',ly-1);
    txt.setAttribute('font-family','monospace'); txt.setAttribute('font-size','11');
    txt.setAttribute('font-weight','bold'); txt.setAttribute('fill','#ffffff');
    txt.textContent=label; svg.appendChild(txt);
  }
  root.appendChild(svg);
  return {ok:true,count:MARKS.length};
})()`
}

// buildClearOverlayExpression removes the SoM overlay host if present.
func buildClearOverlayExpression() string {
	return `(function(){var h=document.getElementById('__piercode_som__'); if(h){h.remove(); return {ok:true};} return {ok:false};})()`
}
```

- [ ] **Step 5: Add the `Mark` controller method (controller.go)**

```go
// Mark enumerates the tab's interactive elements, injects a numbered overlay,
// records the marks for browser_click mark= resolution, and returns a screenshot
// with the overlay baked in plus the mark list. clear=true just removes the
// overlay and returns.
func (c *Controller) Mark(ctx context.Context, req tool.BrowserMarkRequest) ([]tool.MarkedElement, tool.BrowserScreenshot, error) {
	tab, err := c.ensureTab(ctx, req.TabID)
	if err != nil {
		return nil, tool.BrowserScreenshot{}, err
	}
	if req.Clear {
		_, _ = c.runtimeEvaluate(ctx, tab.TabID, buildClearOverlayExpression(), false, defaultActionTimeout, true)
		c.tabs.SetMarks(tab.TabID, nil)
		return nil, tool.BrowserScreenshot{}, nil
	}
	marks, err := c.enumerateInteractive(ctx, tab.TabID)
	if err != nil {
		return nil, tool.BrowserScreenshot{}, err
	}
	if _, err := c.runtimeEvaluate(ctx, tab.TabID, buildMarkOverlayExpression(marks), false, defaultActionTimeout, true); err != nil {
		return nil, tool.BrowserScreenshot{}, err
	}
	c.tabs.SetMarks(tab.TabID, marks)
	shot, err := c.Screenshot(ctx, tool.BrowserScreenshotRequest{TabID: &tab.TabID, Format: req.Format, OutputDir: req.OutputDir})
	if err != nil {
		return marks, tool.BrowserScreenshot{}, err
	}
	return marks, shot, nil
}
```

- [ ] **Step 6: Add `BrowserMarkRequest` (tool.go) + tool (browser_tools_ext.go) + register (executor.go)**

`internal/tool/tool.go`:
```go
type BrowserMarkRequest struct {
	TabID     *int
	Clear     bool
	Format    string
	OutputDir string
}
```
`internal/tool/browser_tools_ext.go`:
```go
func NewBrowserMarkTool() Tool {
	return &browserTool{
		name:        "browser_mark",
		description: "Overlay numbered badges on every interactive element and return a screenshot showing the numbers. Then browser_click with mark=<n> clicks element n. Call browser_mark again to refresh after the page changes; mark={clear:true} removes the overlay.",
		parameters: map[string]string{
			"clear":  "boolean (optional) - remove the overlay instead of drawing it",
			"format": "string (optional, png|jpeg, default jpeg) - screenshot format",
			"tabId":  "number (optional) - controlled tab id",
		},
		validate: func(map[string]interface{}) error { return nil },
		execute: func(ctx *Context) (string, error) {
			marks, shot, err := ctx.Browser.Mark(ctx.Context, BrowserMarkRequest{
				TabID:     optionalInt(ctx.Args, "tabId"),
				Clear:     boolArg(ctx.Args, "clear"),
				Format:    stringArg(ctx.Args, "format"),
				OutputDir: filepath.Join(ctx.EffectiveRootDir(), ".piercode", "screenshots"),
			})
			if err != nil {
				return "", err
			}
			if len(marks) == 0 && shot.FilePath == "" {
				return "overlay cleared", nil
			}
			var b strings.Builder
			b.WriteString(fmt.Sprintf("marked %d interactive elements:\n", len(marks)))
			for _, m := range marks {
				b.WriteString(fmt.Sprintf("  [%d] %s %q @ %.0f,%.0f\n", m.Index, m.Role, m.Text, m.CenterX, m.CenterY))
			}
			if shot.FilePath != "" {
				b.WriteString("Screenshot with numbers: " + shot.FilePath + "\n")
			}
			b.WriteString("Click an element with browser_click mark=<n>.")
			return b.String(), nil
		},
	}
}
```
(`ctx.Browser.Mark` requires the `BrowserController` interface to declare the method — added in Step 7. `MarkedElement` already lives in the `tool` package (Step 3a), so no import-cycle concern.)

`internal/executor/executor.go` near the other `e.registry.Register(tool.NewBrowser...)` lines:
```go
	e.registry.Register(tool.NewBrowserMarkTool())
```

- [ ] **Step 7: Add the Mark method to the BrowserController interface**

`MarkedElement` already lives in `internal/tool/tool.go` (Task 1 Step 3a). Add the method to the `BrowserController` interface (grep `BrowserController interface` in `tool.go`):
```go
	Mark(ctx context.Context, req BrowserMarkRequest) ([]MarkedElement, BrowserScreenshot, error)
```
Everything (`marks.go`, `Mark` method, tool) already uses `tool.MarkedElement` / `MarkedElement` consistently — no type move needed.

- [ ] **Step 8: Run tests**

Run: `go test ./internal/browser/... ./internal/tool/...`
Expected: PASS. Fix any import-cycle or interface-mismatch the compiler flags per Step 7.

- [ ] **Step 9: Commit**

```bash
git add internal/browser/registry.go internal/browser/marks.go internal/browser/controller.go internal/tool/tool.go internal/tool/browser_tools_ext.go internal/executor/executor.go internal/browser/registry_test.go internal/browser/marks_test.go
git commit -m "feat(browser): Set-of-Marks overlay + numbered screenshot (A1)

browser_mark enumerates interactive elements, injects a closed-shadow-root
SVG overlay with numbered badges (phantom-cursor injection pattern; label
placement adapted from cua som/visualization.py), records marks per tab,
and returns a screenshot with the numbers baked in. Marks purged on tab
close.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: A2 — visual click by mark number

**Files:**
- Modify: `internal/tool/tool.go` (`BrowserClickRequest.Mark *int`)
- Modify: `internal/tool/browser_tools.go` (`mark` param + `validateClickTarget`)
- Modify: `internal/browser/controller.go` (`Click` resolves mark → center)
- Modify: `internal/browser/controller_click_test.go` (mark-click test)

- [ ] **Step 1: Write the failing test**

```go
func TestClickByMarkResolvesToCenter(t *testing.T) {
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
	c.SetInputFidelity(InputFidelity{MoveSteps: 1}) // keep event count simple
	c.tabs.SetDefault(tool.BrowserTab{TabID: 1, URL: "https://example.com"})
	c.tabs.SetMarks(1, []tool.MarkedElement{{Index: 7, CenterX: 250, CenterY: 140}})

	mark := 7
	_, err := c.Click(context.Background(), tool.BrowserClickRequest{Mark: &mark})
	if err != nil {
		t.Fatalf("mark click err: %v", err)
	}
	var pressed map[string]interface{}
	for _, cmd := range commands {
		var p map[string]interface{}
		_ = json.Unmarshal(cmd.Params, &p)
		if p["type"] == "mousePressed" {
			pressed = p
		}
	}
	if pressed == nil || pressed["x"] != float64(250) || pressed["y"] != float64(140) {
		t.Fatalf("expected press at mark-7 center 250,140, got %#v", pressed)
	}
}

func TestClickByMarkStaleErrors(t *testing.T) {
	c := NewController(NewRelayManagerFromSend(func([]byte) bool { return true }), func([]byte) {})
	c.tabs.SetDefault(tool.BrowserTab{TabID: 1, URL: "https://example.com"})
	mark := 99
	if _, err := c.Click(context.Background(), tool.BrowserClickRequest{Mark: &mark}); err == nil {
		t.Fatal("expected error for unknown mark index")
	}
}
```
(This test bypasses approval — confirm the test path: if `Click` calls `c.ask`, the mock approval must auto-grant. Check how existing click tests handle `ask` — grep `TestDispatchClickRightButton` calls `dispatchClick` directly to skip approval. For `Click` (the full method), grep how `controller_click_test.go` / `controller_ext_test.go` tests that call `c.Click`/`c.Type` satisfy approval — likely via an approval auto-grant or a test seam. Mirror that. If `Click` cannot be tested without approval plumbing, test the mark→center resolution at the `resolvePoint` level instead and assert the returned center.)

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/browser/ -run 'TestClickByMark' -v`
Expected: FAIL — `BrowserClickRequest.Mark` undefined.

- [ ] **Step 3: Add `Mark` to BrowserClickRequest (tool.go)**

```go
type BrowserClickRequest struct {
	TabID      *int
	Ref        string
	Selector   string
	X          *float64
	Y          *float64
	Mark       *int
	SnapshotID string
	Button     string
	ClickCount int
	CallID     string
}
```

- [ ] **Step 4: Resolve mark → x,y in Click (controller.go)**

In `Click`, BEFORE the `resolvePoint` call, if `req.Mark != nil` resolve it to x,y and set `req.X/req.Y`:
```go
	if req.Mark != nil {
		marks, ok := c.tabs.Marks(deref(req.TabID))
		if !ok {
			return "", fmt.Errorf("no marks for this tab; call browser_mark first")
		}
		var cx, cy float64
		found := false
		for _, m := range marks {
			if m.Index == *req.Mark {
				cx, cy, found = m.CenterX, m.CenterY, true
				break
			}
		}
		if !found {
			return "", fmt.Errorf("mark %d not found; call browser_mark to refresh", *req.Mark)
		}
		req.X, req.Y = &cx, &cy
	}
```
where `deref(req.TabID)` resolves the tab — but `Marks` needs the resolved tabID, and `resolvePoint`/`ensureTab` resolves it later. SIMPLER: resolve the tab first. Restructure the top of `Click` to call `ensureTab` once, then look up marks by `tab.TabID`, then proceed. Concretely, if `Click` currently starts with `resolvePoint` (which calls `ensureTab` internally), instead: when `req.Mark != nil`, call `tab, err := c.ensureTab(ctx, req.TabID)` first, look up `c.tabs.Marks(tab.TabID)`, set `req.X/Y` to the center, then continue into the existing `resolvePoint` (which will take the x,y branch). Add a tiny helper if needed; do NOT duplicate ensureTab side effects (it's idempotent — safe to call before resolvePoint).

- [ ] **Step 5: Extend validateClickTarget (browser_tools.go) + add mark param**

In `internal/tool/browser_tools.go` `validateClickTarget` (line ~504), count `mark` as a target:
```go
	hasMark := optionalInt(args, "mark") != nil
	...
	if hasMark {
		count++
	}
	...
	// keep: count != 1 → "provide exactly one target: ref, selector, x/y, or mark"
```
Update the error message to mention `mark`. In the `browser_click` tool params add:
```go
				"mark": "number (optional) - click interactive element #n from the last browser_mark",
```
and plumb `Mark: optionalInt(ctx.Args, "mark")` into `BrowserClickRequest`. (`optionalInt` returns `*int`.)

- [ ] **Step 6: Run tests**

Run: `go test ./internal/browser/... ./internal/tool/...`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/tool/tool.go internal/tool/browser_tools.go internal/browser/controller.go internal/browser/controller_click_test.go
git commit -m "feat(browser): visual click by mark number (A2)

browser_click gains mark=<n>: resolves the index to the recorded element
center from the last browser_mark and routes through the existing raw-x,y
click path (approval + phantom cursor + interpolated move + hold). Stale/
unknown mark returns a clear refresh error. mark is mutually exclusive
with ref/selector/x,y.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: D2 — drag approach via moveTo + HTML5 last-pointer

**Files:**
- Modify: `internal/browser/controller_ext.go` (`dispatchDrag`, `dispatchHTML5Drag`)
- Modify: `internal/browser/controller_ext_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestDragApproachInterpolatesFromLastPointer(t *testing.T) {
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
	c.SetInputFidelity(InputFidelity{MoveSteps: 5, DragSteps: 4, DragHoldMS: 0})
	c.sleep = func(ctx context.Context, d time.Duration) error { return nil }
	c.tabs.SetLastPointer(1, Point{X: 0, Y: 0})

	if err := c.dispatchDrag(context.Background(), 1, Point{X: 100, Y: 100}, Point{X: 200, Y: 100}); err != nil {
		t.Fatalf("drag err: %v", err)
	}
	// Approach moves (button:none) BEFORE the press should be >1 (interpolated),
	// not a single teleport to from.
	approachMoves := 0
	for _, cmd := range commands {
		var p map[string]interface{}
		_ = json.Unmarshal(cmd.Params, &p)
		if p["type"] == "mousePressed" {
			break
		}
		if p["type"] == "mouseMoved" && p["button"] == "none" {
			approachMoves++
		}
	}
	if approachMoves <= 1 {
		t.Fatalf("expected interpolated approach (>1 none-button moves), got %d", approachMoves)
	}
}

func TestHTML5DragUpdatesLastPointer(t *testing.T) {
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		// HTML5 drag runs one Runtime.evaluate returning ok:true.
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"result":{"value":"{\"ok\":true}"}}`)})
		return true
	})
	c := NewController(relay, func([]byte) {})
	if err := c.dispatchHTML5Drag(context.Background(), 1, Point{X: 10, Y: 10}, Point{X: 90, Y: 90}); err != nil {
		t.Fatalf("html5 drag err: %v", err)
	}
	p, ok := c.tabs.LastPointer(1)
	if !ok || p.X != 90 || p.Y != 90 {
		t.Fatalf("expected last-pointer at drop 90,90, got %#v ok=%v", p, ok)
	}
}
```
(Verify the HTML5 drag success-detection: earlier code checks `strings.Contains(out.Result.Value, "\"ok\":false")` to fall back. The mock returns ok:true → no fallback → success path. Confirm `dispatchHTML5Drag`'s result parsing matches the mock shape; adjust the mock's Data to whatever `runtimeEvaluate` + that function actually inspect.)

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/browser/ -run 'TestDragApproach|TestHTML5Drag' -v`
Expected: FAIL — approach is a single teleport; HTML5 drag doesn't set last-pointer.

- [ ] **Step 3: Change dispatchDrag opening move (controller_ext.go)**

Replace the opening `send(map[string]interface{}{"type": "mouseMoved", "x": from.X, "y": from.Y, "button": "none"})` in `dispatchDrag` with a moveTo to the origin:
```go
	if err := c.moveTo(ctx, tabID, from.X, from.Y, "none", 0); err != nil {
		return err
	}
```
(Keep everything after — press, DragHoldMS sleep, DragSteps interpolated buttons:1 moves, release, SetLastPointer(to) — unchanged. moveTo already updates last-pointer to `from`, then SetLastPointer(to) at the end overrides to the drop.)

- [ ] **Step 4: HTML5 drag success updates last-pointer (controller_ext.go)**

In `dispatchHTML5Drag`, on the SUCCESS branch (where it does NOT fall back to dispatchDrag — i.e. when the page accepted the HTML5 drag), add before returning nil:
```go
	c.tabs.SetLastPointer(tabID, to)
```
(The fallback path already calls `dispatchDrag` which sets it; only the native-HTML5-success path is missing it.)

- [ ] **Step 5: Run tests**

Run: `go test ./internal/browser/... -run 'Drag'`
Expected: PASS, including the existing `TestDispatchDragHoldsAndInterpolates` and `TestDispatchDragUsesMinimalMouseSequence` (the latter sets MoveSteps via its own fidelity; if the moveTo approach adds moves, that test set `DragSteps:1,DragHoldMS:0` but NOT MoveSteps — the approach moveTo now uses default MoveSteps=5, changing its command count. Update `TestDispatchDragUsesMinimalMouseSequence` to also set `MoveSteps:1` so the approach is a single move and its count math holds; recompute expected count = 1 approach + press + 1 drag-step + release = 4, which already matches — verify and adjust if the moveTo adds one).

- [ ] **Step 6: Run full package**

Run: `go test ./internal/browser/...`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/browser/controller_ext.go internal/browser/controller_ext_test.go
git commit -m "fix(browser): drag approaches origin via moveTo + HTML5 drag updates last-pointer (D2)

dispatchDrag's opening move now interpolates from the tracked last-pointer
to the drag origin (consistent with click), and the native HTML5-drag
success path records the drop point so a following click no longer
interpolates from a stale position. Final-review followups.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: D3 — recorder quality + frames-zip output

**Files:**
- Modify: `internal/tool/tool.go` (`BrowserRecordRequest.Quality int`, `.Format string`)
- Modify: `internal/tool/browser_tools.go` (`browser_record` `quality`/`format` params)
- Modify: `internal/browser/screenshot_gif.go` (`encodeFramesZip`)
- Modify: `internal/browser/controller.go` (`RecordGIF` honors quality + format dispatch)
- Modify: `internal/browser/screenshot_gif_test.go` (zip + quality tests)

- [ ] **Step 1: Write the failing test** (add to `internal/browser/screenshot_gif_test.go`)

```go
func TestEncodeFramesZipContainsFrames(t *testing.T) {
	// Two tiny valid JPEGs.
	f := jpegBytes(2, 2) // helper below
	zipped, err := encodeFramesZip([][]byte{f, f, f})
	if err != nil {
		t.Fatalf("zip err: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(zipped), int64(len(zipped)))
	if err != nil {
		t.Fatalf("read zip: %v", err)
	}
	if len(zr.File) != 3 {
		t.Fatalf("expected 3 frames in zip, got %d", len(zr.File))
	}
}
```
Add a helper in the test file if not present:
```go
func jpegBytes(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	return buf.Bytes()
}
```
(Add imports `archive/zip`, `bytes`, `image`, `image/jpeg` to the test file as needed.)

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/browser/ -run TestEncodeFramesZip -v`
Expected: FAIL — `encodeFramesZip` undefined.

- [ ] **Step 3: Add encodeFramesZip (screenshot_gif.go)**

```go
// encodeFramesZip packs raw captured frame bytes (jpeg) into a zip archive as
// frame-000.jpg, frame-001.jpg, … — a dependency-free way to return every
// captured frame for diffing or per-frame vision. Returns nil if no frames.
func encodeFramesZip(frames [][]byte) ([]byte, error) {
	if len(frames) == 0 {
		return nil, nil
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i, f := range frames {
		w, err := zw.Create(fmt.Sprintf("frame-%03d.jpg", i))
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(f); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
```
Add `"archive/zip"` and `"fmt"` to `screenshot_gif.go` imports (it already imports `bytes`).

- [ ] **Step 4: Add Quality + Format to BrowserRecordRequest (tool.go)**

```go
type BrowserRecordRequest struct {
	TabID      *int
	Frames     int
	IntervalMS int
	Quality    int    // frame JPEG quality 1-95, default 60
	Format     string // "gif" (default) | "frames"
	OutputDir  string
}
```

- [ ] **Step 5: RecordGIF honors quality + format dispatch (controller.go)**

In `RecordGIF`, replace the hardcoded capture quality:
```go
	quality := req.Quality
	if quality <= 0 || quality > 95 {
		quality = 60
	}
	captureParams, _ := json.Marshal(map[string]interface{}{"format": "jpeg", "quality": quality})
```
After the frame-capture loop, dispatch on format. Replace the `gifBytes, err := encodeGIF(...)` + file-write block with:
```go
	format := strings.ToLower(strings.TrimSpace(req.Format))
	if format == "" {
		format = "gif"
	}
	outputDir := filepath.Clean(strings.TrimSpace(req.OutputDir))
	if outputDir == "" {
		return tool.BrowserScreenshot{}, fmt.Errorf("recording output directory is required")
	}
	if mkErr := os.MkdirAll(outputDir, 0o755); mkErr != nil {
		return tool.BrowserScreenshot{}, fmt.Errorf("failed to create recording dir: %w", mkErr)
	}
	var data []byte
	var pattern string
	switch format {
	case "gif":
		g, gerr := encodeGIF(shots, intervalMS/10)
		if gerr != nil {
			return tool.BrowserScreenshot{}, fmt.Errorf("failed to encode gif: %w", gerr)
		}
		if g == nil {
			return tool.BrowserScreenshot{}, fmt.Errorf("no frames captured")
		}
		data, pattern = g, "recording-*.gif"
	case "frames":
		z, zerr := encodeFramesZip(shots)
		if zerr != nil {
			return tool.BrowserScreenshot{}, fmt.Errorf("failed to zip frames: %w", zerr)
		}
		if z == nil {
			return tool.BrowserScreenshot{}, fmt.Errorf("no frames captured")
		}
		data, pattern = z, "recording-*.zip"
	default:
		return tool.BrowserScreenshot{}, fmt.Errorf("unsupported format %q; use gif or frames", format)
	}
	tmpFile, mkErr := os.CreateTemp(outputDir, pattern)
	if mkErr != nil {
		return tool.BrowserScreenshot{}, fmt.Errorf("failed to create recording file: %w", mkErr)
	}
	defer tmpFile.Close()
	if _, mkErr = tmpFile.Write(data); mkErr != nil {
		return tool.BrowserScreenshot{}, fmt.Errorf("failed to write recording: %w", mkErr)
	}
	return tool.BrowserScreenshot{Tab: tab, Format: format, Bytes: len(data), FilePath: tmpFile.Name()}, nil
```
(Remove the now-replaced original gif-encode-and-write tail. `strings` already imported.)

- [ ] **Step 6: Add quality/format params to browser_record tool (browser_tools.go)**

In `NewBrowserRecordTool` parameters add:
```go
				"quality": "number (optional, 1-95, default 60) - frame JPEG quality",
				"format":  "string (optional, gif|frames, default gif) - gif animation or a zip of per-frame jpgs",
```
and plumb into the request:
```go
					Quality:    intArgDefault(ctx.Args, "quality", 0),
					Format:     stringArg(ctx.Args, "format"),
```

- [ ] **Step 7: Run tests**

Run: `go test ./internal/browser/... ./internal/tool/...`
Expected: PASS. Existing GIF recording test (if any) uses default format=gif → unchanged.

- [ ] **Step 8: Commit**

```bash
git add internal/tool/tool.go internal/tool/browser_tools.go internal/browser/screenshot_gif.go internal/browser/controller.go internal/browser/screenshot_gif_test.go
git commit -m "feat(browser): configurable record quality + frames-zip output (D3)

browser_record gains quality (frame JPEG quality, was hardcoded 60) and
format=gif|frames; 'frames' returns a zip of per-frame jpgs for diffing /
per-frame vision. Zero new deps (stdlib archive/zip) — webp/mp4 ruled out
as they'd need cgo/ffmpeg against the project's dependency-free philosophy.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full verification

- [ ] **Step 1: Race detector**

Run: `go test -race ./internal/browser/... ./internal/tool/... ./internal/executor/...`
Expected: PASS, no data races (new `marksByTab` is mutex-guarded).

- [ ] **Step 2: Build**

Run: `go build ./...`
Expected: exit 0.

- [ ] **Step 3: Whole repo**

Run: `go test ./...`
Expected: PASS.

- [ ] **Step 4: Tool metadata sanity**

Run: `go test ./internal/tool/ -run Metadata -v`
Expected: PASS — `browser_mark` registered and has a description (the metadata test enumerates tools; if it has an explicit tool list, add `NewBrowserMarkTool()` to it).

- [ ] **Step 5: Commit any cleanup**

```bash
git add -A -- internal/ && git commit -m "test(browser): verification for SoM visual-click batch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || echo "nothing to commit"
```
(NOTE: `git add -A -- internal/` scopes to internal/ only, NEVER the 8 pre-existing extension/ working-tree changes. Do not `git add -A` at repo root.)

---

## Notes for the implementer

- **Commit discipline**: the working tree has 8 pre-existing unrelated `extension/src/...` changes from before this session. NEVER `git add -A` at repo root or `git add .`. Only `git add` the exact files each task lists.
- Mock-relay fixture: `NewRelayManagerFromSend(func([]byte) bool)`; deliver results from a goroutine via `relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: ...})`. JSON numbers unmarshal to `float64`.
- `runtimeEvaluate(ctx, tabID, expr, awaitPromise bool, timeout, returnByValue bool)` returns `*runtimeEvalResult` whose `.Result.Value` is `json.RawMessage`. For a JS function returning a JSON STRING (our collectors use `JSON.stringify`), `.Result.Value` is a quoted string → unmarshal to a Go `string` first, then unmarshal that string to your slice (see enumerateInteractive).
- **Type location (critical, Task 2 Step 7)**: `MarkedElement` lives in `internal/tool/tool.go` so the `BrowserController` interface can reference it without an import cycle; `internal/browser/marks.go` uses `tool.MarkedElement`. If Task 1 defined it in the browser package, move it in Task 2 and update Task 1's files.
- `optionalInt(args, key)` returns `*int`; `optionalFloat` returns `*float64`; `boolArg`/`stringArg`/`intArgDefault` exist — copy usage from neighboring tools.
- Approval in `Click`/`Mark` tests: check how existing `c.Click`/`c.Type` tests satisfy the approval gate (grep `controller_click_test.go` for how `TestBrowserTypeVerifiesTextLanded` handles `ask`); mirror it. If untestable at the `Click` level, drop to testing mark→center resolution directly.
- Serial execution, single repo, no worktrees. Each task green before the next. D1→A1→A2 strictly ordered (A1 needs D1's enumeration, A2 needs A1's marks). D2/D3 independent, run after.
- After all tasks: the next-phase items (OS-level computer-use, CDP screencast, OCR, cua callback/eval/trajectory) get their own specs — do NOT start them here.
