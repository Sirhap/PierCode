import { describe, it, expect } from 'vitest'
import { fuzzyFilter, type Command } from '../sidebar/commands'

const cmds: Command[] = [
  { id: 'new', title: '新对话', hint: 'new chat', run: () => {} },
  { id: 'clear', title: '清屏', hint: 'clear messages', run: () => {} },
  { id: 'plat-qwen', title: '切换到 Qwen', hint: 'platform', run: () => {} },
]

describe('fuzzyFilter', () => {
  it('returns all commands for an empty query', () => {
    expect(fuzzyFilter(cmds, '')).toHaveLength(3)
  })
  it('matches on title substring', () => {
    expect(fuzzyFilter(cmds, '清屏').map(c => c.id)).toEqual(['clear'])
  })
  it('matches on hint (case-insensitive)', () => {
    expect(fuzzyFilter(cmds, 'PLATFORM').map(c => c.id)).toEqual(['plat-qwen'])
  })
  it('matches subsequence across title', () => {
    // "qwen" appears in "切换到 Qwen" (case-insensitive)
    expect(fuzzyFilter(cmds, 'qwen').map(c => c.id)).toEqual(['plat-qwen'])
  })
  it('returns empty when nothing matches', () => {
    expect(fuzzyFilter(cmds, 'zzz')).toEqual([])
  })
})
