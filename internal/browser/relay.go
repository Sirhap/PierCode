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
	transport RelayTransport

	mu      sync.Mutex
	pending map[string]chan Result
	seq     atomic.Uint64
}

func NewRelayManager(transport RelayTransport) *RelayManager {
	return &RelayManager{
		transport: transport,
		pending:   make(map[string]chan Result),
	}
}

// NewRelayManagerFromSend builds a relay over a single broadcast send func
// (no per-tab routing, one fan-out lane). For single-channel callers and tests.
func NewRelayManagerFromSend(send func([]byte) bool) *RelayManager {
	return NewRelayManager(broadcastTransport{send: send})
}

func (m *RelayManager) nextID() string {
	return fmt.Sprintf("browser_%d_%d", time.Now().UnixNano(), m.seq.Add(1))
}

// prepare fills defaults and marshals a command for sending.
func (m *RelayManager) prepare(cmd *Command, timeout time.Duration) ([]byte, error) {
	if cmd.ID == "" {
		cmd.ID = m.nextID()
	}
	cmd.Type = "browser_cmd"
	if cmd.TimeoutMS <= 0 {
		cmd.TimeoutMS = int(timeout / time.Millisecond)
	}
	if len(cmd.Params) == 0 {
		cmd.Params = json.RawMessage(`{}`)
	}
	return json.Marshal(cmd)
}

func (m *RelayManager) SendCommand(ctx context.Context, cmd Command, timeout time.Duration) (json.RawMessage, error) {
	if m == nil || m.transport == nil {
		return nil, ErrNoRelay
	}
	if timeout <= 0 {
		timeout = defaultReadTimeout
	}

	// Owner-unknown tab command broadcast to multiple browsers: only ONE of them
	// actually hosts the tab; the others answer "No tab with id" (failure). A
	// plain first-result-wins would let a non-owner's failure win the race. So
	// when the send wasn't owner-targeted and a tabId is set, prefer the first
	// SUCCESS and ignore failures until one arrives (or we time out). The channel
	// is buffered to the relay count so failures from non-owners don't get
	// dropped before the owner's success is consumed.
	relayCount := len(m.transport.BrowserRelayIDs())
	bufSize := relayCount
	if bufSize < 1 {
		bufSize = 1
	}
	ch := make(chan Result, bufSize)
	payload, err := m.prepare(&cmd, timeout)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.pending[cmd.ID] = ch
	m.mu.Unlock()
	defer m.deletePending(cmd.ID)

	// Route by tabId: a tab-targeted command reaches only its owning browser
	// (when known), so a second connected browser no longer races to answer
	// "No tab with id" for a tab it doesn't host.
	sent, targeted := m.transport.SendBrowserCommand(cmd.TabID, payload)
	if !sent {
		return nil, ErrNoRelay
	}

	preferSuccess := !targeted && cmd.TabID != nil && relayCount > 1

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	var lastFail Result
	haveFail := false
	failCount := 0
	for {
		select {
		case res := <-ch:
			if res.Success {
				return res.Data, nil
			}
			if !preferSuccess {
				if res.Error == "" {
					res.Error = "browser command failed"
				}
				return nil, errors.New(res.Error)
			}
			// Hold the failure; keep waiting for a success from the owner.
			// pending[id] stays mapped (deletePending runs only on return), and
			// the buffered channel keeps the owner's later success deliverable.
			lastFail, haveFail = res, true
			failCount++
			// Once every broadcast recipient has answered with a failure, no
			// owner success is coming — return now instead of waiting out the
			// full timeout (a genuinely-closed tab otherwise blocked ~10s/60s).
			if failCount >= relayCount {
				if lastFail.Error == "" {
					lastFail.Error = "browser command failed"
				}
				return nil, errors.New(lastFail.Error)
			}
		case <-timer.C:
			if haveFail {
				if lastFail.Error == "" {
					lastFail.Error = "browser command failed"
				}
				return nil, errors.New(lastFail.Error)
			}
			return nil, fmt.Errorf("browser command timed out after %s", timeout)
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// SendCommandFanout sends the SAME command to every connected browser-relay
// client (one distinct command id per client) and returns all successful
// results. Used to aggregate listTabs across multiple browsers — each browser
// only knows its own chrome.tabs, so a single broadcast (first-result-wins)
// would surface just one browser's tabs. Per-client failures are skipped; an
// empty slice with nil error means every browser answered empty.
func (m *RelayManager) SendCommandFanout(ctx context.Context, cmd Command, timeout time.Duration) ([]Result, error) {
	if m == nil || m.transport == nil {
		return nil, ErrNoRelay
	}
	if timeout <= 0 {
		timeout = defaultReadTimeout
	}
	ids := m.transport.BrowserRelayIDs()
	if len(ids) == 0 {
		return nil, ErrNoRelay
	}

	type pendingOne struct {
		ch    chan Result
		cmdID string
	}
	waiters := make([]pendingOne, 0, len(ids))
	anySent := false
	for _, clientID := range ids {
		one := cmd // copy; each gets its own id
		one.ID = m.nextID()
		payload, err := m.prepare(&one, timeout)
		if err != nil {
			continue
		}
		ch := make(chan Result, 1)
		m.mu.Lock()
		m.pending[one.ID] = ch
		m.mu.Unlock()
		if m.transport.SendToID(clientID, payload) {
			anySent = true
			waiters = append(waiters, pendingOne{ch: ch, cmdID: one.ID})
		} else {
			m.deletePending(one.ID)
		}
	}
	if !anySent {
		return nil, ErrNoRelay
	}

	// One absolute deadline for the whole fan-in: a single time.Timer fires only
	// once, so reusing it across N waiters would bound only the FIRST straggler and
	// let later unresponsive browsers block until ctx (minutes). Arm a fresh timer
	// per iteration from the remaining budget instead, so the total wait across all
	// waiters stays capped at timeout no matter how many browsers go silent.
	deadline := time.Now().Add(timeout)
	results := make([]Result, 0, len(waiters))
	cancelled := false
	for _, w := range waiters {
		rem := time.Until(deadline)
		if rem <= 0 {
			// Budget already spent on earlier stragglers; don't wait on this one.
			m.deletePending(w.cmdID)
			continue
		}
		timer := time.NewTimer(rem)
		select {
		case res := <-w.ch:
			if res.Success {
				results = append(results, res)
			}
		case <-timer.C:
			// Stop waiting on the slow ones; return what we have.
			m.deletePending(w.cmdID)
		case <-ctx.Done():
			// Caller gave up. Keep draining to clean up the remaining pending
			// entries, but remember to surface the cancellation so the caller
			// doesn't mistake a truncated result set for "these are all the tabs".
			m.deletePending(w.cmdID)
			cancelled = true
		}
		timer.Stop()
		m.deletePending(w.cmdID)
	}
	if cancelled {
		return results, ctx.Err()
	}
	return results, nil
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
