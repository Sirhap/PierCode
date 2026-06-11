# Qwen bx-ua Borrow-Once 直发 — 设计

日期: 2026-06-12
状态: 已批准架构 / 待实现

## 背景

侧边栏 (sidebar) 走 API 调 qwen 当前默认走 **listen 通道**:驱动一个真 qwen 页面在 DOM 里填字+提交,页面自己发请求 (天然带 baxia bx-ua / cookie),我们 monkey-patch `window.fetch` tee 一份 SSE 副本回传。

痛点:
- 必须有可见 qwen tab,且 DOM 选择器易碎。
- 本质是"遥控网页聊天",绕一大圈,体验差 (用户感受"纯放屁")。

### 实测结论 (本次 console 取证)

| 验证项 | 结果 |
|---|---|
| `/api/v2/chats/new` 无 bx-ua 直发 | ✅ 过 (不要 bx-ua) |
| `/api/v2/chat/completions` 无 bx-ua 直发 | ❌ `RGV587_ERROR::SM` 弹滑块 punish |
| bx-ua 是否在 `init.headers` 可截 | ✅ 账号非 punish 态时可截,1552 字符 |
| 截获的 bx-ua 在干净 iframe fetch 重放 completions | ✅ 过风控 (无 RGV587),拿到真 SSE `phase:answer content:"Hi"` |
| Qwen2API 的 ssxmod-only (本地造 cookie,无 bx-ua) | ❌ 本测试账号/IP 直接 punish |

**核心洞察**: completions 必须 baxia bx-ua;bx-ua **可截获 + 可复用** (不绑单请求)。这是 Qwen2API 完全没碰的东西 —— 它赌 ssxmod 够,在严格风控账号上输。

## 目标

让 qwen completions **脱离每请求经页面**:借页面 baxia 算一次 bx-ua,SW 缓存复用,干净 fetch 直发。bx-ua 失效才重借。无可借页面时降级 Qwen2API 的 ssxmod 法。

## 架构

```
qwen 请求
  ├─ 主: bx-ua 直发 (SW 干净 fetch + 缓存 bx-ua header)
  │    ├─ 缓存空 → 借 qwen tab 发眨眼请求截 bx-ua → 缓存
  │    └─ 收到 RGV587 → 清缓存 → 重借一次 → 重发一次 (仅 1 次)
  └─ 降级: ssxmod 直发 (本地生成 cookie, Qwen2API 法)
       └─ 触发: 无 qwen tab 可借 / 借取失败 / 重试后仍 RGV587
```

两层降级链 (用户选定): **bx-ua → ssxmod**。listen / page-fetch 不再用于 qwen (其他平台保留)。

## 新增模块 (3 个独立单元)

### 1. `extension/src/background/qwen-bxua-broker.ts`

借 qwen tab 算 bx-ua 并缓存。

接口:
- `getBxUa(): Promise<{ bxUa: string; umid: string } | null>` — 命中缓存秒回;空则借取;借不到返回 `null` (→ 调用方降 ssxmod)
- `invalidate(): void` — 清缓存 (收到 RGV587 时调)

实现要点:
- 内存缓存 `{ bxUa, umid, ts }`,SW 重启丢失 (可接受,懒刷新)。
- **单 in-flight Promise 去重**: 并发请求共享一次借取,不重复发眨眼请求。
- 借取超时 10s → 视为失败返回 `null`。
- 借取流程: `tabs.query` 找 qwen tab → `tabs.connect(port "piercode-bxua")` → 指令页面发眨眼请求 + 截 header → 回传。

### 2. `extension/src/background/qwen-ssxmod.ts`

移植 Qwen2API 的 `fingerprint.js` + `cookie-generator.js` (纯算法,LZW + 自定义 base64)。

接口:
- `genSsxmod(): { ssxmod_itna: string; ssxmod_itna2: string }`

