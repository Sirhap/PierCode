package server

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/sirhap/piercode/internal/browser"
	"github.com/sirhap/piercode/internal/executor"
	"github.com/sirhap/piercode/internal/logsink"
	"github.com/sirhap/piercode/internal/prompt"
	"github.com/sirhap/piercode/internal/security"
	"github.com/sirhap/piercode/internal/skill"
	"github.com/sirhap/piercode/internal/tool"
	"github.com/sirhap/piercode/internal/types"
	"github.com/sirhap/piercode/internal/version"
)

type Server struct {
	config   *types.Config
	router   *gin.Engine
	executor *executor.Executor
	ws       *WSManager // WebSocket 管理器
	browser  *browser.Controller
	logger   logsink.Sink

	// Unsubscribe handles for the TUI-level chunk/done subscribers registered
	// in SetLogSink. We call them before re-subscribing so repeated
	// SetLogSink calls don't fan every chunk out N times.
	tuiUnsubChunk func()
	tuiUnsubDone  func()
}

func New(config *types.Config) *Server {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery())

	ws := NewWSManager(config.AllowedOrigins)
	ws.Start()

	s := &Server{
		config:   config,
		router:   router,
		executor: executor.New(config),
		ws:       ws,
	}
	relay := browser.NewRelayManager(func(payload []byte) bool {
		return ws.SendToRole("browser-relay", payload)
	})
	s.browser = browser.NewController(relay, func(payload []byte) {
		ws.Send(payload)
	})
	s.executor.SetBrowserController(s.browser)

	// Tools (currently just `question`) can push arbitrary WS payloads via
	// the executor's broadcaster. Wiring it here keeps the WSManager out of
	// the tool layer.
	s.executor.SetBroadcaster(func(payload []byte) {
		s.ws.Send(payload)
	})
	s.executor.SetClientBroadcaster(func(clientID string, payload []byte) bool {
		return s.ws.SendToID(clientID, payload)
	})

	// Wire background task events into the WebSocket broadcast channel so any
	// connected extension / TUI sees live stdout and completion notices.
	if tm := s.executor.Tasks(); tm != nil {
		tm.SubscribeChunks(func(taskID, callID, stream, text string) {
			clientID := tm.SourceClientID(taskID)
			payload, err := json.Marshal(gin.H{
				"type":      "tool_stream",
				"task_id":   taskID,
				"call_id":   callID,
				"client_id": clientID,
				"stream":    stream,
				"text":      text,
			})
			if err == nil {
				if clientID != "" {
					s.ws.SendToID(clientID, payload)
				} else {
					s.ws.Send(payload)
				}
			}
		})
		tm.SubscribeDone(func(taskID, callID string, exitCode int, status string, errMsg string, durationMs int64) {
			clientID := tm.SourceClientID(taskID)
			payload, err := json.Marshal(gin.H{
				"type":        "tool_done",
				"task_id":     taskID,
				"call_id":     callID,
				"client_id":   clientID,
				"exit_code":   exitCode,
				"status":      status,
				"error":       errMsg,
				"duration_ms": durationMs,
			})
			if err == nil {
				if clientID != "" {
					s.ws.SendToID(clientID, payload)
				} else {
					s.ws.Send(payload)
				}
			}
		})
	}

	s.setupRoutes()
	return s
}

