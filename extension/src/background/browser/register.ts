// Registers controller methods into the dispatch TOOL_TABLE. Imported once at SW
// startup (background/index.ts). Kept separate from dispatch.ts so the router stays
// free of a controller import, and separate from controller.ts so the controller
// stays free of a dispatch import — register.ts is the single wiring seam.
import { TOOL_TABLE, READONLY_TOOLS, dispatchBrowserTool, type ToolMethod } from './dispatch'
import { getController, setBatchDispatcher } from './controller'

let registered = false

/** Idempotent. Populates TOOL_TABLE + READONLY_TOOLS for all phases shipped so far. */
export function registerBrowserTools(): void {
  if (registered) return
  registered = true
  const c = getController()
  // Wire browser_batch's re-dispatcher (avoids a controller→dispatch import; see
  // setBatchDispatcher in controller.ts for why).
  setBatchDispatcher(dispatchBrowserTool)

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
    ['browser_wait_stable', a => c.waitStable(a as any)],
    ['browser_assert', a => c.assert(a as any)],
    // visual_diff reads the page (screenshot) and writes only extension-local
    // storage (the baseline) — page-wise read-only, so it skips the gates.
    ['browser_visual_diff', a => c.visualDiff(a as any)],
    ['browser_pdf', a => c.pdf(a)],
    ['browser_record', a => c.record(a)],
  ]
  for (const [name, fn] of read) { TOOL_TABLE.set(name, fn); READONLY_TOOLS.add(name) }

  // Interactive (Phase 2) — gated (sensitivity + approval) in dispatch.ts.
  const interactive: Array<[string, ToolMethod]> = [
    ['browser_click', a => c.click(a as any)],
    ['browser_type', a => c.type(a as any)],
    ['browser_hover', a => c.hover(a as any)],
    ['browser_scroll', a => c.scroll(a as any)],
    ['browser_select', a => c.select(a as any)],
    ['browser_press_key', a => c.pressKey(a as any)],
    ['browser_drag', a => c.drag(a as any)],
    ['browser_focus', a => c.focus(a as any)],
    ['browser_navigate', a => c.navigate(a as any)],
    ['browser_new_tab', a => c.newTab(a as any)],
    ['browser_use_tab', a => c.useTab(a as any)],
    ['browser_go_back', a => c.goBack(a)],
    ['browser_go_forward', a => c.goForward(a)],
    ['browser_reload', a => c.reload(a as any)],
    ['browser_mark', a => c.mark(a)],
    ['browser_handle_dialog', a => c.handleDialog(a as any)],
    ['browser_wait_for_navigation', a => c.waitForNavigation(a as any)],
    ['browser_resize', a => c.resize(a as any)],
    ['browser_viewport', a => c.viewport(a as any)],
    ['browser_emulate', a => c.emulate(a as any)],
  ]
  for (const [name, fn] of interactive) TOOL_TABLE.set(name, fn)

  // Write / high-risk (Phase 3) — high-risk ones approval-gated in dispatch.ts.
  const write: Array<[string, ToolMethod]> = [
    ['browser_evaluate', a => c.evaluate(a as any)],
    ['browser_storage', a => c.storage(a as any)],
    ['browser_form_input', a => c.formInput(a as any)],
    ['browser_clipboard', a => c.clipboard(a as any)],
    ['browser_cookies', a => c.cookies(a as any)],
    ['browser_set_cookie', a => c.setCookie(a as any)],
    ['browser_downloads', a => c.downloads(a)],
    ['browser_upload', a => c.upload(a as any)],
    ['browser_zoom', a => c.zoom(a as any)],
    ['browser_finalize_tabs', a => c.finalizeTabs(a as any)],
    ['browser_batch', a => c.batch(a as any)],
    ['browser_test', a => c.test(a as any)],
    ['browser_intercept', a => c.intercept(a as any)],
    ['browser_reset', a => c.reset(a as any)],
  ]
  for (const [name, fn] of write) TOOL_TABLE.set(name, fn)
  // browser_batch / browser_test bypass the OUTER gate (no tab pre-resolution, no double
  // lock): each re-dispatched sub-call runs its own gate + per-tab lock. Mark them
  // read-only so the dispatcher skips the wrapper gate (mirrors Go browser_batch
  // taking no lock).
  READONLY_TOOLS.add('browser_batch')
  READONLY_TOOLS.add('browser_test')
  // browser_downloads is a pure read of chrome.downloads (no tab, no mutation) — skip
  // the gate too. browser_cookies stays gated (sensitive credential read).
  READONLY_TOOLS.add('browser_downloads')
}
