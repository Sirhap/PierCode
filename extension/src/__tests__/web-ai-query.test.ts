import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  shouldHandleWebAIQuery,
  waitForStableWebAIResponse,
  WebAIQueryMessage,
} from '../content/web-ai-query';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('shouldHandleWebAIQuery', () => {
  it('matches by provider unless an exact client id target is supplied', () => {
    const base: WebAIQueryMessage = {
      type: 'ai_query',
      query_id: 'q1',
      text: 'ask',
      provider: 'Claude',
    };

    expect(shouldHandleWebAIQuery(base, { provider: 'Claude', clientId: 'content-a' })).toBe(true);
    expect(shouldHandleWebAIQuery(base, { provider: 'Qwen', clientId: 'content-a' })).toBe(false);
    expect(shouldHandleWebAIQuery({ ...base, client_id: 'content-a', provider: 'Qwen' }, { provider: 'Claude', clientId: 'content-a' })).toBe(true);
    expect(shouldHandleWebAIQuery({ ...base, client_id: 'content-b' }, { provider: 'Claude', clientId: 'content-a' })).toBe(false);
  });
});

describe('waitForStableWebAIResponse', () => {
  it('ignores history and resolves after the newest response stops changing', async () => {
    vi.useFakeTimers();
    try {
      const dom = new JSDOM('<main><div class="assistant">old answer</div></main>');
      const doc = dom.window.document as Document;
      const history = Array.from(doc.querySelectorAll('.assistant'));
      const collect = () => Array.from(doc.querySelectorAll('.assistant')).map(element => ({
        element,
        text: element.textContent || '',
      }));

      let settled: string | undefined;
      const promise = waitForStableWebAIResponse({
        collect,
        initialElements: history,
        observeRoot: doc.body,
        timeoutMs: 5_000,
        stableMs: 400,
        pollMs: 100,
      });
      promise.then(result => {
        settled = result.text;
      });

      const current = doc.createElement('div');
      current.className = 'assistant';
      current.textContent = 'draft';
      doc.querySelector('main')!.appendChild(current);

      await vi.advanceTimersByTimeAsync(100);
      current.textContent = 'final answer';
      await vi.advanceTimersByTimeAsync(399);
      await flushMicrotasks();
      expect(settled).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toMatchObject({ text: 'final answer' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resolve while the page still reports generation in progress', async () => {
    vi.useFakeTimers();
    try {
      const dom = new JSDOM('<main><div class="assistant">complete text</div></main>');
      const doc = dom.window.document as Document;
      let generating = true;
      const promise = waitForStableWebAIResponse({
        collect: () => Array.from(doc.querySelectorAll('.assistant')).map(element => ({
          element,
          text: element.textContent || '',
        })),
        observeRoot: doc.body,
        timeoutMs: 5_000,
        stableMs: 300,
        pollMs: 100,
        isGenerating: () => generating,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await flushMicrotasks();
      generating = false;
      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toMatchObject({ text: 'complete text' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores rerendered history text even when the element identity changes', async () => {
    vi.useFakeTimers();
    try {
      const dom = new JSDOM('<main><div class="assistant">already done</div></main>');
      const doc = dom.window.document as Document;
      const promise = waitForStableWebAIResponse({
        collect: () => (Array.from(doc.querySelectorAll('.assistant')) as Element[]).map(element => ({
          element,
          text: element.textContent || '',
        })),
        initialTexts: ['already done'],
        observeRoot: doc.body,
        timeoutMs: 5_000,
        stableMs: 300,
        pollMs: 100,
      });

      doc.querySelector('main')!.innerHTML = '<div class="assistant">already done</div>';
      await vi.advanceTimersByTimeAsync(1_000);
      doc.querySelector('main')!.innerHTML += '<div class="assistant">new answer</div>';
      await vi.advanceTimersByTimeAsync(300);
      await flushMicrotasks();

      await expect(promise).resolves.toMatchObject({ text: 'new answer' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('can ignore provider status text while waiting for a real answer', async () => {
    vi.useFakeTimers();
    try {
      const dom = new (JSDOM as any)('<main></main>', { url: 'https://chat.qwen.ai/' });
      const doc = dom.window.document as Document;
      const promise = waitForStableWebAIResponse({
        collect: () => (Array.from(doc.querySelectorAll('.assistant')) as Element[]).map(element => ({
          element,
          text: element.textContent || '',
        })),
        ignoreText: text => text.trim() === '已经完成思考',
        observeRoot: doc.body,
        timeoutMs: 5_000,
        stableMs: 300,
        pollMs: 100,
      });

      doc.querySelector('main')!.innerHTML = '<div class="assistant">已经完成思考</div>';
      await vi.advanceTimersByTimeAsync(1_000);
      doc.querySelector('main')!.innerHTML += '<div class="assistant">可以收到。</div>';
      await vi.advanceTimersByTimeAsync(300);
      await flushMicrotasks();

      await expect(promise).resolves.toMatchObject({ text: '可以收到。' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast when a new assistant turn stays empty', async () => {
    vi.useFakeTimers();
    try {
      const dom = new JSDOM('<main></main>');
      const doc = dom.window.document as Document;
      const promise = waitForStableWebAIResponse({
        collect: () => (Array.from(doc.querySelectorAll('.assistant')) as Element[]).map(element => ({
          element,
          text: element.textContent || '',
        })),
        observeRoot: doc.body,
        timeoutMs: 10_000,
        stableMs: 300,
        pollMs: 100,
        emptyCandidateTimeoutMs: 1_000,
      });

      doc.querySelector('main')!.innerHTML = '<div class="assistant"></div>';
      const assertion = expect(promise).rejects.toThrow('web AI assistant turn stalled empty');
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not ignore a Qwen answer that starts with a completed-thinking status line', async () => {
    vi.useFakeTimers();
    try {
      const dom = new (JSDOM as any)('<main></main>', { url: 'https://chat.qwen.ai/' });
      const doc = dom.window.document as Document;
      const promise = waitForStableWebAIResponse({
        collect: () => (Array.from(doc.querySelectorAll('.assistant')) as Element[]).map(element => ({
          element,
          text: element.textContent || '',
        })),
        ignoreText: text => text.trim().replace(/\s+/g, ' ') === '已经完成思考',
        observeRoot: doc.body,
        timeoutMs: 5_000,
        stableMs: 300,
        pollMs: 100,
      });

      doc.querySelector('main')!.innerHTML = '<div class="assistant">已经完成思考\n收到，我可以继续处理这条 Claude CLI 消息。</div>';
      await vi.advanceTimersByTimeAsync(300);
      await flushMicrotasks();

      await expect(promise).resolves.toMatchObject({
        text: '已经完成思考\n收到，我可以继续处理这条 Claude CLI 消息。',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
