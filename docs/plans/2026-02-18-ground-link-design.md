# Ground-Link 系统设计文档

**版本**: v1.0
**日期**: 2026-02-18
**状态**: 设计中

---

## 1. 系统架构

### 1.1 整体架构

```
浏览器 (Browser Extension)
    ↓ HTTP
本地服务 (Go Server :8080)
    ↓
文件系统 (Sandbox Directory)
```

### 1.2 核心组件

1. **浏览器插件** (Chrome Extension Manifest V3)
   - XML 解析器
   - 确认 UI
   - 输入框回填

2. **Go 服务端**
   - HTTP API
   - 安全层
   - 工具执行器

---

## 2. Go Server 详细设计

### 2.1 目录结构

```
ground-link/
├── cmd/
│   └── server/
│       └── main.go          # 入口
├── internal/
│   ├── server/
│   │   └── server.go        # HTTP 服务
│   ├── security/
│   │   └── sandbox.go       # 沙箱校验
│   ├── executor/
│   │   └── executor.go      # 工具执行
│   └── types/
│       └── types.go         # 数据结构
└── go.mod
```

### 2.2 核心数据结构

```go
// 工具调用请求
type ToolRequest struct {
    Name   string                 `json:"name"`
    Args   map[string]interface{} `json:"args"`
    Reason string                 `json:"reason,omitempty"`
}

// 工具执行响应
type ToolResponse struct {
    Status string `json:"status"` // "success" | "error"
    Output string `json:"output"`
    Error  string `json:"error,omitempty"`
}

// 服务配置
type Config struct {
    RootDir string
    Port    int
    Timeout int // 秒
}
```

### 2.3 HTTP API 设计

#### POST /exec
执行工具调用

**请求**:
```json
{
  "name": "read_file",
  "args": {"path": "./config.yaml"},
  "reason": "读取配置文件"
}
```

**响应**:
```json
{
  "status": "success",
  "output": "file content here..."
}
```

#### GET /health
健康检查

**响应**:
```json
{
  "status": "ok",
  "dir": "/Users/afumu/workspace",
  "version": "1.0.0"
}
```

#### GET /config
获取当前配置

**响应**:
```json
{
  "rootDir": "/Users/afumu/workspace",
  "timeout": 60
}
```

### 2.4 安全层设计

#### SafePath 沙箱校验

```go
func SafePath(rootDir, targetPath string) (string, error) {
    cleanRoot := filepath.Clean(rootDir)
    cleanTarget := filepath.Clean(filepath.Join(rootDir, targetPath))

    if !strings.HasPrefix(cleanTarget, cleanRoot) {
        return "", errors.New("path outside sandbox")
    }
    return cleanTarget, nil
}
```

#### 命令黑名单

```go
var dangerousCommands = []string{
    "rm -rf", "mkfs", "dd", "format",
    "> /dev/", "curl", "wget", "nc",
}
```

#### 超时控制

```go
ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
defer cancel()
```

### 2.5 工具执行器

#### list_dir
```go
// 列出目录内容
args: {"path": "./"}
output: "file1.txt\nfile2.go\ndir1/"
```

#### read_file
```go
// 读取文件内容
args: {"path": "./config.yaml"}
output: "文件内容..."
```

#### write_file
```go
// 写入文件
args: {
  "path": "./output.txt",
  "content": "hello",
  "mode": "overwrite" // 或 "append"
}
output: "写入成功"
```

#### exec_cmd
```go
// 执行命令 (高危)
args: {"cmd": "ls -la"}
output: "命令输出..."
```

---

## 3. 浏览器插件设计

### 3.1 目录结构

```
extension/
├── manifest.json
├── background.js      # Service Worker
├── content.js         # Content Script
├── injected.js        # 注入到页面的脚本
├── popup.html         # 插件弹窗
├── popup.js
└── styles.css
```

### 3.2 核心模块

#### 3.2.1 XML 解析器
```javascript
// 实时监听流式响应
function parseToolCall(text) {
  const regex = /<tool>([\s\S]*?)<\/tool>/g;
  const match = regex.exec(text);
  if (match) {
    return JSON.parse(match[1]);
  }
  return null;
}
```

#### 3.2.2 HTTP 拦截器
```javascript
// 劫持 fetch
const originalFetch = window.fetch;
window.fetch = function(...args) {
  return originalFetch.apply(this, args).then(response => {
    // 拦截流式响应
    const reader = response.body.getReader();
    // 监听 <tool> 标签
  });
};
```

#### 3.2.3 确认 UI
```javascript
// 在页面渲染确认卡片
function showConfirmUI(toolCall) {
  const card = document.createElement('div');
  card.innerHTML = `
    <div class="tool-confirm">
      <p>🛠️ ${toolCall.name}</p>
      <button id="run">运行</button>
      <button id="reject">拒绝</button>
    </div>
  `;
  document.body.appendChild(card);
}
```

#### 3.2.4 输入框回填器
```javascript
// 自动填充结果并发送
async function fillAndSend(result) {
  const textarea = document.querySelector('textarea');
  textarea.value = result;
  textarea.dispatchEvent(new Event('input', {bubbles: true}));

  const sendBtn = document.querySelector('[type="submit"]');
  sendBtn.click();
}
```

---

## 4. 通信协议

### 4.1 协议格式

**AI 输出格式**:
```xml
<tool>
{"name": "read_file", "args": {"path": "./config.yaml"}}
</tool>
```

**插件 → Server**:
```http
POST http://127.0.0.1:8080/exec
Content-Type: application/json

{"name": "read_file", "args": {"path": "./config.yaml"}}
```

**Server → 插件**:
```json
{"status": "success", "output": "file content..."}
```

### 4.2 错误码

| 错误码 | 说明 |
|--------|------|
| `path_outside_sandbox` | 路径越界 |
| `file_not_found` | 文件不存在 |
| `permission_denied` | 权限不足 |
| `timeout` | 执行超时 |
| `dangerous_command` | 危险命令 |

---

## 5. 配置与启动

### 5.1 启动命令
```bash
./ground-link -dir="/Users/afumu/workspace" -port=8080 -timeout=60
```

### 5.2 配置文件 (可选)
```yaml
# config.yaml
rootDir: /Users/afumu/workspace
port: 8080
timeout: 60
autoMode: false
```

---

## 6. 测试策略

### 6.1 安全测试
- 路径越界: `../../etc/passwd`
- 危险命令: `rm -rf /`
- 超时测试: `sleep 100`

### 6.2 功能测试
- 读取文件
- 写入文件
- 列出目录
- 执行命令

---

## 7. 技术栈

| 组件 | 技术 |
|------|------|
| Server | Go 1.21+ |
| Web框架 | Gin |
| Extension | Chrome Manifest V3 |
| 通信 | HTTP + JSON |

---

## 8. 下一步

设计文档完成后,进入实施阶段:
1. 初始化 Go 项目
2. 实现 Server 核心功能
3. 开发浏览器插件
4. 集成测试


```
