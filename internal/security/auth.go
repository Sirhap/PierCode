package security

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"

	"github.com/gin-gonic/gin"
)

func NewSessionToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}
	return hex.EncodeToString(b), nil
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
