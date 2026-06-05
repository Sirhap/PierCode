---
title: "PierCode Browser & Extension Test Plan"
description: "Full manual test plan for PierCode's browser automation tools and Chrome extension integration across supported AI platforms."
---

# PierCode 浏览器与扩展全量测试计划 (Browser & Extension Test Plan)

日期：2026-06-01

## 目标

验证 PierCode 的 Go 后端、Chrome Manifest V3 扩展、AI 页面内容脚本、浏览器 relay、审批流程、后台任务工具、附件上传、下载跟踪、PDF 导出、拖放等能力在真实用户场景下可用。

本计划要求区分三类结论：

- `真实 Chrome 通过`：必须使用用户已经打开、已经安装 PierCode 扩展的 Chrome，连接本地 Go 后端后验证。
- `自动化测试通过`：Go 单测、Vitest、TypeScript、构建通过。
- `人工/半自动确认`：涉及真实 AI 网站、登录态、第三方 UI 或需要人工授权的场景，必须记录页面、步骤、观察结果和风险。

不得把局部 smoke test 结果描述为全量通过。每个测试项必须有证据：命令输出、截图、日志、测试报告或明确的手工记录。

## 环境要求

- 工作目录：`/Volumes/other/IdeaProjects/sirhao/piercode`
- Go 后端：`go run ./cmd/server -dir .`
- 扩展构建：`cd extension && npm run build`
- 扩展来源：Chrome 已安装的 PierCode 未打包扩展，加载 `extension/dist`
- Chrome：必须优先使用用户已打开且已安装插件的 Chrome
- 权限：PierCode 扩展启用以下权限
  - debugger
  - tabs
  - scripting
  - storage
  - downloads
  - cookies
  - host permissions for local test pages and AI sites
- 文件 URL 权限：上传场景需要确认扩展允许访问文件 URL
- 测试输出目录：
  - `.piercode/live-smoke/`
  - `.piercode/screenshots/`
  - `.piercode/pdfs/`
  - `docs/test-runs/`，如需要保存人工记录

## 总体执行顺序

1. 静态检查和构建。
2. Go 全量测试。
3. 扩展单元测试和类型检查。
4. 隔离 Chrome profile smoke，只作为 CI/回归辅助，不作为用户 Chrome 结论。
5. 用户已安装扩展的真实 Chrome live smoke。
6. AI 页面内容脚本和 Qwen 适配验证。
7. 附件上传到 AI 会话验证。
8. 弹窗 UI、审批流程、停止操作和异常恢复验证。
9. 整理覆盖矩阵，标注通过、失败、跳过原因和证据路径。

## 基础命令

```bash
go test ./...
cd extension && npm test -- --run
cd extension && npx tsc --noEmit
cd extension && npm run build
```

真实 Chrome live smoke 使用当前运行的后端 token：

```bash
go run ./cmd/server -dir .
PIERCODE_API_URL=http://127.0.0.1:<port> PIERCODE_TOKEN=<token> node scripts/browser-live-smoke.mjs
```

新增浏览器工具、真实用户插件、真实 Chrome relay 的验收必须使用 `scripts/browser-live-smoke.mjs`。`scripts/browser-smoke.mjs` 会新开隔离 Chrome profile 并加载 `extension/dist`，只用于 CI/回归辅助；手动运行时必须显式设置 `PIERCODE_ALLOW_ISOLATED_CHROME_SMOKE=1`，且不得把它的结果记为“真实 Chrome/已安装扩展通过”。

Qwen 上下文压缩端到端脚本：

```bash
PIERCODE_API_URL=http://127.0.0.1:<port> \
PIERCODE_TOKEN=<token> \
PIERCODE_EXTENSION_ID=<installed-piercode-extension-id> \
node scripts/qwen-context-e2e.mjs
```

该脚本使用真实 Chrome、真实已登录 Qwen、已安装 PierCode 扩展，不启动隔离 Chrome profile。脚本会通过 `configure.html` 自动写入临时 `qwenCompressionConfig.maxContextTokens=1` 和 `qwenE2EBridgeEnabled=true`，跑完后恢复为 `1000000` 并关闭 E2E bridge。E2E bridge 默认关闭，仅用于测试时把页面侧 `postMessage` 路由到 content script 内部稳定的 `fillAndSend`。

