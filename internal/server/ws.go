package server

import (
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

// clientConn 包装单个 WebSocket 连接，带写锁
type clientConn struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

// WSManager 管理所有 WebSocket 连接
type WSManager struct {
	clients   map[*clientConn]bool
	clientsMu sync.RWMutex
	upgrader  websocket.Upgrader
	broadcast chan []byte
	done      chan struct{}
	closeOnce sync.Once
}

// NewWSManager 创建新的 WebSocket 管理器
func NewWSManager() *WSManager {
	return &WSManager{
		clients:   make(map[*clientConn]bool),
		broadcast: make(chan []byte, 100),
		done:      make(chan struct{}),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			// 允许所有来源连接（开发环境），生产环境应校验 Origin
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

// Upgrade 升级 HTTP 连接到 WebSocket
func (m *WSManager) Upgrade(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	return m.upgrader.Upgrade(w, r, nil)
}

// Register 注册新的客户端连接
func (m *WSManager) Register(conn *websocket.Conn) {
	cc := &clientConn{conn: conn}
	m.clientsMu.Lock()
	m.clients[cc] = true
	m.clientsMu.Unlock()
}

// ClientCount returns the number of currently connected browser extensions.
func (m *WSManager) ClientCount() int {
	m.clientsMu.RLock()
	defer m.clientsMu.RUnlock()
	return len(m.clients)
}

// Unregister 移除客户端连接
func (m *WSManager) Unregister(conn *websocket.Conn) {
	m.clientsMu.Lock()
	for cc := range m.clients {
		if cc.conn == conn {
			delete(m.clients, cc)
			cc.conn.Close()
			break
		}
	}
	m.clientsMu.Unlock()
}

// Broadcast 广播消息给所有连接的客户端（串行写入每个连接）
func (m *WSManager) Broadcast(message []byte) {
	m.clientsMu.RLock()
	clients := make([]*clientConn, 0, len(m.clients))
	for cc := range m.clients {
		clients = append(clients, cc)
	}
	m.clientsMu.RUnlock()

	var failed []*clientConn
	for _, cc := range clients {
		cc.mu.Lock()
		err := cc.conn.WriteMessage(websocket.TextMessage, message)
		cc.mu.Unlock()
		if err != nil {
			failed = append(failed, cc)
		}
	}
	if len(failed) > 0 {
		m.clientsMu.Lock()
		for _, cc := range failed {
			delete(m.clients, cc)
			cc.conn.Close()
		}
		m.clientsMu.Unlock()
	}
}

// Start 启动广播循环（从 channel 读取并广播）
func (m *WSManager) Start() {
	go func() {
		for {
			select {
			case msg, ok := <-m.broadcast:
				if !ok {
					return
				}
				m.Broadcast(msg)
			case <-m.done:
				return
			}
		}
	}()
}

// Close 关闭广播循环并断开所有客户端
func (m *WSManager) Close() {
	m.closeOnce.Do(func() {
		close(m.done)
		m.clientsMu.Lock()
		for cc := range m.clients {
			cc.conn.Close()
			delete(m.clients, cc)
		}
		m.clientsMu.Unlock()
	})
}

// Send 发送消息到广播队列（非阻塞）
func (m *WSManager) Send(message []byte) {
	select {
	case m.broadcast <- message:
	default:
		// 队列满时丢弃，避免阻塞主流程
	}
}
