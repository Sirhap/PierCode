package server

import (
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	wsClientQueueSize = 64
	wsWriteTimeout    = 5 * time.Second
	wsReadTimeout     = 60 * time.Second
)

// wsFallbackSeq makes auto-generated WS client ids unique even if two clients
// connect within the same nanosecond (UnixNano alone can collide on coarse
// clocks). Only the browser-relay path hits this — content scripts supply their
// own high-entropy id — but a collision would alias two connections' routing.
var wsFallbackSeq atomic.Uint64

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

// tabOwners maps a browser tabId to the WS client id of the browser instance
// that hosts it. Multiple browsers may each connect as role "browser-relay";
// without this, a tabId-targeted command would be broadcast to every browser
// and a non-owning one answers "No tab with id …" first, breaking the call.
// Learned from listTabs / browser_event(tab_created|tab_updated). Cleared when
// the tab closes or the owning client disconnects.

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

	tabOwnersMu sync.RWMutex
	tabOwners   map[int]string // tabId → owning browser-relay client id

	// onForgetTabs, if set, is called with the tabIds a disconnecting browser
	// owned, so the controller can clear a default tab hosted by the now-gone
	// browser (no tab_removed event fires on a WS disconnect). Wired once at
	// startup before any connection, so a plain field read is race-free.
	onForgetTabs func([]int)
}

// SetForgetTabsHook wires the disconnect → controller callback. Call once during
// server setup, before serving.
func (m *WSManager) SetForgetTabsHook(fn func([]int)) {
	m.onForgetTabs = fn
}

