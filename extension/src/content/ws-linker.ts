// ws-linker.ts: 负责与 OpenLink 后端建立 WebSocket 连接并处理输入注入

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let configuredApiUrl = '';
let configuredToken = '';
let connectionSeq = 0;

type InjectConfig = {
  editor: string;
  sendBtn: string;
  fillMethod: "value" | "execCommand" | "contentEditable";
};

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

function getInjectConfig(): InjectConfig {
  const h = location.hostname;
  if (h.includes("qwen.ai") || h.includes("qwenlm.ai")) {
    return {
      editor: [
        "textarea.message-input-textarea",
        "textarea[placeholder*='Send']",
        "textarea[placeholder*='输入']",
        "[contenteditable='true']"
      ].join(","),
      sendBtn: [
        "button.send-button:not([disabled])",
        "button[aria-label*='发送']:not([disabled])",
        "button[aria-label*='Send']:not([disabled])"
      ].join(","),
      fillMethod: "value"
    };
  }
  if (h.includes("kimi.com")) {
    return {
      editor: "div.chat-input-editor[contenteditable='true'], [contenteditable='true']",
      sendBtn: "div.send-button-container, button[aria-label*='发送']:not([disabled]), button[aria-label*='Send']:not([disabled])",
      fillMethod: "execCommand"
    };
  }
  if (h.includes("chat.z.ai")) {
    return {
      editor: "textarea#chat-input, textarea",
      sendBtn: "button#send-message-button:not([disabled]), button[aria-label*='发送']:not([disabled]), button[aria-label*='Send']:not([disabled])",
      fillMethod: "value"
    };
  }
  if (h.includes("gemini.google.com")) {
    return {
      editor: "div.ql-editor[contenteditable='true'], [contenteditable='true']",
      sendBtn: "button.send-button[aria-label*='发送']:not([disabled]), button.send-button[aria-label*='Send']:not([disabled])",
      fillMethod: "execCommand"
    };
  }
  return {
    editor: [
      "textarea.prompt-textarea",
      "textarea#prompt-textarea",
      "#prompt-textarea",
      "textarea[placeholder*='Start typing a prompt']",
      "textarea[placeholder*='Message']",
      "textarea[placeholder*='输入']",
      "textarea[placeholder*='Send']",
      "[contenteditable='true']"
    ].join(","),
    sendBtn: [
      "button[type='submit']:not([disabled])",
      "button[aria-label*='Run']:not([disabled])",
      "button[aria-label*='发送']:not([disabled])",
      "button[aria-label*='Send']:not([disabled])",
      "button.send-button:not([disabled])"
    ].join(","),
    fillMethod: "value"
  };
}

function querySelectorFirst(selectors: string): HTMLElement | null {
  for (const selector of selectors.split(",").map(s => s.trim()).filter(Boolean)) {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (el && isVisibleInput(el)) return el;
  }
  return null;
}

function isVisibleInput(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0" &&
    el.getAttribute("aria-hidden") !== "true";
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
  if (targetInput instanceof HTMLTextAreaElement || targetInput instanceof HTMLInputElement) {
    const end = targetInput.value.length;
    targetInput.setSelectionRange?.(end, end);
  }
}

function sanitizeInjectedText(text: string): string {
  return text.replace(/^[\s\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\uFEFF\uFFFC\uFFFD\u25A1]+/u, "");
}

function setContentEditableValue(targetInput: HTMLElement, text: string) {
  targetInput.focus();
  targetInput.textContent = "";
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(targetInput);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand("insertText", false, text);
  targetInput.dispatchEvent(new Event("input", { bubbles: true }));
  targetInput.dispatchEvent(new Event("change", { bubbles: true }));
}

function fillTargetInput(targetInput: HTMLTextAreaElement | HTMLInputElement | HTMLElement, text: string, fillMethod: InjectConfig["fillMethod"]) {
  if (targetInput instanceof HTMLTextAreaElement || targetInput instanceof HTMLInputElement) {
    setTextInputValue(targetInput, text);
    return;
  }
  if (fillMethod === "execCommand") {
    setContentEditableValue(targetInput, text);
    return;
  }
  setContentEditableValue(targetInput, text);
}

function clickSendButton(config: InjectConfig, targetInput: HTMLElement, attempts = 0) {
  const sendBtn = querySelectorFirst(config.sendBtn);
  if (sendBtn) {
    sendBtn.click();
    return;
  }
  if (attempts >= 50) {
    targetInput.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    }));
    return;
  }
  window.setTimeout(() => clickSendButton(config, targetInput, attempts + 1), 100);
}

// 处理注入消息：查找聊天输入框并填入内容
function handleInjectMessage(text: string) {
  console.log("[OpenLink] 收到注入消息:", text);
  const cleanText = sanitizeInjectedText(text);
  if (!cleanText) {
    console.warn("[OpenLink] 注入内容为空，已跳过");
    return;
  }
  const config = getInjectConfig();
  const targetInput = querySelectorFirst(config.editor);

  if (!targetInput) {
    console.warn("[OpenLink] 未找到当前页面的聊天输入框");
    return;
  }

  fillTargetInput(targetInput, cleanText, config.fillMethod);
  window.setTimeout(() => clickSendButton(config, targetInput), 100);

  console.log("[OpenLink] ✅ 内容已注入并提交到输入框");
}

export function sendAIResponseLog(key: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed || !ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "ai_log", key, text: trimmed }));
  } catch (error) {
    console.warn("[OpenLink] AI 响应日志回传失败:", error);
  }
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
