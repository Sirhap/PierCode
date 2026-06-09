# Batch 状态按响应容器隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 修问题 E（batch 跨响应串）—— Response B 的工具结果被并入 Response A 的提交。按响应容器(`Element`)隔离 batch 输出累积 + 提交分组，使每个响应的工具结果只回填到该响应。

**Architecture:** 最小侵入。保留单一执行器 + 单 `batchExecuting` 锁（一次一个工具，已正确，不动）。只把**输出累积**从全局 `batchOutputs: string[]` 改为按容器分组 `Map<Element, string[]>`（实为 `WeakMap` + 活跃容器 Set，因 submit 要遍历）。每个容器到点独立 `fillAndSend`。每个 batch item 带 `container` tag。

**Tech Stack:** TypeScript, Chrome MV3 content script (classic — 无 ESM import 到 index.ts), Vitest。

**配套:** [调查报告](../../investigation-batch-state-race.md) §问题E。container 引用稳定性已验证（现有 `preInitTextLen`/`settleRetryTimers` 等多个 WeakMap<Element> 长期工作；流式追加原地复用同一 Element）。

**风险:** 最高的一个改动（动 batch 主流程）。每步独立验证，348 测试 + 手测兜底。

---

## 关键现状（已核实，行号近似）

- 全局状态 `index.ts:2342-2353`：`pendingBatch`、`batchTimer`、`submitTimer`、`batchExecuting`、`batchOutputs`、`submitDeferStartedAt`(2400)。
- `scheduleToBatch(toolCall, key)` (2384)：push 到全局 `pendingBatch`。
- `executeBatch` (2446)：drain `pendingBatch`，`batchOutputs.push(...)` (2483)，末尾 `scheduleFinalSubmit`。
- `scheduleFinalSubmit` (2402)：`combinedOutput = batchOutputs.join` (2428) → 单次 `fillAndSend`。**这是串联点。**
- call 链有 `sourceEl`（容器）：`maybeScheduleAutoExecute`/`scheduleToBatch` 调用点在 scanText phase 内（2625/2672/2708/2712/2739/2743），`sourceEl` 在作用域。
- `maybeScheduleAutoExecute(toolCall, key)` (2511) → `scheduleToBatch`。

## 设计要点（YAGNI — 不做全 per-container 队列/锁）

**不动**：`pendingBatch`（单队列）、`batchExecuting`（单锁）、`batchTimer`、execution 顺序。一次一个工具执行本身无 bug。
**改**：
1. 每个 batch item 带 `container: Element`（来自 sourceEl）。
2. 输出累积按 container 分组：`outputsByContainer = new WeakMap<Element, string[]>()` + `activeOutputContainers = new Set<Element>()`（submit 要遍历活跃容器；WeakMap 不可遍历，故配一个 Set 存当前有待提交输出的容器，submit 后清）。
3. `submitDeferStartedAt` 也按容器：`Map<Element, number>` 或 WeakMap。
4. `scheduleFinalSubmit` 改为遍历 `activeOutputContainers`，每个容器独立判断 settle/generating + 独立 `fillAndSend`。

> sourceEl 缺失兜底：少数路径若无 sourceEl（理论上 scanText 都有），用一个 `FALLBACK_CONTAINER = document.body` 当 key，行为退化为旧的全局合并（不比现状差）。

---

## Task 1: batch item 带 container（线程化 sourceEl）

**Files:** Modify `extension/src/content/index.ts`

- [ ] **Step 1: 给 scheduleToBatch + maybeScheduleAutoExecute 加 container 参数**

`scheduleToBatch(toolCall, key)` → `scheduleToBatch(toolCall, key, container)`：
```typescript
  function scheduleToBatch(toolCall: any, key: string, container: Element) {
    clearSubmitTimer();
    lastAutoToolSeenAt = Date.now();
    pendingBatch.push({ data: ensureToolCallId(toolCall, key), key, container });
    scheduleBatchExecution();
  }
```
`maybeScheduleAutoExecute(toolCall, key)` → `maybeScheduleAutoExecute(toolCall, key, container)`：
```typescript
  function maybeScheduleAutoExecute(toolCall: any, key: string, container: Element) {
    if (isExecuted(key)) return;
    if (autoExecute === true) {
      scheduleToBatch(toolCall, key, container);
    }
    // ...保留其余逻辑原样
  }
```

