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
