// Package subproc manages optional child processes that PierCode launches
// alongside the main server — currently the chatgpt-proxy, a bundled
// OpenAI-compatible bridge to the ChatGPT web backend.
//
// The proxy binary is embedded into the PierCode executable at build time (see
// embed_*.go), extracted to a temp dir on first launch, and run as a child
// process whose lifetime is tied to the server: when PierCode exits, the proxy
// is killed. If no proxy binary was embedded for this platform, Start is a
// no-op and ChatGPT sub-agents simply get a connection error until the user
// runs a proxy themselves.
package subproc

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// ChatGPTProxy supervises the embedded chatgpt-proxy child process.
type ChatGPTProxy struct {
	Port int // port the proxy listens on (default 8765)

	cmd     *exec.Cmd
	binPath string // extracted binary path, removed on Stop
}

// DefaultPort is where the proxy listens and where the extension probes /health.
const DefaultPort = 8765

// NewChatGPTProxy returns a supervisor for the given port (0 → DefaultPort).
func NewChatGPTProxy(port int) *ChatGPTProxy {
	if port == 0 {
		port = DefaultPort
	}
	return &ChatGPTProxy{Port: port}
}

// Start extracts the embedded proxy binary and launches it. It returns nil
// (no error, no-op) when no binary is embedded for this platform, so callers
// can always call Start and let the feature degrade gracefully. If a proxy is
// already healthy on the port (user ran one manually), Start skips launching.
func (p *ChatGPTProxy) Start() error {
	if p.healthy(500 * time.Millisecond) {
		fmt.Printf("ℹ️  ChatGPT 代理已在 127.0.0.1:%d 运行，复用现有实例。\n", p.Port)
		return nil
	}

	data, name := embeddedProxy()
	if len(data) == 0 {
		// No binary for this OS/arch — feature unavailable but not fatal.
		fmt.Println("ℹ️  本平台未内置 ChatGPT 代理；ChatGPT 子代理将不可用（可手动运行 chatgpt-proxy）。")
		return nil
	}

	dir, err := os.MkdirTemp("", "piercode-chatgpt-proxy-")
	if err != nil {
		return fmt.Errorf("创建临时目录失败: %w", err)
	}
	binPath := filepath.Join(dir, name)
	if err := os.WriteFile(binPath, data, 0o700); err != nil {
		return fmt.Errorf("释放代理二进制失败: %w", err)
	}
	p.binPath = binPath

	cmd := exec.Command(binPath)
	cmd.Env = append(os.Environ(), fmt.Sprintf("CGPT_PROXY_PORT=%d", p.Port))
	// Inherit stdout/stderr so proxy logs interleave with PierCode's.
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动 ChatGPT 代理失败: %w", err)
	}
	p.cmd = cmd

	// Wait for it to come up; report but don't fail hard if slow. A PyInstaller
	// --onefile binary unpacks to a temp dir on first run, so cold start can take
	// 10-15s; give it 30s before warning.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if p.waitHealthy(ctx) {
		fmt.Printf("✅ ChatGPT 代理已启动：127.0.0.1:%d\n", p.Port)
	} else {
		fmt.Printf("⚠️  ChatGPT 代理启动较慢或失败（127.0.0.1:%d），ChatGPT 子代理可能暂不可用。\n", p.Port)
	}
	return nil
}

// Stop kills the child process and removes the extracted binary. Safe to call
// when Start was a no-op.
func (p *ChatGPTProxy) Stop() {
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
		_, _ = p.cmd.Process.Wait()
		p.cmd = nil
	}
	if p.binPath != "" {
		_ = os.RemoveAll(filepath.Dir(p.binPath))
		p.binPath = ""
	}
}

func (p *ChatGPTProxy) healthURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d/health", p.Port)
}

func (p *ChatGPTProxy) healthy(timeout time.Duration) bool {
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(p.healthURL())
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func (p *ChatGPTProxy) waitHealthy(ctx context.Context) bool {
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		if p.healthy(500 * time.Millisecond) {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
		}
	}
}

// platformName is a human label used in logs / build matching.
func platformName() string {
	return runtime.GOOS + "_" + runtime.GOARCH
}
