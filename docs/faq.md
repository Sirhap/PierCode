---
title: "PierCode FAQ — Connect ChatGPT, Claude & Gemini to Your Local Files"
description: "Answers to common questions about PierCode: how to let web AI assistants read local files, run commands, and automate the browser; supported platforms; security; and how it compares to MCP."
keywords: "PierCode FAQ, connect ChatGPT to local files, Claude run local commands, web AI local filesystem, AI coding agent browser, MCP alternative, Chrome extension AI tools"
---

# PierCode FAQ

Common questions about connecting web-based AI assistants to your local machine with PierCode.

## What is PierCode?

PierCode is an open-source local development tool that connects web-based AI assistants — ChatGPT, Claude, Gemini, Qwen, Kimi, and others — to your local filesystem and browser. It runs a sandboxed Go server on `127.0.0.1` and a Chrome (Manifest V3) extension. The AI prints tool calls in its replies; the extension detects them, asks for your approval, and proxies them to the local server, which executes file, shell, and browser operations and returns the results.

## How do I let ChatGPT or Claude read my local files?

Install the PierCode Chrome extension, start the local Go server pointed at your working directory, and open a supported AI page. When the AI emits a `piercode-tool` block (for example a `read_file` call), the extension shows an approval card; once you approve, the server reads the file inside the sandboxed directory and returns the contents to the chat.

## Which AI platforms are supported?

ChatGPT, Claude, Google Gemini, Google AI Studio, Qwen, Kimi, Chat Z, and Mimo. Support is added per site through a platform adapter plus a manifest match rule.

## Can the AI run shell commands?

Yes — through the `exec_cmd` tool, which runs inside the working-directory sandbox with path validation and a dangerous-command filter (`rm -rf`, `sudo`, `curl`, etc. are blocked). Shell execution can be disabled at launch with `--no-shell`. The command blacklist is a backstop, not a full sandbox.

## Is PierCode secure?

The server binds `127.0.0.1` only and requires a per-launch bearer token. File paths are resolved against the real path and validated to stay inside the working directory. Browser actions (click, type, upload, evaluate) require explicit user approval. That said, PierCode is not a hardened sandbox for untrusted prompts — only run it in directories you are willing to expose to the connected AI page.

## How is PierCode different from MCP (Model Context Protocol)?

MCP requires the AI client to support the protocol and connect to MCP servers directly. PierCode instead works with any web AI chat page through a browser extension — no client-side protocol support needed. The AI just prints tool-call blocks as visible text, and the extension bridges them to the local server. It is a practical alternative when you want a web AI chat to act like a local coding agent.

## Does it cost anything?

PierCode itself is free and open source, provided for learning and research use only (no commercial use). You bring your own AI subscription on whichever supported web platform you use.

## Where do I get it?

Source, releases, and build instructions are on [GitHub](https://github.com/Sirhap/PierCode). See the [documentation home](index.html) and the [development guide](development.html).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is PierCode?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "PierCode is an open-source local tool that connects web-based AI assistants (ChatGPT, Claude, Gemini, Qwen, Kimi) to your local filesystem and browser via a Chrome extension and a sandboxed Go server. The AI prints tool calls; the extension proxies them to a localhost server that executes them after your approval."
      }
    },
    {
      "@type": "Question",
      "name": "How do I let ChatGPT or Claude read my local files?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Install the PierCode Chrome extension, start the local Go server pointed at your working directory, and open a supported AI page. When the AI emits a read_file tool call, approve the card and the server returns the file contents inside the sandboxed directory."
      }
    },
    {
      "@type": "Question",
      "name": "Which AI platforms are supported?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "ChatGPT, Claude, Google Gemini, Google AI Studio, Qwen, Kimi, Chat Z, and Mimo."
      }
    },
    {
      "@type": "Question",
      "name": "Can the AI run shell commands?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes, via the exec_cmd tool, which runs inside the working-directory sandbox with path validation and a dangerous-command filter. Shell execution can be disabled at launch with --no-shell."
      }
    },
    {
      "@type": "Question",
      "name": "How is PierCode different from MCP?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "MCP requires the AI client to support the protocol and connect to MCP servers directly. PierCode works with any web AI chat page through a browser extension, with no client-side protocol support needed: the AI prints visible tool-call blocks and the extension bridges them to the local server."
      }
    }
  ]
}
</script>
