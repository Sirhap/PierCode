package tool

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// AgentTabURLParam is the query parameter spawn_agent appends to a worker tab's
// URL so the worker page can announce its agent id when it connects over WS.
// The server reads the matching WS query param to bind the worker.
const AgentTabURLParam = "piercode_agent"

// platformURLs maps a coordinator-facing platform name to the base URL the
// worker tab opens. Keys are matched case-insensitively. An unknown platform is
// an error; an omitted platform defaults to the coordinator's own platform, or
// qwen when that can't be determined (see defaultPlatformFor).
var platformURLs = map[string]string{
	"qwen":      "https://chat.qwen.ai/",
	"chatgpt":   "https://chatgpt.com/",
	"claude":    "https://claude.ai/new",
	"gemini":    "https://gemini.google.com/app",
	"kimi":      "https://www.kimi.com/",
	"z.ai":      "https://chat.z.ai/",
	"zai":       "https://chat.z.ai/",
	"aistudio":  "https://aistudio.google.com/prompts/new_chat",
	"ai studio": "https://aistudio.google.com/prompts/new_chat",
	"mimo":      "https://aistudio.xiaomimimo.com/",
}

// maxSpawnDepth caps how deep the recursive sub-agent tree may grow. A main
// agent (depth 0) spawns children at depth 1, which spawn at depth 2, etc. The
// cap stops an off-script worker AI from fanning out tabs/panes without bound.
const maxSpawnDepth = 3

