/**
 * PierCode 可视化指示器
 * 借鉴自 QoderWork 的 visual-indicator 设计
 * 提供：脉冲边框、停止按钮、状态徽章
 */

interface VisualIndicatorState {
  isPulsingActive: boolean;
  wasPulsingBeforeHide: boolean;
  currentTabId: number | null;
}

const state: VisualIndicatorState = {
  isPulsingActive: false,
  wasPulsingBeforeHide: false,
  currentTabId: null,
};

let shadowRoot: ShadowRoot | null = null;
let glowBorder: HTMLDivElement | null = null;
let stopContainer: HTMLDivElement | null = null;
let statusBadge: HTMLDivElement | null = null;

function getOrCreateShadowRoot(): ShadowRoot {
  if (shadowRoot) return shadowRoot;

  let container = document.getElementById('piercode-shadow-container');
  if (container?.shadowRoot) {
    shadowRoot = container.shadowRoot;
    return shadowRoot;
  }

  container = document.createElement('div');
  container.id = 'piercode-shadow-container';
  container.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  shadowRoot = container.attachShadow({ mode: 'open' });
  document.body.appendChild(container);
  return shadowRoot;
}

function clearHighlight(): void {
  const container = document.getElementById('piercode-shadow-container');
  if (!container?.shadowRoot) return;
  const overlay = container.shadowRoot.getElementById('piercode-highlight-overlay');
  if (overlay) overlay.remove();
}

function highlightElement(ref: string): void {
  // 需要无障碍树支持，暂时留空
  void ref;
  clearHighlight();
}

function createPulseStyles(root: ShadowRoot): void {
  if (root.getElementById('piercode-pulse-styles')) return;

  const style = document.createElement('style');
  style.id = 'piercode-pulse-styles';
  style.textContent = `
    @keyframes piercode-agent-pulse {
      0%, 100% {
        box-shadow:
          inset 0 0 4px rgba(74, 222, 128, 0.5),
          inset 0 0 8px rgba(74, 222, 128, 0.25);
      }
      50% {
        box-shadow:
          inset 0 0 6px rgba(74, 222, 128, 0.7),
          inset 0 0 12px rgba(74, 222, 128, 0.35);
      }
    }

    @keyframes piercode-stop-slide-in {
      from {
        opacity: 0;
        transform: translate(-50%, 100px);
      }
      to {
        opacity: 1;
        transform: translate(-50%, 0);
      }
    }

    @keyframes piercode-stop-slide-out {
      from {
        opacity: 1;
        transform: translate(-50%, 0);
      }
      to {
        opacity: 0;
        transform: translate(-50%, 100px);
      }
    }
  `;
  root.appendChild(style);
}

function showPulsingBorder(): void {
  state.isPulsingActive = true;
  const root = getOrCreateShadowRoot();
  createPulseStyles(root);

  if (!glowBorder) {
    glowBorder = document.createElement('div');
    glowBorder.id = 'piercode-agent-glow-border';
    glowBorder.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 2147483646;
      opacity: 0;
      transition: opacity 0.3s ease-in-out;
      animation: piercode-agent-pulse 2s ease-in-out infinite;
      box-shadow:
        inset 0 0 4px rgba(74, 222, 128, 0.5),
        inset 0 0 8px rgba(74, 222, 128, 0.25);
    `;
    root.appendChild(glowBorder);
  }

  if (!stopContainer) {
    stopContainer = createStopButton();
    root.appendChild(stopContainer);
  }

  requestAnimationFrame(() => {
    if (glowBorder) glowBorder.style.opacity = '1';
    if (stopContainer) {
      stopContainer.style.opacity = '1';
      stopContainer.style.animation = 'piercode-stop-slide-in 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards';
    }
  });
}

function hidePulsingBorder(): void {
  state.isPulsingActive = false;

  if (glowBorder) {
    glowBorder.style.opacity = '0';
  }

  if (stopContainer) {
    stopContainer.style.animation = 'piercode-stop-slide-out 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards';
    setTimeout(() => {
      if (!state.isPulsingActive && stopContainer) {
        stopContainer.style.display = 'none';
      }
    }, 300);
  }
}

function createStopButton(): HTMLDivElement {
  const container = document.createElement('div');
  container.id = 'piercode-agent-stop-container';
  container.style.cssText = `
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%) translateY(100px);
    pointer-events: none;
    z-index: 2147483647;
    opacity: 0;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  `;

  const button = document.createElement('button');
  button.id = 'piercode-agent-stop-button';
  button.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" style="display:inline-block;vertical-align:middle;margin-right:8px;">
      <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm40-112v56a12,12,0,0,1-12,12H100a12,12,0,0,1-12-12V100a12,12,0,0,1,12-12h56A12,12,0,0,1,168,100Z"></path>
    </svg>
    <span style="vertical-align:middle">停止操作</span>
  `;
  button.style.cssText = `
    position: relative;
    padding: 12px 16px;
    background: #FAF9F5;
    color: #141413;
    border: 0.5px solid rgba(31, 30, 29, 0.4);
    border-radius: 12px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow:
      0 40px 80px rgba(74, 222, 128, 0.24),
      0 4px 14px rgba(74, 222, 128, 0.24);
    transition: all 0.2s ease;
    pointer-events: auto;
  `;

  button.addEventListener('mouseenter', () => {
    if (state.isPulsingActive) button.style.background = '#F5F4F0';
  });

  button.addEventListener('mouseleave', () => {
    if (state.isPulsingActive) button.style.background = '#FAF9F5';
  });

  button.addEventListener('click', async () => {
    try {
      // 发送停止消息到background
      chrome.runtime.sendMessage({ type: 'STOP_BROWSER_OPERATION' });
      button.innerHTML = `
        <span style="vertical-align:middle">正在停止...</span>
      `;
      button.disabled = true;
      button.style.opacity = '0.7';

      // 0.5秒后隐藏指示器
      setTimeout(() => {
        hideAllIndicators();
      }, 500);
    } catch (error) {
      console.error('[PierCode] Failed to send stop message:', error);
    }
  });

  container.appendChild(button);
  return container;
}

