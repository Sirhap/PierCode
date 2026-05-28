# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PierCode is a browser-local proxy that connects web-based AI assistants to the local filesystem through a sandboxed Go server and Chrome extension. The AI outputs tool calls in its responses; the extension detects them, proxies them to a localhost Go server, which executes sandboxed filesystem/shell operations and returns results.

**Two-component system:**
1. **Go Server** (`cmd/server/`): HTTP + WebSocket server that executes sandboxed tool calls
2. **Chrome Extension** (`extension/`): Manifest V3 extension with content scripts, background service worker, and popup UI

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
- Core tools: `exec_cmd`, `read_file`, `write_file`, `edit`, `list_dir`, `glob`, `grep`, `web_fetch`, `skill`, `question`, `todo_write`, `todo_read`, `task_list`, `task_output`, `task_stop`, `send_stdin`
- Browser tools (`browser_tools.go`, `browser_tools_ext.go`, `browser_tools_find.go`): ~25 browser automation tools using CDP via the extension's debugger API
- `tool.go`: `Tool` interface, `Context` struct (carries RootDir snapshot, Streamer, TaskRunner, Broadcast callbacks), `BrowserController` interface

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
| `src/page-bridge/` | `page-bridge.js` | Bridge between content script and injected script |

**Platform adapter pattern** (`src/platform-adapters/`): Each supported AI site has its own adapter module. Adapters are matched by URL in priority order in `platform-adapters.ts`.

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
- `/cwd` cannot escape the initial startup directory
- Dangerous commands blocked: `rm -rf`, `sudo`, `curl`, `wget`, `dd`, `mkfs`, etc.
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
