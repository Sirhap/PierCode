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
