import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  __resetConversationScopeForTest,
  getCanonicalConversationURL,
  getConversationKey,
  isConversationURLForCurrentPage,
  observeConversationURL,
} from '../content/conversation-scope';

// The conversation-scope module persists migration aliases to sessionStorage.
// This test file runs in the node environment (no DOM), so provide a minimal
// in-memory sessionStorage shim. Keeping node env is important: it means
// isConversationURLForCurrentPage() with no explicit URL does NOT re-observe a
// real `location` (which jsdom would set to about:blank and pollute the alias
// set) — matching how each test drives the URL explicitly.
beforeAll(() => {
  if (typeof (globalThis as any).sessionStorage === 'undefined') {
    const store = new Map<string, string>();
    (globalThis as any).sessionStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
    };
  }
});

describe('conversation-scope', () => {
  afterEach(() => __resetConversationScopeForTest());

  it('canonicalizes conversation URLs by stripping query, hash, and trailing slash', () => {
    expect(getCanonicalConversationURL('https://claude.ai/chat/abc/?model=sonnet#bottom')).toBe('https://claude.ai/chat/abc');
  });

  it('allows the latest transient new-chat URL to migrate to the stable conversation URL', () => {
    observeConversationURL('https://claude.ai/new');
    observeConversationURL('https://claude.ai/chat/cea2fb98-22bf-420d-8d7b-d17bb3d8c7eb');

    expect(isConversationURLForCurrentPage('https://claude.ai/new')).toBe(true);
  });

  it('does not keep old /new aliases after navigating to a fresh new chat', () => {
    observeConversationURL('https://claude.ai/new');
    observeConversationURL('https://claude.ai/chat/old');
    observeConversationURL('https://claude.ai/new');

    expect(isConversationURLForCurrentPage('https://claude.ai/chat/old')).toBe(false);
  });

  it('rejects messages scoped to a different stable conversation', () => {
    observeConversationURL('https://chat.qwen.ai/c/current');

    expect(isConversationURLForCurrentPage('https://chat.qwen.ai/c/other')).toBe(false);
  });

  it('persists the migration alias across a simulated reload (sessionStorage)', () => {
    observeConversationURL('https://claude.ai/new');
    observeConversationURL('https://claude.ai/chat/uuid-1');

    // Simulate a page refresh: module state is reset but sessionStorage persists.
    __resetForReload();
    // On reload the page is already on the stable URL.
    observeConversationURL('https://claude.ai/chat/uuid-1');

    // A server push tagged with the original /new must still resolve to this page.
    expect(isConversationURLForCurrentPage('https://claude.ai/new')).toBe(true);
  });

  it('getConversationKey is stable across a /new -> /chat migration (first message onward)', () => {
    // The key is now a synthetic scope id, not the URL, precisely so the first
    // tool call (keyed while still on /new) is NOT re-executed after the URL
    // migrates to /chat/<uuid>. The exact value is opaque; what matters is that
    // it does not change across the transient->stable flip.
    const onNew = getConversationKey('https://claude.ai/new');
    expect(onNew).toBeTruthy();
    const afterMigration = getConversationKey('https://claude.ai/chat/uuid-2');
    expect(afterMigration).toBe(onNew);
    // And it stays stable on subsequent observations of the same conversation.
    expect(getConversationKey('https://claude.ai/chat/uuid-2')).toBe(onNew);
  });

  it('reuses the original scope id when switching back to a visited conversation (A->B->A)', () => {
    const a1 = getConversationKey('https://chat.qwen.ai/c/aaa');
    const b = getConversationKey('https://chat.qwen.ai/c/bbb');
    expect(b).not.toBe(a1);
    // Switching back to A must reuse A's id — a rotated id would miss every
    // exec-dedup entry and re-run A's already-executed tools on re-mount.
    const a2 = getConversationKey('https://chat.qwen.ai/c/aaa');
    expect(a2).toBe(a1);
    // And B's identity also survives another hop.
    expect(getConversationKey('https://chat.qwen.ai/c/bbb')).toBe(b);
  });

  it('reuses a conversation scope id on reload even when aliases were reset by visiting another conversation', () => {
    const a1 = getConversationKey('https://claude.ai/chat/conv-a');
    getConversationKey('https://claude.ai/chat/conv-b');

    // Reload back on A: module state gone, sessionStorage (incl. scope map) kept.
    __resetForReload();
    const a2 = getConversationKey('https://claude.ai/chat/conv-a');
    expect(a2).toBe(a1);
  });

  // Same as above but a TRUE reload (full sessionStorage incl. scope_id slot, which
  // holds conv-b's id after visiting it). Opening conv-a DIRECTLY (no transient flash)
  // must still resolve to conv-a's id via the scope map, not the global slot's conv-b id.
  it('direct-opens an older conversation after a full reload with its own id', () => {
    const a1 = getConversationKey('https://claude.ai/chat/conv-a');
    const b1 = getConversationKey('https://claude.ai/chat/conv-b');
    expect(b1).not.toBe(a1);
    __resetForRealRefresh();
    const a2 = getConversationKey('https://claude.ai/chat/conv-a');
    expect(a2).toBe(a1);
  });

  it('keeps the migration-bound stable URL mapped to the transient-born scope id across revisits', () => {
    const born = getConversationKey('https://claude.ai/new');
    getConversationKey('https://claude.ai/chat/uuid-m'); // migration binds uuid-m -> born id
    getConversationKey('https://claude.ai/chat/other');  // navigate away
    expect(getConversationKey('https://claude.ai/chat/uuid-m')).toBe(born);
  });

  it('getConversationKey returns a fresh stable key for a distinct conversation', () => {
    const a = getConversationKey('https://chat.qwen.ai/c/abc');
    expect(a).toBeTruthy();
    // Navigating to a different stable conversation yields a different key.
    const b = getConversationKey('https://chat.qwen.ai/c/xyz');
    expect(b).toBeTruthy();
    expect(b).not.toBe(a);
    // ...and re-observing the same conversation returns its stable key.
    expect(getConversationKey('https://chat.qwen.ai/c/xyz')).toBe(b);
  });

  // Reproduce the user-reported "refresh re-runs every tool" bug: a REAL browser
  // refresh preserves ALL of sessionStorage (scope_id included), unlike the lighter
  // __resetForReload above which drops scope_id and falls back to the scope MAP. If
  // the scope id is not stable across a full-sessionStorage reload, the exec-dedup key
  // (${scopeId}:${name}:${callId}) changes and every already-run tool re-executes.
  it('keeps the scope id stable across a FULL-sessionStorage reload (real refresh)', () => {
    const before = getConversationKey('https://chat.qwen.ai/c/deep-convo');
    __resetForRealRefresh();
    const after = getConversationKey('https://chat.qwen.ai/c/deep-convo');
    expect(after).toBe(before);
  });

  // Same, but the user visited another conversation earlier in the session, so the
  // global scope_id slot holds the OTHER conversation's id at refresh time.
  it('keeps the scope id stable on real refresh even if another convo was last viewed', () => {
    const a = getConversationKey('https://chat.qwen.ai/c/aaa');
    getConversationKey('https://chat.qwen.ai/c/bbb'); // global scope_id slot now = bbb's id
    // User navigates back to A and refreshes there (full sessionStorage kept).
    getConversationKey('https://chat.qwen.ai/c/aaa');
    __resetForRealRefresh();
    const a2 = getConversationKey('https://chat.qwen.ai/c/aaa');
    expect(a2).toBe(a);
  });

  // The exact lifecycle of a first tool call: executed while still on the transient
  // /new surface (key minted there), then the SPA migrates to /c/<uuid>, then the user
  // hits F5 — landing directly on /c/<uuid> with full sessionStorage. The dedup key
  // must equal the one used at execution time on /new, or the first tool re-runs.
  it('keeps the /new-era scope id after migration AND a real refresh on the stable URL', () => {
    const atExec = getConversationKey('https://chat.qwen.ai/');          // transient new-chat
    getConversationKey('https://chat.qwen.ai/c/migrated-uuid');           // SPA migration
    __resetForRealRefresh();                                              // F5
    const afterRefresh = getConversationKey('https://chat.qwen.ai/c/migrated-uuid');
    expect(afterRefresh).toBe(atExec);
  });

  // THE user-reported bug: a deep, established conversation gets a stable id. On F5,
  // qwen's SPA momentarily shows the transient landing URL ('/') BEFORE routing back to
  // /c/<uuid>. If a scan fires during that transient window, observeConversationURL sees
  // a transient URL and resetScopeId() mints a NEW id — so the dedup key for every
  // already-executed tool changes and they ALL re-run. The id must survive a
  // refresh that transits through the transient surface.
  it('keeps the stable scope id when a real refresh transits through the transient URL', () => {
    // Establish a deep conversation (NOT born from /new in this load — just opened it).
    const established = getConversationKey('https://chat.qwen.ai/c/deep');
    __resetForRealRefresh();
    // F5: qwen briefly shows '/' before the SPA restores /c/deep.
    getConversationKey('https://chat.qwen.ai/');                 // transient flash
    const afterRefresh = getConversationKey('https://chat.qwen.ai/c/deep');
    expect(afterRefresh).toBe(established);                       // must NOT have rotated
  });

  // THE second user-reported variant: reload the EXTENSION, then OPEN AN OLDER
  // conversation from the list. After reload, content cold-loads; qwen flashes '/'
  // (which carries the GLOBAL last-used scope id = the LAST conversation's id), then the
  // SPA restores the older conversation B. B has its own id in the scope map. The flash
  // must NOT overwrite B's id with the last conversation's id, or all of B's tools re-run.
  it('opening an OLDER conversation after extension reload keeps THAT conversation id', () => {
    const idA = getConversationKey('https://chat.qwen.ai/c/aaa');   // conversation A
    const idB = getConversationKey('https://chat.qwen.ai/c/bbb');   // conversation B (last viewed)
    expect(idB).not.toBe(idA);
    // Extension reload: in-memory cleared, ALL sessionStorage kept (scope_id slot = idB).
    __resetForRealRefresh();
    // User opens the OLDER conversation A from the list; qwen flashes '/' first.
    getConversationKey('https://chat.qwen.ai/');                   // flash carries idB
    const reopenedA = getConversationKey('https://chat.qwen.ai/c/aaa');
    expect(reopenedA).toBe(idA);                                   // must be A's id, not idB
  });
});

