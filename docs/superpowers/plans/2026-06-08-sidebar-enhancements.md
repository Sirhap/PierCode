# Sidebar Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring four content-script enhancements into the standalone sidebar chat client: accurate token panel, `@@` agent completion, conversation persistence, and recursive sub-agents.

**Architecture:** The sidebar (`extension/src/sidebar/`) is a standalone API chat client; `background/chat-api.ts` drives the SSE stream and tool exec. Sidebar is a separate Vite ESM entry, so it can `import` content-script pure modules (`content/token-meter.ts`, `content/qwen-context-compress.ts`) that classic content scripts cannot. New logic is isolated into focused modules (`session-store.ts`) and a reused generic `Picker`. Sub-agents are recursive sub-conversations (new chatId + worker prompt), not browser tabs.

**Tech Stack:** TypeScript, React 18, Vite, Vitest (jsdom, `pool: 'threads'`), Chrome MV3 (`chrome.storage.local`, `chrome.cookies`), `js-tiktoken`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/sidebar/token-panel.tsx` | (modify) Token meter UI — delegate counting to `content/token-meter.ts`, add accuracy badge + compression-threshold marker + cost |
| `src/sidebar/Picker.tsx` | (modify) Generic picker — fix `key` collision so agent/template items with dup values render |
| `src/sidebar/agent-templates.ts` | (create) Built-in `@@` task templates constant |
| `src/sidebar/session-store.ts` | (create) Conversation persistence: load/save/list/delete/switch over `chrome.storage.local` |
| `src/sidebar/App.tsx` | (modify) `@@` completion branch; wire session-store + multi-session dropdown; subAgents state + sub-agent tool cards; `CHAT_AGENT_*` listener branches |
| `src/background/chat-api.ts` | (modify) Intercept `spawn_agent` locally; `runSubAgent` recursive orchestration; `CHAT_AGENT_*` broadcasts; cached worker-prompt fetch |
| `src/__tests__/sidebar-token-panel.test.tsx` | (create) Token panel tests |
| `src/__tests__/sidebar-completions.test.ts` | (create) `@@`/`@`/`/` dispatch tests |
| `src/__tests__/sidebar-session-store.test.ts` | (create) Persistence tests |
| `src/__tests__/sidebar-subagent.test.ts` | (create) Recursive sub-agent tests |

**Test environment note:** This repo sets no global vitest `environment`. `.tsx` component tests construct their own `JSDOM` and install a `chrome` mock manually — follow `src/__tests__/popup-advanced-options.test.tsx`. Pure-logic `.ts` tests need no DOM. The `js-tiktoken` mock MUST use `vi.mock('js-tiktoken', ...)` at top of file (see `src/__tests__/token-meter.test.ts`); do not change `pool: 'threads'` in `vite.config.ts` — forks pool breaks that mock.

**Reused token-meter API** (from `src/content/token-meter.ts`, already exported):
- `countTokens(text: string, platform?: string): number`
- `computeMeter(ctx: ConversationContext, platform?: string): TokenMeter` where `TokenMeter = { input, output, total, accuracy }`
- `platformAccuracy(platform: string, state: LoadState): TokenAccuracy` (`'exact'|'approx'|'estimate'`)
- `tokenizerState(): LoadState` (`'idle'|'loading'|'ready'|'failed'`)
- `whenTokenizerReady(): Promise<void>`
- `PLATFORM_TOKEN_FACTOR: Record<string, number>`
- `__resetTokenizerForTest(): void`
- `ConversationContext` (from `content/qwen-context-compress`): `{ messages: {role, content}[], totalChars, lastCompressedAt }`

**Reused thresholds** (from `src/content/qwen-settings.ts`): `DEFAULT_PLATFORM_THRESHOLDS: Record<string, number>`.

---

## Task 1: Token panel — delegate counting to token-meter

**Files:**
- Modify: `src/sidebar/token-panel.tsx`
- Test: `src/__tests__/sidebar-token-panel.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/sidebar-token-panel.test.tsx`:

```tsx
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import TokenPanel from '../sidebar/token-panel';
import { __resetTokenizerForTest } from '../content/token-meter';

// Deterministic tokenizer: 1 token per 4 chars.
vi.mock('js-tiktoken', () => ({
  getEncoding: vi.fn(() => ({ encode: (t: string) => new Array(Math.ceil(t.length / 4)).fill(0) })),
}));

let dom: JSDOM;
let root: Root | null;
let host: HTMLElement;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  (globalThis as any).window = dom.window as any;
  (globalThis as any).document = dom.window.document;
  host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  __resetTokenizerForTest();
});

