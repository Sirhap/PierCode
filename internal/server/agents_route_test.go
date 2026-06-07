package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

func TestHandleListAgentsRequiresAuth(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/agents", nil)
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("GET /agents without token: expected 401, got %d", w.Code)
	}
}

func TestHandleListAgentsReturnsRoster(t *testing.T) {
	s := testServer(t)
	reg := s.executor.Agents()
	rec := reg.Create("dispatcher-1", "https://chat.qwen.ai/c/x", "qwen", "chat.qwen.ai", "fix bug", "the task")

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/agents", nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body struct {
		Agents []tool.AgentSummary `json:"agents"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Agents) != 1 || body.Agents[0].AgentID != rec.AgentID {
		t.Fatalf("expected the created agent in the roster, got %+v", body.Agents)
	}
	if body.Agents[0].Status != "pending" {
		t.Fatalf("new agent should be pending, got %q", body.Agents[0].Status)
	}
}

func TestHandleListAgentsEmptyIsArray(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/agents", nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	// Empty roster must serialize as [] not null so the dashboard can map over it.
	if got := w.Body.String(); got != `{"agents":[]}` {
		t.Fatalf("empty roster body = %s, want {\"agents\":[]}", got)
	}
}

func TestHandleAgentControlStop(t *testing.T) {
	s := testServer(t)
	reg := s.executor.Agents()
	rec := reg.Create("dispatcher-1", "url", "qwen", "chat.qwen.ai", "desc", "task")
	reg.BindWorker(rec.AgentID, "worker-1")

	s.handleAgentControl("stop", rec.AgentID)

	// Stop comes from closing the worker pane in the Hub: after stopping, the
	// record is deleted so the registry doesn't keep a dead agent around.
	if _, ok := reg.Get(rec.AgentID); ok {
		t.Fatal("stop should delete the agent record (pane closed)")
	}
}

func TestHandleAgentControlUnknownIsNoop(t *testing.T) {
	s := testServer(t)
	// Unknown agent / action must not panic.
	s.handleAgentControl("stop", "no-such-agent")
	s.handleAgentControl("bogus", "no-such-agent")
}

func TestHandleAgentControlRetryUnboundWorkerNoop(t *testing.T) {
	s := testServer(t)
	reg := s.executor.Agents()
	rec := reg.Create("dispatcher-1", "url", "qwen", "chat.qwen.ai", "desc", "task")
	// Worker never bound (no WorkerClientID). Retry must be a safe no-op that
	// leaves the agent pending — not flipped to running.
	s.handleAgentControl("retry", rec.AgentID)
	got, _ := reg.Get(rec.AgentID)
	if got.Status != tool.AgentPending {
		t.Fatalf("retry on unbound worker should leave status pending, got %s", got.Status)
	}
}

func TestHandleAgentControlRetryDeadWorkerDoesNotFlipRunning(t *testing.T) {
	s := testServer(t)
	reg := s.executor.Agents()
	rec := reg.Create("dispatcher-1", "url", "qwen", "chat.qwen.ai", "desc", "task")
	// Bind a worker whose WS client id is not connected, then mark it failed.
	reg.BindWorker(rec.AgentID, "worker-gone")
	reg.RecordResult(rec.AgentID, "failed", "boom")
	// SendToID returns false (no such client), so retry must NOT flip the agent
	// back to running — otherwise the dashboard would show a live agent whose
	// worker is gone (the race the review flagged).
	s.handleAgentControl("retry", rec.AgentID)
	got, _ := reg.Get(rec.AgentID)
	if got.Status == tool.AgentRunning {
		t.Fatalf("retry with a dead worker must not flip to running, got %s", got.Status)
	}
}
