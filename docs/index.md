---
title: "PierCode — Local AI Assistant Proxy for ChatGPT, Claude, Gemini & Qwen"
description: "Connect web-based AI assistants to your local filesystem and browser. PierCode is a Chrome extension plus a sandboxed Go server that lets ChatGPT, Claude, Gemini, Qwen, and Kimi read files, edit code, run commands, and automate the browser inside a permission-controlled working directory."
keywords: "PierCode, local AI assistant, AI coding agent, Chrome extension AI, ChatGPT local filesystem, Claude code execution, Gemini local server, Qwen tools, browser AI proxy, sandboxed code execution, MCP alternative, Go server AI, Manifest V3"
---

# PierCode — Local AI Assistant Proxy for ChatGPT, Claude, Gemini & Qwen

PierCode is an open-source local development tool that connects web-based AI assistants — **ChatGPT, Claude, Gemini, Qwen, Kimi**, and more — to your **local filesystem and browser** via a **Chrome extension** and a **sandboxed Go server**. The AI emits tool calls in its replies; the extension detects them and proxies them to a localhost server that executes sandboxed filesystem, shell, and browser operations, then returns the results.

If you want a web AI to act like a local coding agent — reading your repo, editing files, running tests, and driving the browser — without pasting code back and forth, PierCode is the bridge.

## Features

- **Safe file operations**: `read_file`, `write_file`, `list_dir`, `glob`, `grep`
- **Edit and patch code**: `edit`, `apply_patch` (multi-file contextual patches)
- **Run shell commands in a sandbox**: `exec_cmd` (path validation + dangerous-command filtering)
- **Browser automation with user approval**: ~25 `browser_*` tools over CDP
- **Multi-platform support**: ChatGPT, Claude, Qwen, Gemini, Google AI Studio, Kimi, Chat Z, Mimo
- **Local-only security**: binds `127.0.0.1`, per-launch token auth, working-directory sandbox via real-path resolution

## How it works

```
Web AI page (ChatGPT / Claude / Gemini / Qwen …)
  → AI prints a `piercode-tool` fenced JSON block
  → Chrome extension detects it, shows an approval card
  → Localhost Go server validates + executes in the sandbox
  → Result returned to the AI page
```

## Getting Started

See [development.md](development.md) for build instructions and [browser-full-test-plan.md](browser-full-test-plan.md) for browser automation tests. Source and releases are on [GitHub](https://github.com/Sirhap/PierCode).

## Contributing

Refer to [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md) for contribution guidelines and AI platform instructions.