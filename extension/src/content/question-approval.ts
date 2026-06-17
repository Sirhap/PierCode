// 问答 / 浏览器操作审批弹窗（extracted from content/index.ts）。
//
// question 工具的远程提问、browser_* 写操作的用户审批，都渲染成输入框上方的
// 内联面板（showInlineQuestionPanel）。WS 应答直接走 ws-linker（leaf 安全）。
// 面板定位需要当前编辑器元素 —— 由 index.ts 经 initQuestionApprovalDeps 注入，
// 避免反向依赖 getSiteConfig。

import { T_PANEL, T_PANEL2, T_LINE, T_DIM, T_TXT, T_GLOW, T_GLOW_SOFT, T_AMBER, T_FONT } from './terminal-theme';
import { sendQuestionAnswer, sendQuestionCancel, sendBrowserApprovalAnswer } from './ws-linker';
import { showToast } from './toast';

let getEditorEl: () => HTMLElement | null = () => null;
export function initQuestionApprovalDeps(d: { getEditorEl: () => HTMLElement | null }): void {
  getEditorEl = d.getEditorEl;
}

function resolveAutoApproveBrowserActions(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

async function shouldAutoApproveBrowserActions(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get(['autoApproveBrowserActions']);
    return resolveAutoApproveBrowserActions(result.autoApproveBrowserActions);
  } catch {
    return false;
  }
}

const activeQuestionPopups = new Map<string, HTMLDivElement>();
const activeBrowserApprovalPopups = new Map<string, HTMLDivElement>();

export function showRemoteQuestionPopup(callID: string, question: string, options: unknown[]) {
  dismissRemoteQuestionPopup(callID);

  const panel = showInlineQuestionPanel({
    question,
    options,
    onSubmit: answer => {
      sendQuestionAnswer(callID, answer);
      dismissRemoteQuestionPopup(callID);
    },
    onCancel: () => {
      sendQuestionCancel(callID);
      dismissRemoteQuestionPopup(callID);
    },
  });
  panel.dataset.piercodeQuestionId = callID;
  activeQuestionPopups.set(callID, panel);
}

export function dismissRemoteQuestionPopup(callID: string) {
  const el = activeQuestionPopups.get(callID);
  if (!el) return;
  el.remove();
  activeQuestionPopups.delete(callID);
}

function showBrowserApprovalPopup(msg: {
  approval_id: string;
  call_id?: string;
  action: string;
  tab?: { tabId?: number; title?: string; url?: string };
  target: string;
  risk: string;
  options?: string[];
}) {
  const existing = activeBrowserApprovalPopups.get(msg.approval_id);
  if (existing) existing.remove();
  if (msg.call_id) dismissBrowserApprovalPopupForCall(msg.call_id);
  const tabLine = msg.tab
    ? `tabId=${msg.tab.tabId ?? ''}\n标题：${msg.tab.title || '(untitled)'}\nURL：${msg.tab.url || '(unknown)'}`
    : '目标标签页未知';
  // The server may offer a session-scoped option ("本站点始终允许"): a third
  // choice that remembers (site, action class) so repeat actions skip the prompt.
  const sessionLabel = '本站点始终允许';
  const options = Array.isArray(msg.options) && msg.options.length >= 2 ? msg.options : ['允许', '拒绝'];
  const panel = showInlineQuestionPanel({
    question: [
      `浏览器操作：${msg.action}`,
      '',
      tabLine,
      '',
      `目标：${msg.target || '(unknown)'}`,
      `风险：${msg.risk || '此操作会改变网页状态。'}`,
    ].join('\n'),
    options,
    onSubmit: answer => {
      const a = answer.trim();
      const isSession = a === sessionLabel;
      const approved = a === '允许' || a === '1' || isSession;
      sendBrowserApprovalAnswer(
        msg.approval_id,
        approved,
        approved ? '' : 'user rejected browser action',
        isSession ? 'session' : '',
      );
      panel.remove();
      activeBrowserApprovalPopups.delete(msg.approval_id);
    },
    onCancel: () => {
      sendBrowserApprovalAnswer(msg.approval_id, false, 'user cancelled browser action');
      activeBrowserApprovalPopups.delete(msg.approval_id);
    },
  });
  panel.dataset.piercodeBrowserApprovalId = msg.approval_id;
  if (msg.call_id) panel.dataset.piercodeBrowserApprovalCallId = msg.call_id;
  activeBrowserApprovalPopups.set(msg.approval_id, panel);
}

