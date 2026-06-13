package tool

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

type WebFetchTool struct{}

func NewWebFetchTool() *WebFetchTool { return &WebFetchTool{} }

func (t *WebFetchTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }

func (t *WebFetchTool) Name() string { return "web_fetch" }
func (t *WebFetchTool) Description() string {
	return "Fetch public web page content via HTTP/HTTPS (private/internal addresses are blocked)."
}
func (t *WebFetchTool) Parameters() interface{} {
	return map[string]string{
		"url":    "string (required) - http/https URL to fetch",
		"format": "string (optional) - 'text' (default, strips HTML) or 'html'",
	}
}

// blockedCIDRs 覆盖各种「内部地址」的 CIDR：私网、回环、链路本地、CGNAT、
// 0.0.0.0/8 与 IPv6 等价段。比黑名单形式可靠，因为 net.IP.To4 会把
// IPv4-mapped-IPv6（::ffff:127.0.0.1）转成 v4 后再比对。
var blockedCIDRs = func() []*net.IPNet {
	cidrs := []string{
		"0.0.0.0/8",
		"10.0.0.0/8",
		"100.64.0.0/10", // CGNAT
		"127.0.0.0/8",
		"169.254.0.0/16", // link-local（含 AWS metadata 169.254.169.254）
		"172.16.0.0/12",
		"192.0.0.0/24",
		"192.168.0.0/16",
		"198.18.0.0/15",
		"::1/128",
		"fc00::/7",
		"fe80::/10",
	}
	var nets []*net.IPNet
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err == nil {
			nets = append(nets, n)
		}
	}
	return nets
}()

// allowLoopbackForTests is a test-only escape hatch: when true, isBlockedIP
// permits loopback / unspecified addresses so httptest.NewServer can be hit.
// Production code never flips this; only TestWebFetchExecute does.
var allowLoopbackForTests atomic.Bool

func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	// IPv4-mapped-IPv6 ::ffff:127.0.0.1 → 127.0.0.1，这样 v4 段也能命中。
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	if allowLoopbackForTests.Load() && (ip.IsLoopback() || ip.IsUnspecified()) {
		return false
	}
	if ip.IsUnspecified() || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() {
		return true
	}
	for _, n := range blockedCIDRs {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// safeDialer 在每次 TCP 拨号时校验目标 IP，从根本上阻止 DNS rebinding 与
// 重定向到内部地址：即便 LookupHost 校验时返回的是公网 IP，真正建连时
// 也必须再过一遍 isBlockedIP。
var safeDialer = &net.Dialer{
	Timeout:   10 * time.Second,
	KeepAlive: 30 * time.Second,
	Control: func(network, address string, c syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		ip := net.ParseIP(host)
		if ip == nil {
			// 走到这里说明 DialContext 没用 Resolver 解析，host 还是域名，
			// 退回保守拒绝。正常路径 DialContext 已把 host 替换为 IP。
			return fmt.Errorf("unresolved host: %s", host)
		}
		if isBlockedIP(ip) {
			return fmt.Errorf("connection to internal address blocked: %s", ip)
		}
		return nil
	},
}

// resolveAndCheckHost resolves host through ctx's resolver and returns an
// error if any resolved address is internal. Centralizes the host→IP gate
// so every caller (initial dial + redirect check) goes through the same
// resolver and the same blocked-IP rules. Without this the initial path
// used DefaultResolver.LookupIPAddr while CheckRedirect used net.LookupHost,
// and a future resolver swap could leave one path unprotected.
func resolveAndCheckHost(ctx context.Context, host string) ([]net.IPAddr, error) {
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	for _, ip := range ips {
		if isBlockedIP(ip.IP) {
			return nil, fmt.Errorf("blocked internal address: %s", ip.IP)
		}
	}
	return ips, nil
}

func safeDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	// Per-IP dial loop: try each address but skip blocked ones; this lets a
	// host with both public and internal addresses still reach the public
	// one if dial to the public IP succeeds first. resolveAndCheckHost is
	// used by the redirect check where any blocked IP must abort the whole
	// request.
	var lastErr error
	for _, ip := range ips {
		if isBlockedIP(ip.IP) {
			lastErr = fmt.Errorf("blocked internal address: %s", ip.IP)
			continue
		}
		conn, err := safeDialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("no usable address")
	}
	return nil, lastErr
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
	// 这里仍做一次预检，给出更友好的错误；最终防线是 DialContext，DNS
	// rebinding 也无法绕过。
	ips, err := net.LookupHost(host)
	if err != nil {
		return fmt.Errorf("cannot resolve host: %s", host)
	}
	for _, ipStr := range ips {
		if ip := net.ParseIP(ipStr); ip != nil && isBlockedIP(ip) {
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

// safeHTTPClient 是一个全局 client：自定义 Transport 走 safeDialContext 在
// 每次拨号时检查目标 IP；CheckRedirect 对每跳重定向再次校验主机，避免
// 公网 URL → 302 → http://localhost:6379 这类 SSRF。
var safeHTTPClient = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		DialContext:           safeDialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("too many redirects")
		}
		// Re-validate the redirect target through the same resolver +
		// blocked-IP rules used by safeDialContext. A public URL that 302s
		// to http://localhost:6379 (Redis) must be stopped here.
		if _, err := resolveAndCheckHost(req.Context(), req.URL.Hostname()); err != nil {
			return err
		}
		return nil
	},
}

func (t *WebFetchTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	rawURL, _ := ctx.Args["url"].(string)
	format, _ := ctx.Args["format"].(string)

	parentCtx := ctx.Context
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	reqCtx, cancel := context.WithTimeout(parentCtx, 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, rawURL, nil)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	resp, err := safeHTTPClient.Do(req)
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
