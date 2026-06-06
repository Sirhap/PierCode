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

  it('getConversationKey returns the stable URL after a /new -> /chat migration', () => {
    observeConversationURL('https://claude.ai/new');
    // After the first message the SPA settles on the stable conversation URL.
    expect(getConversationKey('https://claude.ai/chat/uuid-2')).toBe('https://claude.ai/chat/uuid-2');
    // And the key stays stable on subsequent observations of the same URL.
    expect(getConversationKey('https://claude.ai/chat/uuid-2')).toBe('https://claude.ai/chat/uuid-2');
  });

  it('getConversationKey falls back to the current URL when no migration happened', () => {
    expect(getConversationKey('https://chat.qwen.ai/c/abc')).toBe('https://chat.qwen.ai/c/abc');
  });
});

// __resetForReload clears only the in-memory module state, leaving sessionStorage
// intact — emulating a tab refresh where the alias set must survive.
function __resetForReload(): void {
  // observeConversationURL re-seeds conversationAliasSet from sessionStorage on
  // next call, so just clearing the observed URL is enough to simulate reload.
  // We piggyback on the public reset by snapshotting/restoring sessionStorage.
  const saved = sessionStorage.getItem('piercode_conversation_aliases');
  __resetConversationScopeForTest();
  if (saved !== null) sessionStorage.setItem('piercode_conversation_aliases', saved);
}
