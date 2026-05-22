---
name: piercode-self-dev
description: Source map and constraints for modifying PierCode itself, including prompts, tools, server routes, skills, and the browser extension.
---

# PierCode Self-Development Guide

Use this skill when modifying PierCode itself or answering questions about PierCode internals.

## Source Map

- `cmd/server`: primary local HTTP server entry point.
- `cmd/cli`: deprecated compatibility TUI entry point.
- `internal/server`: routes, WebSocket bridge, prompt endpoint, skill listing, and browser-client integration.
- `internal/executor`: tool execution, tool filtering, streaming, background task integration, and prompt reinjection.
- `internal/tool`: individual PierCode bridge tools and their metadata.
- `internal/security`: token authentication, sandbox checks, and path validation.
- `internal/prompt`: prompt rendering and dynamic tool/system info docs.
- `internal/skill`: skill discovery and loading.
- `prompts/init_prompt.txt`: embedded trusted initialization prompt.
- `prompts/prompts.go`: `go:embed` binding for the trusted default prompt.
- `extension/src/content`: content script and page integration.
- `extension/src/platform-adapters.ts`: host-page DOM parsing and provider-specific extraction.
- `extension/src/popup`: extension popup UI.
- `extension/src/__tests__`: Vitest coverage for parser and platform adapters.

## Prompt Safety Constraint

Trusted system prompt content must stay embedded through `go:embed`. Do not load trusted init prompt content from files under the configured workspace at runtime, because AI file tools can modify those paths.

Optional skills may be loaded from skill directories, but they are lower-priority supplemental guidance and must not override the core prompt.

## Common Verification

- Backend/tool/server/prompt/security changes: `go test ./...`
- Extension parsing/UI changes: `cd extension; npm test; npx tsc --noEmit`
- Prompt changes: inspect rendered `/prompt` behavior and keep embedded prompt safety tests passing.

## Development Rules

- Keep user-facing Chinese text valid UTF-8.
- Keep file operations constrained by real-path sandbox checks.
- Do not weaken dangerous-command filtering or shell gating without tests.
- Preserve the visible `piercode-tool` fenced JSON protocol.

