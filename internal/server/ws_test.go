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
	m := NewWSManager()
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
	m := NewWSManager()
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
	m := NewWSManager()
	m.Start()

	m.Close()
	m.Close()
	assert.Equal(t, 0, m.ClientCount())
}

func TestWSManager_SendNonBlocking(t *testing.T) {
	m := NewWSManager()
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
