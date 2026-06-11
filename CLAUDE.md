# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PierCode is a browser-local proxy that connects web-based AI assistants to the local filesystem through a sandboxed Go server and Chrome extension. The AI outputs tool calls in its responses; the extension detects them, proxies them to a localhost Go server, which executes sandboxed filesystem/shell operations and returns results.

**Two-component system:**
1. **Go Server** (`cmd/server/`): HTTP + WebSocket server that executes sandboxed tool calls
2. **Chrome Extension** (`extension/`): Manifest V3 extension with content scripts, background service worker, and popup UI

## Environment Requirements

- Go 1.24+ (toolchain 1.24.8)
- Node.js 18+
- Chrome or Chromium browser with Manifest V3 support

## Development Commands

```bash
# --- Go server ---
go run ./cmd/server -dir .                    # start server (default port 39527)
go run ./cmd/server -dir /path -port 39527    # custom workspace and port
go build -o piercode.exe ./cmd/server         # build binary (Windows)

# --- Go tests ---
go test ./...                                 # all tests
go test ./internal/tool/...                   # single package
go test ./internal/browser/... -run TestFind  # single test by name
go test -race ./...                           # race detector

# --- Extension ---
cd extension
npm install
npm run build        # production build → extension/dist/
npm run dev          # watch mode (auto-rebuild on changes)
npm test             # vitest (run once)
npm run test:watch   # vitest (watch mode)
npx tsc --noEmit     # type-check only

# --- Windows build script (test + build + package) ---
.\scripts\build.ps1              # full build with tests
.\scripts\build.ps1 -SkipTests   # build without running tests

# --- Browser smoke test (after extension build) ---
cd extension; npm run build; cd ..
node scripts/browser-smoke.mjs
```

## Code Architecture

### Request Flow

```
Web AI page (Gemini/ChatGPT/Claude/Qwen/Kimi/etc.)
  ↓ AI outputs piercode-tool fenced code blocks
Content script (extension/src/content/)
  ↓ PlatformAdapter detects tool blocks, renders approval card
  ↓ User clicks "执行" → message to background service worker
Background (extension/src/background/)
  ↓ HTTP POST to localhost:39527/exec
Go Server (internal/server/)
  ↓ auth + validation
Executor (internal/executor/) → Tool Registry (internal/tool/)
  ↓ executes with sandbox
Security Layer (internal/security/)
  ↓ path validation + command filtering
Local Filesystem / Browser CDP
```

### Go Server Packages

**`internal/server/`**: HTTP routes (Gin) + WebSocket bridge
- Routes: `/auth`, `/health`, `/config`, `/cwd`, `/tools`, `/exec`, `/prompt`, `/skills`, `/files`, `/inject`, `/ws`
- `ws.go`: WebSocket manager for bidirectional comms between extension ↔ server

**`internal/executor/`**: Tool dispatch and lifecycle
- `executor.go`: Owns a `tool.Registry`, dispatches tool calls, manages concurrency (read/write locking per tool), injects prompt guidance every N calls
- `tasks.go`: Background task manager for long-running `exec_cmd` calls (`background: true`)

**`internal/tool/`**: Tool implementations (each tool implements the `Tool` interface in `tool.go`)
- `registry.go`: Thread-safe tool registry (Register/Get/List)
- Core tools: `exec_cmd`, `read_file`, `write_file`, `edit`, `apply_patch` (multi-file contextual patches), `list_dir`, `glob`, `grep`, `web_fetch`, `skill`, `question`, `todo_write`, `todo_read`, `task_list`, `task_output`, `task_stop`, `send_stdin`, `tool_help` (on-demand tool docs)
- Browser tools (`browser_tools.go`, `browser_tools_ext.go`, `browser_tools_find.go`): ~25 browser automation tools using CDP via the extension's debugger API
- Multi-agent tools (`agent_tools.go`, `agent_registry.go`): `spawn_agent` / `send_to_agent` / `stop_agent` let a coordinator AI dispatch worker agents into new AI tabs. `AgentRegistry` maps `agent_id → {dispatcher, worker, status}`. Worker page carries `?piercode_agent=<id>` in its tab URL → WS `agent` query → server binds it (`handleWS`) and seeds the `worker`-profile prompt + task via an `inject` message. Worker reports back with a `piercode-agent-result` fenced packet → content detects it → WS `agent_result` → server routes a `<task-notification>` `inject` to the dispatcher (push callback; coordinator never polls). Worker prompt contract lives in `prompts/worker_append.txt` (the `worker` profile).
- **Sidebar API sub-agents** (a separate system from the web-worker route above): the chat sidebar (`extension/src/sidebar/`) talks to AI platforms directly via API, and its `spawn_agent` runs each sub-agent as an in-memory API sub-conversation (`background/chat-api.ts` `runSubAgent` → `runIsolatedConversation`), with NO browser tab — so none of the web-worker plumbing (Monaco-truncation packet parsing, keep-alive shim, WS `agent_result` routing, URL-migration callback loss) applies. Sub-agents run in parallel (`Promise.all`); each worker has its own abort via `mergedAgentSignal(agentId, currentAbort?.signal)` (signal-merge of global-stop + per-worker cancel) and is cancellable from the running card's ✕ → `CHAT_AGENT_ABORT` → `agentAborts.get(id).abort()`. A finished done-card fades out and is removed; once a whole batch is terminal the parent chat gets ONE inline `agentSummary` card (`subagent-ui.ts` `buildAgentSummary` → `MessageView` ⏺/⎿ tree).
- `tool.go`: `Tool` interface, `Context` struct (10 fields — core: RootDir snapshot, Args, Config; capability groups `Client ClientIO` (Streamer/Broadcast/BroadcastToClient/SourceClientID/ConversationURL, defined in `context_client.go`) and `Tasks TaskAccess` (background-task Runner, in `context_tasks.go`); plus `Browser` + `Agents`. Groups embed by value so a bare `&Context{}` in tests reads `ctx.Client.X` / `ctx.Tasks.Runner` without panic; nil/empty = capability unavailable, nil-checked per field), `BrowserController` interface

