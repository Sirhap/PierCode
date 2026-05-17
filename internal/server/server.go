package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/executor"
	"github.com/sirhap/piercode/internal/prompt"
	"github.com/sirhap/piercode/internal/security"
	"github.com/sirhap/piercode/internal/skill"
	"github.com/sirhap/piercode/internal/tool"
	"github.com/sirhap/piercode/internal/tui"
	"github.com/sirhap/piercode/internal/types"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

type Server struct {
	config   *types.Config
	router   *gin.Engine
	executor *executor.Executor
	ws       *WSManager // WebSocket 管理器
	logger   *tui.Logger

	// Unsubscribe handles for the TUI-level chunk/done subscribers registered
	// in SetTUILogger. We call them before re-subscribing so repeated
	// SetTUILogger calls don't fan every chunk out N times.
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

	// Tools (currently just `question`) can push arbitrary WS payloads via
	// the executor's broadcaster. Wiring it here keeps the WSManager out of
	// the tool layer.
	s.executor.SetBroadcaster(func(payload []byte) {
		s.ws.Send(payload)
	})

	// Wire background task events into the WebSocket broadcast channel so any
	// connected extension / TUI sees live stdout and completion notices.
	if tm := s.executor.Tasks(); tm != nil {
		tm.SubscribeChunks(func(taskID, callID, stream, text string) {
			payload, err := json.Marshal(gin.H{
				"type":    "tool_stream",
				"task_id": taskID,
				"call_id": callID,
				"stream":  stream,
				"text":    text,
			})
			if err == nil {
				s.ws.Send(payload)
			}
		})
		tm.SubscribeDone(func(taskID, callID string, exitCode int, status string, errMsg string, durationMs int64) {
			payload, err := json.Marshal(gin.H{
				"type":        "tool_done",
				"task_id":     taskID,
				"call_id":     callID,
				"exit_code":   exitCode,
				"status":      status,
				"error":       errMsg,
				"duration_ms": durationMs,
			})
			if err == nil {
				s.ws.Send(payload)
			}
		})
	}

	s.setupRoutes()
	return s
}

func (s *Server) setupRoutes() {
	s.router.Use(func(c *gin.Context) {
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
	s.router.POST("/cwd", s.handleSetCWD)
	s.router.GET("/tools", s.handleListTools)
	s.router.POST("/exec", s.handleExec)
	s.router.POST("/inject", s.handleInject)
	s.router.GET("/ws", s.handleWS) // WebSocket 连接端点
	s.router.GET("/prompt", s.handlePrompt)
	s.router.GET("/skills", s.handleListSkills)
	s.router.GET("/files", s.handleListFiles)
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
		"version": "1.0.0",
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
		"rootDir": s.config.GetRootDir(),
		"timeout": s.config.Timeout,
	})
}

func (s *Server) handlePrompt(c *gin.Context) {
	rootDir := s.config.GetRootDir()
	// 早期版本会优先读 <rootDir>/prompts/init_prompt.txt，但该路径在 sandbox
	// 内、AI 通过 write_file 即可改写，等于把系统提示词控制权交给 AI。
	// 改为只信任二进制内嵌的 DefaultPrompt（prompts/prompts.go 通过 //go:embed
	// 提供），AI 无法改动。
	content := s.config.DefaultPrompt
	if len(content) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "init prompt not embedded"})
		return
	}
	content = prompt.Render(content, rootDir, s.executor.ListTools())

	skills := skill.LoadInfos(rootDir)
	if len(skills) > 0 {
		var sb strings.Builder
		sb.WriteString("\n\n## 当前可用 Skills\n\n")
		for _, sk := range skills {
			sb.WriteString(fmt.Sprintf("- **%s**: %s\n", sk.Name, sk.Description))
		}
		content = append(content, []byte(sb.String())...)
	}

	content = append(content, []byte("\n\n初始化回复：\n你好，我是 piercode，请问有什么可以帮你？")...)

	c.String(http.StatusOK, string(content))
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

	// Restrict /cwd to subdirectories of the initial startup RootDir. Use real
	// paths so symlinks or junctions under the workspace cannot escape it.
	initialRoot := s.config.InitialRootDir
	if initialRoot == "" {
		initialRoot = s.config.GetRootDir()
	}
	if initialRoot != "" {
		safePath, err := security.SafeAbsPath(absPath, initialRoot)
		if err != nil {
			c.JSON(http.StatusForbidden, gin.H{"error": "path must be within the initial working directory"})
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
	tools := s.executor.ListTools()
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

	// 修复 AI 模型将换行符误写为 \t 的情况（仅对 edit 工具的字符串参数）
	if req.Name == "edit" {
		for _, key := range []string{"old_string", "new_string"} {
			if v, ok := req.Args[key].(string); ok {
				req.Args[key] = fixTabNewlines(v)
			}
		}
	}

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
	}
	ctx, cancel := context.WithTimeout(context.Background(), execTimeout)
	defer cancel()

	// Streaming bridge: every stdout/stderr chunk produced by a streaming
	// tool (currently only exec_cmd) is broadcast over WebSocket so any
	// connected extension can render it live in the corresponding ToolCard.
	streamer := func(stream, text string) {
		payload, err := json.Marshal(gin.H{
			"type":    "tool_stream",
			"call_id": req.CallID,
			"stream":  stream,
			"text":    text,
		})
		if err == nil {
			s.ws.Send(payload)
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

	s.ws.Register(conn)
	s.logTUI("system", "BROWSER", "success", fmt.Sprintf("浏览器扩展已连接 (%d)", s.ws.ClientCount()))
	defer func() {
		s.ws.Unregister(conn)
		s.logTUI("system", "BROWSER", "info", fmt.Sprintf("浏览器扩展已断开 (%d)", s.ws.ClientCount()))
	}()

	// 保持连接，处理可能的客户端消息（目前仅广播，不处理客户端发送）
	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("[PierCode] ⚠️ WebSocket 连接异常: %v\n", err)
			}
			break
		}
		s.handleWSClientMessage(payload)
	}
}

