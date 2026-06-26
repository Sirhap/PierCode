import { describe, expect, it } from 'vitest';
import wsLinkerSource from '../content/ws-linker.ts?raw';

// spawn_agent (Go) now pushes an `open_worker_tab` WS message to the dispatcher
// instead of opening the worker tab through the dead Go→WS relay. The dispatcher
// content script must handle that message by opening the tab SW-natively via
// EXEC_BROWSER_TOOL/browser_new_tab — gated to the owning client so connected
// browsers don't each open a duplicate.
//
// The ws-linker onmessage handler is an internal closure (no export); this file
// follows the established source-assertion convention used by ws-linker-focus.
describe('open_worker_tab dispatcher handler', () => {
  it('handles open_worker_tab and opens the tab via EXEC_BROWSER_TOOL/browser_new_tab', () => {
    expect(wsLinkerSource).toContain('msg.type === "open_worker_tab"');
    expect(wsLinkerSource).toContain('type: "EXEC_BROWSER_TOOL"');
    expect(wsLinkerSource).toContain('name: "browser_new_tab"');
    // The worker URL from the server is forwarded as the tab URL.
    expect(wsLinkerSource).toContain('args: { url: msg.url }');
  });

  it('only the owning dispatcher acts (isForThisClient gate)', () => {
    // The branch must early-return for messages addressed to a different client,
    // so two connected browsers don't both open the worker tab.
    const idx = wsLinkerSource.indexOf('msg.type === "open_worker_tab"');
    expect(idx).toBeGreaterThan(-1);
    const branch = wsLinkerSource.slice(idx, idx + 600);
    expect(branch).toContain('if (!isForThisClient(msg)) return;');
  });
});
