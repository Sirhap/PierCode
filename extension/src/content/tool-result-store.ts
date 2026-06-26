// Persistent per-key tool-result cache (content-bundle leaf).
//
// `piercode_executed` only records key→timestamp (dedup), NOT the result text.
// When the SPA rebuilds the message DOM and orphans an already-executed tool
// card, the result is gone with the old node — but `isExecuted` blocks the
// interactive card from re-rendering (it would risk double-exec). To re-render
// a read-only "done" card with its output, we need the output stored somewhere
// retrievable. That is this cache.
//
// Content-safe: no chrome.* at module scope, no cross-entry imports — so the
// classic content.js bundle (and any classic importer) stays intact.

const STORE_KEY = 'piercode_tool_results';
const TTL = 7 * 24 * 60 * 60 * 1000; // 7d — mirrors piercode_executed.
const MAX_ENTRIES = 200; // cap localStorage growth; evict oldest by ts beyond this.
const MAX_OUTPUT = 4096; // the read-only card shows a preview, not full output.

export type ToolResultStatus = 'done' | 'error';

export interface ToolResultRecord {
  name: string;
  argsPreview: string;
  output: string;
  status: ToolResultStatus;
  durationMs: number;
  ts: number;
}

type Store = Record<string, ToolResultRecord>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

// saveToolResult writes one record, pruning expired entries (TTL) and capping
// total count (oldest-ts eviction). Output is truncated to MAX_OUTPUT. All
// failures (quota, private mode) are swallowed — the cache is best-effort; a
// miss only degrades the read-only card to "executed, no cached output".
export function saveToolResult(key: string, rec: ToolResultRecord): void {
  try {
    const store = readStore();
    const now = rec.ts || Date.now();
    // TTL prune.
    for (const k of Object.keys(store)) {
      if (now - store[k].ts > TTL) delete store[k];
    }
    store[key] = {
      name: rec.name,
      argsPreview: rec.argsPreview,
      output: rec.output.length > MAX_OUTPUT ? rec.output.slice(0, MAX_OUTPUT) + '\n…(已截断)' : rec.output,
      status: rec.status,
      durationMs: rec.durationMs,
      ts: now,
    };
    // Count cap: evict oldest by ts until within MAX_ENTRIES.
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => store[a].ts - store[b].ts);
      for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete store[keys[i]];
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* best-effort */
  }
}

// loadToolResult returns the cached record for `key`, or null on miss / expired
// / any storage error.
export function loadToolResult(key: string): ToolResultRecord | null {
  try {
    const store = readStore();
    const rec = store[key];
    if (!rec) return null;
    if (Date.now() - rec.ts > TTL) return null;
    return rec;
  } catch {
    return null;
  }
}
