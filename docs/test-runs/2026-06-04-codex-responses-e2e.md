# Codex Responses API E2E - 2026-06-04

## Summary

Status: passed (with a fake browser AI page; real browser AI not yet exercised).

Wired real Codex CLI `0.137.0` to PierCode's new OpenAI Responses API impersonation
(`POST /v1/responses`) and confirmed the full request → web AI → response loop works
end to end, including the keepalive that prevents Codex from aborting during a slow
browser AI round-trip.

Key finding up front: **Codex 0.137 removed `wire_api = "chat"`**. The Chat
Completions impersonation (`/v1/chat/completions`) still works for generic OpenAI
clients, but modern Codex speaks **only** the Responses API, so `/v1/responses` was
required.

## Environment

- codex: `codex-cli 0.137.0` (`npm i -g @openai/codex`)
- server: `go build ./cmd/server`, fixed token, port 39572
- fake browser AI: `scripts/fake-ai-page.mjs <port> <token> <mode>` (echo / tool)
- Codex config: isolated `CODEX_HOME=/tmp/cdx-home` to avoid the user's real
  plugins/MCP/notify hooks (they stall non-interactive startup).

Codex provider wiring (`config.toml`):

```toml
model = "claude-via-browser"
model_provider = "piercode"
[model_providers.piercode]
name = "PierCode"
base_url = "http://127.0.0.1:39572/v1"
wire_api = "responses"
env_key = "PIERCODE_KEY"          # PIERCODE_KEY = server token
requires_openai_auth = false
```

## Captured Request Contract (real codex 0.137)

`POST /v1/responses`, `Authorization: Bearer <env_key>`, `Accept: text/event-stream`:

```json
{
  "model": "...",
  "instructions": "<full Codex system prompt>",
  "input": [
    {"type":"message","role":"developer|user|assistant",
     "content":[{"type":"input_text","text":"..."}]},
    {"type":"function_call","name":"...","arguments":"...","call_id":"..."},
    {"type":"function_call_output","call_id":"...","output":"..."}
  ],
  "tools": [{"type":"function","name":"exec_command","description":"...","parameters":{...}}],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "stream": true
}
```

Response SSE sequence Codex accepts:

```
response.created
response.output_item.added
response.content_part.added            (message turns)
response.output_text.delta | response.function_call_arguments.delta
*.done
response.output_item.done
response.completed
```

Keepalive while waiting for the browser AI: `response.in_progress` (no content,
ignored by Codex) every 5s, after an immediate `response.created`.

## Test A — plain text round trip

fake page in `echo` mode (always replies plain text, no tool block).

```text
$ echo "Say hello" | codex exec --skip-git-repo-check --sandbox read-only -
user: Say hello
codex: Hello from the fake browser AI page.
rc=0
```

The browser AI's text reached Codex through `/v1/responses`. Pass.

## Test B — keepalive under a slow page

fake page delays its reply 12s; Codex's silence tolerance would otherwise abort.

```text
[slow] got query at 08:01:02Z, waiting 12s
codex: final answer after 12s slow wait
rc=0  elapsed=15s
```

`response.created` + `response.in_progress` pings (5s cadence) kept the connection
alive across the 12s page round-trip. This is the same class of failure that broke
the Anthropic CLI path (see `2026-06-03-real-browser-anthropic-e2e.md`). Pass.

## Test C — tool-call loop (negative, expected)

fake page in `tool` mode emits a `piercode-call` for `Read` (a Claude Code tool).
Codex's tool set is `exec_command` / `write_stdin` / … — there is no `Read`, so:

```text
ERROR codex_core::tools::router: error=unsupported call: Read   (repeated → loop)
```

This is **not** an impersonation bug. It confirms the function_call translation is
correct (Codex received a well-formed `function_call` and tried to dispatch it); the
fake page simply advertised a tool Codex doesn't have. A real browser AI driven by
the `buildToolProtocolPreamble` (which lists Codex's actual tools) would call
`exec_command`, not `Read`.

## What this proves

- `/v1/responses` request parsing (instructions + input items + tools) ✓
- Bearer auth via `env_key` ✓ (existing middleware, no change)
- Response SSE event shape Codex accepts ✓
- function_call translation (piercode-call → Responses function_call) ✓
- keepalive prevents slow-page abort ✓
- prompt flatten: `prompt_bytes≈740k`, all instructions+tools forwarded ✓

## Not yet covered

- Real browser AI page (Claude/ChatGPT) instead of the fake stub — needs Chrome +
  extension + a logged-in AI tab.
- A full multi-turn tool loop against a real page that honors Codex's tool contract
  (exec_command etc.) and feeds `function_call_output` back.
- Codex's exact production silence-timeout value vs the 5s ping cadence.

## Unit coverage

`internal/server/responses_test.go`: flatten (messages/function_call/
function_call_output/bare-string), tool name filtering, non-stream text,
non-stream function_call, streaming text, streaming function_call, no-browser 502.
All green; `go test -race ./internal/server/` clean.
