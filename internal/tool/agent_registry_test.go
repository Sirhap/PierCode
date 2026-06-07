package tool

import (
	"fmt"
	"sync"
	"testing"
)

func TestAgentRegistryCreateBindAndResult(t *testing.T) {
	r := NewAgentRegistry()
	dispatcherURL := "https://chat.qwen.ai/c/abc"
	rec := r.Create("dispatcher-1", dispatcherURL, "qwen", "chat.qwen.ai", "fix bug", "the task")
	if rec.AgentID == "" {
		t.Fatal("Create should generate an agent id")
	}
	if rec.Status != AgentPending {
		t.Fatalf("new agent should be pending, got %s", rec.Status)
	}
	if rec.DispatcherConversationURL != dispatcherURL {
		t.Fatalf("dispatcher conversation url = %q, want %q", rec.DispatcherConversationURL, dispatcherURL)
	}
	summaries := r.List("dispatcher-1")
	if len(summaries) != 1 || summaries[0].DispatcherConversationURL != dispatcherURL {
		t.Fatalf("summary should preserve dispatcher conversation url, got %+v", summaries)
	}

	if !r.BindWorker(rec.AgentID, "worker-9") {
		t.Fatal("BindWorker should succeed for a known agent")
	}
	got, ok := r.Get(rec.AgentID)
	if !ok || got.WorkerClientID != "worker-9" || got.Status != AgentRunning {
		t.Fatalf("after bind expected worker-9/running, got %+v", got)
	}

	final, ok := r.RecordResult(rec.AgentID, "completed", "done text")
	if !ok || final.Status != AgentCompleted || final.LastResult != "done text" {
		t.Fatalf("RecordResult should mark completed, got %+v", final)
	}
	if final.EndedAt.IsZero() {
		t.Fatal("RecordResult should set EndedAt")
	}
}

func TestAgentRegistryResultStatusMapping(t *testing.T) {
	cases := map[string]AgentStatus{
		"completed": AgentCompleted,
		"failed":    AgentFailed,
		"blocked":   AgentBlocked,
		"weird":     AgentCompleted, // unknown defaults to completed
	}
	for packetStatus, want := range cases {
		r := NewAgentRegistry()
		rec := r.Create("d", "", "qwen", "", "x", "y")
		got, ok := r.RecordResult(rec.AgentID, packetStatus, "r")
		if !ok || got.Status != want {
			t.Errorf("status %q -> %s, want %s", packetStatus, got.Status, want)
		}
	}
}

func TestAgentRegistryUnknownAgent(t *testing.T) {
	r := NewAgentRegistry()
	if r.BindWorker("nope", "w") {
		t.Error("BindWorker should fail for unknown agent")
	}
	if _, ok := r.Get("nope"); ok {
		t.Error("Get should fail for unknown agent")
	}
	if _, ok := r.RecordResult("nope", "completed", ""); ok {
		t.Error("RecordResult should fail for unknown agent")
	}
	if r.SetStatus("nope", AgentStopped) {
		t.Error("SetStatus should fail for unknown agent")
	}
}

func TestAgentRegistryListByDispatcher(t *testing.T) {
	r := NewAgentRegistry()
	r.Create("d1", "", "qwen", "", "a", "t")
	r.Create("d1", "", "chatgpt", "", "b", "t")
	r.Create("d2", "", "qwen", "", "c", "t")

	if got := len(r.List("d1")); got != 2 {
		t.Errorf("d1 should have 2 agents, got %d", got)
	}
	if got := len(r.List("d2")); got != 1 {
		t.Errorf("d2 should have 1 agent, got %d", got)
	}
	if got := len(r.List("")); got != 3 {
		t.Errorf("empty filter should return all 3, got %d", got)
	}
}

func TestAgentRegistryParentChainDepth(t *testing.T) {
	r := NewAgentRegistry()
	root := r.CreateInProject("d", "", "qwen", "", "root", "t", "", "proj-1")
	child := r.CreateInProject("d", "", "qwen", "", "child", "t", root.AgentID, "proj-1")
	grand := r.CreateInProject("d", "", "qwen", "", "grand", "t", child.AgentID, "proj-1")

	if d := r.Depth(root.AgentID); d != 0 {
		t.Errorf("root depth = %d, want 0", d)
	}
	if d := r.Depth(child.AgentID); d != 1 {
		t.Errorf("child depth = %d, want 1", d)
	}
	if d := r.Depth(grand.AgentID); d != 2 {
		t.Errorf("grandchild depth = %d, want 2", d)
	}
	if d := r.Depth("missing"); d != 0 {
		t.Errorf("unknown agent depth = %d, want 0", d)
	}
}

func TestAgentRegistryAgentIDByWorkerClient(t *testing.T) {
	r := NewAgentRegistry()
	rec := r.Create("d", "", "qwen", "", "x", "t")
	r.BindWorker(rec.AgentID, "worker-7")
	if got := r.AgentIDByWorkerClient("worker-7"); got != rec.AgentID {
		t.Errorf("AgentIDByWorkerClient = %q, want %q", got, rec.AgentID)
	}
	if got := r.AgentIDByWorkerClient("nope"); got != "" {
		t.Errorf("unknown worker client should map to empty, got %q", got)
	}
}

func TestAgentRegistryListByProject(t *testing.T) {
	r := NewAgentRegistry()
	r.CreateInProject("d", "", "qwen", "", "a", "t", "", "proj-1")
	r.CreateInProject("d", "", "qwen", "", "b", "t", "", "proj-1")
	r.CreateInProject("d", "", "qwen", "", "c", "t", "", "proj-2")

	if got := len(r.ListByProject("proj-1")); got != 2 {
		t.Errorf("proj-1 should have 2 agents, got %d", got)
	}
	if got := len(r.ListByProject("proj-2")); got != 1 {
		t.Errorf("proj-2 should have 1 agent, got %d", got)
	}
	if got := len(r.ListByProject("")); got != 3 {
		t.Errorf("empty project filter should return all 3, got %d", got)
	}
}

