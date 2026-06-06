package prompt

import "strings"

// Cadence for per-call guidance appended to AI-originated tool results.
const (
	fullPromptReinjectEvery = 20
	taskCheckpointEvery     = 5
)

// Reminder content. These strings are part of the prompt contract, so they live
// in the prompt layer rather than as magic constants inside the executor.
const (
	operatingReminder = "\n\n[系统提示] 继续以 PierCode 身份执行：工具调用必须使用可见的 `piercode-tool` fenced JSON；所有文件操作保持在当前工作目录/sandbox 内；工具参数或格式失败时先调用 `tool_help` 读取该工具详细用法再重试；需要更细规则时加载匹配的 `piercode-*` skill；完成前用测试或明确证据验证。"

	taskCheckpointReminder = "\n\n[任务状态快照提示] 如果当前任务已跨多步或上下文变长，请在下一次回复中简短保留：目标、已完成事项、已改文件、验证结果、下一步/阻塞；必要时用 `todo_write`/`todo_read` 同步待办。"

	// workerResultPacketReminder is wired onto the worker profile's ContextHandoff
	// in DefaultProfileRegistry. It nudges a dispatched worker to close out with
	// the result packet the coordinator is waiting on.
	workerResultPacketReminder = "\n\n[Worker 结果回传提示] 你是 PierCode worker，只负责手头这一个自包含任务。任务完成、失败或受阻时，只输出一个 ```piercode-agent-result fenced JSON block（字段：version、agent_id、status=completed|failed|blocked、summary、result、evidence、files_changed）；不要套 `piercode-tool`，不要输出多个 block，不要在 packet 前后加解释；输出后停止。coordinator 看不到你的会话，result/evidence 要自包含。"
)

// GuidanceFor returns the guidance text to append to the n-th AI-originated tool
// result for this profile. renderFull is invoked only when a full-prompt
// re-injection is due, so callers do not pay the render cost on every call.
//
// The executor owns when this fires (call counting); the profile owns what gets
// appended (operating reminder, periodic checkpoint, and any profile-specific
// context handoff such as Qwen's migration packet prompt).
func (p Profile) GuidanceFor(n int64, renderFull func() []byte) string {
	var b strings.Builder
	if n%fullPromptReinjectEvery == 0 && len(p.Prompt) > 0 {
		b.WriteString("\n\n[系统重新注入提示词]\n")
		b.Write(renderFull())
	} else {
		b.WriteString(operatingReminder)
	}
	if n%taskCheckpointEvery == 0 {
		b.WriteString(taskCheckpointReminder)
	}
	if p.ContextHandoff != "" {
		b.WriteString(p.ContextHandoff)
	}
	return b.String()
}
