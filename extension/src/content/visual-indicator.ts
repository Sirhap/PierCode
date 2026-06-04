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

// 隐身配置。stealth 开启时改用迷你圆点、关闭脉冲边框，并随机化 DOM id
// 以免页面凭固定 id 探测插件。idBase 默认 'piercode'，保证非隐身行为与
// 单测断言不变；调用 configure({ stealth: true }) 时换成随机前缀。
interface IndicatorConfig {
  stealth: boolean;
  idBase: string;
}

const config: IndicatorConfig = {
  stealth: false,
  idBase: 'piercode',
};

function ids() {
  const b = config.idBase;
  return {
    container: `${b}-shadow-container`,
    glow: `${b}-agent-glow-border`,
    stopContainer: `${b}-agent-stop-container`,
    stopButton: `${b}-agent-stop-button`,
    badge: `${b}-status-badge`,
    dot: `${b}-mini-dot`,
    pulseStyles: `${b}-pulse-styles`,
    highlight: `${b}-highlight-overlay`,
  };
}

function randomBase(): string {
  // 无明显特征的短随机串，避免 'piercode' 出现在 DOM。
  const n = Math.random().toString(36).slice(2, 8);
  return `x${n}`;
}

/**
 * 配置指示器外观。stealth 切换时重建容器（id 变化），保证旧节点清理干净。
 */
function configure(opts: { stealth: boolean }): void {
  if (opts.stealth === config.stealth) return;
  const wasRunning = state.isPulsingActive;
  hideAllIndicators();
  destroyContainer();
  config.stealth = opts.stealth;
  config.idBase = opts.stealth ? randomBase() : 'piercode';
  if (wasRunning) {
    showPulsingBorder();
  }
}

let shadowRoot: ShadowRoot | null = null;
let glowBorder: HTMLDivElement | null = null;
let stopContainer: HTMLDivElement | null = null;
let statusBadge: HTMLDivElement | null = null;
let miniDot: HTMLDivElement | null = null;

function destroyContainer(): void {
  const el = shadowRoot?.host as HTMLElement | undefined;
  el?.remove();
  shadowRoot = null;
  glowBorder = null;
  stopContainer = null;
  statusBadge = null;
  miniDot = null;
}

function getOrCreateShadowRoot(): ShadowRoot {
  if (shadowRoot) return shadowRoot;

  let container = document.getElementById(ids().container);
  if (container?.shadowRoot) {
    shadowRoot = container.shadowRoot;
    return shadowRoot;
  }

  container = document.createElement('div');
  container.id = ids().container;
  container.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  shadowRoot = container.attachShadow({ mode: 'open' });
  document.body.appendChild(container);
  return shadowRoot;
}

function clearHighlight(): void {
  const container = document.getElementById(ids().container);
  if (!container?.shadowRoot) return;
  const overlay = container.shadowRoot.getElementById(ids().highlight);
  if (overlay) overlay.remove();
}

function highlightElement(ref: string): void {
  // 需要无障碍树支持，暂时留空
  void ref;
  clearHighlight();
}

function createPulseStyles(root: ShadowRoot): void {
  if (root.getElementById(ids().pulseStyles)) return;

  const style = document.createElement('style');
  style.id = ids().pulseStyles;
  style.textContent = `
    @keyframes piercode-dot-pulse {
      0%, 100% { opacity: 0.55; transform: scale(1); }
      50%      { opacity: 1;    transform: scale(1.25); }
    }

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

  // 隐身模式：不画全屏脉冲边框，也不弹大停止按钮，只显示角落迷你圆点。
  if (config.stealth) {
    showMiniDot('loading');
    return;
  }

  if (!glowBorder) {
    glowBorder = document.createElement('div');
    glowBorder.id = ids().glow;
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

  hideMiniDot();

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
  container.id = ids().stopContainer;
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
  button.id = ids().stopButton;
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

const DOT_COLORS: Record<string, string> = {
  loading: '#4ade80',
  completed: '#4CAF50',
  error: '#f44336',
};

// 隐身模式下的迷你指示：右下角一个小圆点。loading 时脉冲呼吸，
// 点击即发送停止指令。占地极小，不显眼。
function showMiniDot(status: 'loading' | 'completed' | 'error'): void {
  const root = getOrCreateShadowRoot();
  createPulseStyles(root);

  if (!miniDot) {
    miniDot = document.createElement('div');
    miniDot.id = ids().dot;
    miniDot.title = '停止操作';
    miniDot.style.cssText = `
      position: fixed;
      bottom: 14px;
      right: 14px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      cursor: pointer;
      pointer-events: auto;
      z-index: 2147483647;
      box-shadow: 0 0 0 3px rgba(0,0,0,0.06);
    `;
    miniDot.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'STOP_BROWSER_OPERATION' });
      } catch (error) {
        console.error('[PierCode] Failed to send stop message:', error);
      }
      hideAllIndicators();
    });
    root.appendChild(miniDot);
  }

  miniDot.style.display = '';
  miniDot.style.background = DOT_COLORS[status];
  miniDot.style.animation = status === 'loading'
    ? 'piercode-dot-pulse 1.4s ease-in-out infinite'
    : 'none';
}

function hideMiniDot(): void {
  if (miniDot) {
    miniDot.remove();
    miniDot = null;
  }
}

function showStatusBadge(status: 'loading' | 'completed' | 'error'): void {
  // 隐身模式：用迷你圆点替代大徽章。
  if (config.stealth) {
    showMiniDot(status);
    return;
  }

  const root = getOrCreateShadowRoot();

  // 移除旧的状态徽章
  const existing = root.getElementById(ids().badge);
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
  badge.id = ids().badge;
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
  hideMiniDot();
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
  if (miniDot) miniDot.style.display = 'none';
}

function showAfterToolUse(): void {
  if (state.wasPulsingBeforeHide) {
    if (config.stealth) {
      // 隐身模式只需把迷你圆点恢复为 loading 脉冲。
      showMiniDot('loading');
      state.wasPulsingBeforeHide = false;
      return;
    }
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
  configure,
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
      stealth: config.stealth,
    };
  },
};

// 页面卸载时清理
window.addEventListener('beforeunload', () => {
  hideAllIndicators();
});
