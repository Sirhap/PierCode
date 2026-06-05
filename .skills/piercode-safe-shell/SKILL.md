---
name: piercode-safe-shell
description: PierCode safe shell guidance for PowerShell, Windows paths, command risk, parent directory checks, and background process handling.
---

# PierCode Safe Shell

Use this skill when shell commands, PowerShell syntax, Windows paths, or command risk are central to the task.

## Command Selection

- Prefer PierCode file tools for reading, searching, editing, and writing files.
- Use `exec_cmd` only when it is listed in the available tools and a shell is actually needed.
- Keep commands bounded, explicit, and scoped to the current workspace.
- On Windows, quote paths with spaces and prefer PowerShell-native commands.
- Use UTF-8 output when Chinese text may appear.

## Safety Checks

- Before creating a new file or directory via shell, list or inspect the parent directory and confirm it is the intended location.
- Before deleting, moving, overwriting, or recursively changing files, inspect the exact target and ask if the action is destructive or broad.
- Avoid `git reset --hard`, `git checkout --`, force push, broad `Remove-Item -Recurse`, and bypass flags such as `--no-verify` unless explicitly authorized.
- If a sandbox or permission failure occurs, report the blocked action and use the narrowest safe alternative.

## Git Workflow Harness

- Treat Git state as inspectable context. Prefer `git status --short --branch`, `git branch -a`, and `git remote -v` before deciding what to do.
- For branch checkout requests, do not assume a short name is exact. If checkout fails, list branches and look for exact, suffix, or strong fuzzy matches such as `codex/*` when the user says `codex`.
- If one strong branch match exists locally, switch to it. If one strong match exists only under `remotes/origin/`, create or switch to a local tracking branch. If more than one plausible match exists, ask with `question` and include concrete branch choices.
- For commit and push requests, first inspect status and branch tracking. Commit or push only after the user explicitly asks for that externally visible action.
- For merges and rebases, stop on conflicts, report conflicted files, and ask before selecting a resolution. Do not discard worktree changes to make Git commands pass.

## Background Commands

- For long-running commands, use PierCode background task support when available.
- Check task status with `task_list` and output with `task_output`.
- Stop only the intended task with `task_stop`; do not kill unrelated processes.

## Reporting

When reporting command results, summarize the meaningful stdout/stderr. If a command failed, include the exit/failure reason and the next action taken.
