if (!(window as any).__GROUND_LINK_LOADED__) {
  (window as any).__GROUND_LINK_LOADED__ = true;

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  (document.head || document.documentElement).appendChild(script);

  window.addEventListener('message', async (event) => {
    if (event.data.type === 'TOOL_CALL') {
      executeToolCall(event.data.data);
    }
  });

  if (document.body) {
    injectInitButton();
  } else {
    document.addEventListener('DOMContentLoaded', injectInitButton);
  }
}

function injectInitButton() {
  const btn = document.createElement('button');
  btn.textContent = '🔗 初始化';
  btn.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:99999;padding:8px 14px;background:#1677ff;color:#fff;border:none;border-radius:20px;cursor:pointer;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
  btn.onclick = sendInitPrompt;
  document.body.appendChild(btn);
}

async function sendInitPrompt() {
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) { alert('请先在插件中配置 API 地址'); return; }
  const headers: any = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const resp = await fetch(`${apiUrl}/prompt`, { headers });
  if (!resp.ok) { alert('获取初始化提示词失败'); return; }
  const text = await resp.text();
  fillAndSend(text, true);
}

async function executeToolCall(toolCall: any) {
  try {
    const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
    const headers: any = { 'Content-Type': 'application/json' };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    if (!apiUrl) {
      fillAndSend('请先在插件中配置 API 地址', false);
      return;
    }

    const response = await fetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify(toolCall)
    });

    if (response.status === 401) {
      fillAndSend('认证失败，请在插件中重新输入 Token', false);
      return;
    }

    const result = await response.json();
    fillAndSend(result.output, true);
  } catch (error) {
    console.error('[Ground-Link] 执行失败:', error);
  }
}

function fillAndSend(result: string, autoSend = false) {
  const editor = document.querySelector('[data-slate-editor="true"]') as HTMLElement;
  if (!editor) return;

  editor.focus();
  const dataTransfer = new DataTransfer();
  dataTransfer.setData('text/plain', result);
  editor.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dataTransfer, bubbles: true, cancelable: true}));

  if (autoSend) {
    const checkAndClick = () => {
      const sendBtn = document.querySelector('.operateBtn-JsB9e2') as HTMLElement;
      if (sendBtn && !sendBtn.classList.contains('disabled-ZaDDJC')) {
        sendBtn.click();
      } else {
        setTimeout(checkAndClick, 100);
      }
    };
    setTimeout(checkAndClick, 300);
  }
}