执行前必须：

1. 在用户已打开的 Chrome 中刷新 PierCode 扩展。
2. 打开 PierCode 扩展弹窗，粘贴后端认证 URL。
3. 确认弹窗显示：
   - `PierCode 本地服务已连接`
   - `浏览器控制 relay 已连接`
4. 如果测试涉及 AI 页面，确认 AI 页面 WebSocket 已打开。

## 全量覆盖矩阵

| 范围 | 必测内容 | 验证方式 | 通过标准 | 证据 |
| --- | --- | --- | --- | --- |
| Go 后端启动 | token、端口、工作目录、local-only | 真实启动 | 能输出认证 URL，`/stats` 可访问 | 终端日志 |
| 扩展刷新 | MV3 service worker reload | 真实 Chrome | `chrome://extensions` 显示已重新加载 | 截图/记录 |
| 弹窗 UI | 未连接、连接中、已连接、重新配置、自动执行、自动审批浏览器操作、自动提交、随机延迟 | 真实 Chrome + Vitest | 文案和状态正确，storage 写入正确 | 截图、`configure.test.ts` |
| 配置页 | `configure.html` 外部脚本、写入 `apiUrl/authToken`、缺参状态 | Vitest + build | 无 inline script，MV3 CSP 不阻断 | `configure.test.ts` |
| 后台 relay | `browser_hello` capability、ping、断线重连、token 失效 | 真实 Chrome + Go test | relay 状态准确，token 失效清理配置 | 日志/单测 |
| 审批流程 | ask、approve、reject、timeout、done dismiss | 真实 Chrome + Go test | 用户审批弹窗显示正确；批准才执行；拒绝不执行 | live smoke、人工记录 |
| 内容脚本 | WebSocket linker、工具卡扫描、自动提交、停止操作、视觉指示器 | Vitest + AI 页面验证 | 工具调用可提取，状态可见，停止按钮发消息 | 测试输出/截图 |
| 无障碍树 | snapshot refs、搜索、坐标、点击、滚动 | Vitest + live smoke | 树含用户可见内容，ref 可用于后续操作 | `accessibility-tree.test.ts`、live smoke |
| Qwen 适配 | Qwen DOM、Monaco、NBSP、流式、不完整 JSON、新版 response selector | Vitest + 真实 Qwen 页面 | 能提取真实工具调用，不把 Show more 当代码 | `qwen-dom.test.ts`、人工记录 |
| 后台任务工具 | `task_list`、`task_output`、`task_stop` | Go integration | 后台命令可列出、读取输出、停止后不 running | `executor_test.go` |
| 附件上传 | 截图 attachment upload 到当前 AI chat | Go test + 真实 AI 页面 | AI 页面收到文件并完成上传结果回传 | 单测、人工记录 |
| 下载跟踪 | created、changed、complete、interrupted、filter、limit | Vitest + 真实 Chrome download | 当前测试 URL 下载记录出现，状态 complete | `downloads.test.ts`、live smoke |
| PDF 导出 | A4、landscape、输出路径、workspace sandbox | Go test + live smoke | PDF 文件存在且大小合理 | live smoke 输出 |
| 拖放 | selector/ref/coordinate、前台 tab 激活、敏感页面拒绝 | Go test + live smoke | drop 目标状态改变，性能不超时 | live smoke 输出 |
| 文件上传到 input | workspace 文件解析、多文件、非法路径拒绝 | Go test + live smoke | 页面显示上传文件名和大小 | live smoke 输出 |
| 截图/zoom | screenshot、fullPage、quality、zoom region、保存路径 | Go test + live smoke | 文件存在且大小合理，不泄露 data URL | 输出文件 |
| console/network | console filter、onlyErrors、network URL filter、clear | Go test + live smoke | 能读到当前页日志和 `/api/ping` 请求 | live smoke 输出 |
| cookies | URL/domain、includeValue、limit | Go test + live smoke | 本地测试 cookie 可读；敏感站点不做无授权读取 | live smoke 输出 |
| 导航历史 | navigate、go_back、go_forward、reload、beforeunload policy | Go test + live smoke | 页面切换和历史返回正确 | live smoke 输出 |
| 稳定性 | stale snapshot、debugger detached、tab close、finalize | Go test + live smoke | stale 提示明确，finalize 清理 tab | 日志/测试 |
| 安全 | sandbox、危险命令、敏感支付/金融页面拒绝浏览器副作用 | Go test | 不越权、不弱化过滤 | Go test |