describe('sidebar TokenPanel', () => {
  it('renders an estimate badge before the tokenizer loads', () => {
    act(() => {
      root!.render(
        <TokenPanel
          messages={[{ role: 'user', content: 'hello world' }]}
          platform="qwen"
        />,
      );
    });
    expect(host.textContent).toContain('estimate');
  });

  it('counts user content as input and assistant content as output', () => {
    act(() => {
      root!.render(
        <TokenPanel
          messages={[
            { role: 'user', content: 'aaaa' },
            { role: 'assistant', content: 'bbbbbbbb' },
          ]}
          platform="chatgpt"
        />,
      );
    });
    // Char-estimate fallback (tokenizer not awaited): input>0, output>0, both shown.
    expect(host.textContent).toMatch(/Input/);
    expect(host.textContent).toMatch(/Output/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/sidebar-token-panel.test.tsx`
Expected: FAIL — current `token-panel.tsx` has no accuracy badge text `estimate` driven by tokenizer state (it hardcodes `estimate` so the first test may pass, but the import of `__resetTokenizerForTest` + delegation does not exist yet; if both pass, proceed — the real change is verified in Step 3 diff).

- [ ] **Step 3: Rewrite token-panel.tsx to delegate counting**

Replace the entire contents of `src/sidebar/token-panel.tsx` with:

```tsx
import { useEffect, useMemo, useState } from 'react'
import {
  computeMeter,
  platformAccuracy,
  tokenizerState,
  whenTokenizerReady,
  type TokenAccuracy,
} from '../content/token-meter'
import type { ConversationContext } from '../content/qwen-context-compress'
import { DEFAULT_PLATFORM_THRESHOLDS } from '../content/qwen-settings'

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool_result' | 'system'
  content: string
}

interface TokenPanelProps {
  messages: ChatMessage[]
  threshold?: number
  platform?: string
}

// Rough per-1M-token USD price for cost estimate (input+output blended, conservative).
const PRICE_PER_1M: Record<string, number> = {
  qwen: 0.5,
  chatgpt: 5,
  claude: 6,
  openai: 5,
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const ACCURACY_STYLE: Record<TokenAccuracy, string> = {
  exact: 'text-emerald-400',
  approx: 'text-amber-400',
  estimate: 'text-gray-500',
}

export default function TokenPanel({ messages, threshold, platform = 'qwen' }: TokenPanelProps) {
  // Re-render once the lazy tokenizer finishes loading so counts upgrade from
  // estimate → exact/approx without a user action.
  const [, setReady] = useState(tokenizerState())
  useEffect(() => {
    let alive = true
    whenTokenizerReady().then(() => { if (alive) setReady(tokenizerState()) })
    return () => { alive = false }
  }, [])

  const meter = useMemo(() => {
    const ctx: ConversationContext = {
      messages: messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
      totalChars: messages.reduce((s, m) => s + m.content.length, 0),
      lastCompressedAt: 0,
    }
    return computeMeter(ctx, platform)
  }, [messages, platform])

  const accuracy = platformAccuracy(platform, tokenizerState())
  const effectiveThreshold = threshold || DEFAULT_PLATFORM_THRESHOLDS[platform] || 128_000
  const ratio = meter.total / effectiveThreshold
  const pct = Math.min(100, Math.round(ratio * 100))

  const barColor = ratio >= 1 ? 'bg-red-500' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-emerald-500'
  const dotColor = ratio >= 1 ? 'bg-red-400' : ratio >= 0.8 ? 'bg-amber-400' : 'bg-emerald-400'

  const price = PRICE_PER_1M[platform]
  const cost = price ? (meter.total / 1_000_000) * price : 0

  return (
    <div className="px-3 py-1.5 border-t border-gray-800/40 bg-gray-950 flex-shrink-0">
      <div className="flex items-center gap-3 text-[10px] text-gray-500 mb-1">
        <span>Input <span className="text-gray-400">{fmt(meter.input)}</span></span>
        <span>Output <span className="text-gray-400">{fmt(meter.output)}</span></span>
        <span className="font-semibold text-gray-300">Total {fmt(meter.total)}</span>
        <span className="ml-auto">{fmt(effectiveThreshold)}</span>
      </div>
      {/* Progress bar with compression-threshold marker at 100% (bar maxes at threshold). */}
      <div className="relative h-1 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <span className="text-[9px] text-gray-600">{pct}%</span>
        <span className={`text-[9px] ${ACCURACY_STYLE[accuracy]}`}>· {accuracy}</span>
        {cost > 0 && <span className="text-[9px] text-gray-600">· ~${cost.toFixed(3)}</span>}
        {ratio >= 0.8 && <span className="text-[9px] text-amber-500 ml-auto">将压缩</span>}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/__tests__/sidebar-token-panel.test.tsx`
Expected: PASS

- [ ] **Step 5: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors (resolves `content/token-meter`, `qwen-settings` imports).

- [ ] **Step 6: Commit**

```bash
git add extension/src/sidebar/token-panel.tsx extension/src/__tests__/sidebar-token-panel.test.tsx
git commit -m "feat(sidebar): real tiktoken token panel with accuracy badge + cost"
```

---

## Task 2: Picker key fix (allow dup values across modes)

**Files:**
- Modify: `src/sidebar/Picker.tsx:70`

The Picker keys rows on `item.value`. Agent items and template items may share a value (e.g. a label used as both). React dup-key warnings + render skips result. Key on index+value instead.

- [ ] **Step 1: Apply the fix**

In `src/sidebar/Picker.tsx`, change the row `key`:

```tsx
            key={`${i}-${item.value}`}
```

(replacing `key={item.value}`)

- [ ] **Step 2: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add extension/src/sidebar/Picker.tsx
git commit -m "fix(sidebar): key picker rows on index to allow dup values"
```

---

## Task 3: Agent templates constant

**Files:**
- Create: `src/sidebar/agent-templates.ts`

- [ ] **Step 1: Create the module**

Create `src/sidebar/agent-templates.ts`:

```ts
import type { PickerItem } from './Picker'

/**
 * Built-in @@ task templates. Selecting one inserts a sub-task instruction that
 * nudges the main AI to emit a spawn_agent piercode-tool block. `value` is the
 * text inserted into the input (replacing the @@token); `label`/`sub` are display.
 */
export const AGENT_TEMPLATES: PickerItem[] = [
  {
    label: '@@review',
    sub: '审查最近改动的代码',
    value: '请派一个子 agent 审查当前改动的代码，找出 bug、风格问题与改进点，汇总结论。',
  },
  {
    label: '@@test',
    sub: '运行测试并修复失败',
    value: '请派一个子 agent 运行项目测试，若有失败逐项定位并修复，报告结果。',
  },
  {
    label: '@@explore',
    sub: '探索代码库结构',
    value: '请派一个子 agent 探索代码库结构，梳理关键模块、入口与数据流，输出地图。',
  },
]

/** Filter templates by the text typed after @@ (case-insensitive substring on label/sub). */
export function filterAgentTemplates(query: string): PickerItem[] {
  if (!query) return AGENT_TEMPLATES
  const q = query.toLowerCase()
  return AGENT_TEMPLATES.filter(
    t => t.label.toLowerCase().includes(q) || (t.sub || '').toLowerCase().includes(q),
  )
}
```

- [ ] **Step 2: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add extension/src/sidebar/agent-templates.ts
git commit -m "feat(sidebar): @@ agent task templates"
```

---

## Task 4: `@@` completion dispatch (extract + branch ordering)

The `@@` regex MUST be tested before `@files`, because `@([^\s]*)$` matches `@@review` as `@review`. We extract the dispatch into a pure function so it is unit-testable without the React component.

**Files:**
- Create: `src/sidebar/completions.ts`
- Test: `src/__tests__/sidebar-completions.test.ts`
- Modify: `src/sidebar/App.tsx` (use the extracted classifier)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/sidebar-completions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyCompletion } from '../sidebar/completions';

describe('classifyCompletion', () => {
  it('classifies a trailing /skill token', () => {
    expect(classifyCompletion('do /rev')).toEqual({ mode: 'skills', token: '/rev', query: 'rev' });
  });

  it('classifies @@ before @ (agents, not files)', () => {
    expect(classifyCompletion('ping @@rev')).toEqual({ mode: 'agents', token: '@@rev', query: 'rev' });
  });

  it('classifies a bare @file token', () => {
    expect(classifyCompletion('open @src/a')).toEqual({ mode: 'files', token: '@src/a', query: 'src/a' });
  });

  it('returns null when no trailing trigger', () => {
    expect(classifyCompletion('hello world')).toBeNull();
  });

  it('empty @@ yields empty query', () => {
    expect(classifyCompletion('@@')).toEqual({ mode: 'agents', token: '@@', query: '' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/sidebar-completions.test.ts`
Expected: FAIL — `classifyCompletion` not defined.

- [ ] **Step 3: Create the classifier**

Create `src/sidebar/completions.ts`:

```ts
export type CompletionMode = 'skills' | 'files' | 'agents'

export interface CompletionMatch {
  mode: CompletionMode
  token: string  // exact trailing token incl. trigger, e.g. "@@rev"
  query: string  // text after the trigger
}

/**
 * Classify the trailing trigger of an input string.
 * Order matters: @@ (agents) is tested BEFORE @ (files), because the @files
 * regex would otherwise swallow @@x as @x.
 */
export function classifyCompletion(text: string): CompletionMatch | null {
  const slash = text.match(/(?:^|\s)(\/([\w-]*))$/)
  if (slash) return { mode: 'skills', token: slash[1], query: slash[2] }

  const atAt = text.match(/(@@([\w-]*))$/)
  if (atAt) return { mode: 'agents', token: atAt[1], query: atAt[2] }

  const at = text.match(/(@([^\s@]*))$/)
  if (at) return { mode: 'files', token: at[1], query: at[2] }

  return null
}
```

Note: the `@files` regex uses `[^\s@]*` (excludes `@`) so a stray earlier `@` in the same word doesn't merge; the `@@` branch already handled the double case.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/__tests__/sidebar-completions.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Wire classifier into App.tsx**

In `src/sidebar/App.tsx`, replace the body of `updateCompletions` (the `slashMatch` + `atMatch` logic) so it first calls `classifyCompletion`. Add at top of file:

```tsx
import { classifyCompletion } from './completions'
import { filterAgentTemplates } from './agent-templates'
```

Replace the `updateCompletions` function (currently starting `const updateCompletions = useCallback(async (text: string) => {`) with:

```tsx
  const updateCompletions = useCallback(async (text: string) => {
    const match = classifyCompletion(text)
    if (!match) {
      setPickerMode(null)
      setPickerItems([])
      return
    }
    setPickerToken(match.token)

    if (match.mode === 'skills') {
      setPickerMode('skills')
      const now = Date.now()
      if (skillsCacheRef.current && now - skillsCacheRef.current.ts < 30_000) {
        setPickerItems(skillsCacheRef.current.items.filter(
          item => item.label.includes(match.query) || (item.sub || '').includes(match.query)))
        return
      }
      const auth = await getAuth()
      if (!auth) return
      try {
        const res = await bgFetch(`${auth.apiUrl}/skills`, { headers: { Authorization: `Bearer ${auth.token}` } })
        const data = JSON.parse(res.text)
        const skills: PickerItem[] = (data.skills || [])
          .filter((s: any) => !s.name?.startsWith('piercode-'))
          .map((s: any) => ({ label: s.name, sub: s.description, value: s.name }))
        skillsCacheRef.current = { ts: now, items: skills }
        setPickerItems(skills.filter(item => item.label.includes(match.query) || (item.sub || '').includes(match.query)))
      } catch {
        setPickerItems([])
      }
      return
    }

    if (match.mode === 'agents') {
      setPickerMode('agents')
      const active: PickerItem[] = subAgents
        .filter(a => a.status === 'running')
        .map(a => ({ label: `@${a.label}`, sub: `运行中 · ${a.task.slice(0, 24)}`, value: `@${a.label} ` }))
      const templates = filterAgentTemplates(match.query)
      setPickerItems([...active, ...templates])
      return
    }

    // files
    setPickerMode('files')
    const auth = await getAuth()
    if (!auth) return
    try {
      const res = await bgFetch(`${auth.apiUrl}/files?q=${encodeURIComponent(match.query)}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      const data = JSON.parse(res.text)
      const files: string[] = data.files || []
      setPickerItems(files.slice(0, 20).map(f => ({ label: f, value: f })))
    } catch {
      setPickerItems([])
    }
  }, [subAgents])
```

Also widen the `pickerMode` state type. Find:

```tsx
  const [pickerMode, setPickerMode] = useState<'skills' | 'files' | null>(null)
```

Replace with:

```tsx
  const [pickerMode, setPickerMode] = useState<'skills' | 'files' | 'agents' | null>(null)
```

And in `handlePickerSelect`, add an `agents` branch (insert before the closing of the function, alongside the existing `files` branch):

```tsx
    } else if (pickerMode === 'agents') {
      setInput(prev => prev.replace(new RegExp(escapeRegExp(pickerToken) + '$'), item.value))
```

> `subAgents` state is introduced in Task 6. Until Task 6 lands, add a temporary `const subAgents: { label: string; task: string; status: string }[] = []` near the other `useState` declarations so this task type-checks; Task 6 replaces it with real state. (If executing in order, do Task 6's state addition first — see Task 6 Step 3.)

- [ ] **Step 6: Type-check + run completions test**

Run: `cd extension && npx tsc --noEmit && npx vitest run src/__tests__/sidebar-completions.test.ts`
Expected: no type errors; tests PASS.

- [ ] **Step 7: Commit**

```bash
git add extension/src/sidebar/completions.ts extension/src/sidebar/App.tsx extension/src/__tests__/sidebar-completions.test.ts
git commit -m "feat(sidebar): @@ agent completion with correct trigger ordering"
```

---

## Task 5: Session persistence store

**Files:**
- Create: `src/sidebar/session-store.ts`
- Test: `src/__tests__/sidebar-session-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/sidebar-session-store.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  setActiveSessionId,
  getActiveSessionId,
  type StoredSession,
} from '../sidebar/session-store';

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string[] | string) => {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.map(n => [n, store[n]]));
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(store, obj); }),
        remove: vi.fn(async (keys: string[] | string) => {
          const names = Array.isArray(keys) ? keys : [keys];
          for (const n of names) delete store[n];
        }),
      },
    },
  };
});

