# PierCode

PierCode 是一个本地开发辅助工具：通过浏览器扩展把网页版 AI 和本机 Go 服务连接起来，让 AI 可以在受限工作目录内请求读取文件、编辑文件、执行命令、搜索内容等工具能力。

它不是 API 网关，也不是生产级 Agent 运行时，更不是面向不可信提示词的安全沙箱。请只在你愿意暴露给当前 AI 页面访问的工作目录中运行。

## 组成

- 本地 HTTP 服务，默认监听 `127.0.0.1:39527`
- 已废弃的可选 TUI，仅为兼容旧流程保留
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

启动普通服务版本（推荐）：

```powershell
go run ./cmd/server -dir .
```

旧 TUI 入口已废弃，仅为兼容旧流程保留：

```powershell
go run ./cmd/cli -dir .
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

## TUI 使用（已废弃）

TUI 入口仅保留兼容，不再作为日常推荐入口。优先使用 `cmd/server` 启动本地服务，并通过浏览器扩展完成交互。

```powershell
go run ./cmd/cli -dir .
```

常用操作：

- 直接输入文本：发送到当前已连接的 AI 页面输入框
- `/`：进入指令输入
- `Tab`：补全 slash 指令或 `/cd` 目录
- `Ctrl+J` 或 `Alt+Enter`：在输入框内换行
- `Ctrl+T`：切换完整输出视图
- `q` 或 `Ctrl+C`：退出

支持的 slash 指令：

```text
/cd <path>     切换 AI 工具执行目录，限制在启动目录内
/cwd           显示当前执行目录
/url           显示认证 URL
/send <text>   把文本发送到已连接的 AI 页面
/clear         清空 TUI 活动区
/help          显示指令帮助
```

`/cd` 不允许跳出程序启动时指定的根目录，即使路径经过符号链接或 junction 也会按真实路径校验。

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

构建旧 TUI 版本（已废弃，仅兼容）：

```powershell
go build -o piercode-cli.exe ./cmd/cli
```

构建普通服务版本：

```powershell
go build -o piercode.exe ./cmd/server
```

这些构建产物不需要提交：

- `piercode.exe`
- `piercode-cli.exe`
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
| `edit` | 对文件做精确字符串替换 |
| `glob` | 按 glob 模式搜索文件 |
| `grep` | 用正则搜索文件内容 |
| `web_fetch` | 获取 HTTP 页面内容 |
| `skill` | 加载本地 skill 文档 |
| `question` | 向用户提问 |
| `todo_write` | 写入 `.todos.json` 任务状态 |

`/prompt` 会根据当前工作目录和已注册工具动态渲染初始化提示词。

## 本地服务端点

所有端点都只在本机访问，并需要生成的 token。

| 端点 | 说明 |
| --- | --- |
| `GET /auth?token=...` | 校验扩展 token |
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

## 安全边界

PierCode 做了基础防护，但不能替代人工确认。

已有保护：

- 服务只绑定 `127.0.0.1`
- 请求需要 token
- 文件路径会解析真实路径后再做沙箱校验
- `/cwd` 不能离开初始启动目录
- 已知危险命令和下载执行模式会被拦截
- 命令执行有超时限制

仍然存在的风险：

- AI 仍可请求修改启动目录内的文件
- AI 仍可请求执行未被拦截的普通命令
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

- `cmd/cli`：已废弃的 TUI 启动入口，仅兼容旧流程
- `cmd/server`：普通服务启动入口
- `internal/server`：HTTP 路由和 WebSocket 桥接
- `internal/tool`：本地工具实现
- `internal/security`：token 和沙箱校验
- `internal/tui`：已废弃的终端 UI 和日志模型，仅兼容旧流程
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
