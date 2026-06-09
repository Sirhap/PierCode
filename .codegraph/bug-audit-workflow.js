export const meta = {
  name: 'piercode-bug-audit',
  description: 'Full-project per-file bug audit: shard → find → adversarial verify → synthesize',
  phases: [
    { title: 'Find', detail: 'one finder per module shard reads real source, emits candidate bugs' },
    { title: 'Verify', detail: 'blue-team refuters attack each candidate; survivors are real' },
    { title: 'Synthesize', detail: 'dedupe + severity-rank confirmed bugs' },
  ],
}

const ROOT = '/Volumes/other/IdeaProjects/sirhao/piercode'

// 14 balanced shards across Go + TS. Each shard lists concrete files so the
// finder reads REAL source (no summaries) and stays in its lane (no overlap).
const SHARDS = [
  { key: 'go-security-auth', files: [
    'internal/security/sandbox.go', 'internal/security/auth.go',
    'internal/browser/security.go', 'internal/portutil/portutil.go',
    'cmd/server/main.go',
  ]},
  { key: 'go-server-ws', files: [
    'internal/server/server.go', 'internal/server/ws.go',
  ]},
  { key: 'go-executor-tasks', files: [
    'internal/executor/executor.go', 'internal/executor/tasks.go',
  ]},
  { key: 'go-tool-edit-patch', files: [
    'internal/tool/edit.go', 'internal/tool/apply_patch.go',
    'internal/tool/multi_edit.go', 'internal/tool/undo.go',
  ]},
  { key: 'go-tool-fs', files: [
    'internal/tool/read_file.go', 'internal/tool/write_file.go',
    'internal/tool/list_dir.go', 'internal/tool/glob.go',
    'internal/tool/grep.go', 'internal/tool/move.go',
    'internal/tool/walk_exclude.go', 'internal/tool/truncate.go',
  ]},
  { key: 'go-tool-exec-misc', files: [
    'internal/tool/exec_cmd.go', 'internal/tool/command_semantics.go',
    'internal/tool/send_stdin.go', 'internal/tool/web_fetch.go',
    'internal/tool/skill.go', 'internal/tool/question.go',
    'internal/tool/question_pending.go', 'internal/tool/tool.go',
    'internal/tool/tool_help.go', 'internal/tool/error_hint.go',
    'internal/tool/invalid.go', 'internal/tool/registry.go',
  ]},
  { key: 'go-tool-agent-mem', files: [
    'internal/tool/agent_tools.go', 'internal/tool/agent_registry.go',
    'internal/tool/memory.go', 'internal/tool/todo_write.go',
    'internal/tool/todo_read.go', 'internal/tool/task_list.go',
    'internal/tool/task_output.go', 'internal/tool/task_stop.go',
    'internal/tool/attachment_pending.go', 'internal/memory/memory.go',
  ]},
  { key: 'go-browser-tools', files: [
    'internal/tool/browser_tools.go', 'internal/tool/browser_tools_ext.go',
    'internal/tool/browser_tools_find.go', 'internal/tool/browser_tools_state.go',
    'internal/tool/browser_tools_stability.go', 'internal/tool/snapshot.go',
  ]},
  { key: 'go-browser-core', files: [
    'internal/browser/controller.go', 'internal/browser/controller_ext.go',
    'internal/browser/controller_find.go', 'internal/browser/controller_state.go',
    'internal/browser/relay.go', 'internal/browser/registry.go',
  ]},
  { key: 'go-browser-events-prompt', files: [
    'internal/browser/events.go', 'internal/browser/snapshot.go',
    'internal/browser/approval.go', 'internal/browser/types.go',
    'internal/prompt/profile.go', 'internal/prompt/prompt.go',
    'internal/prompt/guidance.go', 'internal/skill/loader.go',
    'internal/logsink/sink.go', 'internal/procutil/output.go',
    'internal/procutil/command_unix.go', 'internal/procutil/command_windows.go',
  ]},
  { key: 'ts-content-core', files: [
    'extension/src/content/index.ts',
  ]},
  { key: 'ts-content-aux', files: [
    'extension/src/content/ws-linker.ts', 'extension/src/content/conversation-scope.ts',
    'extension/src/content/qwen-context-compress.ts', 'extension/src/content/qwen-context-packet-waiter.ts',
    'extension/src/content/qwen-settings.ts', 'extension/src/content/token-meter.ts',
    'extension/src/content/token-hud.ts', 'extension/src/content/status-panel.ts',
    'extension/src/content/visual-indicator.ts', 'extension/src/content/accessibility-tree.ts',
    'extension/src/content/auto-submit-settle.ts', 'extension/src/content/send-fallback.ts',
    'extension/src/content/destructive-warning.ts',
  ]},
  { key: 'ts-background-bridge', files: [
    'extension/src/background/index.ts', 'extension/src/background/chat-api.ts',
    'extension/src/background/browser-relay-utils.ts', 'extension/src/background/downloads.ts',
    'extension/src/background/frame-unlock.ts', 'extension/src/page-bridge/index.ts',
    'extension/src/page-bridge/api-intercept.ts', 'extension/src/injected/index.ts',
    'extension/src/parser.ts', 'extension/src/settings.ts',
  ]},
  { key: 'ts-hub-popup-sidebar', files: [
    'extension/src/hub/App.tsx', 'extension/src/hub/main.tsx',
    'extension/src/hub/pane-manager.ts', 'extension/src/hub/project-store.ts',
    'extension/src/hub/canvas/Canvas.tsx', 'extension/src/hub/canvas/CanvasNodeCard.tsx',
    'extension/src/hub/canvas/Edges.tsx', 'extension/src/hub/canvas/canvas-math.ts',
    'extension/src/hub/dashboard/OverviewBar.tsx', 'extension/src/hub/dashboard/ProjectDrawer.tsx',
    'extension/src/hub/dashboard/agent-store.ts', 'extension/src/hub/dashboard/hub-ws.ts',
    'extension/src/popup/App.tsx', 'extension/src/sidebar/App.tsx',
    'extension/src/sidebar/main.tsx',
    'extension/src/platform-adapters.ts', 'extension/src/platform-adapters/shared.ts',
    'extension/src/platform-adapters/qwen.ts', 'extension/src/platform-adapters/claude.ts',
    'extension/src/platform-adapters/chatgpt.ts', 'extension/src/platform-adapters/gemini.ts',
  ]},
]

