# PierCode 状态面板 — 设计文档

日期：2026-06-05
状态：待评审

## 目标

在 AI 页面注入一个独立悬浮**状态面板**，集中显示运行态信息：

- **操作状态** — 当前 UI 操作生命周期：空闲 / 思考中 / 执行工具 / 完成 / 错误
- **AI 提供商** — 当前平台 + profile（gemini / claude / qwen / chatgpt …）
- **Token 计量** — 输入 / 输出 / 总计 token + 阈值 + 进度条 + 精度标注
- **控制的 Tab** — 被 CDP 控制的浏览器 tab：tabId / 标题 / URL

与现有 `tokenHud`、`visualIndicator` 并存（独立控件，不复用 TokenHud）。

## 非目标（YAGNI）

- 不做历史/趋势图表
- 不做面板内交互动作（停止/重连等仍归 popup 与 visualIndicator）
- 不引入重量级本地分词器（SentencePiece、Qwen 完整 vocab 等大文件）

## 架构

content 脚本是唯一数据汇聚点。面板是被动 UI——数据由 index.ts 喂入。

```
                ┌─────────────────────────────────────┐
                │  background/index.ts                 │
                │  controlledTabId + tab title/url     │
                └───────────────┬─────────────────────┘
                                │ chrome.tabs.sendMessage
                                │ { type: PIERCODE_CONTROLLED_TAB }
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  content/index.ts （接线层）                                   │
│                                                                │
│  · platformAdapter.name / profile ──► setProvider()           │
│  · tool 执行生命周期 ──────────────► setOpState()             │
│  · 定时 DOM 扫描会话 ─► computeMeter ─► setMeter()            │
│  · onMessage PIERCODE_CONTROLLED_TAB ─► setControlledTab()    │
│  · storage stealthMode 变化 ───────► configure({stealth})     │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
                ┌───────────────────────────┐
                │  content/status-panel.ts  │
                │  纯 UI + 状态容器          │
                └───────────────────────────┘
```

## 组件

### 1. `content/status-panel.ts`（新增）

纯 UI 单例，无抓数逻辑。公开 API：

```ts
init(): void
configure(opts: { stealth: boolean }): void
setOpState(s: OpState): void
setProvider(name: string, profile: string): void
setMeter(meter: TokenMeter, threshold: number): void
setControlledTab(info: ControlledTabInfo | null): void
destroy(): void

type OpState = 'idle' | 'thinking' | 'executing' | 'done' | 'error';
type ControlledTabInfo = { tabId: number; title: string; url: string };
```

行为：

- 角落悬浮控件（圆点 → 点击展开面板），右下角，`z-index` 略低于 tokenHud 避免重叠（位置：`bottom: 16px; right: 40px;` 与 tokenHud 错开）。
- 展开/折叠状态存 `chrome.storage.local`（key `statusPanelExpanded`）跨页面记忆。
- stealth 模式整体隐藏（同 tokenHud `applyVisibility`）。
- 所有节点 `all: initial` 样式隔离，`escapeHtml` 防注入。
- `done` / `error` 状态在 N 秒后自动回落到 `idle`（与 visualIndicator 徽章淡出节奏一致：done 1.5s，error 2s）。

### 2. `content/index.ts`（接线，改动）

- 顶部初始化：`statusPanel.init()`，`statusPanel.setProvider(platformAdapter.name, platformProfile)`。
- 在现有 `visualIndicator.showStatusBadge(...)` 调用点旁同步 `statusPanel.setOpState(...)`：
  - 思考中（响应开始观察）→ `thinking`
  - 工具执行 loading → `executing`
  - completed → `done`
  - error → `error`
- **激活 token 管线**（目前 `token-meter.ts` / `computeMeter` 是死代码）：
  - 新增 `scanConversation(): ConversationContext`——按平台选择器扫 DOM，分类 user/assistant 消息。
  - 定时（如每 3s 或在响应 settle 后）调 `computeMeter(ctx)` → `statusPanel.setMeter(meter, threshold)`。
  - qwen 已有的 `qwenConversationCtx` 直接复用；其他平台走 `scanConversation`。
  - `whenTokenizerReady()` resolve 后刷新一次（精确值替换估算）。
- `onMessage` 监听 `PIERCODE_CONTROLLED_TAB` → `statusPanel.setControlledTab(info)`。

### 3. `content/token-meter.ts`（精度升级，改动）

