package executor

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sirhap/piercode/internal/logsink"
	"github.com/sirhap/piercode/internal/prompt"
	"github.com/sirhap/piercode/internal/skill"
	"github.com/sirhap/piercode/internal/tool"
	"github.com/sirhap/piercode/internal/types"
)

type Executor struct {
	config   *types.Config
	registry *tool.Registry
	profiles *prompt.ProfileRegistry
	// guidanceCounts tracks per-conversation AI tool-call counts so the periodic
	// guidance cadence (operating reminder every few turns, checkpoint every
	// fifth) follows each conversation's own progress instead of a single global
	// counter shared across all tabs/workers. Keyed by conversation URL, falling
	// back to client id, then a shared bucket. Each entry carries a lastSeen
	// timestamp so the GC goroutine can evict idle conversations — otherwise a
	// long-running server leaks one permanent entry per conversation URL ever
	// seen.
	guidanceCounts  sync.Map // map[string]*guidanceCounter
	guidanceGCStop  chan struct{}
	guidanceGCClose sync.Once
	toolMu          sync.RWMutex
	// logger is read from Execute on every tool call (potentially many
	// goroutines) and written from SetLogger at startup or when the TUI
	// reconfigures. atomic.Pointer keeps the read path lock-free and
	// race-free without forcing every caller through a mutex.
	logger            atomic.Value // stores logsink.Sink
	tasks             *TaskManager
	agents            *tool.AgentRegistry
	broadcast         atomic.Pointer[func([]byte)]
	broadcastToClient atomic.Pointer[func(string, []byte) bool]
	browserMu         sync.RWMutex
	browser           tool.BrowserController
	// keyedLocks holds fine-grained mutexes for tools whose conflicts are
	// scoped, not global: browser write tools per target tab ("tab:<id>" /
	// "tab:default") and single-path file writers per normalized path
	// ("path:<abs>"). Distinct keys run in parallel; one key stays strictly
	// ordered. map[string]*sync.Mutex.
	keyedLocks sync.Map
}

// SetLogger sets the event sink for real-time feedback. Safe to call
// concurrently with Execute.
func (e *Executor) SetLogger(logger logsink.Sink) {
	e.logger.Store(logger)
}

func (e *Executor) getLogger() logsink.Sink {
	v := e.logger.Load()
	if v == nil {
		return nil
	}
	s, _ := v.(logsink.Sink)
	return s
}

// SetBroadcaster wires a WS-broadcast callback so tools like `question` can
// push events to every connected client. Safe to call concurrently with
// Execute; passing nil disables broadcasting.
func (e *Executor) SetBroadcaster(fn func([]byte)) {
	if fn == nil {
		e.broadcast.Store(nil)
		return
	}
	e.broadcast.Store(&fn)
}

func (e *Executor) SetClientBroadcaster(fn func(string, []byte) bool) {
	if fn == nil {
		e.broadcastToClient.Store(nil)
		return
	}
	e.broadcastToClient.Store(&fn)
}

func (e *Executor) SetBrowserController(controller tool.BrowserController) {
	e.browserMu.Lock()
	e.browser = controller
	e.browserMu.Unlock()
}

// Tasks returns the background task manager owned by this executor.
func (e *Executor) Tasks() *TaskManager {
	return e.tasks
}

// Agents returns the worker-agent registry owned by this executor. The server's
// WS layer consults it to bind workers and route result packets.
func (e *Executor) Agents() *tool.AgentRegistry {
	return e.agents
}

