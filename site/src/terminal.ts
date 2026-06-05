import { termScript, type TermSeg } from './data'

const TYPE_MS = 26
const LINE_PAUSE = 380

const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches

function renderAll(el: HTMLElement) {
  // Static, fully-typed render for reduced-motion / fallback.
  el.innerHTML = ''
  for (const line of termScript) {
    const div = document.createElement('div')
    for (const seg of line) {
      const span = document.createElement('span')
      if (seg.c) span.className = seg.c
      span.textContent = seg.t
      div.appendChild(span)
    }
    el.appendChild(div)
  }
}

function appendSeg(line: HTMLElement, seg: TermSeg, cursor: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const span = document.createElement('span')
    if (seg.c) span.className = seg.c
    line.insertBefore(span, cursor)
    let i = 0
    const tick = () => {
      span.textContent = seg.t.slice(0, ++i)
      if (i < seg.t.length) setTimeout(tick, TYPE_MS)
      else resolve()
    }
    tick()
  })
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Types the terminal script line by line, looping forever. */
export async function runTerminal(el: HTMLElement) {
  if (prefersReduced) { renderAll(el); return }

  const cursor = document.createElement('span')
  cursor.className = 'cursor'

  for (;;) {
    el.innerHTML = ''
    for (const line of termScript) {
      const div = document.createElement('div')
      div.appendChild(cursor)
      el.appendChild(div)
      for (const seg of line) await appendSeg(div, seg, cursor)
      el.scrollTop = el.scrollHeight
      await wait(LINE_PAUSE)
    }
    await wait(2200)
  }
}
