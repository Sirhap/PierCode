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
