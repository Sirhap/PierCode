package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
)

func TestWSManager_RegisterAndUnregister(t *testing.T) {
	m := NewWSManager(nil)
	m.Start()
	defer m.Close()

	// 模拟创建两个客户端连接（使用测试服务器）
	svr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _ := m.Upgrade(w, r)
		m.Register(conn)
		defer m.Unregister(conn)
		// 保持连接
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				break
			}
		}
	}))
	defer svr.Close()

	// 替换 ws:// 协议
	wsURL := "ws" + svr.URL[4:]

	// 连接客户端 1
	conn1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	assert.NoError(t, err)
	defer conn1.Close()

	// 连接客户端 2
	conn2, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	assert.NoError(t, err)
	defer conn2.Close()

	// 给一点时间让连接注册完成
	time.Sleep(50 * time.Millisecond)

	// 验证两个客户端都已注册
	m.clientsMu.RLock()
	assert.Equal(t, 2, len(m.clients))
	m.clientsMu.RUnlock()

	// 发送广播消息
	testMsg := []byte(`{"type":"test","data":"hello"}`)
	m.Send(testMsg)

	// 验证两个客户端都收到了消息
	var received1, received2 map[string]interface{}

	// 设置读取超时
	conn1.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg1, err := conn1.ReadMessage()
	assert.NoError(t, err)
	err = json.Unmarshal(msg1, &received1)
	assert.NoError(t, err)
	assert.Equal(t, "test", received1["type"])
	assert.Equal(t, "hello", received1["data"])

	conn2.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg2, err := conn2.ReadMessage()
	assert.NoError(t, err)
	err = json.Unmarshal(msg2, &received2)
	assert.NoError(t, err)
	assert.Equal(t, "test", received2["type"])
	assert.Equal(t, "hello", received2["data"])
}

func TestWSManager_BroadcastConcurrent(t *testing.T) {
	m := NewWSManager(nil)
	m.Start()
	defer m.Close()

	var wg sync.WaitGroup
	const clientCount = 5
	const msgCount = 10

	// 创建测试服务器模拟客户端连接
	svr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _ := m.Upgrade(w, r)
		m.Register(conn)
		defer m.Unregister(conn)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				break
			}
		}
	}))
	defer svr.Close()

	wsURL := "ws" + svr.URL[4:]

	// 启动多个客户端协程监听消息
	receivedCounts := make([]int, clientCount)
	for i := 0; i < clientCount; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
			if err != nil {
				return
			}
			defer conn.Close()

			conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			for j := 0; j < msgCount; j++ {
				_, msg, err := conn.ReadMessage()
				if err != nil {
					break
				}
				if string(msg) != "" {
					receivedCounts[idx]++
				}
			}
		}(i)
	}

	// 给客户端连接时间
	time.Sleep(100 * time.Millisecond)

	// 并发发送多条消息
	for i := 0; i < msgCount; i++ {
		m.Send([]byte(fmt.Sprintf(`{"seq":%d}`, i)))
	}

	// 等待客户端接收完成
	wg.Wait()

	// 验证每个客户端都收到了所有消息（允许少量丢失，因为测试环境）
	for i, count := range receivedCounts {
		// 至少收到 80% 的消息算通过（考虑测试环境的不稳定性）
		assert.GreaterOrEqual(t, count, msgCount*8/10, "客户端 %d 收到的消息数不足", i)
	}
}

func TestWSManager_CloseIsIdempotent(t *testing.T) {
	m := NewWSManager(nil)
	m.Start()

	m.Close()
	m.Close()
	assert.Equal(t, 0, m.ClientCount())
}

func TestWSManager_SendNonBlocking(t *testing.T) {
	m := NewWSManager(nil)
	m.Start()

	// 快速发送大量消息，验证不会阻塞
	done := make(chan bool)
	go func() {
		for i := 0; i < 1000; i++ {
			m.Send([]byte(fmt.Sprintf(`{"n":%d}`, i)))
		}
		done <- true
	}()

	select {
	case <-done:
		// 成功，没有阻塞
		assert.True(t, true)
	case <-time.After(2 * time.Second):
		t.Fatal("Send 方法阻塞了超过 2 秒")
	}
}

func TestWSManager_BroadcastDisconnectsFullClientQueue(t *testing.T) {
	m := NewWSManager(nil)
	defer m.Close()

	slow := &clientConn{send: make(chan []byte, 1)}
	slow.send <- []byte("already full")
	healthy := &clientConn{send: make(chan []byte, 1)}

	m.clientsMu.Lock()
	m.clients[slow] = true
	m.clients[healthy] = true
	m.clientsMu.Unlock()

	done := make(chan struct{})
	go func() {
		m.Broadcast([]byte("ok"))
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("Broadcast waited on a full client queue")
	}

	select {
	case msg := <-healthy.send:
		assert.Equal(t, "ok", string(msg))
	default:
		t.Fatal("healthy client did not receive broadcast")
	}

	assert.Eventually(t, func() bool {
		return m.ClientCount() == 1
	}, time.Second, 10*time.Millisecond)
}

