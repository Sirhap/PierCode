import { describe, expect, it } from 'vitest';
import { recoverBareToolObjects, isExcludedFramePathname } from '../content/browser-agent-bridge';
import { extractFenceToolCalls } from '../parser';

// Live root cause: chatgpt's main page embeds a Cloudflare Turnstile/sentinel
// iframe at chatgpt.com/backend-api/sentinel/frame.html. Its host is chatgpt.com,
// so the host-fallback frame gate misidentified it as our AI conversation frame
// and installed the bridge there — INJECT then hit a frame with no composer, so
// the timeline stayed empty and the task hung. The gate must EXCLUDE these
// non-conversation internal frames by pathname.
describe('isExcludedFramePathname (frame gate excludes sentinel/widget frames)', () => {
  it('excludes the chatgpt sentinel frame (the actual root cause)', () => {
    expect(isExcludedFramePathname('/backend-api/sentinel/frame.html')).toBe(true);
  });
  it('excludes turnstile/challenge/cdn-cgi/next/api internal frames', () => {
    expect(isExcludedFramePathname('/cdn-cgi/challenge-platform/x')).toBe(true);
    expect(isExcludedFramePathname('/turnstile/v0/api.js')).toBe(true);
    expect(isExcludedFramePathname('/_next/static/chunk.js')).toBe(true);
    expect(isExcludedFramePathname('/api/auth/session')).toBe(true);
    expect(isExcludedFramePathname('/some/frame.html')).toBe(true);
  });
  it('does NOT exclude the legit AI conversation frame paths', () => {
    expect(isExcludedFramePathname('/')).toBe(false);
    expect(isExcludedFramePathname('/c/abc-123-uuid')).toBe(false);
    expect(isExcludedFramePathname('')).toBe(false);
  });
});

// Live bug: chatgpt/qwen render the piercode-tool call as a custom collapsible
// card (not a standard <pre><code class="language-piercode-tool">), so the
// adapter's tag/class-based extractText misses it and the readback finds zero
// tools → no timeline card, task hangs at "AI 正在操作浏览器…". recoverBareToolObjects
// is the structure-agnostic fallback: scan the raw textContent for bare tool
// JSON objects and re-wrap them as piercode-tool fences.
describe('recoverBareToolObjects (readback fallback for custom tool-card DOM)', () => {
  it('recovers a bare {name,call_id,args} object into a piercode-tool fence', () => {
    const raw = 'Some intro text\n{"name":"browser_snapshot","call_id":"brows-1ab2c","args":{}}\ntrailing';
    const buf: string[] = [];
    recoverBareToolObjects(raw, buf);
    expect(buf).toHaveLength(1);
    const tools = extractFenceToolCalls(buf.join('\n'));
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('browser_snapshot');
    expect(tools[0].callId).toBe('brows-1ab2c');
  });

  it('recovers multiple concatenated tool objects', () => {
    const raw = '{"name":"browser_navigate","call_id":"n1","args":{"url":"https://x.test"}}{"name":"browser_click","call_id":"c1","args":{"ref":"e1"}}';
    const buf: string[] = [];
    recoverBareToolObjects(raw, buf);
    const tools = extractFenceToolCalls(buf.join('\n'));
    expect(tools.map(t => t.name)).toEqual(['browser_navigate', 'browser_click']);
  });

  it('accepts "arguments" as an alias for "args"', () => {
    const raw = '{"name":"browser_scroll","call_id":"s1","arguments":{"direction":"down"}}';
    const buf: string[] = [];
    recoverBareToolObjects(raw, buf);
    expect(buf).toHaveLength(1);
  });

  it('ignores non-tool JSON and prose (no name+args)', () => {
    const buf: string[] = [];
    recoverBareToolObjects('{"foo":1,"bar":2} just some {object} text', buf);
    expect(buf).toHaveLength(0);
  });

  it('leaves an unclosed (still-streaming) object alone', () => {
    const buf: string[] = [];
    recoverBareToolObjects('{"name":"browser_snapshot","call_id":"x","args":{', buf);
    expect(buf).toHaveLength(0);
  });

  it('does not split braces inside string values', () => {
    const raw = '{"name":"browser_type","call_id":"t1","args":{"text":"a {curly} brace"}}';
    const buf: string[] = [];
    recoverBareToolObjects(raw, buf);
    const tools = extractFenceToolCalls(buf.join('\n'));
    expect(tools).toHaveLength(1);
    expect((tools[0].args as { text: string }).text).toBe('a {curly} brace');
  });
});