const BUG_SCHEMA = {
  type: 'object',
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'relative path' },
          line: { type: 'string', description: 'line number or range, e.g. "123" or "120-135"' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string', description: 'e.g. nil-deref, race, security, logic, resource-leak, off-by-one' },
          title: { type: 'string', description: 'one-line summary' },
          root_cause: { type: 'string', description: 'why it is wrong, citing the code' },
          trigger: { type: 'string', description: 'concrete input/sequence that triggers it' },
          fix: { type: 'string', description: 'concrete fix' },
        },
        required: ['file', 'line', 'severity', 'category', 'title', 'root_cause', 'trigger', 'fix'],
      },
    },
  },
  required: ['bugs'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true if this is NOT a real bug (false positive)' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string', description: 'why refuted or why confirmed, citing real code' },
    corrected_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
  },
  required: ['refuted', 'confidence', 'reason', 'corrected_severity'],
}

const finderPrompt = (shard) => `You are a senior Go+TypeScript bug hunter auditing the PierCode project (a browser-local proxy: web AI emits tool calls → Chrome extension → local Go sandbox server executes them).

Project root: ${ROOT}

Read the FULL source of EACH of these files with the Read tool (read every line, not summaries):
${shard.files.map(f => `- ${ROOT}/${f}`).join('\n')}

You may also Read neighboring files or Grep for callers/definitions to confirm a suspicion — but only REPORT bugs in the files listed above (stay in your lane; another agent owns the rest).

Hunt for REAL, TRIGGERABLE bugs. Apply RCA (root-cause analysis) and be your own blue team. Look hard for:
- nil/null pointer derefs, unchecked type assertions, index out of range
- goroutine races, deadlocks, lock-scope errors, missing defer unlock, channel misuse
- resource leaks (unclosed files/conns/tickers/contexts, goroutine leaks)
- security: path traversal / sandbox escape, command injection, auth bypass, TOCTOU, missing origin/token checks, SSRF in web_fetch
- logic errors: off-by-one, wrong operator (< vs <=), inverted conditions, wrong default, swapped args
- error handling: ignored errors that matter, swallowed panics, wrong error returned
- concurrency in JS: stale closures, race on shared mutable state, missing await, unhandled promise rejection
- API misuse: wrong CDP params, wrong fetch options, SSE parse bugs, JSON shape mismatch
- integer overflow, string slicing on multibyte runes, regex catastrophic backtracking

Do NOT report: style nits, missing tests, naming, formatting, "could be refactored", speculative "might be slow". Only concrete bugs where you can name the trigger.

For each bug, cite the exact line and the exact code that is wrong. If you cannot point to a trigger, do not report it.

Return ALL bugs you find via the structured schema. Empty array if truly none. Be thorough — this shard (${shard.key}) is YOUR responsibility; a missed bug is on you.`