## 浏览器工具全覆盖清单

所有工具都必须至少有一个测试证据。真实 Chrome 优先，无法真实自动化的说明原因并补单元/集成测试。

| 工具 | 用户场景 | 必测验证 |
| --- | --- | --- |
| `browser_tabs` | 用户问“现在有哪些可操作页面” | 不要求用户提供 tabId，输出可读标题和 URL |
| `browser_new_tab` | 打开新的业务页面 | 创建受控 tab，页面加载完成 |
| `browser_use_tab` | 选择已有页面继续操作 | 从 `browser_tabs` 输出中选择，审批后受控 |
| `browser_navigate` | 打开指定业务 URL | 支持 `about:blank/http/https`，处理 beforeunload |
| `browser_snapshot` | 查看页面结构 | 输出可读无障碍树，包含 refs 和 node count |
| `browser_find` | 按按钮文字找元素 | 用“Submit request”等真实文字查找 |
| `browser_click` | 点击按钮/链接 | selector、ref、坐标至少覆盖两类 |
| `browser_type` | 填写输入框 | clear、submit、文本落地校验 |
| `browser_focus` | 聚焦输入区域 | activeElement 正确 |
| `browser_press_key` | 键盘快捷操作 | Enter、Escape 或 End 生效 |
| `browser_form_input` | checkbox/radio/contenteditable/React 风格输入 | 值变化触发 input/change 事件 |
| `browser_select` | 选择下拉选项 | value、label、index 至少覆盖 label/value |
| `browser_hover` | 悬停显示详情 | hover 后页面状态变化 |
| `browser_scroll` | 滚动到长页面底部 | 目标进入视口并可读取 |
| `browser_wait` | 等待元素出现/消失或 load | visible/attached/load 至少覆盖两类 |
| `browser_wait_for_function` | 等待异步状态 | JS 表达式 truthy 后返回 |
| `browser_evaluate` | 读取页面状态或触发测试事件 | 返回值序列化正确，超长表达式拒绝 |
| `browser_get_content` | 读取文本、HTML、结构化内容 | selector 和 full page 均可用 |
| `browser_screenshot` | 截图保存/附件上传 | 保存文件；AI 页面 attach 流程另测 |
| `browser_zoom` | 截取局部区域 | 输出图片存在且大小合理 |
| `browser_pdf` | 导出报告 PDF | 文件在 workspace 内，大小合理 |
| `browser_upload` | 上传本地凭证文件 | 文件名和大小在页面显示 |
| `browser_drag` | 拖拽审批卡片到目标 | drop 状态变化，不超时 |
| `browser_handle_dialog` | 处理 alert/confirm/prompt | accept/dismiss/promptText 均测 |
| `browser_go_back` | 返回上一页 | URL 和内容回到上一页 |
| `browser_go_forward` | 前进下一页 | URL 和内容前进 |
| `browser_reload` | 刷新页面 | 内容仍可读，ignoreCache 可用 |
| `browser_resize` | 调整窗口尺寸 | 窗口尺寸变化且不破坏后续操作 |
| `browser_viewport` | 移动端视口模拟 | `window.innerWidth` 符合设置，reset 恢复 |
| `browser_console` | 查看页面错误/日志 | pattern、onlyErrors、clear 行为正确 |
| `browser_network` | 查看请求记录 | 当前测试 API 请求可见，filter 生效 |
| `browser_cookies` | 查看当前测试站点 cookie | includeValue true/false 生效 |
| `browser_downloads` | 查看下载历史 | 当前测试 URL 下载 complete |
| `browser_finalize_tabs` | 清理测试创建的 tab | 关闭 PierCode 创建 tab，不误关用户 tab |

## 真实 Chrome 用户场景测试

### 2026-06-02 真实 Chrome E2E 记录

环境：

