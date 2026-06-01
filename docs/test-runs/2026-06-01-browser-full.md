# Browser Full Test Run - 2026-06-01

## Result

Final status: pass.

All automated checks passed, the installed PierCode extension was reloaded in the user's real Google Chrome, the backend relay stayed connected, the enhanced live browser smoke passed end-to-end, and a fresh Qwen conversation passed initialization, tool execution, result fill-back, and screenshot attachment upload.

## Environment

- Workspace: `/Volumes/other/IdeaProjects/sirhao/piercode`
- Backend command: `go run ./cmd/server -dir . -port 63643 -token piercode-e2e-2026-fixed-token-abcdef1234567890`
- Backend URL: `http://127.0.0.1:63643`
- Backend token source: fixed test token supplied on the server command line so the installed extension could reconnect after backend restart.
- Chrome: user real Google Chrome, not an isolated profile.
- PierCode extension id: `lolcioebooncpbcgfdkcpolcihcdhcfl`
- Extension reload evidence: `chrome://extensions/?id=lolcioebooncpbcgfdkcpolcihcdhcfl` showed `已重新加载`; the extension was enabled and file URL access was enabled.
- AI platform: Qwen at `https://chat.qwen.ai/`
- Final stats evidence after live smoke: `browser_clients: 2`, `browser_relays: 1`, `browser_providers: {Extension: 1, Qwen: 1}`
- Earlier stats immediately after extension reload and Qwen tabs were present: `browser_clients: 3`, `browser_relays: 1`, `browser_providers: {Extension: 1, Qwen: 2}`

## Commands

| Time | Command | Result | Evidence |
| --- | --- | --- | --- |
| 2026-06-01 16:13 CST | `go test ./...` | pass | All Go packages passed, including `cmd/server`, `internal/browser`, `internal/executor`, `internal/server`, and `internal/tool`. |
| 2026-06-01 16:13 CST | `cd extension && npm test -- --run` | pass | Vitest: 12 test files passed, 117 tests passed, duration 1.13s. |
| 2026-06-01 16:13 CST | `cd extension && npx tsc --noEmit` | pass | No TypeScript diagnostics. |
| 2026-06-01 16:13 CST | `node --check scripts/browser-live-smoke.mjs` | pass | Script syntax check exited 0. |
| 2026-06-01 16:13 CST | `cd extension && npm run build` | pass | Vite build succeeded, 55 modules transformed, output included `background.js`, `content.js`, and `popup.js`. |
| 2026-06-01 16:23 CST | `PIERCODE_API_URL=http://127.0.0.1:63643 PIERCODE_TOKEN=... node scripts/browser-live-smoke.mjs` | fail | Correctly failed because the backend had no real Chrome extension relay yet: `/stats` showed `browser_relays:0`. The extension was then reloaded in real Chrome. |
| 2026-06-01 16:24 CST | Chrome extension reload | pass | Real Chrome extension page showed `已重新加载`; `/stats` recovered to `{"browser_clients":2,"browser_providers":{"Extension":1,"Qwen":1},"browser_relays":1}`. |
| 2026-06-01 16:26 CST | `PIERCODE_API_URL=http://127.0.0.1:63643 PIERCODE_TOKEN=... node scripts/browser-live-smoke.mjs` | pass | Real user Chrome with installed extension. Page URL `http://127.0.0.1:60224/`. Enhanced script passed, including explicit approval approve/reject and done-receipt assertions. |
| 2026-06-01 16:24 CST | `curl -H 'Authorization: Bearer ...' http://127.0.0.1:63643/stats` | pass | Returned `{"browser_clients":2,"browser_providers":{"Extension":1,"Qwen":1},"browser_relays":1}`. |

## Real Chrome Results

