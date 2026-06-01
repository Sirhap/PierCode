// ws-linker.ts: 负责与 PierCode 后端建立 WebSocket 连接并处理输入注入

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let configuredApiUrl = '';
let configuredToken = '';
let connectionSeq = 0;
const PAGE_CLIENT_ID = getOrCreateClientId();

type BridgeState = 'not_configured' | 'connecting' | 'open' | 'closed' | 'error' | 'invalid_url';

function setBridgeStatus(state: BridgeState, apiUrl = configuredApiUrl) {
  (window as any).__PIERCODE_WS_STATUS__ = {
    connected: state === 'open',
    state,
    apiUrl,
    updatedAt: Date.now(),
  };
}

export type ToolStreamMessage = {
  type: 'tool_stream';
  task_id?: string;
  call_id?: string;
  stream: 'stdout' | 'stderr';
  text: string;
};

export type ToolDoneMessage = {
  type: 'tool_done';
  task_id?: string;
  call_id?: string;
  exit_code: number;
  status: string;
  error?: string;
  duration_ms: number;
};

export type QuestionAskMessage = {
  type: 'question_ask';
  call_id: string;
  question: string;
  options?: unknown[];
};

export type QuestionCancelMessage = {
  type: 'question_cancel';
  call_id: string;
  reason?: string;
};

export type BrowserApprovalAskMessage = {
  type: 'browser_approval_ask';
  approval_id: string;
  call_id?: string;
  action: string;
  tab?: { tabId?: number; title?: string; url?: string };
  target: string;
  risk: string;
  options?: string[];
};

export type BrowserApprovalDoneMessage = {
  type: 'browser_approval_done';
  approval_id: string;
  call_id?: string;
};

export type BrowserAttachmentUploadMessage = {
  type: 'browser_attachment_upload';
  call_id: string;
  path: string;
  name: string;
  mimeType: string;
  bytes?: number;
};

type StreamHandler = (msg: ToolStreamMessage) => void;
type DoneHandler = (msg: ToolDoneMessage) => void;
type QuestionAskHandler = (msg: QuestionAskMessage) => void;
type QuestionCancelHandler = (msg: QuestionCancelMessage) => void;
type BrowserApprovalAskHandler = (msg: BrowserApprovalAskMessage) => void;
type BrowserApprovalDoneHandler = (msg: BrowserApprovalDoneMessage) => void;
type BrowserAttachmentUploadHandler = (msg: BrowserAttachmentUploadMessage) => void;

const streamHandlers: StreamHandler[] = [];
const doneHandlers: DoneHandler[] = [];
const questionAskHandlers: QuestionAskHandler[] = [];
const questionCancelHandlers: QuestionCancelHandler[] = [];
const browserApprovalAskHandlers: BrowserApprovalAskHandler[] = [];
const browserApprovalDoneHandlers: BrowserApprovalDoneHandler[] = [];
const browserAttachmentUploadHandlers: BrowserAttachmentUploadHandler[] = [];
const answeredBrowserApprovals = new Set<string>();

