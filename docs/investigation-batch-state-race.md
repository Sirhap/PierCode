# 调查报告：content 脚本 batch 状态跨响应串联（问题 E）+ 双执行 race（问题 B）

> 状态：调查完成，**暂不改**（用户决定 review 后再定）。E 为高风险改动，落档备决策。
> 文件：`extension/src/content/index.ts`（3817 行，classic MV3 content script，`startDOMObserver` 闭包内含全部 batch 状态）。

## TL;DR

- **问题 E（batch 跨响应串）：真实且严重。** 全局 `pendingBatch` / `batchOutputs` 无容器隔离，Response B 的工具结果可被并入 Response A 的提交。建议修，但改动面大、回归风险高 → 需独立 plan + 重回归测试。
- **问题 B（双执行 race）：大部分已被 `processed` Set 挡住。** 仅剩 settle-retry 窄缝（未平衡 JSON 跳过时不加 `processed`，600ms 重扫前 Phase 1 可能已命中）。低优先。
- **调查副产品 — 一个真问题：** `index.ts:2821` 用裸 NUL 字节 `\x00` 当 dedup key 字段分隔符，导致 `rg`/grep 把文件当 binary、从该偏移起失明（投资 agent 因此误报多个函数"未定义"）。功能正常但工具不友好，建议换分隔符。

---

## 问题 E：batch 状态跨响应串联（真实，严重）

### 状态（全局单例，无隔离）— `index.ts:2342-2353`
```
let pendingBatch: any[] = [];          // 2342 — 无容器/响应标签
let batchTimer = null;                 // 2343 — 单 timer 服务所有响应
let submitTimer = null;                // 2344
let batchExecuting = false;            // 2345 — 执行中新工具不排队，直接 push
const batchOutputs: string[] = [];     // 2346 — 全局累积，混合多响应结果
let quietMs = 400;                     // 2353
let submitDeferStartedAt = 0;          // 2400 — 全局时间戳，跨响应污染
```

### Race 时序（已从代码追出）
```
t=0    Response A DOM 插入 → MutationObserver → scanText(containerA) → 工具1 → scheduleToBatch
       pendingBatch=[tool1], batchTimer=quietMs
t=300  batchTimer 到期 → executeBatch() → batchExecuting=true
       batch=[tool1], pendingBatch=[], await executeToolCallReturn(tool1)
t=350  Response B DOM 插入 → scanText(containerB) → 工具2 → scheduleToBatch
       pendingBatch=[tool2]；但 batchExecuting=true → scheduleBatchExecution() 直接 return（无排队）
t=400  tool1 完成 → batchOutputs.push(result1)
       executeBatch while 检查 pendingBatch.length>0 → drain [tool2] → batchOutputs.push(result2)
t=600  scheduleFinalSubmit() → combinedOutput = batchOutputs.join('\n\n') = result1+result2
       ❌ result2（属于 Response B）被并入 Response A 的提交
```

### 关键证据
- `scheduleToBatch`（2384）：`pendingBatch.push({data, key})` — 无响应标签。
- `scheduleBatchExecution`（2371）：`if (batchExecuting) return` — 执行中不排队，新工具靠 `executeBatch` 末尾 while 续 drain（2504），并入同批。
- `executeBatch`（2446）：`batchOutputs.push(...)`（约 2490），全局累积。
- `scheduleFinalSubmit`（2428）：`const combinedOutput = batchOutputs.join('\n\n')` — 无来源过滤。
- `submitDeferStartedAt`（2400/2414）：全局戳，Response A 设置后 Response B 的 defer 判断受旧戳影响（`MAX_SUBMIT_DEFER_MS=15s`）。

### 触发条件
两个响应在 ~quietMs+执行时长 的窗口内相继产出工具（多 tab worker 并发、或快速连续对话、或一条响应工具执行期间下一条已开始流式）。单响应场景不触发。

### 建议修法（独立 plan，高回归风险）
按 **conversationKey + 响应容器** 隔离 batch 状态：`Map<containerKey, {pendingBatch, batchOutputs, batchTimer, submitDeferStartedAt}>`，每个响应独立队列 + 独立提交。`getConversationKey()`（conversation-scope.ts，已存在）可作 key 基础。需重回归（多响应/多 tab worker 并发用例）。**剔出本批的原因：动 batch 主流程，错了直接坏掉工具执行。**

---

## 问题 B：双执行 race（大部分已挡住）

### 现有 dedup（有效）— `index.ts:2231`
`const processed = new Set<string>()`（startDOMObserver 闭包级，per-response-session 持久）。三条检测路径都查它：
- Phase 0 Qwen Monaco（2618 `processed.has` / 2622 `processed.add` / 2635 early return）
- Phase 0b Chat Z CodeMirror（2666/2670/2677 return，不 fallthrough）
- Phase 1 JSON fence（2702/2706）

Phase 0 命中即 early-return，不会再走 Phase 1；`renderToolCard`（1806）内部同步无 await，`processed.add` 在 render 前 → 无异步插入窗口。**常规路径双执行已被挡。**

### 仅剩窄缝 — settle-retry
`index.ts:2601-2603`：Phase 0 遇未平衡 JSON（`!isBalancedJson`）→ `scheduleSettleRetry` 且**不** `processed.add`。600ms 后重扫：若期间 Phase 1（另一 schedule 周期）已对同 key 命中并 add，重扫 Phase 0 会被 `processed.has` 挡住 → 实际安全；真正风险仅在 render 卡片重复的极窄时序，未观测到稳定复现。

### 建议
低优先。若修：settle-retry 前给该 key 占位（tentative add），或统一所有 phase 在解析成功点单一入口 add。**风险低于 E，但收益也低。** 可与 E 同 plan 顺带，或单独留。

---

## 调查副产品：NUL 字节当分隔符（真问题，建议修）

`index.ts:2821`：
```
const contentKey = `${reportedId}\x00${packet.status}\x00${packet.summary}\x00${packet.result}`
```
裸 NUL（`\x00`）当 dedup key 字段分隔符。功能正常（NUL 不出现在正常文本，分隔无歧义），但：
- 让 `rg`/`grep` 从该字节偏移起把文件判为 **binary 并停止搜索** → 工具失明。本次调查 agent 因此误报 `isExecuted`/`markExecuted`/`executeToolCallReturn`/`bootstrapContentScript` "未定义"（实际都存在，构建/348 测试全绿可证）。
- 后续任何 grep-based 工具/agent 在此文件都会被误导。

**建议**：换非 NUL 分隔符（如 `\x1f` Unit Separator 同样无歧义但不触发 binary 判定，或直接 `JSON.stringify([reportedId, status, summary, result])` 当 key）。一行改动，消除工具失明。**低风险，可单独快修。**

---

## 决策点（待用户）

1. E 隔离修不修？（真严重，但高回归风险，需独立 plan + 重测试）
2. B settle-retry 窄缝修不修？（低优先，可搭 E）
3. NUL 分隔符换不换？（低风险快修，建议换 — 消除 grep 失明）