func (s *Server) setupRoutes() {
	s.router.Use(func(c *gin.Context) {
		// WebSocket upgrade requests carry the Origin of the page that
		// created the socket (e.g. https://chatgpt.com). CORS rules don't
		// apply to WS the same way as fetch/XHR; the token in the query
		// string already authenticates the connection, and the upgrader
		// has its own CheckOrigin. Skip CORS entirely for /ws so that
		// content scripts running inside AI pages can connect.
		if c.Request.URL.Path == "/ws" {
			c.Next()
			return
		}

		origin := c.Request.Header.Get("Origin")
		// 同源请求 / 非浏览器调用（curl、Go test）不带 Origin，直接放行；其余
		// Origin 必须命中白名单（chrome-extension:// / 本地回环 / 用户配置）。
		// 这避免任何随机网站凭借浏览器自带 cookie / token 跨站打到 /exec。
		if origin != "" && IsAllowedOrigin(origin, s.config.AllowedOrigins) {
			c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
			c.Writer.Header().Set("Vary", "Origin")
			c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
			c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		} else if origin != "" {
			// Origin 不在白名单：preflight 直接 403，业务请求也阻断。
			if c.Request.Method == "OPTIONS" {
				c.AbortWithStatus(http.StatusForbidden)
				return
			}
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "origin not allowed"})
			return
		}
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	s.router.Use(security.AuthMiddleware(s.config.Token))

	s.router.GET("/health", s.handleHealth)
	// /auth 仅保留 POST：GET ?token=... 会让 token 进浏览器历史 / 反向代理日志，
	// 长期凭据不能这样暴露。WS 仍允许 query 是一次性接受 + 立即升级。
	s.router.POST("/auth", s.handleAuth)
	s.router.GET("/config", s.handleConfig)
	s.router.POST("/config", s.handleUpdateConfig)
	s.router.POST("/cwd", s.handleSetCWD)
	s.router.GET("/tools", s.handleListTools)
	s.router.POST("/exec", s.handleExec)
	s.router.POST("/inject", s.handleInject)
	s.router.GET("/ws", s.handleWS) // WebSocket 连接端点
	s.router.GET("/prompt", s.handlePrompt)
	s.router.GET("/stats", s.handleStats)
	s.router.GET("/skills", s.handleListSkills)
	s.router.GET("/files", s.handleListFiles)
	s.router.GET("/attachments/screenshot", s.handleScreenshotAttachment)
	s.router.GET("/tasks", s.handleListTasks)
	s.router.GET("/tasks/:id", s.handleGetTask)
	s.router.POST("/tasks/:id/stop", s.handleStopTask)
	s.router.POST("/question_answer", s.handleQuestionAnswer)
}

func (s *Server) handleHealth(c *gin.Context) {
	// /health 不鉴权；只能返回最少信息。早期版本会回 dir（绝对路径），
	// 任何本机进程或恶意网页都能借此做侦察 + 定向攻击，已移除。
	c.JSON(http.StatusOK, gin.H{
		"status":  "ok",
		"version": version.Version,
	})
}

func (s *Server) handleAuth(c *gin.Context) {
	// 仅接受 POST JSON 体；不再支持 GET ?token=...，避免 token 进浏览器历史或代理日志。
	var req struct {
		Token string `json:"token"`
	}
	token := ""
	if err := c.ShouldBindJSON(&req); err != nil {
		if !errors.Is(err, io.EOF) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON"})
			return
		}
	} else {
		token = req.Token
	}

	token = strings.TrimSpace(token)
	valid := len(token) == len(s.config.Token) && token != "" &&
		subtle.ConstantTimeCompare([]byte(token), []byte(s.config.Token)) == 1

	resp := gin.H{"valid": valid}
	if !valid {
		resp["reason"] = "token_mismatch"
		if token == "" {
			resp["reason"] = "missing_token"
		}
	}
	c.JSON(http.StatusOK, resp)
}

func (s *Server) handleConfig(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"rootDir":               s.config.GetRootDir(),
		"additionalAllowedDirs": s.config.GetAdditionalAllowedDirs(),
		"permissionMode":        s.config.GetPermissionMode(),
		"timeout":               s.config.Timeout,
	})
}

