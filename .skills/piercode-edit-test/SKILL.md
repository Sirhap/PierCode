---
name: piercode-edit-test
description: PierCode editing workflow for inspect-edit-verify software changes with minimal diffs and focused tests.
---

# PierCode Edit And Test Workflow

Use this skill when implementing, fixing, refactoring, or documenting code through PierCode tools.

## Workflow

1. Inspect project guidance and entry points.
2. Search for relevant files and symbols.
3. Read surrounding code before editing.
4. Make minimal, focused changes.
5. Run the narrowest verification that proves the claim.
6. If verification fails, inspect the failure and iterate.
7. Report changed files, verification, and remaining risk.

## Editing Rules

- Match existing style, naming, layout, imports, test patterns, and error handling.
- Prefer existing utilities and local patterns over new abstractions.
- Do not add dependencies unless explicitly requested.
- Keep unrelated refactors out of scope.
- Use exact `edit` replacements when possible.
- Use `write_file` for new files or when whole-file replacement is clearly simpler and safer.
- Add comments only when they reduce real maintenance cost.

## Verification Selection

Use the smallest verification that proves the change, then broaden when risk requires it:

- Go unit or package tests for backend changes.
- `go test ./...` for shared backend behavior, tools, prompt rendering, or security changes.
- `npm test` and `npx tsc --noEmit` under `extension/` for extension parser, adapter, popup, or TypeScript changes.
- Build or smoke test when runtime wiring changes.

## Failure Handling

Do not report completion after failed verification. Read the failure, identify whether the implementation or test expectation is wrong, and continue fixing unless blocked by missing user input or authority.

