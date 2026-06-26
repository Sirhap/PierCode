// 全平台 token 计量。优先 js-tiktoken（o200k_base，懒加载），加载未完成或
// 失败时回退现有字符估算（estimateTokens）。回退后功能不降级，只是数字精度降低。

import { ConversationContext, estimateTokens } from './qwen-context-compress';

export type TokenAccuracy = 'exact' | 'approx' | 'estimate';

export interface TokenMeter {
  input: number;
  output: number;
  total: number;
  accuracy: TokenAccuracy;
}

export type LoadState = 'idle' | 'loading' | 'ready' | 'failed';

// 各平台相对 o200k_base 的经验校正系数（混合中英文/代码）。保守初值，可后续标定。
export const PLATFORM_TOKEN_FACTOR: Record<string, number> = {
  chatgpt: 1.0,
  qwen: 1.0,   // 用 cl100k_base 直接编码，不额外乘系数
  gemini: 1.1,
  claude: 1.15,
};

export function platformFactor(platform: string): number {
  return PLATFORM_TOKEN_FACTOR[platform] ?? 1.0;
}

// 精度档：chatgpt+o200k=精确；qwen+cl100k=近似；gemini 系数=近似；其余估算。
// tokenizer 未就绪一律 estimate。
export function platformAccuracy(platform: string, state: LoadState): TokenAccuracy {
  if (state !== 'ready') return 'estimate';
  if (platform === 'chatgpt') return 'exact';
  if (platform === 'qwen') return 'approx';
  if (platform === 'gemini') return 'approx';
  return 'estimate';
}

// tiktoken 编码器单例。null = 未加载；'failed' = 永久回退。
type Encoder = { encode: (text: string) => number[] };
// 两套编码：o200k_base 给 GPT 系；cl100k_base 给 qwen（更贴近其 BPE）。
const encoders: Partial<Record<'o200k_base' | 'cl100k_base', Encoder>> = {};
let loadState: LoadState = 'idle';
let loadPromise: Promise<void> | null = null;

// tokenizerState 暴露加载状态，供面板/测试判断精度档。
export function tokenizerState(): LoadState {
  return loadState;
}

// encoderFor 按平台选编码器。qwen 用 cl100k，其余用 o200k。
function encoderFor(platform: string): Encoder | null {
  const name = platform === 'qwen' ? 'cl100k_base' : 'o200k_base';
  return encoders[name] ?? null;
}

// ensureTiktoken 启动一次懒加载。同步路径不等待——首次调用期间返回字符估算，
// 加载完成后的调用才用精确 token。失败永久回退，不重试风暴。
function ensureTiktoken(): void {
  if (loadState !== 'idle') return;
  loadState = 'loading';
  loadPromise = (async () => {
    try {
      const mod = await import('js-tiktoken');
      // getEncoding 内置 rank 数据，无需网络。
      encoders.o200k_base = mod.getEncoding('o200k_base') as unknown as Encoder;
      encoders.cl100k_base = mod.getEncoding('cl100k_base') as unknown as Encoder;
      loadState = 'ready';
    } catch (err) {
      console.warn('[PierCode] js-tiktoken 加载失败，回退字符估算:', err);
      delete encoders.o200k_base;
      delete encoders.cl100k_base;
      loadState = 'failed';
    }
  })();
}

// tokenAccuracy 报告默认（GPT）计量精度，供旧看板标注。平台相关精度用 platformAccuracy。
export function tokenAccuracy(): TokenAccuracy {
  return loadState === 'ready' && encoders.o200k_base ? 'exact' : 'estimate';
}

// whenTokenizerReady 暴露加载 Promise，便于加载完成后刷新看板（可选 await）。
export function whenTokenizerReady(): Promise<void> {
  ensureTiktoken();
  return loadPromise ?? Promise.resolve();
}

// countTokens 算单段文本的 token。tiktoken 就绪用平台编码器（含校正系数），否则字符估算。
//
// 结果按 (platform,text) 记忆化：会话历史一旦定型其 token 数不变，但 computeMeter 会被
// 高频重算（content 端 3s 定时刷新 + sidebar 流式每 chunk 重算整段历史）。js-tiktoken 是
// 纯 JS BPE（~1-5MB/s），重新编码数百 KB 历史是 ~100-300ms 主线程开销，重复跑会卡。记忆化
// 让不变历史命中缓存，只有增长中的流式尾部重新编码。纯函数，返回值不变。
const COUNT_CACHE_MAX = 500;
const countCache = new Map<string, number>();

export function countTokens(text: string, platform = 'chatgpt'): number {
  if (!text) return 0;
  ensureTiktoken();
  const enc = loadState === 'ready' ? encoderFor(platform) : null;
  if (!enc) return estimateTokens(text);
  const key = platform + '\0' + text;
  const cached = countCache.get(key);
  if (cached !== undefined) {
    // LRU touch: re-insert so hot entries stay live.
    countCache.delete(key);
    countCache.set(key, cached);
    return cached;
  }
  let n: number;
  try {
    n = Math.round(enc.encode(text).length * platformFactor(platform));
  } catch {
    return estimateTokens(text); // don't cache the fallback — tokenizer may recover
  }
  countCache.set(key, n);
  if (countCache.size > COUNT_CACHE_MAX) {
    // Map preserves insertion order → first key is the least-recently-used.
    const oldest = countCache.keys().next().value;
    if (oldest !== undefined) countCache.delete(oldest);
  }
  return n;
}

// computeMeter 把会话消息流算成 input/output/total。
// input = user + system 消息；output = assistant 消息。
export function computeMeter(ctx: ConversationContext, platform = 'chatgpt'): TokenMeter {
  let input = 0;
  let output = 0;
  for (const msg of ctx.messages) {
    const n = countTokens(msg.content, platform);
    if (msg.role === 'assistant') {
      output += n;
    } else {
      input += n;
    }
  }
  return { input, output, total: input + output, accuracy: platformAccuracy(platform, loadState) };
}

// 仅供测试：重置加载状态。
export function __resetTokenizerForTest(): void {
  delete encoders.o200k_base;
  delete encoders.cl100k_base;
  loadState = 'idle';
  loadPromise = null;
  countCache.clear();
}