func New(config *types.Config) *Executor {
	e := &Executor{
		config:         config,
		registry:       tool.NewRegistry(),
		profiles:       prompt.DefaultProfileRegistry(config.DefaultPrompt),
		tasks:          NewTaskManager(),
		agents:         tool.NewAgentRegistry(),
		guidanceGCStop: make(chan struct{}),
	}
	go e.runGuidanceGC()
	e.registry.Register(tool.NewExecCmdTool(config))
	e.registry.Register(tool.NewListDirTool(config))
	e.registry.Register(tool.NewReadFileTool(config))
	e.registry.Register(tool.NewWriteFileTool(config))
	e.registry.Register(tool.NewApplyPatchTool(config))
	e.registry.Register(tool.NewGlobTool(config))
	e.registry.Register(tool.NewGrepTool(config))
	e.registry.Register(tool.NewEditTool(config))
	e.registry.Register(tool.NewMultiEditTool(config))
	e.registry.Register(tool.NewMoveTool(config))
	e.registry.Register(tool.NewUndoTool(config))
	e.registry.Register(tool.NewWebFetchTool())
	e.registry.Register(tool.NewQuestionTool())
	e.registry.Register(tool.NewSkillTool(config))
	e.registry.Register(tool.NewTodoWriteTool(config))
	e.registry.Register(tool.NewTodoReadTool(config))
	e.registry.Register(tool.NewMemoryReadTool(config))
	e.registry.Register(tool.NewMemoryWriteTool(config))
	e.registry.Register(tool.NewMemoryForgetTool(config))
	e.registry.Register(tool.NewTaskListTool())
	e.registry.Register(tool.NewTaskOutputTool())
	e.registry.Register(tool.NewTaskStopTool())
	e.registry.Register(tool.NewSendStdinTool())
	e.registry.Register(tool.NewBrowserTabsTool())
	e.registry.Register(tool.NewBrowserNewTabTool())
	e.registry.Register(tool.NewBrowserUseTabTool())
	e.registry.Register(tool.NewBrowserNavigateTool())
	e.registry.Register(tool.NewBrowserSnapshotTool())
	e.registry.Register(tool.NewBrowserClickTool())
	e.registry.Register(tool.NewBrowserTypeTool())
	e.registry.Register(tool.NewBrowserClipboardTool())
	e.registry.Register(tool.NewBrowserBatchTool())
	e.registry.Register(tool.NewBrowserScreenshotTool())
	e.registry.Register(tool.NewBrowserRecordTool())
	e.registry.Register(tool.NewBrowserWaitTool())
	e.registry.Register(tool.NewBrowserWaitForFunctionTool())
	e.registry.Register(tool.NewBrowserHoverTool())
	e.registry.Register(tool.NewBrowserScrollTool())
	e.registry.Register(tool.NewBrowserEvaluateTool())
	e.registry.Register(tool.NewBrowserGetContentTool())
	e.registry.Register(tool.NewBrowserGetPageTextTool())
	e.registry.Register(tool.NewBrowserSelectTool())
	e.registry.Register(tool.NewBrowserGoBackTool())
	e.registry.Register(tool.NewBrowserGoForwardTool())
	e.registry.Register(tool.NewBrowserReloadTool())
	e.registry.Register(tool.NewBrowserFocusTool())
	e.registry.Register(tool.NewBrowserPressKeyTool())
	e.registry.Register(tool.NewBrowserDragTool())
	e.registry.Register(tool.NewBrowserPDFTool())
	e.registry.Register(tool.NewBrowserUploadTool())
	e.registry.Register(tool.NewBrowserHandleDialogTool())
	e.registry.Register(tool.NewBrowserFindTool())
	e.registry.Register(tool.NewBrowserZoomTool())
	e.registry.Register(tool.NewBrowserResizeTool())
	e.registry.Register(tool.NewBrowserFormInputTool())
	e.registry.Register(tool.NewBrowserConsoleTool())
	e.registry.Register(tool.NewBrowserNetworkTool())
	e.registry.Register(tool.NewBrowserCookiesTool())
	e.registry.Register(tool.NewBrowserFinalizeTabsTool())
	e.registry.Register(tool.NewBrowserViewportTool())
	e.registry.Register(tool.NewBrowserDownloadsTool())
	e.registry.Register(tool.NewBrowserStorageTool())
	e.registry.Register(tool.NewBrowserSetCookieTool())
	e.registry.Register(tool.NewBrowserWaitForNavigationTool())
	e.registry.Register(tool.NewBrowserEmulateTool())
	e.registry.Register(tool.NewBrowserGetAttributesTool())
	e.registry.Register(tool.NewSpawnAgentTool())
	e.registry.Register(tool.NewListAgentsTool())
	e.registry.Register(tool.NewSendToAgentTool())
	e.registry.Register(tool.NewStopAgentTool())
	e.registry.Register(tool.NewToolHelpTool(e.registry))
	return e
}

