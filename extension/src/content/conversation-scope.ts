type LocationLike = Pick<Location, 'origin' | 'pathname'>;

// Persisted across SPA reloads / tab refresh. The AI sites rewrite the URL
// after the first message (e.g. claude.ai/new -> /chat/<uuid>); without
// persistence, a refresh would forget that /new and /chat/<uuid> are the same
// conversation, so server pushes (worker callbacks, compression handoffs) tagged
// with the original /new URL would never match the now-/chat/<uuid> page.
const ALIAS_STORAGE_KEY = 'piercode_conversation_aliases';
// A synthetic, migration-stable identity for the current conversation. The URL
// is unstable across the /new -> /chat/<uuid> flip AND not yet known on the very
// first message (no stable alias exists yet), so keying exec-dedup on the URL
// lets the first tool call re-run after migration. This id is assigned once when
// a conversation begins and reused across the whole conversation, including the
// transient surface and after migration, so the dedup key is stable from the
// first message onward.
const SCOPE_ID_STORAGE_KEY = 'piercode_conversation_scope_id';
// Maps stable conversation URL -> scope id, so REVISITING a conversation in the
// same tab (A -> B -> A sidebar switches) reuses A's original scope id instead of
// minting a fresh one. Without this, every revisit rotated the scope id, all
// exec-dedup keys (`${scopeId}:${name}:${callId}`) missed, and — because the
// response-session gate stays open once activated — the old conversation's
// re-mounted tool fences were re-detected as new and re-executed under
// autoExecute. Session-scoped like the alias set: a brand-new tab is instead
// protected by the pre-init history snapshot in content/index.ts.
const SCOPE_MAP_STORAGE_KEY = 'piercode_conversation_scope_map';
const SCOPE_MAP_MAX_ENTRIES = 100;

let observedConversationURL = '';
let conversationScopeId = '';
// All URLs known to refer to the current conversation. Seeded from sessionStorage
// and grown as the SPA migrates the URL. Includes the canonical current URL plus
// any transient predecessors (e.g. /new) it migrated from.
let conversationAliasSet = new Set<string>();

function stripTrailingSlash(pathname: string): string {
  if (pathname.length > 1) return pathname.replace(/\/+$/, '') || '/';
  return pathname || '/';
}

function normalizeConversationURL(raw: string): string {
  const u = new URL(raw, typeof location !== 'undefined' ? location.href : undefined);
  return `${u.origin}${stripTrailingSlash(u.pathname)}`;
}

export function getCanonicalConversationURL(value?: string | URL | LocationLike): string {
  try {
    if (!value) return normalizeConversationURL(location.href);
    if (typeof value === 'string') return normalizeConversationURL(value);
    if (value instanceof URL) return normalizeConversationURL(value.href);
    return `${value.origin}${stripTrailingSlash(value.pathname)}`;
  } catch {
    if (typeof location !== 'undefined') return `${location.origin}${stripTrailingSlash(location.pathname)}`;
    return '';
  }
}

export function isTransientConversationURL(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '') || '/';
    // Transient "new chat" landing paths that the SPA replaces with a stable
    // conversation URL after the first message. These are per-platform but all
    // share the property of not yet identifying a specific conversation.
    return path === '/new' || path === '/' || path === '/app'
      || path === '/prompts/new_chat' || path === '/chat';
  } catch {
    return false;
  }
}

