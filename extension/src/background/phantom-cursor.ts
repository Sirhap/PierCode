// 虚拟光标(phantom cursor):在被自动化的页面上显示一个跟随 CDP 鼠标事件移动的箭头。
// 注入走 chrome.debugger Runtime.evaluate(tab 已 attach,不受 host_permissions 限制),
// 不依赖 content script,所以任意被控 tab 都能显示。
// SVG 路径与 180ms cubic-bezier 动画参数取自 Claude in Chrome 扩展的 phantom cursor;
// 配色换成 PierCode 主题(--glow #5b8cff / --txt #e6e9ef,见 popup/theme.css)。

const CURSOR_ID = 'piercode-phantom-cursor';
// 光标空闲多久后淡出(页面端定时器);PierCode 没有 agent 生命周期消息推到任意 tab,用空闲超时代替。
// 不直接移除,先降到半透明驻留,真正移除推到 IDLE_REMOVE_MS,动作间隙仍可见。
const IDLE_HIDE_MS = 9000;
// 空闲降透明后再过这么久才移除元素;期间下一个动作把它拉回不闪
const IDLE_REMOVE_MS = 6000;
// 等待移动动画完成的上限,防止页面端 Promise 卡住 CDP 命令流(动画放慢到 260ms,上限同步抬高)
const MOVE_WAIT_CAP_MS = 320;

