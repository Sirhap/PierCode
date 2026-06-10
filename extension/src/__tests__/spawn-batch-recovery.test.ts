/**
 * Recoverable spawn-agent batches: the MV3 service worker can be killed
 * mid-batch (30s idle / 5-min cap). chat-api persists batch progress to
 * chrome.storage.session and resumes orphaned batches on the next SW life.
 *
 * These tests run with a stubbed chrome whose cookies are empty, so every
 * sub-agent fails fast at auth ("子 agent 失败: ...") — which is fine: the
 * recovery machinery (persist / salvage / resume / push) is what's under test,
 * not the platform conversation itself.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  startRecoverableSpawnBatch,
  resumeOrphanedSpawnBatches,
  __spawnBatchStateForTest,
} from '../background/chat-api'

const PREFIX = 'spawnBatch:'

let sessionData: Record<string, any>
let tabsSendSpy: ReturnType<typeof vi.fn>

function installChromeStub() {
  sessionData = {}
  tabsSendSpy = vi.fn(() => Promise.resolve())
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
          // Deep-copy: real storage serializes, so later in-memory mutation of
          // the record object must not retroactively change what was saved.
          for (const [k, v] of Object.entries(obj)) sessionData[k] = JSON.parse(JSON.stringify(v))
        },
        remove: async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete sessionData[k]
        },
      },
      local: {
        get: async () => ({}),
      },
    },
    runtime: {
      sendMessage: () => Promise.resolve(),
      getPlatformInfo: (cb?: () => void) => cb?.(),
      lastError: undefined,
    },
    tabs: { sendMessage: tabsSendSpy },
    cookies: { get: async () => null },
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise(r => setTimeout(r, 10))
  }
}

const spawnCall = (id: string) => ({
  name: 'spawn_agent',
  args: { label: 'w', task: 'do thing' },
  call_id: id,
})

beforeEach(() => {
  installChromeStub()
  __spawnBatchStateForTest().reset()
})

describe('startRecoverableSpawnBatch', () => {
  it('persists the record, completes it, and pushes results to the origin tab', async () => {
    await startRecoverableSpawnBatch('k1', [spawnCall('c1')], 'qwen', undefined, 7)

    const rec = sessionData[PREFIX + 'k1']
    expect(rec).toBeTruthy()
    expect(rec.done).toBe(true)
    expect(rec.agents).toHaveLength(1)
    expect(rec.agents[0].status).toBe('done')
    expect(rec.agents[0].result.call_id).toBe('c1')
    expect(rec.agents[0].result.success).toBe(false) // auth fails in stub env

    expect(__spawnBatchStateForTest().finished.get('k1')).toHaveLength(1)
    expect(__spawnBatchStateForTest().live.size).toBe(0)

    const push = tabsSendSpy.mock.calls.find(c => c[1]?.type === 'CONTENT_SPAWN_RESULT')
    expect(push).toBeTruthy()
    expect(push![0]).toBe(7)
    expect(push![1].batchKey).toBe('k1')
    expect(push![1].results).toHaveLength(1)
  })
})

describe('resumeOrphanedSpawnBatches', () => {
  it('salvages already-done agents and finishes pending ones', async () => {
    const saved = {
      call_id: 'c1',
      name: 'spawn_agent',
      output: 'finished before SW death',
      success: true,
    }
    sessionData[PREFIX + 'k2'] = {
      batchKey: 'k2',
      batchId: 'b2',
      platform: 'qwen',
      depth: 0,
      originTabId: 9,
      createdAt: Date.now(),
      done: false,
      agents: [
        { call: spawnCall('c1'), agentId: 'a1', status: 'done', result: saved },
        { call: spawnCall('c2'), agentId: 'a2', status: 'pending' },
      ],
    }

    await resumeOrphanedSpawnBatches()
    await waitFor(() => sessionData[PREFIX + 'k2']?.done === true)

    const rec = sessionData[PREFIX + 'k2']
    // Agent done before the SW death keeps its result untouched.
    expect(rec.agents[0].result).toEqual(saved)
    // Pending agent was re-run to completion (fails fast in stub env).
    expect(rec.agents[1].status).toBe('done')
    expect(rec.agents[1].result.call_id).toBe('c2')

    const push = tabsSendSpy.mock.calls.find(c => c[1]?.type === 'CONTENT_SPAWN_RESULT')
    expect(push![0]).toBe(9)
    expect(push![1].results[0]).toEqual(saved)
  })

  it('resumes a pending agent from its checkpoint (keeps agentId)', async () => {
    sessionData[PREFIX + 'k3'] = {
      batchKey: 'k3',
      batchId: 'b3',
      platform: 'qwen',
      depth: 0,
      createdAt: Date.now(),
      done: false,
      agents: [{
        call: spawnCall('c1'),
        agentId: 'stable-agent-id',
        status: 'pending',
        checkpoint: { chatId: 'chat-1', parentId: 'p-1', message: 'tool results...', turn: 3 },
      }],
    }

    await resumeOrphanedSpawnBatches()
    await waitFor(() => sessionData[PREFIX + 'k3']?.done === true)

    const rec = sessionData[PREFIX + 'k3']
    expect(rec.agents[0].status).toBe('done')
    // agentId survives the restart so abort ✕ / panel rows still match.
    expect(rec.agents[0].agentId).toBe('stable-agent-id')
  })

  it('drops expired records without running them', async () => {
    sessionData[PREFIX + 'old'] = {
      batchKey: 'old',
      batchId: 'b0',
      platform: 'qwen',
      depth: 0,
      createdAt: Date.now() - 3 * 60 * 60 * 1000,
      done: false,
      agents: [{ call: spawnCall('c1'), agentId: 'a0', status: 'pending' }],
    }

    await resumeOrphanedSpawnBatches()

    expect(sessionData[PREFIX + 'old']).toBeUndefined()
    expect(__spawnBatchStateForTest().live.has('old')).toBe(false)
  })

  it('does not double-run a batch that is already live', async () => {
    sessionData[PREFIX + 'k4'] = {
      batchKey: 'k4',
      batchId: 'b4',
      platform: 'qwen',
      depth: 0,
      createdAt: Date.now(),
      done: false,
      agents: [{ call: spawnCall('c1'), agentId: 'a4', status: 'pending' }],
    }
    __spawnBatchStateForTest().live.add('k4')

    await resumeOrphanedSpawnBatches()
    await new Promise(r => setTimeout(r, 50))

    // Still pending: the "live" batch is owned by another runner.
    expect(sessionData[PREFIX + 'k4'].done).toBe(false)
    __spawnBatchStateForTest().live.delete('k4')
  })
})
