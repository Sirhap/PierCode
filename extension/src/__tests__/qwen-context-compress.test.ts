import { describe, expect, it } from 'vitest';
import {
  compactToolOutputForChat,
  estimateContextTokens,
  estimateTokens,
  extractContextPacketFields,
  formatPacketHandoffPrompt,
  formatPierCodeContextPacketPrompt,
  formatQwenCompressedContextPrompt,
  generateSummary,
  parsePierCodeContextPacket,
  shouldCompress,
} from '../content/qwen-context-compress';

describe('qwen context compression helpers', () => {
  it('keeps short tool output unchanged', () => {
    const output = '### list_dir #abc12\nREADME.md\ninternal/';
    const result = compactToolOutputForChat(output, 1000);

    expect(result.compacted).toBe(false);
    expect(result.text).toBe(output);
  });

  it('compacts long tool output while preserving section headers and tail content', () => {
    const output = [
      '### read_file #abc12',
      'a'.repeat(12_000),
      'TAIL_A',
      '',
      '### grep #def34',
      'b'.repeat(12_000),
      'TAIL_B'
    ].join('\n');

    const result = compactToolOutputForChat(output, 8_000);

    expect(result.compacted).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(8_000);
    expect(result.text).toContain('### read_file #abc12');
    expect(result.text).toContain('### grep #def34');
    expect(result.text).toContain('TAIL_A');
    expect(result.text).toContain('TAIL_B');
    expect(result.text).toContain('已省略');
  });

  it('estimates mixed text tokens without returning zero for non-empty text', () => {
    expect(estimateTokens('hello 世界')).toBeGreaterThan(0);
  });

  it('keeps compressed summaries within the requested token budget', () => {
    const summary = generateSummary({
      messages: [
        { role: 'system', content: '系统提示'.repeat(1000), timestamp: 1 },
        { role: 'user', content: '用户问题'.repeat(1000), timestamp: 2 },
        { role: 'assistant', content: '助手回答'.repeat(1000), timestamp: 3 },
      ],
      totalChars: 0,
      lastCompressedAt: 0,
    }, 256);

    expect(estimateTokens(summary)).toBeLessThanOrEqual(256);
  });

  it('preserves chronological order for selected recent messages', () => {
    const summary = generateSummary({
      messages: [
        { role: 'user', content: 'first user message', timestamp: 1 },
        { role: 'assistant', content: 'first assistant message', timestamp: 2 },
        { role: 'user', content: 'second user message', timestamp: 3 },
      ],
      totalChars: 0,
      lastCompressedAt: 0,
    }, 512);

    expect(summary.indexOf('first user message')).toBeLessThan(summary.indexOf('first assistant message'));
    expect(summary.indexOf('first assistant message')).toBeLessThan(summary.indexOf('second user message'));
  });

  it('uses the configured threshold when deciding to compress', () => {
    const ctx = {
      messages: [
        { role: 'user' as const, content: 'a'.repeat(100), timestamp: 1 },
      ],
      totalChars: 100,
      lastCompressedAt: 0,
    };

    expect(estimateContextTokens(ctx)).toBeGreaterThan(0);
    expect(shouldCompress(ctx, 1)).toBe(true);
    expect(shouldCompress(ctx, 1_000_000)).toBe(false);
  });

  it('parses a fenced JSON PierCode context packet without treating it as a tool call', () => {
    const parsed = parsePierCodeContextPacket([
      'prefix ignored',
      '```piercode-context',
      '{"version":1,"reason":"model_initiated","goal":"继续修复压缩上下文","pending":["打开新会话"]}',
      '```',
      'suffix ignored',
    ].join('\n'));

    expect(parsed?.attrs).toEqual({ version: '1', reason: 'model_initiated' });
    expect(parsed?.content).toContain('"version":1');
    expect(parsed?.content).toContain('"goal"');
    expect(parsed?.raw).toContain('```piercode-context');
  });

  it('still parses the legacy XML-wrapped PierCode context packet', () => {
    const parsed = parsePierCodeContextPacket([
      '<piercode_context_packet version="1" reason="model_initiated">',
      '```json',
      '{"goal":"旧格式兼容","pending":["打开新会话"]}',
      '```',
      '</piercode_context_packet>',
    ].join('\n'));

    expect(parsed?.attrs).toEqual({ version: '1', reason: 'model_initiated' });
    expect(parsed?.content).toContain('```json');
    expect(parsed?.raw).toContain('<piercode_context_packet');
  });

  it('does not treat an archived context fence as a new compression signal', () => {
    // 防无限环：注入新会话的历史 packet 用 piercode-context-archived 围栏，
    // 解析器只认 piercode-context，不能误命中 archived 前缀。
    const parsed = parsePierCodeContextPacket([
      '```piercode-context-archived',
      '{"version":1,"reason":"piercode_requested","goal":"历史包"}',
      '```',
    ].join('\n'));

    expect(parsed).toBeNull();
  });

  it('rejects invalid fenced JSON context packets', () => {
    const parsed = parsePierCodeContextPacket([
      '```piercode-context',
      '{"version":1,',
      '```',
    ].join('\n'));

    expect(parsed).toBeNull();
  });

  it('builds a visible compression request with fenced JSON and no piercode-tool', () => {
    const prompt = formatPierCodeContextPacketPrompt({
      messages: [
        { role: 'user', content: '请继续实现上下文压缩', timestamp: 1 },
        { role: 'assistant', content: '已完成部分实现', timestamp: 2 },
      ],
      totalChars: 0,
      lastCompressedAt: 0,
    }, {
      enabled: true,
      maxContextTokens: 10,
      maxSummaryTokens: 100,
    });

    expect(prompt).toContain('```piercode-context');
    expect(prompt).toContain('"version": 1');
    expect(prompt).toContain('"reason": "piercode_requested"');
    expect(prompt).toContain('"next_action"');
    expect(prompt).toContain('不要输出 `piercode-tool`');
  });

  it('asks for a chronological <analysis> scratchpad before the JSON packet', () => {
    const prompt = formatPierCodeContextPacketPrompt({
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
      totalChars: 0,
      lastCompressedAt: 0,
    }, { enabled: true, maxContextTokens: 10, maxSummaryTokens: 100 });

    // 借鉴 Claude Code：先逐条分析(草稿)再产出结构化包，提升质量。
    expect(prompt).toContain('<analysis>');
    expect(prompt).toContain('</analysis>');
    expect(prompt.indexOf('<analysis>')).toBeLessThan(prompt.indexOf('```piercode-context'));
  });

  it('requests the Claude-Code 9-section fields in the packet schema', () => {
    const prompt = formatPierCodeContextPacketPrompt({
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
      totalChars: 0,
      lastCompressedAt: 0,
    }, { enabled: true, maxContextTokens: 10, maxSummaryTokens: 100 });

    // 9 段映射到 JSON 字段：原有 + 新增 key_concepts/errors_fixes/
    // problem_solving/user_messages。
    for (const field of [
      'goal', 'key_concepts', 'key_files', 'errors_fixes', 'problem_solving',
      'user_messages', 'completed', 'pending', 'current_state', 'next_action',
    ]) {
      expect(prompt).toContain(`"${field}"`);
    }
    // Next Step 要求引用最近对话原文，防 task drift
    expect(prompt).toContain('原文');
  });

  it('sandwiches the prompt with NO_TOOLS guards (preamble + trailer)', () => {
    const prompt = formatPierCodeContextPacketPrompt({
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
      totalChars: 0,
      lastCompressedAt: 0,
    }, { enabled: true, maxContextTokens: 10, maxSummaryTokens: 100 });

    // 首尾双约束：开头和结尾都强调不调工具、工具调用会被拒绝浪费回合。
    const firstGuard = prompt.indexOf('不要调用任何工具');
    const lastGuard = prompt.lastIndexOf('不要调用任何工具');
    expect(firstGuard).toBeGreaterThanOrEqual(0);
    expect(lastGuard).toBeGreaterThan(firstGuard); // 至少出现两次(首/尾)
    expect(prompt).toContain('拒绝'); // "工具调用会被拒绝"话术
  });

  it('does not hardcode a single platform name in the compression request', () => {
    const prompt = formatPierCodeContextPacketPrompt({
      messages: [{ role: 'user', content: 'x', timestamp: 1 }],
      totalChars: 0,
      lastCompressedAt: 0,
    }, { enabled: true, maxContextTokens: 10, maxSummaryTokens: 100 });

    // 压缩 ChatGPT 时不能误说要迁移到 Qwen；提示词必须平台中立。
    expect(prompt).not.toContain('Qwen');
    expect(prompt).not.toContain('qwen');
  });

  it('builds compressed handoff payload as plain-text summary (no JSON wrapping)', () => {
    const summary = '第一段摘要\n\n第二段摘要';
    const payload = formatQwenCompressedContextPrompt(summary, 'INIT PROMPT');

    expect(payload).toContain('INIT PROMPT');
    // 纯文本直发：摘要原样保留真换行，不再套 JSON 把换行转义成字面 \n
    expect(payload).toContain(summary);
    expect(payload).not.toContain('\\n');
    expect(payload).not.toContain('```piercode-context');
    expect(payload).not.toContain('compressed_context_handoff');
    expect(payload).not.toContain('<compressed_context>');
    expect(payload.indexOf('压缩上下文')).toBeLessThan(payload.indexOf('INIT PROMPT'));
  });

  it('labels init vs compressed-context sections so they are not confused', () => {
    const payload = formatQwenCompressedContextPrompt('压缩摘要', 'INIT PROMPT');

    // 必须明确区分"运行说明(初始化)"和"上次会话压缩上下文"，否则新会话会把
    // 两段当成一团。压缩上下文段落必须出现在运行说明段落之前。
    expect(payload).toContain('运行说明');
    expect(payload).toContain('压缩上下文');
    expect(payload.indexOf('压缩上下文')).toBeLessThan(payload.indexOf('运行说明'));
  });

  it('omits the init-prompt section entirely when no init prompt is provided', () => {
    const payload = formatQwenCompressedContextPrompt('压缩摘要', '');

    expect(payload).toContain('压缩摘要');
    expect(payload).not.toContain('运行说明');
  });

  it('forwards a model packet content but archives its fence to break the self-compression loop', () => {
    const packetRaw = [
      '```piercode-context',
      '{"version":1,"reason":"piercode_requested","goal":"修复压缩注入","next_action":"打开新会话"}',
      '```',
    ].join('\n');

    const payload = formatPacketHandoffPrompt(packetRaw, 'INIT PROMPT');

    expect(payload).toContain('INIT PROMPT');
    // 结构化字段原样保留，没被压成转义字符串
    expect(payload).toContain('"reason":"piercode_requested"');
    expect(payload).toContain('"next_action":"打开新会话"');
    // 关键：注入新会话的历史 packet 围栏已改成 archived，不会被
    // parsePierCodeContextPacket 当作"新压缩信号"再触发开新会话（无限环根因）。
    expect(payload).toContain('```piercode-context-archived');
    expect(parsePierCodeContextPacket(payload)).toBeNull();
    // 没有任何活跃的 piercode-context 围栏（archived 不算）
    expect(payload).not.toMatch(/```piercode-context(?![-\w])/);
    expect(payload).not.toContain('compressed_context_handoff');
  });

  it('labels the init vs compressed-context sections in the packet handoff', () => {
    const packetRaw = '```piercode-context\n{"version":1}\n```';
    const payload = formatPacketHandoffPrompt(packetRaw, 'INIT PROMPT');

    // 初始化(运行说明)和上次会话压缩上下文必须分段标注，避免混在一起。
    expect(payload).toContain('运行说明');
    expect(payload).toContain('压缩上下文');
    expect(payload.indexOf('压缩上下文')).toBeLessThan(payload.indexOf('运行说明'));
  });

  it('omits the init-prompt section in packet handoff when no init prompt', () => {
    const packetRaw = '```piercode-context\n{"version":1}\n```';
    const payload = formatPacketHandoffPrompt(packetRaw, '');

    expect(payload).toContain('```piercode-context');
    expect(payload).not.toContain('运行说明');
  });

  it('extracts structured fields from a fenced JSON context packet for card rendering', () => {
    const packet = parsePierCodeContextPacket([
      '```piercode-context',
      JSON.stringify({
        version: 1,
        reason: 'piercode_requested',
        goal: '修复压缩上下文',
        completed: ['修好提示词'],
        current_state: '正在做渲染',
        key_files: ['index.ts'],
        evidence: ['vitest 通过'],
        pending: ['渲染卡片', '加状态'],
        constraints: ['用中文'],
        next_action: '开新会话',
      }),
      '```',
    ].join('\n'))!;

    const fields = extractContextPacketFields(packet);
    expect(fields.goal).toBe('修复压缩上下文');
    expect(fields.next_action).toBe('开新会话');
    // 数组字段保留为字符串数组，供卡片逐项渲染
    expect(fields.pending).toEqual(['渲染卡片', '加状态']);
    expect(fields.completed).toEqual(['修好提示词']);
    expect(fields.reason).toBe('piercode_requested');
  });

  it('extracts fields from the legacy XML-wrapped ```json context packet', () => {
    const packet = parsePierCodeContextPacket([
      '<piercode_context_packet version="1" reason="model_initiated">',
      '```json',
      JSON.stringify({ goal: '旧格式', pending: ['开新会话'] }),
      '```',
      '</piercode_context_packet>',
    ].join('\n'))!;

    const fields = extractContextPacketFields(packet);
    expect(fields.goal).toBe('旧格式');
    expect(fields.pending).toEqual(['开新会话']);
  });

  it('returns empty fields (not throw) for a local-summary handoff packet', () => {
    const packet = parsePierCodeContextPacket([
      '```piercode-context',
      JSON.stringify({ version: 1, reason: 'compressed_context_handoff', context: '本地摘要', instruction: '继续' }),
      '```',
    ].join('\n'))!;

    const fields = extractContextPacketFields(packet);
    // 本地摘要包没有结构化字段，goal 等为空，但 context 文本可读
    expect(fields.goal).toBe('');
    expect(fields.context).toBe('本地摘要');
    expect(fields.reason).toBe('compressed_context_handoff');
  });
});
