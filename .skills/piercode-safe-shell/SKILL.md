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

## Background Commands

- For long-running commands, use PierCode background task support when available.
- Check task status with `task_list` and output with `task_output`.
- Stop only the intended task with `task_stop`; do not kill unrelated processes.

## Reporting

When reporting command results, summarize the meaningful stdout/stderr. If a command failed, include the exit/failure reason and the next action taken.
