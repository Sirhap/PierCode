package browser

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/sirhap/piercode/internal/tool"
)

var aiPageHosts = []string{
	"gemini.google.com",
	"aistudio.google.com",
	"qwen.ai",
	"qwenlm.ai",
	"chat.z.ai",
	"kimi.com",
	"claude.ai",
	"chatgpt.com",
	"chat.openai.com",
}

// sensitiveHostPatterns match against hostname only (not path or title).
// [Fixed by mimo-v2.5-pro: split host vs path patterns to reduce false positives]
var sensitiveHostPatterns = []string{
	"bank",
	"alipay",
	"paypal",
}

// sensitivePathKeywords match against URL path + title text.
// These are more specific to avoid false positives on developer docs.
var sensitivePathKeywords = []string{
	"/payment",
	"/checkout",
	"/finance",
	"/wallet",
	"/transfer",
	"payment",
	"checkout",
	"付款",
	"支付",
	"转账",
	"结账",
}

type SecurityPolicy struct{}

func NewSecurityPolicy() *SecurityPolicy { return &SecurityPolicy{} }

func (p *SecurityPolicy) CheckNavigate(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "about:blank" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid URL")
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
		return nil
	default:
		return fmt.Errorf("browser navigation only supports http, https, and about:blank URLs")
	}
}

func (p *SecurityPolicy) IsAIPage(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, aiHost := range aiPageHosts {
		if host == aiHost || strings.HasSuffix(host, "."+aiHost) {
			return true
		}
	}
	return false
}

// IsSensitive checks if a tab likely contains payment/financial content.
// [Fixed by mimo-v2.5-pro: split host vs path matching, added Chinese keywords]
func (p *SecurityPolicy) IsSensitive(tab tool.BrowserTab) bool {
	u, err := url.Parse(strings.TrimSpace(tab.URL))
	if err == nil {
		host := strings.ToLower(u.Hostname())
		for _, pattern := range sensitiveHostPatterns {
			if strings.Contains(host, pattern) {
				return true
			}
		}
	}
	text := strings.ToLower(tab.URL + " " + tab.Title)
	for _, keyword := range sensitivePathKeywords {
		if strings.Contains(text, keyword) {
			return true
		}
	}
	return false
}

func originOf(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme + "://" + u.Host)
}
