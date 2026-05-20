package security

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
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
