// Screenshot vision-token budget (OffscreenCanvas) + GIF encode (gifenc) + base64
// passthrough for PDF. Replaces Go's image/gif/jpeg stdlib + filesystem writes:
// the SW has no filesystem, so everything returns a base64 dataURL.
//
// gifenc is imported statically (not dynamic import()) on purpose: a dynamic import
// makes Vite emit a vite-preload-helper chunk that gets statically pulled into
// content.js, breaking the classic-MV3-content-script guard (content-build.test.ts).
// See memory: sidebar-tiktoken-content-chunk-leak. Static import keeps gifenc in
// background.js only.
import { GIFEncoder, quantize, applyPalette } from 'gifenc'

/** Pure: target dims that cap the longest side at maxDim, preserving aspect.
 *  Port of screenshot_budget.go downscaleBox. */
export function budgetTargetDims(w: number, h: number, maxDim: number): { width: number; height: number } {
  const longest = Math.max(w, h)
  if (longest <= maxDim) return { width: w, height: h }
  const scale = maxDim / longest
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

async function base64ToBitmap(base64: string, mime: string): Promise<ImageBitmap> {
  const blob = await (await fetch(`data:${mime};base64,${base64}`)).blob()
  return createImageBitmap(blob)
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** Downscale a base64 PNG/JPEG to the budget and re-encode as JPEG dataURL. */
export async function budgetScreenshot(base64: string, mime: string, maxDim: number, quality = 0.8): Promise<string> {
  const bmp = await base64ToBitmap(base64, mime)
  const { width, height } = budgetTargetDims(bmp.width, bmp.height, maxDim)
  if (width === bmp.width && height === bmp.height && mime === 'image/png') {
    // under budget and already PNG — keep as-is to avoid needless re-encode
    return `data:${mime};base64,${base64}`
  }
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0, width, height)
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  const buf = new Uint8Array(await out.arrayBuffer())
  return `data:image/jpeg;base64,${bytesToBase64(buf)}`
}

/** Assemble base64 PNG frames into an animated GIF dataURL. Port of screenshot_gif.go. */
export async function encodeGif(frames: string[], mime = 'image/png', delayMs = 200): Promise<string> {
  const enc = GIFEncoder()
  for (const f of frames) {
    const bmp = await base64ToBitmap(f, mime)
    const canvas = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height)
    const palette = quantize(data, 256)
    const index = applyPalette(data, palette)
    enc.writeFrame(index, width, height, { palette, delay: delayMs })
  }
  enc.finish()
  return `data:image/gif;base64,${bytesToBase64(enc.bytes())}`
}
