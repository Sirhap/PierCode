# PierCode Documentation - Local AI Assistant Proxy

PierCode is a local development tool that connects web-based AI assistants (ChatGPT, Claude, Qwen, etc.) to your local filesystem and browser via a Chrome extension and a sandboxed Go server.

## Features

- Execute safe file operations: `read_file`, `write_file`, `list_dir`, `glob`, `grep`
- Edit and patch files: `edit`, `apply_patch`
- Run shell commands in a sandbox: `exec_cmd`
- Browser automation with approval: `browser_*` tools
- Multi-platform support: ChatGPT, Claude, Qwen, Gemini, AI Studio, Kimi, Mimo
- Local sandbox and token-based authentication

## Getting Started

See [development.md](development.md) for build instructions and [browser-full-test-plan.md](browser-full-test-plan.md) for browser automation tests.

## Contributing

Refer to [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md) for contribution guidelines and AI platform instructions.

## Screenshots

![PierCode UI](../docs/screenshot.png)