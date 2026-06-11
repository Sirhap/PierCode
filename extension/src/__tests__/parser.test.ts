import { describe, it, expect } from 'vitest';
import { FENCE_RE, TOOL_RE, parseJsonFenceToolCall, parseXmlToolCall, tryParseToolJSON, parseAgentResultPacket, splitFenceObjects, parseFenceToolCalls, extractFenceToolCalls, hasIncompleteToolFence } from '../parser';

// ── multi-object fence handling (content/injected path hardening) ───────────

describe('splitFenceObjects', () => {
  it('splits concatenated top-level objects', () => {
    expect(splitFenceObjects('{"a":1}{"b":2}')).toEqual(['{"a":1}', '{"b":2}']);
  });
  it('does not split on braces inside string values', () => {
    expect(splitFenceObjects('{"cmd":"echo {hi}"}')).toEqual(['{"cmd":"echo {hi}"}']);
  });
  it('returns the body as one segment when no object present', () => {
    expect(splitFenceObjects('not json')).toEqual(['not json']);
  });
});

describe('parseFenceToolCalls', () => {
  it('parses multiple tool objects packed in one fence body', () => {
    const body = '{"name":"read_file","call_id":"a","args":{"path":"X"}}{"name":"grep","call_id":"b","args":{"pattern":"TODO"}}';
    const calls = parseFenceToolCalls(body);
    expect(calls.map(c => c.name)).toEqual(['read_file', 'grep']);
    expect(calls[1].args).toMatchObject({ pattern: 'TODO' });
  });
  it('parses a single tool object', () => {
    expect(parseFenceToolCalls('{"name":"list_dir","args":{"path":"."}}').map(c => c.name)).toEqual(['list_dir']);
  });
  it('skips invalid segments, keeps valid siblings', () => {
    expect(parseFenceToolCalls('{"name":"glob","args":{}}{garbage}').map(c => c.name)).toEqual(['glob']);
  });
});

// ── extractFenceToolCalls: brace-balanced full-text extractor ────────────────
// FENCE_RE's non-greedy body stops at the FIRST ``` it sees, so a tool whose
// args contain a markdown code fence (write_file of a .md / code file) gets its
// JSON truncated mid-string; the leftover tail then re-matches as a phantom
// "fence" and parses into a DIFFERENT tool. These tests pin the fixed behavior.

describe('extractFenceToolCalls', () => {
  it('survives a markdown code fence inside a string arg (the truncation bug)', () => {
    const text = 'here:\n```piercode-tool\n{"name":"write_file","call_id":"w1","args":{"path":"a.md","content":"# Doc\\n```js\\nconsole.log(1)\\n```\\n"}}\n```\nthen:\n```piercode-tool\n{"name":"list_dir","call_id":"l1","args":{"path":"."}}\n```';
    const calls = extractFenceToolCalls(text);
    expect(calls.map(c => c.name)).toEqual(['write_file', 'list_dir']);
    expect(calls[0].args.content).toContain('```js');
    expect(calls[0].callId).toBe('w1');
  });

  it('extracts a plain single fence', () => {
    const calls = extractFenceToolCalls('```piercode-tool\n{"name":"read_file","call_id":"r1","args":{"path":"X"}}\n```');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'read_file', callId: 'r1' });
  });

  it('extracts multiple separate fences in order', () => {
    const text = '```tool\n{"name":"exec_cmd","call_id":"a","args":{"command":"ls"}}\n```\ntext\n```piercode-tool\n{"name":"grep","call_id":"b","args":{"pattern":"TODO"}}\n```';
    expect(extractFenceToolCalls(text).map(c => c.name)).toEqual(['exec_cmd', 'grep']);
  });

  it('extracts multiple objects packed in ONE fence', () => {
    const text = '```piercode-tool\n{"name":"read_file","call_id":"a","args":{"path":"X"}}{"name":"grep","call_id":"b","args":{"pattern":"T"}}\n```';
    expect(extractFenceToolCalls(text).map(c => c.name)).toEqual(['read_file', 'grep']);
  });

  it('tolerates the no-newline one-liner form', () => {
    const calls = extractFenceToolCalls('```piercode-tool{"name":"list_dir","args":{"path":"."}}```');
    expect(calls.map(c => c.name)).toEqual(['list_dir']);
  });

  it('returns [] when a fence body is incomplete (still streaming)', () => {
    expect(extractFenceToolCalls('```piercode-tool\n{"name":"write_file","args":{"path":"a.md","content":"# Doc')).toEqual([]);
  });

  it('does not extract from non-tool fences', () => {
    expect(extractFenceToolCalls('```json\n{"name":"exec_cmd","args":{}}\n```')).toEqual([]);
  });

  it('does not produce a phantom tool from the truncated tail', () => {
    // Single write_file whose content has an inner fence; NOTHING else in text.
    const text = '```piercode-tool\n{"name":"write_file","call_id":"w2","args":{"path":"b.md","content":"x\\n```sh\\necho hi\\n```\\n"}}\n```';
    const calls = extractFenceToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('write_file');
  });

  it('normalizes zero-width chars and NBSP before parsing', () => {
    const text = '```piercode-tool\n{"name": "list_dir",​"call_id":"n1","args":{"path":"src"}}\n```';
    const calls = extractFenceToolCalls(text);
    expect(calls.map(c => c.name)).toEqual(['list_dir']);
  });
});

