# Token 看板 + 全平台可配置上下文压缩 — 设计

日期: 2026-06-05
状态: 已确认，待实现计划

## 目标

1. 在所有支持的 AI 页面显示 **token 看板**：输入 token / 输出 token / 总计，相对压缩阈值的进度。
2. 上下文压缩从 **仅 Qwen** 扩展到 **全 8 平台**，由看板的 total token 触发。
3. 压缩阈值 **可配置，按平台分别设置**。

## 非目标

- 不做精确计费数字（看板是 GPT tokenizer 当量，不等于各平台真实账单）。
- 不改压缩包（`piercode-context` packet）的结构与 handoff 协议——已平台无关。
- 不重写现有 `fillAndSend` / batch-quiet 发送链路。

## 关键决策（已与用户确认）

| 决策点 | 选择 |
|--------|------|
| 看板位置 | AI 页面悬浮小面板，**默认折叠成圆点**，点开展开 |
| token 计算 | **js-tiktoken（`o200k_base`）懒加载；加载失败回退现有字符估算** |
| tokenizer 策略 | 全平台统一 GPT tokenizer（单词表，量级准，跨平台有偏差但够驱动阈值） |
| 压缩推送 | **各平台适配开新会话** |
| 适配范围 | **全 8 平台**（Gemini / AI Studio / Qwen / Chat Z / Kimi / Claude / ChatGPT / Mimo） |
| 阈值粒度 | **按平台分别设阈值**，缺省回退全局默认 |
| 看板默认态 | 折叠圆点（stealth 模式下进一步隐藏/降级，沿用现有 stealth 行为） |

## 架构

### 组件划分

```
content/token-meter.ts   ← token 计数核心（tiktoken 懒加载 + 字符估算回退）
content/token-hud.ts      ← 悬浮看板 UI（折叠圆点 ⇄ 展开面板）
content/index.ts          ← 改：去掉 Qwen-only 限制，接 token-meter 驱动压缩
settings.ts               ← 改：ContextCompressionConfig，按平台阈值
platform-adapters/*.ts    ← 改：PlatformAdapter 加 newSessionUrl()
background/index.ts       ← 改：OPEN_QWEN_COMPRESSED_CONTEXT → OPEN_COMPRESSED_CONTEXT(带 url)
popup/App.tsx             ← 改：压缩配置区块（开关 + 每平台阈值 + summary 上限）
```

### 1. token-meter.ts（新建）

职责：把会话消息流算成 token 数。

- 导出 `estimateTokensAccurate(text): number`——优先 js-tiktoken（`o200k_base` 编码器，单例懒加载），加载未完成或失败时回退现有 `estimateTokens`（字符估算）。
- 懒加载：首次调用触发异步 `import('js-tiktoken')` + 取编码器；加载期间同步返回字符估算，加载完成后切精确值。失败（网络/不支持）永久回退，不重试风暴。
- 导出 `computeMeter(ctx): { input: number; output: number; total: number }`——`input` = role==='user' 消息累加，`output` = role==='assistant' 累加，system 计入 input。
- 复用现有 `ConversationContext`（已有 role 分类），不重复抓 DOM。

**回退契约**：tiktoken 不可用时看板与阈值判定都用字符估算，功能不降级、只是数字精度降低。看板标注当前精度模式（精确/估算）。

### 2. token-hud.ts（新建）

职责：页面角落悬浮看板。

- **默认折叠**为一个小圆点（显示 total 的颜色态）。点击展开为面板：`输入 X · 输出 Y · 总计 Z / 阈值 T` + 进度条 + 精度模式标注。
- 进度条/圆点按 `total / threshold` 着色：<80% 绿、80–100% 黄、≥100% 红。
- 受 stealth 模式控制：stealth 开时沿用现有降级（迷你化/隐藏 DOM 痕迹 + 随机 id）。
- 更新节流：随消息更新，复用现有 batch-quiet 节流，不每字符重绘。
- 折叠/展开状态存 `chrome.storage.local`，跨页面记忆。

### 3. settings.ts（改）

- `QwenCompressionConfig` → `ContextCompressionConfig`（去 Qwen 前缀）：
  ```ts
  interface ContextCompressionConfig {
    enabled: boolean;
    perPlatformThresholds: Record<string, number>; // 键 = adapter.name
    defaultMaxContextTokens: number;               // 未列平台的回退
    maxSummaryTokens: number;
  }
  ```
- `resolveContextCompressionConfig` 兼容读取旧 `qwenCompressionConfig`（迁移：旧 `maxContextTokens` → `perPlatformThresholds.qwen` + `defaultMaxContextTokens`）。
- 各平台默认阈值预设（按真实上下文窗口的保守值，单位 token）：
  - chatgpt ~128_000、qwen ~256_000、claude ~200_000、gemini ~1_000_000、
    aistudio ~1_000_000、kimi ~128_000、chatz ~128_000、mimo ~128_000
  - 这些是默认值，用户可在 popup 改。
