export const DEFAULT_AUTO_EXECUTE = false;
export const DEFAULT_AUTO_APPROVE_BROWSER_ACTIONS = false;

// 自动执行/提交的"静默窗口"：从最后一次 DOM 变动算起，等待这么多毫秒确认
// 流式输出已停止，再批量执行 / 回填提交。0 = 立即（流一停就触发）。
// 取代旧的固定 1500ms*2 双等待，既能把一次响应里的多个工具调用聚成一批，
// 又能在慢速响应时自动顺延，不会提前单独提交。
// 注意：content/index.ts 内联了相同的常量与解析逻辑（避免共享分块产出 ESM
// import）。改这里的默认值/边界时，同步更新 content/index.ts 的内联副本。
export const DEFAULT_BATCH_QUIET_MS = 400;
export const MIN_BATCH_QUIET_MS = 0;
export const MAX_BATCH_QUIET_MS = 5000;

export function resolveBatchQuietMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BATCH_QUIET_MS;
  return Math.min(MAX_BATCH_QUIET_MS, Math.max(MIN_BATCH_QUIET_MS, Math.round(value)));
}

// 隐身模式：在 AI 页面上把插件的视觉痕迹降到最低。
// 关闭脉冲边框与大块状态徽章/停止按钮，改用角落的迷你圆点指示，
// 并随机化注入元素的 DOM id，避免页面凭固定特征探测到插件。
export const DEFAULT_STEALTH_MODE = false;
export const DEFAULT_PERMISSION_MODE = 'default';
export type PermissionMode = 'default' | 'auto' | 'unrestricted';

export function resolveStealthMode(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_STEALTH_MODE;
}

export function resolvePermissionMode(value: unknown): PermissionMode {
  return value === 'default' || value === 'auto' || value === 'unrestricted'
    ? value
    : DEFAULT_PERMISSION_MODE;
}

// Qwen 上下文压缩配置（保留：旧版只压 Qwen，仍被 content/qwen-context-compress.ts 引用）
export const DEFAULT_QWEN_COMPRESSION_ENABLED = true;
export const DEFAULT_QWEN_MAX_CONTEXT_TOKENS = 1_000_000;
export const DEFAULT_QWEN_MAX_SUMMARY_TOKENS = 65_536;

// 全平台上下文压缩配置。阈值按平台分别设置，键 = PlatformAdapter.name。
// 未列出的平台回退 defaultMaxContextTokens。默认阈值按各平台真实上下文窗口的
// 保守值预设（单位 token，统一 GPT tokenizer 当量）。
export const DEFAULT_COMPRESSION_ENABLED = true;
export const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;
export const DEFAULT_MAX_SUMMARY_TOKENS = 65_536;

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
