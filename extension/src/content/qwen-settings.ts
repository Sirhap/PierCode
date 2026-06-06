export const DEFAULT_QWEN_COMPRESSION_ENABLED = true;
export const DEFAULT_QWEN_MAX_CONTEXT_TOKENS = 1_000_000;
export const DEFAULT_QWEN_MAX_SUMMARY_TOKENS = 65_536;

export interface QwenCompressionConfig {
  enabled: boolean;
  maxContextTokens: number;
  maxSummaryTokens: number;
}

export function resolveQwenCompressionConfig(value: unknown): QwenCompressionConfig {
  const defaults: QwenCompressionConfig = {
    enabled: DEFAULT_QWEN_COMPRESSION_ENABLED,
    maxContextTokens: DEFAULT_QWEN_MAX_CONTEXT_TOKENS,
    maxSummaryTokens: DEFAULT_QWEN_MAX_SUMMARY_TOKENS
  };
  if (!value || typeof value !== 'object') return defaults;
  const cfg = value as Partial<QwenCompressionConfig>;
  return {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : defaults.enabled,
    maxContextTokens: typeof cfg.maxContextTokens === 'number' && cfg.maxContextTokens > 0
      ? cfg.maxContextTokens : defaults.maxContextTokens,
    maxSummaryTokens: typeof cfg.maxSummaryTokens === 'number' && cfg.maxSummaryTokens > 0
      ? cfg.maxSummaryTokens : defaults.maxSummaryTokens
  };
}

// ── 全平台上下文压缩配置 ──
// 注意：这里是内容脚本能安全 import 的零依赖叶子模块（MV3 classic content
// script 不允许 ESM import，所以 content 不能直接引 ../settings）。
// settings.ts 不能 re-export 本文件：popup 经 settings.ts 引到这里会让 Rollup
// 把本文件拆成 content.js 也要 import 的共享 chunk，破坏 classic 脚本。因此
// settings.ts 保留一份等价副本给 popup/background/测试，两处必须同步——
// settings.test.ts 的 parity 用例会守护不漂移。改阈值默认值/校验逻辑时两处都改。

export const DEFAULT_COMPRESSION_ENABLED = true;
export const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;
export const DEFAULT_MAX_SUMMARY_TOKENS = 65_536;

// 各平台压缩阈值默认值，键 = PlatformAdapter.name。未列出的平台回退
// defaultMaxContextTokens。预设为各平台真实上下文窗口的保守值（单位 token，
// 统一 GPT tokenizer 当量）。
export const DEFAULT_PLATFORM_THRESHOLDS: Record<string, number> = {
  chatgpt: 128_000,
  qwen: 256_000,
  claude: 200_000,
  gemini: 1_000_000,
  aistudio: 1_000_000,
  kimi: 128_000,
  chatz: 128_000,
  mimo: 128_000,
};

export interface ContextCompressionConfig {
  enabled: boolean;
  perPlatformThresholds: Record<string, number>;
  defaultMaxContextTokens: number;
  maxSummaryTokens: number;
}

function sanitizeThresholds(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      out[k] = Math.round(v);
    }
  }
  return out;
}

// resolveContextCompressionConfig 解析存储里的通用压缩配置。当通用配置缺失时，
// 尝试从旧的 qwenCompressionConfig 迁移（旧 maxContextTokens → qwen 平台阈值 +
// 全局默认），保证升级用户不丢设置。
export function resolveContextCompressionConfig(
  value: unknown,
  legacyQwen?: unknown
): ContextCompressionConfig {
  const defaults: ContextCompressionConfig = {
    enabled: DEFAULT_COMPRESSION_ENABLED,
    perPlatformThresholds: { ...DEFAULT_PLATFORM_THRESHOLDS },
    defaultMaxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    maxSummaryTokens: DEFAULT_MAX_SUMMARY_TOKENS,
  };

  if (!value || typeof value !== 'object') {
    if (legacyQwen && typeof legacyQwen === 'object') {
      const legacy = resolveQwenCompressionConfig(legacyQwen);
      return {
        enabled: legacy.enabled,
        perPlatformThresholds: { ...DEFAULT_PLATFORM_THRESHOLDS, qwen: legacy.maxContextTokens },
        defaultMaxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        maxSummaryTokens: legacy.maxSummaryTokens,
      };
    }
    return defaults;
  }

  const cfg = value as Partial<ContextCompressionConfig>;
  return {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : defaults.enabled,
    perPlatformThresholds: { ...DEFAULT_PLATFORM_THRESHOLDS, ...sanitizeThresholds(cfg.perPlatformThresholds) },
    defaultMaxContextTokens:
      typeof cfg.defaultMaxContextTokens === 'number' && cfg.defaultMaxContextTokens > 0
        ? Math.round(cfg.defaultMaxContextTokens)
        : defaults.defaultMaxContextTokens,
    maxSummaryTokens:
      typeof cfg.maxSummaryTokens === 'number' && cfg.maxSummaryTokens > 0
        ? Math.round(cfg.maxSummaryTokens)
        : defaults.maxSummaryTokens,
  };
}

// thresholdForPlatform 返回某平台的压缩阈值：优先用户配置，否则全局默认。
export function thresholdForPlatform(config: ContextCompressionConfig, platform: string): number {
  const t = config.perPlatformThresholds[platform];
  return typeof t === 'number' && t > 0 ? t : config.defaultMaxContextTokens;
}
