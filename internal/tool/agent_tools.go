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
// an error; an omitted platform defaults to qwen (see defaultPlatformFor).
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
			"platform":    "string (optional) - target AI platform for the worker tab: qwen, chatgpt, claude, gemini, kimi, z.ai, aistudio, mimo. Defaults to qwen if omitted.",
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
				platform = defaultPlatformFor(ctx.SourceClientID)
			}

			rec := ctx.Agents.Create(ctx.SourceClientID, ctx.ConversationURL, platform, "", desc, task)
			workerURL, err := resolvePlatformURL(platform, rec.AgentID)
			if err != nil {
				ctx.Agents.SetStatus(rec.AgentID, AgentFailed)
				return "", err
			}

			tab, err := ctx.Browser.NewTab(ctx.Context, workerURL)
			if err != nil {
				ctx.Agents.SetStatus(rec.AgentID, AgentFailed)
				return "", fmt.Errorf("open worker tab: %w", err)
			}

			return fmt.Sprintf(
				"Dispatched worker %s on %s (tab %d): %s\nThe worker will run autonomously and report back as a <task-notification>. Do not poll or read its tab — end your turn and wait for the callback.",
				rec.AgentID, platform, tab.TabID, desc,
			), nil
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
			if ctx.BroadcastToClient == nil {
				return "", fmt.Errorf("worker messaging is not available in this session")
			}
			payload, err := json.Marshal(map[string]any{"type": "inject", "text": message})
			if err != nil {
				return "", err
			}
			if !ctx.BroadcastToClient(rec.WorkerClientID, payload) {
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
		description: "Stop a worker agent you sent in the wrong direction (e.g. the approach is wrong, or requirements changed). Marks it stopped; you can still continue it later with send_to_agent.",
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
			if _, ok := ctx.Agents.Get(agentID); !ok {
				return "", fmt.Errorf("unknown agent_id %q", agentID)
			}
			ctx.Agents.SetStatus(agentID, AgentStopped)
			return fmt.Sprintf("Stopped worker %s. Continue it with send_to_agent if you want to redirect it.", agentID), nil
		},
	}
}

// defaultPlatformFor picks a fallback platform when the coordinator does not
// specify one. Without per-client platform tracking we default to qwen (the
// primary compression+worker target); the coordinator can always override.
func defaultPlatformFor(_ string) string {
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
	// Hard backstop: workers must not spawn workers. The worker prompt also
	// forbids this, but enforcing it on the dispatch path stops an off-script
	// worker AI from fanning out tabs recursively. Checked before the browser
	// guard so the refusal is deterministic regardless of relay state.
	if t.name == "spawn_agent" && ctx.Agents.IsWorkerClient(ctx.SourceClientID) {
		result.Status = "error"
		result.Error = "workers cannot spawn other workers; do the task yourself or report back to your coordinator"
		return result
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
