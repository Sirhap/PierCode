package browser

import (
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"

	"github.com/sirhap/piercode/internal/tool"
	"golang.org/x/net/publicsuffix"
)

// sameRegistrableHost reports whether two URLs share the same registrable
// domain (eTLD+1), so a benign in-site redirect (www.x.com → x.com, or a path
// change) is treated as the same site while a cross-site navigation
// (x.com → evil.com) is not. An unparseable/empty side is treated as "changed"
// (return false) so the cross-domain guard fails safe. Two empty URLs match.
func sameRegistrableHost(a, b string) bool {
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	if a == b {
		return true
	}
	ra, oka := registrableDomain(a)
	rb, okb := registrableDomain(b)
	if !oka || !okb {
		return false
	}
	return ra == rb
}

func registrableDomain(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", false
	}
	// IP literals must be compared whole. publicsuffix does NOT error on an IPv4
	// address (it treats 127.0.0.1 as a domain and returns "0.1" — its last two
	// labels), which would make every x.0.1 host share one grant key. Detect IPs
	// up front and return them verbatim.
	if net.ParseIP(host) != nil {
		return host, true
	}
	d, err := publicsuffix.EffectiveTLDPlusOne(host)
	if err != nil {
		// Single-label hosts (localhost) have no eTLD+1; compare the bare host
		// instead so they still match themselves.
		return host, true
	}
	return d, true
}

var aiPageHosts = []string{
	"gemini.google.com",
	"aistudio.google.com",
	"qwen.ai",
	"qwenlm.ai",
	"chat.z.ai",
	"kimi.com",
	"claude.ai",
	"free.easychat.top",
	"aistudio.xiaomimimo.com",
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

type SecurityPolicy struct {
	mu sync.RWMutex
	// sensitiveAllow holds registrable domains the user has explicitly marked as
	// NOT sensitive, overriding the keyword heuristic. This fixes false positives
	// where a developer-docs or e-commerce-test page mentions payment/checkout.
	sensitiveAllow map[string]bool
}

func NewSecurityPolicy() *SecurityPolicy {
	return &SecurityPolicy{sensitiveAllow: make(map[string]bool)}
}

// AllowSensitiveHost marks a registrable domain (or any URL/host) as not
// sensitive, so IsSensitive returns false for it. Idempotent.
func (p *SecurityPolicy) AllowSensitiveHost(hostOrURL string) {
	d, ok := registrableDomain(hostOrURL)
	if !ok {
		d = strings.ToLower(strings.TrimSpace(hostOrURL))
	}
	if d == "" {
		return
	}
	p.mu.Lock()
	if p.sensitiveAllow == nil {
		p.sensitiveAllow = make(map[string]bool)
	}
	p.sensitiveAllow[d] = true
	p.mu.Unlock()
}

func (p *SecurityPolicy) isSensitiveAllowed(rawURL string) bool {
	d, ok := registrableDomain(rawURL)
	if !ok {
		return false
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.sensitiveAllow[d]
}

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
	// Strip a trailing dot: "chatgpt.com." is the same site to the browser as
	// "chatgpt.com" (fully-qualified form) but would match neither branch below.
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
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
	// User override: a domain explicitly marked safe is never sensitive.
	if p.isSensitiveAllowed(tab.URL) {
		return false
	}
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
