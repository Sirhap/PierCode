package tool

// TaskAccess groups background-task handoff. A tool that wants to run its work
// out-of-band (currently only exec_cmd with background:true, plus the task_*
// management tools) reaches through here. The zero value has a nil Runner,
// meaning background mode is not available in this invocation — consumers
// nil-check Runner exactly as they did the old top-level ctx.TaskRunner.
type TaskAccess struct {
	Runner TaskRunner
}
