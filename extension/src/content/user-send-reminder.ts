// ── 用户消息系统提示追加 ──────────────────────────────────────────────────────
// 工具结果的 operating reminder 由服务端追加（executor.appendPromptGuidance）；
// 用户手动输入的消息不经过 /exec，这里在"点击发送 / 回车"那一刻同步把同一段
// 提醒文字（GET /guidance）追加进编辑器，使每条用户消息也携带协议提醒。
// 程序化发送（工具结果回填、worker 自动提交）通过 markProgrammaticSend 跳过。
//
// content leaf 模块：不 import index.ts / settings.ts，所有对 index 内部
// helper 的依赖经 UserSendReminderDeps 注入，保持 content.js classic bundle
// 约束并避免循环引用。模块级状态自含。

export interface UserSendReminderDeps {
  /** 当前平台的 editor/sendBtn 选择器与填充方式（index.ts getSiteConfig 子集）。 */
  getSiteConfig(): { editor: string; sendBtn: string; fillMethod: string };
  querySelectorFirst(selectors: string): HTMLElement | null;
  findEditorFromTarget(target: HTMLElement | null): HTMLElement | null;
  getEditorText(el: HTMLElement): string;
  effectiveFillMethod(el: HTMLElement, configuredFillMethod: string): string;
  getNativeSetter(): ((this: unknown, value: string) => void) | null | undefined;
  /** worker 页（后台 agent tab）返回 agent id；普通页返回 null。 */
  workerAgentId(): string | null;
  checkContext(): boolean;
  /** 从服务端取 operating reminder 文本；失败返回空串。 */
  fetchReminderText(): Promise<string>;
}

let deps: UserSendReminderDeps | null = null;
let userSendReminder = '';
let userSendReminderEnabled = true;
// 总开关：关掉后既不给用户消息追加提醒，也让 index 把所有工具调用标记
// with_guidance=false（服务端 GuidanceEnabled() 为假即不追加任何提醒）。
let systemReminderMasterEnabled = true;
let suppressUserSendAppendUntil = 0;

/** 程序化发送（clickSendWhenReady / Enter 兜底）前调用，跳过随后的追加。 */
export function markProgrammaticSend(windowMs = 3000): void {
  suppressUserSendAppendUntil = Date.now() + windowMs;
}

/** withPlatformProfile 用：总开关关闭时所有调用一律 with_guidance=false。 */
export function isSystemReminderEnabled(): boolean {
  return systemReminderMasterEnabled;
}

async function refreshUserSendReminder(): Promise<void> {
  if (!deps || !deps.checkContext()) return;
  try {
    const { appendUserSendReminder, systemReminderEnabled } = await chrome.storage.local.get(['appendUserSendReminder', 'systemReminderEnabled']);
    systemReminderMasterEnabled = systemReminderEnabled !== false;
    userSendReminderEnabled = appendUserSendReminder !== false && systemReminderMasterEnabled;
    if (!userSendReminderEnabled) return;
    const text = await deps.fetchReminderText();
    if (text) userSendReminder = text;
    console.info('[PierCode] 用户发送提醒已就绪:', userSendReminder.length, '字符');
  } catch (err) {
    // 拿不到提醒文本时静默跳过追加，不影响发送。
    console.warn('[PierCode] 用户发送提醒获取失败:', err);
  }
}

function appendUserSendReminderIfNeeded(): void {
  if (!deps) return;
  if (!userSendReminder || !userSendReminderEnabled) {
    console.info('[PierCode] 发送提醒跳过: 文本未就绪或已禁用', { len: userSendReminder.length, enabled: userSendReminderEnabled });
    return;
  }
  if (Date.now() < suppressUserSendAppendUntil) return;
  if (deps.workerAgentId()) return; // worker 页全部是程序化发送
  const siteConfig = deps.getSiteConfig();
  const editor = deps.querySelectorFirst(siteConfig.editor);
  if (!editor) return;
  const current = deps.getEditorText(editor);
  if (!current.trim()) return;
  // 已带提醒（如工具结果回填后的编辑器内容）不重复追加。
  if (current.includes('[系统提示]')) return;

  const method = deps.effectiveFillMethod(editor, siteConfig.fillMethod);
  if (method === 'value') {
    const ta = editor as HTMLTextAreaElement;
    const setter = deps.getNativeSetter();
    const next = ta.value + userSendReminder;
    if (setter) setter.call(ta, next);
    else ta.value = next;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (method === 'paste') {
    const dt = new DataTransfer();
    dt.setData('text/plain', userSendReminder);
    editor.focus();
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  } else if (method === 'execCommand') {
    editor.focus();
    const sel = window.getSelection();
    if (sel) {
      sel.selectAllChildren(editor);
      sel.collapseToEnd();
    }
    document.execCommand('insertText', false, userSendReminder);
  } else if (method === 'prosemirror') {
    editor.textContent = editor.innerText + userSendReminder;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  }
  console.info('[PierCode] 已向用户消息追加系统提示 (method=' + method + ')');
}

export function installUserSendReminder(d: UserSendReminderDeps): void {
  deps = d;
  void refreshUserSendReminder();
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === 'local' && (changes.apiUrl || changes.authToken || changes.appendUserSendReminder || changes.systemReminderEnabled)) {
        void refreshUserSendReminder();
      }
    });
  } catch {
    // storage 监听不可用时仅用启动时的快照。
  }
  // 用 pointerdown/mousedown（capture）而非 click：追加发生在 click 前一个事件，
  // 站点框架（React/Vue 异步批处理 state）有微任务窗口把 input 事件产生的状态
  // 更新刷进内部 state，click 发送 handler 读到的才是带提醒的内容。若直接挂
  // click capture，同一事件内 "改 value→派发 input→站点 handler 读 state" 可能
  // 读到旧值（qwen 实测如此）。重复触发由 appendUserSendReminderIfNeeded 内的
  // [系统提示] 去重挡住。
  const onSendPress = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target || !deps) return;
    const hit = deps.getSiteConfig().sendBtn.split(',').map(s => s.trim()).filter(Boolean)
      .some(sel => { try { return !!target.closest(sel); } catch { return false; } });
    if (hit) appendUserSendReminderIfNeeded();
  };
  document.addEventListener('pointerdown', onSendPress, true);
  document.addEventListener('mousedown', onSendPress, true);
  document.addEventListener('click', onSendPress, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if (!deps?.findEditorFromTarget(e.target as HTMLElement | null)) return;
    appendUserSendReminderIfNeeded();
  }, true);
  console.info('[PierCode] 用户发送提醒拦截已安装');
}
