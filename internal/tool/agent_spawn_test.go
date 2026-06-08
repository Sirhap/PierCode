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

func spawnCtx(reg *AgentRegistry, br BrowserController) *Context {
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
	ctx := spawnCtx(reg, br)
	ctx.SourceClientID = "worker-parent"
	res := NewSpawnAgentTool().Execute(ctx)
	if res.Status != "success" {
		t.Fatalf("spawn: %s %s", res.Status, res.Error)
	}
	// The standalone tab must have been opened (no Hub).
	if br.newTabs != 1 {
		t.Fatalf("expected one standalone tab, opened %d", br.newTabs)
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
	ctx := spawnCtx(reg, br)
	ctx.SourceClientID = deepestWorker
	res := NewSpawnAgentTool().Execute(ctx)
	if res.Status != "error" {
		t.Fatalf("spawn past depth limit should error, got status %q", res.Status)
	}
	if !strings.Contains(res.Error, "depth limit") {
		t.Fatalf("error should mention depth limit, got %q", res.Error)
	}
}
