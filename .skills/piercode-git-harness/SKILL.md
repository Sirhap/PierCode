---
name: piercode-git-harness
description: Git workflow harness — branch resolution, safe commit/push/merge, and the destructive-action safety protocol. Load for any git branch, commit, push, merge, rebase, or PR work.
---

# PierCode Git Workflow Harness

Load this harness for git work: switching/creating branches, staging, committing, pushing, merging, rebasing, resolving conflicts, or opening PRs. Treat branch names, remotes, and repository state as discoverable project facts — inspect, do not guess.

## Git Safety Protocol (always)

These hold unless the user explicitly authorizes the exact action:

- NEVER update git config.
- NEVER skip hooks (`--no-verify`, `--no-gpg-sign`). If a hook fails, fix the underlying issue.
- NEVER run destructive/irreversible commands: `push --force`, `reset --hard`, `checkout .`, `restore .`, `clean -f`, `branch -D`, dropping stashes. When one is genuinely the best path and authorized, still prefer the least destructive variant.
- NEVER force-push to `main`/`master`; warn the user even if they ask.
- ALWAYS create a NEW commit. NEVER `git commit --amend` unless the user explicitly asks. A failed pre-commit hook means the commit did NOT happen — `--amend` would then rewrite the PREVIOUS commit and can destroy work. After a hook failure: fix, re-stage, create a new commit.
- NEVER use interactive flags: `git rebase -i`, `git add -i`, `git add -p` — they need a TTY that `exec_cmd` does not provide. Likewise do not pass `--no-edit` to `git rebase`.
- Do NOT commit files that likely hold secrets (`.env`, `credentials.json`, key files). If the user insists, warn first.
- Do NOT create an empty commit when there is nothing to commit.
- Stage files by name (`git add path/to/file`) rather than `git add -A` / `git add .`, so you do not sweep in secrets or large binaries.

## Inspect Before Acting

Before changing branches, merging, committing, pushing, resetting, or deleting branches, inspect state:

- `git status --short --branch` for working-tree + tracking state.
- `git remote -v` or branch tracking info before a push.
- `git log --oneline -10` before a commit, to match the repo's message style.

## Branch Resolution

If a requested checkout fails with `pathspec ... did not match`, do not immediately ask and do not retry the same command:

1. Run `git branch -a` and look for exact, suffix, or strong fuzzy matches (e.g. a request for `codex` may mean `codex/claude-web-ai-mcp`).
2. Exactly one strong local match → switch to it.
3. Exactly one strong remote-only match → create/switch to a local tracking branch.
4. Multiple plausible matches → use the `question` tool with concrete branch options.
5. No plausible match → report which branches you inspected and ask for the intended branch.

## Commit

Commit only when the user explicitly asked to commit.

1. Inspect `git status --short` and the diff. Use focused staging when the requested scope is narrower than the whole worktree.
2. Draft a concise message (1-2 sentences) focused on the "why", matching the repo's existing style. "add" = new feature, "update" = enhancement, "fix" = bug fix.
3. Pass the message via a HEREDOC so formatting survives:

```text
git commit -m "$(cat <<'EOF'
Commit message here.
EOF
)"
```

4. If the commit fails on a pre-commit hook: fix the issue, re-stage, create a NEW commit (never `--amend`).

## Push

Push only when the user explicitly asked to push. Inspect `git status --short --branch` and the remote tracking first. Never force-push to a shared branch.

## Merge / Rebase

Prefer the least destructive path. On conflicts: stop, report the conflicted files, and ask before choosing a resolution strategy. Resolve conflicts rather than discarding a side's changes.

## Pull Requests

Use `gh` for all GitHub work. Inspect `git diff <base>...HEAD` to see ALL commits on the branch, not just the latest. Keep PR titles under 70 characters; put detail in the body via HEREDOC. If a PR already exists for the branch (`gh pr view`), edit it rather than creating a duplicate. Return the PR URL when done.

## Escalation

Use the `question` tool when multiple branch targets are plausible, when a destructive action is requested, or when a merge conflict needs a strategy decision. Do not ask for facts you can inspect yourself.
