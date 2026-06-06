package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/types"
	"github.com/sirhap/piercode/prompts"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	rootDir := t.TempDir()
	cfg := &types.Config{
		RootDir:        rootDir,
		InitialRootDir: rootDir,
		Port:           8080,
		Timeout:        10,
		Token:          "testtoken",
		// Tests exercise exec_cmd via /exec; production default is to keep
		// the shell gated off behind --allow-shell.
		AllowShell: true,
		// Provide a non-empty default prompt so /prompt-related tests don't
		// fail on the new "embedded prompt only" handler. Real binary supplies
		// this via go:embed; tests don't import the prompts package to keep
		// fixtures small.
		DefaultPrompt: []byte("system:\n{{SYSTEM_INFO}}\n\ntools:\n{{TOOLS}}"),
	}
	s := New(cfg)
	t.Cleanup(s.Close)
	return s
}

func TestHandleHealth(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/health", nil)
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestAuthMiddleware(t *testing.T) {
	s := testServer(t)

	t.Run("missing token returns 401", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/config", nil)
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})

	t.Run("valid token returns 200", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/config", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
	})

	t.Run("wrong token returns 401", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/config", nil)
		req.Header.Set("Authorization", "Bearer wrongtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})
}

func TestHandleExec(t *testing.T) {
	s := testServer(t)

	t.Run("exec_cmd succeeds", func(t *testing.T) {
		body, _ := json.Marshal(types.ToolRequest{
			Name:   "exec_cmd",
			CallID: "call123",
			Args:   map[string]interface{}{"command": "echo hi"},
		})
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/exec", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		var resp types.ToolResponse
		json.NewDecoder(w.Body).Decode(&resp)
		if resp.Status != "success" {
			t.Errorf("expected success, got %s: %s", resp.Status, resp.Error)
		}
		if resp.Name != "exec_cmd" {
			t.Errorf("expected response name exec_cmd, got %q", resp.Name)
		}
		if resp.CallID != "call123" {
			t.Errorf("expected response call_id call123, got %q", resp.CallID)
		}
	})

	t.Run("exec accepts camelCase callId", func(t *testing.T) {
		body := []byte(`{"name":"list_dir","callId":"camel123","args":{"path":"."}}`)
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/exec", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		var resp types.ToolResponse
		json.NewDecoder(w.Body).Decode(&resp)
		if resp.Status != "success" {
			t.Errorf("expected success, got %s: %s", resp.Status, resp.Error)
		}
		if resp.Name != "list_dir" {
			t.Errorf("expected response name list_dir, got %q", resp.Name)
		}
		if resp.CallID != "camel123" {
			t.Errorf("expected response call_id camel123, got %q", resp.CallID)
		}
	})

	t.Run("invalid json returns 400", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/exec", bytes.NewReader([]byte("bad json")))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", w.Code)
		}
	})

	t.Run("edit preserves literal tab indentation", func(t *testing.T) {
		path := filepath.Join(s.config.GetRootDir(), "tabbed.go")
		if err := os.WriteFile(path, []byte("\tfunc foo() {}\n"), 0644); err != nil {
			t.Fatal(err)
		}

		body, _ := json.Marshal(types.ToolRequest{
			Name:   "edit",
			CallID: "tabedit1",
			Args: map[string]interface{}{
				"path":       "tabbed.go",
				"old_string": "\tfunc foo() {}",
				"new_string": "\tfunc bar() {}",
			},
		})
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/exec", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		var resp types.ToolResponse
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatal(err)
		}
		if resp.Status != "success" {
			t.Fatalf("expected success, got %s: %s", resp.Status, resp.Error)
		}
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != "\tfunc bar() {}\n" {
			t.Fatalf("literal tab edit was corrupted: %q", string(got))
		}
	})
}