- 后端：`go run ./cmd/server -dir . -port 63643 -token piercode-e2e-2026-fixed-token-abcdef1234567890`
- PierCode 扩展：真实 Chrome 已安装未打包扩展 `lolcioebooncpbcgfdkcpolcihcdhcfl`，来源 `extension/dist`
- Qwen 页面：`https://chat.qwen.ai/`
- `/stats`：`{"browser_clients":2,"browser_providers":{"Extension":1,"Qwen":1},"browser_relays":1,"tasks_running":0,"tasks_total":0}`

通过项：

- 真实 Chrome 重载 PierCode 扩展后，Qwen 页面日志出现 `[PierCode] 使用 qwen 平台适配器` 和 `✅ WebSocket 已连接`。
- 临时把 Qwen 压缩阈值设为 `1` 后，真实 Qwen 会话触发上下文压缩。
- Qwen 未在 60 秒内输出上下文 packet，PierCode 按预期走本地摘要兜底并打开新会话：`https://chat.qwen.ai/c/910db97e-54c1-4882-a928-7de432ad3843`。
- 新会话应包含 `piercode-context` fenced JSON handoff，说明压缩上下文已迁移。
- 恢复正式阈值 `1_000_000`、重载扩展并刷新压缩后会话后，要求 Qwen 输出可见 `piercode-tool` 调用：
  - `call_id`: `post_compress_list_dir_1780381790205`
  - `name`: `list_dir`
  - `args.path`: `.`
- PierCode 在压缩后会话中提取到工具调用，页面显示 `✅ 已执行`，结果包含 `.git/`、`README.md`、`cmd/`、`docs/`、`extension/`、`internal/`、`prompts/`、`scripts/`。
- 2026-06-02 15:03 CST 复跑压缩上下文端到端：
  - `/stats`：`{"browser_clients":3,"browser_providers":{"Extension":1,"Qwen":2},"browser_relays":1,"tasks_running":0,"tasks_total":0}`
  - 临时阈值 `1` 触发压缩，旧会话 `https://chat.qwen.ai/c/fb2b2101-60ef-4774-a247-6842f887646e` 显示 `上下文已本地压缩，并已发送到新的 Qwen 会话`。
  - 新会话 `https://chat.qwen.ai/c/570ccbf1-92a3-466c-98fe-2203cf8aef46` 收到 handoff 并回复 `我已收到压缩的上下文包并继续会话`，页面正文未出现 `<compressed_context>`。
  - 压缩后会话工具调用通过，`call_id` 为 `post_compress_list_dir_1780441420`，页面显示 `✅ 已执行`，结果包含 `README.md`、`cmd/`、`docs/`、`extension/`、`internal/`、`prompts/`、`scripts/`。
- 2026-06-02 15:25 CST 自动化脚本验证：
  - 新增 `scripts/qwen-context-e2e.mjs`，覆盖真实 relay、配置页自动写入低阈值、Qwen 压缩触发、新会话无 XML wrapper、post-compress 工具调用验证。
  - 脚本多轮跑通到 `wait for local compression handoff`、`select newest Qwen handoff tab`、`verify compressed context response has no XML wrapper`。
  - 发现真实 Qwen 输入自动化仍有波动：`textarea.message-input-textarea` 在部分新首页状态可被工具设置但未实际提交，导致后续等待 handoff 超时。已补 `qwenE2EBridgeEnabled` 测试入口，让脚本可复用 content script 内部稳定 `fillAndSend`；真实 Chrome 需重载安装的 PierCode 扩展后再跑完整脚本。
- 真实 Chrome live smoke 通过，测试页 `http://127.0.0.1:61692/`，覆盖新增工具：
  - `browser_storage`: `localStorage/sessionStorage` set/get/keys/remove/clear 均通过。
  - `browser_set_cookie`: 本地测试 cookie 写入、读取、删除均通过，审批完成通知可见。
  - `browser_wait_for_navigation`: 点击链接后等待 `/second` 导航完成，再返回报告页通过。
  - `browser_emulate`: UA、DPR、dark mode、timezone 生效，reset 后 UA 恢复。
  - `browser_get_attributes`: 读取 `#attributeTarget` 属性和 computed style 成功。
  - 审批统计：`asked=38`、`approved=37`、`rejected=1`、`done=38`、`mismatches=[]`。

问题和优化点：

