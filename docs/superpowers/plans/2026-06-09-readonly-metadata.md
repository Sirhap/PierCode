# 只读工具 Metadata() 收尾 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 18 个只读工具实现 `Metadata()` 方法，去掉 `executor.go` 里 `isReadOnlyToolName` 硬编码名单的依赖，让只读判定来自工具自身（与并发执行优化对齐）。

**Architecture:** `tool.MetadataProvider` 接口已存在（`Metadata() ToolMetadata`，`ToolMetadata.ReadOnly bool`）。`toolIsReadOnly` 先查 `MetadataProvider`，否则回退 `isReadOnlyToolName` 名单。给每个只读工具加一行 `Metadata()` 即可让它走接口路，名单沦为纯回退。

**Tech Stack:** Go 1.24, testify。

**配套文档:** [设计 spec §6](../specs/2026-06-09-subagent-api-migration-design.md)

**前置更正:** 设计 §6 原列"9 处 legacy `ctx.BroadcastToClient` 待切组"——经实读 `question.go`/`agent_tools.go`/`browser_tools.go`，**该迁移已完成**（全部已是 `ctx.Client.BroadcastToClient`）。本 plan 只覆盖真正未做的「只读工具加 Metadata()」。

---

## 现状（已核实）

`internal/tool/tool.go:22-28`：
```go
type ToolMetadata struct {
	ReadOnly bool `json:"readOnly"`
}

type MetadataProvider interface {
	Metadata() ToolMetadata
}
```

`internal/executor/executor.go:439-457`：
```go
func toolIsReadOnly(t tool.Tool) bool {
	if provider, ok := t.(tool.MetadataProvider); ok {
		return provider.Metadata().ReadOnly
	}
	return isReadOnlyToolName(t.Name())
}

func isReadOnlyToolName(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "read_file", "list_dir", "glob", "grep", "web_fetch", "skill", "question", "tool_help",
		"todo_read", "task_list", "task_output", "browser_tabs", "browser_snapshot",
		"browser_screenshot", "browser_wait", "browser_wait_for_function", "browser_get_content",
		"browser_pdf", "browser_console", "browser_network",
		"browser_find", "browser_get_attributes":
		return true
	default:
		return false
	}
}
```

样板（唯一已实现的）`internal/tool/memory.go:27`：
```go
func (t *MemoryReadTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }
```

**待加 Metadata() 的工具**（名单里有但无 Metadata）：`read_file`, `list_dir`, `glob`, `grep`, `web_fetch`, `skill`, `question`, `tool_help`, `todo_read`, `task_list`, `task_output` + 9 个 browser 只读工具。

---

## Task 1: 核心只读工具加 Metadata()（非 browser）

**Files:**
- Modify: `internal/tool/read_file.go`, `list_dir.go`, `glob.go`, `grep.go`, `web_fetch.go`, `skill.go`, `question.go`, `tool_help.go`, `todo_read.go`, `task_list.go`, `task_output.go`
- Test: `internal/tool/metadata_test.go` (create)

- [ ] **Step 1: Write the failing test**

```go
// internal/tool/metadata_test.go
package tool

import "testing"

func TestReadOnlyToolsDeclareMetadata(t *testing.T) {
	readOnly := []Tool{
		&ReadFileTool{}, &ListDirTool{}, &GlobTool{}, &GrepTool{},
		&WebFetchTool{}, &SkillTool{}, &QuestionTool{}, &ToolHelpTool{},
		&TodoReadTool{}, &TaskListTool{}, &TaskOutputTool{},
	}
	for _, tl := range readOnly {
		p, ok := tl.(MetadataProvider)
		if !ok {
			t.Errorf("%s does not implement MetadataProvider", tl.Name())
			continue
		}
		if !p.Metadata().ReadOnly {
			t.Errorf("%s Metadata().ReadOnly = false, want true", tl.Name())
		}
	}
}
```

