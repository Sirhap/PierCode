import {
  platformAccuracy,
  tokenizerState,
  type TokenMeter,
  type TokenAccuracy,
} from './token-count'

interface TokenPanelProps {
  meter: TokenMeter
  threshold?: number
  platform?: string
}

// Per-platform compression thresholds (mirror content/qwen-settings.ts
// DEFAULT_PLATFORM_THRESHOLDS — inlined so the sidebar doesn't import the
// content-side leaf and pull it into content.js's chunk).
const DEFAULT_THRESHOLDS: Record<string, number> = {
  chatgpt: 128_000,
  qwen: 256_000,
  claude: 200_000,
  gemini: 1_000_000,
  openai: 128_000,
}

// Rough per-1M-token USD price for cost estimate (input+output blended, conservative).
const PRICE_PER_1M: Record<string, number> = {
  qwen: 0.5,
  chatgpt: 5,
  claude: 6,
  openai: 5,
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const ACCURACY_STYLE: Record<TokenAccuracy, string> = {
  exact: 'text-emerald-400',
  approx: 'text-amber-400',
  estimate: 'text-gray-500',
}

export default function TokenPanel({ meter, threshold, platform = 'qwen' }: TokenPanelProps) {
  // The tokenizer-ready effect now lives in App.tsx, which re-renders when
  // tiktoken loads and passes a freshly computed meter down as a prop. No
  // internal effect or recompute needed here.

  const accuracy = platformAccuracy(platform, tokenizerState())
  const effectiveThreshold = threshold || DEFAULT_THRESHOLDS[platform] || 128_000
  const ratio = meter.total / effectiveThreshold
  const pct = Math.min(100, Math.round(ratio * 100))

  const barColor = ratio >= 1 ? 'bg-red-500' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-emerald-500'
  const dotColor = ratio >= 1 ? 'bg-red-400' : ratio >= 0.8 ? 'bg-amber-400' : 'bg-emerald-400'

  const price = PRICE_PER_1M[platform]
  const cost = price ? (meter.total / 1_000_000) * price : 0

  return (
    <div className="px-3 py-1.5 border-t border-gray-800/40 bg-gray-950 flex-shrink-0">
      <div className="flex items-center gap-3 text-[10px] text-gray-500 mb-1">
        <span>Input <span className="text-gray-400">{fmt(meter.input)}</span></span>
        <span>Output <span className="text-gray-400">{fmt(meter.output)}</span></span>
        <span className="font-semibold text-gray-300">Total {fmt(meter.total)}</span>
        <span className="ml-auto">{fmt(effectiveThreshold)}</span>
      </div>
      {/* Progress bar; fills to threshold (compression trigger) at 100%. */}
      <div className="relative h-1 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <span className="text-[9px] text-gray-600">{pct}%</span>
        <span className={`text-[9px] ${ACCURACY_STYLE[accuracy]}`}>· {accuracy}</span>
        {cost > 0 && <span className="text-[9px] text-gray-600">· ~${cost.toFixed(3)}</span>}
        {ratio >= 0.8 && <span className="text-[9px] text-amber-500 ml-auto">将压缩</span>}
      </div>
    </div>
  )
}
