import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateTokens, type ConversationContext } from '../content/qwen-context-compress';
import {
  computeMeter,
  countTokens,
  tokenAccuracy,
  whenTokenizerReady,
  __resetTokenizerForTest,
  platformAccuracy,
  platformFactor,
} from '../content/token-meter';

// js-tiktoken mock：每个 token = 4 字符（确定性，便于断言）。
vi.mock('js-tiktoken', () => {
  const mockEncoder = {
    encode: (text: string) => new Array(Math.ceil(text.length / 4)).fill(0),
  };
  return {
    getEncoding: vi.fn(() => mockEncoder),
  };
});

afterEach(() => {
  __resetTokenizerForTest();
});

function ctx(messages: ConversationContext['messages']): ConversationContext {
  return {
    messages,
    totalChars: messages.reduce((s, m) => s + m.content.length, 0),
    lastCompressedAt: 0,
  };
}

describe('token-meter fallback before tokenizer loads', () => {
  it('returns char estimate synchronously while tiktoken is still loading', () => {
    __resetTokenizerForTest();
    const text = 'hello world '.repeat(10);
    // 第一次同步调用：加载刚触发，编码器未就绪 → 估算回退。
    expect(countTokens(text)).toBe(estimateTokens(text));
    expect(tokenAccuracy()).toBe('estimate');
  });
});

describe('token-meter exact path after tokenizer ready', () => {
  it('uses tiktoken once loaded and reports exact accuracy', async () => {
    __resetTokenizerForTest();
    void countTokens('warm up the lazy loader');
    await whenTokenizerReady();
    expect(tokenAccuracy()).toBe('exact');
    // mock 编码器：4 字符 = 1 token
    expect(countTokens('a'.repeat(40))).toBe(10);
  });

  it('memoizes by content: a repeated count returns the identical value', async () => {
    __resetTokenizerForTest();
    void countTokens('warm');
    await whenTokenizerReady();
    const text = 'b'.repeat(80);
    const first = countTokens(text);
    const cached = countTokens(text); // served from the memo
    expect(cached).toBe(first);
    expect(cached).toBe(20);
    // computeMeter over unchanged messages must be stable across repeated calls
    const messages = ctx([
      { role: 'user', content: text, timestamp: 1 },
      { role: 'assistant', content: 'c'.repeat(40), timestamp: 2 },
    ]);
    const m1 = computeMeter(messages);
    const m2 = computeMeter(messages);
    expect(m2).toEqual(m1);
  });
});

describe('computeMeter role classification', () => {
  it('counts user + system as input and assistant as output', async () => {
    __resetTokenizerForTest();
    void countTokens('warm');
    await whenTokenizerReady();

    const meter = computeMeter(ctx([
      { role: 'system', content: 'a'.repeat(8), timestamp: 1 },   // 2 tokens → input
      { role: 'user', content: 'b'.repeat(12), timestamp: 2 },    // 3 tokens → input
      { role: 'assistant', content: 'c'.repeat(20), timestamp: 3 }, // 5 tokens → output
    ]));

    expect(meter.input).toBe(5);
    expect(meter.output).toBe(5);
    expect(meter.total).toBe(10);
    expect(meter.accuracy).toBe('exact');
  });

  it('returns zeros for an empty conversation', () => {
    const meter = computeMeter(ctx([]));
    expect(meter).toMatchObject({ input: 0, output: 0, total: 0 });
  });
});

describe('computeMeter platform-aware', () => {
  it('applies claude factor (>= raw) to totals', async () => {
    __resetTokenizerForTest();
    void countTokens('warm');
    await whenTokenizerReady();
    const claude = computeMeter(ctx([{ role: 'user', content: 'hello world '.repeat(20), timestamp: 1 }]), 'claude');
    const chatgpt = computeMeter(ctx([{ role: 'user', content: 'hello world '.repeat(20), timestamp: 1 }]), 'chatgpt');
    expect(claude.total).toBeGreaterThanOrEqual(chatgpt.total);
    expect(claude.accuracy).toBe('estimate');
  });

  it('chatgpt meter is exact tier', async () => {
    __resetTokenizerForTest();
    void countTokens('warm');
    await whenTokenizerReady();
    const m = computeMeter(ctx([{ role: 'assistant', content: 'reply text here', timestamp: 1 }]), 'chatgpt');
    expect(m.accuracy).toBe('exact');
    expect(m.output).toBeGreaterThan(0);
    expect(m.input).toBe(0);
  });
});

describe('token-meter platform accuracy tier', () => {
  it('chatgpt is exact', () => {
    expect(platformAccuracy('chatgpt', 'ready')).toBe('exact');
  });
  it('qwen is approx when tokenizer ready', () => {
    expect(platformAccuracy('qwen', 'ready')).toBe('approx');
  });
  it('claude is estimate when tokenizer ready', () => {
    expect(platformAccuracy('claude', 'ready')).toBe('estimate');
  });
  it('any platform is estimate when tokenizer not ready', () => {
    expect(platformAccuracy('chatgpt', 'failed')).toBe('estimate');
  });
});

describe('token-meter platform factor', () => {
  it('chatgpt factor is 1.0', () => {
    expect(platformFactor('chatgpt')).toBe(1.0);
  });
  it('claude factor is 1.15', () => {
    expect(platformFactor('claude')).toBe(1.15);
  });
  it('unknown platform falls back to 1.0', () => {
    expect(platformFactor('totally-unknown')).toBe(1.0);
  });
});