- 模型没有在压缩请求后按协议输出 packet，实际使用本地摘要兜底。后续要继续调试提示词，使模型主动压缩时输出：
  - 一个 Markdown fenced JSON block，语言名 `piercode-context`
  - `version`、`reason` 和上下文字段都放进 JSON 对象
  - 不输出 XML-like wrapper，不输出 `piercode-tool`
- 真实 Qwen 标签很多时，自动化接管可能命中旧会话；记录和复跑时必须使用明确 URL 或新开指定会话 URL。
- 临时测试阈值只能用于触发压缩，完成迁移后必须恢复 `DEFAULT_QWEN_MAX_CONTEXT_TOKENS = 1_000_000` 并重载扩展，避免新会话循环压缩。
- `content.js` 必须保持 MV3 classic content script，不能因为共享 chunk 生成顶层 `import`。`extension/src/__tests__/content-build.test.ts` 已覆盖该回归。

### 场景 A：本地业务审批页面全工具链

测试页由 `scripts/browser-live-smoke.mjs` 启动本地 HTTP server，页面模拟真实审批流程：

1. 打开“报销/审批报告”页面。
2. 读取 tab 列表并选择当前测试页。
3. 获取无障碍 snapshot。
4. 按“Submit request”文字查找按钮。
5. 调整窗口尺寸和移动视口。
6. 等待异步状态 ready。
7. 填写申请人、选择优先级、勾选复核、填写备注。
8. hover 查看详情。
9. 点击提交并读取页面提交状态。
10. 滚动到长报告底部。
11. 上传 receipt 文件。
12. 拖动 invoice 到 approved 区域。
13. 导出 PDF。
14. 截图和局部 zoom。
15. 读取 console、network、cookie。
16. 点击下载并验证当前 URL 下载记录。
17. navigate 到第二页，go back/go forward/reload。
18. 触发并处理 JS dialog。
19. finalize 清理测试 tab。

通过标准：

- 所有步骤输出 `ok`。
- 下载记录必须包含本次测试端口的 `/download` URL。
- PDF、screenshot、zoom 文件存在且大小合理。
- 测试结束后 fixture 和 PDF 临时文件清理完成。
- 测试创建的 Chrome tab 被 `browser_finalize_tabs` 清理。

### 场景 B：扩展弹窗配置与状态

1. 刷新 PierCode 扩展。
2. 打开扩展 popup。
3. 未配置时显示未连接。
4. 粘贴后端 auth URL。
5. 点击连接。
6. 观察本地服务状态、AI 页面状态、browser relay 状态。
7. 切换自动执行工具、自动审批浏览器操作、自动提交。
8. 修改随机延迟最小/最大值。
9. 点击重新配置后能回到配置态。

通过标准：

- 弹窗 UI 文案准确。
- storage 中 `apiUrl/authToken/autoExecute/autoSubmit/delay` 正确。
- relay 连接状态和 `/stats` 一致。

### 场景 C：Qwen 页面适配

真实 Qwen 页面测试不能依赖用户不可见的 tabId。步骤必须以用户能理解的操作描述记录：

1. 打开或选择已有 Qwen 对话页面。
2. 确认内容脚本识别平台为 Qwen。
3. 输入一个只读工具调用示例，例如列目录或读取测试文件。
4. 等待 Qwen 渲染工具块。
5. 验证插件能从 Qwen DOM 中提取工具调用。
6. 验证 NBSP、Monaco、省略占位、header-only `piercode-tool` 不破坏解析。
7. 若 Qwen 响应慢，允许新开会话，但必须记录新会话 URL 和原因。

通过标准：

- 工具调用被识别并发送到后端。
- 工具结果回填到页面。
- 没有把普通代码块误判为工具。
- 没有把 `Show more` 或省略占位当成代码内容。

### 场景 D：AI 页面附件上传

1. 打开支持附件的 AI 页面。
2. 通过 PierCode 触发 `browser_screenshot`，默认 `attach=true`。
3. 内容脚本收到 `browser_attachment_upload`。
4. 从后端 `/attachments/screenshot` 获取文件。
5. 将文件放入当前 AI 页面附件输入或拖放区域。
6. 回传 `browser_attachment_upload_result`。

通过标准：

- AI 页面出现截图附件。
- 后端工具输出 `Attachment upload: uploaded to current AI chat page`。
- 失败时必须明确是平台不支持、找不到上传入口、权限不足还是网络错误。

