// ws-linker.ts: 负责与 PierCode 后端建立 WebSocket 连接并处理输入注入

import { getCanonicalConversationURL, isConversationURLForCurrentPage, observeConversationURL } from './conversation-scope';

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let configuredApiUrl = '';
let configuredToken = '';
let connectionSeq = 0;
const PAGE_CLIENT_ID = getOrCreateClientId();
// Worker pages persist their agent id here so it survives the AI site's SPA
// rewriting location.search (e.g. claude.ai/new -> /chat/<uuid>).
const WORKER_AGENT_STORAGE_KEY = "__PIERCODE_WORKER_AGENT__";

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
  client_id?: string;
  conversation_url?: string;
  stream: 'stdout' | 'stderr';
  text: string;
};

export type ToolDoneMessage = {
  type: 'tool_done';
  task_id?: string;
  call_id?: string;
  client_id?: string;
  conversation_url?: string;
  exit_code: number;
  status: string;
  error?: string;
  duration_ms: number;
};

export type QuestionAskMessage = {
  type: 'question_ask';
  call_id: string;
  client_id?: string;
  conversation_url?: string;
  question: string;
  options?: unknown[];
};

export type QuestionCancelMessage = {
  type: 'question_cancel';
  call_id: string;
  client_id?: string;
  conversation_url?: string;
  reason?: string;
};

export type BrowserApprovalAskMessage = {
  type: 'browser_approval_ask';
  approval_id: string;
  call_id?: string;
  client_id?: string;
  conversation_url?: string;
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
  client_id?: string;
  conversation_url?: string;
};