describe('hasIncompleteToolFence', () => {
  it('true when the fence has no closing ``` yet (streaming)', () => {
    expect(hasIncompleteToolFence('```piercode-tool\n{"name":"write_file","args":{"path":"a.md","content":"# Doc')).toBe(true);
  });
  it('true when the object inside a closed-looking text never closes', () => {
    expect(hasIncompleteToolFence('```tool\n{"name":"exec_cmd","args":{')).toBe(true);
  });
  it('false for a complete fence', () => {
    expect(hasIncompleteToolFence('```piercode-tool\n{"name":"list_dir","args":{"path":"."}}\n```')).toBe(false);
  });
  it('false when no tool fence present', () => {
    expect(hasIncompleteToolFence('plain text ```json\n{}\n```')).toBe(false);
  });
  it('true when first fence complete but a second is still streaming', () => {
    const text = '```tool\n{"name":"a_tool","args":{}}\n```\n```piercode-tool\n{"name":"write_file","args":{"content":"x';
    expect(hasIncompleteToolFence(text)).toBe(true);
  });
});

describe('FENCE_RE tolerates missing newlines', () => {
  it('matches a fence with no newline after the tag or before the close', () => {
    const content = '```piercode-tool{"name":"list_dir","args":{"path":"."}}```';
    FENCE_RE.lastIndex = 0;
    const m = FENCE_RE.exec(content);
    expect(m).not.toBeNull();
    const calls = parseFenceToolCalls(m![1]);
    expect(calls.map(c => c.name)).toEqual(['list_dir']);
  });
  it('still matches the well-formed newline form', () => {
    const content = '```piercode-tool\n{"name":"read_file","args":{"path":"X"}}\n```';
    FENCE_RE.lastIndex = 0;
    expect(FENCE_RE.exec(content)).not.toBeNull();
  });
});

// ── parseJsonFenceToolCall ─────────────────────────────────────────────────

