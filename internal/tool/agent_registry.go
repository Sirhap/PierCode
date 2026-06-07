package tool

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// AgentStatus is the lifecycle state of a dispatched worker agent.
type AgentStatus string

const (
	AgentPending   AgentStatus = "pending"   // tab created, worker not yet bound
	AgentRunning   AgentStatus = "running"   // worker bound, task in flight
	AgentCompleted AgentStatus = "completed" // worker reported a result packet
	AgentFailed    AgentStatus = "failed"
	AgentBlocked   AgentStatus = "blocked"
	AgentStopped   AgentStatus = "stopped"
)

// AgentRecord tracks one worker dispatched into its own AI tab. The dispatcher
// is the coordinator AI page that spawned it; the worker is the new AI page that
// runs the task. Both are WebSocket clients identified by their client id.
type AgentRecord struct {
	AgentID                   string
	DispatcherClientID        string // coordinator page that spawned this worker
	DispatcherConversationURL string
	WorkerClientID            string // worker page; empty until bound
	Platform                  string // target AI platform (e.g. "qwen", "chatgpt")
	Host                      string // worker tab host, used for late binding
	Description               string
	Task                      string
	Status                    AgentStatus
	CreatedAt                 time.Time
	BoundAt                   time.Time
	EndedAt                   time.Time
	LastResult                string // last result packet text from the worker
	LastDebug                 string // last worker inject debug packet
	LastDebugAt               time.Time
	LastAIResponse            string // latest AI response text observed in the worker tab
	LastAIResponseAt          time.Time
	seeded                    bool // task already injected once; guards reconnect re-seed
}

// AgentSummary is a JSON-friendly snapshot for tool output and /agents routes.
type AgentSummary struct {
	AgentID                   string `json:"agent_id"`
	DispatcherClientID        string `json:"dispatcher_client_id,omitempty"`
	DispatcherConversationURL string `json:"dispatcher_conversation_url,omitempty"`
	WorkerClientID            string `json:"worker_client_id,omitempty"`
	Platform                  string `json:"platform,omitempty"`
	Description               string `json:"description,omitempty"`
	Status                    string `json:"status"`
	CreatedAt                 string `json:"created_at"`
	BoundAt                   string `json:"bound_at,omitempty"`
	EndedAt                   string `json:"ended_at,omitempty"`
	Seeded                    bool   `json:"seeded"`
	LastDebug                 string `json:"last_debug,omitempty"`
	LastDebugAt               string `json:"last_debug_at,omitempty"`
	LastAIResponse            string `json:"last_ai_response,omitempty"`
	LastAIResponseAt          string `json:"last_ai_response_at,omitempty"`
}

func (r *AgentRecord) summary() AgentSummary {
	s := AgentSummary{
		AgentID:                   r.AgentID,
		DispatcherClientID:        r.DispatcherClientID,
		DispatcherConversationURL: r.DispatcherConversationURL,
		WorkerClientID:            r.WorkerClientID,
		Platform:                  r.Platform,
		Description:               r.Description,
		Status:                    string(r.Status),
		CreatedAt:                 r.CreatedAt.Format(time.RFC3339),
		Seeded:                    r.seeded,
	}
	if !r.BoundAt.IsZero() {
		s.BoundAt = r.BoundAt.Format(time.RFC3339)
	}
	if !r.EndedAt.IsZero() {
		s.EndedAt = r.EndedAt.Format(time.RFC3339)
	}
	if r.LastDebug != "" {
		s.LastDebug = r.LastDebug
	}
	if !r.LastDebugAt.IsZero() {
		s.LastDebugAt = r.LastDebugAt.Format(time.RFC3339)
	}
	if r.LastAIResponse != "" {
		s.LastAIResponse = r.LastAIResponse
	}
	if !r.LastAIResponseAt.IsZero() {
		s.LastAIResponseAt = r.LastAIResponseAt.Format(time.RFC3339)
	}
	return s
}

// AgentRegistry is the thread-safe store of dispatched workers. It is owned by
// the executor and consulted by the server's WS layer to route result packets
// back to the dispatcher.
type AgentRegistry struct {
	mu     sync.Mutex
	agents map[string]*AgentRecord
	seq    uint64
}

func NewAgentRegistry() *AgentRegistry {
	return &AgentRegistry{agents: make(map[string]*AgentRecord)}
}

