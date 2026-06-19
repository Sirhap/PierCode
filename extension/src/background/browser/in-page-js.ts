// In-page JS expression builders, ported verbatim from the Go embedded strings in
// controller_ext.go / controller_state.go / controller_find.go. These run via
// Runtime.evaluate; keeping them as builder functions mirrors the Go jsString()
// substitution. The 100 KiB output cap is applied controller-side, not here.

const q = (s: string) => JSON.stringify(s)

/** Port of controller_ext.go getContentExpression(format, selector). */
export function getContentExpr(format: 'text' | 'html' | 'structured', selector?: string): string {
  const target = selector && selector.trim() ? `document.querySelector(${q(selector)})` : 'document.body'
  if (format === 'html') {
    return `(function(){ var el = ${target}; if (!el) throw new Error('Element not found'); return el.outerHTML || ''; })()`
  }
  if (format === 'structured') {
    return `(function(){
  var root = ${target};
  if (!root) throw new Error('Element not found');
  var items = [];
  root.querySelectorAll('h1,h2,h3,button,a,input,textarea,select,[role]').forEach(function(el) {
    items.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      text: (el.innerText || el.value || el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 500),
      href: el.href || '',
      type: el.type || ''
    });
  });
  return JSON.stringify(items);
})()`
  }
  return `(function(){ var el = ${target}; if (!el) throw new Error('Element not found'); return el.innerText || el.textContent || ''; })()`
}

/** Port of controller_ext.go pageTextExpression() — readability extraction. */
export function pageTextExpr(): string {
  return `(function(){
  function clean(s){ return (s||'').replace(/[ \\t\\f\\v]+/g,' ').replace(/\\n{3,}/g,'\\n\\n').trim(); }
  function textLen(el){ return (el && el.innerText ? el.innerText.length : 0); }
  var root = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role=main]');
  if(!root){
    var best=null, bestLen=0;
    var cands=document.querySelectorAll('article, main, section, div');
    for(var i=0;i<cands.length && i<2000;i++){
      var el=cands[i];
      var id=((el.id||'')+' '+(el.className||'')).toLowerCase();
      if(/nav|header|footer|sidebar|menu|comment|promo|banner|cookie/.test(id)) continue;
      var l=textLen(el);
      if(l>bestLen){ bestLen=l; best=el; }
    }
    root = best || document.body;
  }
  var clone = root.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,button,svg,[aria-hidden=true]').forEach(function(n){ n.remove(); });
  return clean(clone.innerText || clone.textContent || '');
})()`
}

/** Port of controller_state.go storageExpression — get/set/remove/clear/keys. */
export function storageExpr(area: 'local' | 'session', op: string, key?: string, value?: string): string {
  const store = area === 'session' ? 'sessionStorage' : 'localStorage'
  switch (op) {
    case 'get': return `(function(){ return ${store}.getItem(${q(key ?? '')}); })()`
    case 'set': return `(function(){ ${store}.setItem(${q(key ?? '')}, ${q(value ?? '')}); return 'ok'; })()`
    case 'remove': return `(function(){ ${store}.removeItem(${q(key ?? '')}); return 'ok'; })()`
    case 'clear': return `(function(){ ${store}.clear(); return 'ok'; })()`
    case 'keys': return `(function(){ return JSON.stringify(Object.keys(${store})); })()`
    default: return `(function(){ throw new Error('bad storage op: ' + ${q(op)}); })()`
  }
}

/** Port of controller_state.go GetAttributes expression — attrs + computed styles. */
export function getAttributesExpr(selector: string): string {
  return `(function(){
  var el = document.querySelector(${q(selector)});
  if (!el) return null;
  var attrs = {};
  for (var i=0;i<el.attributes.length;i++){ var a=el.attributes[i]; attrs[a.name]=a.value; }
  var cs = getComputedStyle(el);
  return JSON.stringify({
    tag: el.tagName.toLowerCase(),
    attributes: attrs,
    styles: { display: cs.display, visibility: cs.visibility, color: cs.color,
      backgroundColor: cs.backgroundColor, fontSize: cs.fontSize }
  });
})()`
}

/** Selector-present check for browser_wait. */
export function waitSelectorExpr(selector: string): string {
  return `(function(){ return !!document.querySelector(${q(selector)}); })()`
}

/** Load-state check for browser_wait (port waitLoadStateExpression). */
export function waitLoadStateExpr(state: 'load' | 'domcontentloaded' | 'networkidle'): string {
  if (state === 'domcontentloaded') return `(function(){ return document.readyState !== 'loading'; })()`
  return `(function(){ return document.readyState === 'complete'; })()`
}

/** Truthy-expression check for browser_wait_for_function. */
export function waitForFunctionExpr(expr: string): string {
  return `(function(){ try { return !!(${expr}); } catch (e) { return false; } })()`
}

/** Port of controller_find.go FormInput setter — native value setter (React/Vue safe). */
export function formInputExpr(selector: string, kind: 'text' | 'checkbox' | 'radio' | 'contenteditable', value: string): string {
  return `(function(){
  var el = document.querySelector(${q(selector)}); if (!el) return 'not found';
  var kind = ${q(kind)}; var value = ${q(value)};
  if (kind === 'checkbox' || kind === 'radio') {
    el.checked = (value === 'true' || value === '1');
    el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok';
  }
  if (kind === 'contenteditable') {
    el.textContent = value; el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';
  }
  var proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  var nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  nativeInputValueSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`
}

/** Port of controller_ext.go Select setter (by value/label/index). */
export function selectExpr(selector: string, by: 'value' | 'label' | 'index', target: string): string {
  return `(function(){
  var el = document.querySelector(${q(selector)}); if (!el) return 'not found';
  var by = ${q(by)}; var t = ${q(target)};
  var opts = Array.prototype.slice.call(el.options);
  var opt = by === 'index' ? opts[parseInt(t, 10)]
    : by === 'label' ? opts.filter(function(o){ return o.text.trim() === t; })[0]
    : opts.filter(function(o){ return o.value === t; })[0];
  if (!opt) return 'option not found';
  el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok';
})()`
}

export function clipboardReadExpr(): string { return `(async function(){ return await navigator.clipboard.readText(); })()` }
export function clipboardWriteExpr(text: string): string {
  return `(async function(){ await navigator.clipboard.writeText(${q(text)}); return 'ok'; })()`
}

/** Upload via in-page DataTransfer (replaces filesystem upload; bytes as base64). */
export function uploadDataTransferExpr(selector: string, fileName: string, base64: string, mime: string): string {
  return `(function(){
  var el = document.querySelector(${q(selector)}); if (!el) return 'not found';
  var bin = atob(${q(base64)}); var arr = new Uint8Array(bin.length);
  for (var i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  var file = new File([arr], ${q(fileName)}, { type: ${q(mime)} });
  var dt = new DataTransfer(); dt.items.add(file);
  el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok';
})()`
}