// Streamer is the callback signature used to forward live stdout/stderr
// chunks from a streaming tool execution (currently only exec_cmd).
type Streamer func(stream, text string)

// Execute keeps the legacy signature — no live streamer, no background task
// runner. Callers that want streaming should use ExecuteWithStream.
func (e *Executor) Execute(ctx context.Context, req *types.ToolRequest) *types.ToolResponse {
	return e.ExecuteWithStream(ctx, req, nil)
}

// ExecuteWithStream runs a tool with an optional live-output callback. The
// streamer, if non-nil, receives stdout/stderr chunks for streaming-capable
// tools (currently exec_cmd) and is silently ignored for the rest.
func (e *Executor) ExecuteWithStream(ctx context.Context, req *types.ToolRequest, streamer Streamer) *types.ToolResponse {
	log.Printf("[Executor] 执行工具: %s\n", req.Name)

	t, exists := e.registry.Get(req.Name)
	if !exists {
		t, exists = e.registry.Get(strings.ToLower(req.Name))
	}
	if !exists {
		invalid := &tool.InvalidTool{}
		args := copyToolArgs(req.Args, 1)
		args["tool"] = req.Name
		msg := invalid.Execute(&tool.Context{Context: ctx, Args: args, Config: e.config}).Error
		if logger := e.getLogger(); logger != nil {
			logger.LogToolCall(req.Name, "error", "Tool not found")
		}
		return &types.ToolResponse{Name: req.Name, CallID: req.CallID, Status: "error", Output: msg, Error: msg}
	}

	if err := t.Validate(req.Args); err != nil {
		msg := fmt.Sprintf("validation failed: %s", err)
		if logger := e.getLogger(); logger != nil {
			logger.LogToolCall(req.Name, "error", msg)
		}
		// Append a tool_help pointer for AI callers so a malformed call can be
		// corrected without guessing. Direct API/TUI callers get the raw message.
		if req.SourceClientID != "" {
			msg = tool.EnrichErrorMessage(req.Name, msg)
		}
		return &types.ToolResponse{Name: req.Name, CallID: req.CallID, Status: "error", Output: msg, Error: msg}
	}

	// Always copy Args before handing them to tools. A caller that retries or
	// logs the same ToolRequest should not observe tool-local mutations such
	// as injected call_id values or invalid-tool metadata.
	toolArgs := copyToolArgs(req.Args, 1)
	if req.CallID != "" {
		if _, present := toolArgs["call_id"]; !present {
			toolArgs["call_id"] = req.CallID
		}
	}

	// Snapshot RootDir at request entry so the entire tool call sees a single
	// consistent value. Without this, a concurrent /cwd could swap the global
	// RootDir between e.g. SafePath() and the actual write — the path resolves
	// against root A but writes land under root B.
	rootSnapshot := e.config.GetRootDir()
	additionalRootsSnapshot := e.config.GetAdditionalAllowedDirs()
	permissionModeSnapshot := e.config.GetPermissionMode()
	callCtx := tool.ContextWithSourceClientID(ctx, req.SourceClientID)
	toolCtx := &tool.Context{
		Context:               callCtx,
		Args:                  toolArgs,
		Config:                e.config,
		RootDir:               rootSnapshot,
		AdditionalAllowedDirs: additionalRootsSnapshot,
		PermissionMode:        permissionModeSnapshot,
		Agents:                e.agents,
		Tasks:                 tool.TaskAccess{Runner: e.tasks},
		Client: tool.ClientIO{
			SourceClientID:  req.SourceClientID,
			ConversationURL: req.ConversationURL,
		},
	}
	e.browserMu.RLock()
	toolCtx.Browser = e.browser
	e.browserMu.RUnlock()
	// browser_batch re-dispatches each sub-call through the full pipeline so
	// per-item validation/approval/locking all apply. Carry the originating
	// client identity + conversation so approvals route to the same chat.
	toolCtx.Dispatch = func(name string, args map[string]interface{}) tool.BatchItemResult {
		sub := &types.ToolRequest{
			Name:            name,
			Args:            args,
			SourceClientID:  req.SourceClientID,
			ConversationURL: req.ConversationURL,
		}
		resp := e.ExecuteWithStream(ctx, sub, streamer)
		return tool.BatchItemResult{Status: resp.Status, Output: resp.Output, Error: resp.Error}
	}
	if streamer != nil {
		toolCtx.Client.Streamer = func(stream, text string) { streamer(stream, text) }
	}
	if bp := e.broadcast.Load(); bp != nil {
		toolCtx.Client.Broadcast = *bp
	}
	if bp := e.broadcastToClient.Load(); bp != nil {
		toolCtx.Client.BroadcastToClient = *bp
	}

	unlock := e.lockForTool(req.Name, req.Args, rootSnapshot)
	result := t.Execute(toolCtx)
	unlock()

	// Augment runtime errors with an actionable hint for AI callers so they can
	// self-correct (e.g. missing path -> "verify with list_dir"). Direct API/TUI
	// callers keep the raw message untouched.
	if result.Status == "error" && req.SourceClientID != "" {
		result.Error = tool.EnrichErrorMessage(req.Name, result.Error)
	}

	resp := &types.ToolResponse{
		Name:       req.Name,
		CallID:     req.CallID,
		Status:     result.Status,
		Output:     result.Output,
		Error:      result.Error,
		StopStream: result.StopStream,
	}
	if result.Status == "error" && result.Output == "" {
		resp.Output = result.Error
	}

	// TUI Log: End
	if logger := e.getLogger(); logger != nil {
		logger.LogToolCallFull(req.Name, resp.Status, summarizeToolLog(req, resp), fullToolLog(req, resp))
	}

	// Fix 4: append operating reminders; re-inject full prompt every 20 calls.
	// SECURITY: 之前会优先从 <rootDir>/prompts/init_prompt.txt 读取——但该
	// 路径在 sandbox 内，AI 用 write_file 即可改写，从而永久篡改自己的系统
	// 提示词。改为只信任二进制内嵌的 DefaultPrompt（prompts/prompts.go 通过
	// //go:embed 提供）。
	// Only inject operating reminders when the call originates from an AI
	// client (SourceClientID is set) AND this call opted in. The extension
	// clears WithGuidance on every tool of an auto-executed batch except the
	// last, so a multi-tool turn carries the reminder once, not once per tool.
	// Direct /exec API calls from the CLI or E2E tests have no SourceClientID
	// and get clean output.
	if req.SourceClientID != "" && req.GuidanceEnabled() {
		n := e.nextGuidanceCount(req)
		e.appendPromptGuidance(resp, n, req.Profile)
	}

	return resp
}