要点: 源文件含损坏编码的中文注释,移植时全部重写为 TS + 干净注释。无外部依赖。

### 3. page-bridge 扩展 (`extension/src/page-bridge/` 新增 leaf 或扩展现有)

页面侧 (MAIN world) 处理 bx-ua 借取指令:
- 收到 `PIERCODE_BXUA_BORROW` → 临时 hook `window.fetch` → 发一个最小 `chats/new` 眨眼请求 → baxia 自动注 bx-ua/umidtoken → hook 截下 → 还原 fetch → 回传 `{ bxUa, umid }`。
- 截不到 (账号 punish 态,baxia 没注) → 回传 error。

## chat-api.ts 改动

1. **qwen 移出 listen**: 从 `LISTEN_PLATFORMS` 删除 `qwen` (保留 chatgpt)。
2. **qwen config 去 `usePageFetch: true`**。
3. **`buildHeaders` 异步注入**: `const c = await broker.getBxUa(); if (c) headers += {bx-ua, bx-umidtoken}`。`c === null` → 走 ssxmod 路径 (加 Cookie header)。
4. **qwen 专属发送逻辑** (platformFetch 或 handleChatRequest 内):
   - 直 fetch (credentials 自动带 cookie) → 检测首块 RGV587/punish
   - RGV587 → `broker.invalidate()` → 重借 → 重发 **1 次**
   - 仍失败 / 借不到 → ssxmod 降级 (genSsxmod + Cookie header + 无 bx-ua)
   - ssxmod 仍 RGV587 → `CHAT_ERROR` 「请打开 chat.qwen.ai 并登录后重试」

## 错误处理

| 场景 | 处理 |
|---|---|
| 借 bx-ua 时无 qwen tab | 直接降 ssxmod;ssxmod 也 RGV587 → CHAT_ERROR 提示开页登录 |
| 眨眼请求本身 punish (账号风控态) | broker 返回 null → 降 ssxmod → 兜底提示 |
| 借 bx-ua 超时 (10s) | 借失败 → 降 ssxmod |
| RGV587 重试 | 仅 1 次;第 2 次失败即降级,不再重借 (防无限循环) |
| 并发请求同时借 | broker 单 in-flight Promise 去重 |
| bx-ua 缓存跨 SW 重启丢失 | 内存缓存,SW kill 后首请求重借 (懒刷新本就如此) |
| 多轮工具调用 (depth>0) | 复用缓存 bx-ua,不每轮重借 |
| ssxmod 降级标记 | 响应附 `degraded:true` 接口预留,UI 可提示 (先留接口,不强做) |

## 边界 (不做)

- 不预刷、不猜有效期 (懒刷新)。
- 不逆向 baxia 内部函数 (用眨眼请求截法,已实测可靠)。
- 不动 listen/page-fetch (其他平台继续用)。
- bx-ua 不跨平台共享 (缓存 key 含平台)。

## 测试

- `qwen-ssxmod.ts`: 单测 genSsxmod 产出格式 (`1-` 前缀、itna ~413 字符、itna2 ~94 字符、纯 ASCII 输出)。
- `qwen-bxua-broker.ts`: 单测 in-flight 去重 (两次并发 getBxUa 只触发一次借取)、invalidate 清缓存、无 tab 返回 null。
- chat-api: 单测 buildHeaders 在有/无 bx-ua 两态下的 header 组装;RGV587 检测 + 1 次重试逻辑。
- 手动验收: 真 Chrome qwen 已登录 → sidebar 发消息 → 看 SW 直发 (Network 无 page-bridge 中转) + 正常流式回。

## 风险

- bx-ua 有效期未知 (懒刷新策略下不依赖,但若极短会导致频繁 RGV587 重借,体验降级)。实现后观测,必要时再加预刷。
- baxia 若改为不在 `init.headers` 注 bx-ua (改 Request 原型层),眨眼截法失效 → 退回 page-fetch。属上游变更风险,非本设计可控。
