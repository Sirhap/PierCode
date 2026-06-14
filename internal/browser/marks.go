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
    if(!doc||depth>8) return;
    // A ShadowRoot has no body/documentElement — use the root itself.
    var rootEl=doc.body||doc.documentElement||doc;
    var walker=doc.createTreeWalker(rootEl,NodeFilter.SHOW_ELEMENT,null,false);
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
      // Descend into an OPEN shadow root (web components). createTreeWalker does
      // not cross the shadow boundary, so interactive controls inside custom
      // elements are invisible without this. Closed roots read back null and are
      // unreachable by design. getBoundingClientRect inside shadow DOM is in the
      // same viewport coordinate space, so the offset is unchanged.
      if(node.shadowRoot){ walkDoc(node.shadowRoot,offX,offY,depth+1); }
    }
  }
  walkDoc(document,0,0,0);
  return JSON.stringify(out);
})()`
}
