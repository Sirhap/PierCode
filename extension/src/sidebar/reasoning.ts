// Per-platform "thinking level" (reasoning effort) helpers for the sidebar.
// Pure data + functions, no React/chrome, so it stays unit-testable (mirrors
// glow.ts). Each platform exposes its OWN set of levels because the underlying
// web protocols differ: Qwen has a Fast/Thinking/auto feature_config, the
// OpenAI-compatible API takes reasoning_effort=low|medium|high, claude.ai's
// web /completion has no thinking field (empty list → no picker), and ChatGPT
// picks a thinking model slug.
//
// The `key` strings are stored verbatim in chrome.storage (key
// `${platform}Reasoning`) and travel through CHAT_REQUEST → BuildCtx, where
// each platform's buildBody() maps its own keys onto request fields. Keys are
// platform-scoped: 'off' means the same thing everywhere (no reasoning), but
// 'low'/'medium'/'high' only exist for openai, etc.

export type Platform = 'qwen' | 'chatgpt' | 'claude' | 'openai'

export interface ReasoningLevel {
  key: string
  label: string
}

// 'off' is the shared "no thinking" key. Order = display order in the picker;
// the FIRST entry is the per-platform default (see DEFAULT_REASONING).
export const REASONING_LEVELS: Record<Platform, ReasoningLevel[]> = {
  qwen: [
    { key: 'off', label: '关闭' },
    { key: 'fast', label: '快速' },
    { key: 'think', label: '思考' },
    { key: 'auto', label: '自动' },
  ],
  openai: [
    { key: 'off', label: '关闭' },
    { key: 'low', label: '低' },
    { key: 'medium', label: '中' },
    { key: 'high', label: '高' },
  ],
  // claude.ai web /completion 协议没有 thinking 字段（chat-api buildBody 已不
  // 发送），不渲染假开关。
  claude: [],
  chatgpt: [
    { key: 'auto', label: '自动' },
    { key: 'think', label: '思考' },
  ],
}

// First level of each platform is its default. Qwen defaults to 'off' to keep
// the existing behaviour (the sidebar disabled deep thinking to avoid verbose
// reasoning loops); ChatGPT has no 'off' so it defaults to 'auto'.
export const DEFAULT_REASONING: Record<Platform, string> = {
  qwen: 'off',
  openai: 'off',
  claude: 'off',
  chatgpt: 'auto',
}

export function levelsForPlatform(platform: string): ReasoningLevel[] {
  return REASONING_LEVELS[platform as Platform] || []
}

export function defaultReasoning(platform: string): string {
  return DEFAULT_REASONING[platform as Platform] ?? 'off'
}

export function isReasoning(platform: string, v: unknown): v is string {
  return typeof v === 'string' && levelsForPlatform(platform).some(l => l.key === v)
}

export function normalizeReasoning(platform: string, v: unknown): string {
  return isReasoning(platform, v) ? (v as string) : defaultReasoning(platform)
}

export const REASONING_STORAGE_KEY = (platform: string) => `${platform}Reasoning`
