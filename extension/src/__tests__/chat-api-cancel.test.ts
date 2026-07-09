import { describe, it, expect, beforeEach } from 'vitest'
import {
  handleChatCancel, __agentAbortsForTest, __injectionStateForTest, __setCurrentAbortForTest,
  __spawnBatchStateForTest,
} from '../background/chat-api'

// CHAT-API-001: pressing Stop must abort BOTH the main turn (currentAbort) and
// every detached sub-agent (agentAborts) — otherwise a spawn_agent batch keeps
// running after Stop, finishes, and its queued summary spontaneously resumes
// the conversation. See handleChatCancel in background/chat-api.ts.
describe('handleChatCancel', () => {
  beforeEach(() => {
    __agentAbortsForTest().clear()
    __injectionStateForTest().reset()
    __setCurrentAbortForTest(null)
    __spawnBatchStateForTest().reset()
  })

  it('aborts the main turn controller', () => {
    const main = new AbortController()
    __setCurrentAbortForTest(main)
    handleChatCancel()
    expect(main.signal.aborted).toBe(true)
  })

  it('aborts every in-flight sub-agent and clears the map', () => {
    const a1 = new AbortController()
    const a2 = new AbortController()
    __agentAbortsForTest().set('agent-1', a1)
    __agentAbortsForTest().set('agent-2', a2)

    handleChatCancel()

    expect(a1.signal.aborted).toBe(true)
    expect(a2.signal.aborted).toBe(true)
    expect(__agentAbortsForTest().size).toBe(0)
  })

  it('purges queued injections for the stopped conversation only', () => {
    const state = __injectionStateForTest()
    // mainTurnDepth > 0 mirrors reality: a batch that finishes WHILE the main
    // turn is still running enqueues but drainInjectionQueue defers (depth
    // guard) instead of injecting immediately — the case Stop needs to catch
    // before that deferred summary drains as a spontaneous continuation.
    state.setTurnDepth(1)
    state.setMainContext({ platform: 'qwen', chatId: 'chat-A', parentId: null })
    state.enqueue('summary for A (agent 1)', { platform: 'qwen', chatId: 'chat-A', parentId: null })
    state.enqueue('summary for B (unrelated)', { platform: 'qwen', chatId: 'chat-B', parentId: null })
    state.enqueue('summary for A (agent 2)', { platform: 'qwen', chatId: 'chat-A', parentId: null })

    handleChatCancel()

    const remaining = state.queue.map(q => q.ctx.chatId)
    expect(remaining).toEqual(['chat-B'])
  })

  it('is a no-op when nothing was running (no currentAbort, no agents, empty queue)', () => {
    expect(() => handleChatCancel()).not.toThrow()
    expect(__agentAbortsForTest().size).toBe(0)
  })

  // CHAT-API-002: the purge above only catches a batch that ALREADY finished and
  // queued its summary. A batch still RUNNING when Stop is pressed keeps going
  // (its sub-agents see agentAborts fire, but runSpawnBatchRecord's Promise.all
  // still resolves normally afterward) and would otherwise enqueueInjection
  // later, resuming the conversation anyway. handleChatCancel must mark it
  // cancelled so that later call is a no-op — see runSpawnBatchRecord /
  // resumeOrphanedSpawnBatches in chat-api.ts.
  it('marks a live detached batch for the stopped conversation as cancelled', () => {
    const rec: any = {
      batchKey: 'live-1', batchId: 'b1', platform: 'qwen', depth: 0,
      createdAt: Date.now(), done: false, agents: [],
      inject: { platform: 'qwen', chatId: 'chat-A', parentId: null },
    }
    __spawnBatchStateForTest().records.set('live-1', rec)
    __injectionStateForTest().setMainContext({ platform: 'qwen', chatId: 'chat-A', parentId: null })

    handleChatCancel()

    expect(rec.cancelled).toBe(true)
  })

  it('does not cancel a live batch belonging to a different conversation', () => {
    const rec: any = {
      batchKey: 'live-2', batchId: 'b2', platform: 'qwen', depth: 0,
      createdAt: Date.now(), done: false, agents: [],
      inject: { platform: 'qwen', chatId: 'chat-OTHER', parentId: null },
    }
    __spawnBatchStateForTest().records.set('live-2', rec)
    __injectionStateForTest().setMainContext({ platform: 'qwen', chatId: 'chat-A', parentId: null })

    handleChatCancel()

    expect(rec.cancelled).toBeUndefined()
  })
})
