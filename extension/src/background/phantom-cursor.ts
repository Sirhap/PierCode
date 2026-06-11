// 虚拟光标(phantom cursor):在被自动化的页面上显示一个跟随 CDP 鼠标事件移动的箭头。
// 注入走 chrome.debugger Runtime.evaluate(tab 已 attach,不受 host_permissions 限制),
// 不依赖 content script,所以任意被控 tab 都能显示。
// SVG 路径与 180ms cubic-bezier 动画参数取自 Claude in Chrome 扩展的 phantom cursor;
// 配色换成 PierCode 主题(--glow #5b8cff / --txt #e6e9ef,见 popup/theme.css)。

const CURSOR_ID = 'piercode-phantom-cursor';
// 光标空闲多久后淡出移除(页面端定时器);PierCode 没有 agent 生命周期消息推到任意 tab,用空闲超时代替
const IDLE_HIDE_MS = 4000;
// 等待移动动画完成的上限,防止页面端 Promise 卡住 CDP 命令流
const MOVE_WAIT_CAP_MS = 250;

// 页面上下文渲染器:首次执行安装 window.__piercodePhantomCursor,之后只调 move(x,y)。
// move 返回 Promise:动画 transitionend 或 220ms 兜底后 resolve;同坐标/页面隐藏时立即 resolve。
const RENDERER_SOURCE = `(() => {
  const g = window;
  if (!g.__piercodePhantomCursor) {
    const NS = 'http://www.w3.org/2000/svg';
    const ARROW = 'M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z';
    const mkPath = (attrs) => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', ARROW);
      for (const k in attrs) p.setAttribute(k, attrs[k]);
      return p;
    };
    const mkLayer = (stroke, fill, extra) => {
      const s = document.createElementNS(NS, 'svg');
      s.setAttribute('width', '20');
      s.setAttribute('height', '26');
      s.setAttribute('viewBox', '0 0 20 26');
      s.style.cssText = 'position:absolute;top:0;left:0;overflow:visible;' + extra;
      s.appendChild(mkPath({ stroke: stroke, 'stroke-width': '3', 'stroke-linejoin': 'round', fill: stroke }));
      s.appendChild(mkPath({ fill: fill }));
      return s;
    };
    const state = { el: null, x: null, y: null, hideTimer: null };
    const create = (x, y) => {
      const c = document.createElement('div');
      c.id = '${CURSOR_ID}';
      c.setAttribute('aria-hidden', 'true');
      c.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646;'
        + 'transform:translate3d(' + x + 'px,' + y + 'px,0);'
        + 'transition:transform 180ms cubic-bezier(0.2, 0, 0, 1),opacity 200ms ease;will-change:transform;';
      c.appendChild(mkLayer('white', '#111', ''));
      c.appendChild(mkLayer('#5b8cff', '#e6e9ef',
        'filter: drop-shadow(0 0 4px rgba(91,140,255,0.9)) drop-shadow(0 0 10px rgba(91,140,255,0.45));'));
      return c;
    };
    g.__piercodePhantomCursor = {
      move(x, y) {
        if (!document.body) return Promise.resolve();
        if (state.hideTimer) { clearTimeout(state.hideTimer); state.hideTimer = null; }
        const same = state.el !== null && state.x === x && state.y === y;
        state.x = x; state.y = y;
        let el = state.el;
        const created = !el || !el.isConnected;
        if (created) {
          if (el) el.remove();
          el = create(x, y);
          state.el = el;
          document.body.appendChild(el);
        }
        el.style.opacity = '1';
        state.hideTimer = setTimeout(() => {
          state.hideTimer = null;
          el.style.opacity = '0';
          setTimeout(() => {
            if (state.el === el && el.style.opacity === '0') { el.remove(); state.el = null; }
          }, 250);
        }, ${IDLE_HIDE_MS});
        if (created) return Promise.resolve();
        el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
        if (same || document.hidden) return Promise.resolve();
        return new Promise((resolve) => {
          let done = false;
          const fin = () => {
            if (done) return;
            done = true;
            el.removeEventListener('transitionend', fin);
            resolve();
          };
          el.addEventListener('transitionend', fin, { once: true });
          setTimeout(fin, 220);
        });
      },
    };
  }
  return g.__piercodePhantomCursor.move(__X__, __Y__);
})()`;

export function buildPhantomCursorExpression(x: number, y: number): string {
  return RENDERER_SOURCE.replace('__X__', String(Math.round(x))).replace('__Y__', String(Math.round(y)));
}

// 在转发 Input.dispatchMouseEvent 给 CDP 之前调用:先把虚拟光标移到目标坐标。
// mouseMoved/mouseWheel/mousePressed 等动画走完(上限 MOVE_WAIT_CAP_MS)再返回,
// 视觉与真实事件同步;mouseReleased 与 press 同坐标,fire-and-forget 即可。
export async function syncPhantomCursor(tabId: number, params: Record<string, unknown>): Promise<void> {
  const { x, y, type } = params;
  if (typeof x !== 'number' || typeof y !== 'number') return;
  const evalPromise = chrome.debugger
    .sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: buildPhantomCursorExpression(x, y),
      awaitPromise: true,
      returnByValue: true,
    })
    .catch(() => undefined);
  if (type === 'mouseMoved' || type === 'mouseWheel' || type === 'mousePressed') {
    await Promise.race([evalPromise, new Promise((resolve) => setTimeout(resolve, MOVE_WAIT_CAP_MS))]);
  }
}
