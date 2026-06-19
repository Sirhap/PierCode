// Tool-name router + per-tab serialization lock. Phase 0 builds the routing +
// concurrency primitive; the security/approval gates are wired in Phase 2 once the
// controller singleton exists. Tools register into TOOL_TABLE in their phases.
import type { ExecResult } from './types'

/** Port of executor.go:528 browserTabKey: tabId>0 → "tab:<id>", else "tab:default". */
export function browserTabKey(args: Record<string, unknown>): string {
  const n = args?.tabId
  if (typeof n === 'number' && n > 0 && Number.isFinite(n)) return `tab:${Math.trunc(n)}`
  return 'tab:default'
}

/** Per-key promise chain: same key serializes, different keys run concurrently. */
export class KeyedLock {
  private chains = new Map<string, Promise<unknown>>()
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)   // run regardless of prior outcome
    // keep the chain but swallow rejection so one failure doesn't poison the key
    this.chains.set(key, next.catch(() => undefined))
    return next
  }
}

// Controller method signature: (args) => Promise<string> (the tool output text).
export type ToolMethod = (args: Record<string, unknown>) => Promise<string>
export const TOOL_TABLE = new Map<string, ToolMethod>()   // filled in phases 1-3
export const READONLY_TOOLS = new Set<string>()           // filled in phases 1-3

const lock = new KeyedLock()

/** Entry point the onMessage handler calls. Routes + locks + invokes the method. */
export async function dispatchBrowserTool(
  name: string, args: Record<string, unknown>, callId: string,
): Promise<ExecResult> {
  const method = TOOL_TABLE.get(name)
  if (!method) return { callId, name, output: `unknown browser tool: ${name}`, error: 'unknown tool', success: false }
  const key = browserTabKey(args)
  try {
    const output = await lock.run(key, () => method(args))
    return { callId, name, output, success: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { callId, name, output: msg, error: msg, success: false }
  }
}
