# PierCode 全系统 Bug 审计报告

> 审计时间：2026-06-08（5 子 agent 并行审计 + 5 子 agent 二次验证）
> 审计范围：Go 端 53 文件 100% · 扩展 90 文件 100% · 总计 140+ 功能文件
> 状态：**已验证 Bug 清单**（✅ 真Bug / ⚠️ 设计如此 / ❌ 误报 / 📐 夸大了）

---

## 二次验证结果总览

```
┌────────────────┬──────┬──────┬──────┬──────┐
│ 类别            │ ✅真Bug│ ⚠️设计│ ❌误报│ 📐夸大│
├────────────────┼──────┼──────┼──────┼──────┤
│ 原 P0 (6项)    │   0  │   1  │   4  │   1  │
│ 原 P1 (40项)   │  11  │   8  │  16  │   5  │
│ 原 P2 (47项)   │   2  │  10  │   5  │  30  │
├────────────────┼──────┼──────┼──────┼──────┤
│ 合计 (93项)     │  13  │  19  │  25  │  36  │
└────────────────┴──────┴──────┴──────┴──────┘
```

---

## ✅ 已验证真 Bug（13 个）

### 🔴 P1 — 需要修复

| # | 严重度 | 文件:行 | 描述 | 验证结论 |
|---|--------|---------|------|----------|
| BUG-1 | 🔴 P1 | `internal/server/server.go:1055-1071` | **Server.Close() 双重关闭 panic** — select/default 检查 channel 关闭非原子，并发调用可 panic。同文件 WSManager.Close() 已用 `closeOnce` 但 Server.Close() 遗漏 | ✅ 源码确认 `select { case <-s.stop: default: close(s.stop) }` 无 sync.Once 保护 |
| BUG-2 | 🟡 P2 | `internal/browser/controller_ext.go:199-201` | **GetContent 截断在字节边界** — `string([]byte(text)[:100*1024])` 在多字节 UTF-8 字符中间切断产生乱码。同代码库 `memory.go` 已正确实现 rune 边界回退 | ✅ 源码确认无 `utf8.RuneStart` 回退 |
| BUG-3 | 🔴 P1 | `extension/src/platform-adapters/claude.ts` | **Claude 适配器不处理 agent-result** — 只检测 `piercode-tool`，不检测 `piercode-agent-result`。Qwen/ChatGPT 适配器都有完整双类型支持。导致 Claude 平台多 agent 工作流无法接收子 agent 回调 | ✅ 对比 qwen.ts 有完整 agent-result，claude.ts 完全缺失 |
| BUG-4 | 🟡 P2 | `internal/tool/agent_registry.go:173-188` | **Depth() 持写锁** — 只读操作用 `mu.Lock()` 而非 `mu.RLock()`，不必要阻塞其他并发读操作 | ✅ 源码确认 `r.mu.Lock()`，方法只读不写 |
| BUG-5 | 🟡 P2 | `internal/tool/glob.go:67-90` | **递归 glob 丢失路径前缀** — `src/**/*.go` 只用 `filepath.Match("*.go", name)` 匹配文件名，`src/` 前缀约束被忽略，`other/foo.go` 也会匹配 | ✅ 源码确认 `isRecursive` 分支只用 `basePat` 匹配 |
| BUG-6 | 🟡 P2 | `extension/src/popup/App.tsx:526-539` | **重新配置误删凭据** — 点击「重新配置」立即 `clearStoredAuth()`，用户点「取消」后凭据已丢失，需重新输入 | ✅ 源码确认 `clearStoredAuth()` 在 toggle 前执行 |
| BUG-7 | 🟡 P2 | `extension/src/hub/canvas/Canvas.tsx:258-271` | **focusNode 闭包过期值** — toggle 用函数式 `setFocusedNodeId(prev => ...)` 正确，但 centering 用闭包中旧 `focusedNodeId`。快速连续点击时 centering 行为不一致 | ✅ 源码确认闭包值 vs 函数式更新来源不一致 |
| BUG-8 | 🟡 P2 | `extension/src/hub/App.tsx:166-176` | **removeProject 引用闭包旧 projects** — `setActiveId` 内部的 `projects` 来自闭包旧值，当 `projects` 只有 1 个元素被删除时 `activeId` 设为 null，而 `setProjects` 已补充默认项目但 `setActiveId` 看不到 | ✅ 源码确认 `projects.filter(...)` 用闭包值 |
| BUG-9 | 🟡 P2 | `extension/src/background/downloads.ts:32-46` | **下载进度不更新** — `applyDownloadDelta` 遗漏 `delta.bytesReceived` 处理，下载进行中时 `bytesReceived` 不更新 | ✅ 源码确认无 `bytesReceived` 处理 |
| BUG-10 | 🟡 P2 | `internal/portutil/portutil.go:137-150` | **lsof 匹配所有连接状态** — `lsof -i :PORT` 返回 ESTABLISHED + LISTEN，Windows 版正确过滤 LISTENING，Unix 版未过滤 | ✅ 对比 Windows 版有 `LISTENING` 过滤，Unix 版无 |
| BUG-11 | 🟡 P2 | `internal/tool/edit.go:188-213` | **levenshtein 按字节非 rune** — CJK 字符（3字节）被当作 3 个单元，编辑距离膨胀约 3 倍。影响模糊匹配质量但不导致功能错误 | ✅ 源码确认 `len(a)` 和 `a[i-1]` 是字节操作 |
| BUG-12 | 🟡 P2 | `internal/prompt/profile.go:184-202` | **renderCache check-then-act 竞态** — 两次独立加锁区间，两个 goroutine 可同时 miss 缓存重复计算。幂等但浪费 CPU | ✅ 源码确认 Lock-读-Unlock 后 Lock-写-Unlock |
| BUG-13 | 🟡 P2 | `internal/browser/controller_ext.go:463-511` | **HandleDialog dialog 事件丢失** — dialog 可能在 `WaitForDialog` 调用之前触发（极端时序），函数等到超时 | ✅ 事件驱动系统中先注册后监听是标准模式，但无历史事件回放 |