| Case | Result | Evidence |
| --- | --- | --- |
| Backend restart | pass | Backend started on `127.0.0.1:63643` with fixed token and accepted browser-tool requests from the installed Chrome extension. |
| Extension reload | pass | The real Chrome extension detail page for `lolcioebooncpbcgfdkcpolcihcdhcfl` was opened and reloaded; Chrome displayed `已重新加载`. |
| Extension relay | pass | `/stats` reported one Extension provider and one browser relay after reload and again after the final live smoke. |
| Tab lifecycle | pass | Live smoke created controlled tab `104679827`, listed it, selected it, and finalized controlled tabs at cleanup. |
| Navigation/history | pass | Covered initial navigation, second page navigation, back, forward, reload, and return to the report page before dialog checks. |
| Accessibility snapshot | pass | Snapshot contained `PierCode live browser report`; fresh snapshot `snap_10` was used before ref-click validation. |
| Find/click/type/focus/key | pass | Found `Submit request`, focused requester name, typed requester/email, submitted email with Enter, and pressed End. |
| Form input/select/radio/checkbox | pass | Selected priority by label, value, and index; selected department; checked review checkbox; selected travel radio; filled contenteditable notes. |
| Coordinate click | pass | Evaluated button coordinates, clicked by `x/y`, and verified `coordinate clicked`. |
| Hover/scroll/wait | pass | Hover changed status to `details visible`; scroll reached `Bottom of long approval report`; async and delayed-panel waits passed. |
| Content extraction | pass | Structured content, form HTML, and full page text were read and verified. |
| File upload | pass | Uploaded `.piercode/live-smoke/upload-fixture.txt`; page reported `upload-fixture.txt:29`. |
| Drag and drop | pass | Dragged `#dragSource` to `#dropTarget`; page reported `invoice dropped`. |
| Screenshot/PDF/zoom | pass | Screenshot saved to `.piercode/screenshots/screenshot-1060830371.png` with 93135 bytes; full-page JPEG saved to `.piercode/screenshots/screenshot-3420484737.jpg` with 172715 bytes; PDF generated at `.piercode/live-smoke/browser-live-smoke.pdf` with 84763 bytes before cleanup; zoom screenshot saved under `/Users/sirhao/.piercode/screenshots/zoom-1780301994995336000.jpg`. |
| Console tools | pass | Console log and expected error were captured; `onlyErrors` returned the expected error; clear was verified by `No console messages recorded`. |
| Network tools | pass | `/api/ping` request captured as `GET 200 OK`; clear was verified by `No network requests recorded`. |
| Cookies | pass | Cookie name-only and value modes both worked; `piercode_live_cookie=ready` was returned when `includeValue` was enabled. |
| Downloads | pass | Download record id `16` completed for `/Users/sirhao/Downloads/piercode-live-report-60224.txt`, 31/31 bytes, URL `http://127.0.0.1:60224/download`. |
| Dialogs | pass | Alert accepted, confirm dismissed, and prompt accepted with prompt text; page state verified for confirm and prompt. |
| Approval approve | pass | Explicit approval case used call id `live-smoke-explicit-approval-approve`, clicked `#coordinateButton`, and waited for `browser_approval_done`; approval stats recorded `approved:32`. |
| Approval reject | pass | Explicit rejection case used call id `live-smoke-explicit-approval-reject`, returned `live smoke rejection check`, and waited for `browser_approval_done`; approval stats recorded `rejected:1`. |
| Approval done/failure handling | pass | Live smoke asserted `asked:33`, `approved:32`, `rejected:1`, `done:33`, and `mismatches:[]`, proving every approval ask reached a terminal done state. |
| Stop operation UI/message | pass | Covered by extension unit tests: stop button sends `STOP_BROWSER_OPERATION`, disables while stopping, and shows `正在停止`. |
| Popup/settings state | pass | Extension tests cover configure persistence, visual indicator behavior, downloads, and popup state. |
| Background tasks | pass | Existing automated coverage for task output/list/stop passed in Go and extension test suites. |

## Qwen Results

| Case | Result | Evidence |
| --- | --- | --- |
| Fresh conversation | pass | Opened a new Qwen conversation at `https://chat.qwen.ai/c/c5705bb4-2b41-411f-92ee-856c724796ed` because old/long conversations are slower and may hit quota. |
| Initialization | pass | Clicked `🔗 初始化`, submitted normally, and Qwen replied `你好，我是 PierCode，请问有什么可以帮你？`; no quota or initialization error remained. |
| Provider presence | pass | Stats showed Qwen provider connected; after cleanup final stats still showed `{Extension: 1, Qwen: 1}`. |
| Tool call extraction | pass | Normal user prompt produced `list_dir` tool call `qwen_read_1780301422738`; Qwen displayed a visible tool card. |
| Tool result fill-back | pass | Tool card showed `✅ 已执行`; output contained real repo entries such as `AGENTS.md`, `cmd/`, `docs/`, `extension/`, `go.mod`, `internal/`, and `scripts/`. |
| Attachment upload | pass | Normal user prompt produced `browser_screenshot` tool call `qwen_attach_1780301467195` with `attach:true`; Qwen displayed a visible tool card and `✅ 已执行`. |
| Attachment evidence | pass | Tool output contained `screenshot tabId=104679826 title="about:blank" url="about:blank" format=png bytes=8668`, saved `/Volumes/other/IdeaProjects/sirhao/piercode/.piercode/screenshots/screenshot-4218451719.png`, and returned `Attachment upload: uploaded to current AI chat page`; Qwen replied `截图已成功捕获并上传到当前聊天页面。测试完成.` |
| False-positive guard | pass | The real Qwen test used explicit tool-call prompts and observed visible tool-card execution, not ordinary Markdown code-block matching. Existing adapter tests for `Show more` and ordinary code-block handling passed in the Vitest suite. |
| PierCode self-development, long raw results | observed issue | In Qwen conversation `https://chat.qwen.ai/c/3169f2ad-c99f-4fd5-ab2b-faa1fd2d72d0`, a prompt asked Qwen to inspect PierCode itself with `list_dir` and four `read_file` calls. All five tool cards executed, but combined raw tool output was left in the Qwen input box and Qwen showed the 131072-character large-text guard. |
| PierCode self-development, compact results | pass | In fresh Qwen conversation `https://chat.qwen.ai/c/05f6ee40-846b-4042-9101-798e7e10219a`, four `read_file` calls used `limit:60`; all four cards executed, no 131072-character guard appeared, input stayed clear, and Qwen produced the expected self-development analysis. |
| Compact self-dev analysis evidence | pass | Qwen concluded that existing DOM/message/tool foundations are present in `extension/src/content/index.ts`, `extension/src/content/ws-linker.ts`, `extension/src/background/index.ts`, and `internal/server/ws.go`; it recommended a continuation packet, 20-turn trigger, backend snapshot/recovery, new-tab initialization, and tests for serialization, migration, retry/idempotency, secret stripping, and multi-platform behavior. |

