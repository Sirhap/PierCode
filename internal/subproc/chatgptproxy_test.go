package subproc

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestNewChatGPTProxyDefaultPort(t *testing.T) {
	if got := NewChatGPTProxy(0); got.Port != DefaultPort {
		t.Fatalf("port 0 should default to %d, got %d", DefaultPort, got.Port)
	}
	if got := NewChatGPTProxy(9000); got.Port != 9000 {
		t.Fatalf("explicit port not honored: got %d", got.Port)
	}
}

// Without -tags proxyembed, embeddedProxy returns nil so Start is a no-op and
// must not error or spawn anything.
func TestStartNoEmbedIsNoop(t *testing.T) {
	p := NewChatGPTProxy(0)
	if err := p.Start(); err != nil {
		t.Fatalf("Start with no embedded binary should be nil, got %v", err)
	}
	if p.cmd != nil {
		t.Fatal("Start should not spawn a process when nothing is embedded")
	}
	p.Stop() // must be safe even though nothing started
}

func TestStopIdempotent(t *testing.T) {
	p := NewChatGPTProxy(0)
	p.Stop()
	p.Stop() // second call must not panic
}

// Start reuses an already-running proxy (e.g. a manually-launched dev instance)
// instead of trying to spawn a second one.
func TestStartReusesExistingHealthyProxy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer srv.Close()

	// Extract the port the test server bound to.
	addr := strings.TrimPrefix(srv.URL, "http://")
	_, portStr, ok := strings.Cut(addr, ":")
	if !ok {
		t.Fatalf("unexpected test server URL %q", srv.URL)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("bad port %q: %v", portStr, err)
	}

	p := NewChatGPTProxy(port)
	if !p.healthy(500 * time.Millisecond) {
		t.Fatal("healthy() should detect the running test server")
	}
	if err := p.Start(); err != nil {
		t.Fatalf("Start should reuse healthy proxy without error, got %v", err)
	}
	if p.cmd != nil {
		t.Fatal("Start must not spawn when a healthy proxy already exists")
	}
}
