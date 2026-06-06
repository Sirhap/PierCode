package server

import (
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	wsClientQueueSize = 64
	wsWriteTimeout    = 5 * time.Second
	wsReadTimeout     = 60 * time.Second
)

// clientConn wraps one WebSocket connection. Its writePump is the only
// goroutine that writes to conn.
type clientConn struct {
	conn      *websocket.Conn
	send      chan []byte
	id        string
	client    string
	role      string
	provider  string
	connected time.Time
	closeOnce sync.Once
}

type WSClientMeta struct {
	ID        string
	Client    string
	Role      string
	Provider  string
	Connected time.Time
}

// WSManager 管理所有 WebSocket 连接
type WSManager struct {
	clients        map[*clientConn]bool
	clientsMu      sync.RWMutex
	upgrader       websocket.Upgrader
	done           chan struct{}
	closeOnce      sync.Once
	allowedOrigins []string
}

// NewWSManager 创建新的 WebSocket 管理器。allowedOrigins 是用户显式配置的
// Origin 白名单（除自动放行的 chrome-extension:// 与 127.0.0.1/localhost 之外）。
func NewWSManager(allowedOrigins []string) *WSManager {
	return &WSManager{
		clients:        make(map[*clientConn]bool),
		done:           make(chan struct{}),
		allowedOrigins: append([]string(nil), allowedOrigins...),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			// Content scripts create WebSocket connections from the AI
			// page's origin (e.g. https://chatgpt.com), not from
			// chrome-extension://. Since the token in the query string
			// already authenticates the connection, we accept any origin
			// for the WS upgrade. The CORS middleware has already been
			// bypassed for /ws, so this is the sole origin gate.
			CheckOrigin: func(r *http.Request) bool {
				return true
			},
		},
	}
}

// Upgrade 升级 HTTP 连接到 WebSocket
func (m *WSManager) Upgrade(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	return m.upgrader.Upgrade(w, r, nil)
}

// Register 注册新的客户端连接
func (m *WSManager) Register(conn *websocket.Conn) {
	m.RegisterWithProvider(conn, "")
}

// RegisterWithProvider registers a client and records the AI surface it came
// from so status UIs can show something more useful than a raw page count.
func (m *WSManager) RegisterWithProvider(conn *websocket.Conn, provider string) {
	m.RegisterWithMeta(conn, WSClientMeta{Provider: provider})
}

func (m *WSManager) RegisterWithMeta(conn *websocket.Conn, meta WSClientMeta) {
	if meta.ID == "" {
		meta.ID = fmt.Sprintf("ws_%d", time.Now().UnixNano())
	}
	if meta.Client == "" {
		meta.Client = "content"
	}
	if meta.Role == "" {
		meta.Role = "ai-page"
	}
	if meta.Connected.IsZero() {
		meta.Connected = time.Now()
	}
	cc := &clientConn{
		conn:      conn,
		send:      make(chan []byte, wsClientQueueSize),
		id:        meta.ID,
		client:    strings.TrimSpace(meta.Client),
		role:      strings.TrimSpace(meta.Role),
		provider:  normalizeProvider(meta.Provider),
		connected: meta.Connected,
	}
	m.clientsMu.Lock()
	m.clients[cc] = true
	m.clientsMu.Unlock()
	go m.writePump(cc)
}

func (m *WSManager) SendToID(id string, message []byte) bool {
	id = strings.TrimSpace(id)
	if id == "" {
		return false
	}
	var failed []*clientConn
	sent := false
	m.clientsMu.RLock()
	for cc := range m.clients {
		if cc.id != id {
			continue
		}
		select {
		case cc.send <- message:
			sent = true
		default:
			failed = append(failed, cc)
		}
	}
	m.clientsMu.RUnlock()
	for _, cc := range failed {
		m.unregisterClient(cc)
	}
	return sent
}

// ClientCount returns the number of currently connected browser extensions.
func (m *WSManager) ClientCount() int {
	m.clientsMu.RLock()
	defer m.clientsMu.RUnlock()
	return len(m.clients)
}

func (m *WSManager) ProviderCounts() map[string]int {
	m.clientsMu.RLock()
	defer m.clientsMu.RUnlock()
	counts := make(map[string]int)
	for cc := range m.clients {
		counts[normalizeProvider(cc.provider)]++
	}
	return counts
}

func (m *WSManager) RoleCount(role string) int {
	m.clientsMu.RLock()
	defer m.clientsMu.RUnlock()
	count := 0
	for cc := range m.clients {
		if cc.role == role {
			count++
		}
	}
	return count
}

func normalizeProvider(provider string) string {
	switch strings.TrimSpace(provider) {
	case "ChatGPT", "Claude", "Gemini", "Qwen", "Kimi", "Z.ai", "AI Studio", "MiMo", "Extension":
		return provider
	default:
		return "Browser"
	}
}

