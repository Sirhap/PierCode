package tool

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/sirhap/piercode/internal/security"
	"github.com/sirhap/piercode/internal/types"
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
	Browser BrowserController

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

type BrowserController interface {
	ListTabs(ctx context.Context, includeAI bool) ([]BrowserTab, error)
	NewTab(ctx context.Context, url string) (BrowserTab, error)
	UseTab(ctx context.Context, tabID int, reason, callID string) (BrowserTab, error)
	Navigate(ctx context.Context, tabID *int, url, callID string) (BrowserTab, error)
	Snapshot(ctx context.Context, tabID *int, maxNodes int) (BrowserSnapshot, error)
	Click(ctx context.Context, req BrowserClickRequest) (string, error)
	Type(ctx context.Context, req BrowserTypeRequest) (string, error)
	Screenshot(ctx context.Context, req BrowserScreenshotRequest) (BrowserScreenshot, error)
	Wait(ctx context.Context, req BrowserWaitRequest) (string, error)
	WaitForFunction(ctx context.Context, req BrowserWaitForFunctionRequest) (string, error)
	Hover(ctx context.Context, req BrowserHoverRequest) (string, error)
	Scroll(ctx context.Context, req BrowserScrollRequest) (string, error)
	Evaluate(ctx context.Context, req BrowserEvaluateRequest) (BrowserEvaluateResponse, error)
	GetContent(ctx context.Context, req BrowserGetContentRequest) (string, error)
	Select(ctx context.Context, req BrowserSelectRequest) (string, error)
	GoBack(ctx context.Context, tabID *int, callID string) (BrowserTab, error)
	GoForward(ctx context.Context, tabID *int, callID string) (BrowserTab, error)
	Reload(ctx context.Context, req BrowserReloadRequest) (BrowserTab, error)
	Focus(ctx context.Context, req BrowserFocusRequest) (string, error)
	PressKey(ctx context.Context, req BrowserPressKeyRequest) (string, error)
	Drag(ctx context.Context, req BrowserDragRequest) (string, error)
	PDF(ctx context.Context, req BrowserPDFRequest) (BrowserPDFResponse, error)
	Upload(ctx context.Context, req BrowserUploadRequest) (string, error)
	HandleDialog(ctx context.Context, req BrowserHandleDialogRequest) (string, error)
}

type BrowserTab struct {
	TabID      int    `json:"tabId"`
	URL        string `json:"url"`
	Title      string `json:"title"`
	Active     bool   `json:"active"`
	Controlled bool   `json:"controlled"`
}

type BrowserSnapshot struct {
	SnapshotID string
	Tab        BrowserTab
	Text       string
	NodeCount  int
	RefCount   int
	Truncated  bool
}

type BrowserClickRequest struct {
	TabID      *int
	Ref        string
	Selector   string
	X          *float64
	Y          *float64
	SnapshotID string
	CallID     string
}

type BrowserTypeRequest struct {
	TabID      *int
	Text       string
	Ref        string
	Selector   string
	SnapshotID string
	Clear      bool
	Submit     bool
	CallID     string
}

type BrowserScreenshotRequest struct {
	TabID     *int
	Format    string
	Quality   int
	FullPage  bool
	OutputDir string
}

type BrowserScreenshot struct {
	Tab      BrowserTab
	Format   string
	Bytes    int
	Width    int
	Height   int
	DataURL  string
	FilePath string // [Fixed by mimo-v2.5-pro: screenshot saved to file]
}

type BrowserWaitRequest struct {
	TabID          *int
	Selector       string
	State          string
	LoadState      string
	TimeoutSeconds int
}

type BrowserWaitForFunctionRequest struct {
	TabID          *int
	Expression     string
	TimeoutSeconds int
	Polling        string
}

type BrowserHoverRequest struct {
	TabID            *int
	Ref              string
	Selector         string
	X                *float64
	Y                *float64
	SnapshotID       string
	WaitAfterHoverMS int
	CallID           string
}

type BrowserScrollRequest struct {
	TabID      *int
	Ref        string
	Selector   string
	SnapshotID string
	Direction  string
	Amount     int
	Method     string
}

type BrowserEvaluateRequest struct {
	TabID         *int
	Expression    string
	ReturnByValue bool
	CallID        string
}

type BrowserEvaluateResponse struct {
	Tab   BrowserTab
	Type  string
	Value string
}

type BrowserGetContentRequest struct {
	TabID    *int
	Format   string
	Selector string
}

type BrowserSelectRequest struct {
	TabID      *int
	Ref        string
	Selector   string
	SnapshotID string
	Value      string
	CallID     string
}

type BrowserReloadRequest struct {
	TabID       *int
	IgnoreCache bool
}

type BrowserFocusRequest struct {
	TabID      *int
	Ref        string
	Selector   string
	SnapshotID string
}

type BrowserPressKeyRequest struct {
	TabID  *int
	Key    string
	CallID string
}

type BrowserDragRequest struct {
	TabID        *int
	FromRef      string
	FromSelector string
	FromX        *float64
	FromY        *float64
	ToRef        string
	ToSelector   string
	ToX          *float64
	ToY          *float64
	SnapshotID   string
	CallID       string
}

type BrowserPDFRequest struct {
	TabID      *int
	OutputPath string
	Format     string
	Landscape  bool
}

type BrowserPDFResponse struct {
	Tab      BrowserTab
	FilePath string
	Bytes    int
}

type BrowserUploadRequest struct {
	TabID      *int
	Ref        string
	Selector   string
	SnapshotID string
	Paths      []string
	CallID     string
}

type BrowserHandleDialogRequest struct {
	TabID          *int
	Action         string
	PromptText     string
	TimeoutSeconds int
	CallID         string
}

// resolveAbsPath validates an absolute path against RootDir and common allowed roots (~/.claude, ~/.piercode, ~/.agent).
func resolveAbsPath(path, rootDir string) (string, error) {
	home, _ := os.UserHomeDir()
	roots := []string{
		rootDir,
		filepath.Join(home, ".claude"),
		filepath.Join(home, ".piercode"),
		filepath.Join(home, ".agent"),
	}
	return security.SafeAbsPath(path, roots...)
}
