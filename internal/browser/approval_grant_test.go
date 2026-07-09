package browser

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// TestApprovalSessionGrantSkipsReprompt verifies that once a user approves with
// session scope for (host, action class), a second matching ask is auto-allowed
// without broadcasting another prompt.
func TestApprovalSessionGrantSkipsReprompt(t *testing.T) {
	var broadcasts int
	m := NewApprovalManager(func(payload []byte) {
		var p struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(payload, &p)
		if p.Type == "browser_approval_ask" {
			broadcasts++
		}
	})

	ask := ApprovalAsk{Host: "example.com", ActionClass: "interact", Action: "clicked 页面元素"}

	// First ask: answer with session scope in a goroutine.
	go func() {
		// Wait until the pending entry exists, then approve-with-session.
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			m.mu.Lock()
			var id string
			for k := range m.pending {
				id = k
			}
			m.mu.Unlock()
			if id != "" {
				m.Deliver(ApprovalAnswer{ApprovalID: id, Approved: true, Scope: "session"})
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	if err := m.askWithPrompt(context.Background(), ask); err != nil {
		t.Fatalf("first ask should be approved: %v", err)
	}
	if broadcasts != 1 {
		t.Fatalf("expected 1 broadcast for first ask, got %d", broadcasts)
	}

	// Second ask, same host+class: must be auto-allowed, NO new broadcast.
	if err := m.askWithPrompt(context.Background(), ask); err != nil {
		t.Fatalf("second ask should be auto-allowed by grant: %v", err)
	}
	if broadcasts != 1 {
		t.Fatalf("grant should have skipped the prompt; broadcasts=%d", broadcasts)
	}

	// A DIFFERENT action class on the same host must still prompt.
	evalAsk := ApprovalAsk{Host: "example.com", ActionClass: "evaluate", Action: "执行页面 JavaScript"}
	go func() {
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			m.mu.Lock()
			var id string
			for k := range m.pending {
				id = k
			}
			m.mu.Unlock()
			if id != "" {
				m.Deliver(ApprovalAnswer{ApprovalID: id, Approved: true})
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	if err := m.askWithPrompt(context.Background(), evalAsk); err != nil {
		t.Fatalf("evaluate ask should prompt and be approved: %v", err)
	}
	if broadcasts != 2 {
		t.Fatalf("evaluate (different class) must prompt; broadcasts=%d", broadcasts)
	}
}

func TestActionClassMapping(t *testing.T) {
	cases := map[string]string{
		"clicked 页面元素":      "interact",
		"输入文本":             "interact",
		"执行页面 JavaScript":  "evaluate",
		"读取剪贴板":           "clipboard",
		"读取 cookie":        "cookie",
		"上传文件":             "upload",
		"处理页面弹窗":          "dialog",
	}
	for action, want := range cases {
		if got := actionClassFor(action); got != want {
			t.Errorf("actionClassFor(%q)=%q want %q", action, got, want)
		}
	}
	_ = json.Marshal
}
