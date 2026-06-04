package security

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

func NewSessionToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// userHomeDir is indirected for testing.
var userHomeDir = os.UserHomeDir

// tokenFilePath returns ~/.piercode/token.
func tokenFilePath() (string, error) {
	home, err := userHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".piercode", "token"), nil
}

// PersistentSessionToken returns a token that is stable across server restarts.
// On first launch it generates a random token and writes it to ~/.piercode/token
// (0600); subsequent launches reuse the stored value so the extension stays
// authorized without re-pasting the auth URL. If the file cannot be read or
// written, it falls back to an in-memory random token.
func PersistentSessionToken() (string, error) {
	path, err := tokenFilePath()
	if err != nil {
		return NewSessionToken()
	}

	if data, err := os.ReadFile(path); err == nil {
		if tok := strings.TrimSpace(string(data)); tok != "" {
			return tok, nil
		}
	}

	tok, err := NewSessionToken()
	if err != nil {
		return "", err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err == nil {
		// Best-effort persist; a write failure still yields a usable (though
		// non-persistent) token rather than blocking startup.
		_ = os.WriteFile(path, []byte(tok+"\n"), 0o600)
	}
	return tok, nil
}

func AuthMiddleware(token string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.URL.Path == "/health" || c.Request.URL.Path == "/auth" {
			c.Next()
			return
		}

		if !authorized(c, token) {
			c.JSON(401, gin.H{"error": "unauthorized"})
			c.Abort()
			return
		}
		c.Next()
	}
}

func authorized(c *gin.Context, token string) bool {
	auth := c.GetHeader("Authorization")
	expected := "Bearer " + token
	if len(auth) == len(expected) && subtle.ConstantTimeCompare([]byte(auth), []byte(expected)) == 1 {
		return true
	}

	// Claude Code authenticates with ANTHROPIC_API_KEY via the x-api-key header
	// rather than Authorization: Bearer. Accept it so the /v1/messages
	// impersonation works without forcing ANTHROPIC_AUTH_TOKEN.
	if apiKey := c.GetHeader("x-api-key"); apiKey != "" && tokenMatches(apiKey, token) {
		return true
	}

	if c.Request.URL.Path != "/ws" {
		return false
	}
	queryToken := c.Query("token")
	return tokenMatches(queryToken, token)
}

func tokenMatches(got, want string) bool {
	if got == "" || len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}