describe('parseJsonFenceToolCall', () => {
  it('parses valid JSON fence tool call', () => {
    const result = parseJsonFenceToolCall('{"name":"exec_cmd","call_id":"a3f9k","args":{"command":"ls -la"}}');
    expect(result).toEqual({ name: 'exec_cmd', callId: 'a3f9k', args: { command: 'ls -la' } });
  });

  it('parses without call_id', () => {
    const result = parseJsonFenceToolCall('{"name":"list_dir","args":{"path":"."}}');
    expect(result).toEqual({ name: 'list_dir', callId: null, args: { path: '.' } });
  });

  it('parses with empty args', () => {
    const result = parseJsonFenceToolCall('{"name":"skill","call_id":"b2k9n","args":{}}');
    expect(result).toEqual({ name: 'skill', callId: 'b2k9n', args: {} });
  });

  it('returns null for invalid JSON', () => {
    expect(parseJsonFenceToolCall('not json')).toBeNull();
  });

  it('returns null if name is missing', () => {
    expect(parseJsonFenceToolCall('{"call_id":"a3f9k","args":{}}')).toBeNull();
  });

  it('returns null if name is not a string', () => {
    expect(parseJsonFenceToolCall('{"name":123,"args":{}}')).toBeNull();
  });

  it('defaults args to {} when missing', () => {
    const result = parseJsonFenceToolCall('{"name":"exec_cmd","call_id":"a3f9k"}');
    expect(result).toEqual({ name: 'exec_cmd', callId: 'a3f9k', args: {} });
  });

  it('handles args with numeric values', () => {
    const result = parseJsonFenceToolCall('{"name":"read_file","call_id":"c4f1h","args":{"path":"big.log","offset":2001,"limit":2000}}');
    expect(result).toEqual({ name: 'read_file', callId: 'c4f1h', args: { path: 'big.log', offset: 2001, limit: 2000 } });
  });

  it('handles args with array values', () => {
    const result = parseJsonFenceToolCall('{"name":"question","call_id":"d8j3m","args":{"question":"choose","options":["a","b"]}}');
    expect(result?.args.options).toEqual(['a', 'b']);
  });
});

// ── parseXmlToolCall ───────────────────────────────────────────────────────

describe('parseXmlToolCall', () => {
  it('parses valid XML tool call with double quotes', () => {
    const result = parseXmlToolCall('<tool name="exec_cmd" call_id="a3f9k">\n  <parameter name="command">ls -la</parameter>\n</tool>');
    expect(result).toEqual({ name: 'exec_cmd', callId: 'a3f9k', args: { command: 'ls -la' } });
  });

  it('parses valid XML tool call with single quotes', () => {
    const result = parseXmlToolCall("<tool name='exec_cmd' call_id='a3f9k'>\n  <parameter name='command'>ls -la</parameter>\n</tool>");
    expect(result).toEqual({ name: 'exec_cmd', callId: 'a3f9k', args: { command: 'ls -la' } });
  });

  it('parses without call_id', () => {
    const result = parseXmlToolCall('<tool name="list_dir">\n  <parameter name="path">.</parameter>\n</tool>');
    expect(result).toEqual({ name: 'list_dir', callId: null, args: { path: '.' } });
  });

  it('parses multiple parameters', () => {
    const result = parseXmlToolCall('<tool name="read_file" call_id="c4f1h">\n  <parameter name="path">big.log</parameter>\n  <parameter name="offset">2001</parameter>\n  <parameter name="limit">2000</parameter>\n</tool>');
    expect(result).toEqual({ name: 'read_file', callId: 'c4f1h', args: { path: 'big.log', offset: '2001', limit: '2000' } });
  });

  it('trims whitespace in parameter values', () => {
    const result = parseXmlToolCall('<tool name="list_dir">\n  <parameter name="path">extension\n   </parameter>\n</tool>');
    expect(result?.args.path).toBe('extension');
  });

  it('uses custom decodeHTMLEntities', () => {
    const result = parseXmlToolCall('<tool name="exec_cmd">\n  <parameter name="command">echo &amp; hello</parameter>\n</tool>', s => s.replace(/&amp;/g, '&'));
    expect(result?.args.command).toBe('echo & hello');
  });

  it('returns null for missing name', () => {
    expect(parseXmlToolCall('<tool call_id="a3f9k">\n  <parameter name="command">ls</parameter>\n</tool>')).toBeNull();
  });

  it('is case-insensitive for tool tag', () => {
    const result = parseXmlToolCall('<TOOL name="exec_cmd">\n  <parameter name="command">ls</parameter>\n</TOOL>');
    // TOOL_RE won't match this, but parseXmlToolCall itself is case-insensitive on the opening tag
    expect(result).not.toBeNull();
  });
});

// ── FENCE_RE ───────────────────────────────────────────────────────────────