### 场景 E：审批弹窗与停止操作

1. 触发需要审批的浏览器副作用：点击、输入、上传、下载、拖放、导航。
2. 在 AI 页面显示审批弹窗。
3. 点击批准，操作继续。
4. 再触发一次并点击拒绝，操作终止。
5. 长操作期间显示视觉指示器和停止按钮。
6. 点击停止按钮，发送 `STOP_BROWSER_OPERATION`。

通过标准：

- 批准和拒绝结果都能回到后端。
- 拒绝不会执行副作用。
- 停止按钮文案变化为正在停止。
- 没有残留多个审批弹窗。

## 自动化测试要求

### Go 测试

必须覆盖：

- 工具参数校验。
- sandbox 路径。
- browser relay command/result。
- approval queue。
- stale snapshot。
- debugger detached。
- console/network event buffer。
- screenshot attachment upload。
- background task lifecycle。
- dangerous command filtering。

命令：

```bash
go test ./...
```

### Extension Vitest

必须覆盖：

- parser。
- Qwen/ChatGPT/Claude/Kimi DOM adapter。
- accessibility tree。
- visual indicator。
- downloads helper。
- popup settings helper。
- configure page。
- browser relay utils。

命令：

```bash
cd extension && npm test -- --run
```

### TypeScript 和构建

必须覆盖：

- `npx tsc --noEmit`
- `npm run build`
- 构建后 `dist/manifest.json`、`dist/background.js`、`dist/content.js`、`dist/popup.html`、`dist/configure.html`、`dist/configure.js` 存在。

## 手工记录模板

每次真实 Chrome/AI 页面验证在 `docs/test-runs/YYYY-MM-DD-browser-full.md` 记录：

```markdown
# Browser Full Test Run - YYYY-MM-DD

## Environment

- Commit/worktree:
- Chrome profile:
- PierCode extension id:
- Backend URL:
- AI platform:

## Commands

- `go test ./...`: pass/fail
- `cd extension && npm test -- --run`: pass/fail
- `cd extension && npx tsc --noEmit`: pass/fail
- `cd extension && npm run build`: pass/fail
- `node scripts/browser-live-smoke.mjs`: pass/fail

## Real Chrome Results

| Case | Result | Evidence |
| --- | --- | --- |
| Popup connection |  |  |
| Browser relay |  |  |
| Approval approve/reject |  |  |
| Stop operation |  |  |
| Full browser tools live smoke |  |  |
| Qwen adapter |  |  |
| Attachment upload |  |  |

## Bugs Found

| ID | Symptom | Root cause | Fix | Retest |
| --- | --- | --- | --- | --- |

## Remaining Risk

- 
```

## 失败处理规则

- 任一必测项失败，不得声明“全量通过”。
- 如果真实 AI 平台不可用，必须标记为 `blocked`，说明平台、时间、失败现象和下一步，不得用本地测试页替代。
- 如果 Qwen 响应慢，可以新开会话，但仍需完成 Qwen 适配验证。
- 如果用户 Chrome 扩展未连接，不得改用隔离 Chrome 作为最终证据。
- 如果测试需要删除、发送第三方消息、修改真实云端数据，必须改用本地测试页或先取得明确确认。

## 完成定义

只有同时满足以下条件，才可以声明当前项目浏览器功能全方位测试通过：

1. `go test ./...` 通过。
2. `cd extension && npm test -- --run` 通过。
3. `cd extension && npx tsc --noEmit` 通过。
4. `cd extension && npm run build` 通过。
5. 用户已安装 PierCode 扩展的真实 Chrome live smoke 覆盖全部浏览器工具并通过。
6. 弹窗 UI 状态和配置流程通过。
7. 审批 approve/reject/timeout/done 流程通过。
8. 内容脚本无障碍树、视觉指示器、停止操作通过。
9. Qwen 平台适配在真实或等价 DOM fixture 中通过；真实 Qwen 不可用时必须有阻塞记录。
10. 附件上传到 AI 会话通过；不可用时必须有阻塞记录。
11. 下载跟踪、PDF、上传、拖放、截图、zoom、console、network、cookies、导航历史、finalize 均有证据。
12. 所有发现的问题已修复并重新构建、刷新扩展、重启后端、复测通过。
