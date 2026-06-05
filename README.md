# PierCode — Local AI Assistant Proxy for ChatGPT, Claude, Gemini & Qwen

> Connect web-based AI assistants to your **local filesystem and browser** through a **Chrome extension** and a **sandboxed Go server**.

![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?logo=go&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-React%2018-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/license-research%20only-lightgrey)

**PierCode** is an open-source local development tool that connects web-based AI assistants — **ChatGPT, Claude, Gemini, Qwen, Kimi**, and more — to your local filesystem and browser. The AI emits tool calls in its replies; a Chrome extension detects them and proxies them to a localhost Go server that executes sandboxed file, shell, and browser operations, then returns the results. It turns any web AI chat into a local coding agent that can read your repo, edit files, run tests, and drive the browser — no copy-pasting code back and forth. Learn more in the [documentation](docs/index.md).

**Keywords:** local AI assistant · AI coding agent · ChatGPT to local filesystem · Claude code execution · browser AI proxy · sandboxed code execution · Chrome extension AI tools · Go server · Manifest V3 · MCP alternative.

> **免责声明：本项目仅供学习和研究使用，严禁用于任何商业用途。**
> **Disclaimer:** for learning and research only; commercial use is prohibited.

PierCode 是一个本地开发辅助工具：通过浏览器扩展把网页版 AI 和本机 Go 服务连接起来，让 AI 可以在受限工作目录内请求读取文件、编辑文件、执行命令、搜索内容等工具能力。

它不是 API 网关，也不是生产级 Agent 运行时，更不是面向不可信提示词的安全沙箱。请只在你愿意暴露给当前 AI 页面访问的工作目录中运行。

## 组成

- 本地 HTTP 服务，默认监听 `127.0.0.1:39527`
- Chrome Manifest V3 浏览器扩展
- `piercode-tool` fenced code block 工具调用解析
- 兼容部分旧 XML / function-call 风格工具调用
- 基于真实路径解析的工作目录沙箱
- 扩展和本地服务之间的 token 认证

## 当前支持页面

扩展当前只会注入到这些页面：

- Google Gemini：`gemini.google.com`
- Google AI Studio：`aistudio.google.com`
- Qwen：`qwen.ai`、`qwenlm.ai`
- Chat Z：`chat.z.ai`
- Kimi：`kimi.com`
- Claude：`claude.ai`
- ChatGPT：`chatgpt.com`、`chat.openai.com`

其他站点需要同时补充 `extension/public/manifest.json` 的匹配规则和 `extension/src/platform-adapters.ts` 的页面适配逻辑。

## 环境要求

- Go 1.24+
- Node.js 18+
- Chrome 或兼容 Manifest V3 的 Chromium 浏览器

## 从源码启动

先构建扩展：

```powershell
cd extension
npm install
npm run build
cd ..
```

启动服务：

```powershell
go run ./cmd/server -dir .
```

启动后会显示本次进程的临时认证 URL，格式类似：

```text
http://127.0.0.1:39527/auth?token=<token>
```

认证 token 每次启动都会重新生成；重启后需要在浏览器扩展里重新粘贴当前 URL。

安装浏览器扩展：

1. 打开 `chrome://extensions/`。
2. 开启开发者模式。
3. 点击“加载已解压的扩展程序”。
4. 选择 `extension/dist`。
5. 打开扩展弹窗，粘贴服务端输出的认证 URL。

如果 AI 页面在扩展安装前已经打开，安装后需要刷新页面。

## 构建二进制

一键验证、构建并打包 Windows 产物：

```powershell
.\scripts\build.ps1
```