func (s *Server) handleUpdateConfig(c *gin.Context) {
	var req struct {
		PermissionMode string `json:"permissionMode"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	mode := strings.TrimSpace(req.PermissionMode)
	if mode == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "permissionMode is required"})
		return
	}
	if types.NormalizePermissionMode(mode) != mode {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid permissionMode"})
		return
	}
	s.config.SetPermissionMode(mode)
	c.JSON(http.StatusOK, gin.H{"permissionMode": mode})
}

func (s *Server) handleStats(c *gin.Context) {
	totalTasks, runningTasks := 0, 0
	if s.executor != nil {
		if tm := s.executor.Tasks(); tm != nil {
			for _, t := range tm.List() {
				totalTasks++
				if t.Status == "running" {
					runningTasks++
				}
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"browser_clients":   s.ws.ClientCount(),
		"browser_relays":    s.ws.RoleCount("browser-relay"),
		"browser_providers": s.ws.ProviderCounts(),
		"tasks_total":       totalTasks,
		"tasks_running":     runningTasks,
	})
}

func (s *Server) handlePrompt(c *gin.Context) {
	rootDir := s.config.GetRootDir()
	// 早期版本会优先读 <rootDir>/prompts/init_prompt.txt，但该路径在 sandbox
	// 内、AI 通过 write_file 即可改写，等于把系统提示词控制权交给 AI。
	// 改为只信任二进制内嵌的 DefaultPrompt（prompts/prompts.go 通过 //go:embed
	// 提供），AI 无法改动。
	profile := s.resolveAIProfile(c)
	content := profile.Prompt
	if len(content) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "init prompt not embedded"})
		return
	}
	content = profile.RenderWithSandbox(rootDir, s.config.GetPermissionMode(), s.config.GetAdditionalAllowedDirs(), s.executor.ListTools(), skill.LoadInfos(rootDir))

	c.String(http.StatusOK, string(content))
}

func (s *Server) resolveAIProfile(c *gin.Context) prompt.Profile {
	profileID := c.Query("profile")
	if profileID == "" {
		profileID = c.Query("adapter")
	}
	return s.executor.ResolveProfile(profileID)
}

func (s *Server) handleSetCWD(c *gin.Context) {
	var req struct {
		Path string `json:"path" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}

	path := strings.TrimSpace(req.Path)
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is required"})
		return
	}
	if strings.HasPrefix(path, "~") {
		home, err := os.UserHomeDir()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if path == "~" {
			path = home
		} else if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
			path = filepath.Join(home, path[2:])
		}
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(s.config.GetRootDir(), path)
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Restrict /cwd to subdirectories of the initial startup RootDir or an
	// explicitly added directory. Use real paths so symlinks or junctions under
	// an allowed root cannot escape it.
	initialRoot := s.config.InitialRootDir
	if initialRoot == "" {
		initialRoot = s.config.GetRootDir()
	}
	allowedRoots := append([]string{initialRoot}, s.config.GetAdditionalAllowedDirs()...)
	if s.config.GetPermissionMode() == "auto" {
		parent := filepath.Dir(initialRoot)
		if parent != initialRoot && filepath.Dir(parent) != parent {
			allowedRoots = append(allowedRoots, parent)
		}
	}
	if s.config.GetPermissionMode() != "unrestricted" && len(allowedRoots) > 0 {
		safePath, err := security.SafeAbsPath(absPath, allowedRoots...)
		if err != nil {
			c.JSON(http.StatusForbidden, gin.H{"error": "path must be within an allowed working directory"})
			return
		}
		absPath = safePath
	}

	info, err := os.Stat(absPath)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is not a directory"})
		return
	}

	s.config.SetRootDir(absPath)
	c.JSON(http.StatusOK, gin.H{"rootDir": absPath})
}

func (s *Server) handleListTools(c *gin.Context) {
	tools := s.resolveAIProfile(c).FilterTools(s.executor.ListTools())
	c.JSON(http.StatusOK, gin.H{"tools": tools})
}

func (s *Server) handleExec(c *gin.Context) {
	log.Println("[PierCode] 收到 /exec 请求")

	var req types.ToolRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("[PierCode] ❌ JSON 解析失败: %v\n", err)
		c.JSON(http.StatusBadRequest, types.ToolResponse{
			Status: "error",
			Error:  err.Error(),
		})
		return
	}

	log.Printf("[PierCode] 工具调用: name=%s, call_id=%s, args=%+v\n", req.Name, req.CallID, req.Args)

	// The standard /exec timeout is fine for filesystem/shell tools, but
	// `question` legitimately blocks waiting for a human and would always
	// hit the deadline. Give it the per-call timeout it advertises (or the
	// 5-minute default the tool uses internally) plus a small grace window.
	execTimeout := time.Duration(s.config.Timeout) * time.Second
	if strings.EqualFold(req.Name, "question") {
		execTimeout = 6 * time.Minute
		if v, ok := req.Args["timeout_sec"].(float64); ok && v > 0 {
			execTimeout = time.Duration(v*float64(time.Second)) + 30*time.Second
		}
	} else if strings.HasPrefix(strings.ToLower(req.Name), "browser_") {
		execTimeout = 6 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), execTimeout)
	defer cancel()

	// Streaming bridge: every stdout/stderr chunk produced by a streaming
	// tool (currently only exec_cmd) is broadcast over WebSocket so any
	// connected extension can render it live in the corresponding ToolCard.
	streamer := func(stream, text string) {
		payload, err := json.Marshal(gin.H{
			"type":      "tool_stream",
			"call_id":   req.CallID,
			"client_id": req.SourceClientID,
			"stream":    stream,
			"text":      text,
		})
		if err == nil {
			if req.SourceClientID != "" {
				s.ws.SendToID(req.SourceClientID, payload)
			} else {
				s.ws.Send(payload)
			}
		}
	}
	resp := s.executor.ExecuteWithStream(ctx, &req, streamer)

	log.Printf("[PierCode] 执行结果: status=%s, output长度=%d\n", resp.Status, len(resp.Output))
	if resp.Error != "" {
		log.Printf("[PierCode] 错误信息: %s\n", resp.Error)
	}

	c.JSON(http.StatusOK, resp)
	log.Println("[PierCode] 响应已发送")
}

