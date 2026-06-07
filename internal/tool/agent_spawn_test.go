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

func spawnCtx(reg *AgentRegistry, br BrowserController, hubOnline bool, addPane func(string, string, string)) *Context {
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
	addPane := func(agentID, platform, _ string) {
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
	addPane := func(string, string, string) { paneCalled = true }
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
	ctx := spawnCtx(reg, br, true, func(string, string, string) { paneCalled = true })
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