func (s *Server) handleWSClientMessage(payload []byte) {
	var msg struct {
		Type   string `json:"type"`
		Key    string `json:"key"`
		Text   string `json:"text"`
		CallID string `json:"call_id"`
		Answer string `json:"answer"`
		Reason string `json:"reason"`
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
	}
}

func summarizeBrowserAIText(text string) string {
	const maxLines = 50
	lines := strings.Split(strings.ReplaceAll(strings.TrimSpace(text), "\r\n", "\n"), "\n")
	if len(lines) <= maxLines {
		return strings.TrimSpace(text)
	}
	return strings.Join(lines[:maxLines], "\n") + fmt.Sprintf("\n… +%d lines (Ctrl+T 查看完整)", len(lines)-maxLines)
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

// SetTUILogger allows injecting a TUI logger for real-time monitoring.
// Safe to call multiple times: each call replaces any previously registered
// TUI-level subscribers so we don't double-fan every chunk.
func (s *Server) SetTUILogger(logger *tui.Logger) {
	s.logger = logger
	s.executor.SetLogger(logger)

	if s.tuiUnsubChunk != nil {
		s.tuiUnsubChunk()
		s.tuiUnsubChunk = nil
	}
	if s.tuiUnsubDone != nil {
		s.tuiUnsubDone()
		s.tuiUnsubDone = nil
	}

	if tm := s.executor.Tasks(); tm != nil && logger != nil {
		s.tuiUnsubChunk = tm.SubscribeChunks(func(taskID, callID, stream, text string) {
			logger.LogTaskStream(taskID, callID, stream, text)
		})
		s.tuiUnsubDone = tm.SubscribeDone(func(taskID, callID string, exitCode int, status string, errMsg string, durationMs int64) {
			logger.LogTaskDone(taskID, callID, exitCode, status, errMsg, durationMs)
		})
	}
}

func (s *Server) logTUI(source, toolName, status, message string) {
	if s.logger != nil {
		s.logger.LogToolCallWithSource(source, toolName, status, message)
	}
}

// fixTabNewlines 修复 AI 模型将换行符误写为 \t 的情况。
// 当 old_string 里不含真正的 \n，但含有 \t 序列时，
// 尝试把行间的 \t 替换为 \n + 原有缩进。
func fixTabNewlines(s string) string {
	// 如果已经含有真正的换行符，说明 AI 输出正常，不做处理
	if strings.Contains(s, "\n") {
		return s
	}
	// 如果不含 \t，也不需要处理
	if !strings.Contains(s, "\t") {
		return s
	}
	// 把每个 \t 替换为 \n\t，模拟换行+缩进
	// 这样 "\t\t\tfoo\t\t\tbar" → "\n\t\t\tfoo\n\t\t\tbar"
	return strings.ReplaceAll(s, "\t", "\n\t")
}

type skillItem struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (s *Server) handleListSkills(c *gin.Context) {
	skills := skill.LoadInfos(s.config.GetRootDir())
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
