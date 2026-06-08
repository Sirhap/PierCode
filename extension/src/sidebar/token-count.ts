// Sidebar-local token counting. A self-contained copy of the counting essentials
// from content/token-meter.ts.
//
// Why a copy and not an import: content/index.ts is a classic MV3 content script
// (no ESM import allowed). content/status-panel.ts + token-hud.ts import
// content/token-meter.ts, so if the sidebar ALSO imported it, Rollup would hoist
// token-meter into a shared chunk and emit a static `import ... from` into
// content.js — breaking the classic content script (content-build.test.ts guards
// this). settings.ts duplicates qwen-settings.ts for the same reason. Keep the
// counting logic in sync with content/token-meter.ts when changing factors.

export type TokenAccuracy = 'exact' | 'approx' | 'estimate'
export type LoadState = 'idle' | 'loading' | 'ready' | 'failed'

export interface TokenMeter {
  input: number
  output: number
  total: number
  accuracy: TokenAccuracy
}

export interface MeterMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

// Per-platform correction factors relative to o200k_base (mirror token-meter.ts).
export const PLATFORM_TOKEN_FACTOR: Record<string, number> = {
  chatgpt: 1.0,
  qwen: 1.0,
  gemini: 1.1,
  claude: 1.15,
}

export function platformFactor(platform: string): number {
  return PLATFORM_TOKEN_FACTOR[platform] ?? 1.0
}

export function platformAccuracy(platform: string, state: LoadState): TokenAccuracy {
  if (state !== 'ready') return 'estimate'
  if (platform === 'chatgpt') return 'exact'
  if (platform === 'qwen') return 'approx'
  if (platform === 'gemini') return 'approx'
  return 'estimate'
}

// Character-based fallback estimate (mirror qwen-context-compress estimateTokens):
// ASCII ~4 chars/token, non-ASCII ~1.5 chars/token.
export function estimateTokens(text: string): number {
  if (!text) return 0
  const ascii = (text.match(/[\x00-\x7F]/g) || []).length
  const nonAscii = text.length - ascii
  return Math.ceil(ascii / 4 + nonAscii / 1.5)
}

type Encoder = { encode: (text: string) => number[] }
const encoders: Partial<Record<'o200k_base' | 'cl100k_base', Encoder>> = {}
let loadState: LoadState = 'idle'
let loadPromise: Promise<void> | null = null

export function tokenizerState(): LoadState {
  return loadState
}

function encoderFor(platform: string): Encoder | null {
  const name = platform === 'qwen' ? 'cl100k_base' : 'o200k_base'
  return encoders[name] ?? null
}

function ensureTiktoken(): void {
  if (loadState !== 'idle') return
  loadState = 'loading'
  loadPromise = (async () => {
    try {
      const mod = await import('js-tiktoken')
      encoders.o200k_base = mod.getEncoding('o200k_base') as unknown as Encoder
      encoders.cl100k_base = mod.getEncoding('cl100k_base') as unknown as Encoder
      loadState = 'ready'
    } catch (err) {
      console.warn('[PierCode] js-tiktoken 加载失败，回退字符估算:', err)
      delete encoders.o200k_base
      delete encoders.cl100k_base
      loadState = 'failed'
    }
  })()
}

export function whenTokenizerReady(): Promise<void> {
  ensureTiktoken()
  return loadPromise ?? Promise.resolve()
}

export function countTokens(text: string, platform = 'chatgpt'): number {
  if (!text) return 0
  ensureTiktoken()
  const enc = loadState === 'ready' ? encoderFor(platform) : null
  if (enc) {
    try {
      return Math.round(enc.encode(text).length * platformFactor(platform))
    } catch {
      return estimateTokens(text)
    }
  }
  return estimateTokens(text)
}

export function computeMeter(messages: MeterMessage[], platform = 'chatgpt'): TokenMeter {
  let input = 0
  let output = 0
  for (const msg of messages) {
    const n = countTokens(msg.content, platform)
    if (msg.role === 'assistant') output += n
    else input += n
  }
  return { input, output, total: input + output, accuracy: platformAccuracy(platform, loadState) }
}

// Test-only reset.
export function __resetTokenizerForTest(): void {
  delete encoders.o200k_base
  delete encoders.cl100k_base
  loadState = 'idle'
  loadPromise = null
}
