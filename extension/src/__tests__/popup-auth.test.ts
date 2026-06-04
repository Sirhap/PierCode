import { describe, expect, it } from 'vitest'
import { normalizeAuthUrl } from '../popup/App'

describe('normalizeAuthUrl', () => {
  it('parses a full auth URL with token query param', () => {
    const { baseUrl, token, port } = normalizeAuthUrl('http://127.0.0.1:39527/auth?token=abcdef0123456789')
    expect(baseUrl).toBe('http://127.0.0.1:39527')
    expect(token).toBe('abcdef0123456789')
    expect(port).toBe(39527)
  })

  it('trims surrounding whitespace', () => {
    const { token } = normalizeAuthUrl('   http://127.0.0.1:39527/auth?token=deadbeefdeadbeef   ')
    expect(token).toBe('deadbeefdeadbeef')
  })

  it('accepts a bare hex token and defaults to localhost:39527', () => {
    const hex = 'a'.repeat(64)
    const { baseUrl, token, port } = normalizeAuthUrl(hex)
    expect(baseUrl).toBe('http://127.0.0.1:39527')
    expect(token).toBe(hex)
    expect(port).toBe(39527)
  })

  it('falls back to default ports for http/https without explicit port', () => {
    expect(normalizeAuthUrl('http://example.com/auth?token=abcdef0123456789').port).toBe(80)
    expect(normalizeAuthUrl('https://example.com/auth?token=abcdef0123456789').port).toBe(443)
  })

  it('returns empty token when the URL has no token param', () => {
    const { token } = normalizeAuthUrl('http://127.0.0.1:39527/auth')
    expect(token).toBe('')
  })

  it('throws on input that is neither a URL nor a hex token', () => {
    expect(() => normalizeAuthUrl('not a url')).toThrow()
  })
})