func TestAgentSummaryExposesParentAndProject(t *testing.T) {
	r := NewAgentRegistry()
	root := r.CreateInProject("d", "", "qwen", "", "root", "t", "", "proj-1")
	child := r.CreateInProject("d", "", "qwen", "", "child", "t", root.AgentID, "proj-1")
	for _, s := range r.List("") {
		if s.AgentID == child.AgentID {
			if s.ParentAgentID != root.AgentID || s.ProjectID != "proj-1" {
				t.Fatalf("child summary missing parent/project: %+v", s)
			}
			return
		}
	}
	t.Fatal("child summary not found")
}

func TestListAgentsTool(t *testing.T) {
	r := NewAgentRegistry()
	rec := r.Create("dispatcher-1", "https://chat.qwen.ai/", "qwen", "", "debug", "task")
	r.BindWorker(rec.AgentID, "worker-1")
	r.MarkSeeded(rec.AgentID)
	r.RecordDebug(rec.AgentID, `{"stage":"filled","agent_id":"`+rec.AgentID+`"}`)
	r.RecordAIResponseByWorkerClient("worker-1", "worker visible answer")

	list := NewListAgentsTool()
	res := list.Execute(&Context{Args: map[string]interface{}{}, Agents: r})
	if res.Status != "success" {
		t.Fatalf("list_agents failed: %s", res.Error)
	}
	if !strContains(res.Output, rec.AgentID) || !strContains(res.Output, "worker-1") || !strContains(res.Output, "running") || !strContains(res.Output, "filled") || !strContains(res.Output, "worker visible answer") {
		t.Fatalf("list_agents output missing agent details: %s", res.Output)
	}
}

func TestAgentRegistryConcurrentCreate(t *testing.T) {
	r := NewAgentRegistry()
	var wg sync.WaitGroup
	ids := make(chan string, 100)
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			rec := r.Create(fmt.Sprintf("d%d", n), "", "qwen", "", "x", "y")
			ids <- rec.AgentID
		}(i)
	}
	wg.Wait()
	close(ids)
	seen := map[string]bool{}
	for id := range ids {
		if seen[id] {
			t.Fatalf("duplicate agent id under concurrency: %s", id)
		}
		seen[id] = true
	}
	if len(seen) != 100 {
		t.Fatalf("expected 100 unique ids, got %d", len(seen))
	}
}

func TestAgentRegistryMarkSeededOnce(t *testing.T) {
	r := NewAgentRegistry()
	rec := r.Create("d", "", "qwen", "", "x", "y")
	if !r.MarkSeeded(rec.AgentID) {
		t.Fatal("first MarkSeeded should win")
	}
	if r.MarkSeeded(rec.AgentID) {
		t.Fatal("second MarkSeeded must not re-seed (reconnect guard)")
	}
	if r.MarkSeeded("unknown") {
		t.Fatal("MarkSeeded on unknown agent should be false")
	}
}

func TestAgentRegistryIsWorkerClient(t *testing.T) {
	r := NewAgentRegistry()
	rec := r.Create("dispatcher-1", "", "qwen", "", "x", "y")
	if r.IsWorkerClient("dispatcher-1") {
		t.Error("dispatcher should not be flagged as a worker")
	}
	if r.IsWorkerClient("worker-7") {
		t.Error("unbound id should not be flagged as a worker")
	}
	r.BindWorker(rec.AgentID, "worker-7")
	if !r.IsWorkerClient("worker-7") {
		t.Error("bound worker client should be flagged")
	}
	if r.IsWorkerClient("") {
		t.Error("empty id should never be a worker")
	}
}

// A shallow worker (depth 0) is now ALLOWED to spawn a sub-agent — recursion is
// permitted up to maxSpawnDepth. The worker caller must get past the depth guard
// (the only remaining refusal here is the unrelated browser-not-configured one,
// since this ctx has no Browser). The depth refusal is covered separately in
// TestSpawnAgentDepthLimit.
func TestSpawnAgentAllowsShallowWorkerCaller(t *testing.T) {
	r := NewAgentRegistry()
	rec := r.Create("d", "", "qwen", "", "x", "y")
	r.BindWorker(rec.AgentID, "worker-c")

	spawn := NewSpawnAgentTool()
	ctx := &Context{
		Args:           map[string]interface{}{"task": "t", "description": "d"},
		Agents:         r,
		SourceClientID: "worker-c",
	}
	res := spawn.Execute(ctx)
	if strContains(res.Error, "depth limit") {
		t.Fatalf("a depth-0 worker must not hit the depth limit, got %q", res.Error)
	}
	// Without a Browser and Hub bridge, the spawn falls through to the tab path
	// and fails on the browser guard — proving it passed the worker/depth checks.
	if res.Status != "error" || !strContains(res.Error, "browser relay") {
		t.Fatalf("expected the browser-not-configured error after passing the depth gate, got status=%s err=%q", res.Status, res.Error)
	}
}

func TestResolvePlatformURL(t *testing.T) {
	url, err := resolvePlatformURL("qwen", "agent-123")
	if err != nil {
		t.Fatal(err)
	}
	if want := AgentTabURLParam + "=agent-123"; !strContains(url, want) {
		t.Fatalf("url %q should encode %q", url, want)
	}
	if !strContains(url, "qwen") {
		t.Fatalf("url %q should target qwen", url)
	}

	if _, err := resolvePlatformURL("nonsense", "a"); err == nil {
		t.Error("unknown platform should error")
	}
}

func strContains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
