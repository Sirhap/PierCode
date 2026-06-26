package tool

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// countingBrowser is a BrowserController that only counts NewTab calls. spawn no
// longer opens tabs through the Go relay (it pushes open_worker_tab to the
// dispatcher's browser), so NewTab must NOT be called — these tests assert it
// stays at zero.
type countingBrowser struct {
	noopBrowserController // safe defaults; only NewTab is exercised
	newTabs               int
}

func (b *countingBrowser) NewTab(context.Context, string) (BrowserTab, error) {
	b.newTabs++
	return BrowserTab{TabID: b.newTabs}, nil
}

// recordingDispatcher captures the open_worker_tab payloads spawn_agent pushes
// to the dispatcher's WS client.
type recordingDispatcher struct {
	msgs    [][]byte
	targets []string
	deliver bool // what BroadcastToClient returns
}

func (d *recordingDispatcher) broadcastToClient(clientID string, payload []byte) bool {
	d.targets = append(d.targets, clientID)
	d.msgs = append(d.msgs, payload)
	if !d.deliver {
		return false
	}
	return true
}

func spawnCtx(reg *AgentRegistry, br BrowserController) (*Context, *recordingDispatcher) {
	d := &recordingDispatcher{deliver: true}
	return &Context{
		Context: context.Background(),
		Args: map[string]interface{}{
			"task":        "do the thing",
			"description": "do thing",
			"platform":    "qwen",
		},
		Browser: br,
		Agents:  reg,
		Client: ClientIO{
			SourceClientID:    "dispatcher-1",
			ConversationURL:   "https://chat.qwen.ai/c/abc",
			BroadcastToClient: d.broadcastToClient,
		},
	}, d
}

// decodeOpenWorkerTab parses the most recent open_worker_tab payload.
func decodeOpenWorkerTab(t *testing.T, d *recordingDispatcher) map[string]any {
	t.Helper()
	if len(d.msgs) == 0 {
		t.Fatal("no open_worker_tab message was pushed to the dispatcher")
	}
	var m map[string]any
	if err := json.Unmarshal(d.msgs[len(d.msgs)-1], &m); err != nil {
		t.Fatalf("open_worker_tab payload is not valid JSON: %v", err)
	}
	return m
}

// spawn_agent must push an open_worker_tab message to the dispatcher's browser
// (which opens the tab SW-natively) instead of opening it through the Go relay.
func TestSpawnAgentPushesOpenWorkerTab(t *testing.T) {
	reg := NewAgentRegistry()
	br := &countingBrowser{}
	ctx, d := spawnCtx(reg, br)

	res := NewSpawnAgentTool().Execute(ctx)
	if res.Status != "success" {
		t.Fatalf("spawn: %s %s", res.Status, res.Error)
	}
	if br.newTabs != 0 {
		t.Fatalf("spawn must NOT open a tab via the Go relay, opened %d", br.newTabs)
	}
	if len(d.targets) != 1 || d.targets[0] != "dispatcher-1" {
		t.Fatalf("expected one push to dispatcher-1, got %v", d.targets)
	}
	msg := decodeOpenWorkerTab(t, d)
	if msg["type"] != "open_worker_tab" {
		t.Fatalf("expected type open_worker_tab, got %v", msg["type"])
	}
	url, _ := msg["url"].(string)
	if !strings.Contains(url, "piercode_agent=") {
		t.Fatalf("worker url must carry the piercode_agent param, got %q", url)
	}
	// The agent_id in the payload must match the just-created record and appear
	// in the worker URL.
	all := reg.List("")
	if len(all) != 1 {
		t.Fatalf("expected one agent record, got %d", len(all))
	}
	if msg["agent_id"] != all[0].AgentID {
		t.Fatalf("payload agent_id %v != record %q", msg["agent_id"], all[0].AgentID)
	}
	if !strings.Contains(url, all[0].AgentID) {
		t.Fatalf("worker url %q must contain agent id %q", url, all[0].AgentID)
	}
	// Reply no longer prints a tab number.
	if strings.Contains(res.Output, "(tab ") {
		t.Fatalf("reply should not mention a tab number, got %q", res.Output)
	}
}