// handleInject 接收 TUI 输入并通过 WebSocket 广播给所有连接的扩展
func (s *Server) handleInject(c *gin.Context) {
	var req struct {
		Text string `json:"text" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}

	log.Printf("[PierCode] 收到 TUI 注入输入: %q\n", req.Text)

	// 通过 WebSocket 广播给所有连接的扩展客户端
	msg, err := json.Marshal(gin.H{"type": "inject", "text": req.Text})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid message"})
		return
	}
	clients := s.ws.ClientCount()
	s.ws.Send(msg)

	c.JSON(http.StatusOK, gin.H{"status": "injected", "text": req.Text, "clients": clients})
}

// handleWS 处理 WebSocket 连接请求（供浏览器扩展连接）
func (s *Server) handleWS(c *gin.Context) {
	conn, err := s.ws.Upgrade(c.Writer, c.Request)
	if err != nil {
		log.Printf("[PierCode] ❌ WebSocket 升级失败: %v\n", err)
		return
	}
	log.Println("[PierCode] ✅ 扩展已连接 WebSocket")

	provider := browserProviderFromRequest(c.Request)
	id := strings.TrimSpace(c.Query("id"))
	role := strings.TrimSpace(c.Query("role"))
	client := strings.TrimSpace(c.Query("client"))
	s.ws.RegisterWithMeta(conn, WSClientMeta{ID: id, Provider: provider, Role: role, Client: client})
	count := s.ws.ClientCount()
	s.logTUI("system", "BROWSER", "success", fmt.Sprintf("浏览器扩展已连接 (%d)", count))
	if s.logger != nil {
		s.logger.LogBrowserStatus(count, s.ws.ProviderCounts())
	}
	defer func() {
		s.ws.Unregister(conn)
		count := s.ws.ClientCount()
		s.logTUI("system", "BROWSER", "info", fmt.Sprintf("浏览器扩展已断开 (%d)", count))
		if s.logger != nil {
			s.logger.LogBrowserStatus(count, s.ws.ProviderCounts())
		}
	}()

	// 设置读超时，检测 MV3 service worker 休眠后的僵死连接。
	// 扩展每 20 秒发送 browser_ping，60 秒超时 = 3 倍 ping 间隔。
	_ = conn.SetReadDeadline(time.Now().Add(wsReadTimeout))

	// 保持连接，处理可能的客户端消息（目前仅广播，不处理客户端发送）
	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("[PierCode] ⚠️ WebSocket 连接异常: %v\n", err)
			}
			break
		}
		// 每次收到消息后刷新读超时
		_ = conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
		s.handleWSClientMessage(payload)
	}
}

func browserProviderFromRequest(r *http.Request) string {
	provider := strings.TrimSpace(r.URL.Query().Get("provider"))
	if provider != "" {
		return provider
	}
	host := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("host")))
	switch {
	case strings.Contains(host, "qwen.ai"), strings.Contains(host, "qwenlm.ai"):
		return "Qwen"
	case strings.Contains(host, "claude.ai"):
		return "Claude"
	case strings.Contains(host, "chatgpt.com"), strings.Contains(host, "chat.openai.com"):
		return "ChatGPT"
	case strings.Contains(host, "gemini.google.com"):
		return "Gemini"
	case strings.Contains(host, "aistudio.google.com"):
		return "AI Studio"
	case strings.Contains(host, "kimi.com"):
		return "Kimi"
	case strings.Contains(host, "chat.z.ai"):
		return "Z.ai"
	default:
		return "Browser"
	}
}

func (s *Server) handleWSClientMessage(payload []byte) {
	var msg struct {
		Type       string          `json:"type"`
		Key        string          `json:"key"`
		Text       string          `json:"text"`
		CallID     string          `json:"call_id"`
		Answer     string          `json:"answer"`
		Reason     string          `json:"reason"`
		ID         string          `json:"id"`
		Success    bool            `json:"success"`
		Data       json.RawMessage `json:"data"`
		Error      string          `json:"error"`
		ApprovalID string          `json:"approval_id"`
		Approved   bool            `json:"approved"`
		OK         bool            `json:"ok"`
		Event      string          `json:"event"`
		TabID      int             `json:"tabId"`
		URL        string          `json:"url"`
		Title      string          `json:"title"`
		Params     json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}
	switch msg.Type {
	case "user_log":
		text := strings.TrimSpace(msg.Text)
		if text == "" {
			return
		}
		if s.logger != nil {
			key := strings.TrimSpace(msg.Key)
			if key == "" {
				key = "browser-user-prompt"
			}
			s.logger.LogUserPrompt(key, text)
		}
	case "ai_log":
		text := strings.TrimSpace(msg.Text)
		if text == "" {
			return
		}
		if s.logger != nil {
			key := strings.TrimSpace(msg.Key)
			if key == "" {
				key = "browser-ai-response"
			}
			s.logger.LogAIResponse(key, summarizeBrowserAIText(text), text)
		}
	case "question_answer":
		callID := strings.TrimSpace(msg.CallID)
		if callID == "" {
			return
		}
		tool.PendingQuestions.Deliver(callID, msg.Answer)
	case "question_cancel":
		callID := strings.TrimSpace(msg.CallID)
		if callID == "" {
			return
		}
		tool.PendingQuestions.Cancel(callID, msg.Reason)
	case "browser_result":
		if s.browser != nil {
			s.browser.DeliverResult(browser.Result{
				Type:    msg.Type,
				ID:      msg.ID,
				Success: msg.Success,
				Data:    msg.Data,
				Error:   msg.Error,
			})
		}
	case "browser_approval_answer":
		if s.browser != nil {
			s.browser.DeliverApproval(browser.ApprovalAnswer{
				Type:       msg.Type,
				ApprovalID: msg.ApprovalID,
				Approved:   msg.Approved,
				Reason:     msg.Reason,
			})
		}
	case "browser_attachment_upload_result":
		tool.PendingAttachmentUploads.Deliver(msg.CallID, tool.AttachmentUploadResult{
			OK:    msg.OK,
			Error: msg.Error,
		})
	case "browser_event":
		if s.browser != nil {
			s.browser.HandleEvent(browser.Event{
				Type:   msg.Type,
				Event:  msg.Event,
				TabID:  msg.TabID,
				Reason: msg.Reason,
				URL:    msg.URL,
				Title:  msg.Title,
				Params: msg.Params,
			})
		}
	case "browser_ping", "browser_hello":
		return
	}
}

func summarizeBrowserAIText(text string) string {
	const maxLines = 50
	text = summarizeBrowserToolCalls(text)
	lines := strings.Split(strings.ReplaceAll(strings.TrimSpace(text), "\r\n", "\n"), "\n")
	if len(lines) <= maxLines {
		return strings.TrimSpace(text)
	}
	return strings.Join(lines[:maxLines], "\n") + fmt.Sprintf("\n… +%d lines (Ctrl+T 查看完整)", len(lines)-maxLines)
}

var (
	browserToolFenceRE = regexp.MustCompile("(?is)```(?:piercode-tool|tool)\\s*\\n([\\s\\S]*?)\\n```")
	browserXMLToolRE   = regexp.MustCompile("(?is)<tool(?:\\s[^>]*)?>[\\s\\S]*?</(?:tool|function)(?:_call)?>")
)

func summarizeBrowserToolCalls(text string) string {
	text = browserToolFenceRE.ReplaceAllStringFunc(text, func(raw string) string {
		body := ""
		if match := browserToolFenceRE.FindStringSubmatch(raw); len(match) == 2 {
			body = match[1]
		}
		return "\n" + toolCallSummary(parseToolCallJSON(body)) + "\n"
	})
	text = browserXMLToolRE.ReplaceAllStringFunc(text, func(raw string) string {
		return "\n" + toolCallSummary(toolCallInfo{
			Name:   extractXMLAttr(raw, "name"),
			CallID: extractXMLAttr(raw, "call_id"),
		}) + "\n"
	})
	return text
}

type toolCallInfo struct {
	Name   string
	CallID string
}

func parseToolCallJSON(raw string) toolCallInfo {
	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(strings.ReplaceAll(raw, "\u00a0", " ")), &payload); err != nil {
		return toolCallInfo{}
	}
	info := toolCallInfo{}
	if name, ok := payload["name"].(string); ok {
		info.Name = name
	}
	if callID, ok := payload["call_id"].(string); ok {
		info.CallID = callID
	} else if callID, ok := payload["callId"].(string); ok {
		info.CallID = callID
	}
	return info
}

func toolCallSummary(info toolCallInfo) string {
	name := strings.TrimSpace(info.Name)
	if name == "" {
		name = "tool"
	}
	if callID := strings.TrimSpace(info.CallID); callID != "" {
		return fmt.Sprintf("调用工具 %s #%s … (Ctrl+T 查看完整)", name, callID)
	}
	return fmt.Sprintf("调用工具 %s … (Ctrl+T 查看完整)", name)
}

func extractXMLAttr(raw, name string) string {
	openingTag := raw
	if end := strings.IndexByte(openingTag, '>'); end >= 0 {
		openingTag = openingTag[:end]
	}
	lower := strings.ToLower(openingTag)
	key := strings.ToLower(name) + "="
	idx := strings.Index(lower, key)
	if idx < 0 {
		return ""
	}
	rest := openingTag[idx+len(key):]
	if rest == "" {
		return ""
	}
	quote := rest[0]
	if quote != '"' && quote != '\'' {
		return ""
	}
	end := strings.IndexByte(rest[1:], quote)
	if end < 0 {
		return ""
	}
	return rest[1 : 1+end]
}

func (s *Server) Run() error {
	return s.router.Run(fmt.Sprintf("127.0.0.1:%d", s.config.Port))
}

func (s *Server) Close() {
	if s.ws != nil {
		s.ws.Close()
	}
	if s.executor != nil {
		if tm := s.executor.Tasks(); tm != nil {
			tm.Close()
		}
	}
}

// SetLogSink allows injecting an event sink for real-time monitoring.
// Safe to call multiple times: each call replaces any previously registered
// subscribers so we don't double-fan every chunk.
func (s *Server) SetLogSink(sink logsink.Sink) {
	s.logger = sink
	s.executor.SetLogger(sink)

	if s.tuiUnsubChunk != nil {
		s.tuiUnsubChunk()
		s.tuiUnsubChunk = nil
	}
	if s.tuiUnsubDone != nil {
		s.tuiUnsubDone()
		s.tuiUnsubDone = nil
	}

	if tm := s.executor.Tasks(); tm != nil && sink != nil {
		s.tuiUnsubChunk = tm.SubscribeChunks(func(taskID, callID, stream, text string) {
			sink.LogTaskStream(taskID, callID, stream, text)
		})
		s.tuiUnsubDone = tm.SubscribeDone(func(taskID, callID string, exitCode int, status string, errMsg string, durationMs int64) {
			sink.LogTaskDone(taskID, callID, exitCode, status, errMsg, durationMs)
		})
	}
}

func (s *Server) logTUI(source, toolName, status, message string) {
	if s.logger != nil {
		s.logger.LogToolCallWithSource(source, toolName, status, message)
	}
}

type skillItem struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (s *Server) handleListSkills(c *gin.Context) {
	skills := s.resolveAIProfile(c).FilterSkills(skill.LoadInfos(s.config.GetRootDir()))
	items := make([]skillItem, 0, len(skills))
	for _, sk := range skills {
		items = append(items, skillItem{Name: sk.Name, Description: sk.Description})
	}
	c.JSON(http.StatusOK, gin.H{"skills": items})
}

func (s *Server) handleListFiles(c *gin.Context) {
	q := strings.ToLower(c.Query("q"))
	if len(q) > 200 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "q too long"})
		return
	}
	rootDir := s.config.GetRootDir()
	rootReal, err := filepath.EvalSymlinks(rootDir)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid root"})
		return
	}
	skipDirs := map[string]bool{
		".git": true, "node_modules": true, ".next": true,
		"dist": true, "build": true, "vendor": true,
	}
	var files []string
	filepath.WalkDir(rootDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && skipDirs[d.Name()] {
			return filepath.SkipDir
		}
		if !d.IsDir() {
			real, err := filepath.EvalSymlinks(path)
			if err != nil {
				return nil
			}
			if !strings.HasPrefix(real, rootReal+string(filepath.Separator)) && real != rootReal {
				return nil
			}
			rel, _ := filepath.Rel(rootDir, path)
			if q == "" || strings.Contains(strings.ToLower(rel), q) {
				files = append(files, rel)
			}
		}
		if len(files) >= 50 {
			return filepath.SkipAll
		}
		return nil
	})
	c.JSON(http.StatusOK, gin.H{"files": files})
}

func (s *Server) handleScreenshotAttachment(c *gin.Context) {
	rawPath := strings.TrimSpace(c.Query("path"))
	if rawPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is required"})
		return
	}
	screenshotDir := filepath.Join(s.config.GetRootDir(), ".piercode", "screenshots")
	safePath, err := security.SafeAbsPath(rawPath, screenshotDir)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "path outside screenshot directory"})
		return
	}
	info, err := os.Stat(safePath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "screenshot not found"})
		return
	}
	if info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is a directory"})
		return
	}
	if info.Size() > 20*1024*1024 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "screenshot is too large"})
		return
	}
	data, err := os.ReadFile(safePath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read screenshot"})
		return
	}
	ext := strings.ToLower(filepath.Ext(safePath))
	mimeType := "image/jpeg"
	if ext == ".png" {
		mimeType = "image/png"
	}
	c.JSON(http.StatusOK, gin.H{
		"name":       filepath.Base(safePath),
		"mimeType":   mimeType,
		"dataBase64": base64.StdEncoding.EncodeToString(data),
		"bytes":      len(data),
	})
}

func (s *Server) handleListTasks(c *gin.Context) {
	tm := s.executor.Tasks()
	if tm == nil {
		c.JSON(http.StatusOK, gin.H{"tasks": []any{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"tasks": tm.List()})
}

func (s *Server) handleGetTask(c *gin.Context) {
	tm := s.executor.Tasks()
	if tm == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "task manager unavailable"})
		return
	}
	t := tm.Get(c.Param("id"))
	if t == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
		return
	}
	stdout, stderr := t.Output()
	snap := t.Snapshot()
	c.JSON(http.StatusOK, gin.H{
		"task":   snap,
		"stdout": stdout,
		"stderr": stderr,
	})
}

func (s *Server) handleStopTask(c *gin.Context) {
	tm := s.executor.Tasks()
	if tm == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "task manager unavailable"})
		return
	}
	err := tm.Stop(c.Param("id"))
	if err != nil {
		switch err {
		case executor.ErrTaskNotFound:
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		case executor.ErrTaskAlreadyDone:
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "stopping", "id": c.Param("id")})
}

// handleQuestionAnswer lets the TUI (or curl) deliver an answer to a pending
// question tool invocation. Mirrors the WS `question_answer` message.
func (s *Server) handleQuestionAnswer(c *gin.Context) {
	var req struct {
		CallID string `json:"call_id" binding:"required"`
		Answer string `json:"answer"`
		Cancel bool   `json:"cancel"`
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	callID := strings.TrimSpace(req.CallID)
	delivered := false
	if req.Cancel {
		delivered = tool.PendingQuestions.Cancel(callID, req.Reason)
	} else {
		delivered = tool.PendingQuestions.Deliver(callID, req.Answer)
	}
	if !delivered {
		c.JSON(http.StatusNotFound, gin.H{"error": "no pending question for call_id"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "delivered"})
}
