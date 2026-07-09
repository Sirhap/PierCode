# Fix: chatgpt 子 agent 刷新后重复执行

日期: 2026-06-26
分支: dev

## 症状
chatgpt 网页里主 agent `spawn_agent` 开子 agent。刷新 chatgpt 网页 tab 后,已触发的子 agent 又被执行一遍。

## Root cause (systematic-debugging Phase 1, 已确认)

chatgpt 走 **content DOM-observer 检测路径**(非 SSE/listen);`spawn_agent` 因 `hasApiClient(chatgpt)` 走 **API 子 agent 路由**(`extension/src/content/index.ts` `executeToolCallReturn`)。

关键时序缺陷:
- spawn 分支 `await runSpawnBatchRecoverable([spawn])` —— 整个子 agent 对话跑完(可数分钟)才 resolve。
- `markExecuted(key)` 在批量循环(`runBatchItem`)里,**在 `executeToolCallReturn` 返回之后**才落(index.ts:~2200)。
- 防重复执行的两道闸:`executingKeys`(内存)+ `isExecuted`/`markExecuted`(localStorage `piercode_executed`)。

→ 子 agent **运行期间**用户刷新:
1. content tab 重载,内存态(`executingKeys`、spawn promise、poll/listener)全清。
2. 但 SW 端 recoverable batch **仍在跑/可恢复**(持久化)。
3. content DOM 重扫主 agent 回复里的 `spawn_agent` fence;此 key 刷新前没跑到 `markExecuted` → `isExecuted=false`。
4. → 重新 `runSpawnBatchRecoverable`,**全新 batchKey** → SW 开**第二个** batch → 子 agent 任务重跑。

整个子 agent 执行期 = 不设防的刷新窗口。这是 RC-1,唯一证实的 root cause。

排除项:
- **scope/dedup key 不稳** (RC-2): `getConversationKey`→`ensureScopeId` 跨真实刷新稳定(sessionStorage 全局键 + scope map),`toolDedupHash` render-independent。现有 `conversation-scope.test.ts` / `parser-dedup.test.ts` 充分覆盖 qwen/claude real-refresh,chatgpt 同 `/c/<uuid>` 模式。排除。
- **markExecuted 不被调** (候选): spawn API 路由返回 `sendable:true` → markExecuted 会调。排除。

## 修复 (Phase 4)
`extension/src/content/index.ts`:
1. `runSpawnBatchRecoverable(spawns, onAccepted?)` 加可选回调;在 SW **accepted ack / inline-result**(dispatch 不可逆、SW 已接管)那一刻 `fireAccepted()` 一次(含 kickoff 重试路径)。
2. spawn_agent API 分支: `runSpawnBatchRecoverable([spawn], () => markExecuted(spawnDedupKey(toolCall)))` —— 接管即标记,不等结果。
3. 新增 `spawnDedupKey(toolCall)`,复用批量循环同公式 `${convId}:${name}:${callId|toolDedupHash}`,保证提前标记与刷新后重扫 key 一致。

效果: 子 agent 运行中刷新 → key 已标记 → DOM 重扫 `isExecuted=true` → 不重 spawn;SW 端原 batch 照常恢复+注入结果。

权衡: SW kickoff **失败**(reject)不 fireAccepted → key 不标记,可重试(失败已 inject 错误消息,主 agent 自行决定)。spawn accepted 后即标记,即使结果未回——"开了不可逆 batch"即视为已执行,正确。

## 验证
- `tsc --noEmit`: 0
- `vitest`: 673 passed (含 content-build.test → content.js 仍是合法 classic MV3)
- 真实刷新时序(content↔SW)纯单测无法复现,**需用户实测**: chatgpt 主 agent spawn 子 agent,运行中刷新页面 → 应不再重跑。

## 待用户确认
若"子 agent **完全跑完后**再刷新也重跑",则存在 RC-2 之外的第二路径,需进一步查(当前证据指向只有运行期窗口)。
