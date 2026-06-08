/**
 * Conversation persistence for the sidebar chat client.
 *
 * Storage layout (chrome.storage.local):
 *   sidebarSessions          → SessionMeta[]   (light index, always loaded)
 *   sidebar_session_<id>     → StoredSession   (full per-session payload)
 *   sidebarActiveSessionId   → string          (current session id)
 */

export interface StoredMessage {
  role: 'user' | 'assistant' | 'tool_result' | 'system'
  content: string
  pinned?: boolean
  toolCalls?: { name: string; args: Record<string, unknown>; call_id: string }[]
  toolResults?: { call_id: string; name: string; output: string; success: boolean }[]
  toolStreams?: Record<string, string[]>
  thinking?: { title: string; thought: string }[]
  ts?: number
}

export interface StoredSession {
  id: string
  platform: string
  model: string
  chatId: string | null
  lastResponseId: string | null
  messages: StoredMessage[]
  ts: number
}

export interface SessionMeta {
  id: string
  title: string
  platform: string
  ts: number
}

const INDEX_KEY = 'sidebarSessions'
const ACTIVE_KEY = 'sidebarActiveSessionId'
const sessionKey = (id: string) => `sidebar_session_${id}`

function deriveTitle(s: StoredSession): string {
  const firstUser = s.messages.find(m => m.role === 'user')
  const raw = (firstUser?.content || '新对话').trim().replace(/\s+/g, ' ')
  return raw.slice(0, 30)
}

export async function listSessions(): Promise<SessionMeta[]> {
  const got = await chrome.storage.local.get([INDEX_KEY])
  const list = got[INDEX_KEY]
  return Array.isArray(list) ? (list as SessionMeta[]) : []
}

export async function saveSession(s: StoredSession): Promise<void> {
  await chrome.storage.local.set({ [sessionKey(s.id)]: s })
  const list = await listSessions()
  const meta: SessionMeta = { id: s.id, title: deriveTitle(s), platform: s.platform, ts: s.ts }
  const idx = list.findIndex(m => m.id === s.id)
  if (idx >= 0) list[idx] = meta
  else list.unshift(meta)
  await chrome.storage.local.set({ [INDEX_KEY]: list })
}

export async function loadSession(id: string): Promise<StoredSession | null> {
  const got = await chrome.storage.local.get([sessionKey(id)])
  const s = got[sessionKey(id)]
  return s ? (s as StoredSession) : null
}

export async function deleteSession(id: string): Promise<void> {
  await chrome.storage.local.remove([sessionKey(id)])
  const list = (await listSessions()).filter(m => m.id !== id)
  await chrome.storage.local.set({ [INDEX_KEY]: list })
}

export async function setActiveSessionId(id: string): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_KEY]: id })
}

export async function getActiveSessionId(): Promise<string | null> {
  const got = await chrome.storage.local.get([ACTIVE_KEY])
  return typeof got[ACTIVE_KEY] === 'string' ? got[ACTIVE_KEY] : null
}
