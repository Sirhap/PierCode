# PierCode 落地页重设计 — 硬核绿磷光 CRT 终端

> 2026-06-09 · 全新落地页(从零) · 替换现有 `site/` Vite 构建

## 目标

把 PierCode 的 GitHub Pages 落地页(`site/`)从"通用暗色终端风"(Catppuccin 大众配色、系统字体、居中段落、蓝绿渐变)重做成一个**记得住的硬核绿磷光 CRT 终端**。访客的体感应是"登录进 PierCode 的终端",而非浏览一张营销页。

内容**全保留**(现有所有 section),但重组为一次"从开机到任务完成的终端会话"叙事。双语(zh 默认 / EN 切换)保留,活聊天 demo 保留并 CRT 化,CRT 动效做重。

非目标:不改 `docs/`(Jekyll 文档站),不改 Pages 部署 workflow 的结构(仅可能因去掉 three 依赖而让 `npm ci` 更快)。

## 美学方向

### 调色板(单色绿磷光,极少量点缀)

```
--crt-bg:        #0a0e0a   屏底黑绿
--crt-bg2:       #0c130c   面板底
--crt-bg3:       #0f1a0f   抬升面板
--phosphor:      #33ff66   主荧光绿(标题/命令/强调)
--phosphor-dim:  #1f9943   暗绿(正文/次要文字)
--phosphor-mute: #146b30   最暗(注释/分隔/边框)
--phosphor-glow: rgba(51,255,102,.45)   辉光
--amber:         #ffb000   警告 / 危险命令 / 危险高亮
--cyan:          #00d3f2   平台点缀 + 链接 hover(用量极少,做冷暖对比锚点)
--scanline:      rgba(0,0,0,.28)
```

设计原则:**单一主色统治屏幕**,amber 只用于警告,cyan 只用于平台点 + 链接 hover。冷暖对比稀有才有冲击。

### 字体

- 主导:`JetBrains Mono`(标题超大号 + 重字重;正文/代码同字族)。
- 中文 fallback:思源等宽 / 系统等宽(`"Sarasa Mono SC", "Noto Sans Mono CJK SC", monospace`)。
- 通过 `@fontsource` 或 CDN/woff2 自托管二选一 → **自托管 woff2**(Pages 无外链依赖、离线可用、SEO 稳)。放 `site/public/fonts/`,`@font-face` 引入,`font-display: swap`。

### CRT 重动效(全套)

1. **开机加载序列(boot.ts)** — 首屏先全黑,逐行打印启动日志:
   ```
   PierCode v2 · local AI bridge
   [ OK ] mounting workspace sandbox
   [ OK ] binding 127.0.0.1:39527
   [ OK ] loading tool registry (read_file, edit, exec_cmd, browser_*, …)
   [ OK ] extension relay ready
   ▸ session ready_
   ```
   每行带 `[ OK ]`(绿)前缀逐行出现,~1.1–1.3s 总时长,末行光标闪。完成后覆盖层"上电"淡出(扫描线扫过 + 短暂过曝白闪),hero 内容淡入。
   - `prefers-reduced-motion`:跳过整个序列,直接显示 hero。
   - 只在每个浏览器首次访问跑一次(`sessionStorage` 记忆),刷新不重复折磨用户。
2. **扫描线 overlay** — 固定全屏 `position:fixed` 伪元素:`repeating-linear-gradient` 横扫描线(2px 周期)+ 一条缓慢纵向滚动的高光带。`pointer-events:none`,`z-index` 高于内容但不挡交互。
3. **CRT 暗角 + 辉光** — body `box-shadow: inset` 四角暗角;关键文字 `text-shadow` 荧光晕(`0 0 6px var(--phosphor-glow)`)。
4. **打字机** — hero 主标题逐字打,块状光标 `█` 1s steps 闪烁。
5. **活聊天 demo(chatdemo.ts)** 重做为 CRT 审批流:用户请求"改端口 8080→39527 再跑测试" → AI 逐行输出工具调用(grep / read_file / edit / exec_cmd) → 每个工具弹绿磷光审批卡(自动"执行"高亮)→ 结果逐行回填 → 完成总结。打字 + 逐行 reveal。
6. **轻微色差**(克制):辉光层叠加 ≤1px 的红/蓝偏移做 chromatic aberration,仅在大标题上,reduced-motion 关。
7. **背景 canvas(crt.ts)** 替代 Three.js `grid.ts`:轻量 2D canvas **稀疏字符雨 + 网格**——暗绿网格 + 偶发下落的单字符(工具名/十六进制),低密度、低帧率(节流到 ~24fps)。移动端 / reduced-motion 用纯 CSS 扫描线静态 fallback,不启 canvas。

## 叙事结构(全保留内容,重组为"会话流")

整页从上到下读起来像一次终端会话:开机 → 提示符 → 执行 → 完成 → 退出。

| # | Section | 终端化处理 | 来源(现状映射) |
|---|---------|-----------|----------------|
| 0 | **Boot** | 开机日志覆盖层(~1.2s,可跳过) | 新增 |
| 1 | **Hero** | `$ piercode` 提示符 + 打字机标题 + 副本 + CTA + 右/下活聊天 demo 面板 | 现 Hero + chat demo |
| 2 | **工作原理** | `> how it works` 段标,4 步终端卡 `[1]..[4]`,用 `→` 管道连线 | 现 How(4 步) |
| 3 | **核心能力** | `## CAPABILITIES` ASCII 段标,4 大能力大面板(多Agent协调 / 多AI工作台 / 上下文压缩 / 持久记忆),每面板底部 `$ highlight` 命令行 | 现 Core(4) |
| 4 | **工具** | `$ piercode --list-tools` 输出风,6 工具等宽卡 | 现 Features(6) |
| 5 | **平台墙** | `> connected surfaces`,8 平台做带状态点的"进程列表"(cyan 点) | 现 Platforms(8) |
| 6 | **安全** | `[SECURITY]` 三项,amber 警告框样式 | 现 Security(3) |
| 7 | **快速开始** | 3 步 `$` 命令块,点击复制(`navigator.clipboard`,带"copied"反馈) | 现 Quick start(3) |
| 8 | **Footer** | `// exit 0 — for research only` 风,免责声明 + 链接 | 现 Footer |