// With no dispatcher browser (SourceClientID empty), spawn_agent must fail
// clearly and mark the agent failed — workers are browser tabs.
func TestSpawnAgentRequiresDispatcherBrowser(t *testing.T) {
	reg := NewAgentRegistry()
	ctx, _ := spawnCtx(reg, &countingBrowser{})
	ctx.Client.SourceClientID = ""

	res := NewSpawnAgentTool().Execute(ctx)
	if res.Status != "error" {
		t.Fatalf("expected error with no dispatcher browser, got %q", res.Status)
	}
	if !strings.Contains(res.Error, "browser") {
		t.Fatalf("error should explain a browser AI page is required, got %q", res.Error)
	}
	// The created record (if any) must be marked failed, not left running.
	for _, s := range reg.List("") {
		if s.Status != string(AgentFailed) {
			t.Fatalf("agent should be failed, got %q", s.Status)
		}
	}
}

// When the dispatcher's browser is unreachable (BroadcastToClient returns
// false), spawn_agent fails and marks the agent failed.
func TestSpawnAgentDispatcherUnreachable(t *testing.T) {
	reg := NewAgentRegistry()
	ctx, d := spawnCtx(reg, &countingBrowser{})
	d.deliver = false // BroadcastToClient reports the client is gone

	res := NewSpawnAgentTool().Execute(ctx)
	if res.Status != "error" {
		t.Fatalf("expected error when dispatcher unreachable, got %q", res.Status)
	}
	if !strings.Contains(res.Error, "not reachable") {
		t.Fatalf("error should mention unreachable dispatcher, got %q", res.Error)
	}
	for _, s := range reg.List("") {
		if s.Status != string(AgentFailed) {
			t.Fatalf("agent should be failed, got %q", s.Status)
		}
	}
}

// A sub-agent (worker) spawning a sub-sub-agent: the child must inherit the
// parent agent id, and connect as a node under its parent.
func TestSpawnAgentSubAgentInheritsParent(t *testing.T) {
	reg := NewAgentRegistry()
	br := &countingBrowser{}
	// Parent agent: created with a bound worker WS client.
	parent := reg.CreateInProject("dispatcher-1", "url", "qwen", "", "parent", "ptask", "")
	reg.BindWorker(parent.AgentID, "worker-parent")

	// The spawn call now comes FROM the parent worker (its WS client id).
	ctx, _ := spawnCtx(reg, br)
	ctx.Client.SourceClientID = "worker-parent"
	res := NewSpawnAgentTool().Execute(ctx)
	if res.Status != "success" {
		t.Fatalf("spawn: %s %s", res.Status, res.Error)
	}
	// No Go-relay tab is opened.
	if br.newTabs != 0 {
		t.Fatalf("expected no Go-relay tab, opened %d", br.newTabs)
	}

	// Find the child record in the registry (there are now 2: parent + child).
	all := reg.List("")
	var child AgentSummary
	for _, s := range all {
		if s.AgentID != parent.AgentID {
			child = s
		}
	}
	if child.AgentID == "" {
		t.Fatal("child agent not found in registry")
	}
	if child.ParentAgentID != parent.AgentID {
		t.Fatalf("child should carry parent agent id %q, got %q", parent.AgentID, child.ParentAgentID)
	}
}

// Recursive spawn is allowed but depth-capped: a chain at the limit refuses.
func TestSpawnAgentDepthLimit(t *testing.T) {
	reg := NewAgentRegistry()
	br := &countingBrowser{}
	// Build a parent chain reaching depth maxSpawnDepth (depths 0..maxSpawnDepth),
	// each bound to a worker client. The deepest agent sits AT the limit, so its
	// spawn would be depth maxSpawnDepth+1 > limit → refused.
	prevID := ""
	var deepestWorker string
	for d := 0; d <= maxSpawnDepth; d++ {
		rec := reg.CreateInProject("d", "url", "qwen", "", "x", "t", prevID)
		deepestWorker = "worker-" + rec.AgentID
		reg.BindWorker(rec.AgentID, deepestWorker)
		prevID = rec.AgentID
	}
	ctx, _ := spawnCtx(reg, br)
	ctx.Client.SourceClientID = deepestWorker
	res := NewSpawnAgentTool().Execute(ctx)
	if res.Status != "error" {
		t.Fatalf("spawn past depth limit should error, got status %q", res.Status)
	}
	if !strings.Contains(res.Error, "depth limit") {
		t.Fatalf("error should mention depth limit, got %q", res.Error)
	}
}
