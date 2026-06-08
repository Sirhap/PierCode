# PierCode API 层工具拦截方案

## 背景

通过油猴脚本抓包发现，Qwen 和 ChatGPT 的 web 界面都不在 API 请求里发 `tools` 参数。模型使用平台内置的 `code_interpreter` 来执行本地操作，而不是输出 `piercode-tool` 代码块。

**核心问题**：模型有原生工具（`code_interpreter`），更倾向于用自己的工具而不是输出文本格式的 `piercode-tool`。

**解决方案**：在 page-bridge 层拦截 API 响应的 SSE 流，当检测到模型调用 `code_interpreter` 时，提取其中的代码，翻译成 PierCode 工具调用，执行后把结果注入回对话。

## 抓包数据总结

### Qwen (`chat.qwen.ai`)
```
API: POST /api/v2/chat/completions
格式: OpenAI 兼容 SSE
  data: {"choices":[{"delta":{"content":"..."}}]}

工具调用通过 phase 字段标识：
  {"delta":{"phase":"code_interpreter","function_call":{"name":"code_interpreter","arguments":"{\"code\":\"ls -la\"}"}}}

响应结束：
  {"choices":[{"delta":{"content":"","status":"finished","phase":"answer"}}]}
```

### ChatGPT (`chatgpt.com`)
```
API: POST /backend-api/f/conversation
格式: 私有 SSE delta 编码（v1），通过 WebSocket topic 推送
  event: delta
  data: {"v":{"message":{"content":{"parts":["文本"]},"author":{"role":"assistant"}}}}

工具调用通过 code_interpreter phase：
  {"delta":{"phase":"code_interpreter","function_call":{"name":"code_interpreter","arguments":"{\"code\":\"...\"}"}}}
```

### 关键发现
- 两个平台都用 `code_interpreter` 作为默认工具
- 模型会先用 `code_interpreter` 打印 "Preparing spawn_agent call" 这样的占位符，然后才输出 `piercode-tool` 代码块
- `code_interpreter` 的代码内容是 Python/Shell 代码

## 方案设计

### 架构：page-bridge SSE 拦截 + 工具翻译

```
AI 平台 API 响应 (SSE)
    ↓
page-bridge.js（MAIN world, document_start）
    ↓ monkey-patch window.fetch
拦截响应流 → tee() 分流
    ↓                              ↓
原始流 → AI 页面正常渲染      分析流 → 逐行解析 SSE
                                      ↓
                              检测 code_interpreter 调用
                                      ↓
                              解析代码 → 映射到 PierCode 工具
                                      ↓
                              执行工具 → 获取结果
                                      ↓
                              注入结果回对话（通过 WS → Go server → inject）
```

### 实现步骤

#### Step 1: page-bridge 添加 fetch 拦截器

**文件**: `extension/src/page-bridge/index.ts`

在现有 `installKeepAliveVisibilityShim()` 之后，添加 API 拦截器：

