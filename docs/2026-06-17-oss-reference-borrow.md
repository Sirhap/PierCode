# 开源对标 · 可借鉴点代办

> 调研日期: 2026-06-17
> 方法: 拉三个最相关开源项目的 README/源码实拆,非凭记忆。
> 配套 TaskList #1–#10(同序号)。

## 对标项目定位

PierCode 独特组合 = **网页 AI(非 API)输出工具 fence → 扩展检测 → 本地 Go 沙箱执行 + browser_* CDP 自动化 + 网页内 spawn 子 agent + 多平台风控绕过**。无单一开源项目占全。三个生态交叉点上的最近邻:

| 项目 | 仓库 | 关系 | 借它什么 |
|------|------|------|----------|
| **openchrome** | [shaun0927/openchrome](https://github.com/shaun0927/openchrome) | CDP 浏览器自动化 MCP(方向相反:API 推理→驱动浏览器) | browser_* 可靠性层(最富) |
| **webcode / WebMCP** | [three-water666/WebMCP](https://github.com/three-water666/WebMCP) | 理念双胞胎:网页 AI→本地工具,只是宿主=VSCode | 成熟工程件 + 验证方向 |
| **nanobrowser** | [nanobrowser/nanobrowser](https://github.com/nanobrowser/nanobrowser) | MV3 多 agent 网页自动化(Operator 开源替代) | agent 分工范式 |

**核心洞察**: openchrome 全套招数 = "server 内自纠,不烦 LLM"。PierCode 白嫖网页订阅,每次工具往返成本 = 用户额度 + 延迟,比 API 更该省轮次 → 这套确定性恢复层对 PierCode 价值 > 对普通 API-agent。

---

## 代办清单

### 🥇 第一优先(browser_* 核心可靠性,配合 SW-direct 迁移一起设计)

**#1 · Outcome Contract — 工具返回真实结果枚举**
- 来源: openchrome
- 借鉴: 工具返回 `SUCCESS / SILENT_CLICK / WRONG_ELEMENT` 真实交互结果,非默认"猜成功了"。配 Outcome Contract 做断言式校验,无需 LLM 判断。
- 现状: browser_* 点击后若未生效,网页 AI 不知道,无法自纠。
- 落地: `internal/browser/controller*.go` 点击/输入类工具加结果判定(点后校验 DOM 变化/焦点/可见性),返回结构化 outcome 字段。
- **这是 #2/#4/#5 的信号源,先做。**

**#2 · Ralph 交互瀑布 — 点击 7 级降级**
- 来源: openchrome
- 借鉴: AX click → CSS 选择器 → CDP 坐标 → JS 执行 → 键盘 → 裸鼠标 → 升级人工。每级失败自动降级。
- 现状: 点击疑似单路径,失败即失败。
- 落地: browser click/type 工具内实现降级链,每级靠 #1 的 outcome 判定是否生效。最高 ROI 之一。

### 🥈 第二优先(缺口明显 / 省网页轮次)

**#3 · 读 repo 的 CLAUDE.md/AGENTS.md 自动注入**
- 来源: webcode/WebMCP
- 借鉴: 读 workspace 根的 AGENTS.md/CLAUDE.md 定制 AI 行为。
- 现状: 缺。工程 agent 标配。
- 落地: `internal/prompt/` 渲染时,RootDir 存在 CLAUDE.md/AGENTS.md 则读入作 `{{PROJECT_RULES}}` 占位注入 init_prompt。改动小。

**#4 · Hint Engine 雏形 — server 内拦错误模式**
- 来源: openchrome(30+ 规则)
- 借鉴: server 侧拦 错误→恢复 模式,不走 LLM 往返就纠正(虚拟化列表/遮挡/未加载等)。
- 现状: 无。
- 落地: browser 工具执行后插一层规则检查,命中常见失败把修正提示拼进工具结果。先做 5–10 条高频规则。**对白嫖网页 AI 的 ROI 最高(省订阅额度+延迟)。**

**#5 · Circuit Breaker — 3 级失败隔离**
- 来源: openchrome
- 借鉴: element/page/global 三级断路器,永久坏元素不无限重试,超阈值升级/停止。
- 现状: 已有 renderer-crash 恢复(c8566de)+ targetCrashed 处理,缺"防 AI 对坏元素死磕"层。
- 落地: controller 加 element/tab/global 维度失败计数与熔断,超阈值返回明确"不可用"。依赖 #1 的失败信号。

### 🥉 第三优先(局部增强 / 中期)

**#6 · closed shadow root 穿透补全**
- 来源: openchrome(穿 open+closed)
- 现状: commit 2e4452c 已穿 open shadow root,仅 open。
- 落地: element collectors 用 CDP DOM pierce / backendNodeId 路径穿 closed。补已有工作缺口。

**#7 · backendNodeId 稳定寻址 + DOM 序列化 token 压缩对标**
- 来源: openchrome(DOM mode 紧凑文本+affordance 标记,5–15x 压缩;元素带稳定 backendNodeId 跨调用)
- 现状: 已有 accessibility snapshot(`internal/browser/snapshot.go`)。
- 落地: (1) 评估当前 snapshot token 占用 vs openchrome 紧凑格式;(2) 元素引用改用稳定 backendNodeId,使同一元素跨多次调用一致寻址,避免快照刷新后引用失效。

**#8 · init context 超长转附件上传**
- 来源: webcode/WebMCP
- 借鉴: init context 超输入框上限时转附件,用户确认后发送。
- 现状: init prompt 直接塞输入框,网页有长度墙。
- 落地: content/platform-adapter 注入 init prompt 时,超平台上限则走文件/附件上传(各 adapter 已有上传能力)绕过长度墙。

**#9 · Planner/Navigator 分层选模型(非对称)**
- 来源: nanobrowser
- 借鉴: Planner(强模型规划)+ Navigator(弱模型执行)非对称角色,按性能层分配模型,省钱又稳。
- 现状: 侧边栏 API 子 agent(`background/chat-api.ts` runSubAgent)同质 worker。
- 落地: spawn_agent 可指定 role/model,coordinator 强模型出计划、worker 便宜模型执行。中期,先把同质架构验稳。

**#10 · 显式触发前缀 /piercode @piercode(可选模式)**
- 来源: webcode/WebMCP(/webcode、@webcode 显式触发)
- 借鉴: 显式前缀触发,减少 fence 误检 + 用户控制启用时机。
- 现状: 靠扫 piercode-tool fence,有 session-gating 误检历史。
- 落地: 加可选"显式触发模式",仅当用户消息带前缀才激活该轮检测,作默认全扫描的补充开关。低优先,体验向。

---

## 差异化备忘(PierCode 赢在哪)

webcode 证明"网页 AI→本地"方向有人验证(非孤例)。PierCode 差异化领先:
- 多 **8** 平台网页适配(webcode 仅 3)
- Go 沙箱**独立**(不绑 VSCode,插件可单独用)
- browser_* CDP 自动化套件(~44 工具)
- 网页内 **spawn 子 agent** + 侧边栏 API 子对话双路线
- 多平台**风控绕过**(qwen bx-ua / chatgpt turnstile 等)

这些 webcode / openchrome / nanobrowser 都没有全。借鉴是补可靠性短板,不是抄定位。

---

## 附录 A · webcode 深挖(理念双胞胎,逐文件拆)

> 2026-06-17 二次深挖:拉了 webcode monorepo 结构 + doc/ 全部 18 篇指南。
> 仓库: [three-water666/WebMCP](https://github.com/three-water666/WebMCP)(实际产品名 webcode;另有 Chrome 商店版叫 "WebMCP Bridge",VSCode 扩展 "WebMCP Gateway")。

### 仓库结构(monorepo, pnpm workspace)
```
bridge-browser/    # 浏览器桥接扩展(MV3): manifest.json + bridge_marker.js(content script) + offscreen.html + src/
gateway-vscode/    # VSCode 扩展 = 本地 Gateway server(执行工具)
shared/            # bridge ↔ gateway 共享类型/协议
doc/               # 18 篇指南(中英双份)
```
对照 PierCode: `bridge-browser`≈你 `extension/`,`gateway-vscode`≈你 `cmd/server`+`internal/`。**你 Gateway 是独立 Go server,它绑 VSCode** — 你这点更解耦(插件可单独用)。

### webcode 内置工具清单(对照 PierCode)
| webcode 工具 | 行为 | PierCode 对应 | 差距 |
|------|------|--------------|------|
| `read_file` | head/tail/start_line/end_line/show_line_numbers 范围读 | read_file(offset/limit) | 对齐 |
| `write_file` | 全量替换 | write_file | 对齐 |
| `edit_file` | **精确文本替换 或 unified diff patch + `dryRun` 预览** | edit/multi_edit/apply_patch | **缺 dryRun → 任务#11** |
| `search_files` | ripgrep 文件名/路径,默认忽略大小写,尊重 ignore | glob | 对齐 |
| `search_code` | ripgrep 内容,返相对路径+行号+匹配行,regex | grep | 对齐 |
| `execute_command` | 短命后台 POSIX/bash,返 stdout/stderr | exec_cmd | 对齐 |
| `run_in_terminal` | **可见 VSCode 集成终端**,持久,立即返 session_id | exec_cmd(background)+task_* | 浏览器无终端 UI,概念 N/A |
| `terminal_session` | action=list/read/stop 管理会话 | task_list/task_output/task_stop + send_stdin | 对齐 |

**路径约束**(可借鉴措辞):全工具要求 **workspace 相对路径 + `/` 分隔符;拒绝绝对路径、home 路径、反斜杠**。你 SafePath 做沙箱校验,但报错措辞可更明确。

### Bootstrap-only 工具(双阶段工具集隔离)— PierCode 缺
webcode 把工具分两组:
- **初始化期专用**: `get_project_rules` / `get_project_context` / `list_tools` / `list_skills` — 模型正式交互期**不可见**。
- **交互期**: 文件/命令工具。
PierCode 现状:工具全程可见。**可考虑**:把"列工具/读项目规则"做成仅 init 期注入,减少交互期工具表噪声。低优先,未建任务(收益不确定)。

### Prompt 6 层拼装 — PierCode 已超越 ✅
webcode init prompt 顺序:① 公共 base → ② 站点专属(`<siteId>_<lang>.md`,缺省回落公共)→ ③ 项目规则 → ④ 项目上下文 → ⑤ Available Tools → ⑥ Available Skills。

**PierCode `internal/prompt/profile.go` 的 `ProfileRegistry` 已实现等价且更强**:
- 按 profile(=siteId)分层 ✅(qwen/worker/browser-agent profile)
- PromptAppend(站点专属追加)✅
- 工具过滤 ToolNames/ToolNamePrefixes ✅(webcode 无此粒度)
- ContextHandoff 每调用追加 ✅(webcode 无)
- 渲染缓存(renderCacheKey)✅
- {{SYSTEM_INFO}}/{{TOOLS}}/{{SKILLS}} 占位 ✅
- memory.AppendMemoryDoc ✅

→ **唯一缺口 = 不读 repo 根的 CLAUDE.md/AGENTS.md(webcode 的"项目规则"层)= 任务#3**。你读自己的 memory,但不读用户 repo 的规则文件。

### ChatGPT 专属 prompt 坑 — 任务#12
webcode PLATFORM_PROMPT_GUIDE 明示:ChatGPT 要警告 AI **别误用 `python_user_visible`** 原生工具(会输出 "noop"/占位)。→ 给你 ChatGPT profile 加约束。

### 独立浏览器 profile + keepalive(可选借鉴,体验向)
webcode "isolated browser mode":
- 开**专用 Edge profile**(与日常浏览隔离),自动加载内置 bridge,**加 keepalive flags**。
- 先开 bridge 页,**握手成功后才跳转目标 AI 站**。
- profile 持久在 OS 目录,VSCode 卸载后仍在;可配 `isolatedBrowser.profileRoot`。
- 登录态隔离:在隔离 profile 内登录一次目标站。
- **第三方登录跳转时:bridge 暂停页能力 + 保留 session,回到目标站自动恢复**。

PierCode 现状:靠用户自己装扩展进日常 Chrome。你的 keep-alive 走 page-bridge visibility shim(更轻,不需独立 profile)。webcode 这套适合"开箱即用一键启动"场景。**未建任务**(你 shim 方案已解决后台节流核心痛点;独立 profile 是产品打包决策,非技术缺口)。

### bridge 握手 / 会话状态机(实现参考)
- 握手字段: `siteId` / `targetOrigin` / `targetUrl`。
- 会话状态: `active` / `missing` / `invalid` / `suspended`(suspended = 第三方登录跳转期暂停)。
- 工具结果回传:页面刷新后 webcode 重扫页面并**重跑 tool-result 投递流程**(处理未完成工具调用)— 你 conversation-scope 的 isExecuted 去重 + 刷新重扫是同类问题,你已处理更细(URL migration alias)。

### webcode 没有、PierCode 已有的(差异化护城河)
- 多 **8** 平台(webcode 仅 ChatGPT/Gemini/DeepSeek 3)
- browser_* CDP 自动化(~44 工具)— webcode 无浏览器自动化(它只做文件/命令)
- 网页内 spawn 子 agent + 侧边栏 API 子对话
- 风控绕过(qwen bx-ua / chatgpt turnstile)
- 上下文压缩 + 跨会话 handoff
- ProfileRegistry 工具过滤粒度

### webcode 借鉴净增量(去重已有后,真正该做的)
1. **#11 edit dryRun 干跑预览** ← edit_file 的 dryRun
2. **#3 读 CLAUDE.md/AGENTS.md** ← 项目规则层(唯一 prompt 缺口)
3. **#12 ChatGPT python_user_visible 警告** ← 平台坑
4. (可选)路径拒绝措辞更明确 / Bootstrap-only 工具隔离 — 低优先,未建任务

---

## 附录 B · webcode 源码级深挖(clone 仓库读源码,非 doc 摘要)

> 2026-06-19 三次深挖:`git clone` webcode 读 `bridge-browser/src` 源码体。
> doc 指南只讲用法,**真正的工程坑解在源码里** — 且大量是 PierCode 同领域问题(对照 memory 里踩过的坑)。

### bridge-browser/src 关键文件(全是 PierCode 同类问题)
```
content/completion_notifier.ts        # AI 答完检测状态机
content/tool_call_tracker.ts          # 工具调用追踪 + 稳定化防截断
content/virtualized_history_skip.ts   # 虚拟列表旧调用跳过
content/tool_request_registry.ts      # 请求去重/结果存储
content/approval_policy.ts            # 审批策略(命令级粒度)
modules/toolCallProtocol.ts           # 协议校验(JSON envelope)
modules/jsonRepair/ (6 文件)          # 残缺 JSON 修复引擎
modules/command_approval.ts           # 命令档位匹配
modules/result_delivery.ts            # 结果回传
background/session_health.ts          # 会话健康
```

### 源码级净增量(逐个对照 PierCode 现状)

**#13 · JSON 修复引擎 ⭐⭐**(`modules/jsonRepair/`)
- `parseModelJson`: strict `JSON.parse` → 失败则 `buildRepairCandidates` 生成多候选逐个试。
- 松散语法容错: 单引号→双引号、尾逗号、智能引号 `“”`→`""`、缺闭合补全。保留原始 error 指向模型输出。
- **PierCode**: memory `fence-truncation-phantom-tool` 只有花括号配对(commit a52844b)= 结构判定。**无松散语法修复**。网页 AI 常出智能引号/尾逗号(尤其中文输入法)→ 真增量,与花括号配对互补。

**#14 · 稳定化复查窗口 ⭐⭐**(`content/tool_call_tracker.ts`,`STABILIZATION_TIMEOUT_MS=3000`)
- JSON 流式残缺时**不立刻判错**,记块文本+时间戳,文本 3s 不变才回填协议错误。文本变了重置。
- 源码中文注释直说:"把仍在生成的工具调用误判为失败"。
- request 身份: 显式 request_id → 否则 `req_auto_{msgIdx}_{blockIdx}_{hash(sig)}` 合成;dataset 缓存签名/scope,文本没变复用 id = 去重。
- **PierCode**: 你花括号配对=结构判定;webcode 时间稳定窗口=时序判定。**两者互补,可叠加**。

**#15 · 完成检测状态机 ⭐**(`content/completion_notifier.ts`)
- idle 判定 = **stop 按钮消失**(`isStopButtonVisible`),非靠文本停。
- `COMPLETION_SETTLE_MS=600` 沉降:idle 后等 600ms 再确认(防流式抖动)。
- signature = `messageIndex:hash(text)`,start→end 签名变了才算新回合完成。
- `notifiedCompletionKeys` Set 去重 + cooldown(1000ms)+ 上限 200 FIFO 驱逐。
- **PierCode**: 各 adapter 自检 streaming 结束,有 `session-gating` 误检史。这套 stop按钮+沉降+签名更稳。

**#16 · purpose 必填 + 顶层键白名单 ⭐**(`modules/toolCallProtocol.ts`)
- 工具调用 envelope: `{mcp_action:"call", name, purpose, arguments, request_id}`。
- **purpose 必填**(逼 AI 说明意图,审批卡可读+减乱调)。
- 顶层键白名单,多余键报错。校验失败回喂结构化 issues + 标准格式示例让模型重出。
- **PierCode**: piercode-tool fence DSL(非 JSON envelope)。**按自己格式适配 purpose + 畸形结构纠错回喂**,别照搬 mcp_action 信封。

**#17 · 命令级审批粒度 ⭐**(`content/approval_policy.ts` + `command_approval.ts`)
- 命令工具审批分 3 档持久化: `command-exact:`(精确串)/ `command-executable:`(可执行档,如 git 全放)/ `command-prefix:`(前缀档,如 `go test` 全放)。
- 用户批一次选档,存储;再来命中免批。
- **PierCode**: exec_cmd 靠 IsDangerousCommand 黑名单 + 每次批。**"记住此命令/可执行/前缀"持久化 = 减重复审批**。
- ⚠️ 安全: prefix 档防 `go test; rm -rf` 拼接绕过 → 匹配基于解析后可执行+参数,非裸字符串前缀。

**虚拟列表跳过**(`content/virtualized_history_skip.ts`)— 节流日志,标记虚拟化来源旧调用别重跑。PierCode conversation-scope `isExecuted` 去重应已覆盖(memory `live-verify-batch-isolation`),未单独建任务。

### webcode 源码体现的设计哲学(值得吸收)
1. **流式不确定性当一等问题**:稳定化窗口 + 沉降 + 签名,处处假设"文本还在变"。PierCode 网页检测同样面对流式,可系统化这套防抖。
2. **畸形输入必修复必回喂**:JSON repair + 协议 issues 回喂,不静默丢弃。
3. **去重靠内容签名 + dataset 缓存**,不靠单一 flag(对照 memory `tool-card-live-rerender` 烧死 key 问题,签名法更稳)。
4. **审批可记忆分档**,不是每次全批或全放。

### 临时 clone 位置
`/tmp/oss-ref/webcode`(会被清)。需要重看: `git clone --depth 1 https://github.com/three-water666/WebMCP.git`。同目录可一并 clone openchrome/nanobrowser 读源码。

---

## 任务总览(截至 2026-06-19)

| # | 标题 | 来源 | 优先级 |
|---|------|------|--------|
| 1 | browser_* Outcome Contract | openchrome | 🥇 |
| 2 | browser_* Ralph 交互瀑布 | openchrome | 🥇 |
| 3 | 读 CLAUDE.md/AGENTS.md 注入 | webcode | 🥈 |
| 4 | browser_* Hint Engine | openchrome | 🥈 |
| 5 | browser_* Circuit Breaker | openchrome | 🥈 |
| 6 | closed shadow root 穿透 | openchrome | 🥉 |
| 7 | backendNodeId 寻址 + DOM 压缩 | openchrome | 🥉 |
| 8 | init 超长转附件 | webcode | 🥉 |
| 9 | Planner/Navigator 分层 | nanobrowser | 🥉 |
| 10 | 显式触发前缀 | webcode | 低 |
| 11 | edit dryRun 预览 | webcode | 🥈 |
| 12 | ChatGPT python_user_visible 警告 | webcode | 🥈 |
| 13 | JSON 修复引擎 | webcode 源码 | 🥇 |
| 14 | 稳定化复查防截断 | webcode 源码 | 🥇 |
| 15 | 完成检测状态机 | webcode 源码 | 🥈 |
| 16 | purpose 必填 + 键校验 | webcode 源码 | 🥈 |
| 17 | 命令级审批粒度 | webcode 源码 | 🥈 |

**webcode 贡献 9 项**(#3/#8/#10/#11/#12/#13/#14/#15/#16/#17)— 确实"很多细节可借鉴",尤其源码层 #13/#14(直接打你 fence-truncation 痛点)。

---

## 附录 C · openchrome + nanobrowser 源码级深挖

> 2026-06-19 四次深挖:clone openchrome(1525 TS 文件,真生产项目非营销壳)+ nanobrowser(124 文件,精炼)读源码。
> **结论:openchrome README 吹的全是真的,源码比吹的还细。** `src/utils/ralph/` 全套实在。

### openchrome — README 营销 = 源码实锤 ✅

源码定位证实:`src/utils/ralph/{ralph-engine,circuit-breaker,strategy-learner,hitl-escalation}.ts` + `src/hints/{hint-engine,pattern-learner}.ts` + 11 条 `hints/rules/*.ts` + `src/failure/classifier.ts` + `src/contracts/` + `src/recovery/`。

**Ralph Engine — 8 级交互瀑布**(`utils/ralph/ralph-engine.ts`,比 README 的 7 多一级)
```
S1 AX树点击      → page.mouse.click @ AX解析坐标
S2 CSS发现点击    → 评分排序后 page.mouse.click @ CSS坐标(score<10 放弃,<50 标 LOW CONFIDENCE)
S3 CDP坐标       → Input.dispatchMouseEvent(绕 isTrusted)
S4 JS注入        → element.click() + dispatchEvent
S5 键盘导航      → DOM.focus + keyboard.press('Enter'/'Space')
S6 CDP裸事件     → 完整 mousePressed + mouseReleased
S7 视觉grounding → bbox 点击(gated,需 visualSnapshot)
S8 HITL          → 返结构化上下文给人工
```
- 每级后 `classifyOutcome` 判定 + `budgetMs=15000` 总预算 + `invalidateAXCache` 清缓存。
- 每级带 `backendDOMNodeId` + role + name + `withDomDelta`(DOM delta 判生效)。
- → **任务 #2 的完整参考实现**,直接照抄成 Go 版降级链。

**Outcome Classifier — 自带数据背书** ⭐⭐⭐(`utils/ralph/outcome-classifier.ts`)
- 源码注释金句:**"Skyvern proved adding outcome validation alone drove WebVoyager from 68.7% to 85.85%"**(只加 outcome 判定 = +17pt)。
- 判定:DOM delta 正则匹配 `SUCCESS_PATTERNS`(aria-checked/selected/expanded/pressed、class active|open|selected、URL changed、+dialog/modal/drawer/menu、form submit、scroll)→ SUCCESS;delta 空 → SILENT_CLICK;非 button 目标只出 tooltip/popover(`TOOLTIP_PATTERNS`: role=tooltip/cdk-overlay/mattooltip)→ WRONG_ELEMENT。
- 6 枚举 + ✓⚠✗⏱ 符号紧凑展示。"observation-only,不限制现有行为"。
- → **任务 #1 实现已确定,且有数据证明这是最高 ROI 单点改进**。

**Circuit Breaker — 标准状态机**(`utils/ralph/circuit-breaker.ts`)
- 三独立 scope:element(同 query 同 tab 失败 3 次→跳瀑布)/ page(同 tab 5 个不同元素失败→建议 reload,用 `Set<queryHash>` 计数)/ global(滑窗 5min 内 10 次失败→暂停)。
- `CLOSED → OPEN → HALF_OPEN → CLOSED` + **冷却自动重置(永不永久阻塞)**:element 2min / page 1min / global 5min。
- element key = `tabId:queryHash`。
- → **任务 #5 完整参考**。

**Hint Engine — 规则化非 LLM 判** ⭐(`hints/`)
- `HintRule = {name, priority, maxSeverity, match(ctx)→string|null}`。ctx 带 `toolName/resultText/isError/fireCounts`(Map,one-shot:同规则每会话只发一次)。
- priority 排序(error-recovery 100+，console-buffer 95)。11 条规则:blocking-page / error-recovery / pagination-detection / repetition-detection / snapshot-stale / success-hints / sequence-detection / composite-suggestions / setup-hints / learned-rules / console-buffer-pressure。
- `PatternLearner` 从历史学新规则(进阶)。
- → **任务 #4 架构已确定**:rule 链 + fireCounts one-shot + priority。

### nanobrowser — Planner/Navigator 编排范式(可直接抄给侧边栏子 agent)

**Executor 编排循环**(`chrome-extension/src/background/agent/executor.ts`)
- 一 task 双 LLM:`plannerLLM ?? navigatorLLM`(可同可分模型)。
- 主循环 `for step < maxSteps`:**每 `planningInterval` 步或 navigatorDone 时才跑 Planner**(非每步 → 省钱),其余步 Navigator 执行动作。
- `checkTaskCompletion`:Planner 输出 `done:true` → 完成,取 `final_answer`。
- 错误边界:`MaxStepsReachedError` / `MaxFailuresReachedError`。
- `addFollowUpTask`:完成后追加任务,过滤 `includeInMemory=false` 的旧结果(历史裁剪)。
- → **任务 #9**:你侧边栏 API 子 agent 是同质 worker,可引入周期规划 + 分层模型。

**Planner prompt 策略**(`prompts/templates/planner.ts`,文案可直接借)
- 强制 JSON:`observation/done/challenges/next_steps/final_answer/reasoning/web_task`。
- **`web_task` 分流**:非网页任务直接答(不调浏览器)= 省一整轮 → 任务 #18。
- viewport-first:"优先当前视口可见内容,滚动是最后手段,一次最多滚一页,别滚整页"。
- "知道直接 URL 就直连别搜"。
- **登录需求 → 标 done + 让用户自己登,别教怎么登**。
- `next_steps` 与 `final_answer` 互斥(done 时反过来)。
- "忽略其他 agent 消息的输出结构"(多 agent 混合历史防混淆)。
- → 任务 #18:web_task 分流 + viewport-first 文案。

### openchrome 设计哲学(整体吸收)
1. **silent failure 是头号敌人**:不是"点击报错",而是"点了没反应"。outcome 判定专治这个(Skyvern +17pt 实证)。
2. **永不放弃 + 永不死磕**:Ralph 8 级降级(never give up)叠 Circuit Breaker(坏元素 fail-fast,但冷却自重置)。两者一进一退平衡。
3. **确定性恢复优先于 LLM**:Hint Engine 规则化、recovery runtime server 内修,能不烦 LLM 就不烦(对白嫖网页 AI 是核心优势)。
4. **每个动作带可验证元数据**:backendDOMNodeId + role + name + DOM delta,不靠"我以为点了"。

### 三项目源码贡献净增量汇总
- **openchrome 6 项**(#1/#2/#4/#5/#6/#7)— 全有源码级参考实现,#1 还有数据背书。
- **nanobrowser 2 项**(#9/#18)— 编排循环 + prompt 策略可直接抄文案。
- **webcode 10 项**(#3/#8/#10–#17)。

### 临时 clone 位置(会被清)
```
/tmp/oss-ref/webcode      git clone --depth 1 https://github.com/three-water666/WebMCP.git
/tmp/oss-ref/openchrome   git clone --depth 1 https://github.com/shaun0927/openchrome.git
/tmp/oss-ref/nanobrowser  git clone --depth 1 https://github.com/nanobrowser/nanobrowser.git
```
落地任一项时拉对应源码精读。openchrome 的 ralph/hints 直接对照写 Go;nanobrowser 的 planner prompt 直接借文案;webcode 的 jsonRepair 直接移 TS。

