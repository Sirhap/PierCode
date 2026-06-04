import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTO_APPROVE_BROWSER_ACTIONS,
  DEFAULT_AUTO_EXECUTE,
  DEFAULT_STEALTH_MODE,
  DEFAULT_QWEN_COMPRESSION_ENABLED,
  DEFAULT_QWEN_MAX_CONTEXT_TOKENS,
  DEFAULT_QWEN_MAX_SUMMARY_TOKENS,
  resolveAutoApproveBrowserActions,
  resolveAutoExecute,
  resolveStealthMode,
  resolveQwenCompressionConfig,
} from '../settings';

describe('resolveAutoExecute', () => {
  it('defaults auto execution off when unset', () => {
    expect(DEFAULT_AUTO_EXECUTE).toBe(false);
    expect(resolveAutoExecute(undefined)).toBe(false);
    expect(resolveAutoExecute(null)).toBe(false);
  });

  it('preserves explicit user choices', () => {
    expect(resolveAutoExecute(true)).toBe(true);
    expect(resolveAutoExecute(false)).toBe(false);
  });
});

describe('resolveAutoApproveBrowserActions', () => {
  it('defaults browser action auto approval off when unset', () => {
    expect(DEFAULT_AUTO_APPROVE_BROWSER_ACTIONS).toBe(false);
    expect(resolveAutoApproveBrowserActions(undefined)).toBe(false);
    expect(resolveAutoApproveBrowserActions(null)).toBe(false);
  });

  it('preserves explicit browser action auto approval choices', () => {
    expect(resolveAutoApproveBrowserActions(true)).toBe(true);
    expect(resolveAutoApproveBrowserActions(false)).toBe(false);
  });
});

describe('resolveStealthMode', () => {
  it('defaults stealth mode off when unset', () => {
    expect(DEFAULT_STEALTH_MODE).toBe(false);
    expect(resolveStealthMode(undefined)).toBe(false);
    expect(resolveStealthMode(null)).toBe(false);
  });

  it('preserves explicit stealth mode choices', () => {
    expect(resolveStealthMode(true)).toBe(true);
    expect(resolveStealthMode(false)).toBe(false);
  });
});

describe('resolveQwenCompressionConfig', () => {
  it('uses the Qwen compression defaults when unset', () => {
    expect(resolveQwenCompressionConfig(undefined)).toEqual({
      enabled: DEFAULT_QWEN_COMPRESSION_ENABLED,
      maxContextTokens: DEFAULT_QWEN_MAX_CONTEXT_TOKENS,
      maxSummaryTokens: DEFAULT_QWEN_MAX_SUMMARY_TOKENS,
    });
  });

  it('preserves valid Qwen compression overrides', () => {
    expect(resolveQwenCompressionConfig({
      enabled: false,
      maxContextTokens: 123,
      maxSummaryTokens: 45,
    })).toEqual({
      enabled: false,
      maxContextTokens: 123,
      maxSummaryTokens: 45,
    });
  });
});