function getOrCreateClientId(): string {
  try {
    const key = '__PIERCODE_CLIENT_ID__';
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const id = `content-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(key, id);
    return id;
  } catch {
    return `content-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function getPierCodeClientId(): string {
  return PAGE_CLIENT_ID;
}

export function onToolStream(handler: StreamHandler): () => void {
  streamHandlers.push(handler);
  return () => {
    const idx = streamHandlers.indexOf(handler);
    if (idx >= 0) streamHandlers.splice(idx, 1);
  };
}

export function onToolDone(handler: DoneHandler): () => void {
  doneHandlers.push(handler);
  return () => {
    const idx = doneHandlers.indexOf(handler);
    if (idx >= 0) doneHandlers.splice(idx, 1);
  };
}

export function onQuestionAsk(handler: QuestionAskHandler): () => void {
  questionAskHandlers.push(handler);
  return () => {
    const idx = questionAskHandlers.indexOf(handler);
    if (idx >= 0) questionAskHandlers.splice(idx, 1);
  };
}

export function onQuestionCancel(handler: QuestionCancelHandler): () => void {
  questionCancelHandlers.push(handler);
  return () => {
    const idx = questionCancelHandlers.indexOf(handler);
    if (idx >= 0) questionCancelHandlers.splice(idx, 1);
  };
}

export function onBrowserApprovalAsk(handler: BrowserApprovalAskHandler): () => void {
  browserApprovalAskHandlers.push(handler);
  return () => {
    const idx = browserApprovalAskHandlers.indexOf(handler);
    if (idx >= 0) browserApprovalAskHandlers.splice(idx, 1);
  };
}

export function onBrowserApprovalDone(handler: BrowserApprovalDoneHandler): () => void {
  browserApprovalDoneHandlers.push(handler);
  return () => {
    const idx = browserApprovalDoneHandlers.indexOf(handler);
    if (idx >= 0) browserApprovalDoneHandlers.splice(idx, 1);
  };
}

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

export function onBrowserAttachmentUpload(handler: BrowserAttachmentUploadHandler): () => void {
  browserAttachmentUploadHandlers.push(handler);
  return () => {
    const idx = browserAttachmentUploadHandlers.indexOf(handler);
    if (idx >= 0) browserAttachmentUploadHandlers.splice(idx, 1);
  };
}

function clearStoredAuth(): Promise<void> {
  return new Promise(resolve => {
    chrome.storage.local.remove(["authToken", "apiUrl", "authPort"], () => resolve());
  });
}

function apiEndpoint(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/+$/, "")}${path}`;
}

function bgFetch(url: string, options?: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: "FETCH", url, options }, result => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, status: 0, body: chrome.runtime.lastError.message || "" });
          return;
        }
        resolve(result || { ok: false, status: 0, body: "" });
      });
    } catch (error) {
      resolve({ ok: false, status: 0, body: String(error) });
    }
  });
}

async function verifyStoredAuth(info: { apiUrl: string; token: string }): Promise<"valid" | "unauthorized" | "unknown"> {
  const response = await bgFetch(apiEndpoint(info.apiUrl, "/stats"), {
    headers: { Authorization: `Bearer ${info.token}` }
  });
  if (response.status === 401) return "unauthorized";
  if (response.ok) return "valid";
  return "unknown";
}

async function connectWithStoredAuth(info: { apiUrl: string; token: string }) {
  const authState = await verifyStoredAuth(info);
  if (authState === "unauthorized") {
    console.log("[PierCode] 保存的认证信息已失效，清空缓存并停止 WebSocket 重连");
    await clearStoredAuth();
    disconnectWebSocket("not_configured");
    return;
  }
  const current = await getAuthInfo();
  if (!current) {
    disconnectWebSocket("not_configured");
    return;
  }
  if (current.apiUrl !== info.apiUrl || current.token !== info.token) {
    return;
  }
  connectWebSocket(info.apiUrl, info.token);
}

function toWebSocketUrl(apiUrl: string, token: string): string | null {
  try {
    const url = new URL(apiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.searchParams.set("token", token);
    url.searchParams.set("id", PAGE_CLIENT_ID);
    url.searchParams.set("client", "content");
    url.searchParams.set("role", "ai-page");
    url.searchParams.set("provider", currentProvider());
    url.searchParams.set("host", location.hostname);
    return url.toString();
  } catch {
    return null;
  }
}

function sameAuthInfo(info: { apiUrl: string; token: string } | null): boolean {
  return !!info && info.apiUrl === configuredApiUrl && info.token === configuredToken;
}

function disconnectWebSocket(state: BridgeState = 'not_configured') {
  connectionSeq++;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const current = ws;
  ws = null;
  if (current) {
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    try { current.close(); } catch {}
  }
  configuredApiUrl = '';
  configuredToken = '';
  setBridgeStatus(state, '');
}

function currentProvider(): string {
  const h = location.hostname.toLowerCase();
  if (h.includes("qwen.ai") || h.includes("qwenlm.ai")) return "Qwen";
  if (h.includes("claude.ai") || h.includes("free.easychat.top")) return "Claude";
  if (h.includes("chatgpt.com") || h.includes("chat.openai.com")) return "ChatGPT";
  if (h.includes("aistudio.xiaomimimo.com")) return "MiMo";
  if (h.includes("gemini.google.com")) return "Gemini";
  if (h.includes("aistudio.google.com")) return "AI Studio";
  if (h.includes("kimi.com")) return "Kimi";
  if (h.includes("chat.z.ai")) return "Z.ai";
  return "Browser";
}

function isQwenPage(): boolean {
  const h = location.hostname.toLowerCase();
  return h.includes("qwen.ai") || h.includes("qwenlm.ai");
}

async function focusCurrentTabForSend(): Promise<void> {
  if (!isQwenPage()) return;
  try {
    await chrome.runtime.sendMessage({ type: "FOCUS_SELF", forceFocus: false });
    await new Promise(resolve => window.setTimeout(resolve, 150));
  } catch (error) {
    console.warn("[PierCode] 激活 Qwen 标签页失败，继续尝试发送:", error);
  }
}

// redactWsUrl 把 ?token=... 替换成 ?token=<前4>…<后4>，用于日志输出。
// 短 token（≤8 字符）整体掩成 ***，避免短弱 token 的元信息也外泄。
function redactWsUrl(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    const t = u.searchParams.get("token") || "";
    if (t) {
      const masked = t.length <= 8 ? "***" : `${t.slice(0, 4)}…${t.slice(-4)}`;
      u.searchParams.set("token", masked);
    }
    return u.toString();
  } catch {
    return "[ws url]";
  }
}

function getInjectConfig(): InjectConfig {
  const h = location.hostname;
  if (h.includes("qwen.ai") || h.includes("qwenlm.ai")) {
    return {
      editor: [
        "textarea[class*='MessageInput__TextArea']",
        "textarea.message-input-textarea",
        "textarea[placeholder*='Qwen']",
        "textarea[placeholder*='Send']",
        "textarea[placeholder*='输入']",
        "[contenteditable='true']"
      ].join(","),
      sendBtn: [
        "div[class*='MessageInput__Submit']:not([aria-disabled='true'])",
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
  if (h.includes("claude.ai") || h.includes("free.easychat.top")) {
    return {
      editor: [
        "div[contenteditable='true'][data-testid='chat-input']",
        "div.ProseMirror[contenteditable='true'][aria-label*='Claude']",
        "div.ProseMirror[contenteditable='true']"
      ].join(","),
      sendBtn: [
        "button[data-testid='send-button']:not([disabled])",
        "button[aria-label*='Send']:not([disabled])",
        "button[aria-label*='发送']:not([disabled])"
      ].join(","),
      fillMethod: "execCommand"
    };
  }
  if (h.includes("chatgpt.com") || h.includes("chat.openai.com")) {
    return {
      editor: [
        "div#prompt-textarea.ProseMirror[contenteditable='true']",
        "div#prompt-textarea[contenteditable='true']",
        "div.ProseMirror[contenteditable='true'][aria-label*='ChatGPT']",
        "textarea[name='prompt-textarea']"
      ].join(","),
      sendBtn: [
        "button[data-testid='send-button']:not([disabled])",
        "button[aria-label*='Send']:not([disabled])",
        "button[aria-label*='发送']:not([disabled])",
        "button[aria-label*='提交']:not([disabled])"
      ].join(","),
      fillMethod: "execCommand"
    };
  }
  if (h.includes("gemini.google.com")) {
    return {
      editor: "div.ql-editor[contenteditable='true'], [contenteditable='true']",
      sendBtn: "button.send-button[aria-label*='发送']:not([disabled]), button.send-button[aria-label*='Send']:not([disabled])",
      fillMethod: "execCommand"
    };
  }
  if (h.includes("aistudio.xiaomimimo.com")) {
    return {
      editor: "textarea",
      sendBtn: "button[data-track-id='home_send_btn']",
      fillMethod: "value"
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
    console.warn("[PierCode] WebSocket URL 无效:", apiUrl);
    setBridgeStatus('invalid_url', apiUrl);
    return;
  }
  // 不要打印完整 wsUrl —— 它带 ?token=... ，落到 DevTools console / 录屏 /
  // 用户报错截图都是泄露面。脱敏成 host:port + token 首尾。
  console.log("[PierCode] WebSocket 连接中...", redactWsUrl(wsUrl));
  setBridgeStatus('connecting', apiUrl);

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("[PierCode] ✅ WebSocket 已连接");
      setBridgeStatus('open', apiUrl);
      window.dispatchEvent(new CustomEvent("PIERCODE_BACKEND_CONNECTED"));
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
        } else if (msg.type === "tool_stream" && typeof msg.text === "string") {
          for (const handler of streamHandlers.slice()) {
            try { handler(msg as ToolStreamMessage); } catch (e) { console.error(e); }
          }
        } else if (msg.type === "tool_done") {
          for (const handler of doneHandlers.slice()) {
            try { handler(msg as ToolDoneMessage); } catch (e) { console.error(e); }
          }
        } else if (msg.type === "question_ask" && typeof msg.call_id === "string") {
          for (const handler of questionAskHandlers.slice()) {
            try { handler(msg as QuestionAskMessage); } catch (e) { console.error(e); }
          }
        } else if (msg.type === "question_cancel" && typeof msg.call_id === "string") {
          for (const handler of questionCancelHandlers.slice()) {
            try { handler(msg as QuestionCancelMessage); } catch (e) { console.error(e); }
          }
        } else if (msg.type === "browser_approval_ask" && typeof msg.approval_id === "string") {
          for (const handler of browserApprovalAskHandlers.slice()) {
            try { handler(msg as BrowserApprovalAskMessage); } catch (e) { console.error(e); }
          }
        } else if (msg.type === "browser_approval_done" && typeof msg.approval_id === "string") {
          for (const handler of browserApprovalDoneHandlers.slice()) {
            try { handler(msg as BrowserApprovalDoneMessage); } catch (e) { console.error(e); }
          }
        } else if (msg.type === "browser_attachment_upload" && typeof msg.call_id === "string") {
          for (const handler of browserAttachmentUploadHandlers.slice()) {
            try { handler(msg as BrowserAttachmentUploadMessage); } catch (e) { console.error(e); }
          }
        }
      } catch (e) {
        console.error("[PierCode] 解析 WebSocket 消息失败:", e);
      }
    };

    ws.onclose = (e) => {
      console.warn("[PierCode] ⚠️ WebSocket 连接已关闭:", e.reason);
      ws = null;
      if (seq !== connectionSeq) return;
      setBridgeStatus('closed', apiUrl);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        getAuthInfo().then(async (info) => {
          if (!info) {
            console.log("[PierCode] 认证信息已清空，停止旧 WebSocket 重连");
            disconnectWebSocket('not_configured');
            return;
          }
          if (!sameAuthInfo(info)) {
            console.log("[PierCode] 认证信息已变更或清空，停止旧 WebSocket 重连");
            disconnectWebSocket('closed');
            connectWithStoredAuth(info);
            return;
          }
          const authState = await verifyStoredAuth(info);
          if (authState === "unauthorized") {
            console.log("[PierCode] 保存的认证信息已失效，清空缓存并停止 WebSocket 重连");
            await clearStoredAuth();
            disconnectWebSocket("not_configured");
            return;
          }
          console.log("[PierCode] 🔄 正在尝试重新连接 WebSocket...");
          connectWebSocket(info.apiUrl, info.token);
        });
      }, 3000);
    };

    ws.onerror = (err) => {
      console.error("[PierCode] ❌ WebSocket 发生错误:", err);
      setBridgeStatus('error', apiUrl);
      ws?.close();
    };
  } catch (e) {
    console.error("[PierCode] 创建 WebSocket 失败:", e);
    setBridgeStatus('error', apiUrl);
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
async function handleInjectMessage(text: string) {
  console.log("[PierCode] 收到注入消息:", text);
  const cleanText = sanitizeInjectedText(text);
  if (!cleanText) {
    console.warn("[PierCode] 注入内容为空，已跳过");
    return;
  }
  await focusCurrentTabForSend();
  const config = getInjectConfig();
  const targetInput = querySelectorFirst(config.editor);

  if (!targetInput) {
    console.warn("[PierCode] 未找到当前页面的聊天输入框");
    return;
  }

  fillTargetInput(targetInput, cleanText, config.fillMethod);
  window.dispatchEvent(new CustomEvent("PIERCODE_PROMPT_SUBMITTED", { detail: cleanText }));
  window.setTimeout(() => clickSendButton(config, targetInput), 100);

  console.log("[PierCode] ✅ 内容已注入并提交到输入框");
}

export function sendAIResponseLog(key: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed || !ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "ai_log", key, text: trimmed }));
  } catch (error) {
    console.warn("[PierCode] AI 响应日志回传失败:", error);
  }
}

export function sendUserPromptLog(key: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed || !ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "user_log", key, text: trimmed }));
  } catch (error) {
    console.warn("[PierCode] 用户输入日志回传失败:", error);
  }
}

// sendQuestionAnswer routes a user's answer to a pending `question` tool call
// back to the Go server, which dispatches it to the blocked tool goroutine.
export function sendQuestionAnswer(callID: string, answer: string): boolean {
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		console.warn("[PierCode] WebSocket 未连接，无法回答 question");
		return false;
	}
  try {
    ws.send(JSON.stringify({ type: "question_answer", call_id: callID, answer }));
    return true;
  } catch (error) {
    console.warn("[PierCode] question_answer 发送失败:", error);
    return false;
	}
}

// sendQuestionCancel tells the Go server to unblock a pending `question`
// invocation as canceled instead of waiting for timeout.
export function sendQuestionCancel(callID: string, reason = "user_cancelled"): boolean {
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		console.warn("[PierCode] WebSocket 未连接，无法取消 question");
		return false;
	}
	try {
		ws.send(JSON.stringify({ type: "question_cancel", call_id: callID, reason }));
		return true;
	} catch (error) {
		console.warn("[PierCode] question_cancel 发送失败:", error);
		return false;
	}
}

export function sendBrowserApprovalAnswer(approvalID: string, approved: boolean, reason = ""): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("[PierCode] WebSocket 未连接，无法发送 browser approval");
    return false;
  }
  if (answeredBrowserApprovals.has(approvalID)) return true;
  try {
    ws.send(JSON.stringify({ type: "browser_approval_answer", approval_id: approvalID, approved, reason }));
    answeredBrowserApprovals.add(approvalID);
    return true;
  } catch (error) {
    console.warn("[PierCode] browser_approval_answer 发送失败:", error);
    return false;
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
      connectWithStoredAuth(info);
    } else {
      setBridgeStatus('not_configured');
      console.log("[PierCode] 等待认证配置... (将在认证后自动连接)");
    }
  });

  // 监听存储变化，以便在认证后立即连接
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && (changes.apiUrl || changes.authToken || changes.authPort)) {
      getAuthInfo().then((info) => {
        if (info) {
          console.log("[PierCode] 检测到认证信息变更，重新连接 WebSocket");
          connectWithStoredAuth(info);
        } else {
          console.log("[PierCode] 认证信息已清空，停止 WebSocket 重连");
          disconnectWebSocket('not_configured');
        }
      });
    }
  });
}

export function sendBrowserAttachmentUploadResult(callID: string, ok: boolean, error = ""): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("[PierCode] WebSocket 未连接，无法发送 attachment upload result");
    return false;
  }
  try {
    ws.send(JSON.stringify({ type: "browser_attachment_upload_result", call_id: callID, ok, error }));
    return true;
  } catch (err) {
    console.warn("[PierCode] attachment upload result 发送失败:", err);
    return false;
  }
}
