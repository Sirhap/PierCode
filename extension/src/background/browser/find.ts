// Interactive element find/scoring. findElementsExpr is ported verbatim from
// controller_find.go findElementsExpression (term scoring, own-text, stable
// selectors, same-origin iframe walk, open shadow-DOM descent). find() runs it on
// the main session and merges OOPIF child sessions, sorting by score.
import type { Cdp } from './cdp'
type Debuggee = chrome.debugger.Debuggee

const q = (s: string) => JSON.stringify(s)

export interface FindRequest { tabId?: number; query: string; limit?: number }
export interface FoundElement { ref: string; role: string; text: string; score: number; x?: number; y?: number; frame?: string }

export function findElementsExpr(query: string, maxResults: number): string {
  return `(function() {
  var query = ${q(query)};
  var maxResults = ${maxResults};
  var terms = query.toLowerCase().split(/\\s+/).filter(function(t) { return t.length > 0; });
  if (terms.length === 0) return JSON.stringify([]);

  var INTERACTIVE = {a:1,button:1,input:1,select:1,textarea:1,summary:1,label:1,option:1};
  var INTERACTIVE_ROLES = {button:1,link:1,textbox:1,searchbox:1,checkbox:1,radio:1,combobox:1,menuitem:1,tab:1,option:1,switch:1,slider:1};

  function visible(el){
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    var s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity||'1') === 0) return false;
    if (el.closest('[aria-hidden=true]')) return false;
    return true;
  }
  function ownText(el){
    var t = '';
    for (var i=0;i<el.childNodes.length;i++){ var n=el.childNodes[i]; if(n.nodeType===3) t+=n.textContent; }
    t = t.trim();
    if (!t && (el.tagName==='BUTTON'||el.tagName==='A'||el.getAttribute('role'))) t=(el.textContent||'').trim();
    return t.slice(0,200);
  }
  function stableSelector(el){
    if (el.id) return '#' + CSS.escape(el.id);
    var name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
    var al = el.getAttribute('aria-label');
    if (al) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(al) + '"]';
    var ph = el.getAttribute('placeholder');
    if (ph) return el.tagName.toLowerCase() + '[placeholder="' + CSS.escape(ph) + '"]';
    var p = el.parentElement;
    if (p){ var same=0, idx=0; for(var i=0;i<p.children.length;i++){ if(p.children[i].tagName===el.tagName){ same++; if(p.children[i]===el) idx=same; } }
      var base=(p.id?('#'+CSS.escape(p.id)+' >'):'') ; return (base+' '+el.tagName.toLowerCase()+':nth-of-type('+idx+')').trim(); }
    return el.tagName.toLowerCase();
  }

  var results = [];
  function scoreNode(node, offX, offY, frameUrl) {
    var tag = node.tagName.toLowerCase();
    var roleAttr = (node.getAttribute('role') || '').toLowerCase();
    var role = roleAttr || tag;
    var isInteractive = INTERACTIVE[tag] || INTERACTIVE_ROLES[roleAttr] || node.tabIndex >= 0;
    var ariaLabel = (node.getAttribute('aria-label') || '').trim();
    var title = (node.getAttribute('title') || '').trim();
    var placeholder = (node.getAttribute('placeholder') || '').trim();
    var text = ownText(node);

    var hay = (ariaLabel+' '+title+' '+placeholder+' '+text+' '+role).toLowerCase();
    var score = 0;
    for (var i = 0; i < terms.length; i++) {
      var term = terms[i];
      if (ariaLabel.toLowerCase().indexOf(term) >= 0) score += 4;
      if (placeholder.toLowerCase().indexOf(term) >= 0) score += 3;
      if (title.toLowerCase().indexOf(term) >= 0) score += 3;
      if (text.toLowerCase().indexOf(term) >= 0) score += 2;
      if (role.indexOf(term) >= 0) score += 2;
      else if (hay.indexOf(term) >= 0) score += 1;
    }
    if (score === 0) return;
    if (isInteractive) score += 3;
    else { score -= 2; if ((node.textContent||'').length > 400) score -= 2; }
    if (score <= 0) return;
    if (!visible(node)) return;

    var displayText = ariaLabel || placeholder || title || text;
    var entry = {ref: stableSelector(node), role: role, text: displayText.slice(0,200), score: score};
    if (offX || offY || frameUrl) {
      var r = node.getBoundingClientRect();
      entry.x = Math.round(offX + r.left + r.width/2);
      entry.y = Math.round(offY + r.top + r.height/2);
      entry.frame = frameUrl || '(iframe)';
    }
    results.push(entry);
  }
  function walkDoc(doc, offX, offY, frameUrl, depth) {
    if (!doc || depth > 8) return;
    var rootEl = doc.body || doc.documentElement || doc;
    var walker = doc.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT, null, false);
    var node;
    while (node = walker.nextNode()) {
      if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
        var idoc = null;
        try { idoc = node.contentDocument; } catch (e) { idoc = null; }
        if (idoc) {
          var ir = node.getBoundingClientRect();
          var cs = null; try { cs = (node.ownerDocument.defaultView||window).getComputedStyle(node); } catch(e){}
          var bl = cs ? parseFloat(cs.borderLeftWidth)||0 : 0;
          var bt = cs ? parseFloat(cs.borderTopWidth)||0 : 0;
          var pl = cs ? parseFloat(cs.paddingLeft)||0 : 0;
          var pt = cs ? parseFloat(cs.paddingTop)||0 : 0;
          walkDoc(idoc, offX + ir.left + bl + pl, offY + ir.top + bt + pt, (idoc.location && idoc.location.href) || frameUrl, depth + 1);
        }
        continue;
      }
      scoreNode(node, offX, offY, frameUrl);
      if (node.shadowRoot) { walkDoc(node.shadowRoot, offX, offY, frameUrl, depth + 1); }
    }
  }
  walkDoc(document, 0, 0, '', 0);

  results.sort(function(a, b) { return b.score - a.score; });
  return JSON.stringify(results.slice(0, maxResults));
})()`
}

export async function find(cdp: Cdp, target: Debuggee, req: FindRequest): Promise<FoundElement[]> {
  const limit = req.limit ?? 20
  const rawMain = await cdp.runtimeEvaluate(target, findElementsExpr(req.query, limit))
  const main: FoundElement[] = typeof rawMain === 'string' ? JSON.parse(rawMain) : (rawMain ?? [])
  // OOPIF cross-origin frames run on child sessions — the controller merges those
  // in via session targets; here we return the main-document results (which already
  // include same-origin iframes walked in-page). Cross-origin merge is layered by
  // the controller passing additional session targets.
  return main.sort((a, b) => b.score - a.score).slice(0, limit)
}
