import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  setActiveSessionId,
  getActiveSessionId,
  type StoredSession,
} from '../sidebar/session-store';

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string[] | string) => {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.map(n => [n, store[n]]));
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(store, obj); }),
        remove: vi.fn(async (keys: string[] | string) => {
          const names = Array.isArray(keys) ? keys : [keys];
          for (const n of names) delete store[n];
        }),
      },
    },
  };
});

function mk(id: string, firstUser: string): StoredSession {
  return {
    id,
    platform: 'qwen',
    model: 'qwen3.7-plus',
    chatId: null,
    lastResponseId: null,
    messages: [{ role: 'user', content: firstUser }],
    ts: 1,
  };
}

describe('session-store', () => {
  it('saves a session and lists its metadata with a derived title', async () => {
    await saveSession(mk('s1', 'fix the auth bug please'));
    const list = await listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('s1');
    expect(list[0].title).toBe('fix the auth bug please');
  });

  it('truncates long titles to 30 chars', async () => {
    await saveSession(mk('s2', 'x'.repeat(50)));
    const list = await listSessions();
    expect(list[0].title.length).toBeLessThanOrEqual(30);
  });

  it('loads a saved session back by id', async () => {
    const s = mk('s3', 'hi');
    await saveSession(s);
    const got = await loadSession('s3');
    expect(got?.messages[0].content).toBe('hi');
  });

  it('deletes a session and removes it from the list', async () => {
    await saveSession(mk('s4', 'a'));
    await saveSession(mk('s5', 'b'));
    await deleteSession('s4');
    const list = await listSessions();
    expect(list.map(m => m.id)).toEqual(['s5']);
    expect(await loadSession('s4')).toBeNull();
  });

  it('tracks the active session id', async () => {
    await setActiveSessionId('s6');
    expect(await getActiveSessionId()).toBe('s6');
  });
});
