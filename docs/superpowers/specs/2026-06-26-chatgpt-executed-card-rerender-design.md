# ChatGPT 已执行工具卡片消失 — 修复设计

**日期**: 2026-06-26
**范围**: extension/src/content — 工具卡片自愈逻辑
**关联记忆**: [[tool-card-live-rerender]]、[[tool-double-exec-sse-vs-dom]]

## 问题

ChatGPT 页面上,工具卡片在**执行成功后消失**且不再重渲。历史消息稳定渲染,流式/执行后偶失。

### 根因

ChatGPT 走 Phase 1 通用 JSON fence 路径(`index.ts` `scanText`,`lower.includes('```piercode-tool')`)。两道去重门:

```
if (isExecuted(key)) continue;                                    // (1) 凶手
if (processed.has(key) && (!sourceEl || isToolCardLive(key))) continue;  // (2) 自愈门
```

链条:
1. 卡片渲染,锚在流式 `<pre>` 上。
2. 用户点「执行」成功 → `markExecuted(key)`(`tool-card.ts` `execBtn.onclick`)→ `isExecuted(key)===true`。
3. ChatGPT(React)流式结束后**重建 message DOM**(markdown 重解析 / 代码高亮 / 滚动虚拟化)→ 旧 `<pre>` 连同卡片被孤儿移除。
4. 下次 scan:**门 (1) 先短路 continue**,根本到不了门 (2) 的自愈 `isToolCardLive` 检测 → 卡片永不重渲。

自愈逻辑(2026-06-12 加)只在「未执行」时生效;`isExecuted` 守卫(同轮加,防双执行)抢在自愈前 return。稳定 DOM 平台无碍;ChatGPT 重建节点 → 已执行卡片孤儿化后无法救回。

`isExecuted` 守卫**必须保留**——它防的是「给已执行/已跳过工具复活一张*可点*的卡片」造成双执行。修复不能直接删它。

## 设计(方案 A:完整 done 只读卡)

**核心**: 已执行 ≠ 不能重渲。区分两件事 —— 「该工具已 done」(用 `isExecuted`)与「卡片是否还在 DOM」(用 `isToolCardLive`)。已执行且卡片孤儿时,重渲一张**终态只读卡**:⏺ done + 工具名 + 参数预览 + 结果预览(可展开),**无执行/后台/忽略按钮**,不可再触发执行。

### 组件 1: 工具结果缓存(`tool-result-store.ts`,新建 content 叶子)

`piercode_executed` 只存 `key → timestamp`,无结果文本。孤儿后结果已随旧 DOM 丢失,需独立缓存回取。

新 content-safe 叶子模块(无 `chrome.*` module-scope,可被 classic content.js 静态 import):

```
存储键: localStorage 'piercode_tool_results'
形状:   Record<key, { name, argsPreview, output, status, durationMs, ts }>
        status: 'done' | 'error'
API:
  saveToolResult(key, rec): void   // 写 + TTL(7d,与 piercode_executed 同)裁剪 + 体积上限(见下)
  loadToolResult(key): rec | null
```

体积控制: `output` 截断到 ~4KB 入存(只读卡是预览,不需全文);条目数超上限(如 200)按 ts 淘汰最旧。TTL 复用 `piercode_executed` 的 7 天。`localStorage.setItem` 失败(配额满)吞掉——缓存是 best-effort,丢了顶多退化成「已执行(无输出)」只读卡。

### 组件 2: `renderToolCard` 增 `executed` 终态模式(`tool-card.ts`)

签名加可选参 `opts?: { executed?: boolean }`(或读 deps 取 `loadToolResult`)。`executed===true` 时走精简渲染分支:

- ⏺ 头行 done 色(`T_GLOW`),`{name}({argsPreview})`,statusNote 显示耗时或 `error · …`。
- 不挂 execBtn / bgBtn / skipBtn(只读)。
- 从 `loadToolResult(key)` 取结果 → 复用现有 `appendResultSection(output)`(⎿ 预览 + 展开 + 「插入到对话」)。无缓存 → 一行 `⎿ (已执行,无缓存输出)`。
- 仍复用 `findToolBlockElement` 锚点 + `data-piercode-key` 标记 + 隐藏原始块逻辑,这样只读卡同样替换掉 ChatGPT 重新冒出来的原始 JSON `<pre>`。
- 返回 boolean 语义不变(入 DOM 才 true)。

普通(未执行)分支完全不动 —— 现有交互卡渲染路径零改动。

### 组件 3: 4 处 call site 放宽 `isExecuted` 守卫(`index.ts`)

把 `if (isExecuted(key)) continue;` 改为:已执行但卡片孤儿(实时路径 `sourceEl` 存在且 `!isToolCardLive(key)`)时,渲染只读卡而非直接跳过:

```
if (isExecuted(key)) {
  if (sourceEl && !isToolCardLive(key)) {
    renderToolCard(data, raw, sourceEl, key, processed, { executed: true });
  }
  continue;   // 已执行,绝不重新进入执行/自动执行路径
}
```

4 处: Phase 0 Qwen DOM(2467)、Phase 0b Chat Z(无 isExecuted 门,但有 `processed.has` 门——同样补只读分支)、Phase 1 JSON(2553)、Phase 2 XML(2587)。统一行为,不只补 chatgpt——同样的 SPA 重建在 qwen/claude 也可能发生。

**关键不变量**: `continue` 永远在渲染只读卡后立即执行 —— 已执行 key 绝不流向 `maybeScheduleAutoExecute` / `renderToolCard` 的可点卡分支,杜绝双执行。只读卡无按钮、`renderToolCard` executed 分支不调 `executeToolCallRaw`。

### 组件 4: 写缓存(3 处 exec 成功点)

- `tool-card.ts` `execBtn.onclick` 成功后(`markExecuted` 旁): `saveToolResult(key, {name,argsPreview,output:text,status:'done',durationMs,ts})`。
- `tool-card.ts` `bgBtn.onclick` 成功后: 同上 status 由结果定。
- `index.ts` `runBatchItem`(自动执行/批量,2222 `output` 处): `sendable` 时 `saveToolResult`。
- 流式 exec_cmd 的 `streamDoneSubs` 回调拿到终态时也补一次(可选,exec_cmd 输出已进 streamBox,只读卡退化为「已执行」也可接受 —— 一期可跳过,保持简单)。

## 数据流

```
用户点执行 → executeToolCallRaw → 成功
  → markExecuted(key)           [piercode_executed: key→ts]
  → saveToolResult(key, rec)    [piercode_tool_results: key→rec]  ← 新增
  → 卡片显示 done + 结果

ChatGPT 重建 message DOM → 卡片孤儿 → isToolCardLive(key)=false

下次 scan → Phase 1 → isExecuted(key)=true
  → sourceEl && !isToolCardLive → renderToolCard(..., {executed:true})
       → loadToolResult(key) → appendResultSection(output)
  → continue (不执行)
  → 用户重新看到 done 只读卡(带结果,可展开)
```

## 错误处理

- `localStorage` 读/写失败(配额、隐私模式): try/catch 吞,`loadToolResult` 返回 null → 只读卡显示「已执行,无缓存输出」。不抛、不阻断 scan。
- 缓存命中但 output 为旧截断: 可接受 —— 只读卡是预览,完整结果当初已通过 `fillAndSend` 进对话。
- `executed` 只读卡的 `findToolBlockElement` 找不到锚点: `renderToolCard` 返回 false,无卡 —— 与现有 fallback 一致,不烧 key,下次 scan 再试。

## 测试(`tool-card-selfheal.test.ts` 扩展)

复用现有 JSDOM 装置:

1. **executed 只读卡渲染**: `initToolCardDeps` 注入返回固定 rec 的 `loadToolResult` mock → `renderToolCard(DATA, '', msg, KEY, set, {executed:true})` → 断言卡片 live、含结果预览文本、**无 execBtn/skipBtn**(`querySelector('button')` 为 null 或仅展开类元素)。
2. **executed 孤儿后重渲**: 渲染交互卡 → 标记 executed → 抹掉 message 子树重建 `<pre>` → 模拟 scan 的 executed 分支 → 断言只读卡重新 live。
3. **executed 只读卡不可执行**: 断言只读卡内无任何会调 `executeToolCallRaw` 的按钮(回归双执行防护)。
4. **无缓存降级**: `loadToolResult` 返回 null → 只读卡 live 且显示「无缓存输出」占位、仍无按钮。
5. **`tool-result-store` 单测**(新): save/load 往返、TTL 裁剪、体积上限淘汰、setItem 抛错时 load 返回 null。

`tsc --noEmit` + `npm test` 全绿。

## 不做(YAGNI)

- 不持久化完整(非截断)结果——只读卡只需预览。
- 一期不为流式 exec_cmd 的 streamBox 重建实时流(只读卡退化为已执行标记可接受)。
- 不改 `isExecuted`/`markExecuted` 的 `piercode_executed` 结构(独立新缓存,零迁移风险)。