- [ ] **Step 2: 更新所有调用点传 sourceEl**

`rg -n "maybeScheduleAutoExecute\(|scheduleToBatch\(" extension/src/content/index.ts` —— 6+ 个调用点（2625/2672/2708/2712/2739/2743 区）。每处在 scanText phase 内，`sourceEl` 在作用域。把 `maybeScheduleAutoExecute(data, key)` → `maybeScheduleAutoExecute(data, key, sourceEl)`，`scheduleToBatch(data, key)` → `scheduleToBatch(data, key, sourceEl)`。
- 调用点 2528（`scheduleToBatch(item.data, item.key)`）在某个重试/重排逻辑里 —— 读其上下文确认 container 来源（item 是否带 container？若该处来自 pendingBatch item，用 `item.container`；若来自别处，读出真实容器变量）。**必须实读 2520-2530 区确认。**
- 若某调用点 `sourceEl` 可能为空/undefined，传 `sourceEl ?? document.body`。

- [ ] **Step 3: type-check + build**

`cd extension && npx tsc --noEmit && npm run build`
Expected: 编译通过。此步还没改输出累积，行为暂不变（item 多带个字段）。

- [ ] **Step 4: Commit**
```bash
git add extension/src/content/index.ts
git commit -m "refactor(content): thread response container through batch scheduling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 输出累积按容器分组

**Files:** Modify `extension/src/content/index.ts`

- [ ] **Step 1: 替换全局 batchOutputs + submitDeferStartedAt 为按容器**

在 `const batchOutputs: string[] = [];` (2346) 处替换为：
```typescript
  // 输出按响应容器分组，避免不同响应的工具结果混进同一次提交（问题 E）。
  // WeakMap 不可遍历，配一个活跃容器 Set 供 scheduleFinalSubmit 遍历；提交后从 Set 移除。
  const outputsByContainer = new WeakMap<Element, string[]>();
  const activeOutputContainers = new Set<Element>();
  const submitDeferByContainer = new WeakMap<Element, number>();
```
删除全局 `submitDeferStartedAt` (2400) 声明（移到 per-container）。

- [ ] **Step 2: executeBatch 输出 push 到对应容器**

`executeBatch` 内 `batchOutputs.push(...)` (2483) 改为：
```typescript
          if (sendable && !alreadyInjected && output.trim()) {
            const callId = getToolCallId(toolCall);
            const c = item.container;
            let arr = outputsByContainer.get(c);
            if (!arr) { arr = []; outputsByContainer.set(c, arr); }
            arr.push(`### ${toolCall.name} #${callId}\n${output}`);
            activeOutputContainers.add(c);
          }
```
（`item` 已含 `container`，from Task 1。注意 `item` 变量名 —— 当前是 `const item = batch[i]`，`item.container` 可用。）

- [ ] **Step 3: scheduleFinalSubmit 改为遍历活跃容器，每容器独立提交**

把 `scheduleFinalSubmit` (2402) 整体改写为按容器循环。保留原有 settle/generating/defer 逻辑，但 per-container：
```typescript
  function scheduleFinalSubmit() {
    if (activeOutputContainers.size === 0) return;
    clearSubmitTimer();
    submitTimer = setTimeout(() => {
      submitTimer = null;
      if (batchExecuting) return;
      if (pendingBatch.length > 0) { scheduleBatchExecution(); return; }

      const stillGenerating = isResponseGenerating();
      const settleRemainingMs = responseSettleRemainingMs();

      for (const c of Array.from(activeOutputContainers)) {
        const arr = outputsByContainer.get(c);
        if (!arr || arr.length === 0) { activeOutputContainers.delete(c); continue; }

        let startedAt = submitDeferByContainer.get(c);
        if (startedAt == null) { startedAt = Date.now(); submitDeferByContainer.set(c, startedAt); }
        const deferredTooLong = Date.now() - startedAt >= MAX_SUBMIT_DEFER_MS;

        // 流仍在生成 → 顺延（不超过上限）。
        if (!deferredTooLong && stillGenerating) { continue; }
        if (!deferredTooLong && settleRemainingMs > 0) { continue; }

        const combinedOutput = arr.join('\n\n');
        outputsByContainer.delete(c);
        activeOutputContainers.delete(c);
        submitDeferByContainer.delete(c);
        if (combinedOutput) {
          fillAndSend(prepareToolOutputForChat(combinedOutput), true);
        }
      }

      // 仍有未提交容器（顺延中）→ 重排一次。
      if (activeOutputContainers.size > 0) {
        if (settleRemainingMs > 0 && !isResponseGenerating()) {
          submitTimer = setTimeout(() => { submitTimer = null; scheduleFinalSubmit(); }, settleRemainingMs);
        } else {
          scheduleFinalSubmit();
        }
      }
    }, quietMs);
  }
