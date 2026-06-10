# PierCode 待办清单（无上下文版）

> 2026-06-10 整理。每项自带背景 + 文件 + 怎么做，照着做不需要历史会话记忆。
> 配套：[投资报告](investigation-batch-state-race.md)、[各计划](superpowers/plans/)。
> 当前分支 `dev`，领先 `origin/dev` 72 commits（未推）。本轮已合并：子agent转API+parser去重、DOM脆弱债收敛、只读工具Metadata、广播→源tab、NUL→US分隔符、E batch容器隔离、ChatGPT getAuth(413d702)。

---

## P0 — 一致性 bug（live 验证暴露，值得先修）

### [x] 1. `hasApiClient` 去掉 chatgpt（spawn_agent 白试一次失败）— 已修（fc4cc2b）

**背景**：官网 `spawn_agent` 在「有 API client 的平台」走内存 API 子对话，没有的回退 tab-worker。`extension/src/content/platform-caps.ts` 的 `hasApiClient` 当前含 `chatgpt`。但 **live 验证证明 ChatGPT API 路走不通**：拿到 accessToken 后，`/backend-api/conversation` 被 OpenAI 的 sentinel **turnstile** 挡死（turnstile 由页面 `window.SentinelSDK` 事件驱动生成，外部脚本驱动不了，是架构性反爬）。所以 chatgpt 走 API → 必失败 → 才降级 tab-worker = 每次 spawn_agent 白做一次失败往返。

**改**：`extension/src/content/platform-caps.ts`，把 `API_CLIENT_PLATFORMS` 集合里的 `'chatgpt'` 删掉（保留 `'qwen'`、`'claude'`、`'openai'`）。这样 chatgpt 的 spawn_agent 直接走 tab-worker，不浪费失败往返。

**注意**：getAuth 的 ChatGPT accessToken 修复（commit `413d702`，`extension/src/background/chat-api.ts` 的 `getAuth` chatgpt 分支走 `/api/auth/session`）**保留不动** —— 它本身是对的（background 能拿 token，"SameSite死结"是误判），只是 turnstile 这关过不了。以后 OpenAI 若放松 turnstile，把 chatgpt 加回 `hasApiClient` 即可。

**验证**：改完 `cd extension && npx tsc --noEmit && npm test`（应 348 绿）。`hasApiClient('chatgpt')` 现在返回 false（测试 `src/__tests__/subagent-api-route.test.ts` 里有 hasApiClient 用例，把 chatgpt 从 true 组移到 false 组）。

---

## P1 — 验证缺口（功能已写，没真验）

### [x] 2. E（batch 容器隔离）多响应隔离 live 验证 — PASS（2026-06-10）

**结果**：qwen 同对话构造重叠窗口：慢工具响应 D（`sleep 12`）执行期间发出新消息产生响应 E（快 `echo`）。DOM 文档序证实 E 的 fence/执行发生在 D 提交之前（窗口真实重叠）；D 提交只含 `SLOW_D_RESULT`，E 提交只含 `FAST_E_RESULT`，两次独立提交零混串。`call_id` 各恰好出现一次（无双执行）。

**背景**：E 修复 = 不同 AI 响应的工具结果按响应容器隔离，不再混进同一次提交（`extension/src/content/index.ts` 的 `outputsByContainer: WeakMap<Element,string[]>` + `scheduleFinalSubmit` 按容器循环提交）。**单响应多工具路径已 live 验证 PASS**（一次合并提交）。但**多响应隔离（修复目标本身）没验** —— 需要两个 AI 响应在重叠窗口各产工具。

**怎么验**：扩展已构建 + Go server 跑（`./piercode` 或 `go run ./cmd/server -dir .`，默认 :39527）。在一个**能走 API 的平台**（qwen，cookie auth 简单）或用 tab-worker 构造两个并发响应：
- 法 A：qwen 页面 spawn_agent 派子 agent（子 agent 在后台产工具，与主响应并发）→ 看子 agent 结果只注入到对应对话。
- 法 B：开两个 AI tab，各发产工具的 prompt，让流式时间重叠 → 看各 tab 结果不串。
- 预期：每个响应的工具结果只回填到**自己**的对话，Response B 不混进 Response A。