// 页面上下文渲染器:首次执行安装 window.__piercodePhantomCursor,之后只调 move(x,y,type)。
// move 返回 Promise:动画 transitionend 或 280ms 兜底后 resolve;同坐标/页面隐藏时立即 resolve。
// type === 'mousePressed' 时触发点击脉冲(光标缩一下 + 扩散光环 ripple),让"点击发生"可见。
const RENDERER_SOURCE = `(() => {
  const g = window;
  if (!g.__piercodePhantomCursor) {
    const NS = 'http://www.w3.org/2000/svg';
    const ARROW = 'M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z';
    // 箭头整体放大,满屏中更显眼
    const SCALE = 1.45;
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
    const ensureKeyframes = (root) => {
      // Keyframes must live INSIDE the shadow root — a page-level @keyframes is
      // not visible to elements in a shadow tree.
      if (!root || root.getElementById && root.getElementById('${CURSOR_ID}-kf')) return;
      if (root.querySelector && root.querySelector('#${CURSOR_ID}-kf')) return;
      const st = document.createElement('style');
      st.id = '${CURSOR_ID}-kf';
      st.textContent =
        '@keyframes pcc-ripple{0%{transform:translate(-50%,-50%) scale(0.2);opacity:0.85}'
        + '100%{transform:translate(-50%,-50%) scale(1);opacity:0}}'
        + '@keyframes pcc-trail{0%{opacity:0.5}100%{opacity:0}}';
      root.appendChild(st);
    };
    const state = { host: null, el: null, arrow: null, x: null, y: null, hideTimer: null, removeTimer: null, observer: null };
    // The cursor lives inside a CLOSED shadow root on a neutral host element, so
    // page CSS can't restyle it and a page script can't reach it via the host's
    // shadowRoot (closed → null). The host carries no identifying id/class.
    const mountHost = () => {
      const host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483646;';
      const root = host.attachShadow({ mode: 'closed' });
      state.host = host;
      state.root = root;
      (document.body || document.documentElement).appendChild(host);
      // Self-heal: if the page removes our host (SPA re-render, sanitizer),
      // re-attach on the next move() instead of silently vanishing.
      if (!state.observer && window.MutationObserver && document.body) {
        state.observer = new MutationObserver(() => {
          // Guard the whole document: a callback can still be queued after the
          // realm is torn down (JSDOM window.close in tests, or a navigating
          // page), where document itself is gone, so reading document.body
          // throws an uncaught TypeError.
          if (typeof document === 'undefined' || !document || !document.body) return;
          if (state.host && !state.host.isConnected) {
            try { document.body.appendChild(state.host); } catch (e) {}
          }
        });
        try { state.observer.observe(document.body, { childList: true }); } catch (e) {}
      }
      return root;
    };
    const create = (x, y) => {
      const c = document.createElement('div');
      c.setAttribute('aria-hidden', 'true');
      c.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646;'
        + 'transform:translate3d(' + x + 'px,' + y + 'px,0);'
        + 'transition:transform 260ms cubic-bezier(0.22, 0.61, 0.36, 1),opacity 220ms ease;will-change:transform;';
      // 常驻柔光圈:中心对准箭头热点(2,2),始终标出光标位置
      const halo = document.createElement('div');
      halo.style.cssText = 'position:absolute;left:2px;top:2px;width:30px;height:30px;'
        + 'transform:translate(-50%,-50%);border-radius:50%;'
        + 'background:radial-gradient(circle,rgba(91,140,255,0.55) 0%,rgba(91,140,255,0.18) 45%,transparent 72%);'
        + 'filter:blur(1px);';
      c.appendChild(halo);
      // 箭头单独包一层,以热点(2,2)为原点放大,点击脉冲只缩放箭头不动光环
      const arrow = document.createElement('div');
      arrow.style.cssText = 'position:absolute;top:0;left:0;transform-origin:2px 2px;'
        + 'transform:scale(' + SCALE + ');transition:transform 120ms cubic-bezier(0.22,0.61,0.36,1);';
      arrow.appendChild(mkLayer('white', '#111', ''));
      arrow.appendChild(mkLayer('#5b8cff', '#e6e9ef',
        'filter: drop-shadow(0 0 5px rgba(91,140,255,1)) drop-shadow(0 0 14px rgba(91,140,255,0.6));'));
      c.appendChild(arrow);
      state.arrow = arrow;
      return c;
    };
    const pulse = (el) => {
      // 箭头缩一下回弹
      const arrow = state.arrow;
      if (arrow) {
        arrow.style.transform = 'scale(' + (SCALE * 0.72) + ')';
        setTimeout(() => { if (state.arrow === arrow) arrow.style.transform = 'scale(' + SCALE + ')'; }, 120);
      }
      // 扩散光环 ripple,中心对准箭头热点(2,2)
      const r = document.createElement('div');
      r.style.cssText = 'position:absolute;left:2px;top:2px;width:46px;height:46px;'
        + 'border-radius:50%;border:2.5px solid rgba(91,140,255,0.95);'
        + 'box-shadow:0 0 10px rgba(91,140,255,0.7);'
        + 'transform:translate(-50%,-50%) scale(0.2);'
        + 'animation:pcc-ripple 480ms cubic-bezier(0.22,0.61,0.36,1) forwards;';
      el.appendChild(r);
      setTimeout(() => r.remove(), 520);
    };
    g.__piercodePhantomCursor = {
      move(x, y, type) {
        if (!document.body) return Promise.resolve();
        if (state.hideTimer) { clearTimeout(state.hideTimer); state.hideTimer = null; }
        if (state.removeTimer) { clearTimeout(state.removeTimer); state.removeTimer = null; }
        // (Re)mount the closed-shadow host if missing.
        let root = state.root;
        if (!state.host || !state.host.isConnected) {
          root = mountHost();
        }
        ensureKeyframes(root);
        const same = state.el !== null && state.x === x && state.y === y;
        const prevX = state.x, prevY = state.y;
        state.x = x; state.y = y;
        let el = state.el;
        const created = !el || !el.isConnected;
        if (created) {
          if (el) el.remove();
          el = create(x, y);
          state.el = el;
          root.appendChild(el);
        }
        el.style.opacity = '1';
        // 移动拖尾:从上一个位置到新位置留一团短暂残影
        if (!created && !same && prevX !== null && prevY !== null && !document.hidden) {
          const t = document.createElement('div');
          // 圆 12px,圆心落在上一位置的热点(prev+2,2) → 左上角偏 -4
          t.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483645;'
            + 'transform:translate3d(' + (prevX - 4) + 'px,' + (prevY - 4) + 'px,0);'
            + 'width:12px;height:12px;border-radius:50%;'
            + 'background:radial-gradient(circle,rgba(91,140,255,0.65),transparent 70%);'
            + 'animation:pcc-trail 320ms ease forwards;';
          root.appendChild(t);
          setTimeout(() => t.remove(), 340);
        }
        if (type === 'mousePressed') pulse(el);
        // 空闲先降到半透明驻留(IDLE_HIDE_MS),再过 IDLE_REMOVE_MS 才真正移除
        state.hideTimer = setTimeout(() => {
          state.hideTimer = null;
          el.style.opacity = '0.35';
          state.removeTimer = setTimeout(() => {
            state.removeTimer = null;
            if (state.el === el) {
              el.remove(); state.el = null; state.arrow = null;
              // Tear down the shadow host + observer so no empty overlay lingers.
              if (state.observer) { try { state.observer.disconnect(); } catch (e) {} state.observer = null; }
              if (state.host) { try { state.host.remove(); } catch (e) {} state.host = null; state.root = null; }
            }
          }, ${IDLE_REMOVE_MS});
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
          setTimeout(fin, 300);
        });
      },
      // Explicit teardown: disconnect the self-heal observer, clear the idle
      // hide/remove timers, and remove the host overlay immediately instead of
      // waiting out IDLE_HIDE_MS + IDLE_REMOVE_MS (~15s). Tests call this in
      // afterEach so a queued observer callback can't fire after the realm is
      // torn down; production can call it on tab teardown / extension disable.
      destroy() {
        if (state.hideTimer) { clearTimeout(state.hideTimer); state.hideTimer = null; }
        if (state.removeTimer) { clearTimeout(state.removeTimer); state.removeTimer = null; }
        if (state.observer) { try { state.observer.disconnect(); } catch (e) {} state.observer = null; }
        if (state.el) { try { state.el.remove(); } catch (e) {} state.el = null; state.arrow = null; }
        if (state.host) { try { state.host.remove(); } catch (e) {} state.host = null; state.root = null; }
        state.x = null; state.y = null;
      },
    };
  }
  return g.__piercodePhantomCursor.move(__X__, __Y__, __TYPE__);
})()`;

export function buildPhantomCursorExpression(x: number, y: number, type?: string): string {
  return RENDERER_SOURCE.replace('__X__', String(Math.round(x)))
    .replace('__Y__', String(Math.round(y)))
    .replace('__TYPE__', JSON.stringify(type || ''));
}

// 在转发 Input.dispatchMouseEvent 给 CDP 之前调用:先把虚拟光标移到目标坐标。
// mouseMoved/mouseWheel/mousePressed 等动画走完(上限 MOVE_WAIT_CAP_MS)再返回,
// 视觉与真实事件同步;mouseReleased 与 press 同坐标,fire-and-forget 即可。
export async function syncPhantomCursor(tabId: number, params: Record<string, unknown>): Promise<void> {
  const { x, y, type } = params;
  if (typeof x !== 'number' || typeof y !== 'number') return;
  const evalPromise = chrome.debugger
    .sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: buildPhantomCursorExpression(x, y, typeof type === 'string' ? type : undefined),
      awaitPromise: true,
      returnByValue: true,
    })
    .catch(() => undefined);
  if (type === 'mouseMoved' || type === 'mouseWheel' || type === 'mousePressed') {
    await Promise.race([evalPromise, new Promise((resolve) => setTimeout(resolve, MOVE_WAIT_CAP_MS))]);
  }
}