// NewWSManager 创建新的 WebSocket 管理器。allowedOrigins 是用户显式配置的
// Origin 白名单（除自动放行的 chrome-extension:// 与 127.0.0.1/localhost 之外）。
func NewWSManager(allowedOrigins []string) *WSManager {
	return &WSManager{
		clients:        make(map[*clientConn]bool),
		tabOwners:      make(map[int]string),
		done:           make(chan struct{}),
		allowedOrigins: append([]string(nil), allowedOrigins...),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			// The content script opens this WS from inside the AI page, so the
			// browser forces Origin to that page's https origin (e.g.
			// https://chat.qwen.ai) — NOT chrome-extension://. The set of such
			// origins is exactly the extension's host_permissions and grows every
			// time a platform is added, so the server cannot enumerate them
			// without duplicating the manifest; gating on an allowlist here would
			// reject every legitimate AI-page connection (verified: a real Qwen
			// content script got a 403). The per-launch bearer token in the query
			// string is therefore the authoritative auth for /ws (server binds
			// 127.0.0.1 only). We intentionally accept any Origin and rely on the
			// token. allowedOrigins still governs the CORS middleware for the HTTP
			// routes; it is deliberately NOT applied to the WS upgrade.
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

// RegisterWithMeta registers a connection and returns the client id it was
// actually assigned. The returned id may differ from meta.ID when the requested
// id was empty or already in use (#3) — callers MUST use the returned id for any
// later directed routing (worker bind, per-client messages), not the value they
// passed in.
func (m *WSManager) RegisterWithMeta(conn *websocket.Conn, meta WSClientMeta) string {
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
		client:    strings.TrimSpace(meta.Client),
		role:      strings.TrimSpace(meta.Role),
		provider:  normalizeProvider(meta.Provider),
		connected: meta.Connected,
	}
	// Assign the id and insert under ONE lock so two simultaneous registrations
	// can't both pass a separate "is it free?" check and end up sharing an id.
	m.clientsMu.Lock()
	cc.id = m.uniqueIDLocked(strings.TrimSpace(meta.ID))
	m.clients[cc] = true
	m.clientsMu.Unlock()
	go m.writePump(cc)
	return cc.id
}

// genClientID returns a fresh, collision-resistant server-side client id.
func genClientID() string {
	return fmt.Sprintf("ws_%d_%d", time.Now().UnixNano(), wsFallbackSeq.Add(1))
}

// idInUseLocked reports whether a live connection already holds id. Caller holds
// clientsMu (read or write).
func (m *WSManager) idInUseLocked(id string) bool {
	for cc := range m.clients {
		if cc.id == id {
			return true
		}
	}
	return false
}

// uniqueIDLocked returns the id a newly registering client should be given. An
// empty id, or one already held by a live connection, is replaced with a fresh
// generated id so no two connections ever share an id (which would let SendToID
// fan directed traffic to an eavesdropper — #3). A unique client-supplied id is
// honored unchanged (content scripts supply their own high-entropy per-document
// id, which the worker-binding/conversation routing relies on). Caller holds
// clientsMu for writing.
func (m *WSManager) uniqueIDLocked(requested string) string {
	if requested != "" && !m.idInUseLocked(requested) {
		return requested
	}
	for {
		candidate := genClientID()
		if !m.idInUseLocked(candidate) {
			return candidate
		}
	}
}

// assignClientID is the lock-taking wrapper used by tests and any non-register
// caller that needs to preview the id assignment.
func (m *WSManager) assignClientID(requested string) string {
	m.clientsMu.Lock()
	defer m.clientsMu.Unlock()
	return m.uniqueIDLocked(strings.TrimSpace(requested))
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
	var goneID string
	m.clientsMu.Lock()
	for cc := range m.clients {
		if cc.conn == conn {
			goneID = cc.id
			delete(m.clients, cc)
			cc.close()
			break
		}
	}
	m.clientsMu.Unlock()
	m.forgetClientTabs(goneID)
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

// ── Tab ownership (multi-browser routing) ───────────────────────────────────

// RecordTabOwner remembers which browser-relay client hosts a tab. Called when
// listTabs / browser_event reveals a tab on a given source client.
func (m *WSManager) RecordTabOwner(clientID string, tabID int) {
	clientID = strings.TrimSpace(clientID)
	if clientID == "" || tabID <= 0 {
		return
	}
	m.tabOwnersMu.Lock()
	m.tabOwners[tabID] = clientID
	m.tabOwnersMu.Unlock()
}

// ForgetTab drops a tab's ownership (tab closed).
func (m *WSManager) ForgetTab(tabID int) {
	if tabID <= 0 {
		return
	}
	m.tabOwnersMu.Lock()
	delete(m.tabOwners, tabID)
	m.tabOwnersMu.Unlock()
}

// forgetClientTabs drops every tab owned by a disconnected client.
func (m *WSManager) forgetClientTabs(clientID string) {
	if clientID == "" {
		return
	}
	var gone []int
	m.tabOwnersMu.Lock()
	for tabID, owner := range m.tabOwners {
		if owner == clientID {
			delete(m.tabOwners, tabID)
			gone = append(gone, tabID)
		}
	}
	m.tabOwnersMu.Unlock()
	// Notify the controller OUTSIDE the tabOwners lock (avoids any lock-ordering
	// coupling with the tab registry) so a default tab hosted by the now-gone
	// browser is cleared and the next tabId-less call auto-creates instead of
	// failing "No tab with id" forever against a dead cached default.
	if len(gone) > 0 && m.onForgetTabs != nil {
		m.onForgetTabs(gone)
	}
}

// tabOwner returns the client id hosting tabID, if known.
func (m *WSManager) tabOwner(tabID int) (string, bool) {
	if tabID <= 0 {
		return "", false
	}
	m.tabOwnersMu.RLock()
	owner, ok := m.tabOwners[tabID]
	m.tabOwnersMu.RUnlock()
	return owner, ok
}

// BrowserRelayIDs returns the client ids of every connected browser-relay.
func (m *WSManager) BrowserRelayIDs() []string {
	m.clientsMu.RLock()
	defer m.clientsMu.RUnlock()
	ids := make([]string, 0, len(m.clients))
	for cc := range m.clients {
		if cc.role == "browser-relay" {
			ids = append(ids, cc.id)
		}
	}
	return ids
}

// SendBrowserCommand routes a browser command payload. When tabID is known and
// its owning browser is connected, the command goes ONLY to that browser —
// otherwise it broadcasts to every browser-relay (single-browser case, or a tab
// whose owner we haven't learned yet). Returns whether at least one client got
// it, and whether the send was owner-targeted (callers may relax first-result
// races when targeted).
func (m *WSManager) SendBrowserCommand(tabID *int, message []byte) (sent bool, targeted bool) {
	if tabID != nil {
		if owner, ok := m.tabOwner(*tabID); ok {
			if m.SendToID(owner, message) {
				return true, true
			}
			// Owner vanished mid-flight; fall through to broadcast.
			m.ForgetTab(*tabID)
		}
	}
	return m.SendToRole("browser-relay", message), false
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
	removed := false
	if _, ok := m.clients[cc]; ok {
		delete(m.clients, cc)
		cc.close()
		removed = true
	}
	m.clientsMu.Unlock()
	if removed {
		m.forgetClientTabs(cc.id)
	}
}

func (cc *clientConn) close() {
	cc.closeOnce.Do(func() {
		close(cc.send)
		if cc.conn != nil {
			_ = cc.conn.Close()
		}
	})
}