导航(sticky 顶栏)保留锚点 + EN/中文切换 + GitHub CTA,样式 CRT 化(`▌PierCode` 品牌 + 闪烁块)。

## 组件拆分与职责

每个文件单一职责,可独立理解/测试:

| 文件 | 职责 | 依赖 |
|------|------|------|
| `site/index.html` | 静态骨架:所有 section 容器、SEO/OG/JSON-LD meta、boot 覆盖层 DOM、扫描线 overlay DOM | css, main.ts |
| `site/src/styles/main.css` | 绿磷光 CRT 设计系统:变量、@font-face、扫描线/暗角/辉光、所有 section 样式、响应式、reduced-motion | — |
| `site/src/main.ts` | 启动编排:跑 boot → 渲染数据 section → applyLang → reveals → 启 crt 背景 → 接 chat demo → 绑定语言/复制按钮 | 其余全部 |
| `site/src/boot.ts` | 开机加载序列:逐行打印启动日志,完成回调淡出;reduced-motion / 已访问过则 resolve 立即返回 | i18n(日志行可选本地化,英文为主) |
| `site/src/crt.ts` | 背景 canvas:稀疏字符雨 + 网格,节流 raf,reduced-motion/mobile 不启 | — |
| `site/src/chatdemo.ts` | CRT 审批流逐行演示(打字 + 工具卡 + 结果) | i18n |
| `site/src/data.ts` | 数据驱动 section 的内容数组(核心能力 / 工具 / 平台) | — |
| `site/src/i18n.ts` | zh/en 字符串 + applyLang/get/set;按新文案调整 | — |

删除:`site/src/scenes/grid.ts`、`three` + `@types/three` 依赖。

## 数据流

1. `main.ts` 入口 → 判定 reduced-motion / 是否首访。
2. `boot.run()` 返回 Promise;reduced-motion 或非首访立即 resolve。
3. resolve 后:`renderCore/Tools/Platforms()` 注入 DOM(带 `data-i18n` key)→ `applyLang(getLang())` 本地化(默认 zh)→ `initReveals()`(GSAP ScrollTrigger 加 `.in`)→ `initCRT()`(非 mobile/非 reduced)→ `runChatDemo()` 启动 demo 循环。
4. 语言切换按钮 → `setLang()` → 重新 `applyLang()`(对静态 + 已渲染节点)。
5. 快速开始命令块点击 → `clipboard.writeText` → 临时切 `copied` 文案。

## 错误处理 / 降级

- `prefers-reduced-motion: reduce`:跳过 boot、打字机、字符雨、色差;所有 `.reveal` 直接显示;扫描线降为极淡静态。
- `<noscript>`:CSS 让 `.reveal{opacity:1}`、隐藏 boot 覆盖层;内容静态可读(SEO 友好)。
- 字体加载失败:`monospace` 系统等宽兜底(`@font-face` `font-display:swap`)。
- canvas 初始化异常:`try/catch`,失败静默,CSS 扫描线仍在。
- 移动端(`max-width:900px`):不启 canvas;栅格塌成单/双列;终端面板去 3D 透视。
- clipboard 不可用:降级为选中文本提示,不报错。

## 测试

落地页是纯静态前端,无单测框架。验证手段:

1. `cd site && npm install && npm run build` 构建通过(无 three 依赖)。
2. `npm run preview` 本地起站,人工核对:boot 序列、扫描线、打字机、chat demo、语言切换、复制按钮、滚动 reveal、各 section 渲染。
3. 移动端窄屏 / `prefers-reduced-motion` 两种降级路径核对。
4. `npx tsc --noEmit`(site 有 tsconfig)类型检查通过。
5. SEO:`view-source` 确认 meta/OG/JSON-LD 完整、首屏文本可被无 JS 抓取。
6. (可选)`node scripts/browser-smoke.mjs` 不覆盖此站;手动 Chrome 核对即可。

## 部署影响

- `pages.yml` 不变:仍 `working-directory: site` → `npm ci && npm run build` → `site/dist` 作 artifact 根,Jekyll docs 进 `/docs`。
- `vite.config.ts` 保留 `base:'/PierCode/'`。
- 去掉 three 后 `package-lock.json` 重生成,`npm ci` 更快、artifact 更小。
- 新增 `site/public/fonts/*.woff2` 自托管字体,随 `dist` 一起部署。

## 风险

- **字体体积**:JetBrains Mono + 中文等宽 woff2 可能偏大。缓解:仅自托管 JetBrains Mono(拉丁/数字/符号),中文走系统等宽 fallback(中文标题量少,可接受);或 subset。先用 JetBrains Mono regular+bold 两档。
- **boot 序列折磨感**:控制 ≤1.3s + sessionStorage 单次 + reduced-motion 跳过。
- **可读性**:纯绿单色正文长段可能累;正文用 `--phosphor-dim` 降饱和、行高放宽,标题才上满荧光 + 辉光。