func TestHandleAuth(t *testing.T) {
	s := testServer(t)

	t.Run("valid token returns valid=true", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"token": "testtoken"})
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/auth", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		var resp map[string]interface{}
		json.NewDecoder(w.Body).Decode(&resp)
		if resp["valid"] != true {
			t.Errorf("expected valid=true, got %v", resp["valid"])
		}
	})

	t.Run("wrong token returns valid=false", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"token": "wrong"})
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/auth", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		s.router.ServeHTTP(w, req)
		var resp map[string]interface{}
		json.NewDecoder(w.Body).Decode(&resp)
		if resp["valid"] != false {
			t.Errorf("expected valid=false, got %v", resp["valid"])
		}
		if resp["reason"] != "token_mismatch" {
			t.Errorf("expected reason token_mismatch, got %v", resp["reason"])
		}
		if _, ok := resp["actual_length"]; ok {
			t.Errorf("actual_length should not be returned")
		}
		if _, ok := resp["expected_length"]; ok {
			t.Errorf("expected_length should not be returned")
		}
	})

	t.Run("GET /auth no longer accepts token query", func(t *testing.T) {
		// Removed in security hardening: GET ?token=... let long-lived tokens
		// land in browser history / proxy logs. Use POST instead.
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/auth?token=%20testtoken%0A", nil)
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404 for removed GET handler, got %d", w.Code)
		}
	})

	t.Run("invalid json returns 400", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/auth", bytes.NewReader([]byte("bad")))
		req.Header.Set("Content-Type", "application/json")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", w.Code)
		}
	})
}

func TestHandleSetCWD(t *testing.T) {
	s := testServer(t)
	subdir := filepath.Join(s.config.GetRootDir(), "extension", "dist")
	if err := os.MkdirAll(subdir, 0755); err != nil {
		t.Fatal(err)
	}

	body, _ := json.Marshal(map[string]string{"path": filepath.Join("extension", "dist")})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/cwd", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	expectedSubdir, err := filepath.EvalSymlinks(subdir)
	if err != nil {
		t.Fatal(err)
	}
	if resp["rootDir"] != expectedSubdir {
		t.Fatalf("expected rootDir %q, got %v", expectedSubdir, resp["rootDir"])
	}

	w = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/config", nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected config 200, got %d", w.Code)
	}
	resp = map[string]interface{}{}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["rootDir"] != expectedSubdir {
		t.Fatalf("expected config rootDir %q, got %v", expectedSubdir, resp["rootDir"])
	}
}

func TestHandleSetCWDAllowsAdditionalAllowedDir(t *testing.T) {
	s := testServer(t)
	extra := t.TempDir()
	s.config.AdditionalAllowedDirs = []string{extra}

	body, _ := json.Marshal(map[string]string{"path": extra})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/cwd", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	expected, err := filepath.EvalSymlinks(extra)
	if err != nil {
		t.Fatal(err)
	}
	if resp["rootDir"] != expected {
		t.Fatalf("expected rootDir %q, got %v", expected, resp["rootDir"])
	}
}

func TestHandleSetCWDPermissionModes(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "project")
	sibling := filepath.Join(parent, "sibling")
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sibling, 0755); err != nil {
		t.Fatal(err)
	}
	s := testServer(t)
	s.config.RootDir = root
	s.config.InitialRootDir = root

	body, _ := json.Marshal(map[string]string{"path": sibling})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/cwd", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("default mode should block sibling cwd, got %d: %s", w.Code, w.Body.String())
	}

	s.config.PermissionMode = "auto"
	w = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/cwd", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("auto mode should allow sibling cwd, got %d: %s", w.Code, w.Body.String())
	}

	outside := t.TempDir()
	body, _ = json.Marshal(map[string]string{"path": outside})
	w = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/cwd", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("auto mode should block unrelated cwd, got %d: %s", w.Code, w.Body.String())
	}

	s.config.PermissionMode = "unrestricted"
	w = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/cwd", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("unrestricted mode should allow unrelated cwd, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHandleSetCWDRejectsSymlinkEscape(t *testing.T) {
	s := testServer(t)
	outside := t.TempDir()
	link := filepath.Join(s.config.GetRootDir(), "outside-link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("cannot create symlink on this system: %v", err)
	}

	body, _ := json.Marshal(map[string]string{"path": "outside-link"})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/cwd", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for symlink escape, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHandleListTools(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/tools", nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["tools"] == nil {
		t.Error("expected tools in response")
	}
}

func TestHandleInjectReportsConnectedClients(t *testing.T) {
	s := testServer(t)
	body, _ := json.Marshal(map[string]string{"text": "hello from tui"})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/inject", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["clients"] != float64(0) {
		t.Errorf("expected clients=0, got %v", resp["clients"])
	}
}