// guidanceCounter is one conversation's guidance turn counter plus the wall
// time it was last touched. lastSeen is stored as unix nanoseconds so it can be
// read/written atomically from the hot path (every tool call) and the GC sweep
// concurrently without a mutex.
type guidanceCounter struct {
	count    atomic.Int64
	lastSeen atomic.Int64 // unix nanoseconds
}

const (
	// guidanceIdleTTL is how long a conversation's guidance counter survives
	// without a tool call before the GC evicts it. A conversation idle this long
	// is effectively over; if it ever resumes, a fresh counter is created (the
	// cadence resets, which is harmless).
	guidanceIdleTTL = 2 * time.Hour
	// guidanceGCInterval is how often the GC goroutine sweeps idle counters.
	guidanceGCInterval = 15 * time.Minute
)

// nextGuidanceCount returns the per-conversation guidance counter, incremented.
// Keyed by conversation URL so each conversation's cadence follows its own turn
// count; falls back to client id, then a shared bucket, when the URL is absent.
func (e *Executor) nextGuidanceCount(req *types.ToolRequest) int64 {
	key := strings.TrimSpace(req.ConversationURL)
	if key == "" {
		key = strings.TrimSpace(req.SourceClientID)
	}
	if key == "" {
		key = "_shared"
	}
	v, _ := e.guidanceCounts.LoadOrStore(key, new(guidanceCounter))
	gc := v.(*guidanceCounter)
	gc.lastSeen.Store(time.Now().UnixNano())
	return gc.count.Add(1)
}