**注意**：ChatGPT 走 tab-worker（见 #1），别用 ChatGPT API 验（turnstile 挡）。Chrome MCP 的 type 在 ChatGPT ProseMirror 里**会丢 ASCII 字符**（spawn_agent/README.md 等英文词变残缺），用纯中文 prompt 或 qwen 避开。

---

## P2 — 低优先（投资报告里标的）

### [x] 3. B 双执行 race 的 settle-retry 窄缝 — 已修（c1acd26）

Phase 0 遇未平衡 JSON 时置 `pendingQwenTool` 并 early-return，不再同 scan fallthrough 到 Phase 1（无 callId 时两 phase fallback key 不同，processed 兜不住）。settle retry 600ms 后全量重扫接管。

**背景**：`extension/src/content/index.ts` 工具检测有 `processed` Set 去重（跨 Phase 0/0b/1 有效）。唯一窄缝：Phase 0 遇未平衡 JSON（`!isBalancedJson`）→ `scheduleSettleRetry` 但**不**加 `processed`，600ms 后重扫前 Phase 1 可能已对同 key 命中。实际多被 `processed.has` 兜住，未观测稳定复现，低优先。详见 [投资报告](investigation-batch-state-race.md) §问题B。

**改（若做）**：settle-retry 前给该 key 占位（tentative add 到 processed），或统一所有 phase 在解析成功的单一入口 add。改 `index.ts` 的 settle-retry 逻辑（搜 `scheduleSettleRetry`）。

---

## P3 — 杂物清理（非本轮工作，顺带发现）

### [x] 4. 检查 2 个 stale worktree-agent 分支 — 已清理（2026-06-10）

两分支独有 commit 经 `git cherry` + 文件级 diff 确认内容已全部并入 dev（Context ClientIO/TaskAccess 重构终态在 dev），worktree unlock + remove + branch -D 完成。

`git branch` 列出 `worktree-agent-a8ac4aa7b386a4734` / `worktree-agent-af877ffa47cc74da1`（别的 agent 留的 worktree 分支）。确认无用后 `git worktree list` 看路径，`git worktree remove <path>` + `git branch -D <name>` 清理。**别误删有未合并工作的**，先 `git log <branch> --not dev` 看有没有独有 commit。

### [x] 5. 其它未合分支（非我的）— 已处理（2026-06-10）

`fix/bug-audit-20260607`：零独有 commit（已全并入 dev，remote 分支仍在）→ 本地已删。
`codex/claude-web-ai-mcp`：1 个独有 WIP commit（web-ai impersonation + MCP bridge，进行中）→ 保留。

---

## 收尾动作

### [x] 6. 推 dev + 开 PR — 完成（2026-06-10）

dev 领先 origin/dev **72 commits**（本轮全部工作 + 历史）。攒太多，该推。
```bash
git push origin dev
gh pr create --base master --head dev --title "..." --body "..."
```
PR body 概括本轮：子agent API迁移、DOM脆弱债结构化收敛、只读工具Metadata、batch容器隔离(E)、子agent广播源tab隔离、ChatGPT getAuth(token，turnstile未通故仍走tab-worker)。

---

## 关键认知（避免重走弯路）

- **ChatGPT API 反爬是架构性硬墙**：accessToken 能拿（background host_permissions 让 fetch same-site，cookie 自动带 —— 不是 SameSite 死结）；但 `/conversation` 要 sentinel turnstile token，由页面 `window.SentinelSDK`（事件驱动状态机，要真实会话行为指纹）生成，**外部脚本驱动不了**（pending 状态空）。**不要再试 proxy-through-content / 手动拼 Cookie header / 逆向 SentinelSDK** —— 都验证过走不通。ChatGPT 务实走 tab-worker。
- **Qwen 能走 API 因为**：cookie `token` 值直接当 `Authorization: Bearer`（普通 header，JS 能设），无反爬。ChatGPT 靠 `Cookie` header（forbidden，JS 设不了）+ turnstile，所以不行。
- **Chrome MCP type 丢 ASCII**：ChatGPT ProseMirror 编辑器吞英文/数字字符，验证时用纯中文 prompt 或换 qwen。
