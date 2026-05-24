package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

var ErrNoRelay = errors.New("browser relay is not connected; open PierCode extension popup or reload extension")

type RelayManager struct {
	send clientSender

	mu      sync.Mutex
	pending map[string]chan Result
	seq     atomic.Uint64
}

func NewRelayManager(send clientSender) *RelayManager {
	return &RelayManager{
		send:    send,
		pending: make(map[string]chan Result),
	}
}

func (m *RelayManager) SendCommand(ctx context.Context, cmd Command, timeout time.Duration) (json.RawMessage, error) {
	if m == nil || m.send == nil {
		return nil, ErrNoRelay
	}
	if timeout <= 0 {
		timeout = defaultReadTimeout
	}
	if cmd.ID == "" {
		cmd.ID = fmt.Sprintf("browser_%d_%d", time.Now().UnixNano(), m.seq.Add(1))
	}
	cmd.Type = "browser_cmd"
	if cmd.TimeoutMS <= 0 {
		cmd.TimeoutMS = int(timeout / time.Millisecond)
	}
	if len(cmd.Params) == 0 {
		cmd.Params = json.RawMessage(`{}`)
	}

	ch := make(chan Result, 1)
	m.mu.Lock()
	m.pending[cmd.ID] = ch
	m.mu.Unlock()
	defer m.deletePending(cmd.ID)

	payload, err := json.Marshal(cmd)
	if err != nil {
		return nil, err
	}
	if ok := m.send(payload); !ok {
		return nil, ErrNoRelay
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case res := <-ch:
		if !res.Success {
			if res.Error == "" {
				res.Error = "browser command failed"
			}
			return nil, errors.New(res.Error)
		}
		return res.Data, nil
	case <-timer.C:
		return nil, fmt.Errorf("browser command timed out after %s", timeout)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (m *RelayManager) DeliverResult(res Result) bool {
	if m == nil || res.ID == "" {
		return false
	}
	m.mu.Lock()
	ch, ok := m.pending[res.ID]
	m.mu.Unlock()
	if !ok {
		log.Printf("[PierCode][Browser] ignoring result for unknown command id %q", res.ID)
		return false
	}
	select {
	case ch <- res:
	default:
	}
	return true
}

func (m *RelayManager) deletePending(id string) {
	m.mu.Lock()
	delete(m.pending, id)
	m.mu.Unlock()
}