// runGuidanceGC periodically evicts idle per-conversation guidance counters so
// the guidanceCounts map does not grow without bound over a long-running server
// (one entry per conversation URL ever seen would otherwise leak forever).
// Mirrors TaskManager.runGC. Exits when Close closes guidanceGCStop.
func (e *Executor) runGuidanceGC() {
	ticker := time.NewTicker(guidanceGCInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			e.guidanceGCSweep(time.Now())
		case <-e.guidanceGCStop:
			return
		}
	}
}

func (e *Executor) guidanceGCSweep(now time.Time) {
	cutoff := now.Add(-guidanceIdleTTL).UnixNano()
	e.guidanceCounts.Range(func(key, value any) bool {
		gc, ok := value.(*guidanceCounter)
		if !ok {
			e.guidanceCounts.Delete(key)
			return true
		}
		if gc.lastSeen.Load() < cutoff {
			e.guidanceCounts.Delete(key)
		}
		return true
	})
}

// Close stops the executor's background goroutines (currently the guidance-GC
// sweeper). Safe to call multiple times via sync.Once. The owned TaskManager has
// its own Close and is shut down by the server separately.
func (e *Executor) Close() {
	e.guidanceGCClose.Do(func() {
		if e.guidanceGCStop != nil {
			close(e.guidanceGCStop)
		}
	})
}

// ResolveProfile returns the prompt profile for the given adapter/profile id
// from the executor's shared registry. The /prompt route and the periodic
// re-injection then render from the same profile surface.
func (e *Executor) ResolveProfile(id string) prompt.Profile {
	return e.profiles.Select(id)
}

func (e *Executor) appendPromptGuidance(resp *types.ToolResponse, n int64, profileID string) {
	profile := e.profiles.Select(profileID)
	resp.Output += profile.GuidanceFor(n, func() []byte {
		rootDir := e.config.GetRootDir()
		return profile.RenderWithSandbox(rootDir, e.config.GetPermissionMode(), e.config.GetAdditionalAllowedDirs(), e.ListTools(), skill.LoadInfos(rootDir))
	})
}

func (e *Executor) ListTools() []tool.ToolInfo {
	all := e.registry.List()
	// When the operator hasn't opted in to shell access, hide exec_cmd from
	// the rendered prompt and /tools listing entirely. Otherwise the AI sees
	// it documented, tries it, gets a "exec_cmd is disabled" error, and
	// burns a turn — and the same prompt will trick it again on the next
	// task. Treat absent ≡ unavailable so the AI plans around it from the
	// start (e.g. asks the user to run a command, or uses other tools).
	if e.config != nil && !e.config.AllowShell {
		filtered := all[:0]
		for _, t := range all {
			if strings.EqualFold(t.Name, "exec_cmd") {
				continue
			}
			filtered = append(filtered, t)
		}
		return filtered
	}
	return all
}

