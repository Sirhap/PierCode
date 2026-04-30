package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"

	"github.com/afumu/openlink/internal/portutil"
	"github.com/afumu/openlink/internal/security"
	"github.com/afumu/openlink/internal/server"
	"github.com/afumu/openlink/internal/tui"
	"github.com/afumu/openlink/internal/types"
	"github.com/afumu/openlink/prompts"
	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	cwd, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}
	dir := flag.String("dir", cwd, "工作目录")
	port := flag.Int("port", 39527, "端口")
	timeout := flag.Int("timeout", 60, "超时(秒)")
	flag.Parse()

	addr := fmt.Sprintf("127.0.0.1:%d", *port)

	// 检测端口是否已被占用，若占用则自动杀掉旧进程
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Printf("端口 %d 已被占用，正在尝试终止占用进程...\n", *port)
		if killed := portutil.KillPortProcess(*port); killed {
			fmt.Printf("✅ 已终止旧进程，重新检测端口...\n")
			ln, err = net.Listen("tcp", addr)
			if err != nil {
				fmt.Printf("❌ 端口仍被占用，请手动处理或使用 -port 指定其他端口\n")
				os.Exit(1)
			}
		} else {
			fmt.Printf("❌ 无法终止占用进程，请手动处理或使用 -port 指定其他端口\n")
			os.Exit(1)
		}
	}
	ln.Close()

	token, err := security.LoadOrCreateToken()
	if err != nil {
		log.Fatal(err)
	}

	config := &types.Config{
		RootDir:        *dir,
		InitialRootDir: *dir,
		Port:           *port,
		Timeout:        *timeout,
		Token:          token,
		DefaultPrompt:  prompts.DefaultPrompt,
	}
	log.SetOutput(io.Discard)

	// 创建 TUI 模型
	// TODO: 后续可从配置或环境变量读取实际的 AI 服务商
	aiProvider := "OpenAI / Claude / Local"
	model := tui.NewModel(*port, *dir, aiProvider, token)
	program := tea.NewProgram(model, tea.WithAltScreen(), tea.WithMouseCellMotion())

	// 创建 TUI Logger
	tuiLogger := tui.NewLogger(program)

	// 启动后端服务（在后台 goroutine 中）
	go func() {
		srv := server.New(config)
		srv.SetTUILogger(tuiLogger)
		tuiLogger.LogStatus("running")
		tuiLogger.Printf("认证 URL: http://127.0.0.1:%d/auth?token=%s", *port, token)

		if err := srv.Run(); err != nil {
			tuiLogger.Printf("服务器运行出错: %v", err)
			program.Quit()
		}
	}()

	// 运行 TUI（阻塞直到退出）
	if _, err := program.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error running TUI: %v\n", err)
		os.Exit(1)
	}
}
