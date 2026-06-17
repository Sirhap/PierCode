// Core SW-side browser types.
// Mirrors internal/tool/tool.go browser structs + internal/browser/registry.go.

export interface Bounds { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

export interface BrowserTab {
  tabId: number
  url: string
  title: string
  controlled?: boolean
  tracked?: boolean
}

// SafeTitle equivalent — sanitize attacker-controllable titles before they reach
// model-readable output (mirrors tool.go BrowserTab.SafeTitle / SanitizeLabel).
// Replace C0 controls (0x00-0x1f) + DEL (0x7f) with spaces — done by codepoint so
// there are no literal control chars in source — then collapse whitespace runs.
export function safeTitle(title: string): string {
  let out = ''
  for (const ch of title || '') {
    const c = ch.charCodeAt(0)
    out += (c <= 0x1f || c === 0x7f) ? ' ' : ch
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 300)
}

export interface RefTarget {
  ref: string
  nodeId: string
  backendId: number
  role: string
  name: string
  bounds: Bounds | null
  sessionId: string        // OOPIF child session; '' = main
  frameOffset: Bounds | null
}

export interface ExecResult {
  callId: string
  name: string
  output: string
  error?: string
  success: boolean
}

// The message content/sidebar sends to the SW to run a browser tool.
export interface ExecBrowserToolMsg {
  type: 'EXEC_BROWSER_TOOL'
  name: string
  args: Record<string, unknown>
  callId?: string
  conversationUrl?: string
}