func (e *Executor) lockForTool(name string, args map[string]interface{}, rootDir string) func() {
	if t, ok := e.registry.Get(name); ok && toolIsReadOnly(t) {
		e.toolMu.RLock()
		return e.toolMu.RUnlock
	}
	// browser_batch re-dispatches each of its sub-calls back through Execute,
	// and every sub-call takes its own lock (shared RLock + per-tab mutex). The
	// batch itself must therefore hold NO lock here: holding the keyed tab mutex
	// would self-deadlock on the first item, and even holding toolMu.RLock would
	// risk a deadlock because Go's RWMutex forbids recursively read-locking on
	// one goroutine while a writer may block in between (the item's RLock would
	// queue behind a waiting toolMu.Lock that is itself blocked by the batch's
	// outer RLock). The per-item locks provide all the ordering guarantees.
	if strings.EqualFold(strings.TrimSpace(name), "browser_batch") {
		return func() {}
	}
	// Browser write tools mutate browser state, not the filesystem. They hold
	// the SHARED side of toolMu (so exclusive-lock tools keep their guarantee)
	// and serialize per target tab instead of globally: multi-agent flows can
	// drive different tabs in parallel, while calls on the same tab — or the
	// implicit default tab — stay strictly ordered.
	if isBrowserToolName(name) {
		return e.sharedPlusKeyed(browserTabKey(args))
	}
	// Single-path file writers conflict only on their target file: serialize
	// per normalized path so parallel workers writing DIFFERENT files don't
	// queue behind each other. Path keys are best-effort (Clean + case-fold,
	// no symlink resolution) — an alias slipping through degrades to the same
	// last-write-wins race that serialized execution had anyway.
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "write_file", "edit", "multi_edit":
		return e.sharedPlusKeyed(pathLockKey(rootDir, args))
	case "exec_cmd", "send_stdin":
		// Shell commands and task stdin are independent processes; they run
		// concurrently with each other and with path-scoped writes. A shell
		// touching the same file as a concurrent edit is unguarded — same as
		// every standalone agent runner — and exec_cmd output is consumed by
		// its own caller only.
		e.toolMu.RLock()
		return e.toolMu.RUnlock
	case "spawn_agent":
		// Worker dispatch is the whole point of parallelism: each spawn only
		// touches the (thread-safe) agent registry and opens its own tab, so
		// N spawns in flight must not queue behind each other or behind a
		// long-running tool holding the lock.
		e.toolMu.RLock()
		return e.toolMu.RUnlock
	}
	// Everything else non-read-only (apply_patch multi-file, todo_write,
	// agent/task control, unknown tools) keeps the global exclusive lock.
	e.toolMu.Lock()
	return e.toolMu.Unlock
}

// sharedPlusKeyed takes the shared side of toolMu plus the keyed mutex, so the
// caller excludes only same-key peers and global exclusive-lock holders.
func (e *Executor) sharedPlusKeyed(key string) func() {
	e.toolMu.RLock()
	mu := e.keyedLock(key)
	mu.Lock()
	return func() {
		mu.Unlock()
		e.toolMu.RUnlock()
	}
}

func isBrowserToolName(name string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(name)), "browser_")
}

// browserTabKey extracts the per-tab lock key from a browser tool's args.
// JSON numbers arrive as float64; a missing/invalid tabId means the call will
// resolve to the controller's default tab, so all such calls share one key.
func browserTabKey(args map[string]interface{}) string {
	if args != nil {
		switch n := args["tabId"].(type) {
		case float64:
			if n > 0 {
				return fmt.Sprintf("tab:%d", int(n))
			}
		case int:
			if n > 0 {
				return fmt.Sprintf("tab:%d", n)
			}
		}
	}
	return "tab:default"
}

// pathLockKey normalizes a writer tool's target path into a lock key. A
// missing path (validation will reject the call anyway) falls back to one
// shared key so malformed calls still serialize conservatively.
func pathLockKey(rootDir string, args map[string]interface{}) string {
	p, _ := args["path"].(string)
	p = strings.TrimSpace(p)
	if p == "" {
		return "path:?"
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(rootDir, p)
	}
	return "path:" + strings.ToLower(filepath.Clean(p))
}

func (e *Executor) keyedLock(key string) *sync.Mutex {
	mu, _ := e.keyedLocks.LoadOrStore(key, &sync.Mutex{})
	return mu.(*sync.Mutex)
}

func toolIsReadOnly(t tool.Tool) bool {
	if provider, ok := t.(tool.MetadataProvider); ok {
		return provider.Metadata().ReadOnly
	}
	return isReadOnlyToolName(t.Name())
}

// isReadOnlyToolName is the FALLBACK path for tools that have not yet declared
// Metadata().ReadOnly. As of the metadata migration all listed tools implement
// MetadataProvider; this list now only guards against a future tool being added
// without Metadata(). Prefer adding Metadata() over extending this list.
func isReadOnlyToolName(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "read_file", "list_dir", "glob", "grep", "web_fetch", "skill", "question", "tool_help",
		"todo_read", "task_list", "task_output", "browser_tabs", "browser_snapshot",
		"browser_screenshot", "browser_record", "browser_wait", "browser_wait_for_function", "browser_get_content",
		"browser_get_page_text", "browser_pdf", "browser_console", "browser_network",
		"browser_find", "browser_get_attributes":
		return true
	default:
		return false
	}
}