- 保留 `DEFAULT_*` 常量导出（被 content/qwen-context-compress.ts 引用，避免破坏）。

### 4. content/index.ts（改）

- `updateQwenContext` → `updateContext`：移除 `platformAdapter.name !== 'qwen'` 限制，全平台累积消息流。
- `maybeTriggerContextCompression`：用 `computeMeter(ctx).total` 与**当前平台阈值**（`perPlatformThresholds[adapter.name] ?? defaultMaxContextTokens`）比较。
- 触发后流程不变（模型自压缩 packet → 加强重试 → 本地摘要兜底），但"开新会话 URL"改为问 adapter（见 §5）。
- 每次 `updateContext` 后调 token-hud 刷新看板。

### 5. platform-adapters（改）

- `PlatformAdapter` 接口加：
  ```ts
  newSessionUrl?: () => string; // 该平台"新建对话"的 URL；缺省回退 host 根路径
  ```
- 8 个 adapter 各实现 `newSessionUrl`：
  - qwen：`${protocol}//${host}/`（现有逻辑）
  - chatgpt：`${origin}/`（根 = 新对话）
  - claude：`${origin}/new`
  - gemini / aistudio / kimi / chatz / mimo：各自新对话入口（实现时逐个核对 DOM/URL）
- 缺省（未实现）回退 `${location.protocol}//${location.host}/`，并在压缩兜底走"提示用户手动 + 剪贴板"（不静默失败）。

### 6. background/index.ts（改）

- `OPEN_QWEN_COMPRESSED_CONTEXT` 消息泛化为 `OPEN_COMPRESSED_CONTEXT`，payload 带 `{ url, text }`。
- 行为不变：开新标签到 url → 新标签 content script hydrate 后 `fillCompressedContextWhenReady` 填发。
- 保留旧消息名做一版兼容别名（避免新旧 content/background 混用时断）。

### 7. popup/App.tsx（改）

- 新增"上下文压缩"折叠区块：
  - 总开关 `enabled`
  - 每平台阈值输入（列出 8 平台，数字框，单位 token，占位显示默认值）
  - `maxSummaryTokens` 输入
- 写回 `chrome.storage.local` 的 `contextCompressionConfig`，content script 经现有 `storage.onChanged` 监听热更新。

## 数据流

```
消息进入 (user/assistant)
  → updateContext(role, content)  累积 ConversationContext
  → computeMeter(ctx)             token-meter 算 in/out/total（tiktoken 或回退）
  → token-hud 刷新看板（圆点颜色 / 展开面板数字）
  → maybeTriggerContextCompression: total ≥ perPlatformThreshold[platform]?
        是 → triggerContextCompression
              → 模型自压缩 packet（超时重试 → 本地摘要兜底）
              → adapter.newSessionUrl() 取新会话 URL
              → background OPEN_COMPRESSED_CONTEXT { url, packet }
              → 新标签填发压缩上下文 + init_prompt
```

## 错误处理

- **tiktoken 加载失败**：永久回退字符估算，看板标"估算"，功能不降级。
- **adapter 无 newSessionUrl 或新会话发送失败**：toast 提示 + 压缩包复制到剪贴板，让用户手动粘贴；不静默丢上下文。
- **压缩并发**：沿用现有 `compressionInProgress` 锁。
- **阈值配置非法**（负数/非数）：`resolveContextCompressionConfig` 回退默认。

## 测试

- `token-meter`：单测——字符估算回退路径（tiktoken mock 不可用时）、in/out/total 分类正确、system 计入 input。
- `settings`：`resolveContextCompressionConfig` 单测——旧 `qwenCompressionConfig` 迁移、非法值回退、每平台阈值读取。
- `token-hud`：组件测——折叠/展开切换、颜色分段阈值、stealth 降级。
- 各 adapter `newSessionUrl`：单测返回值格式。
- 现有 Qwen 压缩链路回归（不退化）。
- **手动测试矩阵**：8 平台逐个验证「达阈值 → 开新会话 → 上下文接续」。实现完成时产出「已测/未测」清单。

## 风险

1. **跨平台 token 偏差**：统一 GPT tokenizer，Qwen/Claude 实际 token 偏 10–30%。看板是 GPT 当量，非平台账单。够驱动阈值。
2. **8 平台 newSession 易碎**：各站改版会断 newSessionUrl，需逐个核对，列测试清单。
3. **js-tiktoken 体积**：o200k_base 词表懒加载，首屏不阻塞；加载失败回退已覆盖。

## 实现顺序建议

1. settings：`ContextCompressionConfig` + 迁移 + 每平台默认。
2. token-meter：tiktoken 懒加载 + 回退 + computeMeter（带单测）。
3. token-hud：折叠圆点 ⇄ 展开看板。
4. content/index.ts：去 Qwen-only，接 meter 驱动压缩。
5. PlatformAdapter.newSessionUrl + 8 adapter 实现。
6. background：OPEN_COMPRESSED_CONTEXT 泛化。
7. popup：压缩配置 UI。
8. 手动测试矩阵 + 回归。
