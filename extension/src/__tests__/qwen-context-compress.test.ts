import { describe, expect, it } from 'vitest';
import {
  compactToolOutputForChat,
  estimateContextTokens,
  estimateTokens,
  generateSummary,
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
});