func FormatProviderCounts(counts map[string]int) string {
	if len(counts) == 0 {
		return "0 pages"
	}
	total := 0
	names := make([]string, 0, len(counts))
	for name := range counts {
		names = append(names, name)
		total += counts[name]
	}
	sort.Strings(names)
	sort.SliceStable(names, func(i, j int) bool {
		if counts[names[i]] != counts[names[j]] {
			return counts[names[i]] > counts[names[j]]
		}
		return names[i] < names[j]
	})
	limit := len(names)
	if limit > 3 {
		limit = 3
	}
	parts := make([]string, 0, limit+1)
	for _, name := range names[:limit] {
		parts = append(parts, name+" "+strconv.Itoa(counts[name]))
	}
	if rest := len(names) - limit; rest > 0 {
		parts = append(parts, "+"+formatProviderCount(rest))
	}
	return formatPageCount(total) + " / " + formatProviderCount(len(names)) + " (" + strings.Join(parts, ", ") + ")"
}

func formatPageCount(count int) string {
	if count == 1 {
		return "1 page"
	}
	return strconv.Itoa(count) + " pages"
}

func formatProviderCount(count int) string {
	if count == 1 {
		return "1 provider"
	}
	return strconv.Itoa(count) + " providers"
}

// Unregister 移除客户端连接
func (m *WSManager) Unregister(conn *websocket.Conn) {
	m.clientsMu.Lock()
	for cc := range m.clients {
		if cc.conn == conn {
			delete(m.clients, cc)
			cc.close()
			break
		}
	}
	m.clientsMu.Unlock()
}

// Broadcast queues a message for all connected clients. Slow clients are
// disconnected instead of being allowed to stall every other receiver.
func (m *WSManager) Broadcast(message []byte) {
	var failed []*clientConn
	m.clientsMu.RLock()
	for cc := range m.clients {
		select {
		case cc.send <- message:
		default:
			failed = append(failed, cc)
		}
	}
	m.clientsMu.RUnlock()

	if len(failed) > 0 {
		for _, cc := range failed {
			m.unregisterClient(cc)
		}
	}
}

// Start is retained for API/test compatibility. Broadcasting no longer runs
// through a single intermediate channel + drain goroutine; Send fans out to
// every client directly (see Send). Nothing to start.
func (m *WSManager) Start() {}

// Close 关闭广播循环并断开所有客户端
func (m *WSManager) Close() {
	m.closeOnce.Do(func() {
		close(m.done)
		m.clientsMu.Lock()
		for cc := range m.clients {
			delete(m.clients, cc)
			cc.close()
		}
		m.clientsMu.Unlock()
	})
}

// Send fans a message out to every connected client. It no longer routes
// through a shared buffered channel + single drain goroutine — that funnel
// serialized all broadcasts and silently dropped messages (including
// tool_stream chunks and tool_done) when a stdout-heavy task burst past the
// buffer. Send is non-blocking: Broadcast delivers into each client's own
// buffered send queue, and only a client whose own queue is full gets
// disconnected. A healthy client never loses a message to a global-queue spike.
func (m *WSManager) Send(message []byte) {
	m.Broadcast(message)
}

func (m *WSManager) SendToRole(role string, message []byte) bool {
	var failed []*clientConn
	sent := false
	m.clientsMu.RLock()
	for cc := range m.clients {
		if cc.role != role {
			continue
		}
		select {
		case cc.send <- message:
			sent = true
		default:
			failed = append(failed, cc)
		}
	}
	m.clientsMu.RUnlock()
	for _, cc := range failed {
		m.unregisterClient(cc)
	}
	return sent
}

// IsAllowedOrigin 判断 Origin header 是否允许。空 Origin（同源 / 非浏览器
// 工具）放行；chrome-extension:// 自动放行；127.0.0.1 / localhost 任意端口
// 放行；其它必须出现在 allowed 列表里精确匹配。
func IsAllowedOrigin(origin string, allowed []string) bool {
	if origin == "" {
		// 同源请求或 curl/native client（未携带 Origin），不构成跨站风险。
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	switch u.Scheme {
	case "chrome-extension", "moz-extension", "safari-web-extension":
		return true
	case "http", "https":
		host := u.Hostname()
		if host == "127.0.0.1" || host == "::1" || host == "localhost" {
			return true
		}
	}
	for _, a := range allowed {
		if a == origin {
			return true
		}
	}
	return false
}

func (m *WSManager) writePump(cc *clientConn) {
	for msg := range cc.send {
		if cc.conn != nil {
			_ = cc.conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := cc.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				m.unregisterClient(cc)
				return
			}
		}
	}
}

func (m *WSManager) unregisterClient(cc *clientConn) {
	m.clientsMu.Lock()
	if _, ok := m.clients[cc]; ok {
		delete(m.clients, cc)
		cc.close()
	}
	m.clientsMu.Unlock()
}

func (cc *clientConn) close() {
	cc.closeOnce.Do(func() {
		close(cc.send)
		if cc.conn != nil {
			_ = cc.conn.Close()
		}
	})
}
