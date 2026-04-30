// ws-linker.ts: 负责与 OpenLink 后端建立 WebSocket 连接并处理输入注入

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let configuredApiUrl = '';
let configuredToken = '';
let connectionSeq = 0;

async function getAuthInfo(): Promise<{ apiUrl: string; token: string } | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(["apiUrl", "authToken", "authPort"], (result) => {
      if (result.apiUrl && result.authToken) {
        resolve({ apiUrl: result.apiUrl, token: result.authToken });
      } else if (result.authPort && result.authToken) {
        resolve({ apiUrl: `http://127.0.0.1:${result.authPort}`, token: result.authToken });
      } else {
        resolve(null);
      }
    });
  });
}

function toWebSocketUrl(apiUrl: string, token: string): string | null {
  try {
    const url = new URL(apiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = `?token=${encodeURIComponent(token)}`;
    return url.toString();
  } catch {
    return null;
  }
}

function connectWebSocket(apiUrl: string, token: string) {
  configuredApiUrl = apiUrl;
  configuredToken = token;
  const seq = ++connectionSeq;

  if (ws) {
    ws.close();
  }

  const wsUrl = toWebSocketUrl(apiUrl, token);
  if (!wsUrl) {
    console.warn("[OpenLink] WebSocket URL 无效:", apiUrl);
    return;
  }
  console.log("[OpenLink] WebSocket 连接中...", wsUrl);

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("[OpenLink] ✅ WebSocket 已连接");
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "inject" && msg.text) {
          handleInjectMessage(msg.text);
        }
      } catch (e) {
        console.error("[OpenLink] 解析 WebSocket 消息失败:", e);
      }
    };

    ws.onclose = (e) => {
      console.warn("[OpenLink] ⚠️ WebSocket 连接已关闭:", e.reason);
      ws = null;
      if (seq !== connectionSeq) return;
      // 3 秒后尝试重连
      reconnectTimer = window.setTimeout(() => {
        console.log("[OpenLink] 🔄 正在尝试重新连接 WebSocket...");
        if (configuredApiUrl && configuredToken) connectWebSocket(configuredApiUrl, configuredToken);
      }, 3000);
    };

    ws.onerror = (err) => {
      console.error("[OpenLink] ❌ WebSocket 发生错误:", err);
      ws?.close();
    };
  } catch (e) {
    console.error("[OpenLink] 创建 WebSocket 失败:", e);
  }
}

function setTextInputValue(targetInput: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const proto = targetInput instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(targetInput, text);
  else targetInput.value = text;
  targetInput.dispatchEvent(new Event("input", { bubbles: true }));
  targetInput.dispatchEvent(new Event("change", { bubbles: true }));
  targetInput.focus();
}

function setContentEditableValue(targetInput: HTMLElement, text: string) {
  targetInput.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(targetInput);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand("insertText", false, text);
  targetInput.dispatchEvent(new Event("input", { bubbles: true }));
  targetInput.dispatchEvent(new Event("change", { bubbles: true }));
}

// 处理注入消息：查找聊天输入框并填入内容
function handleInjectMessage(text: string) {
  console.log("[OpenLink] 收到注入消息:", text);

  // 定义不同 AI 平台的输入框选择器
  const selectors = [
    // Claude
    "textarea.prompt-textarea",
    // ChatGPT
    "textarea#prompt-textarea",
    "#prompt-textarea",
    // Qwen
    "textarea.message-input-textarea",
    // Kimi
    "div.chat-input-editor[contenteditable='true']",
    // Chat Z
    "textarea#chat-input",
    // Gemini
    "div.ql-editor[contenteditable='true']",
    // AI Studio
    "textarea[placeholder*='Start typing a prompt']",
    // 通用
    "textarea[placeholder*='Message']",
    "textarea[placeholder*='输入']",
    "textarea[placeholder*='Send']",
    "[contenteditable='true']"
  ];

  let targetInput: HTMLTextAreaElement | HTMLElement | null = null;

  // 尝试查找
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      targetInput = el as HTMLTextAreaElement | HTMLElement;
      break;
    }
  }

  if (!targetInput) {
    console.warn("[OpenLink] 未找到当前页面的聊天输入框");
    return;
  }

  // 填入内容并触发事件（模拟用户输入）
  if (targetInput instanceof HTMLTextAreaElement || targetInput instanceof HTMLInputElement) {
    setTextInputValue(targetInput, text);
  } else {
    setContentEditableValue(targetInput, text);
  }

  console.log("[OpenLink] ✅ 内容已注入到输入框");
}

// 初始化
export function initWsLinker() {
  // 页面加载完成后尝试连接
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => startConnection());
  } else {
    startConnection();
  }
}

function startConnection() {
  getAuthInfo().then((info) => {
    if (info) {
      connectWebSocket(info.apiUrl, info.token);
    } else {
      console.log("[OpenLink] 等待认证配置... (将在认证后自动连接)");
    }
  });

  // 监听存储变化，以便在认证后立即连接
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && (changes.apiUrl || changes.authToken || changes.authPort)) {
      getAuthInfo().then((info) => {
        if (info) {
          console.log("[OpenLink] 检测到认证信息变更，重新连接 WebSocket");
          connectWebSocket(info.apiUrl, info.token);
        }
      });
    }
  });
}
