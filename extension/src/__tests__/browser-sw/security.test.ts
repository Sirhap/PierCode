import { describe, it, expect } from 'vitest'
import { SecurityPolicy, registrableDomain, sameRegistrableHost, checkNavigate, isAIPage } from '../../background/browser/security'

describe('security port', () => {
  it('registrableDomain: eTLD+1, IP verbatim, single-label fallback', () => {
    expect(registrableDomain('https://www.example.co.uk/x')).toEqual(['example.co.uk', true])
    expect(registrableDomain('http://127.0.0.1:8080')).toEqual(['127.0.0.1', true])
    expect(registrableDomain('http://localhost:3000')).toEqual(['localhost', true])
    expect(registrableDomain('not a url')[1]).toBe(false)
  })
  it('sameRegistrableHost: in-site redirect same, cross-site different', () => {
    expect(sameRegistrableHost('https://www.x.com/a', 'https://x.com/b')).toBe(true)
    expect(sameRegistrableHost('https://x.com', 'https://evil.com')).toBe(false)
    expect(sameRegistrableHost('', '')).toBe(true)
  })
  it('checkNavigate: only http/https/about:blank', () => {
    expect(checkNavigate('https://x.com')).toBeNull()
    expect(checkNavigate('about:blank')).toBeNull()
    expect(checkNavigate('')).toBeNull()
    expect(checkNavigate('file:///etc/passwd')).toBeTruthy()
    expect(checkNavigate('javascript:alert(1)')).toBeTruthy()
  })
  it('isAIPage: exact host + subdomain suffix', () => {
    expect(isAIPage('https://chatgpt.com/c/1')).toBe(true)
    expect(isAIPage('https://foo.qwen.ai/')).toBe(true)
    expect(isAIPage('https://example.com/')).toBe(false)
  })
  it('isSensitive: host pattern, path keyword, CN keyword, override', () => {
    const p = new SecurityPolicy()
    expect(p.isSensitive({ tabId: 1, url: 'https://mybank.com/', title: '' })).toBe(true)
    expect(p.isSensitive({ tabId: 1, url: 'https://shop.com/checkout', title: '' })).toBe(true)
    expect(p.isSensitive({ tabId: 1, url: 'https://shop.com/x', title: '支付页面' })).toBe(true)
    expect(p.isSensitive({ tabId: 1, url: 'https://docs.dev/payment-api', title: '' })).toBe(true)
    p.allowSensitiveHost('https://docs.dev/')
    expect(p.isSensitive({ tabId: 1, url: 'https://docs.dev/payment-api', title: '' })).toBe(false)
  })
})
