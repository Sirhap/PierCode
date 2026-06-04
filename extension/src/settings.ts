export const DEFAULT_AUTO_EXECUTE = false;
export const DEFAULT_AUTO_APPROVE_BROWSER_ACTIONS = false;

// 隐身模式：在 AI 页面上把插件的视觉痕迹降到最低。
// 关闭脉冲边框与大块状态徽章/停止按钮，改用角落的迷你圆点指示，
// 并随机化注入元素的 DOM id，避免页面凭固定特征探测到插件。
export const DEFAULT_STEALTH_MODE = false;

export function resolveStealthMode(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_STEALTH_MODE;
}

// Qwen 上下文压缩配置
export const DEFAULT_QWEN_COMPRESSION_ENABLED = true;
export const DEFAULT_QWEN_MAX_CONTEXT_TOKENS = 1_000_000;
export const DEFAULT_QWEN_MAX_SUMMARY_TOKENS = 65_536;

export function resolveAutoExecute(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_AUTO_EXECUTE;
}

export function resolveAutoApproveBrowserActions(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_AUTO_APPROVE_BROWSER_ACTIONS;
}

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
