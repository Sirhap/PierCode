import { strings, getLang } from './i18n'

// Animated mock of the real in-page experience: a web AI chat where the
// assistant emits piercode-tool calls, PierCode renders approval cards (same
// look as the extension's renderToolCard in content/index.ts), the user
// approves, and results land back in the chat. A full multi-step task. Loops.

const t = (k: string) => strings[k]?.[getLang()] ?? k
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

type ToolSpec = {
  name: string
  id: string
  args: [string, string][]
  warn?: boolean // show the destructive-command warning banner
}

type Step = {
  ai: string // AI intro line (i18n key)
  tool: ToolSpec
  result: string // result line (i18n key)
}

const steps: Step[] = [
  { ai: 'chat.a1', result: 'chat.r1', tool: { name: 'grep', id: 'a3f9k', args: [['pattern', '"port", 8080'], ['path', 'cmd/']] } },
  { ai: 'chat.a2', result: 'chat.r2', tool: { name: 'read_file', id: 'b2k9n', args: [['path', 'cmd/server/main.go'], ['offset', '14'], ['limit', '8']] } },
  { ai: 'chat.a3', result: 'chat.r3', tool: { name: 'edit', id: 'c4f1h', args: [['path', 'cmd/server/main.go'], ['old_string', '8080'], ['new_string', '39527']], warn: true } },
  { ai: 'chat.a4', result: 'chat.r4', tool: { name: 'exec_cmd', id: 'd8j3m', args: [['command', 'go test ./...']] } },
]

function bubble(role: 'user' | 'ai', resultLike = false): HTMLElement {
  const el = document.createElement('div')
  el.className = `cb cb-${role}` + (resultLike ? ' cb-result' : '')
  return el
}

function toolCard(spec: ToolSpec): HTMLElement {
  const card = document.createElement('div')
  card.className = 'pc-card pc-enter'
  const args = spec.args
    .map(([k, v]) => `<div class="pc-arg"><span class="pc-k">${k}</span><div class="pc-v">${v}</div></div>`)
    .join('')
  const warn = spec.warn ? `<div class="pc-warn">${t('chat.warn')}</div>` : ''
  card.innerHTML = `
    <div class="pc-head">🔧 ${spec.name} <span class="pc-id">#${spec.id}</span></div>
    <div class="pc-args">${args}</div>
    ${warn}
    <div class="pc-btns">
      <button class="pc-run">${t('chat.approve')}</button>
      <button class="pc-bg">${t('chat.bg')}</button>
      <button class="pc-skip">${t('chat.skip')}</button>
    </div>`
  return card
}

async function typeInto(el: HTMLElement, text: string) {
  if (reduced) { el.textContent = text; return }
  el.textContent = ''
  for (let i = 0; i < text.length; i++) {
    el.textContent = text.slice(0, i + 1)
    await wait(18)
  }
}

function scrollEnd(root: HTMLElement) {
  root.scrollTop = root.scrollHeight
}

export async function runChatDemo(root: HTMLElement) {
  for (;;) {
    root.innerHTML = ''

    // Opening user request
    const u = bubble('user')
    root.appendChild(u)
    await typeInto(u, t('chat.u1'))
    await wait(450)

    for (const step of steps) {
      // AI intro line
      const ai = bubble('ai')
      root.appendChild(ai)
      await typeInto(ai, t(step.ai))
      scrollEnd(root)
      await wait(280)

      // Approval card slides in
      const card = toolCard(step.tool)
      root.appendChild(card)
      requestAnimationFrame(() => card.classList.add('pc-in'))
      scrollEnd(root)
      await wait(reduced ? 0 : 780)

      // Auto-approve
      const run = card.querySelector<HTMLElement>('.pc-run')!
      run.classList.add('pc-press')
      await wait(reduced ? 0 : 480)
      card.classList.add('pc-done')
      run.textContent = t('chat.badge')
      await wait(reduced ? 0 : 320)

      // Result bubble
      const res = bubble('ai', true)
      root.appendChild(res)
      await typeInto(res, t(step.result))
      scrollEnd(root)
      await wait(reduced ? 0 : 420)
    }

    // Final summary
    const done = bubble('ai', true)
    done.classList.add('cb-summary')
    root.appendChild(done)
    await typeInto(done, t('chat.done'))
    scrollEnd(root)

    if (reduced) return
    await wait(3800)
  }
}
