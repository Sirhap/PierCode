/*
 * qwen 风控排查脚本 — 在 chat.qwen.ai 页面的 DevTools Console 里粘贴执行。
 *
 * 复制下面 IIFE 整段到 qwen tab 控制台回车。它逐节验证子 agent 走的
 * SW-direct-fetch + 借来的 bx-ua 这条链路，定位是哪节断：
 *   1. 登录态 / cookie（token / xsrf-token / ssxmod）
 *   2. baxia SDK 是否在页面、bx-ua 是否能现算（umidtoken / __fy* / window.baxia）
 *   3. page-context fetch 自动注入的 bx-ua / bx-umidtoken 长啥样
 *   4. 实打实发一发 /chats/new + completions，看响应是 RGV587(墙) 还是 event-stream(过)
 *
 * 注意：必须在 qwen 标签页本身的控制台跑（page world），不是扩展 SW 控制台。
 *       baxia 的 fetch monkey-patch 只在页面里。
 */
(async () => {
  const log = (...a) => console.log('%c[qwen-diag]', 'color:#0bd', ...a);
  const ok = (...a) => console.log('%c[qwen-diag] OK', 'color:#0c0', ...a);
  const bad = (...a) => console.log('%c[qwen-diag] FAIL', 'color:#f33', ...a);
  const isPunish = (t) => /RGV587|punish|aliyun_waf|哎哟喂|被挤爆/.test(t);

  log('开始排查。当前页:', location.href);

  // ── 1. 登录态 / cookie ────────────────────────────────────────────────
  const cookies = Object.fromEntries(
    document.cookie.split(';').map(s => s.trim().split('=').map(decodeURIComponent))
      .filter(p => p[0])
  );
  const token = cookies['token'];
  const xsrf = cookies['xsrf-token'];
  log('cookie 检查:');
  console.table({
    token: token ? token.slice(0, 12) + '…(' + token.length + ')' : '(缺失)',
    'xsrf-token': xsrf ? xsrf.slice(0, 12) + '…' : '(缺失)',
    ssxmod_itna: cookies['ssxmod_itna'] ? '有' : '(无)',
    ssxmod_itna2: cookies['ssxmod_itna2'] ? '有' : '(无)',
  });
  if (!token) bad('无 token cookie — 未登录或登录过期。子 agent Authorization 会失败。先重新登录 qwen。');
  else ok('已登录 (token 存在)');
  if (!xsrf) bad('无 xsrf-token — x-xsrf-token 头会缺失，RGV587 概率升高。刷新页面让前端重新种 cookie。');

  // localStorage 里也常存 token
  try {
    const lsKeys = Object.keys(localStorage).filter(k => /token|auth|umid|baxia|bx/i.test(k));
    if (lsKeys.length) log('localStorage 相关键:', lsKeys);
  } catch {}

  // ── 2. baxia SDK 是否在页面 ──────────────────────────────────────────
  log('baxia / bx-ua 生成能力检查:');
  const baxiaSignals = {
    'window.baxia': typeof window.baxia,
    'window.__baxia__': typeof window.__baxia__,
    'window.__fy_ua__': typeof window.__fy_ua__,
    'window._tb_token_': typeof window._tb_token_,
    'window.umid / getUMID': typeof window.getUMID || typeof window.umid,
  };
  console.table(baxiaSignals);
  const baxiaScripts = [...document.scripts]
    .map(s => s.src).filter(s => /baxia|bx\.|umid|fy\/|aliyun|alicdn.*security/i.test(s));
  if (baxiaScripts.length) ok('baxia/umid 相关脚本已加载:', baxiaScripts);
  else bad('页面没找到 baxia 脚本 src。bx-ua 可能算不出 → 借不到签名 → 子 agent 撞墙。可能脚本被内联或被拦。');

  // ── 3. page-context fetch 注入的 bx-ua 长啥样 ────────────────────────
  // baxia monkey-patch 在请求发出时往 header 写 bx-ua。借一个 Request 看注入结果。
  log('探测 page-fetch 自动注入的签名头（不真正发包，只看 baxia 是否拦截 fetch）:');
  let fetchPatched = false;
  try {
    const fnStr = window.fetch.toString();
    fetchPatched = !/\[native code\]/.test(fnStr);
    log('window.fetch 是否被改写(baxia 注入点):', fetchPatched ? '是 ✅' : '否（native）⚠️');
    if (!fetchPatched) bad('window.fetch 是 native — baxia 没接管 fetch，bx-ua 不会被自动注入。子 agent 走 page-fetch 代理也拿不到签名。');
  } catch (e) { log('读 fetch.toString 失败:', e); }

  // ── 4. 实测：/chats/new (无需 bx-ua 也该过) + completions (撞风控点) ──
  log('实测发包（在页面 page-world，baxia 会自动注入签名）…');

  const baseHeaders = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Origin': 'https://chat.qwen.ai',
    'Referer': 'https://chat.qwen.ai/',
    'version': '0.2.63',
    'source': 'web',
    'x-request-id': crypto.randomUUID(),
    'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    'bx-v': '2.5.36',
    ...(xsrf ? { 'x-xsrf-token': xsrf } : {}),
  });

  // 4a. /chats/new
  let chatId = null;
  try {
    const r = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
      method: 'POST', headers: baseHeaders(), credentials: 'include',
      body: JSON.stringify({
        title: '新建对话', models: ['qwen-max-latest'], chat_mode: 'normal',
        chat_type: 't2t', timestamp: Math.floor(Date.now() / 1000), project_id: '',
      }),
    });
    const t = await r.text();
    if (isPunish(t)) bad(`/chats/new 命中风控 (${r.status}):`, t.slice(0, 300));
    else if (!r.ok) bad(`/chats/new HTTP ${r.status}:`, t.slice(0, 300));
    else {
      let d; try { d = JSON.parse(t); } catch {}
      chatId = d?.data?.id || null;
      if (chatId) ok('/chats/new 通过, chat_id =', chatId);
      else bad('/chats/new 响应无 chat_id:', t.slice(0, 300));
    }
  } catch (e) { bad('/chats/new 异常:', e.message || e); }

  // 4b. completions — 真正撞 bx-ua 风控的端点
  if (chatId) {
    try {
      const r = await fetch(`https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`, {
        method: 'POST', headers: baseHeaders(), credentials: 'include',
        body: JSON.stringify({
          stream: true, chat_id: chatId, chat_mode: 'normal', model: 'qwen-max-latest',
          parent_id: null,
          messages: [{ role: 'user', content: 'hi', chat_type: 't2t',
            extra: {}, feature_config: { thinking_enabled: false, output_schema: 'phase' } }],
          timestamp: Math.floor(Date.now() / 1000),
        }),
      });
      const ct = r.headers.get('content-type') || '';
      log('completions 响应:', r.status, ct);
      if (ct.includes('text/event-stream')) {
        ok('completions 拿到 event-stream — 风控已过 ✅。链路本身 OK，问题在 SW 端借/复用 bx-ua。');
        try { r.body.cancel(); } catch {}
      } else {
        const t = await r.text();
        if (isPunish(t)) bad('completions 命中 RGV587 风控墙:', t.slice(0, 400));
        else bad(`completions 非 stream (${r.status}):`, t.slice(0, 400));
      }
    } catch (e) { bad('completions 异常:', e.message || e); }
  } else {
    log('跳过 completions 实测（无 chat_id）');
  }

  // ── 5. 抓一份真实 bx-ua，给 SW 借用链路比对 ──────────────────────────
  // baxia 注入到 header 是发包时才算；这里挂一次性 fetch 拦截抓出来给你看。
  log('尝试截获一份真实 bx-ua（下次任意请求时打印）。手动在 qwen 页面发条消息触发，或忽略。');
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const h = new Headers(init?.headers || (input && input.headers) || {});
      const bxua = h.get('bx-ua'); const umid = h.get('bx-umidtoken');
      if (bxua) {
        ok('截获 bx-ua (前 60):', bxua.slice(0, 60) + '…  长度=' + bxua.length);
        if (umid) ok('截获 bx-umidtoken:', umid.slice(0, 40) + '…');
        window.__piercode_lastBxUa = { bxUa: bxua, umid };
        log('已存 window.__piercode_lastBxUa，可贴给 SW 比对。');
        window.fetch = origFetch; // 抓一次即还原
      }
    } catch {}
    return origFetch.apply(this, arguments);
  };

  log('排查结束。看上面 OK/FAIL 行：');
  log('  · FAIL 在 cookie/登录 → 重新登录 qwen');
  log('  · FAIL 在 baxia 脚本/fetch 未改写 → bx-ua 算不出，子 agent 必撞墙（检查是否被广告拦截/隐私模式挡了 alicdn 脚本）');
  log('  · completions 拿到 event-stream 但子 agent 仍被风控 → 问题在 SW 复用旧 bx-ua（broker 缓存过期未 invalidate），让我看 SW console 的 RGV587 retry 日志');
})();