> 注：若某工具构造需参数（如 `SkillTool`/`TaskListTool` 可能需依赖），按其现有零值/构造函数调整字面量。先 `grep -n "func New.*Tool\|type .*Tool struct" internal/tool/<file>.go` 确认。

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/tool/ -run TestReadOnlyToolsDeclareMetadata -v`
Expected: FAIL — 多个工具 "does not implement MetadataProvider"

- [ ] **Step 3: Add Metadata() to each tool**

每个文件加一行（紧跟该工具其他方法，类型名按文件实际）：

```go
func (t *ReadFileTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }
```
```go
func (t *ListDirTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }
```
```go
func (t *GlobTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }
```
```go
func (t *GrepTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }
```
```go
func (t *WebFetchTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }
```
```go
func (t *SkillTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }
```
```go
func (t *QuestionTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }
```
```go
func (t *ToolHelpTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }
```
```go
func (t *TodoReadTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }
```
```go
func (t *TaskListTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }
```
```go
func (t *TaskOutputTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }
```

> 实际类型名先核实：`grep -n "type .*Tool struct" internal/tool/read_file.go internal/tool/list_dir.go ...`。若名称不同（如 `ReadTool` 而非 `ReadFileTool`），同步改测试与方法接收者。

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/tool/ -run TestReadOnlyToolsDeclareMetadata -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/tool/*.go
git commit -m "feat(tool): declare ReadOnly Metadata on core read-only tools

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: browser 只读工具加 Metadata()

**Files:**
- Modify: `internal/tool/browser_tools.go` (browser_tabs, browser_snapshot, browser_screenshot, browser_wait, browser_wait_for_function, browser_get_content, browser_console, browser_network) + `browser_tools_ext.go`/`browser_tools_find.go`（browser_pdf, browser_find, browser_get_attributes 所在文件）
- Test: `internal/tool/metadata_test.go` (扩展)

> 注：browser 工具多为同一 `browserTool` 结构 + name 字段区分（investigator 提示 `browser_tools.go:43-163` browserTool ×~40）。先确认结构：`grep -n "type browserTool struct\|func.*browserTool.*Metadata\|browserTool{" internal/tool/browser_tools.go | head`。

- [ ] **Step 1: Determine browser tool structure**

Run: `grep -n "type browserTool\|func (.*browserTool)\|readOnly\|ReadOnly" internal/tool/browser_tools.go | head -20`
Expected: 确认 browser 工具是统一结构还是各自类型。

- [ ] **Step 2: Write the failing test**

```go
// 追加到 metadata_test.go — 用 registry 验证 browser 只读工具
func TestBrowserReadOnlyToolsMetadata(t *testing.T) {
	names := []string{
		"browser_tabs", "browser_snapshot", "browser_screenshot", "browser_wait",
		"browser_wait_for_function", "browser_get_content", "browser_console",
		"browser_network", "browser_pdf", "browser_find", "browser_get_attributes",
	}
	reg := NewRegistry()
	RegisterBrowserTools(reg) // 按实际注册入口名调整
	for _, n := range names {
		tl, ok := reg.Get(n)
		if !ok { t.Errorf("%s not registered", n); continue }
		p, ok := tl.(MetadataProvider)
		if !ok || !p.Metadata().ReadOnly {
			t.Errorf("%s should declare ReadOnly metadata", n)
		}
	}
}
```

> 注册入口名先确认：`grep -n "func Register.*Browser\|registry.Register" internal/tool/browser_tools.go internal/executor/executor.go | head`。

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/tool/ -run TestBrowserReadOnlyToolsMetadata -v`
Expected: FAIL — browser 工具未声明 Metadata

- [ ] **Step 4: Add ReadOnly flag to browser tool definition**

若 browser 工具是统一 `browserTool` 结构，给结构加 `readOnly bool` 字段 + `Metadata()` 方法：

```go
func (t *browserTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: t.readOnly} }
```

并在创建只读 browser 工具处把 `readOnly: true` 置上（按上面 11 个 name 列表）。写工具（navigate/click/type/upload/evaluate 等）保持 `readOnly: false`（零值）。

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/tool/ -run TestBrowserReadOnlyToolsMetadata -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/tool/browser_tools*.go internal/tool/metadata_test.go
git commit -m "feat(tool): declare ReadOnly Metadata on browser read-only tools

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 收紧 isReadOnlyToolName 为纯回退

**Files:**
- Modify: `internal/executor/executor.go:439-457`

> 现在所有只读工具都声明 Metadata()，`isReadOnlyToolName` 名单可瘦身成"仅未实现 Metadata 的工具兜底"。保守起见**不删名单**（防漏标退化），但加注释说明它已是回退路。

- [ ] **Step 1: Add regression test that registry tools match metadata**

```go
// 追加到 executor 测试
func TestAllReadOnlyToolsViaMetadata(t *testing.T) {
	e := New(/* 按现有 New 签名构造 */)
	for _, name := range e.registry.List() {
		tl, _ := e.registry.Get(name)
		_, hasMeta := tl.(tool.MetadataProvider)
		// 名单里的工具应当都已实现 Metadata（名单沦为回退）
		if isReadOnlyToolName(name) && !hasMeta {
			t.Errorf("read-only tool %s still relies on name list, add Metadata()", name)
		}
	}
}
```

> `New` 构造参数按 `internal/executor/executor.go` 实际签名填；若难构造，改用直接 `registry` 遍历。

- [ ] **Step 2: Run test**

Run: `go test ./internal/executor/ -run TestAllReadOnlyToolsViaMetadata -v`
Expected: PASS（所有名单工具已有 Metadata）

- [ ] **Step 3: Add fallback comment**

`executor.go:445`（`isReadOnlyToolName` 上方）加注释：

```go
// isReadOnlyToolName is the FALLBACK path for tools that have not yet declared
// Metadata().ReadOnly. As of the metadata migration all listed tools implement
// MetadataProvider; this list now only guards against a future tool being added
// without Metadata(). Prefer adding Metadata() over extending this list.
```

- [ ] **Step 4: Commit**

```bash
git add internal/executor/executor.go internal/executor/*_test.go
git commit -m "refactor(executor): mark isReadOnlyToolName as fallback-only

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 全量回归

- [ ] **Step 1: Run full Go test suite**

Run: `go test ./... && go test -race ./internal/tool/ ./internal/executor/`
Expected: 全 PASS，无 race。

- [ ] **Step 2: Verify concurrent read-only execution still works**

确认 `toolIsReadOnly` 现在对所有只读工具返回 true（走 Metadata 路），并发读锁优化生效。可加日志或检查现有并发测试。

---

## Self-Review 记录

- **Spec 覆盖**：§6「只读工具加 Metadata」→Task 1/2；「legacy 切组」→已完成，不做（前置更正）；「68 工具表驱动注册」→标 YAGNI 不在此 plan。
- **占位**：Task 1/2/3 含"先 grep 确认类型名/构造签名"步骤——因 Go 类型名需实读确认（investigator 只取了 memory.go 样板），但每步给了具体代码 + grep 命令，非占位。
- **类型一致**：`Metadata() ToolMetadata` / `ToolMetadata{ReadOnly: true}` 跨 task 与样板 `memory.go:27` 一致。
