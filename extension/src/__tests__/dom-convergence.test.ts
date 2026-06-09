import { describe, it, expect } from 'vitest'
import { FENCE_RE } from '../parser'
import { isBalancedJson } from '../content/json-complete'

describe('FENCE_RE tolerates trailing whitespace before closing fence', () => {
  it('matches a fence with spaces/newline before ```', () => {
    const content = '```piercode-tool\n{"name":"a","args":{}}  \n  ```'
    FENCE_RE.lastIndex = 0
    const m = FENCE_RE.exec(content)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('"name":"a"')
  })
})

describe('isBalancedJson', () => {
  it('true for complete object', () => {
    expect(isBalancedJson('{"name":"a","args":{"x":1}}')).toBe(true)
  })
  it('false for truncated object', () => {
    expect(isBalancedJson('{"name":"a","args":{"x":1}')).toBe(false)
  })
  it('ignores braces inside strings', () => {
    expect(isBalancedJson('{"text":"a}b{c"}')).toBe(true)
  })
  it('false for trailing-brace-in-string only', () => {
    expect(isBalancedJson('{"text":"value}')).toBe(false)
  })
})