export type BrowserAttachmentUploadMessage = {
  type: 'browser_attachment_upload';
  call_id: string;
  client_id?: string;
  conversation_url?: string;
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
type PendingInject = { text: string; awaitReady: boolean; conversationURL?: string };
const pendingInjects: PendingInject[] = [];
let conversationURLWatcher: number | null = null;

function getOrCreateClientId(): string {
  // MUST be unique PER DOCUMENT/FRAME. sessionStorage is SHARED across
  // same-origin frames in the same tab, so keying the id on a constant string
  // there made two same-origin Hub panes (e.g. a qwen dispatcher + a qwen worker
  // iframe) read the SAME client id → the server's SendToID(workerClient) ALSO
  // matched the dispatcher, so the worker's seed task was injected into the main
  // agent too ("给子agent的任务主agent也发了一份"). Generate the id fresh per
  // module instance instead: every iframe runs its own content.js module, so each
  // gets a distinct id. It persists for the life of the document (survives MV3 SW
  // sleep, which does not reload the frame); a full reload gets a new id, which is
  // fine — the server just sees a reconnecting client. Persist it on `window` so
  // repeated imports within the same document return the same value.
  const w = window as any;
  if (typeof w.__PIERCODE_CLIENT_ID_VALUE__ === 'string') return w.__PIERCODE_CLIENT_ID_VALUE__;
  const id = `content-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try { w.__PIERCODE_CLIENT_ID_VALUE__ = id; } catch { /* ignore */ }
  return id;
}

export function getPierCodeClientId(): string {
  return PAGE_CLIENT_ID;
}

function isForThisClient(msg: { client_id?: string }): boolean {
  return !msg.client_id || msg.client_id === PAGE_CLIENT_ID;
}

function isForThisPage(msg: { client_id?: string; conversation_url?: string }): boolean {
  return isForThisClient(msg) && isConversationURLForCurrentPage(msg.conversation_url);
}

function queuePendingInject(text: string, awaitReady: boolean, conversationURL?: string) {
  pendingInjects.push({ text, awaitReady, conversationURL });
  if (pendingInjects.length > 20) pendingInjects.splice(0, pendingInjects.length - 20);
}

function flushPendingInjects() {
  for (let i = 0; i < pendingInjects.length;) {
    const item = pendingInjects[i];
    if (!isConversationURLForCurrentPage(item.conversationURL)) {
      i++;
      continue;
    }
    pendingInjects.splice(i, 1);
    void handleInjectMessage(item.text, item.awaitReady);
  }
}

function startConversationURLWatcher() {
  if (conversationURLWatcher !== null) return;
  observeConversationURL();
  conversationURLWatcher = window.setInterval(() => {
    const before = getCanonicalConversationURL();
    const after = observeConversationURL();
    if (before !== after || pendingInjects.length) flushPendingInjects();
  }, 500);
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
    // Worker pages carry ?piercode_agent=<id> in their own URL (spawn_agent
    // encoded it). Forward it so the server can bind this page to its agent
    // record and seed the task.
    const agentId = workerAgentId();
    if (agentId) url.searchParams.set("agent", agentId);
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

// workerAgentId reads the agent id spawn_agent encoded into this worker tab's
// URL. AI sites are SPAs that rewrite/strip the query on load (e.g.
// claude.ai/new -> /chat/<uuid>), so the id is captured into sessionStorage on
// the first read and recovered from there afterward. Empty for ordinary pages.
let cachedWorkerAgentId: string | null = null;
export function workerAgentId(): string {
  if (cachedWorkerAgentId !== null) return cachedWorkerAgentId;
  let id = "";
  try {
    id = new URLSearchParams(location.search).get("piercode_agent") || "";
  } catch {
    id = "";
  }
  try {
    if (id) {
      window.sessionStorage.setItem(WORKER_AGENT_STORAGE_KEY, id);
    } else {
      id = window.sessionStorage.getItem(WORKER_AGENT_STORAGE_KEY) || "";
    }
  } catch {
    // sessionStorage unavailable (rare); fall back to whatever the URL gave us.
  }
  cachedWorkerAgentId = id;
  return cachedWorkerAgentId;
}

// Capture the agent id now, at module load — the earliest point — before any SPA
// route change can strip the query. Persisted to sessionStorage so later reads
// recover it even after the URL changes. Declared after workerAgentId and its
// backing vars to avoid a TDZ ReferenceError at module init.
workerAgentId();

// activateSelfTabForInject brings this tab to the foreground so a server-driven
// inject can reliably fill (execCommand needs real focus) and click send. Used
// for all inject types incl. the coordinator callback, regardless of platform.
async function activateSelfTabForInject(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "FOCUS_SELF", forceFocus: true });
    await new Promise(resolve => window.setTimeout(resolve, 150));
  } catch (error) {
    console.warn("[PierCode] inject 前激活标签页失败，继续尝试:", error);
  }
}

async function focusCurrentTabForSend(): Promise<void> {
  // Worker tabs live in the background; filling a contenteditable via execCommand
  // needs document focus, so a worker must activate its own tab before the seed /
  // follow-up inject. Qwen also needs activation for its send flow.
  if (!isQwenPage() && !workerAgentId()) return;
  try {
    await chrome.runtime.sendMessage({ type: "FOCUS_SELF", forceFocus: true });
    await new Promise(resolve => window.setTimeout(resolve, 150));
  } catch (error) {
    console.warn("[PierCode] 激活标签页失败，继续尝试发送:", error);
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

function isActionableSendButton(el: HTMLElement): boolean {
  if (!isVisibleInput(el)) return false;
  const target = (el.closest("button") as HTMLElement | null) || el;
  if (target.getAttribute("aria-disabled") === "true") return false;
  if (target.hasAttribute("disabled")) return false;
  if ((target as HTMLButtonElement).disabled === true) return false;
  const className = target.getAttribute("class") || "";
  if (/\bdisabled\b/i.test(className)) return false;
  const disabledParent = target.closest('[aria-disabled="true"], [disabled], .disabled');
  return !disabledParent || disabledParent === target;
}

function querySendButtonFirst(selectors: string): HTMLElement | null {
  for (const selector of selectors.split(",").map(s => s.trim()).filter(Boolean)) {
    const elements = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    for (const el of elements) {
      if (isActionableSendButton(el)) return el;
    }
  }
  return null;
}

function connectWebSocket(apiUrl: string, token: string) {
  configuredApiUrl = apiUrl;
  configuredToken = token;
  const seq = ++connectionSeq;

  // Detach the old socket's handlers BEFORE closing it. Otherwise its async
  // onclose fires after we've assigned the new socket to the global `ws` and
  // runs `ws = null` (its closure references the global, not the old socket),
  // nulling out the freshly created connection. Every send() then sees ws ===
  // null and silently drops until the next reconnect.
  if (ws) {
    const old = ws;
    old.onopen = null;
    old.onmessage = null;
    old.onclose = null;
    old.onerror = null;
    try { old.close(); } catch {}
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
          if (!isForThisClient(msg)) return;
          if (!isConversationURLForCurrentPage(msg.conversation_url)) {
            queuePendingInject(msg.text, msg.await_ready === true, msg.conversation_url);
            return;
          }
          handleInjectMessage(msg.text, msg.await_ready === true);
        } else if (msg.type === "tool_stream" && typeof msg.text === "string") {
		  if (!isForThisPage(msg)) return;
          for (const handler of streamHandlers.slice()) {
            try { handler(msg as ToolStreamMessage); } catch (e) { console.error(e); }
          }
        } else if (msg.type === "tool_done") {
		  if (!isForThisPage(msg)) return;
          for (const handler of doneHandlers.slice()) {
            try { handler(msg as ToolDoneMessage); } catch (e) { console.error(e); }
          }
        } else if (msg.type === "question_ask" && typeof msg.call_id === "string") {
		  if (!isForThisPage(msg)) return;
          for (const handler of questionAskHandlers.slice()) {
            try { handler(msg as QuestionAskMessage); } catch (e) { console.error(e); }
          }
        } else if (msg.type === "question_cancel" && typeof msg.call_id === "string") {
		  if (!isForThisPage(msg)) return;
          for (const handler of questionCancelHandlers.slice()) {
            try { handler(msg as QuestionCancelMessage); } catch (e) { console.error(e); }
          }
        } else if (msg.type === "browser_approval_ask" && typeof msg.approval_id === "string") {
		  if (!isForThisPage(msg)) return;
          for (const handler of browserApprovalAskHandlers.slice()) {
            try { handler(msg as BrowserApprovalAskMessage); } catch (e) { console.error(e); }
          }
        } else if (msg.type === "browser_approval_done" && typeof msg.approval_id === "string") {
		  if (!isForThisPage(msg)) return;
          for (const handler of browserApprovalDoneHandlers.slice()) {
            try { handler(msg as BrowserApprovalDoneMessage); } catch (e) { console.error(e); }
          }
        } else if (msg.type === "browser_attachment_upload" && typeof msg.call_id === "string") {
		  if (!isForThisPage(msg)) return;
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

function sendInjectDebug(stage: string, detail: Record<string, unknown> = {}): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({
      type: "user_log",
      key: "worker-inject-debug",
      text: JSON.stringify({
        stage,
        agent_id: workerAgentId(),
        provider: currentProvider(),
        host: location.hostname,
        url: observeConversationURL(),
        ...detail,
      }),
      conversation_url: observeConversationURL(),
    }));
  } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function dispatchEnterAsSendFallback(targetInput: HTMLElement): boolean {
  targetInput.focus();
  const view = targetInput.ownerDocument.defaultView;
  const KeyboardEventCtor = view?.KeyboardEvent ?? KeyboardEvent;
  let handled = false;
  for (const type of ["keydown", "keypress", "keyup"]) {
    const event = new KeyboardEventCtor(type, {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    targetInput.dispatchEvent(event);
    handled = handled || event.defaultPrevented;
  }
  return handled;
}

// sendButtonDisabled reports whether a found send button is present-but-disabled.
// AI sites keep the send button mounted but disabled until the typed value is
// registered into their framework state (debounced after fill). Clicking it while
// disabled is a no-op — that is the "有时发有时不发" race: sometimes the fill has
// propagated by click time, sometimes not. So we treat a disabled button as
// not-yet-ready and keep polling.
function sendButtonDisabled(btn: HTMLElement): boolean {
  if (btn.hasAttribute("disabled")) return true;
  const aria = (btn.getAttribute("aria-disabled") || "").toLowerCase();
  if (aria === "true") return true;
  // Some sites disable a wrapping element; check the closest button too.
  const realBtn = btn.closest("button");
  if (realBtn && realBtn !== btn && (realBtn.hasAttribute("disabled") || (realBtn.getAttribute("aria-disabled") || "").toLowerCase() === "true")) return true;
  return false;
}

async function clickSendButton(config: InjectConfig, targetInput: HTMLElement): Promise<boolean> {
  const deadline = Date.now() + (isQwenPage() ? 90000 : 10000);
  while (Date.now() < deadline) {
    const sendBtn = querySendButtonFirst(config.sendBtn);
    if (sendBtn) {
      if (sendButtonDisabled(sendBtn)) {
        // Present but disabled — the value hasn't registered yet. Wait; do NOT
        // return true on a no-op click.
        await sleep(200);
        continue;
      }
      sendInjectDebug("click_send_button", {
        tag: sendBtn.tagName,
        class: sendBtn.getAttribute("class") || "",
        aria_disabled: sendBtn.getAttribute("aria-disabled") || "",
        disabled: sendBtn.hasAttribute("disabled"),
      });
      sendBtn.click();
      return true;
    }
    await sleep(250);
  }
  sendInjectDebug("enter_fallback");
  return dispatchEnterAsSendFallback(targetInput);
}

// waitForEditor polls for the chat input to mount, up to 30s. Used for worker
// seed injection into a freshly opened AI tab whose SPA is still hydrating.
async function waitForEditor(selectors: string): Promise<HTMLElement | null> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const el = querySelectorFirst(selectors);
    if (el) {
      // Editor present but the SPA may still be wiring input handlers; give it
      // a moment before filling so the value sticks.
      await new Promise(resolve => setTimeout(resolve, 800));
      return querySelectorFirst(selectors);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  console.warn("[PierCode] 30s 内未等到聊天输入框，放弃注入");
  return null;
}

// 处理注入消息：查找聊天输入框并填入内容。awaitReady 为 true 时（worker 种子
// 任务）轮询等待输入框 mount —— 新开的 AI tab SPA 还在 hydrate，输入框可能几秒
// 后才出现，固定延时会偶发丢种子。
async function handleInjectMessage(text: string, awaitReady = false) {
  console.log("[PierCode] 收到注入消息:", text);
  sendInjectDebug("received", { await_ready: awaitReady, length: text.length });
  const cleanText = sanitizeInjectedText(text);
  if (!cleanText) {
    console.warn("[PierCode] 注入内容为空，已跳过");
    sendInjectDebug("empty_after_sanitize");
    return;
  }
  // Server-driven injects (worker seed, compression handoff, and crucially the
  // coordinator's <task-notification> callback) must fill + auto-submit even when
  // the tab is in the background. execCommand-based fill needs real document
  // focus, which the visibility shim can't fake — so activate this tab regardless
  // of platform before injecting. Injects are deliberate and infrequent, so the
  // brief focus is acceptable.
  await activateSelfTabForInject();
  await focusCurrentTabForSend();
  const config = getInjectConfig();
  let targetInput = querySelectorFirst(config.editor);

  if (!targetInput && awaitReady) {
    sendInjectDebug("wait_editor_start");
    targetInput = await waitForEditor(config.editor);
  }

  if (!targetInput) {
    console.warn("[PierCode] 未找到当前页面的聊天输入框");
    sendInjectDebug("editor_not_found");
    return;
  }

  sendInjectDebug("editor_found", { tag: targetInput.tagName, class: targetInput.getAttribute("class") || "" });
  fillTargetInput(targetInput, cleanText, config.fillMethod);
  sendInjectDebug("filled", { length: cleanText.length });
  window.dispatchEvent(new CustomEvent("PIERCODE_PROMPT_SUBMITTED", { detail: cleanText }));
  await sleep(100);
  const sent = await clickSendButton(config, targetInput);
  if (!sent) {
    console.warn("[PierCode] 内容已注入，但未能确认发送按钮点击成功");
    sendInjectDebug("send_failed");
    return;
  }

  console.log("[PierCode] ✅ 内容已注入并提交到输入框");
  sendInjectDebug("send_reported_success");
}

export function sendAIResponseLog(key: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed || !ws || ws.readyState !== WebSocket.OPEN) return;
  try {
	    ws.send(JSON.stringify({ type: "ai_log", key, text: trimmed, conversation_url: observeConversationURL() }));
  } catch (error) {
    console.warn("[PierCode] AI 响应日志回传失败:", error);
  }
}

export function sendUserPromptLog(key: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed || !ws || ws.readyState !== WebSocket.OPEN) return;
  try {
	    ws.send(JSON.stringify({ type: "user_log", key, text: trimmed, conversation_url: observeConversationURL() }));
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
    ws.send(JSON.stringify({ type: "question_answer", call_id: callID, answer, conversation_url: observeConversationURL() }));
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
			ws.send(JSON.stringify({ type: "question_cancel", call_id: callID, reason, conversation_url: observeConversationURL() }));
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
	    ws.send(JSON.stringify({ type: "browser_approval_answer", approval_id: approvalID, approved, reason, conversation_url: observeConversationURL() }));
    answeredBrowserApprovals.add(approvalID);
    return true;
  } catch (error) {
    console.warn("[PierCode] browser_approval_answer 发送失败:", error);
    return false;
  }
}

// sendAgentResult routes a worker's result packet back to the Go server, which
// records it and delivers a <task-notification> to the dispatcher (coordinator)
// page. status/summary/result are parsed from the piercode-agent-result packet.
export function sendAgentResult(agentId: string, status: string, summary: string, result: string): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("[PierCode] WebSocket 未连接，无法回传 agent_result");
    return false;
  }
  try {
	    ws.send(JSON.stringify({ type: "agent_result", agent_id: agentId, status, summary, result, conversation_url: observeConversationURL() }));
    return true;
  } catch (error) {
    console.warn("[PierCode] agent_result 发送失败:", error);
    return false;
  }
}

// 初始化
export function initWsLinker() {
  startConversationURLWatcher();
  // Resolve the worker agent id BEFORE connecting the WS. The id is encoded in
  // the worker tab URL (?piercode_agent=<id>), but AI-site SPAs may strip the
  // query before this content script captures it — so the WS would connect
  // without ?agent=, the server would never bind/seed the worker, and the task
  // would never be typed into the input. As a durable fallback, ask the
  // background (which created the tab and parsed the id from the create URL)
  // for this tab's agent id and persist it before connecting.
  void ensureWorkerAgentIdResolved().finally(() => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => startConnection());
    } else {
      startConnection();
    }
  });
}

// ensureWorkerAgentIdResolved fills in the worker agent id from the background
// when the URL/sessionStorage didn't carry it. No-op (fast) for ordinary pages
// and for worker pages that already have the id.
async function ensureWorkerAgentIdResolved(): Promise<void> {
  if (workerAgentId()) return; // already known (URL or sessionStorage)
  try {
    const res = await new Promise<{ agentId?: string } | undefined>(resolve => {
      try {
        chrome.runtime.sendMessage({ type: "GET_WORKER_AGENT_ID" }, reply => {
          if (chrome.runtime.lastError) { resolve(undefined); return; }
          resolve(reply);
        });
      } catch { resolve(undefined); }
    });
    const id = (res?.agentId || "").trim();
    if (id) {
      try { window.sessionStorage.setItem(WORKER_AGENT_STORAGE_KEY, id); } catch {}
      cachedWorkerAgentId = id; // refresh the module cache so workerAgentId() returns it
      // Notify the content script: it may have already decided this was NOT a
      // worker page (URL query was stripped before index.ts read it) and skipped
      // worker behavior (force-autoExecute, activate session). Let it re-apply.
      try {
        window.dispatchEvent(new CustomEvent("PIERCODE_WORKER_AGENT_RESOLVED", { detail: id }));
      } catch {}
    }
  } catch {
    // background unreachable; fall back to whatever the URL gave us (possibly none)
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
	    ws.send(JSON.stringify({ type: "browser_attachment_upload_result", call_id: callID, ok, error, conversation_url: observeConversationURL() }));
    return true;
  } catch (err) {
    console.warn("[PierCode] attachment upload result 发送失败:", err);
    return false;
  }
}