func summarizeToolLog(req *types.ToolRequest, resp *types.ToolResponse) string {
	const toolPreviewLines = 50
	if resp.Status == "error" {
		if strings.EqualFold(req.Name, "exec_cmd") && strings.TrimSpace(resp.Output) != "" {
			args := req.Args
			if args == nil {
				args = map[string]interface{}{}
			}
			command := argString(args, "command")
			if command == "" {
				command = argString(args, "cmd")
			}
			summary := "Ran " + command
			if msg := strings.TrimSpace(resp.Error); msg != "" {
				summary += " (" + truncateRunes(msg, 80) + ")"
			}
			return summary + outputPreview(resp.Output, toolPreviewLines)
		}
		msg := strings.TrimSpace(resp.Error)
		if msg == "" {
			msg = strings.TrimSpace(resp.Output)
		}
		return fmt.Sprintf("Failed %s: %s", req.Name, truncateRunes(msg, 140))
	}

	args := req.Args
	if args == nil {
		args = map[string]interface{}{}
	}

	switch strings.ToLower(req.Name) {
	case "exec_cmd":
		command := argString(args, "command")
		if command == "" {
			command = argString(args, "cmd")
		}
		return "Ran " + command + outputPreview(resp.Output, toolPreviewLines)
	case "edit":
		path := argString(args, "path")
		oldText := argString(args, "old_string")
		newText := argString(args, "new_string")
		header := fmt.Sprintf("Edited %s (+%d -%d)", path, countLogicalLines(newText), countLogicalLines(oldText))
		return header + editPreview(oldText, newText)
	case "apply_patch":
		return "Applied patch" + outputPreview(resp.Output, toolPreviewLines)
	case "write_file":
		path := argString(args, "path")
		content := argString(args, "content")
		return fmt.Sprintf("Wrote %s (%d lines, %d bytes)", path, countLogicalLines(content), len([]byte(content)))
	case "read_file":
		return "Read " + argString(args, "path") + outputPreview(resp.Output, toolPreviewLines)
	case "list_dir":
		return "Listed " + argString(args, "path") + outputPreview(resp.Output, toolPreviewLines)
	case "grep":
		label := argString(args, "pattern")
		if path := argString(args, "path"); path != "" {
			label += " in " + path
		}
		return "Searched " + label + outputPreview(resp.Output, toolPreviewLines)
	case "glob":
		label := argString(args, "pattern")
		if path := argString(args, "path"); path != "" {
			label += " in " + path
		}
		return "Matched " + label + outputPreview(resp.Output, toolPreviewLines)
	default:
		return strings.TrimSpace(req.Name) + outputPreview(resp.Output, toolPreviewLines)
	}
}

func argString(args map[string]interface{}, key string) string {
	if value, ok := args[key].(string); ok {
		return value
	}
	return ""
}

func outputPreview(output string, maxLines int) string {
	output = strings.TrimSpace(stripCommandEcho(output))
	if output == "" || strings.EqualFold(output, "empty") {
		return ""
	}
	lines := compactLines(output)
	if len(lines) == 0 {
		return ""
	}
	limit := maxLines
	if limit > len(lines) {
		limit = len(lines)
	}
	var b strings.Builder
	for i := 0; i < limit; i++ {
		prefix := " └ "
		if i > 0 {
			prefix = "   "
		}
		b.WriteString("\n")
		b.WriteString(prefix)
		b.WriteString(truncateRunes(lines[i], 120))
	}
	if hidden := len(lines) - limit; hidden > 0 {
		b.WriteString(fmt.Sprintf("\n   … +%d lines (Ctrl+T 查看完整)", hidden))
	}
	return b.String()
}

