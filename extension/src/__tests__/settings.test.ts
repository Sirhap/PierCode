import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTO_APPROVE_BROWSER_ACTIONS,
  DEFAULT_AUTO_EXECUTE,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_STEALTH_MODE,
  DEFAULT_QWEN_COMPRESSION_ENABLED,
  DEFAULT_QWEN_MAX_CONTEXT_TOKENS,
  DEFAULT_QWEN_MAX_SUMMARY_TOKENS,
  resolveAutoApproveBrowserActions,
  resolveAutoExecute,
  resolvePermissionMode,
  resolveStealthMode,
  resolveQwenCompressionConfig,
  DEFAULT_COMPRESSION_ENABLED,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_MAX_SUMMARY_TOKENS,
  DEFAULT_PLATFORM_THRESHOLDS,
  resolveContextCompressionConfig,
  thresholdForPlatform,
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

describe('resolvePermissionMode', () => {
  it('defaults to default mode when unset or invalid', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('default');
    expect(resolvePermissionMode(undefined)).toBe('default');
    expect(resolvePermissionMode(null)).toBe('default');
    expect(resolvePermissionMode('invalid')).toBe('default');
  });

  it('preserves valid permission modes', () => {
    expect(resolvePermissionMode('default')).toBe('default');
    expect(resolvePermissionMode('auto')).toBe('auto');
    expect(resolvePermissionMode('unrestricted')).toBe('unrestricted');
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

describe('resolveContextCompressionConfig', () => {
  it('uses defaults when both new and legacy config are absent', () => {
    expect(resolveContextCompressionConfig(undefined)).toEqual({
      enabled: DEFAULT_COMPRESSION_ENABLED,
      perPlatformThresholds: { ...DEFAULT_PLATFORM_THRESHOLDS },
      defaultMaxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      maxSummaryTokens: DEFAULT_MAX_SUMMARY_TOKENS,
    });
  });

  it('migrates from legacy qwen config when new config is absent', () => {
    const migrated = resolveContextCompressionConfig(undefined, {
      enabled: false,
      maxContextTokens: 333_000,
      maxSummaryTokens: 7_000,
    });
    expect(migrated.enabled).toBe(false);
    expect(migrated.perPlatformThresholds.qwen).toBe(333_000);
    expect(migrated.maxSummaryTokens).toBe(7_000);
    // 其他平台保留默认
    expect(migrated.perPlatformThresholds.chatgpt).toBe(DEFAULT_PLATFORM_THRESHOLDS.chatgpt);
  });

  it('merges user overrides over platform defaults and drops invalid thresholds', () => {
    const cfg = resolveContextCompressionConfig({
      enabled: true,
      perPlatformThresholds: { chatgpt: 64_000, qwen: -5, bogus: 'x' as unknown as number },
      defaultMaxContextTokens: 90_000,
      maxSummaryTokens: 12_000,
    });
    expect(cfg.perPlatformThresholds.chatgpt).toBe(64_000);
    // 非法值被丢弃，回退默认
    expect(cfg.perPlatformThresholds.qwen).toBe(DEFAULT_PLATFORM_THRESHOLDS.qwen);
    expect(cfg.perPlatformThresholds.bogus).toBeUndefined();
    expect(cfg.defaultMaxContextTokens).toBe(90_000);
  });

  it('falls back to defaults for invalid scalar fields', () => {
    const cfg = resolveContextCompressionConfig({
      enabled: 'yes' as unknown as boolean,
      defaultMaxContextTokens: -1,
      maxSummaryTokens: 0,
    });
    expect(cfg.enabled).toBe(DEFAULT_COMPRESSION_ENABLED);
    expect(cfg.defaultMaxContextTokens).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
    expect(cfg.maxSummaryTokens).toBe(DEFAULT_MAX_SUMMARY_TOKENS);
  });
});

describe('thresholdForPlatform', () => {
  const cfg = resolveContextCompressionConfig({
    enabled: true,
    perPlatformThresholds: { chatgpt: 64_000 },
    defaultMaxContextTokens: 90_000,
    maxSummaryTokens: 12_000,
  });

  it('returns the per-platform threshold when set', () => {
    expect(thresholdForPlatform(cfg, 'chatgpt')).toBe(64_000);
  });

  it('falls back to default for unlisted platforms', () => {
    expect(thresholdForPlatform(cfg, 'unknown-platform')).toBe(90_000);
  });
});

// 通用压缩配置在 settings.ts 与 content/qwen-settings.ts 各存一份（content 不能
// 经 settings.ts 引到叶子，否则 Rollup 把叶子拆成 content.js 也要 import 的共享
// chunk，破坏 MV3 classic 脚本）。这里守护两份实现/默认值不漂移。
describe('settings.ts <-> content/qwen-settings.ts compression parity', () => {
  it('produces identical defaults and resolution across both copies', async () => {
    const leaf = await import('../content/qwen-settings');

    expect(leaf.DEFAULT_COMPRESSION_ENABLED).toBe(DEFAULT_COMPRESSION_ENABLED);
    expect(leaf.DEFAULT_MAX_CONTEXT_TOKENS).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
    expect(leaf.DEFAULT_MAX_SUMMARY_TOKENS).toBe(DEFAULT_MAX_SUMMARY_TOKENS);
    expect(leaf.DEFAULT_PLATFORM_THRESHOLDS).toEqual(DEFAULT_PLATFORM_THRESHOLDS);

    const samples: Array<[unknown, unknown]> = [
      [undefined, undefined],
      [undefined, { enabled: false, maxContextTokens: 333_000, maxSummaryTokens: 7_000 }],
      [{ enabled: true, perPlatformThresholds: { chatgpt: 64_000, qwen: -5, bogus: 'x' }, defaultMaxContextTokens: 90_000, maxSummaryTokens: 12_000 }, undefined],
      [{ enabled: 'yes', defaultMaxContextTokens: -1, maxSummaryTokens: 0 }, undefined],
    ];
    for (const [value, legacy] of samples) {
      expect(leaf.resolveContextCompressionConfig(value, legacy))
        .toEqual(resolveContextCompressionConfig(value, legacy));
    }

    const cfg = resolveContextCompressionConfig({ perPlatformThresholds: { chatgpt: 64_000 }, defaultMaxContextTokens: 90_000 });
    expect(leaf.thresholdForPlatform(cfg, 'chatgpt')).toBe(thresholdForPlatform(cfg, 'chatgpt'));
    expect(leaf.thresholdForPlatform(cfg, 'unknown')).toBe(thresholdForPlatform(cfg, 'unknown'));
  });
});