func TestSummarizeBrowserAITextFoldsAfterFiftyLines(t *testing.T) {
	lines := make([]string, 0, 52)
	for i := 1; i <= 52; i++ {
		lines = append(lines, fmt.Sprintf("line-%02d", i))
	}
	summary := summarizeBrowserAIText(strings.Join(lines, "\n"))
	if !strings.Contains(summary, "line-50") {
		t.Fatalf("expected line 50 in summary, got %q", summary)
	}
	if strings.Contains(summary, "line-51") {
		t.Fatalf("expected line 51 to be folded, got %q", summary)
	}
	if !strings.Contains(summary, "… +2 lines") {
		t.Fatalf("expected folded line count, got %q", summary)
	}
}

func TestSummarizeBrowserAITextFoldsToolCalls(t *testing.T) {
	text := "我先看文件\n```piercode-tool\n{\"name\":\"read_file\",\"call_id\":\"abc123\",\"args\":{\"path\":\"internal/tui/transcript.go\"}}\n```\n继续分析"

	summary := summarizeBrowserAIText(text)
	if !strings.Contains(summary, "调用工具 read_file #abc123") {
		t.Fatalf("expected compact tool-call summary, got %q", summary)
	}
	if strings.Contains(summary, "internal/tui/transcript.go") || strings.Contains(summary, "piercode-tool") {
		t.Fatalf("expected raw tool call to be hidden, got %q", summary)
	}
	if !strings.Contains(summary, "Ctrl+T 查看完整") {
		t.Fatalf("expected full-view hint, got %q", summary)
	}
}

func TestSummarizeBrowserAITextFoldsXMLToolCalls(t *testing.T) {
	text := `<tool name="grep" call_id="xml9">
  <parameter name="pattern">secret</parameter>
</tool>`

	summary := summarizeBrowserAIText(text)
	if !strings.Contains(summary, "调用工具 grep #xml9") {
		t.Fatalf("expected compact XML tool-call summary, got %q", summary)
	}
	if strings.Contains(summary, "<parameter") {
		t.Fatalf("expected XML body to be hidden, got %q", summary)
	}
}

