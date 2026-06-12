package tool

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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

type ToolMetadata struct {
	ReadOnly bool `json:"readOnly"`
}

type MetadataProvider interface {
	Metadata() ToolMetadata
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

	// AdditionalAllowedDirs is a request-entry snapshot of Config's extra sandbox
	// roots. Tools combine it with RootDir for absolute path validation.
	AdditionalAllowedDirs []string
	PermissionMode        string

	// Agents, if set, is the registry of dispatched worker agents. The
	// spawn_agent / send_to_agent / stop_agent tools use it to track and
	// address workers. Nil means multi-agent dispatch is not available in this
	// invocation.
	Agents *AgentRegistry

	// Client groups WebSocket-client IO + identity: Streamer, Broadcast,
	// BroadcastToClient, SourceClientID, ConversationURL.
	Client ClientIO

	// Tasks groups background-task handoff.
	Tasks TaskAccess
}

type sourceClientIDContextKey struct{}

func ContextWithSourceClientID(ctx context.Context, clientID string) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if strings.TrimSpace(clientID) == "" {
		return ctx
	}
	return context.WithValue(ctx, sourceClientIDContextKey{}, clientID)
}

func SourceClientIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if v, ok := ctx.Value(sourceClientIDContextKey{}).(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
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

func (c *Context) EffectiveAllowedRoots() []string {
	rootDir := c.EffectiveRootDir()
	roots := make([]string, 0, 1+len(c.AdditionalAllowedDirs))
	if rootDir != "" {
		roots = append(roots, rootDir)
	}
	if c.EffectivePermissionMode() == "auto" {
		parent := filepath.Dir(rootDir)
		if parent != rootDir && filepath.Dir(parent) != parent {
			roots = append(roots, parent)
		}
	}
	if len(c.AdditionalAllowedDirs) > 0 {
		roots = append(roots, c.AdditionalAllowedDirs...)
	} else if c.Config != nil {
		roots = append(roots, c.Config.GetAdditionalAllowedDirs()...)
	}
	return roots
}

func (c *Context) EffectivePermissionMode() string {
	if c == nil {
		return "default"
	}
	if c.PermissionMode != "" {
		return types.NormalizePermissionMode(c.PermissionMode)
	}
	if c.Config != nil {
		return c.Config.GetPermissionMode()
	}
	return "default"
}

func (c *Context) ResolvePath(path string) (string, error) {
	rootDir := c.EffectiveRootDir()
	if c.EffectivePermissionMode() == "unrestricted" {
		return unrestrictedPath(rootDir, path)
	}
	if filepath.IsAbs(path) || strings.HasPrefix(path, "~/") {
		return resolveAbsPath(path, c.EffectiveAllowedRoots())
	}
	return security.SafePath(rootDir, path)
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
	ID              string
	CallID          string
	SourceClientID  string
	ConversationURL string
	Command         string
	Status          string
	StartedAt       string
	EndedAt         string
	ExitCode        int
	ErrMsg          string
	StdoutSize      int
	StderrSize      int
}

// TaskSpec describes a single background command launch.
type TaskSpec struct {
	CallID          string
	SourceClientID  string
	ConversationURL string
	Command         string
	Dir             string
	Timeout         time.Duration
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
	ReadOnly    bool        `json:"readOnly"`
}

func InfoFor(tool Tool) ToolInfo {
	info := ToolInfo{
		Name:        tool.Name(),
		Description: tool.Description(),
		Parameters:  tool.Parameters(),
	}
	if provider, ok := tool.(MetadataProvider); ok {
		info.ReadOnly = provider.Metadata().ReadOnly
	}
	return info
}

type BrowserController interface {
	ListTabs(ctx context.Context, includeAI bool) ([]BrowserTab, error)
	NewTab(ctx context.Context, url string) (BrowserTab, error)
	UseTab(ctx context.Context, tabID int, reason, callID string) (BrowserTab, error)
	Navigate(ctx context.Context, tabID *int, url, callID string) (BrowserTab, error)
	NavigateWithBeforeunload(ctx context.Context, tabID *int, url, callID, beforeunloadPolicy string) (BrowserTab, error)
	Snapshot(ctx context.Context, tabID *int, maxNodes int) (BrowserSnapshot, error)
	Click(ctx context.Context, req BrowserClickRequest) (string, error)
	Type(ctx context.Context, req BrowserTypeRequest) (string, error)
	Clipboard(ctx context.Context, req BrowserClipboardRequest) (BrowserClipboardResponse, error)
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
	Find(ctx context.Context, req BrowserFindRequest) ([]BrowserFindResult, error)
	Zoom(ctx context.Context, req BrowserZoomRequest) (BrowserZoomResponse, error)
	Resize(ctx context.Context, req BrowserResizeRequest) (string, error)
	FormInput(ctx context.Context, req BrowserFormInputRequest) (string, error)
	ReadConsole(ctx context.Context, req BrowserConsoleRequest) (string, error)
	ReadNetwork(ctx context.Context, req BrowserNetworkLogRequest) (string, error)
	Cookies(ctx context.Context, req BrowserCookiesRequest) (BrowserCookiesResponse, error)
	FinalizeTabs(ctx context.Context, req BrowserFinalizeTabsRequest) (BrowserFinalizeTabsResponse, error)
	Viewport(ctx context.Context, req BrowserViewportRequest) (string, error)
	Downloads(ctx context.Context, req BrowserDownloadsRequest) (BrowserDownloadsResponse, error)
	Storage(ctx context.Context, req BrowserStorageRequest) (string, error)
	SetCookie(ctx context.Context, req BrowserSetCookieRequest) (string, error)
	WaitForNavigation(ctx context.Context, req BrowserWaitForNavigationRequest) (string, error)
	Emulate(ctx context.Context, req BrowserEmulateRequest) (string, error)
	GetAttributes(ctx context.Context, req BrowserGetAttributesRequest) (string, error)
}

type BrowserTab struct {
	TabID       int    `json:"tabId"`
	URL         string `json:"url"`
	Title       string `json:"title"`
	Active      bool   `json:"active"`
	Controlled  bool   `json:"controlled"`
	Tracked     bool   `json:"tracked,omitempty"`
	TrackSource string `json:"trackSource,omitempty"`
}

// SafeTitle returns the tab title flattened to a single line, stripped of
// control characters and length-capped. Page titles are attacker-controllable,
// so any title interpolated into a tool result the model reads must go through
// this rather than using Title directly (prompt-injection defense).
func (t BrowserTab) SafeTitle() string {
	return security.SanitizeLabel(t.Title, 200)
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
	Button     string // "left" (default), "right", "middle"
	ClickCount int    // 1 (default), 2 (double), 3 (triple)
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
	// Mode selects the text-entry mechanism. "insert" (default) uses CDP
	// Input.insertText — fast, but fires no keydown/keypress/keyup events.
	// "keys" sends a keyDown/keyUp pair per character so editors, autocomplete,
	// and key-listening widgets (Monaco, CodeMirror, games) react.
	Mode   string
	CallID string
}

type BrowserClipboardRequest struct {
	TabID  *int
	Action string // "read" or "write"
	Text   string // text to write (write action)
	CallID string
}

type BrowserClipboardResponse struct {
	Tab  BrowserTab
	Text string // clipboard contents (read action)
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
	TimeoutMS     int
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
	By         string // "value" (default), "label", or "index"
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
	// Mode selects the drag mechanism. "html5" (default) synthesizes the full
	// dragstart→dragover→drop→dragend DragEvent sequence with a shared
	// DataTransfer, which is what modern DnD libraries (react-dnd, SortableJS)
	// listen for. "mouse" sends raw mousedown→move→mouseup, for native
	// pointer-drag UIs (canvas, sliders, map panning) that ignore HTML5 DnD.
	Mode   string
	CallID string
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

type BrowserFindRequest struct {
	TabID      *int
	Query      string
	MaxResults int
}

type BrowserFindResult struct {
	Ref   string `json:"ref"`
	Role  string `json:"role"`
	Text  string `json:"text"`
	Score int    `json:"score"`
}

type BrowserZoomRequest struct {
	TabID      *int
	Ref        string
	Selector   string
	X          *float64
	Y          *float64
	Width      *float64
	Height     *float64
	SnapshotID string
	CallID     string
	OutputDir  string
}

type BrowserZoomResponse struct {
	Tab      BrowserTab
	FilePath string
	Bytes    int
}

type BrowserResizeRequest struct {
	TabID  *int
	Width  int
	Height int
}

type BrowserFormInputRequest struct {
	TabID      *int
	Ref        string
	Selector   string
	SnapshotID string
	Value      interface{}
	CallID     string
}

type BrowserConsoleRequest struct {
	TabID      *int
	Pattern    string
	OnlyErrors bool
	Clear      bool
	Limit      int
}

type BrowserNetworkLogRequest struct {
	TabID      *int
	URLPattern string
	Clear      bool
	Limit      int
	// RequestID, when set, fetches that one request's response body instead of
	// listing requests. The id comes from the [id=…] column of a prior list.
	RequestID    string
	MaxBodyBytes int
}

type BrowserCookiesRequest struct {
	Domain       string
	URL          string
	IncludeValue bool
	Limit        int
}

type BrowserCookie struct {
	Name           string  `json:"name"`
	Value          string  `json:"value,omitempty"`
	Domain         string  `json:"domain"`
	Path           string  `json:"path"`
	Secure         bool    `json:"secure"`
	HTTPOnly       bool    `json:"httpOnly"`
	SameSite       string  `json:"sameSite,omitempty"`
	Session        bool    `json:"session"`
	ExpirationDate float64 `json:"expirationDate,omitempty"`
	StoreID        string  `json:"storeId,omitempty"`
}

type BrowserCookiesResponse struct {
	Cookies      []BrowserCookie `json:"cookies"`
	Count        int             `json:"count"`
	Total        int             `json:"total"`
	Truncated    bool            `json:"truncated"`
	IncludeValue bool            `json:"includeValue"`
}

type BrowserFinalizeTabsRequest struct {
	CloseTabIDs      []int
	ReleaseTabIDs    []int
	CloseClaimedTabs bool
	CallID           string
}

type BrowserFinalizeTabsResponse struct {
	Closed   []int    `json:"closed"`
	Released []int    `json:"released"`
	Skipped  []string `json:"skipped,omitempty"`
}

type BrowserViewportRequest struct {
	TabID  *int
	Width  int
	Height int
	Reset  bool
}

type BrowserDownloadsRequest struct {
	Limit int
	State string
}

type BrowserDownload struct {
	ID            string `json:"id"`
	URL           string `json:"url,omitempty"`
	Filename      string `json:"filename,omitempty"`
	State         string `json:"state"`
	Error         string `json:"error,omitempty"`
	BytesReceived int64  `json:"bytesReceived,omitempty"`
	TotalBytes    int64  `json:"totalBytes,omitempty"`
	StartedAt     string `json:"startedAt,omitempty"`
	EndedAt       string `json:"endedAt,omitempty"`
}

type BrowserDownloadsResponse struct {
	Downloads []BrowserDownload `json:"downloads"`
	Count     int               `json:"count"`
	Total     int               `json:"total"`
	Truncated bool              `json:"truncated"`
}

type BrowserStorageRequest struct {
	TabID   *int
	Action  string // get|set|remove|clear|keys
	Storage string // local|session
	Key     string
	Value   string
}

type BrowserSetCookieRequest struct {
	Action         string // set|delete
	Name           string
	Value          string
	Domain         string
	Path           string
	URL            string
	Secure         bool
	HTTPOnly       bool
	SameSite       string
	ExpirationDate float64
	CallID         string
}

type BrowserWaitForNavigationRequest struct {
	TabID          *int
	URLPattern     string
	WaitUntil      string // load|domcontentloaded|networkidle
	TimeoutSeconds int
	CallID         string
}

type BrowserEmulateRequest struct {
	TabID             *int
	UserAgent         string
	DeviceScaleFactor float64
	Mobile            *bool
	ColorScheme       string // light|dark|no-preference
	Timezone          string
	Latitude          *float64
	Longitude         *float64
	Accuracy          *float64
	Reset             bool
	CallID            string
}

type BrowserGetAttributesRequest struct {
	TabID      *int
	Ref        string
	Selector   string
	SnapshotID string
	Attributes []string
	Styles     []string
}

// resolveAbsPath validates an absolute path against allowed workspace roots and
// common tool-state roots (~/.claude, ~/.piercode, ~/.agent).
func resolveAbsPath(path string, roots []string) (string, error) {
	home, _ := os.UserHomeDir()
	allowed := append([]string(nil), roots...)
	allowed = append(allowed,
		filepath.Join(home, ".claude"),
		filepath.Join(home, ".piercode"),
		filepath.Join(home, ".agent"),
	)
	return security.SafeAbsPath(path, allowed...)
}

func unrestrictedPath(rootDir, path string) (string, error) {
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, path[2:])
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(rootDir, path)
	}
	return filepath.Abs(path)
}
