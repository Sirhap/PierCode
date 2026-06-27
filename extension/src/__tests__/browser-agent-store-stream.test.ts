import { describe, it, expect, beforeEach, vi } from 'vitest';

// audit #9: a BROWSER_AGENT_STREAM without a (matching) taskId must NOT be
// appended to the current task's streamPreview. The bridge route used to emit
// STREAM via a bare broadcast with no taskId, so an old/stale task's text leaked
// into a freshly started task's preview.

let captured: ((msg: unknown) => void) | null = null;

beforeEach(() => {
  captured = null;
  (globalThis as any).chrome = {
    runtime: {
      sendMessage: vi.fn(() => Promise.resolve()),
      onMessage: {
        addListener: (fn: (msg: unknown) => void) => { captured = fn; },
        removeListener: () => {},
      },
    },
  };
});

async function makeStartedStore() {
  const { createBrowserAgentStore } = await import('../sidebar/browser-agent-store');
  const store = createBrowserAgentStore();
  // startTask generates the store's currentTaskId and sends BROWSER_AGENT_TASK.
  store.startTask('chatgpt', 'do a thing');
  // Recover the taskId the store just generated from the outgoing TASK message.
  const send = (chrome as any).runtime.sendMessage as ReturnType<typeof vi.fn>;
  const taskMsg = send.mock.calls.map(c => c[0]).find((m: any) => m?.type === 'BROWSER_AGENT_TASK');
  return { store, taskId: taskMsg?.taskId as string };
}

describe('browser-agent-store STREAM scoping (audit #9)', () => {
  it('drops a STREAM with no taskId while a task is active', async () => {
    const { store } = await makeStartedStore();
    expect(captured).toBeTruthy();
    captured!({ type: 'BROWSER_AGENT_STREAM', chunk: 'STALE' });
    expect(store.getState().streamPreview ?? '').not.toContain('STALE');
  });

  it('drops a STREAM whose taskId does not match the current task', async () => {
    const { store } = await makeStartedStore();
    captured!({ type: 'BROWSER_AGENT_STREAM', taskId: 'some-other-task', chunk: 'OTHER' });
    expect(store.getState().streamPreview ?? '').not.toContain('OTHER');
  });

  it('accepts a STREAM tagged with the current taskId', async () => {
    const { store, taskId } = await makeStartedStore();
    expect(taskId).toBeTruthy();
    captured!({ type: 'BROWSER_AGENT_STREAM', taskId, chunk: 'MINE' });
    expect(store.getState().streamPreview ?? '').toContain('MINE');
  });
});
