package security

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestNewSessionTokenDoesNotReuseStoredToken(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	settingsDir := filepath.Join(dir, ".piercode")
	os.MkdirAll(settingsDir, 0700)
	os.WriteFile(filepath.Join(settingsDir, "settings.json"), []byte(`{"token":"mytoken123"}`), 0600)

	token1, err := NewSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	token2, err := NewSessionToken()
	if err != nil {
		t.Fatal(err)
	}

	if token1 == "mytoken123" || token2 == "mytoken123" {
		t.Fatalf("session token should not reuse stored token: %q %q", token1, token2)
	}
	if token1 == token2 {
		t.Fatalf("session token should be regenerated each call, got %q", token1)
	}
	if len(token1) != 64 || len(token2) != 64 {
		t.Fatalf("expected 64 hex chars, got %d and %d", len(token1), len(token2))
	}
	for _, token := range []string{token1, token2} {
		if _, err := strconv.ParseUint(token[:16], 16, 64); err != nil {
			t.Fatalf("expected hex token, got %q", token)
		}
	}
}

func TestPersistentSessionTokenStableAcrossCalls(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	tok1, err := PersistentSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(tok1) != 64 {
		t.Fatalf("expected 64 hex chars, got %d", len(tok1))
	}

	// File must be created on first call.
	path := filepath.Join(dir, ".piercode", "token")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("token file not written: %v", err)
	}
	if got := strings.TrimSpace(string(data)); got != tok1 {
		t.Fatalf("persisted token %q != returned %q", got, tok1)
	}

	// Second call reuses the stored token.
	tok2, err := PersistentSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if tok1 != tok2 {
		t.Fatalf("persistent token changed across calls: %q vs %q", tok1, tok2)
	}
}

func TestPersistentSessionTokenReusesExistingFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)

	settingsDir := filepath.Join(dir, ".piercode")
	if err := os.MkdirAll(settingsDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(settingsDir, "token"), []byte("  preset-token-abc\n"), 0600); err != nil {
		t.Fatal(err)
	}

	tok, err := PersistentSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if tok != "preset-token-abc" {
		t.Fatalf("expected stored token reused, got %q", tok)
	}
}

func TestAuthMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)

	handler := AuthMiddleware("secret")
	router := gin.New()
	router.Use(handler)
	router.GET("/health", func(c *gin.Context) { c.Status(200) })
	router.GET("/auth", func(c *gin.Context) { c.Status(200) })
	router.GET("/protected", func(c *gin.Context) { c.Status(200) })
	router.GET("/ws", func(c *gin.Context) { c.Status(200) })

	t.Run("health bypasses auth", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/health", nil)
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
	})

	t.Run("auth endpoint bypasses auth", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/auth", nil)
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
	})

	t.Run("protected without token returns 401", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/protected", nil)
		router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})

	t.Run("protected with valid token returns 200", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/protected", nil)
		req.Header.Set("Authorization", "Bearer secret")
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
	})

	t.Run("protected with wrong token returns 401", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/protected", nil)
		req.Header.Set("Authorization", "Bearer wrong")
		router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})

	t.Run("websocket accepts query token", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/ws?token=secret", nil)
		router.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", w.Code)
		}
	})

	t.Run("websocket rejects wrong query token", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/ws?token=wrong", nil)
		router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})

	t.Run("protected route does not accept query token", func(t *testing.T) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/protected?token=secret", nil)
		router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d", w.Code)
		}
	})
}
