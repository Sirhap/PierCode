/**
 * Async sidebar spawn batches + idle injection (design: sidebar 子 agent 异步化).
 *
 * 1. A spawn-only assistant turn must END the main turn immediately (CHAT_DONE
 *    before any spawn result), so the sidebar input unlocks while the batch
 *    runs detached.
 * 2. The finished batch's summary is queued and injected as a NEW turn only
 *    when the main conversation is idle.
 * 3. A sub-agent that itself emits spawn_agent gets explicit rejection feedback
 *    (no more silent drop that cut its conversation short).
 *
 * Platform 'openai' is used because its auth comes from storage (no cookies)
 * and its chatId is a local UUID — no createConversation round-trip.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  handleChatRequest,
  resumeOrphanedSpawnBatches,
  __injectionStateForTest,
  __spawnBatchStateForTest,
} from '../background/chat-api'

let sessionData: Record<string, any>
let broadcasts: any[]

function installChromeStub() {
  sessionData = {}
  broadcasts = []
  ;(globalThis as any).chrome = {
    storage: {
      session: {
        get: async (key: string | string[] | null) => {
          if (key === null || key === undefined) return { ...sessionData }
          const keys = Array.isArray(key) ? key : [key]
          const out: Record<string, any> = {}
          for (const k of keys) if (k in sessionData) out[k] = sessionData[k]
          return out
        },
        set: async (obj: Record<string, any>) => {
          for (const [k, v] of Object.entries(obj)) sessionData[k] = JSON.parse(JSON.stringify(v))
        },
        remove: async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete sessionData[k]
        },
      },
      local: {
        // openai auth from storage; no apiUrl/authToken so execTool and the
        // worker-prompt fetch both short-circuit without network.
        get: async () => ({ openaiApiKey: 'k', openaiBaseUrl: 'http://api.test' }),
      },
    },
    runtime: {
      sendMessage: (msg: any) => { broadcasts.push(msg); return Promise.resolve() },
      getPlatformInfo: (cb?: () => void) => cb?.(),
      lastError: undefined,
    },
    tabs: { sendMessage: vi.fn(() => Promise.resolve()) },
    cookies: { get: async () => null },
  }
}

// One-shot SSE FetchLike with OpenAI delta framing.
function sseResponse(text: string, delayMs = 0) {
  const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`
  const bytes = new TextEncoder().encode(payload)
  let sent = false
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () => {
          if (delayMs) await new Promise(r => setTimeout(r, delayMs))
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: bytes }
        },
        releaseLock: () => {},
      }),
    },
  }
}

const SPAWN_FENCE =
  '派一个工人。\n```piercode-tool\n{"name":"spawn_agent","call_id":"sp1","args":{"label":"w","task":"统计文件"}}\n```'
const INLINE_SPAWN_FENCE =
  '我再派一个。\n```piercode-tool\n{"name":"spawn_agent","call_id":"sp2","args":{"label":"w2","task":"孙任务"}}\n```'

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise(r => setTimeout(r, 10))
  }
}

const types = () => broadcasts.map(b => b.type)

beforeEach(() => {
  installChromeStub()
  __spawnBatchStateForTest().reset()
  __injectionStateForTest().reset()
})

describe('async spawn batch (sidebar route)', () => {
  it('spawn-only turn ends with CHAT_DONE before the batch result; summary injects when idle', async () => {
    const bodies: string[] = []
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init?: any) => {
      bodies.push(String(init?.body || ''))
      call++
      if (call === 1) return sseResponse(SPAWN_FENCE) as any          // main turn
      if (call === 2) return sseResponse('工人完成：3 个文件', 30) as any // sub-agent
      return sseResponse('收到，已汇总。') as any                       // injected turn
    }))
    try {
      await handleChatRequest({
        platform: 'openai', message: '开工', chatId: 'c1', parentId: null, model: 'gpt-4o',
      })

      // Main turn over: CHAT_DONE broadcast, no spawn result yet.
      const doneAt = types().indexOf('CHAT_DONE')
      expect(doneAt).toBeGreaterThanOrEqual(0)
      expect(types().slice(0, doneAt + 1)).not.toContain('CHAT_TOOL_DONE')

      // Batch finishes detached → per-result CHAT_TOOL_DONE → idle injection
      // (CHAT_CONTINUING + a fresh turn that streams the summary reply).
      await waitFor(() => types().filter(t => t === 'CHAT_DONE').length >= 2)

      const toolDoneAt = types().indexOf('CHAT_TOOL_DONE')
      const continuingAt = types().indexOf('CHAT_CONTINUING')
      expect(toolDoneAt).toBeGreaterThan(doneAt)
      expect(continuingAt).toBeGreaterThan(toolDoneAt)
      const spawnResult = broadcasts[toolDoneAt].result
      expect(spawnResult.call_id).toBe('sp1')
      expect(spawnResult.output).toContain('工人完成')

      // Injected turn carried the formatted batch summary.
      expect(bodies[2]).toContain('sp1')
      expect(bodies[2]).toContain('工人完成')
      expect(__injectionStateForTest().queue).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a sub-agent emitting spawn_agent gets rejection feedback instead of a silent drop', async () => {
    const bodies: string[] = []
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init?: any) => {
      bodies.push(String(init?.body || ''))
      call++
      if (call === 1) return sseResponse(SPAWN_FENCE) as any        // main turn
      if (call === 2) return sseResponse(INLINE_SPAWN_FENCE) as any // sub-agent tries to nest
      return sseResponse('好的，我自己完成了。') as any                 // sub-agent finishes / injection
    }))
    try {
      await handleChatRequest({
        platform: 'openai', message: '开工', chatId: 'c1', parentId: null, model: 'gpt-4o',
      })
      await waitFor(() => bodies.length >= 3)

      // The sub-agent's next message is the rejection tool result, so the
      // conversation continues to a normal finish instead of breaking.
      expect(bodies[2]).toContain('嵌套边界')
      expect(bodies[2]).toContain('sp2')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('injection queue idle gating', () => {
  it('does not inject while a main turn is in flight; drains when idle', async () => {
    const st = __injectionStateForTest()
    st.setMainContext({ platform: 'openai', chatId: 'c9', parentId: 'p9', model: 'gpt-4o' })
    st.queue.push({ message: '汇总', ctx: { platform: 'openai', chatId: 'c9', parentId: 'p9' } })

    st.setTurnDepth(1)
    st.drain()
    expect(st.queue).toHaveLength(1)
    expect(types()).not.toContain('CHAT_CONTINUING')

    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('继续') as any))
    try {
      st.setTurnDepth(0)
      st.drain()
      expect(st.queue).toHaveLength(0)
      expect(types()).toContain('CHAT_CONTINUING')
      await waitFor(() => types().includes('CHAT_DONE'))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('SW-restart recovery of an uninjected finished batch', () => {
  it('re-queues the summary from the persisted record (emit-once)', async () => {
    sessionData['spawnBatch:sb1'] = {
      batchKey: 'sb1',
      batchId: 'b1',
      platform: 'openai',
      depth: 0,
      createdAt: Date.now(),
      done: true,
      injected: false,
      inject: { platform: 'openai', chatId: 'c5', parentId: 'p5', model: 'gpt-4o' },
      agents: [{
        call: { name: 'spawn_agent', args: { label: 'w', task: 't' }, call_id: 'sp9' },
        agentId: 'a9',
        status: 'done',
        result: { call_id: 'sp9', name: 'spawn_agent', output: '早就完成了', success: true },
      }],
    }

    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('继续') as any))
    try {
      await resumeOrphanedSpawnBatches()
      await waitFor(() => types().includes('CHAT_CONTINUING'))
      expect(sessionData['spawnBatch:sb1'].injected).toBe(true)

      // Second resume must not re-inject (emit-once across restarts).
      broadcasts = []
      await resumeOrphanedSpawnBatches()
      await new Promise(r => setTimeout(r, 50))
      expect(types()).not.toContain('CHAT_CONTINUING')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