describe('FENCE_RE', () => {
  it('extracts piercode-tool fence', () => {
    const text = 'some text\n```piercode-tool\n{"name":"list_dir","call_id":"qwen1","args":{"path":"."}}\n```\nmore text';
    FENCE_RE.lastIndex = 0;
    const match = FENCE_RE.exec(text);
    expect(match).not.toBeNull();
    const data = parseJsonFenceToolCall(match![1]);
    expect(data).toEqual({ name: 'list_dir', callId: 'qwen1', args: { path: '.' } });
  });

  it('extracts single tool fence', () => {
    const text = 'some text\n```tool\n{"name":"exec_cmd","call_id":"a3f9k","args":{"command":"ls"}}\n```\nmore text';
    FENCE_RE.lastIndex = 0;
    const match = FENCE_RE.exec(text);
    expect(match).not.toBeNull();
    expect(match![1].trim()).toBe('{"name":"exec_cmd","call_id":"a3f9k","args":{"command":"ls"}}');
  });

  it('extracts multiple tool fences', () => {
    const text = '```tool\n{"name":"exec_cmd","call_id":"a3f9k","args":{"command":"ls"}}\n```\n\n```tool\n{"name":"read_file","call_id":"b2k9n","args":{"path":"main.go"}}\n```';
    FENCE_RE.lastIndex = 0;
    const matches: string[] = [];
    let m;
    while ((m = FENCE_RE.exec(text)) !== null) matches.push(m[1].trim());
    expect(matches).toHaveLength(2);
    expect(JSON.parse(matches[0]).name).toBe('exec_cmd');
    expect(JSON.parse(matches[1]).name).toBe('read_file');
  });

  it('does not match regular code fences', () => {
    const text = '```json\n{"key": "value"}\n```';
    FENCE_RE.lastIndex = 0;
    expect(FENCE_RE.exec(text)).toBeNull();
  });
});

// ── TOOL_RE ────────────────────────────────────────────────────────────────

describe('TOOL_RE', () => {
  it('extracts XML tool block with </tool> closing', () => {
    const text = '<tool name="exec_cmd">\n  <parameter name="command">ls</parameter>\n</tool>';
    TOOL_RE.lastIndex = 0;
    const match = TOOL_RE.exec(text);
    expect(match).not.toBeNull();
    expect(match![0]).toContain('<tool name="exec_cmd"');
    expect(match![0]).toContain('</tool>');
  });

  it('extracts XML tool block with </function> closing', () => {
    const text = '<tool name="exec_cmd">\n  <parameter name="command">ls</parameter>\n</function>';
    TOOL_RE.lastIndex = 0;
    const match = TOOL_RE.exec(text);
    expect(match).not.toBeNull();
    expect(match![0]).toContain('</function>');
  });

  it('extracts XML tool block with </function_call> closing', () => {
    const text = '<tool name="exec_cmd">\n  <parameter name="command">ls</parameter>\n</function_call>';
    TOOL_RE.lastIndex = 0;
    const match = TOOL_RE.exec(text);
    expect(match).not.toBeNull();
    expect(match![0]).toContain('</function_call>');
  });

  it('extracts multiple tool blocks', () => {
    const text = '<tool name="exec_cmd">\n  <parameter name="command">ls</parameter>\n</tool>\n<tool name="read_file">\n  <parameter name="path">main.go</parameter>\n</tool>';
    TOOL_RE.lastIndex = 0;
    const matches: string[] = [];
    let m;
    while ((m = TOOL_RE.exec(text)) !== null) matches.push(m[0]);
    expect(matches).toHaveLength(2);
  });

  it('does not match non-tool XML', () => {
    const text = '<div>hello</div>';
    TOOL_RE.lastIndex = 0;
    expect(TOOL_RE.exec(text)).toBeNull();
  });
});

// ── tryParseToolJSON ───────────────────────────────────────────────────────

