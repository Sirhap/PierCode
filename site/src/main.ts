import './styles/main.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/jetbrains-mono/800.css'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { coreCapabilities, featureTools, platforms } from './data'
import { runChatDemo } from './chatdemo'
import { applyLang, getLang, setLang, strings, type Lang } from './i18n'
import { runBoot } from './boot'

gsap.registerPlugin(ScrollTrigger)

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const isMobile = matchMedia('(max-width: 900px)').matches

// ── Render data-driven sections ──────────────────────────
// Cards carry data-i18n keys on title/desc so applyLang() localizes them; the
// mono tool name / capability tag stays literal.
function renderCoreCapabilities() {
  const root = document.getElementById('core-cards')
  if (!root) return
  root.innerHTML = coreCapabilities
    .map(
      (cap) => `
      <div class="core-card reveal">
        <div class="core-icon">${cap.icon}</div>
        <h3 data-i18n="${cap.i18nKey}t"></h3>
        <p data-i18n="${cap.i18nKey}d"></p>
        <div class="core-highlight" data-i18n="${cap.i18nKey}h"></div>
      </div>`,
    )
    .join('')
}

function renderFeatures() {
  const root = document.getElementById('feature-cards')
  if (!root) return
  root.innerHTML = featureTools
    .map(
      (tool, i) => `
      <div class="card reveal">
        <div class="card-tool">${tool}</div>
        <h3 data-i18n="feat.${i + 1}t"></h3>
        <p data-i18n="feat.${i + 1}d"></p>
      </div>`,
    )
    .join('')
}

function renderPlatforms() {
  const root = document.getElementById('platform-wall')
  if (!root) return
  root.innerHTML = platforms
    .map(
      (p) => `
      <div class="platform reveal">
        <span class="dot" style="background:${p.color};box-shadow:0 0 10px ${p.color}99"></span>
        <span class="pname">${p.name}</span>
        <span class="pstat">${p.status}</span>
      </div>`,
    )
    .join('')
}

// ── Hero title typewriter (re-typed on language switch) ──
let typeToken = 0
async function typeHeroTitle(lang: Lang) {
  const h1 = document.getElementById('hero-h1') as HTMLElement | null
  if (!h1) return
  const text = (lang === 'zh' ? h1.dataset.typeZh : h1.dataset.typeEn) || ''
  const token = ++typeToken
  if (reduced) {
    h1.innerHTML = `${text}<span class="type-cursor"></span>`
    return
  }
  h1.innerHTML = '<span class="t-text"></span><span class="type-cursor"></span>'
  const span = h1.querySelector<HTMLElement>('.t-text')
  if (!span) return
  for (let i = 0; i < text.length; i++) {
    if (token !== typeToken) return // a newer type pass superseded this one
    span.textContent = text.slice(0, i + 1)
    await new Promise((r) => setTimeout(r, 42))
  }
}

// ── Scroll reveals ───────────────────────────────────────
function initReveals() {
  if (reduced) {
    document.querySelectorAll('.reveal').forEach((el) => el.classList.add('in'))
    return
  }
  document.querySelectorAll<HTMLElement>('.reveal').forEach((el) => {
    ScrollTrigger.create({
      trigger: el,
      start: 'top 90%',
      once: true,
      onEnter: () => el.classList.add('in'),
    })
  })
}

// ── CRT background canvas ────────────────────────────────
function initBackground() {
  if (reduced || isMobile) return // CSS grid + scanlines are the fallback
  const canvas = document.getElementById('crt-canvas') as HTMLCanvasElement | null
  if (!canvas) return
  const start = () =>
    import('./crt').then((m) => m.initCRT(canvas)).catch(() => {})
  if ('requestIdleCallback' in window) (window as any).requestIdleCallback(start)
  else setTimeout(start, 400)
}

// ── Copy-to-clipboard command blocks ─────────────────────
function initCopyButtons() {
  document.querySelectorAll<HTMLButtonElement>('.copy-cmd').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cmd = btn.dataset.copy || ''
      const hint = btn.querySelector<HTMLElement>('.copy-hint')
      try {
        await navigator.clipboard.writeText(cmd)
      } catch {
        // clipboard unavailable — select the text as a fallback, no error
        const sel = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(btn)
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
      btn.classList.add('copied')
      if (hint) hint.textContent = strings['start.copied'][getLang()]
      setTimeout(() => {
        btn.classList.remove('copied')
        if (hint) hint.textContent = strings['start.copy'][getLang()]
      }, 1400)
    })
  })
}

// ── Boot, then bring the page to life ────────────────────
async function boot() {
  renderCoreCapabilities()
  renderFeatures()
  renderPlatforms()
  applyLang(getLang()) // localize static + freshly-rendered nodes; default zh
  initCopyButtons()

  await runBoot()

  initReveals()
  initBackground()
  typeHeroTitle(getLang())

  const chat = document.getElementById('chat-body')
  if (chat) runChatDemo(chat)

  const toggle = document.getElementById('lang-toggle')
  toggle?.addEventListener('click', () => {
    const next: Lang = getLang() === 'zh' ? 'en' : 'zh'
    setLang(next)
    typeHeroTitle(next)
  })
}

boot()