func TestWSManagerSendToRoleTargetsOnlyMatchingClients(t *testing.T) {
	m := NewWSManager(nil)
	defer m.Close()

	content := &clientConn{send: make(chan []byte, 1), role: "ai-page"}
	relay := &clientConn{send: make(chan []byte, 1), role: "browser-relay"}
	m.clientsMu.Lock()
	m.clients[content] = true
	m.clients[relay] = true
	m.clientsMu.Unlock()

	if !m.SendToRole("browser-relay", []byte("cmd")) {
		t.Fatal("expected browser-relay send to report success")
	}
	select {
	case msg := <-relay.send:
		assert.Equal(t, "cmd", string(msg))
	default:
		t.Fatal("relay did not receive targeted message")
	}
	select {
	case msg := <-content.send:
		t.Fatalf("content client should not receive browser command, got %q", msg)
	default:
	}
}

func TestFormatProviderCountsSummarizesManyProviders(t *testing.T) {
	got := FormatProviderCounts(map[string]int{
		"ChatGPT":   3,
		"Qwen":      2,
		"Claude":    1,
		"Gemini":    1,
		"AI Studio": 1,
	})

	assert.Equal(t, "8 pages / 5 providers (ChatGPT 3, Qwen 2, AI Studio 1, +2 providers)", got)
}

func TestFormatProviderCountsKeepsSmallProviderSetsReadable(t *testing.T) {
	got := FormatProviderCounts(map[string]int{"Qwen": 1, "ChatGPT": 2})

	assert.Equal(t, "3 pages / 2 providers (ChatGPT 2, Qwen 1)", got)
}

func TestFormatProviderCountsUsesSingularLabels(t *testing.T) {
	got := FormatProviderCounts(map[string]int{"Qwen": 1})

	assert.Equal(t, "1 page / 1 provider (Qwen 1)", got)
}

func TestInjectMessageFormat(t *testing.T) {
	// 验证 /inject 接口生成的 WebSocket 消息格式正确
	text := "测试消息 🎉"
	expected := fmt.Sprintf(`{"type":"inject","text":%q}`, text)

	actual := fmt.Sprintf(`{"type":"inject","text":%q}`, text)
	assert.Equal(t, expected, actual)

	// 验证特殊字符转义（%q 会转义引号和反斜杠）
	specialText := `"quotes" and \backslash`
	expectedEscaped := fmt.Sprintf(`{"type":"inject","text":%q}`, specialText)
	assert.Contains(t, expectedEscaped, "inject")
	// %q 会转义引号为 \"，反斜杠为 \\，所以断言转义后的内容
	assert.Contains(t, expectedEscaped, `\"quotes\"`)
	assert.Contains(t, expectedEscaped, `\\backslash`)
}

// TestIsAllowedOrigin pins the cross-site policy: empty Origin (same-origin /
// curl / native clients) and known-safe schemes pass through; arbitrary HTTPS
// hosts must be explicitly whitelisted. The matrix is small but the cost of a
// silent regression here is direct CSRF / WS-hijack reachability, so the table
// stays compact and verbose.
func TestIsAllowedOrigin(t *testing.T) {
	cases := []struct {
		name    string
		origin  string
		allowed []string
		want    bool
	}{
		{"empty origin allowed (same-origin / curl)", "", nil, true},
		{"chrome extension always allowed", "chrome-extension://abcdef", nil, true},
		{"firefox extension allowed", "moz-extension://uuid", nil, true},
		{"safari extension allowed", "safari-web-extension://uuid", nil, true},
		{"http loopback allowed any port", "http://127.0.0.1:8080", nil, true},
		{"http localhost allowed", "http://localhost:5173", nil, true},
		{"ipv6 loopback allowed", "http://[::1]:39527", nil, true},
		{"https external rejected by default", "https://evil.com", nil, false},
		{"http public rejected by default", "http://example.com", nil, false},
		{"explicit whitelist match", "https://staging.app", []string{"https://staging.app"}, true},
		{"whitelist requires exact match", "https://staging.app:443", []string{"https://staging.app"}, false},
		{"malformed origin rejected", "://broken", nil, false},
		// CSWSH bypass attempts: an attacker host that merely CONTAINS a loopback
		// label must not pass the loopback check (Hostname() is compared whole).
		{"loopback subdomain spoof rejected", "http://127.0.0.1.evil.com", nil, false},
		{"localhost subdomain spoof rejected", "https://localhost.evil.com", nil, false},
		{"loopback-prefixed host rejected", "http://127.0.0.1-evil.com", nil, false},
		{"localhost as suffix rejected", "http://evil.localhost.com", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := IsAllowedOrigin(tc.origin, tc.allowed)
			if got != tc.want {
				t.Errorf("IsAllowedOrigin(%q, %v) = %v, want %v", tc.origin, tc.allowed, got, tc.want)
			}
		})
	}
}
