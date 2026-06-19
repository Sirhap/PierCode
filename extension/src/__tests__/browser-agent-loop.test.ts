import { describe, expect, it, vi } from 'vitest';
import { runBrowserAgentLoop, classifyRisk } from '../background/browser-agent';

// Minimal LoopOpts builder: every IO is a DI seam, so we drive the loop purely
// in-memory with mocks. Defaults form a one-turn "AI replies with no tools →
// completed" happy path; tests override individual seams.
function makeOpts(over: Partial<Parameters<typeof runBrowserAgentLoop>[0]> = {}) {
  const ctrl = new AbortController();
  const emit = vi.fn();
  const base = {
    platform: 'chatgpt',
    task: 'do the thing',
    targetTabId: null as number | null,
    signal: ctrl.signal,
    emit,
    inject: vi.fn(async () => ({ ok: true })),
    awaitTools: vi.fn(async () => ({ tools: [], rawContent: '' })),
    exec: vi.fn(async (name: string, _args: Record<string, unknown>, callId?: string) => ({
      call_id: callId || 'c', name, output: 'ok', success: true,
    })),
    gate: vi.fn(async () => 'approve' as const),
    askQuestion: vi.fn(async () => 'yes'),
  };
  return { opts: { ...base, ...over }, emit, ctrl };
}

const terminalTypes = ['BROWSER_AGENT_DONE', 'BROWSER_AGENT_ERROR'];
function terminalEmits(emit: ReturnType<typeof vi.fn>) {
  return emit.mock.calls.map(c => c[0]).filter((m: { type: string }) => terminalTypes.includes(m.type));
}