function mk(id: string, firstUser: string): StoredSession {
  return {
    id,
    platform: 'qwen',
    model: 'qwen3.7-plus',
    chatId: null,
    lastResponseId: null,
    messages: [{ role: 'user', content: firstUser }],
    ts: 1,
  };
}

describe('session-store', () => {
  it('saves a session and lists its metadata with a derived title', async () => {
    await saveSession(mk('s1', 'fix the auth bug please'));
    const list = await listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('s1');
    expect(list[0].title).toBe('fix the auth bug please');
  });

  it('truncates long titles to 30 chars', async () => {
    await saveSession(mk('s2', 'x'.repeat(50)));
    const list = await listSessions();
    expect(list[0].title.length).toBeLessThanOrEqual(30);
  });

  it('loads a saved session back by id', async () => {
    const s = mk('s3', 'hi');
    await saveSession(s);
    const got = await loadSession('s3');
    expect(got?.messages[0].content).toBe('hi');
  });

  it('deletes a session and removes it from the list', async () => {
    await saveSession(mk('s4', 'a'));
    await saveSession(mk('s5', 'b'));
    await deleteSession('s4');
    const list = await listSessions();
    expect(list.map(m => m.id)).toEqual(['s5']);
    expect(await loadSession('s4')).toBeNull();
  });

  it('tracks the active session id', async () => {
    await setActiveSessionId('s6');
    expect(await getActiveSessionId()).toBe('s6');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/sidebar-session-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement session-store.ts**

Create `src/sidebar/session-store.ts`:

```ts
/**
 * Conversation persistence for the sidebar chat client.
 *
 * Storage layout (chrome.storage.local):
 *   sidebarSessions          → SessionMeta[]   (light index, always loaded)
 *   sidebar_session_<id>     → StoredSession   (full per-session payload)
 *   sidebarActiveSessionId   → string          (current session id)
 */

export interface StoredMessage {
  role: 'user' | 'assistant' | 'tool_result' | 'system'
  content: string
}

export interface StoredSession {
  id: string
  platform: string
  model: string
  chatId: string | null
  lastResponseId: string | null
  messages: StoredMessage[]
  ts: number
}

export interface SessionMeta {
  id: string
  title: string
  platform: string
  ts: number
}

const INDEX_KEY = 'sidebarSessions'
const ACTIVE_KEY = 'sidebarActiveSessionId'
const sessionKey = (id: string) => `sidebar_session_${id}`

function deriveTitle(s: StoredSession): string {
  const firstUser = s.messages.find(m => m.role === 'user')
  const raw = (firstUser?.content || '新对话').trim().replace(/\s+/g, ' ')
  return raw.slice(0, 30)
}

export async function listSessions(): Promise<SessionMeta[]> {
  const got = await chrome.storage.local.get([INDEX_KEY])
  const list = got[INDEX_KEY]
  return Array.isArray(list) ? (list as SessionMeta[]) : []
}

export async function saveSession(s: StoredSession): Promise<void> {
  await chrome.storage.local.set({ [sessionKey(s.id)]: s })
  const list = await listSessions()
  const meta: SessionMeta = { id: s.id, title: deriveTitle(s), platform: s.platform, ts: s.ts }
  const idx = list.findIndex(m => m.id === s.id)
  if (idx >= 0) list[idx] = meta
  else list.unshift(meta)
  await chrome.storage.local.set({ [INDEX_KEY]: list })
}

export async function loadSession(id: string): Promise<StoredSession | null> {
  const got = await chrome.storage.local.get([sessionKey(id)])
  const s = got[sessionKey(id)]
  return s ? (s as StoredSession) : null
}

export async function deleteSession(id: string): Promise<void> {
  await chrome.storage.local.remove([sessionKey(id)])
  const list = (await listSessions()).filter(m => m.id !== id)
  await chrome.storage.local.set({ [INDEX_KEY]: list })
}

export async function setActiveSessionId(id: string): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_KEY]: id })
}

export async function getActiveSessionId(): Promise<string | null> {
  const got = await chrome.storage.local.get([ACTIVE_KEY])
  return typeof got[ACTIVE_KEY] === 'string' ? got[ACTIVE_KEY] : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/__tests__/sidebar-session-store.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/sidebar/session-store.ts extension/src/__tests__/sidebar-session-store.test.ts
git commit -m "feat(sidebar): conversation persistence store"
```

---

## Task 6: Wire persistence + subAgents state into App

**Files:**
- Modify: `src/sidebar/App.tsx`

- [ ] **Step 1: Add imports + state**

At top of `src/sidebar/App.tsx`, add:

```tsx
import {
  saveSession, loadSession, listSessions, deleteSession,
  getActiveSessionId, setActiveSessionId,
  type SessionMeta, type StoredSession,
} from './session-store'
```

Inside `App()`, near the other `useState` calls, add (and REMOVE the temporary `subAgents` stub from Task 4 Step 5):

```tsx
  interface SubAgent {
    id: string
    label: string
    task: string
    status: 'running' | 'done' | 'error'
    messages: ChatMessage[]
  }
  const [subAgents, setSubAgents] = useState<SubAgent[]>([])
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const sessionIdRef = useRef<string>(genId())
```

Add a tiny id helper above `App` (after the `escapeHtml`/helpers block):

```tsx
function genId(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}
```

- [ ] **Step 2: Restore active session on mount**

Add a `useEffect` after the connection-check effect:

```tsx
  // Restore the last active session on mount; populate the session list.
  useEffect(() => {
    (async () => {
      setSessions(await listSessions())
      const activeId = await getActiveSessionId()
      if (!activeId) return
      const s = await loadSession(activeId)
      if (!s) return
      sessionIdRef.current = s.id
      setMessages(s.messages as ChatMessage[])
      setPlatform(s.platform as Platform)
      setModel(s.model)
      chatIdRef.current = s.chatId
      lastResponseIdRef.current = s.lastResponseId
    })()
  }, [])
```

- [ ] **Step 3: Persist on message/platform/model change (debounced)**

Add a debounced persist effect:

```tsx
  // Persist the current session (debounced) whenever it changes.
  useEffect(() => {
    if (messages.length === 0) return
    const id = sessionIdRef.current
    const handle = setTimeout(() => {
      const payload: StoredSession = {
        id,
        platform,
        model,
        chatId: chatIdRef.current,
        lastResponseId: lastResponseIdRef.current,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        ts: Date.now(),
      }
      saveSession(payload).then(() => { setActiveSessionId(id); listSessions().then(setSessions) })
    }, 300)
    return () => clearTimeout(handle)
  }, [messages, platform, model])
```

- [ ] **Step 4: New / switch / delete session handlers**

Add handlers near `handleClear`:

```tsx
  const startNewSession = useCallback(() => {
    if (streaming) chrome.runtime.sendMessage({ type: 'CHAT_CANCEL' })
    sessionIdRef.current = genId()
    setMessages([])
    setSubAgents([])
    setError('')
    setStreaming(false)
    currentAssistantIdx.current = -1
    chatIdRef.current = null
    lastResponseIdRef.current = null
    setActiveSessionId(sessionIdRef.current)
    inputRef.current?.focus()
  }, [streaming])

  const switchSession = useCallback(async (id: string) => {
    if (id === sessionIdRef.current) return
    const s = await loadSession(id)
    if (!s) return
    sessionIdRef.current = s.id
    setMessages(s.messages as ChatMessage[])
    setSubAgents([])
    setPlatform(s.platform as Platform)
    setModel(s.model)
    chatIdRef.current = s.chatId
    lastResponseIdRef.current = s.lastResponseId
    setActiveSessionId(s.id)
  }, [])

  const removeCurrentSession = useCallback(async () => {
    const id = sessionIdRef.current
    await deleteSession(id)
    const list = await listSessions()
    setSessions(list)
    if (list.length > 0) await switchSession(list[0].id)
    else startNewSession()
  }, [switchSession, startNewSession])
```

Replace the existing `handleClear` usage in the header 🗑️ button with `removeCurrentSession`. Find the button:

```tsx
            <button onClick={handleClear} className="text-[10px] text-gray-600 hover:text-red-400 cursor-pointer ml-1" title="清空对话">🗑️</button>
```

Replace with:

```tsx
            <button onClick={removeCurrentSession} className="text-[10px] text-gray-600 hover:text-red-400 cursor-pointer ml-1" title="删除当前对话">🗑️</button>
```

(`handleClear` may now be unused — delete its definition to satisfy `noUnusedLocals` if the build enables it.)

- [ ] **Step 5: Add session dropdown + new-session button to header**

In the header's right-side `<div className="flex items-center gap-2">`, add before the connection dot:

```tsx
          {sessions.length > 0 && (
            <select
              value={sessionIdRef.current}
              onChange={e => switchSession(e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-[10px] text-gray-300 outline-none max-w-[120px]"
              title="切换会话"
            >
              {sessions.map(s => <option key={s.id} value={s.id}>{s.title || '新对话'}</option>)}
            </select>
          )}
          <button onClick={startNewSession} className="text-[10px] text-gray-600 hover:text-blue-400 cursor-pointer" title="新对话">➕</button>
```

- [ ] **Step 6: Type-check**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors. (Fix any unused `handleClear` warning by removing it.)

- [ ] **Step 7: Build to confirm the sidebar bundles**

Run: `cd extension && npm run build`
Expected: build succeeds; `dist/sidebar.html` produced.

- [ ] **Step 8: Commit**

```bash
git add extension/src/sidebar/App.tsx
git commit -m "feat(sidebar): conversation persistence + multi-session switcher"
```

---

## Task 7: Recursive sub-agent orchestration (chat-api)

**Files:**
- Modify: `src/background/chat-api.ts`
- Test: `src/__tests__/sidebar-subagent.test.ts`

The handler intercepts a `spawn_agent` tool call locally (instead of POSTing to `/exec`), runs a sub-conversation with a worker prompt, and returns its final text as the tool result. We extract the spawn-detection + result-shaping into pure helpers so they are unit-testable without a live SSE stream.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/sidebar-subagent.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  partitionSpawnCalls,
  buildSubAgentMessage,
  shapeSubAgentResult,
} from '../background/chat-api';

describe('sub-agent helpers', () => {
  it('partitions spawn_agent calls from normal tool calls', () => {
    const calls = [
      { name: 'read_file', args: { path: 'a' }, call_id: '1' },
      { name: 'spawn_agent', args: { task: 'review', label: 'rev' }, call_id: '2' },
    ];
    const { spawns, normal } = partitionSpawnCalls(calls);
    expect(spawns.map(c => c.call_id)).toEqual(['2']);
    expect(normal.map(c => c.call_id)).toEqual(['1']);
  });

  it('builds a worker message from prompt + task', () => {
    const msg = buildSubAgentMessage('WORKER PROMPT', 'do the thing');
    expect(msg).toContain('WORKER PROMPT');
    expect(msg).toContain('do the thing');
  });

  it('shapes a sub-agent final text into a tool result', () => {
    const r = shapeSubAgentResult({ name: 'spawn_agent', args: { label: 'rev' }, call_id: '2' }, 'done: 3 bugs');
    expect(r.call_id).toBe('2');
    expect(r.success).toBe(true);
    expect(r.output).toContain('done: 3 bugs');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/__tests__/sidebar-subagent.test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Add helpers + constants to chat-api.ts**

In `src/background/chat-api.ts`, after the `extractToolCalls` function, add:

```ts
// ── Sub-agent orchestration ──────────────────────────────────────────────────

/** Max nesting depth of recursive sub-agents (separate from MAX_TOOL_DEPTH). */
const MAX_AGENT_DEPTH = 3

/** Split tool calls into spawn_agent calls (run as sub-conversations) and the
 *  rest (executed normally via /exec). */
export function partitionSpawnCalls(calls: ToolCall[]): { spawns: ToolCall[]; normal: ToolCall[] } {
  const spawns: ToolCall[] = []
  const normal: ToolCall[] = []
  for (const c of calls) {
    if (c.name === 'spawn_agent') spawns.push(c)
    else normal.push(c)
  }
  return { spawns, normal }
}

/** Compose the first message of a sub-agent conversation. */
export function buildSubAgentMessage(workerPrompt: string, task: string): string {
  return `${workerPrompt}\n\n任务：${task}`
}

/** Shape a sub-agent's final assistant text into a ToolResult for the parent. */
export function shapeSubAgentResult(call: ToolCall, finalText: string): ToolResult {
  return {
    call_id: call.call_id,
    name: call.name,
    output: finalText || '(子 agent 无输出)',
    success: true,
  }
}

// Worker prompt cache (fetched once from the PierCode server).
let workerPromptCache: string | null = null

async function fetchWorkerPrompt(): Promise<string> {
  if (workerPromptCache !== null) return workerPromptCache
  try {
    const { apiUrl, authToken } = await chrome.storage.local.get(['apiUrl', 'authToken'])
    if (apiUrl && authToken) {
      const res = await fetch(`${apiUrl}/prompt?profile=worker`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
      if (res.ok) {
        workerPromptCache = await res.text()
        return workerPromptCache
      }
    }
  } catch {
    // fall through to inline default
  }
  workerPromptCache =
    '你是一个子 agent。独立完成下面的任务，可以使用 piercode-tool 工具（read_file/write_file/exec_cmd 等）。' +
    '完成后用纯文本简明汇报结论，不要再派生新的子 agent。'
  return workerPromptCache
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/__tests__/sidebar-subagent.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Add the runSubAgent orchestrator + wire into handleChatRequest**

In `src/background/chat-api.ts`, change `handleChatRequest`'s tool-handling block. Find:

```ts
    // Check for tool calls
    const toolCalls = extractToolCalls(sseResult.content)

    if (toolCalls.length > 0) {
      broadcast({ type: 'CHAT_TOOLS', tools: toolCalls })

      const results: ToolResult[] = []
      for (const tc of toolCalls) {
        if (currentAbort.signal.aborted) break
        const result = await execTool(tc.name, tc.args)
        results.push(result)
        broadcast({ type: 'CHAT_TOOL_DONE', result })
      }
```

Replace that block (up to and including the closing of the `for` loop) with:

```ts
    // Check for tool calls
    const toolCalls = extractToolCalls(sseResult.content)

    if (toolCalls.length > 0) {
      broadcast({ type: 'CHAT_TOOLS', tools: toolCalls })

      const { spawns, normal } = partitionSpawnCalls(toolCalls)
      const results: ToolResult[] = []

      // Normal tools → server /exec.
      for (const tc of normal) {
        if (currentAbort.signal.aborted) break
        const result = await execTool(tc.name, tc.args)
        results.push(result)
        broadcast({ type: 'CHAT_TOOL_DONE', result })
      }

      // spawn_agent → recursive sub-conversation (no tabs).
      for (const tc of spawns) {
        if (currentAbort.signal.aborted) break
        const result = await runSubAgent(tc, platform, modelOverride, depth)
        results.push(result)
        broadcast({ type: 'CHAT_TOOL_DONE', result })
      }
```

Then add `runSubAgent` after `handleChatRequest` (before the `broadcast` helper):

```ts
// runSubAgent runs a spawn_agent call as an isolated sub-conversation: fresh
// chatId, worker prompt + task, its own abort. The sub-agent can itself execute
// tools (recursively through handleChatRequest), bounded by MAX_AGENT_DEPTH and
// MAX_TOOL_DEPTH. Its final assistant text becomes the parent's tool result.
async function runSubAgent(
  call: ToolCall,
  platform: string,
  model: string | undefined,
  parentDepth: number,
): Promise<ToolResult> {
  const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const label = String(call.args.label || 'agent')
  const task = String(call.args.task || call.args.prompt || '')

  if (parentDepth >= MAX_AGENT_DEPTH) {
    return shapeSubAgentResult(call, `(子 agent 嵌套超过上限 ${MAX_AGENT_DEPTH}，已拒绝)`)
  }
  if (!task) {
    return shapeSubAgentResult(call, '(spawn_agent 缺少 task 参数)')
  }

  broadcast({ type: 'CHAT_AGENT_SPAWN', agentId, label, task })

  const workerPrompt = await fetchWorkerPrompt()
  const message = buildSubAgentMessage(workerPrompt, task)

  try {
    const finalText = await runIsolatedConversation({
      platform,
      message,
      model,
      depth: parentDepth + 1,
      agentId,
      abortSignal: currentAbort?.signal,
    })
    broadcast({ type: 'CHAT_AGENT_DONE', agentId, status: 'done' })
    return shapeSubAgentResult(call, finalText)
  } catch (err) {
    broadcast({ type: 'CHAT_AGENT_DONE', agentId, status: 'error' })
    return {
      call_id: call.call_id,
      name: call.name,
      output: `子 agent 失败: ${err instanceof Error ? err.message : String(err)}`,
      success: false,
    }
  }
}

// runIsolatedConversation drives one sub-agent turn loop: it streams the model,
// executes any non-spawn tools, recurses on its own tool output, and returns the
// accumulated assistant text. It deliberately does NOT spawn further agents
// beyond MAX_AGENT_DEPTH (enforced by runSubAgent before entry).
async function runIsolatedConversation(params: {
  platform: string
  message: string
  model?: string
  depth: number
  agentId: string
  abortSignal?: AbortSignal
}): Promise<string> {
  const { platform, agentId, abortSignal } = params
  let { message, depth } = params
  const config = PLATFORMS[platform]
  if (!config) throw new Error(`未知平台: ${platform}`)

  let chatId: string | null = null
  let parentId: string | null = null
  let lastText = ''

  for (let turn = 0; turn < MAX_TOOL_DEPTH; turn++) {
    if (abortSignal?.aborted) break

    const auth = await getAuth(platform)
    if ('error' in auth) throw new Error(auth.error)

    if (!chatId) {
      chatId = config.createConversation
        ? await config.createConversation(auth.token, params.model || 'default')
        : crypto.randomUUID()
    }
    const ctx = { chatId, model: params.model }
    const url = auth.url || config.getUrl(ctx)
    if (!url) throw new Error(`${config.name} API URL 未配置`)

    const response = await fetch(url, {
      method: 'POST',
      headers: config.buildHeaders(auth.token),
      body: config.buildBody(message, parentId, ctx),
      signal: abortSignal,
    })
    if (!response.ok) {
      const t = await response.text().catch(() => '')
      throw new Error(`${config.name} ${response.status}: ${t.slice(0, 120)}`)
    }

    const sse = await processSSEStream(
      response,
      config,
      (chunk) => broadcast({ type: 'CHAT_AGENT_STREAM', agentId, chunk }),
      abortSignal,
    )
    lastText = sse.content
    parentId = sse.responseId

    const calls = extractToolCalls(sse.content)
    const { normal } = partitionSpawnCalls(calls)  // sub-agents don't spawn further
    if (normal.length === 0) break

    const results: ToolResult[] = []
    for (const tc of normal) {
      if (abortSignal?.aborted) break
      results.push(await execTool(tc.name, tc.args))
    }
    message = results.map(r => `### ${r.name} #${r.call_id}\n\n${r.output}`).join('\n\n')
    depth++
  }

  return lastText
}
```

- [ ] **Step 6: Run all sub-agent tests + type-check**

Run: `cd extension && npx vitest run src/__tests__/sidebar-subagent.test.ts && npx tsc --noEmit`
Expected: tests PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add extension/src/background/chat-api.ts extension/src/__tests__/sidebar-subagent.test.ts
git commit -m "feat(sidebar): recursive sub-agent orchestration via chat-api"
```

---

## Task 8: Render sub-agents in App + CHAT_AGENT_* listener

**Files:**
- Modify: `src/sidebar/App.tsx`

- [ ] **Step 1: Extend the streaming listener**

In `src/sidebar/App.tsx`, find the `CHAT_TYPES` set:

```tsx
    const CHAT_TYPES = new Set(['CHAT_STREAM', 'CHAT_TOOLS', 'CHAT_TOOL_DONE', 'CHAT_TOOL_STREAM', 'CHAT_DONE', 'CHAT_ERROR'])
```

Replace with:

```tsx
    const CHAT_TYPES = new Set(['CHAT_STREAM', 'CHAT_TOOLS', 'CHAT_TOOL_DONE', 'CHAT_TOOL_STREAM', 'CHAT_DONE', 'CHAT_ERROR', 'CHAT_AGENT_SPAWN', 'CHAT_AGENT_STREAM', 'CHAT_AGENT_DONE'])
```

Inside the `listener`, before the final `else if (msg.type === 'CHAT_ERROR')`, add:

```tsx
      } else if (msg.type === 'CHAT_AGENT_SPAWN') {
        setSubAgents(prev => [...prev, { id: msg.agentId, label: msg.label, task: msg.task, status: 'running', messages: [] }])
      } else if (msg.type === 'CHAT_AGENT_STREAM') {
        setSubAgents(prev => prev.map(a => a.id === msg.agentId
          ? { ...a, messages: appendAgentChunk(a.messages, msg.chunk || '') }
          : a))
      } else if (msg.type === 'CHAT_AGENT_DONE') {
        setSubAgents(prev => prev.map(a => a.id === msg.agentId ? { ...a, status: msg.status === 'error' ? 'error' : 'done' } : a))
```

Add a helper above `App` (near `genId`):

```tsx
function appendAgentChunk(messages: ChatMessage[], chunk: string): ChatMessage[] {
  const next = [...messages]
  const last = next[next.length - 1]
  if (last && last.role === 'assistant' && last.streaming) {
    next[next.length - 1] = { ...last, content: last.content + chunk }
  } else {
    next.push({ role: 'assistant', content: chunk, streaming: true })
  }
  return next
}
```

- [ ] **Step 2: Render a sub-agents panel**

In the JSX, after the messages list `<div ref={listRef} ...>` block (right before the error bar), add:

```tsx
      {/* ── Sub-agents ──────────────────────────────────────────────────────── */}
      {subAgents.length > 0 && (
        <div className="px-3 py-1.5 border-t border-gray-800/40 bg-gray-950/60 flex-shrink-0 space-y-1 max-h-40 overflow-y-auto">
          {subAgents.map(a => (
            <SubAgentCard key={a.id} agent={a} />
          ))}
        </div>
      )}
```

Add the `SubAgentCard` component above `App`:

```tsx
function SubAgentCard({ agent }: { agent: { id: string; label: string; task: string; status: string; messages: ChatMessage[] } }) {
  const [open, setOpen] = useState(false)
  const icon = agent.status === 'running' ? '⏳' : agent.status === 'error' ? '❌' : '✅'
  const transcript = agent.messages.map(m => m.content).join('')
  return (
    <div className="rounded-md border border-gray-800 bg-gray-900/60 text-xs">
      <div className="flex items-center gap-2 px-2 py-1 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <span>{icon}</span>
        <span className="text-purple-300 font-mono text-[11px]">@{agent.label}</span>
        <span className="text-gray-600 truncate flex-1">{agent.task.slice(0, 40)}</span>
        <span className="text-gray-600 text-[10px]">{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <pre className="px-2 pb-2 text-[10px] text-gray-400 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
          {transcript || '(暂无输出)'}
        </pre>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Type-check + build**

Run: `cd extension && npx tsc --noEmit && npm run build`
Expected: no type errors; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add extension/src/sidebar/App.tsx
git commit -m "feat(sidebar): render recursive sub-agents with live transcripts"
```

---

## Task 9: Full test + build verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd extension && npm test`
Expected: all tests pass (including the four new files + existing suites). If `js-tiktoken` mock issues appear, confirm `vite.config.ts` still has `pool: 'threads'`.

- [ ] **Step 2: Type-check the whole extension**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Production build**

Run: `cd extension && npm run build`
Expected: build succeeds; `dist/sidebar.html` present.

- [ ] **Step 4: Final commit (if any lint/format fixups)**

```bash
git add -A
git commit -m "chore(sidebar): final verification fixups" || echo "nothing to commit"
```

---

## Self-Review Notes

**Spec coverage:**
- §1 Token panel upgrade → Task 1 (tiktoken delegation, accuracy badge, threshold marker, cost). ✓
- §2 `@@` completion → Tasks 3 (templates) + 4 (classifier + ordering fix). ✓
- §3 Persistence / multi-session → Tasks 5 (store) + 6 (App wiring, dropdown, delete-current). ✓
- §4 Recursive sub-agents → Tasks 7 (chat-api orchestration) + 8 (App rendering). ✓
- Picker dup-value risk (flagged in spec §2) → Task 2. ✓
- Worker-prompt-suitability open item → handled in Task 7 `fetchWorkerPrompt` (server `/prompt?profile=worker` with inline fallback). ✓

**Type consistency:** `subAgents` SubAgent shape (`{id,label,task,status,messages}`) is consistent across Tasks 4/6/8. `StoredSession`/`SessionMeta` consistent Tasks 5/6. `ToolCall`/`ToolResult` reuse existing chat-api types. `runSubAgent`/`runIsolatedConversation`/`fetchWorkerPrompt` referenced only after definition.

**Ordering caveat:** Task 4 Step 5 adds a temporary `subAgents` stub that Task 6 Step 1 replaces with real state — noted inline. If executed strictly in order, the stub keeps Task 4 type-checking; Task 6 removes it.
