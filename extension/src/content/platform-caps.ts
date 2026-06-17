// hasApiClient reports whether a platform has an API client in chat-api.ts'
// getAuth (cookie session or OpenAI key). Sub-agents route through the API only
// on these; others fall back to the tab-worker path. Keep in sync with
// background/chat-api.ts getAuth coverage.
// chatgpt included: routes through the local chatgpt-proxy, which solves the
// sentinel turnstile gate server-side and exposes OpenAI-compatible endpoints.
// getAuth('chatgpt') probes the proxy /health. The proxy turnstile gate is flaky,
// so runSubAgent retries the chatgpt run SUBAGENT_RETRY_ATTEMPTS times and, on
// exhaustion, falls back to a real tab-worker via the Go /exec spawn_agent.
// claude is deliberately NOT here: its sidebar-API path is unverified, so a
// claude coordinator's spawn_agent falls through to the Go /exec tab-worker.
// openai keeps its API client (getAuth reads a stored key) but has no page
// adapter, so it has no web coordinator — listed only for completeness.
const API_CLIENT_PLATFORMS = new Set(['qwen', 'chatgpt', 'openai'])

export function hasApiClient(platform: string): boolean {
  return API_CLIENT_PLATFORMS.has(platform)
}
