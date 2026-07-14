// 1:1 port of internal/browser/security.go. registrableDomain uses tldts.
import { getDomain } from 'tldts'
import type { BrowserTab } from './types'

const AI_PAGE_HOSTS = [
  'gemini.google.com', 'aistudio.google.com', 'qwen.ai', 'qwenlm.ai',
  'chat.z.ai', 'kimi.com', 'claude.ai', 'free.easychat.top',
  'aistudio.xiaomimimo.com', 'chatgpt.com', 'chat.openai.com',
  'ultraspeed.xiaomimimo.com',
]
const SENSITIVE_HOST_PATTERNS = ['bank', 'alipay', 'paypal']
const SENSITIVE_PATH_KEYWORDS = [
  '/payment', '/checkout', '/finance', '/wallet', '/transfer',
  'payment', 'checkout', '付款', '支付', '转账', '结账',
]

function hostnameOf(raw: string): string | null {
  try { return new URL(raw.trim()).hostname.toLowerCase() } catch { return null }
}
function isIPLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') /* ipv6 */
}

export function registrableDomain(raw: string): [string, boolean] {
  let host: string
  try { host = new URL(raw.trim()).hostname.toLowerCase() } catch { return ['', false] }
  if (!host) return ['', false]
  if (isIPLiteral(host)) return [host, true]
  const d = getDomain(host)
  if (!d) return [host, true]   // single-label (localhost) fallback
  return [d, true]
}

export function sameRegistrableHost(a: string, b: string): boolean {
  a = a.trim(); b = b.trim()
  if (a === b) return true
  const [ra, oka] = registrableDomain(a)
  const [rb, okb] = registrableDomain(b)
  if (!oka || !okb) return false
  return ra === rb
}

export function originOf(raw: string): string {
  try {
    const u = new URL(raw.trim())
    if (!u.protocol || !u.host) return ''
    return `${u.protocol}//${u.host}`.toLowerCase()
  } catch { return '' }
}

/** Returns an error message string, or null if navigation is allowed. */
export function checkNavigate(raw: string): string | null {
  raw = raw.trim()
  if (raw === '' || raw === 'about:blank') return null
  let scheme: string
  try { scheme = new URL(raw).protocol.replace(/:$/, '').toLowerCase() } catch { return 'invalid URL' }
  if (scheme === 'http' || scheme === 'https') return null
  return 'browser navigation only supports http, https, and about:blank URLs'
}

export function isAIPage(raw: string): boolean {
  const host = hostnameOf(raw)
  if (!host) return false
  return AI_PAGE_HOSTS.some(h => host === h || host.endsWith('.' + h))
}

export class SecurityPolicy {
  private sensitiveAllow = new Set<string>()

  allowSensitiveHost(hostOrURL: string): void {
    let [d, ok] = registrableDomain(hostOrURL)
    if (!ok) d = hostOrURL.trim().toLowerCase()
    if (d) this.sensitiveAllow.add(d)
  }
  private isSensitiveAllowed(rawURL: string): boolean {
    const [d, ok] = registrableDomain(rawURL)
    return ok && this.sensitiveAllow.has(d)
  }
  isSensitive(tab: BrowserTab): boolean {
    if (this.isSensitiveAllowed(tab.url)) return false
    const host = hostnameOf(tab.url)
    if (host && SENSITIVE_HOST_PATTERNS.some(p => host.includes(p))) return true
    const text = `${tab.url} ${tab.title}`.toLowerCase()
    return SENSITIVE_PATH_KEYWORDS.some(k => text.includes(k))
  }
}