describe('tryParseToolJSON', () => {
  it('parses valid JSON', () => {
    const result = tryParseToolJSON('{"name":"exec_cmd","args":{"command":"ls"}}');
    expect(result).toEqual({ name: 'exec_cmd', args: { command: 'ls' } });
  });

  it('repairs unescaped quotes in JSON string values', () => {
    const result = tryParseToolJSON('{"name":"exec_cmd","args":{"command":"echo "hello""}}');
    expect(result).not.toBeNull();
    expect(result.args.command).toContain('hello');
  });

  it('returns null for completely invalid input', () => {
    expect(tryParseToolJSON('not json at all')).toBeNull();
  });

  it('repairs trailing comma in object', () => {
    const result = tryParseToolJSON('{"name":"list_dir","args":{"path":".",}}');
    expect(result).not.toBeNull();
    expect(result.name).toBe('list_dir');
    expect(result.args.path).toBe('.');
  });

  it('repairs trailing comma in array', () => {
    const result = tryParseToolJSON('{"name":"question","args":{"options":["a","b",]}}');
    expect(result).not.toBeNull();
    expect(result.args.options).toEqual(['a', 'b']);
  });

  it('does not treat comma inside a string as trailing', () => {
    const result = tryParseToolJSON('{"name":"exec_cmd","args":{"command":"echo a,}"}}');
    expect(result).not.toBeNull();
    expect(result.args.command).toBe('echo a,}');
  });
});

// parseJsonFenceToolCall should share the same repair chain as tryParseToolJSON,
// so a fenced block with a trailing comma still parses.
describe('parseJsonFenceToolCall repair', () => {
  it('parses a fenced object with a trailing comma', () => {
    const result = parseJsonFenceToolCall('{"name":"list_dir","call_id":"x1","args":{"path":".",}}');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('list_dir');
    expect(result!.callId).toBe('x1');
  });
});

// ── Integration: full scanText scenarios ───────────────────────────────────

describe('integration: full text parsing', () => {
  it('parses JSON fence tool calls from mixed text', () => {
    const text = 'I will list the directory:\n\n```tool\n{"name":"list_dir","call_id":"b2k9n","args":{"path":"extension"}}\n```\n\nDone.';
    FENCE_RE.lastIndex = 0;
    const results: any[] = [];
    let m;
    while ((m = FENCE_RE.exec(text)) !== null) {
      const data = parseJsonFenceToolCall(m[1]);
      if (data) results.push(data);
    }
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('list_dir');
    expect(results[0].args.path).toBe('extension');
  });

  it('parses XML tool calls from mixed text', () => {
    const text = 'Let me read the file:\n\n<tool name="read_file" call_id="c4f1h">\n  <parameter name="path">README.md</parameter>\n</tool>';
    TOOL_RE.lastIndex = 0;
    const results: any[] = [];
    let m;
    while ((m = TOOL_RE.exec(text)) !== null) {
      const full = m[0];
      const inner = full.replace(/^<tool[^>]*>|<\/(?:tool|function)(?:_call)?>$/g, '').trim();
      const data = parseXmlToolCall(full) || tryParseToolJSON(inner);
      if (data) results.push(data);
    }
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('read_file');
    expect(results[0].args.path).toBe('README.md');
  });

  it('handles mixed JSON fence and XML in same text', () => {
    const text = '```tool\n{"name":"exec_cmd","call_id":"a3f9k","args":{"command":"ls"}}\n```\n\n<tool name="list_dir" call_id="b2k9n">\n  <parameter name="path">.</parameter>\n</tool>';

    // Phase 1: JSON fence
    FENCE_RE.lastIndex = 0;
    const fenceResults: any[] = [];
    let m;
    while ((m = FENCE_RE.exec(text)) !== null) {
      const data = parseJsonFenceToolCall(m[1]);
      if (data) fenceResults.push(data);
    }
    expect(fenceResults).toHaveLength(1);
    expect(fenceResults[0].name).toBe('exec_cmd');

    // Phase 2: XML
    TOOL_RE.lastIndex = 0;
    const xmlResults: any[] = [];
    while ((m = TOOL_RE.exec(text)) !== null) {
      const data = parseXmlToolCall(m[0]);
      if (data) xmlResults.push(data);
    }
    expect(xmlResults).toHaveLength(1);
    expect(xmlResults[0].name).toBe('list_dir');
  });

  it('handles write_file with multi-line content in JSON fence', () => {
    const jsonStr = '{"name":"write_file","call_id":"e5g2k","args":{"path":"main.go","content":"package main\\n\\nimport \\"fmt\\"\\n\\nfunc main() {\\n    fmt.Println(\\"hello\\")\\n}"}}';
    const result = parseJsonFenceToolCall(jsonStr);
    expect(result).not.toBeNull();
    expect(result.name).toBe('write_file');
    expect(result.args.path).toBe('main.go');
    expect(result.args.content).toContain('package main');
    expect(result.args.content).toContain('fmt.Println');
  });
});