## Bugs Found

| ID | Symptom | Root cause | Fix / Optimization | Retest |
| --- | --- | --- | --- | --- |
| BROWSER-FULL-001 | Extended live smoke failed at `browser_network` in an earlier run. | Network listener was read before a fresh request was generated. | Updated procedure/script to clear or prime network collection, trigger `/api/ping`, then read and verify. | pass |
| BROWSER-FULL-002 | Live smoke could leave stale controlled tabs open. | Cleanup did not close claimed tabs in all paths. | Finalization path now closes/cleans controlled tabs in `finally`. | pass |
| BROWSER-FULL-003 | Qwen initialization prompt could auto-submit unexpectedly. | Popup `自动提交` setting changes normal test timing. | Test procedure now records the setting and uses normal manual submit when auto-submit is off. | pass |
| BROWSER-FULL-004 | Browser tools could hang after MV3 service-worker inactivity. | WebSocket read could block forever after a quiet disconnect. | Backend WebSocket handling uses read deadlines and cleans stale connections. | pass |
| BROWSER-FULL-005 | First Qwen attachment attempt on an older conversation hit `Allocated quota exceeded`. | Existing conversation/model state was not reliable for a full attachment test. | Opened a fresh Qwen conversation, initialized again, then reran the attachment prompt. | pass |
| BROWSER-FULL-006 | Enhanced live smoke failed once with `snapshot is stale; call browser_snapshot again`. | The page changed after viewport/form operations, invalidating the earlier accessibility ref. | Smoke script now refreshes the accessibility snapshot immediately before ref-based click. | pass |
| BROWSER-FULL-007 | Download assertion was weak and an anchor-style download did not reliably create a current run record. | Fixture reused a generic filename and did not prove the current run produced a tracked Chrome download. | Smoke fixture now uses a normal button flow and unique filename `piercode-live-report-${pagePort}.txt`; test asserts current URL/download history. | pass |
| BROWSER-FULL-008 | Drag status could remain `not dropped` even when the command returned ok. | The local fixture listened to too narrow an event path. | Fixture now handles `mouseup`, `pointerup`, `dragover`, and `drop`, then asserts `invoice dropped`. | pass |
| BROWSER-FULL-009 | A rerun failed before tool coverage because `/stats` showed `browser_relays:0`. | Backend restart left the real Chrome extension service worker disconnected until the extension was reloaded. | Reloaded the installed extension in real Chrome and reran from the beginning; the smoke script also fails fast when no relay is present. | pass |
| BROWSER-FULL-010 | Approval coverage was previously too implicit. | Auto-approval WebSocket covered approve behavior, but the script did not assert approve/reject counts or `browser_approval_done` receipts. | Added explicit approve and reject call ids, waits for done receipts, and final approval statistics assertions. | pass |
| QWEN-SELF-DEV-001 | Qwen self-development test executed `list_dir` and multiple `read_file` tool cards, but the combined tool result was left in the Qwen input box instead of being sent for final analysis. Qwen showed: `如需输入超出 131072 个字符的文本，请将输入转换为 txt 文档通过上传文件的方式输入，或者在 设置-界面-粘贴大文本为文件 开启功能后以粘贴方式输入`. | Tool-result fill-back can exceed Qwen's large-text input threshold; relying on raw long `read_file` output is unsafe for future context compression and session handoff. | Future continuation-packet flow must compress/summarize tool results before fill-back, or attach large context as a file when Qwen supports it. Self-dev tests should include a long-result guard. | observed; requires product fix |
| QWEN-SELF-DEV-002 | Compact self-development flow needed a smaller test shape after QWEN-SELF-DEV-001. | Full-file `read_file` outputs are too large for Qwen; the same use case works when each tool result is bounded. | Retested in a fresh Qwen conversation using `read_file` with `limit:60` for four files. Tool cards executed, Qwen did not show the large-text guard, and Qwen produced the expected implementation analysis. | pass |

