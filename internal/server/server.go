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

	"github.com/afumu/openlink/internal/executor"
	"github.com/afumu/openlink/internal/prompt"
	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/skill"
	"github.com/afumu/openlink/internal/tui"
	"github.com/afumu/openlink/internal/types"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

type Server struct {
	config   *types.Config
	router   *gin.Engine
	executor *executor.Executor
	ws       *WSManager // WebSocket 管理器
	logger   *tui.Logger
}

func New(config *types.Config) *Server {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery())

	ws := NewWSManager()
	ws.Start()

	s := &Server{
		config:   config,
		router:   router,
		executor: executor.New(config),
		ws:       ws,
	}

	s.setupRoutes()
	return s
}

func (s *Server) setupRoutes() {
	s.router.Use(func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	s.router.Use(security.AuthMiddleware(s.config.Token))

	s.router.GET("/health", s.handleHealth)
	s.router.GET("/auth", s.handleAuth)
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
}

func (s *Server) handleHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":  "ok",
		"dir":     s.config.GetRootDir(),
		"version": "1.0.0",
	})
}

func (s *Server) handleAuth(c *gin.Context) {
	// 兼容 GET Query 参数和 POST JSON Body
	token := c.Query("token")
	if token == "" {
		var req struct {
			Token string `json:"token"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			if !errors.Is(err, io.EOF) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON"})
				return
			}
		} else {
			token = req.Token
		}
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
	content, err := os.ReadFile(filepath.Join(rootDir, "prompts", "init_prompt.txt"))
	if err != nil {
		if len(s.config.DefaultPrompt) == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "init_prompt.txt not found"})
			return
		}
		content = s.config.DefaultPrompt
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

	content = append(content, []byte("\n\n初始化回复：\n你好，我是 openlink，请问有什么可以帮你？")...)

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
	log.Println("[OpenLink] 收到 /exec 请求")

	var req types.ToolRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("[OpenLink] ❌ JSON 解析失败: %v\n", err)
		c.JSON(http.StatusBadRequest, types.ToolResponse{
			Status: "error",
			Error:  err.Error(),
		})
		return
	}

	log.Printf("[OpenLink] 工具调用: name=%s, call_id=%s, args=%+v\n", req.Name, req.CallID, req.Args)

	// 修复 AI 模型将换行符误写为 \t 的情况（仅对 edit 工具的字符串参数）
	if req.Name == "edit" {
		for _, key := range []string{"old_string", "new_string"} {
			if v, ok := req.Args[key].(string); ok {
				req.Args[key] = fixTabNewlines(v)
			}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(s.config.Timeout)*time.Second)
	defer cancel()
	resp := s.executor.Execute(ctx, &req)

	log.Printf("[OpenLink] 执行结果: status=%s, output长度=%d\n", resp.Status, len(resp.Output))
	if resp.Error != "" {
		log.Printf("[OpenLink] 错误信息: %s\n", resp.Error)
	}

	c.JSON(http.StatusOK, resp)
	log.Println("[OpenLink] 响应已发送")
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

	log.Printf("[OpenLink] 收到 TUI 注入输入: %q\n", req.Text)

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
		log.Printf("[OpenLink] ❌ WebSocket 升级失败: %v\n", err)
		return
	}
	log.Println("[OpenLink] ✅ 扩展已连接 WebSocket")

	s.ws.Register(conn)
	s.logTUI("system", "BROWSER", "success", fmt.Sprintf("浏览器扩展已连接 (%d)", s.ws.ClientCount()))
	defer func() {
		s.ws.Unregister(conn)
		s.logTUI("system", "BROWSER", "info", fmt.Sprintf("浏览器扩展已断开 (%d)", s.ws.ClientCount()))
	}()

	// 保持连接，处理可能的客户端消息（目前仅广播，不处理客户端发送）
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("[OpenLink] ⚠️ WebSocket 连接异常: %v\n", err)
			}
			break
		}
	}
}

func (s *Server) Run() error {
	return s.router.Run(fmt.Sprintf("127.0.0.1:%d", s.config.Port))
}

func (s *Server) Close() {
	if s.ws != nil {
		s.ws.Close()
	}
}

// SetTUILogger allows injecting a TUI logger for real-time monitoring
func (s *Server) SetTUILogger(logger *tui.Logger) {
	s.logger = logger
	s.executor.SetLogger(logger)
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