// resolvePlatformURL returns the worker tab base URL for a platform name, with
// the agent id encoded as a query param so the worker can self-identify.
func resolvePlatformURL(platform, agentID string) (string, error) {
	key := strings.ToLower(strings.TrimSpace(platform))
	base, ok := platformURLs[key]
	if !ok {
		return "", fmt.Errorf("unknown platform %q; known: qwen, chatgpt, claude, gemini, kimi, z.ai, aistudio, mimo", platform)
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set(AgentTabURLParam, agentID)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func NewSpawnAgentTool() Tool {
	return &agentTool{
		name:        "spawn_agent",
		description: "Dispatch a worker agent into a new AI browser tab to run a self-contained task. The worker runs autonomously and reports back via a result packet (delivered to you as a <task-notification>). Returns the agent_id. Do not poll or peek at the worker tab — wait for the callback.",
		parameters: map[string]string{
			"task":        "string (required) - the complete, self-contained task for the worker. It cannot see your conversation; include file paths, context, and what 'done' means.",
			"description": "string (required) - short 3-5 word summary of what the worker will do",
			"platform":    "string (optional) - target AI platform for the worker tab: qwen, chatgpt, claude, gemini, kimi, z.ai, aistudio, mimo. Defaults to your own platform (the page you're running on); qwen if that can't be determined.",
		},
		validate: func(args map[string]interface{}) error {
			if strings.TrimSpace(stringArg(args, "task")) == "" {
				return fmt.Errorf("task is required")
			}
			if strings.TrimSpace(stringArg(args, "description")) == "" {
				return fmt.Errorf("description is required")
			}
			if p := strings.TrimSpace(stringArg(args, "platform")); p != "" {
				if _, ok := platformURLs[strings.ToLower(p)]; !ok {
					return fmt.Errorf("unknown platform %q", p)
				}
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			task := strings.TrimSpace(stringArg(ctx.Args, "task"))
			desc := strings.TrimSpace(stringArg(ctx.Args, "description"))
			platform := strings.TrimSpace(stringArg(ctx.Args, "platform"))
			if platform == "" {
				platform = defaultPlatformFor(ctx.Client.ConversationURL)
			}

			// If the caller is itself a worker (a sub-agent spawning a sub-agent),
			// its source client id maps back to its own agent record — that agent
			// is the parent. A main-agent (ai-page) caller has no such mapping:
			// parentAgentID stays empty for a root agent.
			parentAgentID := ctx.Agents.AgentIDByWorkerClient(ctx.Client.SourceClientID)

			// Warn (don't block) if the coordinator already has a live worker on the
			// same task — it has no cross-turn memory of prior spawns and otherwise
			// fans out duplicates.
			dupWarn := ""
			if ctx.Agents.HasActiveWithDescription(ctx.Client.SourceClientID, desc) {
				dupWarn = fmt.Sprintf("\n⚠️ 你已有一个在跑的 worker 描述同为 %q —— 确认不是重复派发，别开多个。", desc)
			}

			rec := ctx.Agents.CreateInProject(ctx.Client.SourceClientID, ctx.Client.ConversationURL, platform, "", desc, task, parentAgentID)

			workerURL, err := resolvePlatformURL(platform, rec.AgentID)
			if err != nil {
				ctx.Agents.SetStatus(rec.AgentID, AgentFailed)
				return "", err
			}

			// Open the worker tab via the dispatcher's own browser, NOT the Go
			// relay. browser_* tools now run SW-natively in the extension; the
			// legacy Go→WS browser_cmd relay is rejected (SW_DIRECT_BROWSER=true)
			// and, worse, would broadcast to every connected browser (duplicate
			// tabs). So push an open_worker_tab message to the dispatcher's WS
			// client; its content script opens the tab with chrome.tabs.create via
			// EXEC_BROWSER_TOOL. The worker then connects with ?agent=<id> and the
			// server binds + seeds it — that path is unchanged and fires off the
			// worker's own WS connect, so we don't wait for the tab here.
			if ctx.Client.SourceClientID == "" || ctx.Client.BroadcastToClient == nil {
				ctx.Agents.SetStatus(rec.AgentID, AgentFailed)
				return "", fmt.Errorf("spawn_agent needs an active browser AI page; no dispatcher client connected")
			}
			openMsg, err := json.Marshal(map[string]any{
				"type":             "open_worker_tab",
				"url":              workerURL,
				"agent_id":         rec.AgentID,
				"client_id":        ctx.Client.SourceClientID,
				"conversation_url": ctx.Client.ConversationURL,
			})
			if err != nil {
				ctx.Agents.SetStatus(rec.AgentID, AgentFailed)
				return "", err
			}
			if !ctx.Client.BroadcastToClient(ctx.Client.SourceClientID, openMsg) {
				ctx.Agents.SetStatus(rec.AgentID, AgentFailed)
				return "", fmt.Errorf("dispatcher browser is not reachable (tab may be closed)")
			}

			// Schedule an auto-confirmation inject to mitigate SPA hydration races.
			// This sends a lightweight follow-up after ~90 seconds to ensure the seed
			// task was properly submitted (the "send button not clicked" issue).
			scheduleAutoConfirmSpawn(ctx, rec.AgentID, task)

			return fmt.Sprintf(
				"Dispatched worker %s on %s: %s\nThe worker will run autonomously and report back as a <task-notification>. Do not poll or read its tab — end your turn and wait for the callback.%s%s\n\n✅ 已启用自动确认机制（90秒后发送跟进消息确保任务执行）",
				rec.AgentID, platform, desc, dupWarn, activeRosterSuffix(ctx.Agents, ctx.Client.SourceClientID),
			), nil
		},
	}
}

// activeRosterSuffix renders the coordinator's currently-live workers so each
// spawn_agent reply reminds it what it already has out (it has no cross-turn
// memory). Empty when only this just-spawned worker is live.
func activeRosterSuffix(agents *AgentRegistry, dispatcherClientID string) string {
	if agents == nil {
		return ""
	}
	lines, count := agents.ActiveByDispatcher(dispatcherClientID)
	if count <= 1 {
		return ""
	}
	return fmt.Sprintf("\n\n你当前活跃的 worker（%d 个，别重复开）:\n- %s", count, strings.Join(lines, "\n- "))
}

func NewListAgentsTool() Tool {
	return &agentTool{
		name:        "list_agents",
		description: "List dispatched worker agents and their lifecycle status for diagnosing multi-agent dispatch.",
		parameters: map[string]string{
			"dispatcher_client_id": "string (optional) - filter to agents spawned by this dispatcher client id. Omit to list all agents.",
		},
		validate: func(map[string]interface{}) error { return nil },
		execute: func(ctx *Context) (string, error) {
			dispatcherClientID := strings.TrimSpace(stringArg(ctx.Args, "dispatcher_client_id"))
			summaries := ctx.Agents.List(dispatcherClientID)
			if len(summaries) == 0 {
				return "No worker agents found.", nil
			}
			data, err := json.MarshalIndent(summaries, "", "  ")
			if err != nil {
				return "", err
			}
			return string(data), nil
		},
	}
}

func NewSendToAgentTool() Tool {
	return &agentTool{
		name:        "send_to_agent",
		description: "Send a follow-up message to an existing worker agent by its agent_id, continuing its loaded context. Use to give a synthesized spec after research, or to correct a failure. The worker reports back via a result packet.",
		parameters: map[string]string{
			"agent_id": "string (required) - the worker's agent_id from spawn_agent",
			"message":  "string (required) - the follow-up task or correction. Reference what the worker did, not your conversation with the user.",
		},
		validate: func(args map[string]interface{}) error {
			if strings.TrimSpace(stringArg(args, "agent_id")) == "" {
				return fmt.Errorf("agent_id is required")
			}
			if strings.TrimSpace(stringArg(args, "message")) == "" {
				return fmt.Errorf("message is required")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			agentID := strings.TrimSpace(stringArg(ctx.Args, "agent_id"))
			message := strings.TrimSpace(stringArg(ctx.Args, "message"))
			rec, ok := ctx.Agents.Get(agentID)
			if !ok {
				return "", fmt.Errorf("unknown agent_id %q", agentID)
			}
			if rec.WorkerClientID == "" {
				return "", fmt.Errorf("worker %s has not connected yet; wait for it to start before sending follow-ups", agentID)
			}
			if ctx.Client.BroadcastToClient == nil {
				return "", fmt.Errorf("worker messaging is not available in this session")
			}
			// Re-arm a worker that was halted by stop_agent before delivering the
			// follow-up, or its page-side stop flag keeps blocking auto-execution
			// and the "continued" worker silently never runs a tool again.
			if resume, err := json.Marshal(map[string]any{"type": "agent_control", "action": "resume", "agent_id": agentID}); err == nil {
				ctx.Client.BroadcastToClient(rec.WorkerClientID, resume)
			}
			payload, err := json.Marshal(map[string]any{"type": "inject", "text": message})
			if err != nil {
				return "", err
			}
			if !ctx.Client.BroadcastToClient(rec.WorkerClientID, payload) {
				return "", fmt.Errorf("worker %s is not reachable (tab may be closed)", agentID)
			}
			ctx.Agents.SetStatus(agentID, AgentRunning)
			return fmt.Sprintf("Sent follow-up to worker %s. It will report back as a <task-notification>.", agentID), nil
		},
	}
}

func NewStopAgentTool() Tool {
	return &agentTool{
		name:        "stop_agent",
		description: "Halt a running worker agent and block its further auto-execution (e.g. the approach is wrong, or requirements changed). Marks it stopped; you can still continue it later with send_to_agent.",
		parameters: map[string]string{
			"agent_id": "string (required) - the worker's agent_id from spawn_agent",
		},
		validate: func(args map[string]interface{}) error {
			if strings.TrimSpace(stringArg(args, "agent_id")) == "" {
				return fmt.Errorf("agent_id is required")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			agentID := strings.TrimSpace(stringArg(ctx.Args, "agent_id"))
			rec, ok := ctx.Agents.Get(agentID)
			if !ok {
				return "", fmt.Errorf("unknown agent_id %q", agentID)
			}
			ctx.Agents.SetStatus(agentID, AgentStopped)
			// Tell the worker page itself to halt tool auto-execution; without
			// this, "stopped" was registry-only and the worker kept generating
			// and running tools to completion. Best-effort: even unreachable,
			// the registry's terminal status makes any late result a no-op.
			notified := false
			if rec.WorkerClientID != "" && ctx.Client.BroadcastToClient != nil {
				if payload, err := json.Marshal(map[string]any{"type": "agent_control", "action": "stop", "agent_id": agentID}); err == nil {
					notified = ctx.Client.BroadcastToClient(rec.WorkerClientID, payload)
				}
			}
			if notified {
				return fmt.Sprintf("Stopped worker %s; its page was told to halt tool auto-execution. Continue it with send_to_agent if you want to redirect it.", agentID), nil
			}
			return fmt.Sprintf("Marked worker %s stopped (page unreachable to halt; any late result will be ignored). Continue it with send_to_agent if you want to redirect it.", agentID), nil
		},
	}
}

// autoConfirmSpawnDelay is how long after spawn the confirmation nudge fires.
// It must comfortably exceed the worker's whole seed-inject window (waitForEditor
// polls up to 30s, then the send-button poll runs while the SPA enables it).
// The old 4s delay landed mid-seed; even though the content script now also
// serializes injects (so the nudge can no longer clobber the seed text), firing
// during a healthy seed just injects a useless extra message.
const autoConfirmSpawnDelay = 90 * time.Second

// scheduleAutoConfirmSpawn schedules a delayed confirmation inject to ensure
// the worker's seed task was properly submitted. This mitigates SPA hydration
// races where the initial inject may have filled the input but failed to click send.
func scheduleAutoConfirmSpawn(ctx *Context, agentID, task string) {
	if ctx.Client.BroadcastToClient == nil {
		return
	}
	go func() {
		time.Sleep(autoConfirmSpawnDelay)

		rec, ok := ctx.Agents.Get(agentID)
		if !ok || rec.WorkerClientID == "" {
			return // worker not connected yet, skip confirmation
		}
		// Don't re-inject if the worker already started or finished: a terminal
		// status, an observed AI response, or a reported result all mean the seed
		// (server.go:bindAndSeedWorker, guarded by MarkSeeded) took. Re-sending the
		// full task here would make the worker restart or run it twice.
		switch rec.Status {
		case AgentCompleted, AgentFailed, AgentBlocked, AgentStopped:
			return
		}
		if rec.LastAIResponse != "" || rec.LastResult != "" {
			return
		}
		// The worker content script reports its inject progress as debug packets
		// (ws-linker sendInjectDebug → RecordDebug). A reported successful send
		// means the seed went out — the model just hasn't answered yet; nudging
		// now would only queue a second user message on top of a healthy run.
		if strings.Contains(rec.LastDebug, `"stage":"send_reported_success"`) {
			return
		}

		// The worker is bound but silent: nudge it to start WITHOUT re-sending the
		// whole task (it was already seeded). A short prompt avoids duplicate work.
		confirmMsg := "如果你还没开始执行刚才注入的任务，请立即开始；完成后报告结果。"
		payload, err := json.Marshal(map[string]any{"type": "inject", "text": confirmMsg})
		if err != nil {
			return
		}
		ctx.Client.BroadcastToClient(rec.WorkerClientID, payload)
	}()
}

// platformHostHints maps a substring of an AI page host to a platform key in
// platformURLs. Ordered longest/most-specific intent first is unnecessary since
// these hosts don't overlap, but keep entries host-specific to avoid false hits.
var platformHostHints = []struct{ host, platform string }{
	{"chatgpt.com", "chatgpt"},
	{"chat.openai.com", "chatgpt"},
	{"qwen.ai", "qwen"},
	{"qwenlm.ai", "qwen"},
	{"claude.ai", "claude"},
	{"gemini.google.com", "gemini"},
	{"aistudio.google.com", "aistudio"},
	{"kimi.com", "kimi"},
	{"chat.z.ai", "z.ai"},
	{"aistudio.xiaomimimo.com", "mimo"},
}

// defaultPlatformFor picks the worker platform when the coordinator omits one.
// Preference: open the worker on the SAME platform the coordinator is on (a GPT
// coordinator spawns a GPT worker), derived from its conversation URL host. Falls
// back to qwen (the primary compression+worker target) when the host is unknown
// or empty. The coordinator can always override with the platform arg.
func defaultPlatformFor(conversationURL string) string {
	if u, err := url.Parse(strings.TrimSpace(conversationURL)); err == nil {
		host := strings.ToLower(u.Hostname())
		if host != "" {
			for _, h := range platformHostHints {
				if strings.Contains(host, h.host) {
					return h.platform
				}
			}
		}
	}
	return "qwen"
}

// agentTool adapts the closure-based tool shape used by browser tools to the
// agent registry surface. It fails fast when the registry is unavailable.
type agentTool struct {
	name        string
	description string
	parameters  map[string]string
	validate    func(map[string]interface{}) error
	execute     func(*Context) (string, error)
}

func (t *agentTool) Name() string                               { return t.name }
func (t *agentTool) Description() string                        { return t.description }
func (t *agentTool) Parameters() interface{}                    { return t.parameters }
func (t *agentTool) Validate(args map[string]interface{}) error { return t.validate(args) }
func (t *agentTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()
	if ctx.Agents == nil {
		result.Status = "error"
		result.Error = "multi-agent dispatch is not configured"
		return result
	}
	// Sub-agents MAY spawn their own sub-agents (a recursive tree), but the depth
	// is capped so an off-script worker AI cannot fan out tabs without bound. A
	// worker's source client id maps back to its own agent record; that agent is
	// the parent of whatever it spawns, so its depth + 1 is the child's depth.
	if t.name == "spawn_agent" {
		if parentID := ctx.Agents.AgentIDByWorkerClient(ctx.Client.SourceClientID); parentID != "" {
			// The main/coordinator AI page has no registry record, so the first
			// worker it spawns is stored with ParentAgentID="" and reports
			// Depth()==0 even though it conceptually sits one level below the
			// (unrecorded) main agent. Counting that hidden root, the child this
			// worker would spawn is at tree-depth Depth(parentID)+2. Using `>=`
			// here makes the cap fire one level earlier than a naive `>`, so the
			// deepest worker level is exactly maxSpawnDepth and we don't allow an
			// extra fourth level past the limit.
			if ctx.Agents.Depth(parentID)+1 >= maxSpawnDepth {
				result.Status = "error"
				result.Error = fmt.Sprintf("spawn depth limit reached (max %d levels); do this part yourself or report back to your coordinator", maxSpawnDepth)
				return result
			}
		}
	}
	if ctx.Browser == nil && t.name == "spawn_agent" {
		result.Status = "error"
		result.Error = "browser relay is not configured; cannot open a worker tab"
		return result
	}
	out, err := t.execute(ctx)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	result.Status = "success"
	result.Output = out
	return result
}
