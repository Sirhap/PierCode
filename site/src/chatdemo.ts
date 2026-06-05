import { strings, getLang } from './i18n'

// Animated mock of the in-page experience: a web AI chat where the assistant
// emits a piercode-tool block, PierCode renders an approval card (same look as
// the real extension card in content/index.ts), the user approves, and the
// result lands back in the chat. Loops.

const t = (k: string) => strings[k]?.[getLang()] ?? k
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

function bubble(role: 'user' | 'ai', html: string): HTMLElement {
  const el = document.createElement('div')
  el.className = `cb cb-${role}`
  el.innerHTML = html
  return el
}

// Approval card markup mirroring the extension's renderToolCard styling.
function toolCard(): HTMLElement {
  const card = document.createElement('div')
  card.className = 'pc-card'
  card.innerHTML = `
    <div class="pc-head">🔧 read_file <span class="pc-id">#a3f9k</span></div>
    <div class="pc-args">
      <div class="pc-arg"><span class="pc-k">path</span><div class="pc-v">cmd/server/main.go</div></div>
    </div>
    <div class="pc-btns">
      <button class="pc-run" data-i18n="chat.approve">${t('chat.approve')}</button>
      <button class="pc-bg" data-i18n="chat.bg">${t('chat.bg')}</button>
      <button class="pc-skip" data-i18n="chat.skip">${t('chat.skip')}</button>
    </div>`
  return card
}

async function typeInto(el: HTMLElement, text: string) {
  if (reduced) { el.textContent = text; return }
  el.textContent = ''
  for (let i = 0; i < text.length; i++) {
    el.textContent = text.slice(0, i + 1)
    await wait(22)
  }
}

export async function runChatDemo(root: HTMLElement) {
  for (;;) {
    root.innerHTML = ''

    // 1. user message
    const u = bubble('user', '')
    root.appendChild(u)
    await typeInto(u, t('chat.usermsg'))
    await wait(500)

    // 2. AI message
    const ai = bubble('ai', '')
    root.appendChild(ai)
    await typeInto(ai, t('chat.aimsg'))
    await wait(400)

    // 3. approval card slides in
    const card = toolCard()
    card.classList.add('pc-enter')
    root.appendChild(card)
    requestAnimationFrame(() => card.classList.add('pc-in'))
    await wait(900)

    // 4. auto-approve: highlight the Run button, then "click"
    const run = card.querySelector<HTMLElement>('.pc-run')!
    run.classList.add('pc-press')
    await wait(550)
    card.classList.add('pc-done')
    run.textContent = t('chat.badge')

    // 5. result bubble back in chat
    await wait(450)
    const res = bubble('ai', '')
    res.classList.add('cb-result')
    root.appendChild(res)
    await typeInto(res, t('chat.result'))

    if (reduced) return // one static pass for reduced-motion
    await wait(3200)
  }
}
