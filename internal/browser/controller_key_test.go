package browser

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestTypedKeysInterKeyDelay(t *testing.T) {
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	c := NewController(relay, func([]byte) {})
	c.SetInputFidelity(InputFidelity{TypeCharDelayMS: 18})
	var delays int
	c.sleep = func(ctx context.Context, d time.Duration) error {
		if d == 18*time.Millisecond {
			delays++
		}
		return nil
	}
	if err := c.dispatchTypedKeys(context.Background(), 1, "ab"); err != nil {
		t.Fatalf("type err: %v", err)
	}
	if delays != 2 {
		t.Fatalf("expected 2 inter-key delays for 'ab', got %d", delays)
	}
}

func TestSendKeyChordModsBitmask(t *testing.T) {
	var commands []Command
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		commands = append(commands, cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	c := NewController(relay, func([]byte) {})
	if err := c.sendKeyChordMods(context.Background(), 1, []string{"Meta", "Shift"}, "p"); err != nil {
		t.Fatalf("chord err: %v", err)
	}
	var mask float64
	for _, cmd := range commands {
		var p map[string]interface{}
		_ = json.Unmarshal(cmd.Params, &p)
		if p["type"] == "keyDown" && p["key"] == "p" {
			mask = p["modifiers"].(float64)
		}
	}
	if mask != 12 {
		t.Fatalf("expected modifiers mask 12 (Meta|Shift), got %v", mask)
	}
}

func TestSendKeyChordSingleStillWorks(t *testing.T) {
	var commands []Command
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		commands = append(commands, cmd)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		return true
	})
	c := NewController(relay, func([]byte) {})
	if err := c.sendKeyChord(context.Background(), 1, "Meta", "a"); err != nil {
		t.Fatalf("chord err: %v", err)
	}
	var mask float64
	for _, cmd := range commands {
		var p map[string]interface{}
		_ = json.Unmarshal(cmd.Params, &p)
		if p["type"] == "keyDown" && p["key"] == "a" {
			mask = p["modifiers"].(float64)
		}
	}
	if mask != 4 {
		t.Fatalf("expected Meta mask 4, got %v", mask)
	}
}
