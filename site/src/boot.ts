// CRT boot sequence — prints a short power-on log line-by-line, then "powers
// on" the page (flash + fade-out). Runs at most once per browser session
// (sessionStorage), and is skipped entirely under prefers-reduced-motion.

const SEEN_KEY = 'piercode-booted'

// English boot log — terminal logs read as English regardless of UI language.
const LINES: { label?: string; text: string; arg?: string }[] = [
  { text: 'PierCode v2 · local AI bridge' },
  { label: 'OK', text: 'mounting workspace sandbox' },
  { label: 'OK', text: 'binding ', arg: '127.0.0.1:39527' },
  { label: 'OK', text: 'loading tool registry ', arg: '(read_file · edit · exec_cmd · browser_*)' },
  { label: 'OK', text: 'extension relay ready' },
]

function lineHTML(l: { label?: string; text: string; arg?: string }): string {
  const ok = l.label ? `<span class="ok">[ ${l.label} ]</span> ` : ''
  const arg = l.arg ? `<span class="arg">${l.arg}</span>` : ''
  return `${ok}<span class="lbl">${l.text}</span>${arg}`
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Runs the boot animation; resolves when the overlay is gone. Resolves
// immediately (and reveals the page) when skipped.
export async function runBoot(): Promise<void> {
  const boot = document.getElementById('boot')
  const screen = document.getElementById('boot-screen')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const seen = sessionStorage.getItem(SEEN_KEY) === '1'

  if (!boot || !screen || reduced || seen) {
    if (boot) boot.classList.add('gone')
    return
  }
  sessionStorage.setItem(SEEN_KEY, '1')

  // Print lines one at a time.
  const rows: string[] = []
  for (const l of LINES) {
    rows.push(`<div class="boot-line">${lineHTML(l)}</div>`)
    screen.innerHTML =
      rows.join('') + '<div class="boot-line"><span class="boot-cursor"></span></div>'
    await wait(170)
  }
  // Final "ready" line then a beat.
  rows.push(
    `<div class="boot-line"><span class="ok">▸</span> <span class="lbl">session ready</span><span class="boot-cursor"></span></div>`,
  )
  screen.innerHTML = rows.join('')
  await wait(320)

  // Power-on flash, then fade out.
  boot.classList.add('flash')
  await wait(90)
  boot.classList.remove('flash')
  boot.classList.add('gone')
  await wait(500)
}