// 高危动作文案特征：脚本执行 / cookie 写 / 文件上传 / 剪贴板 / 弹窗 / 跨域导航。
// 这些即使用户开了「自动允许浏览器操作」也**绝不**自动放行——auto-approve 是给
// 点击/输入/滚动这类低危交互省事的，不能成为脚本注入/凭据外泄/跨域跳转的旁路
// （审计 Bug #4：原实现无条件自动批准一切 server browser_approval_ask，等于让
// classifyRisk 漏掉的危险动作彻底无人把关）。镜像 server actionClassFor 的分类。
function isHighRiskBrowserAction(action: string, risk: string): boolean {
  const s = `${action || ''} ${risk || ''}`;
  return (
    /JavaScript|evaluate|脚本|runs page script/i.test(s) ||
    /cookie/i.test(s) ||
    /剪贴板|clipboard/i.test(s) ||
    /上传|upload|uploads a file/i.test(s) ||
    /弹窗|dialog/i.test(s) ||
    /新域名|cross-origin|跨域|新的 origin/i.test(s)
  );
}

export async function handleBrowserApprovalAsk(msg: {
  approval_id: string;
  call_id?: string;
  action: string;
  tab?: { tabId?: number; title?: string; url?: string };
  target: string;
  risk: string;
  options?: string[];
}) {
  // auto-approve 仅覆盖低危交互；高危动作始终弹卡等人工确认（Bug #4）。
  if ((await shouldAutoApproveBrowserActions()) && !isHighRiskBrowserAction(msg.action, msg.risk)) {
    if (msg.call_id) dismissBrowserApprovalPopupForCall(msg.call_id);
    dismissBrowserApprovalPopup(msg.approval_id, msg.call_id);
    const ok = sendBrowserApprovalAnswer(msg.approval_id, true, 'auto approved by extension setting');
    if (ok) showToast(`已自动允许浏览器操作：${msg.action || 'browser action'}`, 2500);
    return;
  }
  showBrowserApprovalPopup(msg);
}

export function dismissBrowserApprovalPopupForCall(callID: string) {
  for (const [approvalID, el] of activeBrowserApprovalPopups) {
    if (el.dataset.piercodeBrowserApprovalCallId !== callID) continue;
    el.remove();
    activeBrowserApprovalPopups.delete(approvalID);
  }
}

export function dismissBrowserApprovalPopup(approvalID: string, callID?: string) {
  const el = activeBrowserApprovalPopups.get(approvalID);
  if (el) {
    el.remove();
    activeBrowserApprovalPopups.delete(approvalID);
  }
  if (callID) dismissBrowserApprovalPopupForCall(callID);
}

type InlineQuestionPanelOptions = {
  question: string;
  options: unknown[];
  onSubmit: (answer: string) => void;
  onCancel?: () => void;
};

