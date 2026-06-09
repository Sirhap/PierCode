// Lightweight CRT background: sparse falling-character "rain" (Catppuccin
// blue) over a faint grid, throttled to ~24fps. Replaces the old Three.js
// grid scene. Skipped on mobile / reduced-motion (the CSS grid + scanlines
// are the fallback).

const GLYPHS = 'read_file edit exec_cmd grep glob browser_* spawn_agent 0123456789abcdef ▸ ✓ → ░▒'.replace(/\s+/g, '')

interface Drop {
  x: number
  y: number
  speed: number
  glyph: string
  trail: number
}

export function initCRT(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  let w = 0
  let h = 0
  let cols = 0
  const cell = 18
  let drops: Drop[] = []

  function rnd(n: number): number {
    return Math.floor(Math.random() * n)
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = canvas.clientWidth
    h = canvas.clientHeight
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    cols = Math.floor(w / cell)
    // sparse: only ~1 in 4 columns has an active drop
    const target = Math.max(6, Math.floor(cols / 4))
    drops = Array.from({ length: target }, () => ({
      x: rnd(cols) * cell,
      y: rnd(Math.floor(h / cell)) * cell,
      speed: 0.6 + Math.random() * 1.4,
      glyph: GLYPHS[rnd(GLYPHS.length)],
      trail: 4 + rnd(8),
    }))
  }

  function frame() {
    ctx!.clearRect(0, 0, w, h)
    ctx!.font = `${cell - 4}px "JetBrains Mono", monospace`
    ctx!.textBaseline = 'top'

    for (const d of drops) {
      // fading trail above the head
      for (let i = d.trail; i >= 0; i--) {
        const yy = d.y - i * cell
        if (yy < -cell || yy > h) continue
        const a = i === 0 ? 0.7 : (1 - i / d.trail) * 0.22
        ctx!.fillStyle = `rgba(91, 140, 255, ${a})`
        const g = i === 0 ? d.glyph : GLYPHS[rnd(GLYPHS.length)]
        ctx!.fillText(g, d.x, yy)
      }
      d.y += d.speed * cell * 0.5
      if (d.y - d.trail * cell > h) {
        d.y = -cell
        d.x = rnd(cols) * cell
        d.glyph = GLYPHS[rnd(GLYPHS.length)]
        d.speed = 0.6 + Math.random() * 1.4
      }
    }
  }

  resize()

  // Debounce resize: it reallocates the drop array, so coalesce rapid
  // window-drag events into one rebuild.
  let resizeTimer = 0
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(resize, 150)
  })

  // throttle to ~24fps
  let last = 0
  function loop(t: number) {
    requestAnimationFrame(loop)
    if (t - last < 42) return
    last = t
    frame()
  }
  requestAnimationFrame(loop)
}