func fullToolLog(req *types.ToolRequest, resp *types.ToolResponse) string {
	args := req.Args
	if args == nil {
		args = map[string]interface{}{}
	}

	var b strings.Builder
	switch strings.ToLower(req.Name) {
	case "exec_cmd":
		command := argString(args, "command")
		if command == "" {
			command = argString(args, "cmd")
		}
		b.WriteString("Ran ")
		b.WriteString(command)
		appendFullOutput(&b, resp)
	case "edit":
		b.WriteString("Edited ")
		b.WriteString(argString(args, "path"))
		if oldText := argString(args, "old_string"); oldText != "" {
			b.WriteString("\n--- old\n")
			b.WriteString(oldText)
		}
		if newText := argString(args, "new_string"); newText != "" {
			b.WriteString("\n+++ new\n")
			b.WriteString(newText)
		}
		appendFullOutput(&b, resp)
	case "apply_patch":
		b.WriteString("Applied patch")
		appendFullOutput(&b, resp)
	case "write_file":
		b.WriteString("Wrote ")
		b.WriteString(argString(args, "path"))
		if content := argString(args, "content"); content != "" {
			b.WriteString("\n")
			b.WriteString(content)
		}
		appendFullOutput(&b, resp)
	case "read_file":
		b.WriteString("Read ")
		b.WriteString(argString(args, "path"))
		appendFullOutput(&b, resp)
	case "list_dir":
		b.WriteString("Listed ")
		b.WriteString(argString(args, "path"))
		appendFullOutput(&b, resp)
	case "grep":
		b.WriteString("Searched ")
		b.WriteString(argString(args, "pattern"))
		if path := argString(args, "path"); path != "" {
			b.WriteString(" in ")
			b.WriteString(path)
		}
		appendFullOutput(&b, resp)
	case "glob":
		b.WriteString("Matched ")
		b.WriteString(argString(args, "pattern"))
		if path := argString(args, "path"); path != "" {
			b.WriteString(" in ")
			b.WriteString(path)
		}
		appendFullOutput(&b, resp)
	default:
		b.WriteString(strings.TrimSpace(req.Name))
		appendFullOutput(&b, resp)
	}
	return strings.TrimSpace(b.String())
}

func copyToolArgs(args map[string]interface{}, extra int) map[string]interface{} {
	copied := make(map[string]interface{}, len(args)+extra)
	for k, v := range args {
		copied[k] = v
	}
	return copied
}

func appendFullOutput(b *strings.Builder, resp *types.ToolResponse) {
	output := strings.TrimSpace(stripCommandEcho(resp.Output))
	if output != "" && !strings.EqualFold(output, "empty") {
		b.WriteString("\n")
		b.WriteString(output)
	}
	if resp.Error != "" && !strings.Contains(output, resp.Error) {
		b.WriteString("\n")
		b.WriteString(resp.Error)
	}
}

func stripCommandEcho(output string) string {
	if strings.HasPrefix(output, "command: ") {
		if idx := strings.Index(output, "\n\n"); idx >= 0 {
			return output[idx+2:]
		}
	}
	return output
}

func compactLines(output string) []string {
	raw := strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

func editPreview(oldText, newText string) string {
	oldLines := compactLines(oldText)
	newLines := compactLines(newText)

	var b strings.Builder
	for _, line := range firstN(oldLines, 3) {
		b.WriteString("\n   - ")
		b.WriteString(truncateRunes(line, 110))
	}
	for _, line := range firstN(newLines, 3) {
		b.WriteString("\n   + ")
		b.WriteString(truncateRunes(line, 110))
	}
	hidden := hiddenPreviewLines(oldLines, 3) + hiddenPreviewLines(newLines, 3)
	if hidden > 0 {
		b.WriteString(fmt.Sprintf("\n   … +%d lines (Ctrl+T 查看完整)", hidden))
	}
	return b.String()
}

func hiddenPreviewLines(lines []string, shown int) int {
	if len(lines) <= shown {
		return 0
	}
	return len(lines) - shown
}

func firstN(lines []string, n int) []string {
	if len(lines) <= n {
		return lines
	}
	return lines[:n]
}

func countLogicalLines(s string) int {
	if s == "" {
		return 0
	}
	return len(strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n"))
}

func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max <= 1 {
		return string(runes[:max])
	}
	return string(runes[:max-1]) + "…"
}
