package tool

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type WebFetchTool struct{}

func NewWebFetchTool() *WebFetchTool { return &WebFetchTool{} }

func (t *WebFetchTool) Name() string        { return "web_fetch" }
func (t *WebFetchTool) Description() string { return "Fetch web page content via HTTP" }
func (t *WebFetchTool) Parameters() interface{} {
	return map[string]string{
		"url":    "string (required) - http/https URL to fetch",
		"format": "string (optional) - 'text' (default, strips HTML) or 'html'",
	}
}

func isPrivateIP(ip net.IP) bool {
	private := []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16", "::1/128", "fc00::/7"}
	for _, cidr := range private {
		_, block, _ := net.ParseCIDR(cidr)
		if block.Contains(ip) {
			return true
		}
	}
	return false
}

func (t *WebFetchTool) Validate(args map[string]interface{}) error {
	rawURL, ok := args["url"].(string)
	if !ok || rawURL == "" {
		return fmt.Errorf("url is required")
	}
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		return fmt.Errorf("only http/https URLs are supported")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL")
	}
	host := parsed.Hostname()
	ips, err := net.LookupHost(host)
	if err != nil {
		return fmt.Errorf("cannot resolve host: %s", host)
	}
	for _, ipStr := range ips {
		if ip := net.ParseIP(ipStr); ip != nil && isPrivateIP(ip) {
			return fmt.Errorf("requests to private/internal addresses are not allowed")
		}
	}
	return nil
}

var (
	htmlTagRe    = regexp.MustCompile(`<[^>]+>`)
	multiSpaceRe = regexp.MustCompile(`[ \t]{2,}`)
	multiNewline = regexp.MustCompile(`\n{3,}`)
)

func stripHTML(s string) string {
	s = htmlTagRe.ReplaceAllString(s, " ")
	s = multiSpaceRe.ReplaceAllString(s, " ")
	s = multiNewline.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

func (t *WebFetchTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	url, _ := ctx.Args["url"].(string)
	format, _ := ctx.Args["format"].(string)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1*1024*1024))
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	content := string(body)
	if format != "html" {
		content = stripHTML(content)
	}

	output, _ := Truncate(content)
	result.Status = "success"
	result.Output = output
	result.EndTime = time.Now()
	return result
}
