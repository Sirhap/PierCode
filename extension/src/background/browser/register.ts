// Registers controller methods into the dispatch TOOL_TABLE. Imported once at SW
// startup (background/index.ts). Kept separate from dispatch.ts so the router stays
// free of a controller import, and separate from controller.ts so the controller
// stays free of a dispatch import — register.ts is the single wiring seam.
import { TOOL_TABLE, READONLY_TOOLS, type ToolMethod } from './dispatch'
import { getController } from './controller'

let registered = false

/** Idempotent. Populates TOOL_TABLE + READONLY_TOOLS for all phases shipped so far. */
export function registerBrowserTools(): void {
  if (registered) return
  registered = true
  const c = getController()

  const read: Array<[string, ToolMethod]> = [
    ['browser_snapshot', a => c.snapshot(a)],
    ['browser_tabs', a => c.tabs(a)],
    ['browser_screenshot', a => c.screenshot(a)],
    ['browser_find', a => c.find(a as any)],
    ['browser_get_content', a => c.getContent(a)],
    ['browser_get_page_text', a => c.getPageText(a)],
    ['browser_get_attributes', a => c.getAttributes(a as any)],
    ['browser_console', a => c.console(a)],
    ['browser_network', a => c.network(a)],
    ['browser_wait', a => c.wait(a)],
    ['browser_wait_for_function', a => c.waitForFunction(a as any)],
    ['browser_pdf', a => c.pdf(a)],
    ['browser_record', a => c.record(a)],
  ]
  for (const [name, fn] of read) { TOOL_TABLE.set(name, fn); READONLY_TOOLS.add(name) }
}
