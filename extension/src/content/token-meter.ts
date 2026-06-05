// 全平台 token 计量。优先 js-tiktoken（o200k_base，懒加载），加载未完成或
// 失败时回退现有字符估算（estimateTokens）。回退后功能不降级，只是数字精度降低。

import { ConversationContext, estimateTokens } from './qwen-context-compress';

export type TokenAccuracy = 'exact' | 'estimate';

export interface TokenMeter {
  input: number;
  output: number;
  total: number;
  accuracy: TokenAccuracy;
}

// tiktoken 编码器单例。null = 未加载；'failed' = 永久回退。
type Encoder = { encode: (text: string) => number[] };
let encoder: Encoder | null = null;
let loadState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let loadPromise: Promise<void> | null = null;

// ensureTiktoken 启动一次懒加载。同步路径不等待——首次调用期间返回字符估算，
// 加载完成后的调用才用精确 token。失败永久回退，不重试风暴。
function ensureTiktoken(): void {
  if (loadState !== 'idle') return;
  loadState = 'loading';
  loadPromise = (async () => {
    try {
      const mod = await import('js-tiktoken');
      // o200k_base 覆盖新一代 GPT 编码；getEncoding 内置 rank 数据，无需网络。
      encoder = mod.getEncoding('o200k_base') as unknown as Encoder;
      loadState = 'ready';
    } catch (err) {
      console.warn('[PierCode] js-tiktoken 加载失败，回退字符估算:', err);
      encoder = null;
      loadState = 'failed';
    }
  })();
}

// tokenAccuracy 报告当前计量精度，供看板标注。
export function tokenAccuracy(): TokenAccuracy {
  return loadState === 'ready' && encoder ? 'exact' : 'estimate';
}

// whenTokenizerReady 暴露加载 Promise，便于加载完成后刷新看板（可选 await）。
export function whenTokenizerReady(): Promise<void> {
  ensureTiktoken();
  return loadPromise ?? Promise.resolve();
}

// countTokens 算单段文本的 token。tiktoken 就绪用精确值，否则字符估算。
export function countTokens(text: string): number {
  if (!text) return 0;
  ensureTiktoken();
  if (loadState === 'ready' && encoder) {
    try {
      return encoder.encode(text).length;
    } catch {
      return estimateTokens(text);
    }
  }
  return estimateTokens(text);
}

// computeMeter 把会话消息流算成 input/output/total。
// input = user + system 消息；output = assistant 消息。
export function computeMeter(ctx: ConversationContext): TokenMeter {
  let input = 0;
  let output = 0;
  for (const msg of ctx.messages) {
    const n = countTokens(msg.content);
    if (msg.role === 'assistant') {
      output += n;
    } else {
      input += n;
    }
  }
  return { input, output, total: input + output, accuracy: tokenAccuracy() };
}

// 仅供测试：重置加载状态。
export function __resetTokenizerForTest(): void {
  encoder = null;
  loadState = 'idle';
  loadPromise = null;
}
