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
