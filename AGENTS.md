# Repository Guidelines

## Project Structure & Module Organization

PierCode is a Go backend plus a Chrome Manifest V3 extension. Server entry points live in `cmd/cli` for the TUI and `cmd/server` for the plain HTTP server. Core backend packages are under `internal/`: `server` owns routes and WebSocket bridging, `tool` owns tool implementations, `security` owns token and sandbox checks, `tui` owns the terminal UI, and `prompt`/`skill` support prompt rendering and local skills. Extension source is in `extension/src`, with page integration in `content`, platform-specific parsing in `platform-adapters.ts`, popup UI in `popup`, and tests in `extension/src/__tests__`. Default prompts live in `prompts/`.

## Build, Test, and Development Commands

Use PowerShell-friendly UTF-8 commands on Windows.

```powershell
go run ./cmd/cli -dir .          # start local server with TUI
go run ./cmd/server -dir .       # start plain local server
go test ./...                    # run all Go tests
go build -o piercode-cli.exe ./cmd/cli
go build -o piercode.exe ./cmd/server
cd extension; npm install; npm test; npm run build; npx tsc --noEmit
```

Do not commit generated binaries, `extension/dist/`, `node_modules/`, `release/`, or `release-packages/`.

## Coding Style & Naming Conventions

Run `gofmt` on Go files and keep package names short and lowercase. Prefer table-driven Go tests for tool and server behavior. TypeScript uses strict, explicit modules; keep platform-specific DOM logic inside `platform-adapters.ts` or narrowly scoped helpers. Keep user-facing Chinese copy consistent with the existing TUI and popup text.

## Testing Guidelines

Place Go tests beside code as `*_test.go`. Extension tests use Vitest and should be named `*.test.ts` under `extension/src/__tests__`. For parser, auth, sandbox, WebSocket, or TUI changes, add or update regression tests. Run both Go and extension checks before claiming completion.

## Commit & Pull Request Guidelines

Recent history uses concise intent lines, sometimes with conventional prefixes such as `refactor(extension): ...`. For substantive commits, include verification trailers such as `Tested:` and `Not-tested:`. PRs should explain the behavior change, list commands run, link related issues, and include screenshots or short recordings for popup/TUI changes.

## Security & Configuration Tips

The service is local-only and token-authenticated, but AI-requested tools can still modify files inside the configured workspace. Keep `/cwd` and file tools constrained by real-path sandbox checks, and do not weaken dangerous-command filtering without tests.