---

## ⚠️ 设计如此（19 个，不改）

| # | 文件 | 描述 |
|---|------|------|
| D-1 | `internal/tool/write_file.go:65-82` | append 非破坏性操作，不快照是合理设计 |
| D-2 | `internal/tool/apply_patch.go:382-389` | `detectCRLF` 严格纯 CRLF 检测，混合行尾返回 false 是预期 |
| D-3 | `internal/executor/executor.go:381-388` | 写工具全局互斥是有意的安全设计 |
| D-4 | `internal/tool/grep.go:161-179` | `scanner.Err()` 有意忽略，保留部分结果 |
| D-5 | `internal/tool/browser_tools_ext.go:52-56` | polling 参数 "accepted for compatibility" |
| D-6 | `internal/tool/question.go:101-128` | Go select + defer cleanup 是标准模式 |
| D-7 | `internal/browser/security.go:96` | IsSensitive 安全保守策略，宁可误报不漏报 |
| D-8 | `internal/security/auth.go:46-49` | token 写入时 0600 已设置，读取不检查在 localhost 威胁模型下可接受 |
| D-9 | `internal/server/ws.go:69-71` | WS CheckOrigin 始终返回 true，token 已认证 |
| D-10 | `extension/src/content/index.ts:1560-1571` | scopedExecutionKey 恒等函数是有意保留的抽象桩 |
| D-11 | `extension/src/content/ws-linker.ts:982-988` | approval 去重 Set 溢出清空，但 MAX=500 实际不会触达 |
| D-12 | `extension/src/page-bridge/index.ts:72-83` | addEventListener 永久覆写是 keep-alive 核心功能 |
| D-13 | `internal/prompt/profile.go:173-203` | renderCache 条目极少（1-5），无淘汰合理 |
| D-14 | `internal/browser/controller_ext.go:247-264` | NavigateWithBeforeunload goroutine 5s 安全网是设计 |
| D-15 | `extension/src/hub/App.tsx:120` | wsSeenAt 受组件生命周期保护，影响被夸大 |
| D-16 | `internal/tool/todo_write.go:58-78` | 硬编码路径不走 ResolvePath 但不会逃逸沙箱 |
| D-17 | `internal/security/auth.go:103-104` | token 长度固定 64 字符，前置检查不增加风险 |
| D-18 | `internal/browser/approval.go:73` | 5 分钟超时是 UX 选择 |
| D-19 | `internal/browser/controller_ext.go:631-635` | release 用 Background ctx，1s 超时后自动释放 |

---

## ❌ 确认误报（25 个）

