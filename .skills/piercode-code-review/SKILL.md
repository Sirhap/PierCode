---
name: piercode-code-review
description: PierCode code review workflow for diffs, regressions, removed safeguards, cross-file behavior, and test gaps.
---

# PierCode Code Review

Use this skill when reviewing changed code, PR-like diffs, or user-provided patches.

## Review Method

1. Inspect the diff or changed files first.
2. Read each touched function or component, not only the changed lines.
3. For replaced or deleted lines, identify the guard, invariant, fallback, or behavior they used to provide, then verify where the new code preserves it.
4. Trace changed public functions, route handlers, tools, parser helpers, and exported TypeScript functions to callers.
5. Check whether tests still cover the changed behavior, especially sandboxing, auth, command gating, DOM parsing, WebSocket flows, and prompt rendering.

## Finding Standards

- Lead with bugs, regressions, security issues, and missing verification.
- Ground each finding in a concrete path and line number.
- Separate evidence from inference when the impact is plausible but not proven.
- Do not report stylistic preferences unless they hide a real maintenance or behavior risk.
- If no issues are found, say so and mention any verification gaps.

## PierCode Hot Spots

- `internal/security`: path traversal, symlink resolution, token checks, dangerous command filtering.
- `internal/executor`: tool availability, concurrency locks, prompt reinjection, background tasks, streaming.
- `internal/tool`: validation, sandbox path use, command execution, file writes.
- `internal/server`: local-only binding, auth middleware, CORS/origin behavior, WebSocket events.
- `extension/src/platform-adapters.ts`: host DOM extraction and malformed tool-call normalization.
- `extension/src/content`: tool card rendering, manual execution, WebSocket connection, popup/editor behavior.
- `prompts/init_prompt.txt`: visible `piercode-tool` protocol, trust hierarchy, safe routing, and verification rules.

## Output

Use this shape:

```text
Findings
- severity path:line - issue and impact

Open questions / assumptions
- ...

Verification gaps
- ...
```