## Optimizations / Procedure Notes

1. Keep the fixed-token backend command for repeatable real-Chrome testing: `go run ./cmd/server -dir . -port 63643 -token piercode-e2e-2026-fixed-token-abcdef1234567890`.
2. Always reload the real installed extension after `extension/dist` is rebuilt; record the Chrome extension id and reload confirmation.
3. Use `/stats` with the bearer token; unauthenticated `/stats` correctly returns `unauthorized`.
4. For Qwen, prefer a fresh conversation for full regression. Long conversations can be slow and can inherit model/quota state unrelated to PierCode.
5. For browser-tool smoke, assert page state after every interaction instead of treating a successful command response as enough.
6. For downloads, use a per-run filename or URL so stale Chrome download history cannot create a false pass.
7. For accessibility refs, refresh the snapshot after layout, viewport, or form-state changes.
8. After backend restart, check authenticated `/stats` and reload the real Chrome extension if `browser_relays` is zero.
9. Approval tests must assert both the command result and the terminal `browser_approval_done` receipt.
10. Qwen has a large-text guard at 131072 characters. Long PierCode tool results should not be pasted back as raw text during self-development workflows; compress them or attach them as files before asking Qwen to continue.
11. For Qwen self-development tests, prefer bounded `read_file` windows such as `limit:60` and ask for synthesis after the bounded results are available.

## Coverage Matrix

| Feature | Automated Test | Real Chrome Live Smoke | Qwen Real Page | Status |
| --- | --- | --- | --- | --- |
| Go backend startup/routes | pass | pass | n/a | pass |
| Extension build/typecheck/unit tests | pass | pass | n/a | pass |
| Extension reload/configuration | pass | pass | n/a | pass |
| Browser relay/provider stats | pass | pass | pass | pass |
| Tab create/list/use/finalize | pass | pass | n/a | pass |
| Navigate/back/forward/reload | pass | pass | n/a | pass |
| Accessibility snapshot/ref click | pass | pass | n/a | pass |
| Find/click/type/focus/key | pass | pass | n/a | pass |
| Text input/contenteditable | pass | pass | n/a | pass |
| Checkbox/radio/select | pass | pass | n/a | pass |
| Coordinate click | pass | pass | n/a | pass |
| Hover/scroll/wait/load state | pass | pass | n/a | pass |
| Evaluate JS | pass | pass | n/a | pass |
| Content extraction | pass | pass | n/a | pass |
| File upload to page input | pass | pass | n/a | pass |
| Drag and drop | pass | pass | n/a | pass |
| PDF export | pass | pass | n/a | pass |
| Screenshot/zoom/full-page screenshot | pass | pass | pass | pass |
| Console log/error/clear | pass | pass | n/a | pass |
| Network capture/clear | pass | pass | n/a | pass |
| Cookies without/with values | pass | pass | n/a | pass |
| Downloads | pass | pass | n/a | pass |
| Dialog alert/confirm/prompt | pass | pass | n/a | pass |
| Approval approve | pass | pass | n/a | pass |
| Approval reject | pass | pass | n/a | pass |
| Approval rejection/failure done handling | pass | pass | n/a | pass |
| Stop operation UI/message | pass | pass | n/a | pass |
| Popup toggles/settings | pass | pass | n/a | pass |
| Visual indicators | pass | pass | n/a | pass |
| Qwen content script initialization | pass | n/a | pass | pass |
| Qwen tool-call extraction | pass | n/a | pass | pass |
| Qwen tool result fill-back | pass | n/a | pass | pass |
| Qwen ordinary code-block/Show more guard | pass | n/a | pass | pass |
| Attachment upload into AI page | pass | n/a | pass | pass |
| Qwen self-development with bounded tool results | pass | n/a | pass | pass |
| Qwen long raw tool-result guard | n/a | n/a | observed | requires product fix |
| Background task tools | pass | pass | n/a | pass |
| Sandbox/security behavior | pass | n/a | n/a | pass |
| Relay stability/read-timeout cleanup | pass | pass | pass | pass |

## Remaining Risk

No blocking risk remains for the 2026-06-01 full browser run. The only residual risk is external Qwen account/model availability in future reruns; the validated recovery is to open a fresh Qwen conversation, initialize again, and rerun the tool prompt.