function showInlineQuestionPanel(config: InlineQuestionPanelOptions): HTMLDivElement {
  const options = config.options.map(opt => String(opt));
  const panel = document.createElement('div');
  panel.style.cssText = buildQuestionPanelStyle();
  let closed = false;
  const closePanel = () => {
    if (closed) return;
    closed = true;
    panel.remove();
  };
  const submitAnswer = (answer: string) => {
    if (!answer) return;
    config.onSubmit(answer);
    closePanel();
  };

  const header = document.createElement('div');
  header.textContent = 'PierCode 需要回答';
  header.style.cssText = `font-weight:600;margin-bottom:8px;color:${T_AMBER};font-family:${T_FONT}`;
  panel.appendChild(header);

  const body = document.createElement('div');
  body.textContent = config.question;
  body.style.cssText = 'white-space:pre-wrap;margin-bottom:10px;max-height:120px;overflow:auto';
  panel.appendChild(body);

  if (options.length > 0) {
    const optWrap = document.createElement('div');
    optWrap.style.cssText = 'display:grid;gap:6px;margin-bottom:10px';
    options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `${i + 1}. ${opt}`;
      btn.style.cssText = [
        'width:100%', 'padding:7px 10px', `border:1px solid ${T_LINE}`, 'border-radius:6px',
        `background:${T_PANEL2}`, `color:${T_TXT}`, 'cursor:pointer', 'font-size:12px',
        'text-align:left', 'line-height:1.35', `font-family:${T_FONT}`,
      ].join(';');
      btn.onmouseenter = () => { btn.style.background = T_PANEL; btn.style.borderColor = T_GLOW; btn.style.color = T_GLOW; };
      btn.onmouseleave = () => { btn.style.background = T_PANEL2; btn.style.borderColor = T_LINE; btn.style.color = T_TXT; };
      btn.onclick = () => submitAnswer(opt);
      optWrap.appendChild(btn);
    });
    panel.appendChild(optWrap);
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = options.length > 0 ? '自定义回答，或输入选项序号后回车' : '输入回答后回车';
  input.style.cssText = [
    'width:100%', 'padding:8px 10px', 'box-sizing:border-box',
    `border:1px solid ${T_LINE}`, 'border-radius:6px',
    `background:${T_PANEL2}`, `color:${T_TXT}`, 'font-size:13px',
    'outline:none', `font-family:${T_FONT}`,
  ].join(';');
  panel.appendChild(input);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;margin-top:10px';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = `padding:5px 10px;border:1px solid ${T_LINE};border-radius:4px;background:transparent;color:${T_DIM};cursor:pointer;font-family:${T_FONT}`;
  cancelBtn.onclick = () => {
    config.onCancel?.();
    closePanel();
  };

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.textContent = '提交';
  submitBtn.style.cssText = `padding:5px 14px;border:1px solid ${T_GLOW};border-radius:4px;background:transparent;color:${T_GLOW};cursor:pointer;font-weight:600;font-family:${T_FONT};box-shadow:0 0 0 1px ${T_GLOW_SOFT}`;

  const submit = () => {
    let answer = input.value.trim();
    if (!answer) return;
    const idx = parseInt(answer, 10);
    if (options.length > 0 && !Number.isNaN(idx) && idx >= 1 && idx <= options.length) {
      answer = options[idx - 1];
    }
    submitAnswer(answer);
  };

  submitBtn.onclick = submit;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      config.onCancel?.();
      closePanel();
    }
  });

  actions.append(cancelBtn, submitBtn);
  panel.appendChild(actions);

  document.body.appendChild(panel);
  setTimeout(() => input.focus(), 50);
  return panel;
}

function buildQuestionPanelStyle(): string {
  const editor = getEditorEl();
  const rect = editor?.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
  const margin = 12;
  const availableWidth = Math.max(320, viewportWidth - margin * 2);
  const width = Math.min(680, availableWidth, Math.max(480, rect?.width ?? 560));
  const maxLeft = Math.max(margin, viewportWidth - width - margin);
  const left = rect
    ? Math.min(Math.max(rect.left + rect.width - width, margin), maxLeft)
    : Math.max(margin, viewportWidth - width - 20);
  const bottom = rect && rect.top > 80
    ? Math.min(Math.max(viewportHeight - rect.top + margin, margin), viewportHeight - 80)
    : 96;

  return [
    'position:fixed', `left:${Math.round(left)}px`, `bottom:${Math.round(bottom)}px`,
    `width:${Math.round(width)}px`, 'z-index:2147483646',
    'max-height:min(420px, calc(100vh - 32px))', 'overflow:auto',
    'padding:14px 16px', 'box-sizing:border-box',
    `background:${T_PANEL}`, `color:${T_TXT}`,
    `border:1px solid ${T_LINE}`, 'border-radius:10px',
    `box-shadow:0 0 0 1px ${T_GLOW_SOFT},0 10px 30px rgba(0,0,0,0.5)`,
    `font-family:${T_FONT}`,
    'font-size:13px', 'line-height:1.5',
  ].join(';');
}

export function showQuestionPopup(question: string, options: string[]): Promise<string> {
  return new Promise(resolve => {
    const panel = showInlineQuestionPanel({
      question,
      options,
      onSubmit: answer => resolve(answer),
      onCancel: () => resolve(''),
    });
    panel.style.zIndex = '2147483647';
  });
}
