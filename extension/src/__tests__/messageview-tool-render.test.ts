import { describe, it, expect } from 'vitest'
import { stripToolBlocks, parsePartialToolCalls } from '../sidebar/MessageView'

const CLOSED = '前言\n```piercode-tool\n{"name":"read_file","call_id":"a1","args":{"path":"x.ts"}}\n```\n后文'
const OPEN = '前言\n```piercode-tool\n{"name":"read_file","call_id":"a1","args":{"path":"x.ts"}}'   // still streaming, no closing fence
const OPEN_PARTIAL = '前言\n```piercode-tool\n{"name":"exec_cmd","call_id":"b2","args":{"command":"ls -'  // mid-stream, truncated JSON

describe('stripToolBlocks', () => {
  it('removes a completed tool fence', () => {
    expect(stripToolBlocks(CLOSED)).toBe('前言\n\n后文')
  })

  it('removes a still-streaming (unclosed) tool fence so raw JSON never shows', () => {
    expect(stripToolBlocks(OPEN)).toBe('前言')
  })

  it('removes a truncated mid-stream fence', () => {
    expect(stripToolBlocks(OPEN_PARTIAL)).toBe('前言')
  })

  it('leaves text without a fence untouched', () => {
    expect(stripToolBlocks('plain text')).toBe('plain text')
  })
})

describe('parsePartialToolCalls', () => {
  it('parses a completed fence', () => {
    const calls = parsePartialToolCalls(CLOSED)
    expect(calls).toEqual([{ name: 'read_file', call_id: 'a1', args: { path: 'x.ts' } }])
  })

  it('parses an unclosed but complete-JSON fence (placeholder card)', () => {
    const calls = parsePartialToolCalls(OPEN)
    expect(calls).toEqual([{ name: 'read_file', call_id: 'a1', args: { path: 'x.ts' } }])
  })

  it('returns [] for a truncated JSON tail (no card yet, falls back to hide-only)', () => {
    expect(parsePartialToolCalls(OPEN_PARTIAL)).toEqual([])
  })

  it('returns [] when no fence present', () => {
    expect(parsePartialToolCalls('just talking')).toEqual([])
  })

  it('defaults call_id/args when the JSON omits them', () => {
    const calls = parsePartialToolCalls('```piercode-tool\n{"name":"list_dir"}\n```')
    expect(calls).toEqual([{ name: 'list_dir', call_id: '', args: {} }])
  })
})