func TestHandlePrompt(t *testing.T) {
	t.Run("missing default prompt returns 404", func(t *testing.T) {
		// Build a server with no DefaultPrompt to verify the no-fallback path.
		rootDir := t.TempDir()
		cfg := &types.Config{
			RootDir:        rootDir,
			InitialRootDir: rootDir,
			Port:           8080,
			Timeout:        10,
			Token:          "testtoken",
		}
		s := New(cfg)
		t.Cleanup(s.Close)
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/prompt", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d", w.Code)
		}
	})

	t.Run("embedded default prompt is ignored when sandbox-internal copy exists", func(t *testing.T) {
		// SECURITY: even if a prompts/init_prompt.txt exists inside the
		// workspace (which AI can write to), the server must NOT load it —
		// only the embedded DefaultPrompt is trusted. This test guards that.
		s := testServer(t)
		promptDir := filepath.Join(s.config.RootDir, "prompts")
		os.MkdirAll(promptDir, 0755)
		os.WriteFile(filepath.Join(promptDir, "init_prompt.txt"), []byte("INJECTED FROM SANDBOX"), 0644)
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/prompt", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		body := w.Body.Bytes()
		if bytes.Contains(body, []byte("INJECTED FROM SANDBOX")) {
			t.Errorf("server loaded prompt from sandbox path; AI could hijack itself: %s", body)
		}
	})

	t.Run("default prompt renders placeholders", func(t *testing.T) {
		s := testServer(t)
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/prompt", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		body := w.Body.Bytes()
		if bytes.Contains(body, []byte("{{SYSTEM_INFO}}")) || bytes.Contains(body, []byte("{{TOOLS}}")) {
			t.Errorf("expected placeholders to be rendered, got %s", string(body))
		}
		if !bytes.Contains(body, []byte("exec_cmd")) {
			t.Errorf("expected tool docs in prompt")
		}
		if !bytes.Contains(body, []byte(s.config.RootDir)) {
			t.Errorf("expected system info in prompt")
		}
		if bytes.Contains(body, []byte("Qwen Host Tool Bridge Override")) {
			t.Errorf("default prompt should not include Qwen-only guidance")
		}
	})

	t.Run("qwen adapter inherits default prompt and appends qwen guidance", func(t *testing.T) {
		s := testServer(t)
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/prompt?adapter=qwen", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		body := w.Body.Bytes()
		if bytes.Contains(body, []byte("{{SYSTEM_INFO}}")) || bytes.Contains(body, []byte("{{TOOLS}}")) {
			t.Errorf("expected placeholders to be rendered, got %s", string(body))
		}
		if !bytes.Contains(body, []byte("exec_cmd")) {
			t.Errorf("expected default profile to include tool docs")
		}
		if !bytes.Contains(body, []byte("Qwen Host Tool Bridge Override")) {
			t.Errorf("expected qwen profile to include qwen guidance")
		}
		if !bytes.Contains(body, []byte("does not exist")) {
			t.Errorf("expected qwen profile to address host-native missing-tool errors")
		}
		if !bytes.Contains(body, []byte("ordinary visible final-answer Markdown")) ||
			!bytes.Contains(body, []byte("not a Qwen tool, function, plugin, MCP server")) {
			t.Errorf("expected qwen profile to force visible markdown instead of host-native calls")
		}
		if !bytes.Contains(body, []byte("PierCode Context Packet Handoff")) ||
			!bytes.Contains(body, []byte("`piercode-context`")) ||
			!bytes.Contains(body, []byte("next_action")) {
			t.Errorf("expected qwen profile to include context packet handoff protocol")
		}
	})

	t.Run("default prompt fallback renders placeholders", func(t *testing.T) {
		cfg := &types.Config{
			RootDir:       t.TempDir(),
			Port:          8080,
			Timeout:       10,
			Token:         "testtoken",
			DefaultPrompt: []byte("{{SYSTEM_INFO}}\n{{TOOLS}}"),
		}
		fallbackServer := New(cfg)
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/prompt", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		fallbackServer.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		body := w.Body.Bytes()
		if bytes.Contains(body, []byte("{{SYSTEM_INFO}}")) || bytes.Contains(body, []byte("{{TOOLS}}")) {
			t.Errorf("expected fallback placeholders to be rendered, got %s", string(body))
		}
		if !bytes.Contains(body, []byte("exec_cmd")) {
			t.Errorf("expected fallback prompt to include tool docs")
		}
	})

	t.Run("embedded piercode prompt keeps core invariants", func(t *testing.T) {
		rootDir := t.TempDir()
		cfg := &types.Config{
			RootDir:        rootDir,
			InitialRootDir: rootDir,
			Port:           8080,
			Timeout:        10,
			Token:          "testtoken",
			AllowShell:     true,
			DefaultPrompt:  prompts.DefaultPrompt,
		}
		s := New(cfg)
		t.Cleanup(s.Close)

		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/prompt", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}

		body := w.Body.String()
		for _, forbidden := range []string{"{{SYSTEM_INFO}}", "{{TOOLS}}"} {
			if strings.Contains(body, forbidden) {
				t.Fatalf("expected placeholder %q to be rendered", forbidden)
			}
		}
		for _, required := range []string{
			"piercode-tool",
			"call_id",
			"args",
			"Treat tool output",
			"File access is enforced by the backend",
			"Safety Boundaries",
			"PierCode routing",
			// Risk/confirmation guidance: the question tool gates risky actions.
			"Use the `question` tool before actions",
			// Git detail now lives in the piercode-git-harness skill; the
			// always-on prompt keeps the harness router plus a safety floor.
			"Git Safety Floor",
			"piercode-git-harness",
			"never force-push shared branches",
			"default to action",
			"Do not answer with only a plan",
			"inspect first",
			"piercode-tool-protocol",
			"piercode-self-dev",
			"piercode-code-review",
			"piercode-debug",
			"piercode-safe-shell",
			"For custom skills",
		} {
			if !strings.Contains(body, required) {
				t.Errorf("rendered prompt missing invariant %q", required)
			}
		}
	})
}