// Create registers a new pending agent and returns its record. The agent id is
// generated here so spawn_agent can seed it into the worker's task prompt.
func (r *AgentRegistry) Create(dispatcherClientID, dispatcherConversationURL, platform, host, description, task string) *AgentRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	rec := &AgentRecord{
		AgentID:                   fmt.Sprintf("agent-%d-%d", time.Now().UnixNano(), r.seq),
		DispatcherClientID:        dispatcherClientID,
		DispatcherConversationURL: dispatcherConversationURL,
		Platform:                  platform,
		Host:                      host,
		Description:               description,
		Task:                      task,
		Status:                    AgentPending,
		CreatedAt:                 time.Now(),
	}
	r.agents[rec.AgentID] = rec
	return rec
}

// BindWorker associates a worker page's WebSocket client id with an agent and
// moves it to running. Returns false if the agent is unknown.
func (r *AgentRegistry) BindWorker(agentID, workerClientID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.agents[agentID]
	if !ok {
		return false
	}
	rec.WorkerClientID = workerClientID
	rec.BoundAt = time.Now()
	if rec.Status == AgentPending {
		rec.Status = AgentRunning
	}
	return true
}

// MarkSeeded records that an agent's task has been injected and returns true
// only for the first caller. The worker page reconnects whenever the MV3
// service worker sleeps, re-triggering bind; this guard stops the task from
// being re-injected (and re-run) on every reconnect.
func (r *AgentRegistry) MarkSeeded(agentID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.agents[agentID]
	if !ok || rec.seeded {
		return false
	}
	rec.seeded = true
	return true
}

// RecordDebug stores the latest worker-side inject debug event for diagnosis.
func (r *AgentRegistry) RecordDebug(agentID, debug string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.agents[agentID]
	if !ok {
		return false
	}
	rec.LastDebug = debug
	rec.LastDebugAt = time.Now()
	return true
}

// RecordAIResponseByWorkerClient stores the latest visible AI response observed
// in a bound worker tab. It lets list_agents diagnose whether the worker model
// answered without relying on reading/polling the worker browser tab.
func (r *AgentRegistry) RecordAIResponseByWorkerClient(workerClientID, text string) (string, bool) {
	workerClientID = strings.TrimSpace(workerClientID)
	text = strings.TrimSpace(text)
	if workerClientID == "" || text == "" {
		return "", false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, rec := range r.agents {
		if rec.WorkerClientID == workerClientID {
			rec.LastAIResponse = text
			rec.LastAIResponseAt = time.Now()
			return rec.AgentID, true
		}
	}
	return "", false
}

// IsWorkerClient reports whether a WebSocket client id belongs to a bound
// worker page. spawn_agent uses it to refuse recursive dispatch — workers must
// not spawn workers (which the worker prompt also forbids; this is the hard
// backstop).
func (r *AgentRegistry) IsWorkerClient(clientID string) bool {
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, rec := range r.agents {
		if rec.WorkerClientID == clientID {
			return true
		}
	}
	return false
}

// Get returns a copy of the record for an agent id.
func (r *AgentRegistry) Get(agentID string) (AgentRecord, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.agents[agentID]
	if !ok {
		return AgentRecord{}, false
	}
	return *rec, true
}

// RecordResult stores the worker's result packet and final status. The status
// string comes from the packet ("completed"/"failed"/"blocked").
func (r *AgentRegistry) RecordResult(agentID, status, result string) (AgentRecord, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.agents[agentID]
	if !ok {
		return AgentRecord{}, false
	}
	rec.LastResult = result
	rec.EndedAt = time.Now()
	switch status {
	case "failed":
		rec.Status = AgentFailed
	case "blocked":
		rec.Status = AgentBlocked
	default:
		rec.Status = AgentCompleted
	}
	return *rec, true
}

// SetStatus updates an agent's lifecycle state.
func (r *AgentRegistry) SetStatus(agentID string, status AgentStatus) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.agents[agentID]
	if !ok {
		return false
	}
	rec.Status = status
	if status == AgentStopped && rec.EndedAt.IsZero() {
		rec.EndedAt = time.Now()
	}
	return true
}

// List returns summaries of all agents dispatched by one dispatcher. An empty
// dispatcherClientID returns every agent.
func (r *AgentRegistry) List(dispatcherClientID string) []AgentSummary {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]AgentSummary, 0, len(r.agents))
	for _, rec := range r.agents {
		if dispatcherClientID != "" && rec.DispatcherClientID != dispatcherClientID {
			continue
		}
		out = append(out, rec.summary())
	}
	return out
}
