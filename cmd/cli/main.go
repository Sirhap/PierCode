package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strings"

	"github.com/sirhap/piercode/internal/portutil"
	"github.com/sirhap/piercode/internal/security"
	"github.com/sirhap/piercode/internal/server"
	"github.com/sirhap/piercode/internal/tui"
	"github.com/sirhap/piercode/internal/types"
	"github.com/sirhap/piercode/prompts"
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
	allowShell := flag.Bool("allow-shell", true, "启用 exec_cmd 工具。默认开启；用 --allow-shell=false 或 --no-shell 关闭")
	noShell := flag.Bool("no-shell", false, "禁用 exec_cmd（等价于 --allow-shell=false）")
	allowedOrigins := flag.String("allowed-origins", "", "允许的 CORS/WS Origin 白名单（逗号分隔），默认仅放行 chrome-extension:// 与 127.0.0.1")
	forceKillPort := flag.Bool("force-kill-port", false, "若端口被非 piercode 进程占用，强制结束该进程")
	flag.Parse()

	addr := fmt.Sprintf("127.0.0.1:%d", *port)

	// 检测端口是否已被占用，若占用则只杀掉 piercode 旧进程；其它进程默认
	// 不动以避免误杀用户的 dev server，--force-kill-port 才一律杀。
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Printf("端口 %d 已被占用，正在尝试终止 piercode 旧进程...\n", *port)
		if killed := portutil.KillPortProcess(*port, *forceKillPort); killed {
			fmt.Printf("✅ 已终止旧进程，重新检测端口...\n")
			ln, err = net.Listen("tcp", addr)
			if err != nil {
				fmt.Printf("❌ 端口仍被占用，请手动处理或使用 -port 指定其他端口\n")
				os.Exit(1)
			}
		} else {
			fmt.Printf("❌ 端口被非 piercode 进程占用。请使用 -port 指定其他端口，或加 --force-kill-port 强制结束该进程。\n")
			os.Exit(1)
		}
	}
	ln.Close()

	token, err := security.LoadOrCreateToken()
	if err != nil {
		log.Fatal(err)
	}

	var origins []string
	for _, o := range strings.Split(*allowedOrigins, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			origins = append(origins, o)
		}
	}

	shellEnabled := *allowShell && !*noShell

	config := &types.Config{
		RootDir:        *dir,
		InitialRootDir: *dir,
		Port:           *port,
		Timeout:        *timeout,
		Token:          token,
		DefaultPrompt:  prompts.DefaultPrompt,
		AllowShell:     shellEnabled,
		AllowedOrigins: origins,
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
		if shellEnabled {
			tuiLogger.Printf("⚠️  exec_cmd 已启用（默认）：AI 可执行任意 shell 命令。命令黑名单仅基础防护，不是沙箱。需关闭加 --no-shell。")
		} else {
			tuiLogger.Printf("ℹ️  exec_cmd 已禁用：AI 不能执行 shell 命令。")
		}

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
