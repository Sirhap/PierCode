// Tool-name router + per-tab serialization lock + security/approval gates.
// Tools register into TOOL_TABLE in their phases (via register.ts).
import type { ExecResult } from './types'
import { getController } from './controller'
import { approval } from './approval-singleton'
import { runGates } from './gates'
import { applyHints } from './hints'

// Append a deterministic recovery hint (item #4) to a browser tool's output. Wrapped so
// a misbehaving rule can never turn a successful tool into a failure. Empty hint → output
// is returned unchanged.
function withHints(name: string, output: string, isError: boolean): string {
  try {
    const hint = applyHints({ toolName: name, resultText: output, isError })
    return hint ? `${output}\n${hint}` : output
  } catch { return output }
}

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

export interface DispatchOpts {
  // The AI-page tab the call came from (content route: the sender tab). Stamped onto
  // args as `__originTabId` so approval prompts + the screenshot attachment target THAT
  // tab only, instead of broadcasting to every AI tab.
  originTabId?: number
  // The browser-agent sidebar route runs its OWN classifyRisk → BROWSER_AGENT_APPROVAL
  // gate before dispatching, so it sets skipApproval to avoid a second prompt. The
  // sensitivity hard-refuse still applies (it is not an approval, it is a refusal).
  skipApproval?: boolean
}

/** Entry point the onMessage handler calls. Per-tab lock → gates → method.
 *  Read-only tools skip the gates (no tab pre-resolution, no approval). */
export async function dispatchBrowserTool(
  name: string, args: Record<string, unknown>, callId: string, opts: DispatchOpts = {},
): Promise<ExecResult> {
  const method = TOOL_TABLE.get(name)
  if (!method) return { callId, name, output: `unknown browser tool: ${name}`, error: 'unknown tool', success: false }
  if (typeof opts.originTabId === 'number') args = { ...args, __originTabId: opts.originTabId }
  const key = browserTabKey(args)
  try {
    const output = await lock.run(key, async () => {
      if (!READONLY_TOOLS.has(name)) {
        const c = getController()
        // Pre-resolve the tab so the gate can check sensitivity + the AI-page gate
        // fires once (ensureTab) before any mutating CDP is issued. Pass the tool name
        // so the tab-establishing tools (use_tab/new_tab) skip the AI-page gate — gating
        // them would deadlock (the gate's remedy IS browser_use_tab).
        const tab = await c.resolveTabForGate(args as { tabId?: number }, name)
        await runGates({ name, tab, callId, approval, security: c.security, originTabId: opts.originTabId, skipApproval: opts.skipApproval })
      }
      return method(args)
    })
    return { callId, name, output: withHints(name, output, false), success: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { callId, name, output: withHints(name, msg, true), error: msg, success: false }
  }
}