// ── Error / edge case scenarios ────────────────────────────────────────────

describe('edge cases and error handling', () => {
  // --- JSON fence edge cases ---
  it('returns null for empty string in parseJsonFenceToolCall', () => {
    expect(parseJsonFenceToolCall('')).toBeNull();
  });

  it('returns null for truncated JSON', () => {
    expect(parseJsonFenceToolCall('{"name":"exec_cmd","args":{')).toBeNull();
  });

  it('returns null for JSON array instead of object', () => {
    expect(parseJsonFenceToolCall('[1,2,3]')).toBeNull();
  });

  it('returns null for JSON with name as object', () => {
    expect(parseJsonFenceToolCall('{"name":{"nested":true},"args":{}}')).toBeNull();
  });

  it('handles args with null value', () => {
    const result = parseJsonFenceToolCall('{"name":"exec_cmd","call_id":"a1b2c","args":{"command":null}}');
    expect(result).not.toBeNull();
    expect(result.args.command).toBeNull();
  });

  it('handles extra unknown fields gracefully', () => {
    const result = parseJsonFenceToolCall('{"name":"exec_cmd","call_id":"a1b2c","args":{"command":"ls"},"extra":"ignored"}');
    expect(result).not.toBeNull();
    expect(result.name).toBe('exec_cmd');
  });

  // --- XML edge cases ---
  it('returns null for empty string in parseXmlToolCall', () => {
    expect(parseXmlToolCall('')).toBeNull();
  });

  it('parses incomplete XML (no parameters) as valid with empty args', () => {
    const result = parseXmlToolCall('<tool name="exec_cmd">');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('exec_cmd');
    expect(result!.args).toEqual({});
  });

  it('parses XML with no parameters', () => {
    const result = parseXmlToolCall('<tool name="skill" call_id="x1y2z">\n</tool>');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('skill');
    expect(result!.args).toEqual({});
  });

  it('parses XML with empty parameter value', () => {
    const result = parseXmlToolCall('<tool name="edit" call_id="a1b2c">\n  <parameter name="new_string"></parameter>\n</tool>');
    expect(result).not.toBeNull();
    expect(result!.args.new_string).toBe('');
  });

  it('parses XML with special characters in parameter value', () => {
    const result = parseXmlToolCall('<tool name="exec_cmd" call_id="a1b2c">\n  <parameter name="command">echo "hello &amp; world"</parameter>\n</tool>');
    expect(result).not.toBeNull();
    expect(result!.args.command).toContain('hello');
  });

  it('parses XML closed with </function>', () => {
    const result = parseXmlToolCall('<tool name="exec_cmd" call_id="a1b2c">\n  <parameter name="command">ls</parameter>\n</function>');
    // parseXmlToolCall only parses the opening tag + parameters, not the closing tag
    expect(result).not.toBeNull();
    expect(result!.name).toBe('exec_cmd');
  });

  // --- FENCE_RE edge cases ---
  it('does not match ```tool without closing fence', () => {
    const text = '```tool\n{"name":"exec_cmd","args":{}}';
    FENCE_RE.lastIndex = 0;
    expect(FENCE_RE.exec(text)).toBeNull();
  });

  it('matches ```tool with carriage return', () => {
    const text = '```tool\r\n{"name":"exec_cmd","call_id":"a1b2c","args":{"command":"ls"}}\r\n```';
    FENCE_RE.lastIndex = 0;
    const match = FENCE_RE.exec(text);
    expect(match).not.toBeNull();
  });

  it('does not match ```tools (plural)', () => {
    const text = '```tools\n{"name":"exec_cmd","args":{}}\n```';
    FENCE_RE.lastIndex = 0;
    expect(FENCE_RE.exec(text)).toBeNull();
  });

  // --- TOOL_RE edge cases ---
  it('matches self-closing tool tag', () => {
    const text = '<tool name="skill" />\n<tool name="exec_cmd">\n  <parameter name="command">ls</parameter>\n</tool>';
    TOOL_RE.lastIndex = 0;
    const matches: string[] = [];
    let m;
    while ((m = TOOL_RE.exec(text)) !== null) matches.push(m[0]);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  // --- tryParseToolJSON edge cases ---
  it('returns null for empty string', () => {
    expect(tryParseToolJSON('')).toBeNull();
  });

  it('parses JSON with trailing comma removed by repair', () => {
    // The repair function handles unescaped quotes, not trailing commas
    // This is just to verify it doesn't crash
    expect(() => tryParseToolJSON('{"a":1,}')).not.toThrow();
  });

  // --- Kimi/Code block rendering scenarios ---
  it('handles tool call from rendered code block (<pre><code class="language-tool">)', () => {
    // 模拟从 Kimi 渲染的代码块提取出的文本
    const extractedText = '\n```tool\n{"name": "list_dir", "call_id": "a1b2c3", "args": {"path": "."}}\n```\n';
    FENCE_RE.lastIndex = 0;
    const match = FENCE_RE.exec(extractedText);
    expect(match).not.toBeNull();
    const data = parseJsonFenceToolCall(match![1]);
    expect(data).not.toBeNull();
    expect(data!.name).toBe('list_dir');
    expect(data!.args.path).toBe('.');
  });

  it('handles tool code block without surrounding whitespace', () => {
    const text = '```tool\n{"name":"exec_cmd","call_id":"x1","args":{"command":"ls"}}\n```';
    FENCE_RE.lastIndex = 0;
    const match = FENCE_RE.exec(text);
    expect(match).not.toBeNull();
    const data = parseJsonFenceToolCall(match![1]);
    expect(data!.name).toBe('exec_cmd');
  });

  it('handles Kimi qwen-markdown-code-body tool class', () => {
    // 模拟从 Kimi 提取的文本（qwen-markdown-code + tool 类）
    const extractedText = '\n```tool\n{"name": "list_dir", "call_id": "a1b2c3", "args": {"path": "."}}\n```\n';
    FENCE_RE.lastIndex = 0;
    const match = FENCE_RE.exec(extractedText);
    expect(match).not.toBeNull();
    const data = parseJsonFenceToolCall(match![1]);
    expect(data).not.toBeNull();
    expect(data!.name).toBe('list_dir');
    expect(data!.args.path).toBe('.');
  });

  // --- Simulated AI error scenarios ---
  it('handles AI outputting malformed XML with function close tag', () => {
    // AI wrote </function> instead of </tool>
    const text = '<tool name="list_dir" call_id="err1">\n  <parameter name="path">extension\n   </parameter>\n</function>';
    TOOL_RE.lastIndex = 0;
    const match = TOOL_RE.exec(text);
    expect(match).not.toBeNull();
    const data = parseXmlToolCall(match![0]);
    expect(data).not.toBeNull();
    expect(data!.name).toBe('list_dir');
    expect(data!.args.path).toBe('extension'); // trimmed
  });

  it('handles AI outputting malformed XML with function_call close tag', () => {
    const text = '<tool name="list_dir" call_id="err1">\n  <parameter name="path">extension\n   </parameter>\n</function_call>';
    TOOL_RE.lastIndex = 0;
    const match = TOOL_RE.exec(text);
    expect(match).not.toBeNull();
    const data = parseXmlToolCall(match![0]);
    expect(data).not.toBeNull();
    expect(data!.name).toBe('list_dir');
    expect(data!.args.path).toBe('extension');
  });

  it('handles AI outputting tool call without call_id (still valid)', () => {
    const text = '```tool\n{"name":"exec_cmd","args":{"command":"ls"}}\n```';
    FENCE_RE.lastIndex = 0;
    const match = FENCE_RE.exec(text);
    expect(match).not.toBeNull();
    const data = parseJsonFenceToolCall(match![1]);
    expect(data).not.toBeNull();
    expect(data!.callId).toBeNull();
  });

  it('handles AI outputting XML with trailing whitespace in values', () => {
    const text = '<tool name="exec_cmd" call_id="ws1">\n  <parameter name="command">ls -la   \n   </parameter>\n</tool>';
    TOOL_RE.lastIndex = 0;
    const match = TOOL_RE.exec(text);
    expect(match).not.toBeNull();
    const data = parseXmlToolCall(match![0]);
    expect(data).not.toBeNull();
    expect(data!.args.command).toBe('ls -la');
  });
});

// ── Non-breaking space (NBSP) handling ────────────────────────────────────

describe('non-breaking space handling', () => {
  it('parseJsonFenceToolCall handles NBSP (\\u00A0) in JSON', () => {
    // Monaco Editor renders spaces as &nbsp; which becomes \u00A0 in textContent
    const jsonWithNbsp = '{"name":\u00A0"read_file",\u00A0"call_id":\u00A0"d4e5f6",\u00A0"args":\u00A0{"path":\u00A0"README.md"}}';
    const result = parseJsonFenceToolCall(jsonWithNbsp);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('read_file');
    expect(result!.callId).toBe('d4e5f6');
    expect(result!.args.path).toBe('README.md');
  });

  it('tryParseToolJSON handles NBSP (\\u00A0) in JSON', () => {
    const jsonWithNbsp = '{"name":\u00A0"exec_cmd",\u00A0"args":\u00A0{"command":\u00A0"ls"}}';
    const result = tryParseToolJSON(jsonWithNbsp);
    expect(result).not.toBeNull();
    expect(result.name).toBe('exec_cmd');
    expect(result.args.command).toBe('ls');
  });

  it('FENCE_RE extracts tool call with NBSP and parses successfully', () => {
    const text = '```tool\n{"name":\u00A0"list_dir",\u00A0"call_id":\u00A0"j0k1l2",\u00A0"args":\u00A0{"path":\u00A0"src"}}\n```';
    FENCE_RE.lastIndex = 0;
    const match = FENCE_RE.exec(text);
    expect(match).not.toBeNull();
    const cleaned = match![1].replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
    const data = parseJsonFenceToolCall(cleaned);
    expect(data).not.toBeNull();
    expect(data!.name).toBe('list_dir');
    expect(data!.args.path).toBe('src');
  });
});

// ── parseAgentResultPacket ─────────────────────────────────────────────────

describe('parseAgentResultPacket', () => {
  it('parses a well-formed packet', () => {
    const p = parseAgentResultPacket('{"version":1,"agent_id":"agent-1","status":"completed","summary":"done","result":"all good"}');
    expect(p).not.toBeNull();
    expect(p!.agentId).toBe('agent-1');
    expect(p!.status).toBe('completed');
    expect(p!.result).toBe('all good');
  });

  it('returns null for an incomplete (still-streaming) body', () => {
    expect(parseAgentResultPacket('{"agent_id":"a","status":"completed"')).toBeNull();
  });

  it('repairs a trailing comma (common LLM slip) instead of dropping the packet', () => {
    const p = parseAgentResultPacket('{"agent_id":"a","status":"completed","summary":"x",}');
    expect(p).not.toBeNull();
    expect(p!.agentId).toBe('a');
  });

  it('defaults status to completed when omitted', () => {
    const p = parseAgentResultPacket('{"agent_id":"a","result":"r"}');
    expect(p!.status).toBe('completed');
  });
});