默认输出到 `release-packages\<timestamp>\`，包含：

- `bin\piercode-cli.exe`
- `bin\piercode.exe`
- `piercode_windows_amd64.zip`
- `extension.zip`

只想快速构建、不跑测试：

```powershell
.\scripts\build.ps1 -SkipTests
```

构建服务版本：

```powershell
go build -o piercode.exe ./cmd/server
```

这些构建产物不需要提交：

- `piercode.exe`
- `extension/dist/`
- `release/`
- `release-packages/`

## AI 可用工具

| 工具 | 说明 |
| --- | --- |
| `exec_cmd` | 在当前沙箱目录执行 shell 命令 |
| `list_dir` | 列出目录内容 |
| `read_file` | 读取文件内容 |
| `write_file` | 创建、覆盖或追加文件 |
| `apply_patch` | 应用带上下文的多文件 patch，适合作为默认代码编辑工具 |
| `edit` | 对文件做小范围精确字符串替换 |
| `glob` | 按 glob 模式搜索文件 |
| `grep` | 用正则搜索文件内容 |
| `web_fetch` | 获取 HTTP 页面内容 |
| `skill` | 加载本地 skill 文档 |
| `question` | 向用户提问 |
| `todo_write` | 写入 `.todos.json` 任务状态 |
| `browser_tabs` / `browser_new_tab` / `browser_use_tab` | 列出、创建、选择 Chrome 受控标签页；控制 AI 对话页前必须显式选择并审批 |
| `browser_navigate` / `browser_snapshot` | 导航受控标签页并读取可访问性树快照；页面理解优先使用 snapshot refs |
| `browser_click` / `browser_type` | 经用户确认后点击或输入；操作后旧 snapshot refs 视为失效 |
| `browser_screenshot` | 截取受控标签页截图并保存到工作区 `.piercode/screenshots` |
| `browser_cookies` / `browser_set_cookie` | 读取、写入或删除 Cookie 均需用户审批，目标域须在扩展 host 权限内 |
| `browser_storage` | 读写 localStorage / sessionStorage（get/set/remove/clear/keys） |
| `browser_emulate` | 模拟设备与环境：UA、设备像素比、移动端、配色方案、时区、地理位置；`reset=true` 清除 |
| `browser_wait_for_navigation` | 等待受控标签页导航完成并匹配 URL，配合触发跳转的点击使用 |
| `browser_get_attributes` | 读取元素属性与 computed style，免写 JS 校验颜色/状态 |

`/prompt` 会根据当前工作目录和已注册工具动态渲染初始化提示词。

## 本地服务端点

所有端点都只在本机访问，并需要生成的 token。

| 端点 | 说明 |
| --- | --- |
| `POST /auth` | 校验扩展 token |
| `GET /health` | 服务健康检查 |
| `GET /config` | 查看当前目录和超时配置 |
| `POST /cwd` | 切换当前工作目录 |
| `GET /tools` | 查看工具定义 |
| `POST /exec` | 执行工具调用 |
| `POST /inject` | 将 TUI 输入发送给浏览器扩展 |
| `GET /ws` | 扩展注入通道 WebSocket |
| `GET /prompt` | 获取渲染后的初始化提示词 |
| `GET /skills` | 列出本地 skills |
| `GET /files?q=...` | 搜索当前目录下的文件 |

## 浏览器控制

PierCode 可以通过 Chrome 扩展的 background service worker 使用 `chrome.debugger` 控制专用受控标签页。扩展要求 Chrome 118+，manifest 会请求 `debugger` 权限。

默认安全策略：

- 默认创建或选择专用受控 tab，不控制 ChatGPT、Gemini、Claude、Qwen 等 AI 对话页；如确需控制 AI 对话页，必须先调用 `browser_use_tab` 并由用户审批。
- `browser_snapshot` 返回紧凑 AX tree 文本和 `e0/e1` refs，是 AI 理解页面和后续点击/输入的主路径。
- `browser_click`、`browser_type`、`browser_upload`、`browser_evaluate` 等会改变页面或读取/执行页面脚本的工具会弹出确认面板，用户拒绝时工具失败；扩展 popup 可开启“自动审批浏览器操作”来自动允许这些浏览器审批；点击、输入、上传、导航后旧 snapshot refs 视为失效，需要重新 snapshot。
- `browser_screenshot` 只在视觉布局、图片、图表或渲染外观重要时使用，截图保存为工作区 `.piercode/screenshots` 下的图片文件，不把图片数据内联回对话。
- 拒绝 `file:`、`chrome:`、`chrome-extension:`、`javascript:`、`data:` 等高风险导航。
- `browser_cookies` 必须指定 domain 或 URL，避免无范围导出 Cookie，读取前会弹出用户审批；`browser_set_cookie` 写/删 Cookie 也属审批工具，目标域须在扩展 host 权限内。`browser_storage` 提供 localStorage / sessionStorage 读写。`browser_evaluate` 属于审批工具，只应在明确需要页面内表达式时使用。

手工验收建议：

1. `cd extension && npm run build` 后加载 `extension/dist` 为 unpacked extension。
2. 打开一个 AI 页面并完成 PierCode 授权，popup 中应显示浏览器控制 relay 状态。
3. 让 AI 依次调用 `browser_new_tab`、`browser_navigate`、`browser_snapshot`，确认能创建受控 tab、导航并返回 refs。
4. 调用 `browser_screenshot`，确认结果只返回保存路径且文件位于 `.piercode/screenshots`，不会把图片数据内联到对话。
5. 调用 `browser_click` 或 `browser_type`，确认页面出现审批面板，允许后执行，拒绝后工具返回错误。
6. 调用 `browser_upload` 到测试页的 `<input type="file">`，确认页面收到文件名；调用 `browser_handle_dialog` 处理延迟触发的 alert，确认不会卡住后续工具。
7. 打开受控 tab 的 DevTools，确认 debugger detach 时工具能给出明确错误。

自动 smoke test 可在构建扩展后运行：

```powershell
cd extension; npm run build; cd ..
node scripts/browser-smoke.mjs
```

## 安全边界

PierCode 做了基础防护，但不能替代人工确认。

已有保护：

- 服务只绑定 `127.0.0.1`
- 请求需要 token
- 文件路径会解析真实路径后再做沙箱校验
- `/cwd` 不能离开初始启动目录
- 已知危险命令和下载执行模式会被拦截
- 命令执行有超时限制

> ⚠️ **shell 默认开启**：`exec_cmd` 工具由 `--allow-shell` 控制，默认值为 `true`。这意味着 AI 默认可在启动目录内执行任意未被黑名单拦截的 shell 命令。危险命令黑名单只是兜底，不是完整沙箱，可被变量展开/引号拼接等方式绕过。在不完全信任的环境中请以 `--no-shell`（等价 `--allow-shell=false`）启动，仅保留文件类工具。

仍然存在的风险：

- AI 仍可请求修改启动目录内的文件
- AI 仍可请求执行未被拦截的普通命令（除非用 `--no-shell` 关闭 `exec_cmd`）
- 不同网页 AI 的 DOM 结构经常变化，工具调用解析可能失效
- 不建议开启任何未经人工确认的自动执行流程

## 开发和验证

Go 测试：

```powershell
go test ./...
```

扩展测试和构建：

```powershell
cd extension
npm test
npm run build
npx tsc --noEmit
```

主要目录：

- `cmd/server`：服务启动入口
- `internal/server`：HTTP 路由和 WebSocket 桥接
- `internal/tool`：本地工具实现
- `internal/security`：token 和沙箱校验
- `extension/src/content`：页面注入和工具调用检测
- `extension/src/platform-adapters.ts`：站点适配逻辑
- `extension/src/popup`：扩展弹窗和认证 UI
- `prompts/init_prompt.txt`：默认初始化提示词

## 提交约定

需要提交：

- 源码
- 测试
- `go.mod` / `go.sum`
- `extension/package.json` / `extension/package-lock.json`
- `extension/public/manifest.json`
- 提示词和文档

不要提交：

- 编译出来的 `.exe`
- `extension/dist/`
- `node_modules/`
- `release/`、`release-packages/`
- `.omx/`、`.claude/`、`.playwright-mcp/`
- 临时分析报告和本机工具状态文件

## 致谢

- [OpenLink](https://github.com/afumu/openlink) — PierCode 的前身项目，提供了初始架构和核心思路。
