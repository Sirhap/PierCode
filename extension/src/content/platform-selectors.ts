// platform-selectors.ts — single source of truth for the per-platform DOM
// selectors (editor / send / stop controls), the input fill strategy, and the
// default response container. These used to be scattered across an
// if/hostname.includes() chain in content/index.ts; centralizing them here means
// a platform UI change touches only this table, not the content-script logic.
//
// content-only leaf: imported by content/index.ts (a classic MV3 content script),
// so it must NOT import from ../settings or any non-content module. Pure data +
// a host resolver — no DOM access, no side effects.

export type FillMethod = 'paste' | 'execCommand' | 'value' | 'prosemirror';

export interface PlatformSelectors {
  // CSS selector(s) for the chat input editor.
  editor: string;
  // CSS selector(s) for the "send / submit" control.
  sendBtn: string;
  // CSS selector(s) for the "stop generating" control, or null when CSS can't
  // distinguish the stop state (AI Studio's Run/Stop share a button, told apart
  // only by text content). null means: use a special stopBtnMatch callback,
  // which lives in content/index.ts because it needs DOM helpers.
  stopBtn: string | null;
  // How tool results are written into the editor.
  fillMethod: FillMethod;
  // DEFAULT response container selector. The adapter's responseSelector override
  // (adapterSelector || base.responseSelector) is applied in content/index.ts.
  responseSelector: string;
}

// PLATFORM_SELECTORS — keyed by platform id. Values copied verbatim from the
// original getSiteConfig() chain in content/index.ts (do not paraphrase: a wrong
// selector silently breaks a platform).
export const PLATFORM_SELECTORS: Record<string, PlatformSelectors> = {
  kimi: {
    editor: 'div.chat-input-editor[contenteditable="true"]',
    sendBtn: 'div.send-button-container',
    stopBtn: '.send-button-container.stop, .send-button-container[class*="stop"]',
    fillMethod: 'execCommand',
    responseSelector: '.segment-assistant',
  },
  chatz: {
    editor: 'textarea#chat-input',
    sendBtn: 'button#send-message-button',
    // Chat Z 生成态：方块停止按钮的 class 全是 Tailwind（易变），但外层包了
    // 稳定的 div[aria-label="停止"]。用它定位内部 button；兼容英文 aria-label="Stop"。
    stopBtn: 'div[aria-label="停止"] button, div[aria-label="Stop"] button',
    fillMethod: 'value',
    responseSelector: '#response-content-container',
  },
  claude: {
    editor: 'div[contenteditable="true"][data-testid="chat-input"], div.ProseMirror[contenteditable="true"][aria-label*="Claude"], div.ProseMirror[contenteditable="true"]',
    sendBtn: 'button[data-testid="send-button"]:not([disabled]), button[aria-label*="Send"]:not([disabled]), button[aria-label*="发送"]:not([disabled])',
    stopBtn: 'button[aria-label="Stop response"], button[aria-label*="Stop response"]',
    fillMethod: 'execCommand',
    responseSelector: '.font-claude-response',
  },
  chatgpt: {
    editor: 'div#prompt-textarea.ProseMirror[contenteditable="true"], div#prompt-textarea[contenteditable="true"], div.ProseMirror[contenteditable="true"][aria-label*="ChatGPT"], textarea[name="prompt-textarea"]',
    sendBtn: 'button[data-testid="send-button"]:not([disabled]), button[aria-label*="Send"]:not([disabled]), button[aria-label*="发送"]:not([disabled]), button[aria-label*="提交"]:not([disabled])',
    stopBtn: 'button[data-testid="stop-button"]',
    fillMethod: 'execCommand',
    responseSelector: '[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"]',
  },
  gemini: {
    editor: 'div.ql-editor[contenteditable="true"]',
    sendBtn: 'button.send-button[aria-label*="发送"], button.send-button[aria-label*="Send"]',
    stopBtn: 'button[aria-label="停止回答"], button[aria-label*="停止回答"], button[aria-label*="Stop response"], button[aria-label*="Stop generating"]',
    fillMethod: 'execCommand',
    responseSelector: 'model-response, .model-response-text, message-content',
  },
  qwen: {
    editor: [
      'textarea[class*="MessageInput__TextArea"]',
      'textarea.message-input-textarea',
      'textarea[placeholder*="Qwen"]',
      'textarea[placeholder*="Send"]',
      'textarea[placeholder*="输入"]',
      '[contenteditable="true"]',
    ].join(','),
    sendBtn: [
      'div[class*="MessageInput__Submit"]:not([aria-disabled="true"])',
      'button.send-button:not([disabled])',
      'button[aria-label*="发送"]:not([disabled])',
      'button[aria-label*="Send"]:not([disabled])',
    ].join(','),
    // 结束后停止按钮仍在但带 disabled（class 与/或属性）。用 :not([disabled])
    // 排除已结束态，避免被误判为"仍在生成"而永不提交。
    stopBtn: 'button.stop-button:not([disabled]):not(.disabled)',
    fillMethod: 'value',
    responseSelector: '.qwen-chat-message-assistant',
  },
  mimo: {
    editor: 'textarea',
    sendBtn: 'button[data-track-id="home_send_btn"]',
    // Mimo 发送态与停止态共用同一 button[data-track-id="home_send_btn"]，
    // 仅内部 SVG 不同：发送=纸飞机 viewBox="0 0 19 16"，停止=方块
    // viewBox="0 0 24 24"。必须靠 :has() 区分，否则发送态会被误判为生成中
    // 而导致工具结果永不提交。
    stopBtn: 'button[data-track-id="home_send_btn"]:has(svg[viewBox="0 0 24 24"])',
    fillMethod: 'value',
    responseSelector: '.markdown-prose',
  },
  // Default / fallback: Google AI Studio (aistudio.google.com).
  // AI Studio 的 Run/Stop 共用 ms-run-button 内的同一 button（type="button"，非
  // submit），仅文本区分：非生成态 "Run"，生成态含 "Stop"。CSS 无法表达"含 Stop
  // 文本"，因此 stopBtn=null，由 content/index.ts 挂上 stopBtnMatch 回调。
  aistudio: {
    editor: 'textarea[placeholder*="Start typing a prompt"]',
    sendBtn: 'ms-run-button button.ctrl-enter-submits, button.ctrl-enter-submits.ms-button-primary, button[aria-label*="Run"]',
    stopBtn: null,
    fillMethod: 'value',
    responseSelector: 'ms-chat-turn',
  },
};

// selectorsForHost resolves a hostname to its platform config. The match order
// MIRRORS the original getSiteConfig() if-chain EXACTLY — order matters because
// some platforms share host fragments and the first match wins. No match falls
// through to aistudio (the original chain's default branch).
export function selectorsForHost(host: string): PlatformSelectors {
  if (host.includes('kimi.com')) return PLATFORM_SELECTORS.kimi;
  if (host.includes('chat.z.ai')) return PLATFORM_SELECTORS.chatz;
  if (host.includes('claude.ai') || host.includes('free.easychat.top')) return PLATFORM_SELECTORS.claude;
  if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) return PLATFORM_SELECTORS.chatgpt;
  if (host.includes('gemini.google.com')) return PLATFORM_SELECTORS.gemini;
  if (host.includes('qwen.ai') || host.includes('qwenlm.ai')) return PLATFORM_SELECTORS.qwen;
  if (host.includes('aistudio.xiaomimimo.com') || host.includes('ultraspeed.xiaomimimo.com')) return PLATFORM_SELECTORS.mimo;
  // Default: AI Studio (aistudio.google.com and anything else).
  return PLATFORM_SELECTORS.aistudio;
}