describe('runBrowserAgentLoop lifecycle', () => {
  it('emits exactly one DONE(completed) when the AI replies with no tools', async () => {
    const { opts, emit } = makeOpts();
    const r = await runBrowserAgentLoop(opts);
    expect(r.reason).toBe('completed');
    const term = terminalEmits(emit);
    expect(term).toHaveLength(1);
    expect(term[0].type).toBe('BROWSER_AGENT_DONE');
    expect(term[0].reason).toBe('completed');
  });

  it('emits BROWSER_AGENT_ERROR and ends when inject fails (no silent death, unlocks input)', async () => {
    const { opts, emit } = makeOpts({
      inject: vi.fn(async () => ({ ok: false, error: 'bridge 未连接' })),
    });
    const r = await runBrowserAgentLoop(opts);
    expect(r.reason).toBe('tab-gone');
    const term = terminalEmits(emit);
    expect(term).toHaveLength(1);
    expect(term[0].type).toBe('BROWSER_AGENT_ERROR');
    expect(term[0].error).toContain('bridge');
  });

  it('returns stopped WITHOUT emitting when aborted before the first turn (finally must compensate)', async () => {
    const { opts, emit, ctrl } = makeOpts();
    ctrl.abort();
    const r = await runBrowserAgentLoop(opts);
    expect(r.reason).toBe('stopped');
    // By design the loop does not emit on the abort fast-path; the caller's
    // finally is responsible for the terminal DONE. Lock that the loop itself
    // stays silent so the caller's compensation is the single source of truth.
    expect(terminalEmits(emit)).toHaveLength(0);
  });

  it('returns stopped without emit when awaitTools rejects due to abort', async () => {
    const { opts, emit, ctrl } = makeOpts({
      awaitTools: vi.fn(async () => {
        ctrl.abort();
        throw new Error('aborted');
      }),
    });
    const r = await runBrowserAgentLoop(opts);
    expect(r.reason).toBe('stopped');
    expect(terminalEmits(emit)).toHaveLength(0);
  });

  it('runs a tool turn: emits TOOL → TOOL_DONE → then DONE on the follow-up empty reply', async () => {
    let turn = 0;
    const { opts, emit } = makeOpts({
      awaitTools: vi.fn(async () => {
        turn += 1;
        if (turn === 1) {
          return { tools: [{ name: 'browser_snapshot', args: {}, call_id: 'k1' }], rawContent: '' };
        }
        return { tools: [], rawContent: 'done' };
      }),
    });
    const r = await runBrowserAgentLoop(opts);
    expect(r.reason).toBe('completed');
    const types = emit.mock.calls.map(c => c[0].type);
    expect(types).toContain('BROWSER_AGENT_TOOL');
    expect(types).toContain('BROWSER_AGENT_TOOL_DONE');
    // exactly one terminal, and it is the final DONE
    expect(terminalEmits(emit)).toHaveLength(1);
    expect(types[types.length - 1]).toBe('BROWSER_AGENT_DONE');
  });

  it('tolerates a slow inject (bridge-port wait) and still completes the turn', async () => {
    // Mirrors the production fix where injectTurn now polls for a bridge port with
    // backoff before resolving, so inject() may resolve after a delay rather than
    // failing immediately. The loop must not treat that latency as fatal.
    let turn = 0;
    const { opts, emit } = makeOpts({
      inject: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 20)); // simulate port-wait backoff
        return { ok: true };
      }),
      awaitTools: vi.fn(async () => {
        turn += 1;
        if (turn === 1) {
          return { tools: [{ name: 'browser_snapshot', args: {}, call_id: 'k1' }], rawContent: '' };
        }
        return { tools: [], rawContent: 'done' };
      }),
    });
    const r = await runBrowserAgentLoop(opts);
    expect(r.reason).toBe('completed');
    const types = emit.mock.calls.map(c => c[0].type);
    expect(types).toContain('BROWSER_AGENT_TOOL');
    expect(terminalEmits(emit)).toHaveLength(1);
  });

  it('emits ERROR (never silent hang) when inject keeps failing after the port wait', async () => {
    // After waitForBridgePort exhausts its budget the production inject resolves
    // { ok:false }; the loop must surface exactly one ERROR and end, unlocking UI.
    const { opts, emit } = makeOpts({
      inject: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 10));
        return { ok: false, error: 'bridge 未连接，已等待 25s' };
      }),
    });
    const r = await runBrowserAgentLoop(opts);
    expect(r.reason).toBe('tab-gone');
    const term = terminalEmits(emit);
    expect(term).toHaveLength(1);
    expect(term[0].type).toBe('BROWSER_AGENT_ERROR');
    expect(term[0].error).toContain('bridge');
  });

  it('routes a question tool to askQuestion (not exec) and feeds the answer back', async () => {
    const askQuestion = vi.fn(async () => '账号 A');
    const exec = vi.fn(async (name: string, _a: Record<string, unknown>, callId?: string) => ({
      call_id: callId || 'c', name, output: 'ok', success: true,
    }));
    let turn = 0;
    const awaitTools = vi.fn(async () => {
      turn++;
      // First turn: AI asks a question. Second turn: natural-language finish.
      if (turn === 1) return { tools: [{ name: 'question', args: { question: '登录哪个账号？', options: ['账号 A', '账号 B'] }, call_id: 'q1' }], rawContent: '' };
      return { tools: [], rawContent: 'done' };
    });
    const { opts, emit } = makeOpts({ askQuestion, exec, awaitTools });
    const r = await runBrowserAgentLoop(opts);
    expect(r.reason).toBe('completed');
    // question went to askQuestion, NOT exec
    expect(askQuestion).toHaveBeenCalledWith('q1', '登录哪个账号？', ['账号 A', '账号 B']);
    expect(exec).not.toHaveBeenCalledWith('question', expect.anything(), expect.anything());
    // a TOOL + TOOL_DONE pair was emitted for the question
    const types = emit.mock.calls.map(c => c[0]);
    const qDone = types.find((m: { type: string; name?: string }) => m.type === 'BROWSER_AGENT_TOOL_DONE' && m.name === 'question');
    expect(qDone).toBeTruthy();
    expect(qDone.output).toContain('账号 A');
  });

  it('classifyRisk still gates high-risk actions (cross-origin nav, submit, evaluate)', () => {
    expect(classifyRisk('browser_navigate', { url: 'https://evil.test/' }, undefined, 'https://chatgpt.com').highRisk).toBe(true);
    expect(classifyRisk('browser_type', { submit: true }).highRisk).toBe(true);
    expect(classifyRisk('browser_evaluate', {}).highRisk).toBe(true);
    expect(classifyRisk('browser_navigate', { url: 'https://chatgpt.com/x' }, undefined, 'https://chatgpt.com').highRisk).toBe(false);
  });

  // Bug #19: navigate with unknown current origin must NOT be auto-allowed.
  it('gates navigate when the controlled-page origin is unknown (Bug #19)', () => {
    // No currentOrigin supplied → previously short-circuited to safe; now gated.
    expect(classifyRisk('browser_navigate', { url: 'https://evil.test/' }).highRisk).toBe(true);
    expect(classifyRisk('browser_navigate', { url: 'https://evil.test/' }, undefined, '').highRisk).toBe(true);
  });

  // Bug #13: a mark-based click has no ref/selector text, so destructive-text
  // detection can't run — it must be gated, not silently classified safe.
  it('gates mark-based clicks with unknown label (Bug #13)', () => {
    expect(classifyRisk('browser_click', { mark: 5 }).highRisk).toBe(true);
    // ref/selector clicks with benign text stay low-risk.
    expect(classifyRisk('browser_click', { selector: '#ok' }).highRisk).toBe(false);
  });

  // Bug #20/#1: previously-ungated mutating tools now classified high-risk;
  // phantom tool names removed (only real registry names gate).
  it('gates cookie/clipboard/dialog/storage/upload mutating tools (Bug #20)', () => {
    expect(classifyRisk('browser_set_cookie', {}).highRisk).toBe(true);
    expect(classifyRisk('browser_clipboard', {}).highRisk).toBe(true);
    expect(classifyRisk('browser_handle_dialog', {}).highRisk).toBe(true);
    expect(classifyRisk('browser_storage', {}).highRisk).toBe(true);
    expect(classifyRisk('browser_upload', {}).highRisk).toBe(true);
    // phantom names that are NOT real tools fall through to safe (default).
    expect(classifyRisk('browser_exec', {}).highRisk).toBe(false);
    expect(classifyRisk('browser_file_input', {}).highRisk).toBe(false);
  });

  it('gates form_input/select/drag page-mutators on the sidebar route (were unprompted)', () => {
    // These are in the content route's APPROVAL_TOOLS; classifyRisk must also flag them
    // or the browser-agent (which sets skipApproval) runs them with NO user approval.
    expect(classifyRisk('browser_form_input', { selector: '#name', value: 'x' }).highRisk).toBe(true);
    expect(classifyRisk('browser_select', { selector: '#s', value: 'a' }).highRisk).toBe(true);
    expect(classifyRisk('browser_drag', { fromSelector: '#a', toSelector: '#b' }).highRisk).toBe(true);
  });
});
