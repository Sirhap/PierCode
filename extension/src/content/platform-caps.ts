// hasApiClient reports whether a platform has an API client in chat-api.ts'
// getAuth (cookie session or OpenAI key). Sub-agents route through the API only
// on these; others fall back to the tab-worker path. Keep in sync with
// background/chat-api.ts getAuth coverage.
const API_CLIENT_PLATFORMS = new Set(['qwen', 'chatgpt', 'claude', 'openai'])

export function hasApiClient(platform: string): boolean {
  return API_CLIENT_PLATFORMS.has(platform)
}