**`internal/browser/`**: Browser automation core
- `controller.go`, `controller_ext.go`, `controller_find.go`: CDP command orchestration via relay to extension
- `relay.go`: Request/response relay between server and extension background worker
- `snapshot.go`: Accessibility tree parsing for page understanding
- `approval.go`: User-approval flow for sensitive browser actions
- `events.go`: Console/network log buffering via CDP domain tracking
- `security.go`: URL scheme filtering (blocks `file:`, `chrome:`, `javascript:`, etc.)

**`internal/security/`**: Sandbox enforcement
- `sandbox.go`: `SafePath()` resolves symlinks and validates paths stay within RootDir; `IsDangerousCommand()` blocks destructive/network/privilege commands
- `auth.go`: Bearer token middleware

**`internal/prompt/`**: Prompt rendering and profile system
- `profile.go`: Multiple prompt profiles selectable per AI platform
- `prompt.go`: Template rendering with `{{SYSTEM_INFO}}`, `{{TOOLS}}`, `{{SKILLS}}` placeholders

**`internal/types/types.go`**: Shared types (`Config`, `ToolRequest`, `ToolResponse`)

**`prompts/`**: Embedded prompt templates (`init_prompt.txt`, `qwen_append.txt`) via `//go:embed`

### Extension Architecture

Built with Vite + React + TypeScript + Tailwind CSS. Five entry points (see `vite.config.ts`):

| Entry | Output | Purpose |
|-------|--------|---------|
| `src/content/` | `content.js` | Injected into AI pages; detects tool calls, renders approval UI |
| `src/background/` | `background.js` | Service worker; proxies HTTP to server, manages WebSocket, drives CDP |
| `src/popup/` | `popup.html` | Extension popup; auth URL input, connection status, relay controls |
| `src/injected/` | `injected.js` | Page-context script for editor interaction |
| `src/page-bridge/` | `page-bridge.js` | Bridge between content script and injected script; also installs the keep-alive visibility shim |

**Platform adapter pattern** (`src/platform-adapters/`): Each supported AI site has its own adapter module. Adapters are matched by URL in priority order in `platform-adapters.ts`.

**Context compression** (`src/content/qwen-context-compress.ts`): Counts conversation tokens (tiktoken via `token-meter.ts`, char-estimate fallback) and, when a per-platform threshold is exceeded, asks the model to emit a `piercode-context` packet (local summary fallback) and hands it to a fresh session. The handoff prompt puts the init/run-instructions section **before** the compressed-context section (model loads the tool protocol first, then resumes from `next_action`). Enabled per platform via `COMPRESSION_PLATFORMS` in `content/index.ts` (currently `qwen` + `chatgpt`). Config + per-platform thresholds live in the content-safe leaf `src/content/qwen-settings.ts` (`ContextCompressionConfig`, `DEFAULT_PLATFORM_THRESHOLDS`, `thresholdForPlatform`), re-exported by `src/settings.ts`. Storage key `contextCompressionConfig`, with migration from legacy `qwenCompressionConfig`. (The `qwen-*` filenames/symbols are legacy names for what is now multi-platform.) Two user-facing modes on the config: `triggerMode` (`'confirm'` default = pop a 压缩/跳过 card at threshold; `'auto'` = compress immediately) and `handoffMode` (`'auto'` default = open new tab + auto-send; `'manual'` = copy packet to clipboard only). An in-flight compression is cancellable via the status card's 取消 button.