function showStatusBadge(status: 'loading' | 'completed' | 'error'): void {
  const root = getOrCreateShadowRoot();

  // 移除旧的状态徽章
  const existing = root.getElementById('piercode-status-badge');
  if (existing) existing.remove();

  const emojiMap: Record<string, string> = {
    loading: '⏳',
    completed: '✅',
    error: '❌',
  };

  const colorMap: Record<string, string> = {
    loading: '#2196F3',
    completed: '#4CAF50',
    error: '#f44336',
  };

  const badge = document.createElement('div');
  badge.id = 'piercode-status-badge';
  badge.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${colorMap[status]};
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    display: flex;
    align-items: center;
    gap: 8px;
    transition: all 0.3s ease;
    z-index: 2147483647;
  `;
  badge.innerHTML = `${emojiMap[status]} ${status.charAt(0).toUpperCase() + status.slice(1)}`;

  badge.onclick = () => {
    badge.style.opacity = '0';
    setTimeout(() => badge.remove(), 300);
  };

  root.appendChild(badge);
  statusBadge = badge;
}

function hideStatusBadge(): void {
  if (statusBadge) {
    statusBadge.remove();
    statusBadge = null;
  }
}

function hideAllIndicators(): void {
  hidePulsingBorder();
  hideStatusBadge();
  clearHighlight();
}

function hideForToolUse(): void {
  state.wasPulsingBeforeHide = state.isPulsingActive;
  if (glowBorder) glowBorder.style.display = 'none';
  if (stopContainer) stopContainer.style.display = 'none';
  if (statusBadge) statusBadge.style.display = 'none';
}

function showAfterToolUse(): void {
  if (state.wasPulsingBeforeHide) {
    if (glowBorder) {
      glowBorder.style.display = '';
      requestAnimationFrame(() => {
        if (glowBorder) glowBorder.style.opacity = '1';
      });
    }
    if (stopContainer) {
      stopContainer.style.display = '';
      requestAnimationFrame(() => {
        if (stopContainer) {
          stopContainer.style.opacity = '1';
          stopContainer.style.animation = 'piercode-stop-slide-in 0.3s cubic-bezier(0.4, 0, 0.2, 1) forwards';
        }
      });
    }
  }
  state.wasPulsingBeforeHide = false;
}

// 暴露API供其他模块调用
export const visualIndicator = {
  showPulsingBorder,
  hidePulsingBorder,
  showStatusBadge,
  hideStatusBadge,
  hideAllIndicators,
  hideForToolUse,
  showAfterToolUse,
  highlightElement,
  clearHighlight,
  get state() {
    return {
      isPulsingActive: state.isPulsingActive,
      wasPulsingBeforeHide: state.wasPulsingBeforeHide,
    };
  },
};

// 页面卸载时清理
window.addEventListener('beforeunload', () => {
  hideAllIndicators();
});