function loadAliasSet(): Set<string> {
  try {
    if (typeof sessionStorage === 'undefined') return new Set();
    const raw = sessionStorage.getItem(ALIAS_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function persistAliasSet(): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(ALIAS_STORAGE_KEY, JSON.stringify([...conversationAliasSet]));
  } catch {
    // sessionStorage may be unavailable (sandboxed iframe); aliases stay in-memory.
  }
}

function ensureAliasSetLoaded(): void {
  if (conversationAliasSet.size === 0) {
    conversationAliasSet = loadAliasSet();
  }
}

function generateScopeId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `cs_${crypto.randomUUID()}`;
    }
  } catch {
    // fall through to the non-crypto path
  }
  return `cs_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

// ensureScopeId returns the conversation's migration-stable scope id, loading a
// persisted one (survives tab refresh) or minting a new one on first use.
function ensureScopeId(): string {
  if (conversationScopeId) return conversationScopeId;
  try {
    if (typeof sessionStorage !== 'undefined') {
      const stored = sessionStorage.getItem(SCOPE_ID_STORAGE_KEY);
      if (stored) {
        conversationScopeId = stored;
        return conversationScopeId;
      }
    }
  } catch {
    // sessionStorage unavailable; keep the id in-memory only.
  }
  conversationScopeId = generateScopeId();
  persistScopeId();
  return conversationScopeId;
}

// resetScopeId mints a fresh id when a genuinely new conversation begins (a new
// transient surface, or navigation between two distinct stable conversations).
function resetScopeId(): void {
  conversationScopeId = generateScopeId();
  persistScopeId();
}

function persistScopeId(): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(SCOPE_ID_STORAGE_KEY, conversationScopeId);
  } catch {
    // ignore
  }
}

function loadScopeMap(): Record<string, string> {
  try {
    if (typeof sessionStorage === 'undefined') return {};
    const raw = sessionStorage.getItem(SCOPE_MAP_STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') map[k] = v;
    }
    return map;
  } catch {
    return {};
  }
}

// bindScopeIdToURL remembers which scope id belongs to a stable conversation
// URL so a later revisit reuses it. Insertion-ordered with a cap so a long
// session hopping across many conversations cannot grow the map unbounded.
function bindScopeIdToURL(url: string, scopeId: string): void {
  if (!url || !scopeId || isTransientConversationURL(url)) return;
  try {
    if (typeof sessionStorage === 'undefined') return;
    const map = loadScopeMap();
    if (map[url] === scopeId) return;
    delete map[url]; // re-insert at the end so eviction drops the oldest first
    map[url] = scopeId;
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length - SCOPE_MAP_MAX_ENTRIES; i++) delete map[keys[i]];
    sessionStorage.setItem(SCOPE_MAP_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // sessionStorage unavailable; revisits will mint fresh ids (pre-fix behavior).
  }
}

function scopeIdForURL(url: string): string {
  if (!url || isTransientConversationURL(url)) return '';
  return loadScopeMap()[url] || '';
}

export function observeConversationURL(value?: string | URL | LocationLike): string {
  const current = getCanonicalConversationURL(value);
  if (!current) return current;
  ensureAliasSetLoaded();

  const previous = observedConversationURL;
  if (previous !== current) {
    if (isTransientConversationURL(current) && previous) {
      // Landed on a fresh new-chat surface FROM somewhere else in this session: the
      // user deliberately started a *new* conversation. Drop the old aliases so a
      // stale /chat/<old> no longer matches, and mint a fresh scope id.
      conversationAliasSet = new Set([current]);
      resetScopeId();
    } else if (isTransientConversationURL(current)) {
      // Transient URL as the FIRST observation after a page load (`!previous`). This is
      // almost always a REFRESH FLASH — qwen/claude momentarily show '/' (or '/new')
      // before the SPA restores /c/<uuid>. Do NOT resetScopeId here: that would rotate
      // an established conversation's id, so every already-executed tool's dedup key
      // changes and they ALL re-run after a refresh (user-reported bug). Keep the
      // persisted scope id; the imminent migration to the stable URL binds it. A
      // genuine cold-start new chat keeps the freshly-minted id either way.
      conversationAliasSet.add(current);
      ensureScopeId();
    } else if (previous && isTransientConversationURL(previous)) {
      // Migration from a transient predecessor to a stable URL. Two cases share this
      // branch and MUST be told apart by the scope map:
      //  (a) genuine /new -> /chat/<uuid> first-message migration: the stable URL is
      //      brand new, has no map entry, so we keep the id minted on /new.
      //  (b) reload-flash: content reloaded, qwen flashed '/' (branch above carried the
      //      GLOBAL last-used scope id), then the SPA restored an OLDER conversation the
      //      user opened. That older conversation already has its OWN id in the scope
      //      map. We must reuse THAT, not the flash-carried global id — otherwise the old
      //      conversation's dedup keys all change and every tool re-runs on re-mount.
      // So: prefer the per-URL mapped id; fall back to the carried id only when unmapped.
      conversationAliasSet.add(previous);
      conversationAliasSet.add(current);
      const mapped = scopeIdForURL(current);
      if (mapped && mapped !== conversationScopeId) {
        conversationScopeId = mapped;
        persistScopeId();
      } else {
        ensureScopeId();
      }
      bindScopeIdToURL(current, conversationScopeId);
    } else if (!previous && conversationAliasSet.has(current)) {
      // Fresh load (e.g. tab refresh) and the persisted alias set already knows
      // this stable URL: keep the persisted aliases so a /new predecessor still
      // matches. Reuse the persisted scope id.
      conversationAliasSet.add(current);
      ensureScopeId();
      bindScopeIdToURL(current, conversationScopeId);
    } else {
      // Navigated between two distinct stable conversations (or fresh-loaded a
      // stable URL the alias set doesn't know). Reuse the scope id this URL had
      // earlier in the session — switching A -> B -> A must NOT rotate A's id,
      // or A's already-executed tool fences all miss the exec-dedup store and
      // re-run when the SPA re-mounts them. Only a URL never seen this session
      // mints a fresh id.
      conversationAliasSet = new Set([current]);
      const known = scopeIdForURL(current);
      if (known) {
        conversationScopeId = known;
        persistScopeId();
      } else {
        resetScopeId();
        bindScopeIdToURL(current, conversationScopeId);
      }
    }
    persistAliasSet();
  } else if (!conversationAliasSet.has(current)) {
    conversationAliasSet.add(current);
    persistAliasSet();
  }
  observedConversationURL = current;
  return current;
}

export function isConversationURLForCurrentPage(messageURL?: string, currentURL?: string | URL | LocationLike): boolean {
  if (!messageURL) return true;
  let current = observedConversationURL;
  if (currentURL) {
    current = observeConversationURL(currentURL);
  } else if (typeof location !== 'undefined') {
    current = observeConversationURL();
  }
  ensureAliasSetLoaded();
  const message = getCanonicalConversationURL(messageURL);
  if (!current || !message) return true;
  if (message === current) return true;
  // Both the message and the current page must be known aliases of the same
  // conversation. A transient predecessor (/new) the page migrated from counts.
  return conversationAliasSet.has(message) && conversationAliasSet.has(current);
}

// getConversationKey returns a stable identity for the current conversation that
// survives the transient->stable URL migration. Used to key per-conversation
// state (token meter context, exec dedup) so a /new -> /chat/<uuid> flip does not
// orphan the history or re-run already-executed tools. Prefers the stable
// (non-transient) alias; falls back to the current URL when none is known yet.
export function getConversationKey(currentURL?: string | URL | LocationLike): string {
  const current = observeConversationURL(currentURL);
  if (!current) return '';
  ensureAliasSetLoaded();
  // The synthetic scope id is stable across the transient->stable URL migration
  // AND from the very first message (unlike the URL, which is transient on /new
  // and not yet a stable alias on the first call). Keying exec-dedup on it means
  // a URL flip neither re-runs an executed tool nor orphans per-conversation
  // state. observeConversationURL has already assigned/loaded it above.
  return ensureScopeId();
}

export function __resetConversationScopeForTest(): void {
  observedConversationURL = '';
  conversationAliasSet = new Set();
  conversationScopeId = '';
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(ALIAS_STORAGE_KEY);
      sessionStorage.removeItem(SCOPE_ID_STORAGE_KEY);
      sessionStorage.removeItem(SCOPE_MAP_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}