| # | 原编号 | 描述 | 误报原因 |
|---|--------|------|----------|
| F-1 | P0-1 | exec_cmd 用实时 RootDir | 代码已改用 `ctx.EffectiveRootDir()` + executor 快照 |
| F-2 | P0-2 | glob.go d.Info() nil panic | 错误已正确检查，`return nil` 跳过 |
| F-3 | P0-3 | grep.go d.Info() nil panic | 同 F-2 |
| F-4 | P0-4 | Upload 路径未沙箱校验 | `resolveUploadPaths` 已调用 `ctx.ResolvePath()` |
| F-5 | P1-1 | Broadcast close/send panic | RWMutex 正确保护 send/close 互斥 |
| F-6 | P1-4 | buildTaskNotification XML 注入 | 所有字段都用 `html.EscapeString` |
| F-7 | P1-5 | handleExec 打印完整 args | 已改为 `argKeys()` 只打 keys |
| F-8 | P1-7 | edit replacer 降级误替换 | 有意设计的 cascade 降级策略 |
| F-9 | P1-10 | exec_cmd 忽略用户 timeout | exec_cmd 无用户 timeout 参数，只有全局配置 |
| F-10 | P1-11 | memory append TOCTOU | memory_write 持写锁，竞态不可能 |
| F-11 | P1-14 | web_fetch DNS 无超时 | net.LookupHost 有系统级 DNS 超时 |
| F-12 | P1-17 | StdoutPipe/StderrPipe 泄漏 | StderrPipe 失败时已显式 Close stdoutPipe |
| F-13 | P1-19 | task_list 切片污染 | Snapshots() 每次返回全新切片 |
| F-14 | P1-26 | injected buffer.replace 只替换首个 | 迭代模式下每次移除一个出现位置，等价全局替换 |
| F-15 | P1-28 | AI_PAGE_HOSTS 缺 chat.qwen.ai | `endsWith(".qwen.ai")` 已覆盖子域名 |
| F-16 | P1-30 | Kimi toolcall-container 不推送 | 第14行明确调用 `pushPierCodeTool` |
| F-17 | P1-34 | project-store zoom=0 | `Math.max(0.01, ...)` 外层保护已拦截 |
| F-18 | P1-39 | bgFetch 未处理 undefined | `result ?? fallback` 已正确处理 |
| F-19 | P2-3 | handleListAgents nil 保护 | 已有 `executor != nil` 检查和 nil slice 兜底 |
| F-20 | P2-23 | appendBounded panic | 三条路径切片索引均在安全范围内 |
| F-21 | P1-16 | grep scanner.Err() 未检查 | 有意忽略，保留部分结果 |
| F-22 | P1-18 | snapshot pruneSnapshots 性能 | 目录 entry 极少，os.ReadDir 开销可忽略 |
| F-23 | P1-20 | snapshot 多路径部分失败 | 设计为 best-effort，已有注释说明 |
| F-24 | P1-24 | SetCookie 忽略 DefaultTab 返回值 | tab 仅用于审批提示文案 |
| F-25 | P2-8 | question 超时竞态 | Go select 标准模式 + defer cleanup |

---

## 📐 夸大了（36 个）

| # | 原编号 | 描述 | 实际影响 |
|---|--------|------|----------|
| E-1 | P0-5 | IsDangerousCommand 缺 dd | dd 有大量合法用途，非 P0 级 |
| E-2 | P0-6 | injected buffer 共享 | 单 SSE 场景安全，理论竞态不构成 P0 |
| E-3 | P1-2 | WS 纳秒 ID 重复 | WS 握手不可能同纳秒 |
| E-4 | P1-8 | levenshtein 字节级 | CJK 膨胀但不影响安全性 |
| E-5 | P1-31 | chatz CodeMirror 不提取 | 会提取但有 `"name"` 过滤 |
| E-6 | P1-33 | wsSeenAt 无清理 | 组件生命周期保护 + cutoff 过滤 |
| E-7 | P1-38 | agentResultSent 无清理 | sessionStorage 关 tab 清零 |
| E-8 | P2-5 | WS client ID 伪造 | localhost + auth token 保护下影响极低 |
| E-9~36 | 多个 P2 | 内存泄漏/资源管理等 | 实际条目数极少或有生命周期保护 |

---

## 最值得修复的 5 个（按影响力排序）

| 优先级 | Bug | 改动量 | 影响 |
|--------|-----|--------|------|
| 1 | BUG-1: Server.Close() 加 sync.Once | 5 行 | 消除服务关闭时并发 panic |
| 2 | BUG-3: Claude 适配器加 agent-result 检测 | 10 行 | 修复 Claude 平台多 agent 回调链路 |
| 3 | BUG-6: popup 重新配置不立即 clearStoredAuth | 3 行 | 防止用户误操作丢失凭据 |
| 4 | BUG-2: GetContent 截断加 rune 边界回退 | 5 行 | 修复中文/日文截断乱码 |
| 5 | BUG-9: applyDownloadDelta 加 bytesReceived | 1 行 | 修复下载进度不更新 |
