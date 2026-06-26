package server

import (
	"net/http"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

// #7: the WS upgrader's CheckOrigin must actually consult the configured
// allowlist, not be a hardcoded `return true`. Token remains the primary auth,
// but a disallowed cross-site Origin must be rejected at the upgrade so the
// allowedOrigins config is not silently dead.
func TestWSCheckOriginUsesAllowlist(t *testing.T) {
	m := NewWSManager([]string{"https://staging.app"})
	check := m.upgrader.CheckOrigin

	req := func(origin string) *http.Request {
		r, _ := http.NewRequest("GET", "http://127.0.0.1:39527/ws", nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		return r
	}

	if !check(req("")) {
		t.Fatal("empty origin (same-origin / native client) must be allowed")
	}
	if !check(req("chrome-extension://abc")) {
		t.Fatal("extension origin must be allowed")
	}
	if !check(req("http://localhost:5173")) {
		t.Fatal("loopback origin must be allowed")
	}
	if !check(req("https://staging.app")) {
		t.Fatal("whitelisted origin must be allowed")
	}
	if check(req("https://evil.com")) {
		t.Fatal("non-whitelisted cross-site origin must be REJECTED (allowlist was dead before)")
	}
}

// #3: a second client must not be able to claim an id already held by a live
// connection. If it could, SendToID would fan a directed message (worker seed,
// inject, tool stream) to BOTH connections — the eavesdrop. RegisterWithMeta
// must hand the colliding client a fresh server-assigned id instead.
func TestRegisterRejectsDuplicateClientID(t *testing.T) {
	m := NewWSManager(nil)
	defer m.Close()

	// First client claims "victim".
	victim := &clientConn{id: "victim", send: make(chan []byte, 1)}
	m.clientsMu.Lock()
	m.clients[victim] = true
	m.clientsMu.Unlock()

	// Second client tries to register with the SAME id (no real conn needed for
	// the id-assignment path; registerMeta is the unit under test).
	assigned := m.assignClientID("victim")
	if assigned == "victim" {
		t.Fatal("duplicate client id must NOT be granted; a fresh id should be assigned")
	}
	if assigned == "" {
		t.Fatal("a fresh id must be non-empty")
	}

	// A unique id supplied by a client is honored as-is.
	if got := m.assignClientID("unique-123"); got != "unique-123" {
		t.Fatalf("unique client id should be honored, got %q", got)
	}

	// An empty id always gets a generated one.
	if got := m.assignClientID(""); got == "" {
		t.Fatal("empty id must be replaced by a generated id")
	}
}

// #1 (question): an answer must only be accepted from the client that owns the
// pending question (the one whose /exec call registered it). A different page
// sharing the token must not be able to answer on the user's behalf.
func TestQuestionDeliverChecksOwner(t *testing.T) {
	reg := tool.PendingQuestions
	ch, cancel := reg.RegisterOwned("call-1", "owner-client")
	defer cancel()

	// Wrong owner is rejected and does not deliver.
	if reg.DeliverFrom("call-1", "attacker answer", "other-client") {
		t.Fatal("answer from a non-owner client must be rejected")
	}
	select {
	case <-ch:
		t.Fatal("non-owner answer must not reach the waiting question")
	default:
	}

	// Correct owner delivers.
	if !reg.DeliverFrom("call-1", "real answer", "owner-client") {
		t.Fatal("answer from the owner client must be accepted")
	}
	select {
	case got := <-ch:
		if got != "real answer" {
			t.Fatalf("expected owner answer, got %q", got)
		}
	default:
		t.Fatal("owner answer should have been delivered")
	}
}

// #2: BindWorker must not let a second client hijack an agent already bound to a
// live worker. The first worker to bind wins; a later (attacker) bind for the
// same agent is refused, so the attacker cannot receive the worker seed (task,
// system prompt, sandbox info).
func TestBindWorkerRejectsTakeover(t *testing.T) {
	r := tool.NewAgentRegistry()
	rec := r.CreateInProject("dispatcher", "http://disp", "qwen", "", "desc", "task", "")

	if !r.BindWorker(rec.AgentID, "worker-1") {
		t.Fatal("first bind should succeed")
	}
	// Same client re-binding (reconnect after SW sleep) is allowed.
	if !r.BindWorker(rec.AgentID, "worker-1") {
		t.Fatal("re-bind by the same worker client (reconnect) must be allowed")
	}
	// A DIFFERENT client must not take over the already-bound agent.
	if r.BindWorker(rec.AgentID, "attacker") {
		t.Fatal("a different client must NOT take over an already-bound agent")
	}
	got, _ := r.Get(rec.AgentID)
	if got.WorkerClientID != "worker-1" {
		t.Fatalf("worker binding must remain worker-1, got %q", got.WorkerClientID)
	}
}