const refutePrompt = (bug) => `You are a skeptical blue-team reviewer. Your job is to REFUTE a claimed bug in the PierCode project. Default stance: this is a FALSE POSITIVE unless the code proves otherwise.

Project root: ${ROOT}

Claimed bug:
- file: ${bug.file}
- line: ${bug.line}
- severity: ${bug.severity}
- category: ${bug.category}
- title: ${bug.title}
- root_cause: ${bug.root_cause}
- trigger: ${bug.trigger}

Read the ACTUAL source at ${ROOT}/${bug.file} around line ${bug.line} (read enough surrounding context — function, callers, related guards). Use Grep to check whether a guard, validation, or caller-side check elsewhere already prevents this.

Then decide:
- Is the claimed trigger actually reachable? Or is there a guard upstream (validation, nil-check, SafePath, auth middleware, type check) that prevents it?
- Does the code actually do what the claim says? Re-read carefully — many "bugs" vanish on close reading.
- Is the severity right?

Set refuted=true if it is NOT a real triggerable bug (guard exists, misread code, unreachable, harmless). Set refuted=false ONLY if you confirmed by reading real code that the bug is real and triggerable. Cite the specific code (line + snippet) in your reason either way.`

// ── Run ──────────────────────────────────────────────────────────────────
phase('Find')
log(`Bug audit: ${SHARDS.length} shards, ${SHARDS.reduce((n, s) => n + s.files.length, 0)} files. Finder → 3x blue-team refute per candidate.`)

const perShard = await pipeline(
  SHARDS,
  (shard) => agent(finderPrompt(shard), {
    label: `find:${shard.key}`,
    phase: 'Find',
    schema: BUG_SCHEMA,
  }).then(r => ({ shard: shard.key, bugs: (r && r.bugs) || [] })),

  // Verify stage: each candidate bug gets 3 independent refuters in parallel.
  // Survives only if <2 of 3 refute it (majority must fail to refute).
  (found) => parallel((found.bugs).map(bug => () =>
    parallel([0, 1, 2].map(i => () =>
      agent(refutePrompt(bug), {
        label: `refute:${bug.file}:${bug.line}#${i}`,
        phase: 'Verify',
        schema: VERDICT_SCHEMA,
      })
    )).then(votes => {
      const valid = votes.filter(Boolean)
      const refutedCount = valid.filter(v => v.refuted).length
      const survives = valid.length > 0 && refutedCount < 2 // majority must NOT refute
      // pick the most common corrected severity among non-refuting verdicts
      const keepers = valid.filter(v => !v.refuted)
      const correctedSev = keepers.length
        ? keepers.map(v => v.corrected_severity).filter(s => s && s !== 'none')
        : []
      return {
        ...bug,
        shard: found.shard,
        verdict: {
          survives,
          refutedCount,
          totalVotes: valid.length,
          reasons: valid.map(v => v.reason),
          correctedSeverity: correctedSev[0] || bug.severity,
        },
      }
    })
  )).then(verified => ({ shard: found.shard, verified: verified.filter(Boolean) }))
)

phase('Synthesize')
const allVerified = perShard.filter(Boolean).flatMap(s => s.verified)
const confirmed = allVerified.filter(b => b.verdict.survives)
const rejected = allVerified.filter(b => !b.verdict.survives)

log(`Candidates: ${allVerified.length} | Confirmed (survived 3x refute): ${confirmed.length} | Rejected: ${rejected.length}`)

// Order: severity then file
const sevRank = { critical: 0, high: 1, medium: 2, low: 3 }
confirmed.sort((a, b) => {
  const sa = sevRank[a.verdict.correctedSeverity] ?? 9
  const sb = sevRank[b.verdict.correctedSeverity] ?? 9
  if (sa !== sb) return sa - sb
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0
})

return {
  summary: {
    shards: SHARDS.length,
    files: SHARDS.reduce((n, s) => n + s.files.length, 0),
    candidates: allVerified.length,
    confirmed: confirmed.length,
    rejected: rejected.length,
  },
  confirmed: confirmed.map(b => ({
    file: b.file, line: b.line,
    severity: b.verdict.correctedSeverity,
    category: b.category,
    title: b.title,
    root_cause: b.root_cause,
    trigger: b.trigger,
    fix: b.fix,
    refute_votes: `${b.verdict.refutedCount}/${b.verdict.totalVotes} refuted`,
    shard: b.shard,
  })),
  rejected: rejected.map(b => ({
    file: b.file, line: b.line, title: b.title,
    refute_votes: `${b.verdict.refutedCount}/${b.verdict.totalVotes} refuted`,
    sample_reason: b.verdict.reasons[0] || '',
  })),
}
