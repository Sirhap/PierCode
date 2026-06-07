package tool

import (
	"context"
	"strings"
	"testing"
)

// countingBrowser is a BrowserController that only counts NewTab calls; the spawn
// tests care whether a standalone tab was opened, not the tab's contents.
type countingBrowser struct {
	BrowserController // embed nil; only NewTab is exercised
	newTabs           int
}

func (b *countingBrowser) NewTab(context.Context, string) (BrowserTab, error) {
	b.newTabs++
	return BrowserTab{TabID: b.newTabs}, nil
}

func spawnCtx(reg *AgentRegistry, br BrowserController, hubOnline bool, addPane func(agentID, parentAgentID, platform, description string)) *Context {
	return &Context{
		Context: context.Background(),
		Args: map[string]interface{}{
			"task":        "do the thing",
			"description": "do thing",
			"platform":    "qwen",
		},
		Browser:         br,
		Agents:          reg,
		SourceClientID:  "dispatcher-1",
		ConversationURL: "https://chat.qwen.ai/c/abc",
		HubOnline:       func() bool { return hubOnline },
		HubAddPane:      addPane,
	}
}

func TestSpawnAgentUsesHubPaneWhenOnline(t *testing.T) {
	reg := NewAgentRegistry()
	br := &countingBrowser{}
	var paneAgent, panePlatform string
	addPane := func(agentID, _ /*parent*/, platform, _ string) {
		paneAgent, panePlatform = agentID, platform
	}
	tool := NewSpawnAgentTool()
	res := tool.Execute(spawnCtx(reg, br, true, addPane))
	if res.Status != "success" {
		t.Fatalf("spawn: %s %s", res.Status, res.Error)
	}
	if br.newTabs != 0 {
		t.Fatalf("Hub online: must not open a standalone tab, opened %d", br.newTabs)
	}
	if paneAgent == "" || panePlatform != "qwen" {
		t.Fatalf("Hub online: expected hub_add_pane(agent, qwen), got agent=%q platform=%q", paneAgent, panePlatform)
	}
	if !strings.Contains(res.Output, "Hub workspace") {
		t.Fatalf("output should mention the Hub workspace, got: %s", res.Output)
	}
	if list := reg.List(""); len(list) != 1 || list[0].AgentID != paneAgent {
		t.Fatalf("agent should be registered with the pane's id, got %+v", list)
	}
}

func TestSpawnAgentFallsBackToTabWhenHubOffline(t *testing.T) {
	reg := NewAgentRegistry()
	br := &countingBrowser{}
	paneCalled := false
	addPane := func(string, string, string, string) { paneCalled = true }
	tool := NewSpawnAgentTool()
	res := tool.Execute(spawnCtx(reg, br, false, addPane))
	if res.Status != "success" {
		t.Fatalf("spawn: %s %s", res.Status, res.Error)
	}
	if br.newTabs != 1 {
		t.Fatalf("Hub offline: expected one standalone tab, opened %d", br.newTabs)
	}
	if paneCalled {
		t.Fatal("Hub offline: must not request a Hub pane")
	}
}

func TestSpawnAgentFallsBackForNonEmbeddablePlatform(t *testing.T) {
	reg := NewAgentRegistry()
	br := &countingBrowser{}
	paneCalled := false
	ctx := spawnCtx(reg, br, true, func(string, string, string, string) { paneCalled = true })
	// aistudio is a valid spawn platform but not in the Hub catalog.
	ctx.Args["platform"] = "aistudio"
	tool := NewSpawnAgentTool()
	res := tool.Execute(ctx)
	if res.Status != "success" {
		t.Fatalf("spawn: %s %s", res.Status, res.Error)
	}
	if paneCalled {
		t.Fatal("non-embeddable platform must not go to a Hub pane")
	}
	if br.newTabs != 1 {
		t.Fatalf("non-embeddable platform should fall back to a tab, opened %d", br.newTabs)
	}
}

// A sub-agent (worker) spawning a sub-sub-agent: the child must inherit the
// parent agent id + project, and connect as a node under its parent.
func TestSpawnAgentSubAgentInheritsParentAndProject(t *testing.T) {
	reg := NewAgentRegistry()
	br := &countingBrowser{}
	// Parent agent: created in a project, with a bound worker WS client.
	parent := reg.CreateInProject("dispatcher-1", "url", "qwen", "", "parent", "ptask", "", "proj-1")
	reg.BindWorker(parent.AgentID, "worker-parent")

	var gotParent, gotChildAgent string
	addPane := func(agentID, parentAgentID, _ /*platform*/, _ string) {
		gotChildAgent, gotParent = agentID, parentAgentID
	}
	// The spawn call now comes FROM the parent worker (its WS client id).
	ctx := spawnCtx(reg, br, true, addPane)
	ctx.SourceClientID = "worker-parent"
	res := NewSpawnAgentTool().Execute(ctx)
	if res.Status != "success" {
		t.Fatalf("spawn: %s %s", res.Status, res.Error)
	}
	if gotParent != parent.AgentID {
		t.Fatalf("child should carry parent agent id %q, got %q", parent.AgentID, gotParent)
	}
	child, ok := reg.Get(gotChildAgent)
	if !ok || child.ParentAgentID != parent.AgentID || child.ProjectID != "proj-1" {
		t.Fatalf("child should inherit parent + project, got %+v", child)
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
		rec := reg.CreateInProject("d", "url", "qwen", "", "x", "t", prevID, "proj-1")
		deepestWorker = "worker-" + rec.AgentID
		reg.BindWorker(rec.AgentID, deepestWorker)
		prevID = rec.AgentID
	}
	ctx := spawnCtx(reg, br, true, func(string, string, string, string) {})
	ctx.SourceClientID = deepestWorker
	res := NewSpawnAgentTool().Execute(ctx)
	if res.Status != "error" {
		t.Fatalf("spawn past depth limit should error, got status %q", res.Status)
	}
	if !strings.Contains(res.Error, "depth limit") {
		t.Fatalf("error should mention depth limit, got %q", res.Error)
	}
}