```typescript
// 配置
const API_INTERCEPT_ENABLED_KEY = 'piercode_api_intercept';
let apiInterceptEnabled = false;

// 从 storage 读取开关状态
chrome.storage.local.get(API_INTERCEPT_ENABLED_KEY, (result) => {
  apiInterceptEnabled = !!result[API_INTERCEPT_ENABLED_KEY];
});

// 监听开关变化
chrome.storage.onChanged.addListener((changes) => {
  if (changes[API_INTERCEPT_ENABLED_KEY]) {
    apiInterceptEnabled = changes[API_INTERCEPT_ENABLED_KEY].newValue;
  }
});

// 聊天 API 端点匹配
const CHAT_API_PATTERNS = [
  /\/api\/v2\/chat\/completions/,   // Qwen
  /\/backend-api\/f\/conversation/,  // ChatGPT
  /\/api\/chat\/completions/,        // 通用 OpenAI 兼容
];

// code_interpreter 代码 → PierCode 工具映射
const CODE_TO_TOOL_MAP: Record<string, (code: string) => {name: string, args: Record<string, unknown>} | null> = {
  'list_dir': (code) => {
    // 匹配 ls, dir, tree 等命令
    const lsMatch = code.match(/(?:ls|dir)\s+(?:-[a-zA-Z]+\s+)?['"]?([^'"]+)['"]?/);
    if (lsMatch) return { name: 'list_dir', args: { path: lsMatch[1] } };
    const treeMatch = code.match(/tree\s+(?:-[a-zA-Z]+\s+)?['"]?([^'"]+)['"]?/);
    if (treeMatch) return { name: 'list_dir', args: { path: treeMatch[1] } };
    return null;
  },
  'read_file': (code) => {
    const catMatch = code.match(/cat\s+['"]?([^'"]+)['"]?/);
    if (catMatch) return { name: 'read_file', args: { path: catMatch[1] } };
    const headMatch = code.match(/head\s+(?:-(\d+)\s+)?['"]?([^'"]+)['"]?/);
    if (headMatch) return { name: 'read_file', args: { path: headMatch[2], limit: headMatch[1] ? parseInt(headMatch[1]) : 10 } };
    return null;
  },
  'grep': (code) => {
    const grepMatch = code.match(/grep\s+(?:-[a-zA-Z]+\s+)?['"](.+?)['"]\s+['"]?([^'"]+)['"]?/);
    if (grepMatch) return { name: 'grep', args: { pattern: grepMatch[1], path: grepMatch[2] || '.' } };
    return null;
  },
  'exec_cmd': (code) => {
    // 通用命令 → exec_cmd
    return { name: 'exec_cmd', args: { command: code.trim() } };
  },
};

// 从 code_interpreter 调用中提取代码
function extractCodeFromInterpreter(args: string): string | null {
  try {
    const parsed = JSON.parse(args);
    return parsed.code || null;
  } catch {
    return null;
  }
}

// 翻译代码到 PierCode 工具调用
function translateCodeToTool(code: string): {name: string, args: Record<string, unknown>} | null {
  // 尝试每种映射
  for (const [, mapper] of Object.entries(CODE_TO_TOOL_MAP)) {
    const result = mapper(code);
    if (result) return result;
  }
  // 默认：作为 shell 命令执行
  if (code.trim().length > 0 && code.trim().length < 500) {
    return { name: 'exec_cmd', args: { command: code.trim() } };
  }
  return null;
}

// SSE 流拦截器
async function interceptSSEStream(response: Response): Promise<Response> {
  const [pageStream, analysisStream] = response.body!.tee();
  
  // 分析流在后台运行
  const reader = analysisStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          
          try {
            const json = JSON.parse(data);
            // 检测 code_interpreter 调用
            const choices = json.choices || [];
            for (const choice of choices) {
              const delta = choice.delta;
              if (!delta) continue;
              
              // Qwen 格式: phase === 'code_interpreter' + function_call
              if (delta.phase === 'code_interpreter' && delta.function_call) {
                const code = extractCodeFromInterpreter(delta.function_call.arguments);
                if (code) {
                  const toolCall = translateCodeToTool(code);
                  if (toolCall) {
                    console.log(`[PierCode API] 检测到 code_interpreter → ${toolCall.name}`, toolCall.args);
                    // 发送给 content script 处理
                    window.dispatchEvent(new CustomEvent('piercode-api-tool-call', {
                      detail: { ...toolCall, source: 'api-intercept', originalCode: code }
                    }));
                  }
                }
              }
              
              // ChatGPT 格式可能不同，需要适配
              // TODO: 添加 ChatGPT 的检测逻辑
            }
          } catch {}
        }
      }
    } catch (e) {
      console.warn('[PierCode API] 分析流错误:', e);
    } finally {
      reader.releaseLock();
    }
  })();
  
  // 返回原始流给页面
  return new Response(pageStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Monkey-patch fetch
const originalFetch = window.fetch;
window.fetch = async function(...args: Parameters<typeof fetch>): Promise<Response> {
  if (!apiInterceptEnabled) {
    return originalFetch.apply(this, args);
  }
  
  const [input, init] = args;
  const url = typeof input === 'string' ? input : input?.url || '';
  const method = (init?.method || 'GET').toUpperCase();
  
  // 只拦截 POST 请求到聊天 API
  if (method !== 'POST' || !CHAT_API_PATTERNS.some(p => p.test(url))) {
    return originalFetch.apply(this, args);
  }
  
  const response = await originalFetch.apply(this, args);
  const contentType = response.headers.get('content-type') || '';
  
  // 只拦截 SSE 响应
  if (!contentType.includes('event-stream') && !contentType.includes('text/event-stream')) {
    return response;
  }
  
  return interceptSSEStream(response);
};
```

