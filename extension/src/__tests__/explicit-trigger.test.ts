/**
 * #10 explicit trigger prefix (optional mode).
 *
 * messageHasPierCodeTrigger detects whether the user's message opted this turn
 * into tool detection via a /piercode or @piercode prefix. The gate using it in
 * scanText is OFF by default, so this only matters when the user enables
 * explicitTriggerMode.
 */
import { describe, it, expect } from 'vitest';
import { messageHasPierCodeTrigger } from '../content/explicit-trigger';

describe('#10 messageHasPierCodeTrigger', () => {
  it('matches a leading /piercode', () => {
    expect(messageHasPierCodeTrigger('/piercode read main.go')).toBe(true);
  });

  it('matches a leading @piercode', () => {
    expect(messageHasPierCodeTrigger('@piercode 帮我跑测试')).toBe(true);
  });

  it('matches a trigger after leading whitespace / mid-sentence at a boundary', () => {
    expect(messageHasPierCodeTrigger('  /piercode go')).toBe(true);
    expect(messageHasPierCodeTrigger('hey @piercode please run')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(messageHasPierCodeTrigger('/PierCode list')).toBe(true);
    expect(messageHasPierCodeTrigger('@PIERCODE x')).toBe(true);
  });

  it('does NOT match without the prefix sigil', () => {
    expect(messageHasPierCodeTrigger('piercode read the file')).toBe(false);
    expect(messageHasPierCodeTrigger('just a normal question')).toBe(false);
  });

  it('does NOT match the token embedded in a word/path (no boundary)', () => {
    expect(messageHasPierCodeTrigger('see docs/piercodexyz')).toBe(false);
    expect(messageHasPierCodeTrigger('a@piercodebot.com')).toBe(false);
  });

  it('handles empty / falsy input', () => {
    expect(messageHasPierCodeTrigger('')).toBe(false);
    expect(messageHasPierCodeTrigger(undefined as unknown as string)).toBe(false);
  });
});
