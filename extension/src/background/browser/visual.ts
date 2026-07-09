// Visual regression (browser_visual_diff): pixel-compare the current screenshot
// against a stored baseline. The pixel diff is PURE (vitest-covered); decode/
// capture/storage live in the controller method.
//
// Baselines persist in chrome.storage.local as ≤maxDim PNGs so a handful of
// keys stays well under the storage quota; compare rasterizes both sides through
// the SAME path (image.ts rasterizeRGBA) so identical pages diff to zero.

export interface VisualDiffResult {
  width: number
  height: number
  totalPx: number
  diffPx: number
  /** diffPx / totalPx, 0..1 */
  ratio: number
}

/** Per-pixel compare of two same-sized RGBA buffers. A pixel differs when any
 *  channel's delta exceeds `tolerance` (0-255; absorbs antialias jitter). */
export function diffRGBA(
  a: Uint8ClampedArray | Uint8Array,
  b: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  tolerance = 16,
): VisualDiffResult {
  const totalPx = width * height
  const n = Math.min(a.length, b.length, totalPx * 4)
  let diffPx = 0
  for (let i = 0; i + 3 < n; i += 4) {
    if (
      Math.abs(a[i] - b[i]) > tolerance ||
      Math.abs(a[i + 1] - b[i + 1]) > tolerance ||
      Math.abs(a[i + 2] - b[i + 2]) > tolerance ||
      Math.abs(a[i + 3] - b[i + 3]) > tolerance
    ) diffPx++
  }
  return { width, height, totalPx, diffPx, ratio: totalPx ? diffPx / totalPx : 0 }
}

const pct = (r: number) => `${(r * 100).toFixed(2)}%`

/** PASS/FAIL line for the tool output. FAIL text is thrown by the controller so
 *  browser_test counts it as a failed step (assert semantics). */
export function renderVisualOutcome(key: string, r: VisualDiffResult, threshold: number): { pass: boolean; text: string } {
  const pass = r.ratio <= threshold
  const verdict = pass ? 'VISUAL PASS' : 'VISUAL FAIL'
  const cmp = pass ? '≤' : '>'
  return {
    pass,
    text: `${verdict}: key=${JSON.stringify(key)} diff=${pct(r.ratio)} ${cmp} threshold=${pct(threshold)} (${r.width}x${r.height}, ${r.diffPx}/${r.totalPx} px)`,
  }
}

export const VISUAL_BASELINE_PREFIX = 'piercode_visual_baseline_'

export interface StoredBaseline { base64: string; width: number; height: number; savedAt: number }

export function baselineStorageKey(key: string): string { return `${VISUAL_BASELINE_PREFIX}${key}` }

/** Validate the user-supplied baseline key (becomes a storage key suffix). */
export function validateVisualKey(key: unknown): string | null {
  const k = typeof key === 'string' ? key.trim() : ''
  if (!k) return 'key is required (names the baseline, e.g. "home-page")'
  if (k.length > 100) return 'key must be at most 100 characters'
  return null
}
