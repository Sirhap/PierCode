package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/afumu/openlink/internal/types"
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

	t.Run("query token trims copied whitespace", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/auth?token=%20testtoken%0A", nil)
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

func TestHandlePrompt(t *testing.T) {
	s := testServer(t)

	t.Run("missing init_prompt.txt returns 404", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/prompt", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d", w.Code)
		}
	})

	t.Run("existing init_prompt.txt returns content", func(t *testing.T) {
		promptDir := filepath.Join(s.config.RootDir, "prompts")
		os.MkdirAll(promptDir, 0755)
		os.WriteFile(filepath.Join(promptDir, "init_prompt.txt"), []byte("hello prompt"), 0644)
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/prompt", nil)
		req.Header.Set("Authorization", "Bearer testtoken")
		s.router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
		if !bytes.Contains(w.Body.Bytes(), []byte("hello prompt")) {
			t.Errorf("expected prompt content in response")
		}
	})

	t.Run("existing init_prompt.txt renders placeholders", func(t *testing.T) {
		promptDir := filepath.Join(s.config.RootDir, "prompts")
		os.MkdirAll(promptDir, 0755)
		os.WriteFile(filepath.Join(promptDir, "init_prompt.txt"), []byte("system:\n{{SYSTEM_INFO}}\n\ntools:\n{{TOOLS}}"), 0644)
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