当前问题：o200k_base 只对 GPT 系列精确；用它算 Claude/Gemini/Qwen 是近似，但标签写 `exact` 误导。

**平台自适应方案**（纯本地、零网络、无新重依赖）：

- 编码器选择按平台：
  | 平台 | 编码器 | 精度档 |
  |---|---|---|
  | chatgpt | o200k_base | `exact` |
  | qwen | cl100k_base（js-tiktoken 已含） | `approx` |
  | gemini | o200k_base × 系数 | `approx` |
  | claude | o200k_base × 系数 | `estimate` |
  | kimi / chatz / mimo / 其他 | o200k_base × 系数 | `estimate` |

- 校正系数表 `PLATFORM_TOKEN_FACTOR: Record<string, number>`（默认 1.0），对混合中英文/代码的经验系数（如 gemini ≈ 1.1、claude ≈ 1.15；初值保守，可后续标定）。
- 精度三档枚举升级：`TokenAccuracy = 'exact' | 'approx' | 'estimate'`。
- `computeMeter(ctx, platform)` 增加 platform 入参，决定编码器与系数；面板按档显示「精确 / 近似 / 估算」。
- tiktoken 加载失败时所有平台回退字符估算 = `estimate`。

> 说明：Claude/Gemini 无公开本地分词器；官方 `count_tokens` API 最准但需 API key + 联网 + 泄露明文给第三方，与本地沙箱理念冲突，本期不采用。抓页面原生计数（部分平台 UI 自显上下文用量）作为后续可选增强，不在本期。

### 4. `background/index.ts`（广播控制 tab，改动）

`setBrowserRelayStatus(...)` 末尾（及 `controlledTabId` 变化时）：

- `controlledTabId` 非空时 `chrome.tabs.get(controlledTabId)` 取 title/url。
- 向所有受控 content（或广播）`chrome.tabs.sendMessage({ type: 'PIERCODE_CONTROLLED_TAB', info })`。
- `controlledTabId` 清空时发 `info: null`。
- 失败静默（tab 可能已关闭 / 无 content）。

### 5. 平台适配器（user 消息选择器，改动）

`PlatformAdapter` 增加可选 `userSelector?: string`（用户消息容器选择器）。现有适配器补默认值；未配置时 `scanConversation` 退化为只算 assistant 响应（output 准、input 缺，仍标 estimate）。

## 数据流

1. 页面加载 → `statusPanel.init()` + `setProvider`。
2. 用户发消息 / AI 响应 → `setOpState` 随生命周期变化。
3. 定时器 → `scanConversation` → `computeMeter` → `setMeter`。
4. background 控制 tab 变化 → 广播 → content → `setControlledTab`。
5. stealth 切换 → `configure` 隐藏/显示。

## 错误处理

- tokenizer 加载失败：全平台回退字符估算，标 `estimate`，功能不降级。
- `scanConversation` 选择器不匹配：返回空 ctx，token 显示 0，不报错。
- background `chrome.tabs.get` 失败（tab 关闭）：发 `null`，面板隐藏 tab 块。
- 所有 `chrome.storage` / `chrome.tabs` 调用 try/catch 包裹（content 可能在受限页）。

## 测试

- `__tests__/status-panel.test.ts`（jsdom）：渲染、折叠/展开、`setOpState` 各状态文案/颜色、`setMeter` 格式化、`setControlledTab` 空/非空、stealth 隐藏。
- `__tests__/token-meter.test.ts`（扩展现有）：平台系数应用、三档精度标注、qwen 用 cl100k、chatgpt 用 o200k。
- background 广播逻辑：抽成纯函数 `buildControlledTabMessage(tabId, tab)` 便于单测。
- 全部 `npm test` 通过；`npx tsc --noEmit` 类型检查通过。

## 文件清单

新增：
- `extension/src/content/status-panel.ts`
- `extension/src/__tests__/status-panel.test.ts`

改动：
- `extension/src/content/index.ts`（接线 + 激活 token 管线 + scanConversation）
- `extension/src/content/token-meter.ts`（平台自适应编码器 + 三档精度）
- `extension/src/__tests__/token-meter.test.ts`（新增用例）
- `extension/src/background/index.ts`（广播 PIERCODE_CONTROLLED_TAB）
- `extension/src/platform-adapters/types.ts`（`userSelector?`）
- 各 `extension/src/platform-adapters/*.ts`（补 userSelector 默认）
