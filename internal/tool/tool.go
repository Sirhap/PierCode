package tool

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/types"
)

type Tool interface {
	Name() string
	Description() string
	Parameters() interface{}
	Validate(args map[string]interface{}) error
	Execute(ctx *Context) *Result
}

type Context struct {
	Context context.Context
	Args    map[string]interface{}
	Config  *types.Config

	// RootDir is a snapshot of Config.GetRootDir() taken at request entry by
	// the executor. Tools must prefer this over Config.GetRootDir() to avoid
	// TOCTOU when a concurrent /cwd swaps the global RootDir mid-call: a path
	// resolved against root A, then written against root B can escape the
	// caller's intended workspace. Tools that legitimately need the live
	// value can still hit Config directly.
	RootDir string

	// Streamer, if set, receives incremental stdout/stderr chunks from a
	// long-running tool (currently only exec_cmd). stream is "stdout" or
	// "stderr". Nil callback means the caller does not care about live output.
	Streamer func(stream, text string)

	// TaskRunner, if set, allows a tool to hand the actual work off to an
	// out-of-band background task and return immediately. Currently only
	// exec_cmd uses this, for background:true requests. Nil means background
	// mode is not available in this invocation.
	TaskRunner TaskRunner

	// Broadcast, if set, sends an arbitrary JSON payload to every connected
	// WebSocket client (browser extension + TUI). The `question` tool uses
	// this to push a question_ask event and then wait for question_answer.
	// Nil means broadcast is not available in this invocation.
	Broadcast func(payload []byte)
}

// EffectiveRootDir returns the snapshot RootDir captured by the executor at
// request entry. Falls back to Config.GetRootDir() (and finally "") so callers
// outside the executor (tests, direct invocation) continue to work.
func (c *Context) EffectiveRootDir() string {
	if c == nil {
		return ""
	}
	if c.RootDir != "" {
		return c.RootDir
	}
	if c.Config != nil {
		return c.Config.GetRootDir()
	}
	return ""
}

// TaskRunner is the minimal background-task surface the tool package depends
// on. The real implementation lives in the executor package; declaring the
// interface here keeps tools free of an executor import.
type TaskRunner interface {
	Start(spec TaskSpec) (taskID string, err error)
	Snapshots() []TaskSnapshot
	GetSnapshot(id string) (snap TaskSnapshot, stdout, stderr string, ok bool)
	Stop(id string) error
	SendStdin(id, data string) error
}

// TaskSnapshot mirrors executor.TaskSummary in a tool-package-local form so
// task_list / task_output tools can render results without a package cycle.
type TaskSnapshot struct {
	ID         string
	CallID     string
	Command    string
	Status     string
	StartedAt  string
	EndedAt    string
	ExitCode   int
	ErrMsg     string
	StdoutSize int
	StderrSize int
}

// TaskSpec describes a single background command launch.
type TaskSpec struct {
	CallID  string
	Command string
	Dir     string
	Timeout time.Duration
	// OnChunk, OnDone are invoked from the task's own goroutine.
	OnChunk func(stream, text string)
	OnDone  func(exitCode int, durationMs int64, errMsg string)
}

type Result struct {
	Status     string
	Output     string
	Error      string
	StopStream bool
	StartTime  time.Time
	EndTime    time.Time
}

type ToolInfo struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Parameters  interface{} `json:"parameters,omitempty"`
}

// resolveAbsPath validates an absolute path against RootDir and common allowed roots (~/.claude, ~/.openlink, ~/.agent).
func resolveAbsPath(path, rootDir string) (string, error) {
	home, _ := os.UserHomeDir()
	roots := []string{
		rootDir,
		filepath.Join(home, ".claude"),
		filepath.Join(home, ".openlink"),
		filepath.Join(home, ".agent"),
	}
	return security.SafeAbsPath(path, roots...)
}
