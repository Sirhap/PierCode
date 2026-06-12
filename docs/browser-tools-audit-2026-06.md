# 浏览器工具审计 2026-06 — 参考对标 + 改进清单

对标四个参考实现，找 PierCode 浏览器工具（39 个 `browser_*`）+ 虚拟光标的优化点与可新增工具。

**参考源：**
1. **Claude in Chrome 扩展 v1.0.75**（fcoeo…，Anthropic 官方，~20 MCP 工具）
2. **OpenAI Codex 扩展 v1.1.5**（hehgg…，Native Messaging + 裸 CDP）
3. **Claude Code CLI 还原源码**（`/Volumes/other/IdeaProjects/sirhao/Claude-Code`，prompt/技巧层）
4. **PierCode 自身代码审计**（20 项弱点）

原始抽取数据（92KB JSON）：`/tmp/ext-analysis/audit-raw.json`；美化后的扩展源码：`/tmp/ext-analysis/{claude,codex}/`。

---

## 一、参考实现核心机制

### Claude in Chrome（官方扩展）

- **工具面**：`computer`（13 个 action 复用一个工具：click/type/key/scroll/scroll_to/drag/hover/zoom/wait/screenshot）、`navigate`、`find`、`read_page`、`get_page_text`、`form_input`、`file_upload`、`upload_image`、`javascript_tool`、`read_console_messages`、`read_network_requests`、`resize_window`、`tabs_*`、`gif_creator`、`shortcuts_*`、`browser_batch`。
- **输入合成**：全部走 CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText`（真合成输入）；仅 `form_input` 用 DOM 赋值 + change/input 事件。type 逐字符 keyDown/keyUp（带虚拟键码），未映射字符回退 `insertText`。
- **虚拟光标**：每次鼠标 CDP 前先发 `UPDATE_PHANTOM_CURSOR {x,y}`，等 CSS `transitionend`（上限 250ms）再发真实事件——光标先行于点击。双层 SVG 箭头（白底 + #D97757 发光），`translate3d` + `180ms cubic-bezier(0.2,0,0,1)`，z-index 2147483646。配套：脉冲橙色内发光边框、底部 "Stop Claude" 按钮、"Claude is active" 常驻指示条、静音 AudioContext 保活。
- **ref 系统**：a11y 树缩进文本格式 + `[ref_N]`，背后 `window.__claudeElementMap` 存 WeakRef（自动 GC）；ref 解析坐标 = `scrollIntoView(block:center)` + `getBoundingClientRect` 中心。
- **find**：自然语言 → 调一次廉价模型（small_fast，maxTokens 800）在 a11y 树上选 ≤20 个候选，返回 `ref | role | name | reason`。
- **截图管线**：`Page.captureScreenshot`（fromSurface + clip）→ 1568px token 预算缩放 → JPEG 质量阶梯下调（0.75→0.10）控制 base64 < 1,398,100 字符；按 tab 缓存"截图上下文"做 zoom/截图像素 ↔ 视口坐标重映射。
- **安全**：每个变更动作前重读 `tab.url`，hostname 中途变化即中止（跨域守卫）；URL 分类（org/safety）重定向 blocked.html；权限 per-netloc allow/deny + once|always + turn-approved-domains；`stripExtensionInterference` 遍历 shadow DOM + frames 删除其它扩展注入的 iframe。
- **console/network**：attach 即 enable，按 tab 环形缓冲，跨域导航自动清空；console 工具描述强烈要求带 regex pattern。

### Codex 扩展

- **极简工具面**：一个泛化 `executeCdp`（裸 CDP 透传）+ `moveMouse`（光标）+ tab 租约工具。attach 时 `setDeviceMetricsOverride` 归一坐标。
- **虚拟光标**：弹簧动画、**closed shadow DOM**（防检测）、MutationObserver 自愈、`AGENT_CURSOR_ARRIVED` 到位回执后才发真实点击（无 sleep）。
- **Tab 租约**：claim = 同意边界（拒绝 chrome 内部页/跨会话）、finalize = 交付/关闭；chrome.tabGroups 分组 + favicon 角标。
- **健壮性**：PING 门控注入、控制期间推迟 SW reload。

### Claude Code（prompt/技巧层，最值得抄的文案）

- **会话启动契约**：先 `tabs_context_mcp`；永不复用陈旧 tabId；默认新建 tab；tab-not-found 即重新 list。
- **anti-rabbit-hole**（逐字）："Browser tool calls failing or returning errors after 2-3 attempts → stop and ask the user… Do not keep retrying the same failing browser action."
- **对话框死锁预防**：永不触发 alert/confirm/prompt（会阻塞扩展后续命令），调试用 console.log + read_console_messages。
- **批量化为核心优化**："whenever you can predict two or more steps ahead" 就用 batch；经济学表述：每次单独调用 = 一个模型→API 往返（数秒）。
- **批内坐标不变式**：本批所有坐标永远指向批前的全屏截图，不指向 zoom 或批中截图；批结束后最新全屏截图成为新基准。
- **token 有界读取 + 自纠错误**：read_page 50k 上限，超限报错文本本身指导"降 depth 或用 ref_id 聚焦"；find 超 20 个提示收窄 query。
- **点击精度文案**：点击前看截图；失败则"调整位置让光标尖端落在元素上"；"点元素中心，别点边缘"；zoom "liberally" 用于小元素。
- **输入合成细节**：点击/滚动前 50ms move-settle；只有 drag 用动画插值（其它瞬移，避免中间帧触发 hover）；剪贴板打字带读回校验 + finally 恢复；modifier 只释放实际按下的。
- **动态工具描述防注入**：安装应用列表字符白名单（单空格规则防 `App\nIgnore previous…`）、长度/数量上限、`<installed-apps>` DATA-ONLY 包裹。

---

## 二、PierCode 现状弱点（自审 20 项，重点）

| # | 弱点 | 位置 |
|---|------|------|
| 1 | `browser_find` TreeWalker 子树文本评分——祖先容器分数压过按钮本身；无可见性/遮挡过滤；输出脆弱 tag.class CSS 路径 | browser_tools_find.go |
| 2 | snapshot 扁平列表无层级缩进；文档序截断（折叠下内容静默消失）；无 depth/子树/分页 | internal/browser/snapshot.go |
| 3 | 无 iframe 支持（主 frame only）——Stripe 表单、嵌入编辑器不可见不可点 | 全链路 |
| 4 | ref 点击前无 scrollIntoView/视口断言——屏外 ref 静默 miss | controller.go resolvePoint |
| 5 | 无可操作性检查（visible/enabled/遮挡 elementFromPoint）；toast 吃掉点击仍报成功 | — |
| 6 | `browser_wait_for_navigation` 页面内轮询——真导航销毁 JS 上下文即报错；无 Page.loadEventFired/networkidle | — |
| 7 | console/network 懒 enable——首调前全丢（含加载期错误）；无 loadingFailed/响应体 | events.go |
| 8 | 每次 Input 强制 activateTab 抢焦点——与 keep-alive 后台哲学矛盾 | background activateTabForInput |
| 9 | 审批疲劳：每个变更动作单独弹窗，无站点/会话/动作类粒度 | approval.go |
| 10 | 点击同步弹 dialog 会 wedge（CDP 命令阻塞到超时）；无持久 per-tab auto-dialog policy | — |
| 11 | drag 只有裸鼠标事件 + 单中点——react-dnd/sortable 不响应 | controller_ext.go |
| 12 | cookies 默认 `includeValue=true`——session token 默认进第三方 AI 转录 | browser_tools_ext.go |
| 13 | 打字只有 `insertText`——keydown 监听的编辑器/自动补全不触发 | — |
| 14 | sidebar/API 模式截图只有文件路径无 vision 通道；browser_zoom 输出模型看不到 | — |
| 15 | IsSensitive 关键词误伤（payment/checkout 文档页硬拒），不可配置 | security.go |
| 16 | AX 节点少 bounds——几乎每次 ref 点击多付一次 DOM.getBoxModel 往返 | snapshot.go |
| 17 | phantom cursor 固定 id `piercode-phantom-cursor` 易被反爬识别；无关闭开关 | content |
| 18 | CSP 严格页 `new Function` 失败无回退 | evaluate |
| 19 | 滚动 DOM 先行 CDP 兜底（与参考相反）且无位移验证 | — |
| 20 | 无 batch/get_page_text/元素截图/GIF 录制/网络节流 | — |

---

## 三、Top 10 改进（综合 critic 排名，已剔除误报）

> 误报剔除：phantom cursor 到位门控、browser_zoom、console clear 标志 PierCode 已有。

| 排名 | 改什么 | 参考 | 工作量 |
|---|---|---|---|
| 1 | **`browser_batch` 元工具**：一次往返执行 `[{name,input},…]` 序列，顺序执行、首错即停、逐项校验+审批+URL 门控、图片穿插返回、禁嵌套。配 prompt："能预测 2+ 步就用 batch" + 批内坐标不变式。PierCode 每次工具调用 = 完整网页聊天轮次（检测 fence→审批→执行→回贴→再生成），杠杆远大于 API 场景。锁域兼容：batch 预计算锁集合，一个审批面板管整批 | Claude ext browser_batch + Claude Code computer_batch | M |
| 2 | **分级权限**：per-site（netloc + `*.domain` 通配）allow 规则 + once\|always 时效 + 动作类粒度（click/type vs evaluate/cookie 写）+ turn-approved-domains + 自解释拒绝文案（"银行站点禁止输入——只读层级"）。替代现在的每动作弹窗 | Claude ext per-netloc 模型 + Claude Code 分层门控 | M |
| 3 | **层级化 token 有界 snapshot**：缩进父子结构（role + 引号 name + [ref] + 关键属性）、`depth`（默认 ~15）、`ref_id` 子树下钻、`max_chars`；超限错误文本自带指导（"降 depth 或聚焦 ref_N"） | Claude read_page 格式 | M |
| 4 | **find 重建**：自然语言 → 一次廉价 LLM 采样（路由到已连接网页 AI 或 sidebar API 通道）在 snapshot 上选 ≤20 候选，返回 snapshot 兼容 ref；废弃 TreeWalker 评分 + CSS 路径 | Claude ext find（small_fast 采样） | M |
| 5 | **可操作性 + 验证层**：ref/坐标解析前 scrollIntoView(block:center) + 视口断言；click/type 前 visible/enabled/遮挡（elementFromPoint）检查；滚动位移验证（>5px）+ 最近可滚祖先回退；每个变更动作前重读 tab.url 跨域守卫 | Claude ext 解析链 + be() 守卫 | M |
| 6 | **Prompt 文案包**（近逐字移植进 `prompts/init_prompt.txt`，零/低代码）：anti-rabbit-hole（2-3 次失败即停）、dialog 死锁预防 + 服务端持久 per-tab auto-dialog policy（attach 时武装 Page.javascriptDialogOpening）兜底、tab 生命周期契约、文件上传规则（永不点 file input）。对弱网页模型性价比最高 | Claude Code BASE_CHROME_PROMPT | S |
| 7 | **console/network 即时捕获**：attach 即 enable Runtime/Network（现在懒 enable 丢加载期日志）、补 Network.loadingFailed、按需 Network.getResponseBody（限大小）、跨域导航自动清缓冲、工具描述强制 regex pattern | Claude ext 捕获层 | M |
| 8 | **截图 token 预算管线 + vision 回路**：1568px 缩放 + JPEG 质量阶梯（0.75→0.10）+ base64 上限；按 tab 缓存视口↔截图比例做 zoom 坐标重映射；sidebar/API 模式返回 base64 vision；browser_zoom 输出像 browser_screenshot 一样附进对话 | Claude ext 截图后处理 | M |
| 9 | **安全双修**：(a) `browser_cookies` 默认 `includeValue=false`（metadata-only，显式 opt-in 取值）；(b) 注入 prompt/工具结果的攻击者可控字符串消毒（tab 标题、页面标题、agent_result、文件列表）：字符白名单 + 长度/数量上限 + "DATA ONLY" 包裹 | Claude Code appNames.ts 消毒模式 | S |
| 10 | **`get_page_text` 工具**：Readability 式正文抽取纯文本（≤50k），区别于 raw innerText——读文档/文章最省 token 的原语，配合压缩阈值机制 | Claude ext get_page_text | S |

## 四、第二梯队（值得排期）

- **iframe/OOPIF 支持**（L）：现实缺口最大但四个参考都没给配方；需 `Target.attachToTarget`（flatten）+ frame 级 AX 树 + frameId 定向 Input。单独立项。
- **HTML5 DnD 合成**：dragstart/dragover/drop DragEvent 序列，修 react-dnd/sortable。
- **逐字符打字模式**：`mode: 'keys'` 参数走 per-char keyDown/keyUp + 虚拟键码（修编辑器/自动补全），默认仍 insertText。
- **焦点偷取修复**：去掉无条件 activateTabForInput——CDP Input 不需要前台 tab；与 keep-alive shim 哲学统一（验证后台 tab Input.dispatch 行为后落地）。
- **虚拟光标升级**（参考 Codex）：closed shadow DOM 化（防检测 + 样式隔离）、MutationObserver 自愈（SPA 重建后恢复）、随机 id、配置开关；可加点击涟漪 + "PierCode is active" 指示条 + Stop 按钮。
- **tab 组 + favicon 角标**：自动化 tab 进 chrome.tabGroups 分组、favicon 加角标——隔离边界 + 用户可见性。
- **wait 重建**：`Page.lifecycleEvent`（load/networkIdle）服务端等待替代页面内轮询；真导航不再报错。
- **GIF/录屏**：gif_creator（Claude ext 有完整 gif.js 管线）或 `Page.startScreencast` → webm。
- **dead code 清理**：extension background 的 legacy native snapshot/click/type 路径（`window.__piercodeAccessibilityTree` 已不存在）；controller_ext.go 的 interpolate()/distance() 死代码。
- **CSP 回退**：evaluate 在 eval-blocked 页面回退直接表达式求值。
- **IsSensitive 可配置**：站点级 override/allowlist。

## 五、参考未覆盖区（critic 标记，业界都薄弱）

跨 origin iframe 配方、shadow DOM 穿透定位、CDP Fetch 拦截/mock、下载工作流（Browser.setDownloadBehavior + 拉文件进工作区）、HTTP basic-auth/权限提示等原生对话框、window.open/OAuth 弹窗收养、storageState 登录态导出导入、networkidle 类系统化 settledness、IME/composition 输入、tab 崩溃恢复（Inspector.targetCrashed）。