func TestHandleScreenshotAttachment(t *testing.T) {
	s := testServer(t)
	rootDir := s.config.GetRootDir()
	screenshotDir := filepath.Join(rootDir, ".piercode", "screenshots")
	if err := os.MkdirAll(screenshotDir, 0o755); err != nil {
		t.Fatalf("create screenshot dir: %v", err)
	}
	shotPath := filepath.Join(screenshotDir, "shot.png")
	if err := os.WriteFile(shotPath, []byte("png-data"), 0o644); err != nil {
		t.Fatalf("write screenshot: %v", err)
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/attachments/screenshot?path="+url.QueryEscape(shotPath), nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var payload map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload["name"] != "shot.png" || payload["mimeType"] != "image/png" || payload["dataBase64"] != "cG5nLWRhdGE=" {
		t.Fatalf("unexpected payload: %#v", payload)
	}

	outside := filepath.Join(rootDir, "outside.png")
	if err := os.WriteFile(outside, []byte("outside"), 0o644); err != nil {
		t.Fatalf("write outside: %v", err)
	}
	w = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/attachments/screenshot?path="+url.QueryEscape(outside), nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected outside path to be forbidden, got %d", w.Code)
	}
}

func TestCORSOptions(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("OPTIONS", "/exec", nil)
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", w.Code)
	}
}

// execJSON 是 /exec 测试的小帮手, 返回解析后的响应。
func execJSON(t *testing.T, s *Server, body string) (int, types.ToolResponse) {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/exec", bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	var resp types.ToolResponse
	json.NewDecoder(w.Body).Decode(&resp)
	return w.Code, resp
}

func TestHandleExecBlocksDangerousCommand(t *testing.T) {
	s := testServer(t)
	code, resp := execJSON(t, s, `{"name":"exec_cmd","call_id":"d1","args":{"command":"rm -rf /"}}`)
	if code != http.StatusOK {
		t.Fatalf("expected 200 with error body, got %d", code)
	}
	if resp.Status != "error" {
		t.Fatalf("dangerous command should be blocked, got status=%s", resp.Status)
	}
	if !strings.Contains(strings.ToLower(resp.Error), "dangerous") {
		t.Errorf("expected dangerous-command error, got %q", resp.Error)
	}
}

func TestHandleExecUnknownTool(t *testing.T) {
	s := testServer(t)
	_, resp := execJSON(t, s, `{"name":"no_such_tool","call_id":"u1","args":{}}`)
	if resp.Status != "error" {
		t.Fatalf("unknown tool should error, got status=%s", resp.Status)
	}
}

func TestHandleExecWriteThenReadRoundTrip(t *testing.T) {
	s := testServer(t)
	_, w := execJSON(t, s, `{"name":"write_file","call_id":"w1","args":{"path":"rt.txt","content":"roundtrip"}}`)
	if w.Status != "success" {
		t.Fatalf("write failed: %s", w.Error)
	}
	_, r := execJSON(t, s, `{"name":"read_file","call_id":"r1","args":{"path":"rt.txt"}}`)
	if r.Status != "success" || !strings.Contains(r.Output, "roundtrip") {
		t.Fatalf("read failed: status=%s output=%q", r.Status, r.Output)
	}
}

func TestHandleExecPathTraversalBlocked(t *testing.T) {
	s := testServer(t)
	_, resp := execJSON(t, s, `{"name":"read_file","call_id":"t1","args":{"path":"../../../etc/passwd"}}`)
	if resp.Status != "error" {
		t.Fatalf("path traversal should be blocked, got status=%s output=%q", resp.Status, resp.Output)
	}
}

func TestHandleListTasks(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/tasks", nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "tasks") {
		t.Errorf("expected tasks key in body, got %q", w.Body.String())
	}
}

func TestHandleConfig(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/config", nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["permissionMode"] != "default" {
		t.Fatalf("expected default permissionMode, got %v", body["permissionMode"])
	}
}

func TestHandleUpdateConfigPermissionMode(t *testing.T) {
	s := testServer(t)
	body, _ := json.Marshal(map[string]string{"permissionMode": "auto"})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if got := s.config.GetPermissionMode(); got != "auto" {
		t.Fatalf("expected auto permission mode, got %q", got)
	}

	body, _ = json.Marshal(map[string]string{"permissionMode": "invalid"})
	w = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid permission mode, got %d", w.Code)
	}
}

func TestHandleStatsIncludesTaskCounts(t *testing.T) {
	s := testServer(t)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/stats", nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	s.router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body map[string]interface{}
	json.NewDecoder(w.Body).Decode(&body)
	for _, k := range []string{"tasks_total", "tasks_running", "browser_clients"} {
		if _, ok := body[k]; !ok {
			t.Errorf("stats missing key %q; body=%v", k, body)
		}
	}
	if body["tasks_total"].(float64) != 0 {
		t.Errorf("expected 0 tasks, got %v", body["tasks_total"])
	}
}
