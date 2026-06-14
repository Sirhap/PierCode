# browser_batch Prompt Guidance — Design

**Date:** 2026-06-14
**Status:** Approved (design)
**Audit ref:** `docs/browser-tools-audit-2026-06.md` Top-10 #1 (the prompt-copy half)

## Background

The `browser_batch` meta-tool is already implemented and tested (commit
`610f13c`): it runs a sequence of `browser_*` calls in one round trip,
stops on first error, re-dispatches each item through the full
validate → approve → URL-guard → execute pipeline, forbids nesting, caps
at 25 actions, and is lock-domain compatible (`executor.go` special-cases
`browser_batch` to hold no outer lock so per-item locks don't deadlock).

Audit Top-10 #1 specified the tool **plus** prompt copy: *"能预测 2+ 步就用
batch" + 批内坐标不变式*. The tool shipped; the prompt copy did not. The
model is therefore never told `browser_batch` exists, when to use it, or
the in-batch coordinate rule — so a built tool goes unused.

This spec covers **only** that missing prompt copy (pure #1). The
adjacent anti-rabbit-hole guidance (audit #6) is explicitly out of scope
and left for the #6 prompt-copy pack.

## Goal

Make the model reach for `browser_batch` when it can predict 2+ browser
steps, and understand that coordinates/refs inside a batch must come from
a snapshot taken **before** the batch (the page is not re-observed between
actions).

## Scope

Single file: `prompts/init_prompt.txt`.

- `qwen_append.txt` / `worker_append.txt` are **appends** layered on top of
  the full `init_prompt.txt` — they contain no tool-selection / browser
  section, so they inherit §11 and need no change.
- The prompt is trusted only from the binary-embedded `DefaultPrompt`
  (`prompts/prompts.go` `//go:embed`), so editing the `.txt` is the only
  surface; no Go code changes.

## Change

In `prompts/init_prompt.txt` §11 ("Tool Selection And Failure Recovery"),
the current single browser line (≈207):

```
- browser page automation: `browser_*` tools
```

becomes a two-sentence entry carrying both audit points:

```
- browser page automation: `browser_*` tools. When you can predict 2+ browser steps ahead (e.g. click a field, type, then submit), chain them in ONE `browser_batch` call instead of separate turns — each web-chat tool call costs a full round trip. Coordinates and refs used inside a batch must come from a snapshot taken BEFORE the batch; the page is not re-observed between actions, so a later action cannot rely on an earlier action's visual result.
```

- Sentence 1 = **"预测 2+ 步就用 batch"** + the round-trip economics that
  motivate it.
- Sentence 2 = **批内坐标不变式** (the in-batch coordinate invariant).

Wording stays consistent with the tool's own `description` in
`browser_batch.go` (same "predict 2+ steps", "stop on first error is
implied by the tool", "snapshot before the batch") so the model gets one
coherent story from both the tool schema and the system prompt.

## Out of scope

- anti-rabbit-hole / dialog-deadlock / tab-lifecycle / file-upload copy
  (audit #6) — separate pack.
- image-passthrough of in-batch screenshots (audit #1's "图片穿插返回")
  depends on the vision return path (audit #8); not done standalone.
- Any change to `browser_batch.go` behavior or its tests.

## Verification

No new Go behavior, so no new Go test. Verify:

1. `go build ./...` — embed still compiles (the `.txt` is `//go:embed`-ed).
2. `go test ./internal/tool/ -run BrowserBatch` — unchanged, still green
   (sanity that nothing in the tool broke).
3. Manual read-back: the rendered prompt (`prompt.Render`) contains the new
   batch sentences. A lightweight assertion is possible if a prompt-render
   test exists; otherwise the embed + build check suffices since the copy
   is static text.

## Commit discipline

Working tree has 8 pre-existing unrelated `extension/src/*` changes.
Stage only `prompts/init_prompt.txt` and this spec — never `git add -A`.