**Conversation scope** (`src/content/conversation-scope.ts`): canonicalizes/identifies the current conversation across the SPA's transient→stable URL migration (e.g. `claude.ai/new` → `/chat/<uuid>`). Migration aliases persist in `sessionStorage` (`piercode_conversation_aliases`) so a refresh still matches server pushes tagged with the original `/new` URL. `isConversationURLForCurrentPage()` gates inbound WS messages (worker callbacks, compression handoffs); `getConversationKey()` is the migration-stable key used for exec dedup (`isExecuted`) and per-conversation token-meter/context state (`conversationCtxByURL`), so a URL flip neither re-runs executed tools nor orphans history. Worker pages (`workerAgentId()` set) force `autoExecute=true` and activate their own tab before submitting, so they run unattended in a background tab.

**Background-tab keep-alive** (`src/page-bridge/index.ts` `installKeepAliveVisibilityShim`): Chrome throttles background tabs and, worse, AI sites pause their own streaming response when `document.hidden`/`visibilitychange` fires. The shim spoofs `document.hidden=false` / `visibilityState='visible'` and swallows `visibilitychange`/`blur`/`pagehide`/`freeze` in **page context** (isolated from the content script's own real visibility checks), so a worker/background AI tab keeps generating. Applied to all AI hosts (`KEEP_ALIVE_HOSTS`) and injected at `document_start` via `injectPageBridgeEarly()` so it beats the site's own listeners. (Electron multi-AI apps like ai-gate get this free from non-throttled hidden BrowserViews; a Chrome extension must fake it.)

Currently supported platforms (from manifest + adapters):
- Google Gemini (`gemini.google.com`)
- Google AI Studio (`aistudio.google.com`)
- Qwen (`qwen.ai`, `qwenlm.ai`)
- Chat Z (`chat.z.ai`)
- Kimi (`kimi.com`)
- Claude (`claude.ai`)
- ChatGPT (`chatgpt.com`, `chat.openai.com`)
- Mimo (`aistudio.xiaomimimo.com`)

### Adding a New AI Platform

1. Create `extension/src/platform-adapters/<name>.ts` implementing the `PlatformAdapter` interface from `types.ts`
2. Add it to the adapter list in `extension/src/platform-adapters.ts`
3. Add URL patterns to `extension/public/manifest.json` (`content_scripts.matches`, `host_permissions`, `web_accessible_resources.matches`)

### Adding a New Tool

1. Create a new file in `internal/tool/` implementing the `Tool` interface (Name, Description, Parameters, Validate, Execute)
2. Register it in `internal/executor/executor.go`'s `New()` function
3. If read-only, add to `isReadOnlyTool()` in `executor.go` for concurrent execution
4. All file paths must go through `security.SafePath()` or the `resolveAbsPath()` helper in `tool.go`

### Security Model

- Server binds `127.0.0.1` only; all requests require Bearer token (generated per-launch, stored in `~/.piercode/token`)
- File paths resolved via `filepath.EvalSymlinks` then validated against RootDir
- `/cwd` cannot escape the initial startup directory or explicitly added allowed dirs — except in `auto` permission mode, which also allows the startup directory's PARENT (sibling projects become reachable; deliberate relaxation in `handleCwd`). `unrestricted` mode skips the check entirely
- Dangerous commands blocked: `rm -rf`, `sudo`, `curl`, `wget`, `dd`, `mkfs`, etc. The blacklist is a backstop, not a sandbox — it can be bypassed via variable expansion / quote splitting
- **`exec_cmd` (shell) is enabled by default** (`--allow-shell` defaults to `true`). Start with `--no-shell` to disable shell execution in untrusted environments
- Command timeout: default 60s, configurable via `-timeout`
- Browser actions (click, type, upload, evaluate) require user approval via extension popup
- High-risk URL schemes (`file:`, `chrome:`, `javascript:`, `data:`) blocked for navigation

## Module Information

- **Module**: `github.com/sirhap/piercode`
- **Go**: 1.24+ (toolchain 1.24.8)
- **Key dependencies**: Gin (HTTP), gorilla/websocket (WS), testify (tests), golang.org/x/text
- **Extension**: TypeScript, React 18, Vite, Tailwind CSS v4, Vitest, Manifest V3

## Commit Conventions

Commit: source, tests, `go.mod`/`go.sum`, `extension/package.json`/`extension/package-lock.json`, `extension/public/manifest.json`, prompts, docs.

Do NOT commit: `.exe` binaries, `extension/dist/`, `node_modules/`, `release/`/`release-packages/`, `.omx/`, `.claude/`, `.playwright-mcp/`.