```
> 注意：多个容器同时 `fillAndSend` 到同一聊天输入框可能冲突（输入框是单个）。**关键约束**：实际上同一时刻通常只有一个响应在收尾。但若两个容器同时到点，连续两次 `fillAndSend(autoSend=true)` 会发两条消息。这是**预期且正确**的行为（两个响应各自的结果分两条发），但需确认 `fillAndSend` 串行安全（它是 async）。Step 4 验证。

- [ ] **Step 4: 确认 fillAndSend 串行 + 其它 batchOutputs 引用清理**

`rg -n "batchOutputs|submitDeferStartedAt" extension/src/content/index.ts` —— 确认无遗留引用（全替换）。读 `fillAndSend` (3381)：若它不是串行安全（两次并发调用会互相踩输入框），用一个简单串行队列包装：连续提交改为 await 链。**实读 fillAndSend 确认**；若它内部已 await 填充+点击，循环里的连续调用因 setTimeout 同步循环会并发 —— 改为 `await` 每个 fillAndSend（把 setTimeout 回调改 async，for 循环内 await）。

- [ ] **Step 5: type-check + build + full suite**

`cd extension && npx tsc --noEmit && npm run build && npm test`
Expected: green incl content-build.test.ts。

- [ ] **Step 6: Commit**
```bash
git add extension/src/content/index.ts
git commit -m "fix(content): isolate batch output accumulation + submit per response container

Each response container's tool results accumulate in its own output list and
submit independently, so Response B's results no longer bleed into Response A's
submit (problem E).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 手测 + 回归

- [ ] **Step 1: 全量 + 构建**
`cd extension && npm test && npx tsc --noEmit && npm run build` — 全绿。

- [ ] **Step 2: 单响应回归（最常见路径不能坏）**
单个 AI 响应含 1 个工具 + 多个工具：确认仍正常执行 + 单次合并提交（同一容器 → 一次 fillAndSend）。

- [ ] **Step 3: 多响应隔离验证（修复目标）**
构造两个响应快速相继产工具（多 tab worker 并发，或一条响应工具执行期间下一条已流式）：确认各响应结果分别回填到**各自**对话，不再混。

- [ ] **Step 4: spawn_agent alreadyInjected 路径不回归**
spawn_agent（API 路）的 `alreadyInjected` 仍不进 batchOutputs（Task 2 Step 2 保留了 `!alreadyInjected` 判断）。

---

## Self-Review 记录

- **覆盖**：E 的串联点（batchOutputs 全局合并 + 单次 submit）→ Task 2。container 线程化 → Task 1。
- **不做（YAGNI）**：per-container 的 pendingBatch/batchExecuting/batchTimer。执行串行本身无 bug，只输出分组是 bug 根因。降低回归面。
- **风险点**：(a) 调用点 2528 的 container 来源需实读确认；(b) 多容器同时 fillAndSend 的串行安全需实读 fillAndSend 确认（Task2 Step4）。两处都在计划里标了"实读确认"，非占位。
- **container 稳定性**：已验证（现有多个 WeakMap<Element> 依赖同一假设）。