#### Step 2: content script 监听 API 工具调用事件

**文件**: `extension/src/content/index.ts`

```typescript
// 监听来自 page-bridge 的 API 拦截事件
window.addEventListener('piercode-api-tool-call', ((e: CustomEvent) => {
  const { name, args, source, originalCode } = e.detail;
  console.log(`[PierCode] API 拦截到工具调用: ${name}`, args);
  
  // 发送给 Go server 执行
  executeToolCall(name, args, source, originalCode);
}) as EventListener);

async function executeToolCall(name: string, args: Record<string, unknown>, source: string, originalCode: string) {
  try {
    const apiUrl = getApiUrl();
    const token = getAuthToken();
    
    const response = await fetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        name,
        args,
        call_id: `api-${Date.now()}`,
        source: 'api-intercept',
      }),
    });
    
    const result = await response.json();
    console.log(`[PierCode] 工具执行结果:`, result);
    
    // 注入结果回 AI 对话
    injectToolResult(name, args, result, originalCode);
  } catch (e) {
    console.error(`[PierCode] 工具执行失败:`, e);
  }
}

function injectToolResult(name: string, args: Record<string, unknown>, result: Record<string, unknown>, originalCode: string) {
  // 构造结果消息，注入回 AI 对话
  const resultText = `### ${name} #api-${Date.now()}\n${result.output || result.error || 'No output'}`;
  
  // 通过 WS 发给 Go server，再由 server inject 回对话
  if (wsLinker && wsLinker.isConnected()) {
    wsLinker.send(JSON.stringify({
      type: 'inject',
      text: resultText,
    }));
  }
}
```

#### Step 3: 添加 API 拦截开关到 popup

**文件**: `extension/src/popup/index.tsx`

```tsx
// 在 popup 中添加开关
<div className="flex items-center justify-between p-3 bg-gray-800 rounded">
  <div>
    <div className="text-sm font-medium">API 工具拦截</div>
    <div className="text-xs text-gray-400">拦截 code_interpreter 调用并翻译为 PierCode 工具</div>
  </div>
  <label className="relative inline-flex items-center cursor-pointer">
    <input type="checkbox" checked={apiIntercept} onChange={toggleApiIntercept} className="sr-only peer" />
    <div className="w-9 h-5 bg-gray-600 peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:bg-blue-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all"></div>
  </label>
</div>
```

## 工具翻译映射表

| code_interpreter 代码 | PierCode 工具 | 参数提取 |
|----------------------|--------------|---------|
| `ls -la /path` | `list_dir` | `path: "/path"` |
| `ls .` | `list_dir` | `path: "."` |
| `cat file.txt` | `read_file` | `path: "file.txt"` |
| `head -20 file.txt` | `read_file` | `path: "file.txt", limit: 20` |
| `grep "pattern" file` | `grep` | `pattern: "pattern", path: "file"` |
| `find . -name "*.go"` | `glob` | `pattern: "**/*.go"` |
| `pwd` | `exec_cmd` | `command: "pwd"` |
| `echo "content" > file` | `write_file` | `path: "file", content: "content"` |
| 其他命令 | `exec_cmd` | `command: <原始命令>` |

## 注意事项

1. **不破坏原有功能**：拦截器只在 `apiInterceptEnabled=true` 时激活，关闭后完全恢复原样
2. **只拦截响应，不修改请求**：AI 页面的请求原样发送，我们只在响应流里做分析
3. **结果注入方式**：通过 WS → Go server → `/inject` 端点注入回对话，和现有的工具结果注入机制一致
4. **平台适配**：Qwen 和 ChatGPT 的 SSE 格式不同，需要分别处理
5. **code_interpreter 代码解析**：需要处理各种 shell/Python 代码格式，用正则提取命令和参数

## 验证方法

1. 打开 Qwen/ChatGPT，开启 API 拦截
2. 输入"帮我看看当前目录有什么文件"
3. 观察控制台是否有 `[PierCode API] 检测到 code_interpreter → list_dir`
4. 确认工具是否正确执行并返回结果
5. 确认结果是否注入回 AI 对话
