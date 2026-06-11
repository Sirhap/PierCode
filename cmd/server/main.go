package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/sirhap/piercode/internal/portutil"
	"github.com/sirhap/piercode/internal/security"
	"github.com/sirhap/piercode/internal/server"
	"github.com/sirhap/piercode/internal/subproc"
	"github.com/sirhap/piercode/internal/types"
	"github.com/sirhap/piercode/internal/version"
	"github.com/sirhap/piercode/prompts"
)

type stringListFlag []string

func (f *stringListFlag) String() string {
	return strings.Join(*f, ",")
}

func (f *stringListFlag) Set(value string) error {
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item != "" {
			*f = append(*f, item)
		}
	}
	return nil
}

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
	showToken := flag.Bool("show-token", true, "在终端打印本次启动的认证 URL（含临时 token）。设 --show-token=false 可隐藏，隐藏后需重启并显示 token 才能重新授权")
	allowedOrigins := flag.String("allowed-origins", "", "允许的 CORS/WS Origin 白名单（逗号分隔），默认仅放行 chrome-extension:// 与 127.0.0.1")
	permissionMode := flag.String("permission-mode", "default", "文件权限模式：default=仅工作区/追加目录，auto=自动允许启动目录父级，unrestricted=不限制文件路径")
	var addDirs stringListFlag
	flag.Var(&addDirs, "add-dir", "额外允许访问的目录；可重复或逗号分隔，类似 Claude Code --add-dir")
	forceKillPort := flag.Bool("force-kill-port", false, "若端口被非 piercode 进程占用，强制结束该进程")
	fixedToken := flag.String("token", "", "使用固定的认证 token（而非随机生成），方便扩展重启后自动重连")
	ephemeralToken := flag.Bool("ephemeral-token", false, "每次启动都随机生成 token（旧行为）。默认会把 token 持久化到 ~/.piercode/token，扩展无需每次重连")
	showVersion := flag.Bool("version", false, "打印版本号并退出")
	noChatGPTProxy := flag.Bool("no-chatgpt-proxy", false, "不启动内置 ChatGPT 代理子进程（默认会启动，供 ChatGPT 子代理走 API 而非浏览器标签）")
	chatGPTProxyPort := flag.Int("chatgpt-proxy-port", subproc.DefaultPort, "内置 ChatGPT 代理监听端口")
	flag.Parse()

	if *showVersion {
		fmt.Printf("piercode %s\n", version.Version)
		return
	}

	absDir, err := filepath.Abs(*dir)
	if err != nil {
		log.Fatal(err)
	}

	addr := fmt.Sprintf("127.0.0.1:%d", *port)

	// 检测端口是否已被占用，若占用则尝试只杀掉旧的 piercode 进程；其它进程
	// 默认不动，避免误杀用户自己的服务（除非显式 --force-kill-port）。
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

	var token string
	switch {
	case *fixedToken != "":
		token = *fixedToken
	case *ephemeralToken:
		var err error
		token, err = security.NewSessionToken()
		if err != nil {
			log.Fatal(err)
		}
	default:
		var err error
		token, err = security.PersistentSessionToken()
		if err != nil {
			log.Fatal(err)
		}
	}

	var origins []string
	for _, o := range strings.Split(*allowedOrigins, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			origins = append(origins, o)
		}
	}

	mode := types.NormalizePermissionMode(*permissionMode)
	additionalAllowedDirs, err := normalizeAllowedDirs(addDirs)
	if err != nil {
		log.Fatal(err)
	}

	// --no-shell 是反向便捷开关，与 --allow-shell=false 等价。两者同时给时
	// --no-shell 优先，避免歧义。
	shellEnabled := *allowShell && !*noShell

	config := &types.Config{
		RootDir:               absDir,
		InitialRootDir:        absDir,
		Port:                  *port,
		Timeout:               *timeout,
		Token:                 token,
		DefaultPrompt:         prompts.DefaultPrompt,
		AllowShell:            shellEnabled,
		AdditionalAllowedDirs: additionalAllowedDirs,
		PermissionMode:        mode,
		AllowedOrigins:        origins,
	}

	if shellEnabled {
		fmt.Println("⚠️  exec_cmd 已启用（默认）：AI 可执行任意 shell 命令。")
		fmt.Println("    命令黑名单只是基础防护，不能视为沙箱。需关闭加 --no-shell。")
	} else {
		fmt.Println("ℹ️  exec_cmd 已禁用：AI 不能执行 shell 命令。")
	}
	for _, dir := range additionalAllowedDirs {
		fmt.Printf("额外允许目录: %s\n", dir)
	}
	fmt.Printf("文件权限模式: %s\n", mode)

	if *showToken {
		fmt.Printf("\n认证 URL: http://127.0.0.1:%d/auth?token=%s\n", *port, token)
		if *fixedToken == "" && !*ephemeralToken {
			fmt.Printf("（token 已持久化到 ~/.piercode/token，扩展授权一次后重启无需重连）\n")
		}
		fmt.Printf("请在浏览器扩展中输入此 URL（仅首次需要）\n")
	} else {
		fmt.Printf("\n认证 token 为本次启动临时生成，--show-token=false 已隐藏。\n")
		fmt.Printf("如需重新授权浏览器插件，请重启并显示认证 URL。\n")
	}
	fmt.Printf("PierCode %s 监听 http://127.0.0.1:%d\n\n", version.Version, *port)

	// 内置 ChatGPT 代理：默认启动一个子进程（PyInstaller 打包的 chatgpt-proxy），
	// 让 ChatGPT 子代理走本地 OpenAI 兼容 API 而非浏览器标签。--no-chatgpt-proxy
	// 关闭。未内置二进制的平台为 no-op。代理生命周期绑主进程：退出时杀子进程。
	if !*noChatGPTProxy {
		proxy := subproc.NewChatGPTProxy(*chatGPTProxyPort)
		if err := proxy.Start(); err != nil {
			fmt.Printf("⚠️  ChatGPT 代理启动失败（继续运行，ChatGPT 子代理不可用）: %v\n", err)
		}
		defer proxy.Stop()
	}

	srv := server.New(config)

	if err := srv.Run(); err != nil {
		log.Fatalf("服务器运行出错: %v", err)
	}
}

func normalizeAllowedDirs(dirs []string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for _, dir := range dirs {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			continue
		}
		if dir == "~" || strings.HasPrefix(dir, "~/") || strings.HasPrefix(dir, `~\`) {
			home, err := os.UserHomeDir()
			if err != nil {
				return nil, err
			}
			if dir == "~" {
				dir = home
			} else {
				dir = filepath.Join(home, dir[2:])
			}
		}
		abs, err := filepath.Abs(dir)
		if err != nil {
			return nil, err
		}
		real, err := filepath.EvalSymlinks(abs)
		if err != nil {
			return nil, fmt.Errorf("add-dir %q: %w", dir, err)
		}
		info, err := os.Stat(real)
		if err != nil {
			return nil, fmt.Errorf("add-dir %q: %w", dir, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("add-dir %q is not a directory", dir)
		}
		if !seen[real] {
			seen[real] = true
			out = append(out, real)
		}
	}
	return out, nil
}
