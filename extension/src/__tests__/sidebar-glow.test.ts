import { describe, it, expect } from 'vitest'
import { GLOW_COLORS, isGlow, normalizeGlow, type Glow } from '../sidebar/glow'

describe('glow helpers', () => {
  it('lists exactly the four supported glow colors', () => {
    expect(GLOW_COLORS.map(g => g.key)).toEqual(['cyan', 'green', 'amber', 'magenta'])
  })

  it('isGlow accepts valid keys and rejects others', () => {
    expect(isGlow('green')).toBe(true)
    expect(isGlow('magenta')).toBe(true)
    expect(isGlow('purple')).toBe(false)
    expect(isGlow(undefined)).toBe(false)
    expect(isGlow(42)).toBe(false)
  })

  it('normalizeGlow falls back to cyan for invalid input', () => {
    expect(normalizeGlow('green')).toBe<Glow>('green')
    expect(normalizeGlow('nope')).toBe<Glow>('cyan')
    expect(normalizeGlow(null)).toBe<Glow>('cyan')
  })

  it('every glow color has a hex swatch for the picker UI', () => {
    for (const g of GLOW_COLORS) {
      expect(g.hex).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })
})
