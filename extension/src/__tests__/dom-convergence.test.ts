import { describe, it, expect } from 'vitest'
import { FENCE_RE } from '../parser'

describe('FENCE_RE tolerates trailing whitespace before closing fence', () => {
  it('matches a fence with spaces/newline before ```', () => {
    const content = '```piercode-tool\n{"name":"a","args":{}}  \n  ```'
    FENCE_RE.lastIndex = 0
    const m = FENCE_RE.exec(content)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('"name":"a"')
  })
})
