// Bilingual (zh / en) strings for the landing page. Default is Chinese.
// Elements carry data-i18n="key"; applyLang() swaps textContent by key.

export type Lang = 'zh' | 'en'

type Dict = Record<string, { zh: string; en: string }>

export const strings: Dict = {
  'nav.how': { zh: '工作原理', en: 'How it works' },
  'nav.core': { zh: '核心能力', en: 'Capabilities' },
  'nav.features': { zh: '能力', en: 'Features' },
  'nav.platforms': { zh: '支持平台', en: 'Platforms' },
  'nav.security': { zh: '安全', en: 'Security' },

  'hero.eyebrow': { zh: '开源 · 本地优先', en: 'open-source · local-first' },
  'hero.h1a': { zh: '网页 AI，接管你的', en: 'Web AI, meet your' },
  'hero.h1b': { zh: '本地环境', en: 'local machine' },
  'hero.lede': {
    zh: 'PierCode 把 ChatGPT、Claude、Gemini、Qwen、Kimi 连接到你的文件系统和浏览器。AI 输出工具调用，Chrome 扩展代理到本地沙箱服务器——读文件、改代码、跑命令、操作浏览器，全程经你批准。',
    en: 'PierCode connects ChatGPT, Claude, Gemini, Qwen & Kimi to your filesystem and browser. The AI emits tool calls; a Chrome extension proxies them to a sandboxed local server that reads files, edits code, runs commands, and drives the browser — with your approval.',
  },
  'hero.cta1': { zh: '开始使用', en: 'Get Started' },
  'hero.cta2': { zh: '阅读文档', en: 'Read the docs' },
  'hero.trust': { zh: '无需复制粘贴。不上传云端。运行在', en: 'No copy-paste. No cloud upload. Runs on' },

  'chat.approve': { zh: '执行', en: 'Run' },
  'chat.skip': { zh: '忽略', en: 'Skip' },
  'chat.bg': { zh: '后台执行', en: 'Background' },
  'chat.badge': { zh: '✅ 已执行', en: '✅ Executed' },
  'chat.warn': { zh: '⚠️ 注意：可能改写文件', en: '⚠️ Note: may modify the file' },

  // User opening request
  'chat.u1': { zh: '把服务器默认端口从 8080 改成 39527，然后跑下测试', en: 'Change the default port from 8080 to 39527, then run the tests' },
  // AI intro lines + results, interleaved with tool cards
  'chat.a1': { zh: '好的，先找到端口定义的位置：', en: 'Sure — first let me find where the port is defined:' },
  'chat.r1': { zh: '找到 1 处：cmd/server/main.go:18', en: 'Found 1 match: cmd/server/main.go:18' },
  'chat.a2': { zh: '读一下上下文确认：', en: 'Let me read the surrounding code:' },
  'chat.r2': { zh: 'port := flag.Int("port", 8080, "listen port")', en: 'port := flag.Int("port", 8080, "listen port")' },
  'chat.a3': { zh: '改这一行：', en: 'Applying the edit:' },
  'chat.r3': { zh: '✓ 已替换 1 处：8080 → 39527', en: '✓ replaced 1 occurrence: 8080 → 39527' },
  'chat.a4': { zh: '跑测试验证：', en: 'Running the tests:' },
  'chat.r4': { zh: 'ok  github.com/sirhap/piercode  (cached)', en: 'ok  github.com/sirhap/piercode  (cached)' },
  'chat.done': { zh: '端口已改为 39527，测试全部通过 ✅', en: 'Port is now 39527 and all tests pass ✅' },

  'how.h2': { zh: '工作原理', en: 'How it works' },
  'how.sub': { zh: '每次工具调用，四个步骤。', en: 'Four steps, every tool call.' },
  'how.s1t': { zh: 'AI 输出工具块', en: 'AI prints a tool block' },
  'how.s1d': { zh: '助手在回复里输出一个可见的 piercode-tool JSON 代码块。', en: 'The assistant outputs a visible piercode-tool fenced JSON block in its reply.' },
  'how.s2t': { zh: '扩展检测到它', en: 'Extension detects it' },
  'how.s2d': { zh: 'Chrome 扩展识别代码块并在页面上弹出批准卡。', en: 'The Chrome extension spots the block and shows an approval card on the page.' },
  'how.s3t': { zh: '本地服务器执行', en: 'Local server executes' },
  'how.s3d': { zh: '127.0.0.1 上的 Go 服务器校验后在工作目录沙箱内执行。', en: 'A Go server on 127.0.0.1 validates and runs it inside the working-directory sandbox.' },
  'how.s4t': { zh: '结果回填', en: 'Result returns' },
  'how.s4d': { zh: '输出流回对话——AI 拿到真实的本地结果继续工作。', en: 'Output flows back into the chat — the AI keeps working with real, local results.' },

  'feat.h2': { zh: '真正的工具，不只是建议', en: 'Real tools, not suggestions' },

  // ── Core capabilities ──
  'core.h2': { zh: '不只是工具调用——是完整的 AI 开发平台', en: 'Not just tool calls — a full AI dev platform' },
  'core.sub': { zh: 'PierCode v2 的核心能力，让网页 AI 真正成为你的本地开发搭档。', en: 'PierCode v2 capabilities that turn web AI into your local dev partner.' },

  'core.1t': { zh: '多 Agent 协调', en: 'Multi-Agent Orchestration' },
  'core.1d': {
    zh: '一个 AI 当协调者，把子任务分发给多个 worker 页面并行执行。跨 tab 调度、结果自动回收、递归派生（最多 3 层）。每个 worker 独立对话、独立沙箱。',
    en: 'One AI acts as coordinator, dispatching sub-tasks to multiple worker pages in parallel. Cross-tab scheduling, automatic result collection, recursive spawning (up to 3 levels). Each worker has its own conversation and sandbox.',
  },
  'core.1h': { zh: 'spawn_agent · send_to_agent · stop_agent', en: 'spawn_agent · send_to_agent · stop_agent' },

  'core.2t': { zh: '多 AI 工作台', en: 'Multi-AI Workspace' },
  'core.2d': {
    zh: '浏览器内同时前台运行多个 AI——Qwen 写代码、Claude 做审查、ChatGPT 跑测试，全在一个画布里。告别 Chrome 后台节流，所有 AI 全速生成。',
    en: 'Run multiple AIs in the foreground simultaneously — Qwen writes code, Claude reviews, ChatGPT tests — all in one canvas. No more Chrome background throttling; every AI generates at full speed.',
  },
  'core.2h': { zh: 'Hub 画布 · 项目管理 · Agent 树', en: 'Hub canvas · project mgmt · agent tree' },

  'core.3t': { zh: '上下文压缩', en: 'Context Compression' },
  'core.3d': {
    zh: '对话 token 接近平台上限时，自动让模型压缩上下文并迁移到新会话。你的工作不会因为 token 耗尽而中断——压缩包携带完整上下文，新会话无缝接续。',
    en: 'When conversation tokens approach the platform limit, the model auto-compresses context and migrates to a new session. Your work never stalls from token exhaustion — the compressed packet carries full context for seamless continuation.',
  },
  'core.3h': { zh: '自动触发 · 熔断保护 · 手动/自动迁移', en: 'Auto-trigger · circuit breaker · manual/auto handoff' },

  'core.4t': { zh: '持久记忆', en: 'Persistent Memory' },
  'core.4d': {
    zh: 'AI 可以跨会话记住你的偏好、项目约定、常用命令。分全局记忆和项目记忆，每次对话开始时自动注入。不再每次从零开始。',
    en: 'The AI remembers your preferences, project conventions, and common commands across sessions. Global and project-scoped memory, auto-injected at conversation start. No more starting from scratch.',
  },
  'core.4h': { zh: 'memory_read · memory_write · memory_forget', en: 'memory_read · memory_write · memory_forget' },
  'feat.sub': { zh: '精简工具集，沙箱化、可审查。', en: 'A focused toolset, sandboxed and reviewable.' },
  'feat.1t': { zh: '读写代码', en: 'Read & write code' },
  'feat.1d': { zh: '在沙箱工作目录内检查和创建文件。', en: 'Inspect and create files inside the sandboxed working directory.' },
  'feat.2t': { zh: '精准编辑', en: 'Surgical edits' },
  'feat.2d': { zh: '精确字符串替换与多文件上下文补丁。', en: 'Exact string replacements and multi-file contextual patches.' },
  'feat.3t': { zh: '执行命令', en: 'Run commands' },
  'feat.3d': { zh: '带路径校验和危险命令过滤的 shell 执行。', en: 'Shell execution with path validation and a dangerous-command filter.' },
  'feat.4t': { zh: '搜索仓库', en: 'Search the repo' },
  'feat.4d': { zh: '按模式找文件，用正则搜内容。', en: 'Find files by pattern and search contents with regex.' },
  'feat.5t': { zh: '操作浏览器', en: 'Drive the browser' },
  'feat.5d': { zh: '约 25 个 CDP 工具——导航、点击、输入、快照、截图，均需批准。', en: '~25 CDP tools — navigate, click, type, snapshot, screenshot, with approval.' },
  'feat.6t': { zh: '规划与扩展', en: 'Plan & extend' },
  'feat.6d': { zh: '跟踪多步任务，按需加载可复用 skill。', en: 'Track multi-step work and load reusable skills on demand.' },

  'plat.h2': { zh: '在你常用的对话里就能用', en: 'Works where you already chat' },
  'plat.sub': { zh: '一个扩展，覆盖多个 AI 平台。', en: 'One extension, many AI surfaces.' },

  'sec.h2': { zh: '本地优先的设计', en: 'Local by design' },
  'sec.sub': { zh: 'AI 能碰什么，由你决定。', en: 'You decide what the AI can touch.' },
  'sec.1t': { zh: '仅回环地址', en: 'Loopback only' },
  'sec.1d': { zh: '服务器绑定 127.0.0.1，绝不暴露公网端口。', en: 'The server binds 127.0.0.1 and never exposes a public port.' },
  'sec.2t': { zh: 'Token 认证', en: 'Token auth' },
  'sec.2d': { zh: '每次启动生成 token，存于 ~/.piercode，每个请求都要带。', en: 'Every request needs a per-launch bearer token stored in ~/.piercode.' },
  'sec.3t': { zh: '路径沙箱', en: 'Path sandbox' },
  'sec.3d': { zh: '路径经真实路径解析校验，始终留在工作目录内。', en: 'Paths resolve through real-path checks and stay inside your working directory.' },

  'start.h2': { zh: '快速开始', en: 'Quick start' },
  'start.sub': { zh: '三步拥有本地 AI 智能体。', en: 'Three steps to a local AI agent.' },
  'start.1t': { zh: '启动服务器', en: 'Run the server' },
  'start.2t': { zh: '构建扩展', en: 'Build the extension' },
  'start.3t': { zh: '在 Chrome 加载', en: 'Load it in Chrome' },
  'start.cta1': { zh: '在 GitHub 点 Star', en: 'Star on GitHub' },
  'start.cta2': { zh: '阅读 FAQ', en: 'Read the FAQ' },

  'foot.fine': { zh: '仅供学习和研究使用。并非面向不可信提示词的安全沙箱。', en: 'For learning and research only. Not a hardened sandbox for untrusted prompts.' },
}

const KEY = 'piercode-lang'

export function getLang(): Lang {
  const saved = localStorage.getItem(KEY)
  if (saved === 'en' || saved === 'zh') return saved
  return 'zh' // default Chinese
}

export function setLang(lang: Lang) {
  localStorage.setItem(KEY, lang)
  applyLang(lang)
}

export function applyLang(lang: Lang) {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n!
    const entry = strings[key]
    if (entry) el.textContent = entry[lang]
  })
  // Update the toggle button label to show the OTHER language.
  const btn = document.getElementById('lang-toggle')
  if (btn) btn.textContent = lang === 'zh' ? 'EN' : '中文'
}
