// Set-of-Marks (SoM) — faithful port of internal/browser/marks.go.
// markCollectorExpr enumerates ALL interactive elements (no query) with a 1-based
// index + bbox + center; the overlay builders inject/clear a closed-shadow-root SVG.
// The collector/overlay JS transfer verbatim from the Go embedded strings.

export interface MarkedElement {
  index: number
  x: number; y: number; w: number; h: number
  cx: number; cy: number
  role: string; text: string; ref: string
}

export function markCollectorExpr(): string {
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
      if(node.shadowRoot){ walkDoc(node.shadowRoot,offX,offY,depth+1); }
    }
  }
  walkDoc(document,0,0,0);
  return JSON.stringify(out);
})()`
}

export function buildMarkOverlayExpr(marks: MarkedElement[]): string {
  const data = JSON.stringify(marks.map(m => ({ index: m.index, x: m.x, y: m.y, w: m.w, h: m.h })))
  return `(function(){
  var MARKS = ${data};
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

export function buildClearOverlayExpr(): string {
  return `(function(){var h=document.getElementById('__piercode_som__'); if(h){h.remove(); return {ok:true};} return {ok:false};})()`
}

/** Parse the collector's JSON-string result into MarkedElement[]. */
export function parseMarks(raw: unknown): MarkedElement[] {
  if (typeof raw === 'string') return JSON.parse(raw) as MarkedElement[]
  return (raw as MarkedElement[]) ?? []
}
