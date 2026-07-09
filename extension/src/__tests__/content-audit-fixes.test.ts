import { describe, expect, it } from 'vitest';
import contentSource from '../content/index.ts?raw';

// content/index.ts is an MV3 classic content script whose scanText pipeline is
// not unit-testable in isolation (no exports, heavy DOM coupling). These follow
// the established ?raw source-assertion convention (see ws-linker-focus.test).

describe('Chat Z generic-parser fallthrough (audit #8)', () => {
  it('only short-circuits the generic parsers when CodeMirror tool containers exist', () => {
    // The Chat Z DOM branch must compute whether it found containers...
    expect(contentSource).toContain('const chatzHasContainers = toolContainers.length > 0;');
    // ...and only return (skipping the fence/XML parsers) when it did.
    expect(contentSource).toContain('if (chatzHasContainers) {');
  });

  it('does not unconditionally return from the Chat Z branch before Phase 1', () => {
    // Pin the regression: the old code had a bare `return;` right after the
    // "Chat Z 已通过 DOM 直接提取" comment that fired even with zero containers.
    const idx = contentSource.indexOf('Chat Z handled via DOM extraction');
    expect(idx).toBeGreaterThan(-1);
    const block = contentSource.slice(idx, idx + 400);
    // The return must be guarded by the container check, not standalone.
    expect(block).toContain('if (chatzHasContainers) {');
  });
});

describe('master switch stops background timers (audit #14)', () => {
  it('defines stopTokenRefresh and calls it when the switch is turned off', () => {
    expect(contentSource).toContain('function stopTokenRefresh()');
    expect(contentSource).toContain('clearInterval(tokenRefreshTimer)');
    // The disable branch must stop the 3s token-refresh timer.
    const off = contentSource.indexOf('总开关已关闭，插件停用');
    expect(off).toBeGreaterThan(-1);
    const offBlock = contentSource.slice(off - 400, off);
    expect(offBlock).toContain('stopTokenRefresh()');
  });

  it('restarts the token-refresh timer when the switch is turned back on', () => {
    const on = contentSource.indexOf('总开关已开启，恢复运行');
    expect(on).toBeGreaterThan(-1);
    const onBlock = contentSource.slice(on - 400, on);
    expect(onBlock).toContain('startTokenRefresh()');
  });
});

describe('master switch clears rendered cards on teardown (Bug3)', () => {
  it('removes tool-card DOM + liveCardKeys, matching checkContext\'s invalid-context cleanup', () => {
    // Without this, cards rendered before the switch was flipped off linger on
    // screen — the disable branch used to only remove the init button.
    const off = contentSource.indexOf('总开关已关闭，插件停用');
    expect(off).toBeGreaterThan(-1);
    const offBlock = contentSource.slice(off - 600, off);
    expect(offBlock).toContain("document.querySelectorAll('[data-piercode-key]').forEach(el => el.remove());");
    expect(offBlock).toContain('clearLiveCardKeys();');
  });
});
