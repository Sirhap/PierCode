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

  it('spawn at deep TOOL recursion is not rejected as agent nesting (depth conflation)', async () => {
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++
      if (call === 1) return sseResponse(SPAWN_FENCE) as any
      return sseResponse('工人完成') as any
    }))
    try {
      // depth 5 = the main conversation already ran 5 tool turns. The spawner
      // is still nesting level 0 — the batch must run, not be refused.
      await handleChatRequest({
        platform: 'openai', message: '继续', chatId: 'c1', parentId: null, model: 'gpt-4o', depth: 5,
      })
      await waitFor(() => types().includes('CHAT_TOOL_DONE'))
      const result = broadcasts.find(b => b.type === 'CHAT_TOOL_DONE').result
      expect(result.output).not.toContain('嵌套超过上限')
      expect(result.output).toContain('工人完成')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a sub-agent emitting question gets rejection feedback instead of hanging on /exec', async () => {
    const bodies: string[] = []
    let call = 0
    const QUESTION_FENCE =
      '```piercode-tool\n{"name":"question","call_id":"q1","args":{"question":"用哪个目录?"}}\n```'
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init?: any) => {
      bodies.push(String(init?.body || ''))
      call++
      if (call === 1) return sseResponse(SPAWN_FENCE) as any     // main turn
      if (call === 2) return sseResponse(QUESTION_FENCE) as any  // sub-agent asks
      return sseResponse('已自行决策完成。') as any                  // sub-agent finishes / injection
    }))
    try {
      await handleChatRequest({
        platform: 'openai', message: '开工', chatId: 'c1', parentId: null, model: 'gpt-4o',
      })
      await waitFor(() => bodies.length >= 3)
      expect(bodies[2]).toContain('无法向用户提问')
      expect(bodies[2]).toContain('q1')
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

describe('injection queue concurrent-drain race (#5)', () => {
  it('a second drain during the first injection’s storage-await does NOT drain concurrently', async () => {
    // Reproduces the fixed race: handleChatRequest bumps mainTurnDepth, but the
    // master-switch read `await chrome.storage.local.get(['extensionEnabled'])`
    // sits at the top. If the depth bump were AFTER that await, a second
    // enqueueInjection firing while the first injection is suspended on the read
    // would see depth still 0, pass the guard, and drain a 2nd item concurrently.
    // With the bump moved BEFORE the await, the second drain is correctly gated.
    const st = __injectionStateForTest()
    st.setMainContext({ platform: 'openai', chatId: 'c1', parentId: 'p1', model: 'gpt-4o' })

    // Gate the master-switch storage read so the first injection's
    // handleChatRequest parks exactly at that await until we release it.
    let releaseStorage!: () => void
    const storageGate = new Promise<void>(r => { releaseStorage = r })
    ;(globalThis as any).chrome.storage.local.get = async (key: any) => {
      // Only the master-switch probe is gated; other reads resolve immediately.
      if (Array.isArray(key) && key.includes('extensionEnabled')) {
        await storageGate
        return {}
      }
      return { openaiApiKey: 'k', openaiBaseUrl: 'http://api.test' }
    }
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('继续') as any))
    try {
      // Two finished batches enqueue back-to-back. The first kicks off a real
      // handleChatRequest which parks on storageGate; the second must NOT proceed.
      st.enqueue('汇总A', { platform: 'openai', chatId: 'c1', parentId: 'p1', model: 'gpt-4o' })
      st.enqueue('汇总B', { platform: 'openai', chatId: 'c1', parentId: 'p1', model: 'gpt-4o' })

      // Let microtasks settle: the first drain has started handleChatRequest (now
      // parked on storageGate), the second enqueue's drain attempt should bail
      // because mainTurnDepth was bumped synchronously to 1 before the await.
      await new Promise(r => setTimeout(r, 20))
      expect(st.queue).toHaveLength(1)                       // B still queued
      expect(types().filter(t => t === 'CHAT_CONTINUING')).toHaveLength(1)

      // Release the first injection; it finishes, depth → 0, finally drains B.
      releaseStorage()
      await waitFor(() => st.queue.length === 0)
      await waitFor(() => types().filter(t => t === 'CHAT_CONTINUING').length >= 2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('injection conversation binding', () => {
  it('injects into the conversation that spawned the batch, not a newer unrelated one', async () => {
    const st = __injectionStateForTest()
    // User started a NEW conversation while the batch ran.
    st.setMainContext({ platform: 'openai', chatId: 'NEW-chat', parentId: 'np', model: 'gpt-4o' })
    st.queue.push({ message: '汇总', ctx: { platform: 'openai', chatId: 'OLD-chat', parentId: 'op', model: 'gpt-4o' } })

    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('继续') as any))
    try {
      st.drain()
      await waitFor(() => types().includes('CHAT_DONE'))
      // CHAT_DONE echoes the chatId the injected turn ran in.
      const done = broadcasts.find(b => b.type === 'CHAT_DONE')
      expect(done.chatId).toBe('OLD-chat')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('prefers lastMainContext (fresher parentId) when it IS the same conversation', async () => {
    const st = __injectionStateForTest()
    st.setMainContext({ platform: 'openai', chatId: 'c1', parentId: 'fresh-parent', model: 'gpt-4o' })
    st.queue.push({ message: '汇总', ctx: { platform: 'openai', chatId: 'c1', parentId: 'stale-parent', model: 'gpt-4o' } })

    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init?: any) => {
      bodies.push(String(init?.body || ''))
      return sseResponse('继续') as any
    }))
    try {
      st.drain()
      await waitFor(() => types().includes('CHAT_DONE'))
      expect(broadcasts.find(b => b.type === 'CHAT_DONE').chatId).toBe('c1')
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