// __resetForRealRefresh emulates a TRUE browser refresh: in-memory module state is
// cleared but the ENTIRE sessionStorage (aliases + scope map + scope id) is preserved,
// exactly as Chrome keeps it across F5.
function __resetForRealRefresh(): void {
  const saved: Record<string, string> = {};
  for (const k of ['piercode_conversation_aliases', 'piercode_conversation_scope_map', 'piercode_conversation_scope_id']) {
    const v = sessionStorage.getItem(k);
    if (v !== null) saved[k] = v;
  }
  __resetConversationScopeForTest();
  for (const [k, v] of Object.entries(saved)) sessionStorage.setItem(k, v);
}

// __resetForReload clears only the in-memory module state, leaving sessionStorage
// intact — emulating a tab refresh where the alias set must survive.
function __resetForReload(): void {
  // observeConversationURL re-seeds conversationAliasSet from sessionStorage on
  // next call, so just clearing the observed URL is enough to simulate reload.
  // We piggyback on the public reset by snapshotting/restoring sessionStorage.
  const savedAliases = sessionStorage.getItem('piercode_conversation_aliases');
  const savedScopeMap = sessionStorage.getItem('piercode_conversation_scope_map');
  __resetConversationScopeForTest();
  if (savedAliases !== null) sessionStorage.setItem('piercode_conversation_aliases', savedAliases);
  if (savedScopeMap !== null) sessionStorage.setItem('piercode_conversation_scope_map', savedScopeMap);
}
