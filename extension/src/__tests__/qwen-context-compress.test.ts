import { describe, expect, it } from 'vitest';
import {
  compactToolOutputForChat,
  estimateContextTokens,
  estimateTokens,
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

  it('rejects invalid fenced JSON context packets', () => {
    const parsed = parsePierCodeContextPacket([
      '```piercode-context',
      '{"version":1,',
      '```',
    ].join('\n'));

    expect(parsed).toBeNull();
  });

  it('builds a visible Qwen compression request with fenced JSON and no piercode-tool', () => {
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
    expect(prompt).toContain('请继续实现上下文压缩');
  });

  it('builds compressed handoff payload as init prompt plus fenced JSON', () => {
    const payload = formatQwenCompressedContextPrompt('压缩摘要', 'INIT PROMPT');

    expect(payload).toContain('INIT PROMPT');
    expect(payload).toContain('```piercode-context');
    expect(payload).toContain('"reason": "compressed_context_handoff"');
    expect(payload).toContain('"context": "压缩摘要"');
    expect(payload).toContain('"instruction": "继续执行用户后续任务。"');
    expect(payload.indexOf('```piercode-context')).toBeLessThan(payload.indexOf('INIT PROMPT'));
    expect(payload).not.toContain('<compressed_context>');
  });

  it('forwards a model packet verbatim without double-wrapping it', () => {
    const packetRaw = [
      '```piercode-context',
      '{"version":1,"reason":"piercode_requested","goal":"修复压缩注入","next_action":"打开新会话"}',
      '```',
    ].join('\n');

    const payload = formatPacketHandoffPrompt(packetRaw, 'INIT PROMPT');

    expect(payload).toContain('INIT PROMPT');
    expect(payload.indexOf('```piercode-context')).toBeLessThan(payload.indexOf('INIT PROMPT'));
    // 原始 packet 内容原样出现，结构化字段没被压成转义字符串
    expect(payload).toContain('"reason":"piercode_requested"');
    expect(payload).toContain('"next_action":"打开新会话"');
    // 关键：只有一层 piercode-context 围栏，没有二次套壳
    expect(payload.match(/```piercode-context/g)?.length).toBe(1);
    // 也不会被塞进 compressed_context_handoff 的 context 字段
    expect(payload).not.toContain('compressed_context_handoff');
  });
});
