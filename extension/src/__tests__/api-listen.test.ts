import { describe, it, expect, vi } from 'vitest'
import { makeStreamingFetchLike, consumeListenStream } from '../background/api-listen'

// Build a qwen-shaped SSE byte stream: response.created (pins primary branch) +
// answer-phase content deltas. Mirrors what page-bridge tees off the page's own
// /api/v2/chat/completions response.
function qwenSSE(lines: object[]): Uint8Array[] {
  const enc = new TextEncoder()
  return lines.map(obj => enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
}

function feed(stream: ReturnType<typeof makeStreamingFetchLike>, frames: Uint8Array[]) {
  for (const f of frames) stream.enqueue(f)
  stream.close()
}

describe('makeStreamingFetchLike', () => {
  it('replays chunks that arrived before getReader was called', async () => {
    const s = makeStreamingFetchLike(true, 200)
    const enc = new TextEncoder()
    s.enqueue(enc.encode('a'))
    s.enqueue(enc.encode('b'))
    s.close()
    const reader = s.fetchLike.body!.getReader()
    const dec = new TextDecoder()
    let out = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out += dec.decode(value)
    }
    expect(out).toBe('ab')
  })
})

describe('consumeListenStream (qwen)', () => {
  it('extracts assistant content from a teed qwen SSE stream', async () => {
    const s = makeStreamingFetchLike(true, 200)
    const frames = qwenSSE([
      { 'response.created': { response_id: 'r0', response_index: '0' } },
      { response_id: 'r0', choices: [{ delta: { phase: 'answer', content: 'Hello ' } }] },
      { response_id: 'r0', choices: [{ delta: { phase: 'answer', content: 'world' } }] },
    ])
    const broadcasts: Array<Record<string, unknown>> = []
    const p = consumeListenStream('qwen', s.fetchLike, m => broadcasts.push(m))
    feed(s, frames)
    const result = await p

    expect(result?.content).toBe('Hello world')
    const streams = broadcasts.filter(b => b.type === 'CHAT_STREAM').map(b => b.chunk)
    expect(streams).toEqual(['Hello ', 'world'])
  })

  it('surfaces a piercode-tool fence in the answer stream as CHAT_TOOLS', async () => {
    const s = makeStreamingFetchLike(true, 200)
    const fence = '```piercode-tool\n{"name":"read_file","args":{"path":"a.txt"}}\n```'
    const frames = qwenSSE([
      { 'response.created': { response_id: 'r0', response_index: '0' } },
      { response_id: 'r0', choices: [{ delta: { phase: 'answer', content: 'reading\n' } }] },
      { response_id: 'r0', choices: [{ delta: { phase: 'answer', content: fence } }] },
    ])
    const broadcasts: Array<Record<string, unknown>> = []
    const p = consumeListenStream('qwen', s.fetchLike, m => broadcasts.push(m))
    feed(s, frames)
    await p

    const toolMsg = broadcasts.find(b => b.type === 'CHAT_TOOLS') as { tools: Array<{ name: string; args: Record<string, unknown> }> } | undefined
    expect(toolMsg).toBeTruthy()
    expect(toolMsg!.tools).toHaveLength(1)
    expect(toolMsg!.tools[0].name).toBe('read_file')
    expect(toolMsg!.tools[0].args).toEqual({ path: 'a.txt' })
  })

  it('drops deltas from a parallel (non-primary) qwen branch', async () => {
    const s = makeStreamingFetchLike(true, 200)
    const frames = qwenSSE([
      { 'response.created': { response_id: 'r0', response_index: '0' } },
      { 'response.created': { response_id: 'r1', response_index: '1' } },
      { response_id: 'r1', choices: [{ delta: { phase: 'answer', content: 'GHOST' } }] },
      { response_id: 'r0', choices: [{ delta: { phase: 'answer', content: 'real' } }] },
    ])
    const broadcasts: Array<Record<string, unknown>> = []
    const p = consumeListenStream('qwen', s.fetchLike, m => broadcasts.push(m))
    feed(s, frames)
    const result = await p

    expect(result?.content).toBe('real')
  })

  it('broadcasts CHAT_ERROR for an unknown platform', async () => {
    const s = makeStreamingFetchLike(true, 200)
    const broadcast = vi.fn()
    const result = await consumeListenStream('nope', s.fetchLike, broadcast)
    expect(result).toBeNull()
    expect(broadcast).toHaveBeenCalledWith({ type: 'CHAT_ERROR', error: '未知平台: nope' })
  })
})
