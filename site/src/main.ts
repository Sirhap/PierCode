import './styles/main.css'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { featureTools, platforms } from './data'
import { runTerminal } from './terminal'
import { runChatDemo } from './chatdemo'
import { applyLang, getLang, setLang } from './i18n'

gsap.registerPlugin(ScrollTrigger)

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const isMobile = matchMedia('(max-width: 900px)').matches

// ── Render data-driven sections ──────────────────────────
// Cards carry data-i18n keys on title/desc so applyLang() localizes them; the
// mono tool name stays literal (API names are not translated).
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
        <span class="dot" style="background:${p.color};box-shadow:0 0 12px ${p.color}88"></span>
        ${p.name}
      </div>`,
    )
    .join('')
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
      start: 'top 88%',
      once: true,
      onEnter: () => el.classList.add('in'),
    })
  })
}

// ── Lazy 3D background ───────────────────────────────────
function initBackground() {
  if (reduced || isMobile) return // CSS static grid is the fallback
  const canvas = document.getElementById('bg-grid') as HTMLCanvasElement | null
  if (!canvas) return
  const start = () =>
    import('./scenes/grid').then((m) => m.initGrid(canvas)).catch(() => {})
  if ('requestIdleCallback' in window) (window as any).requestIdleCallback(start)
  else setTimeout(start, 600)
}

// ── Boot ─────────────────────────────────────────────────
renderFeatures()
renderPlatforms()
applyLang(getLang()) // localize static + freshly-rendered nodes; default zh
initReveals()
initBackground()

const toggle = document.getElementById('lang-toggle')
if (toggle) {
  toggle.addEventListener('click', () => {
    setLang(getLang() === 'zh' ? 'en' : 'zh')
  })
}

const term = document.getElementById('term-body')
if (term) runTerminal(term)

const chat = document.getElementById('chat-body')
if (chat) runChatDemo(chat)
