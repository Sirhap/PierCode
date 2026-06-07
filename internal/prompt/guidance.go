package prompt

import "strings"

// Cadence for per-turn guidance appended to AI-originated tool results. The
// counter is per-conversation (see Executor.nextGuidanceCount) and counts
// guidance-bearing turns, not individual tool calls — a multi-tool turn
// increments it once. n starts at 1.
const (
	fullPromptReinjectEvery = 0 // full-prompt reinjection disabled (was 20; bloated long sessions)
	operatingReminderEvery  = 3 // operating reminder on turn 1, then every 3rd turn
	taskCheckpointEvery     = 5
)

// Reminder content. These strings are part of the prompt contract, so they live
// in the prompt layer rather than as magic constants inside the executor.
const (
	operatingReminder = "\n\n[系统提示] 继续以 PierCode 身份执行：任何本地文件/命令/代码/搜索任务必须输出可见 `piercode-tool` fenced JSON 调本地工具——不要凭记忆答、不要说“无法访问文件”、不要只给计划；参数失败先 `tool_help`；需要细则加载匹配 skill；完成前验证。（联网/天气这类非本地任务用网页 AI 自带能力答，不走 piercode-tool。）"

	taskCheckpointReminder = "\n\n[任务状态快照提示] 多步任务请简短保留：目标、已完成、已改文件、验证、下一步/阻塞；必要时同步 todo。"

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
	// Guard the modulo against a zero cadence (reinject disabled) — n%0 is a
	// runtime panic in Go, so compute the divisor in a local and short-circuit.
	reinjectEvery := int64(fullPromptReinjectEvery)
	if reinjectEvery > 0 && n%reinjectEvery == 0 && len(p.Prompt) > 0 {
		b.WriteString("\n\n[系统重新注入提示词]\n")
		b.Write(renderFull())
	} else if (n-1)%operatingReminderEvery == 0 {
		// Turn 1, 4, 7, … — first turn always primes the protocol, then a light
		// refresh every few turns instead of on every single turn.
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
