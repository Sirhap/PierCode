package portutil

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// KillPortProcess 查找占用端口的进程；默认只在该进程是 openlink 自身（按可执行
// 名匹配）时才终止，避免误杀用户的 dev server。force=true 时跳过名称校验。
// 返回是否成功释放端口。
func KillPortProcess(port int, force bool) bool {
	pids := findPidsOnPort(port)
	if len(pids) == 0 {
		return false
	}
	killed := 0
	for _, pid := range pids {
		if pid == os.Getpid() {
			continue
		}
		if !force && !isOpenLinkProcess(pid) {
			fmt.Printf("   跳过 PID %d：非 openlink 进程，使用 --force-kill-port 可强制终止\n", pid)
			continue
		}
		fmt.Printf("   终止进程 PID %d\n", pid)
		if err := killPid(pid); err != nil {
			fmt.Printf("   终止 PID %d 失败: %v\n", pid, err)
			continue
		}
		killed++
	}
	if killed == 0 {
		return false
	}
	// 等待端口释放
	for i := 0; i < 10; i++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			ln.Close()
			return true
		}
		smallSleep()
	}
	return false
}

// isOpenLinkProcess 判断 PID 对应的可执行名是否包含 "openlink"。失败则保守
// 返回 false，让调用方走 --force 分支。
func isOpenLinkProcess(pid int) bool {
	name, err := processName(pid)
	if err != nil || name == "" {
		return false
	}
	lower := strings.ToLower(name)
	return strings.Contains(lower, "openlink")
}

func processName(pid int) (string, error) {
	if runtime.GOOS == "windows" {
		out, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/NH", "/FO", "CSV").Output()
		if err != nil {
			return "", err
		}
		// CSV: "image.exe","pid","Console","1","mem"
		line := strings.TrimSpace(string(out))
		if line == "" || strings.HasPrefix(line, "INFO:") {
			return "", fmt.Errorf("no such pid")
		}
		parts := strings.SplitN(line, ",", 2)
		if len(parts) == 0 {
			return "", fmt.Errorf("unexpected tasklist output")
		}
		return strings.Trim(parts[0], `"`), nil
	}
	out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "comm=").Output()
	if err != nil {
		return "", err
	}
	return filepath.Base(strings.TrimSpace(string(out))), nil
}

func findPidsOnPort(port int) []int {
	if runtime.GOOS == "windows" {
		return findPidsWindows(port)
	}
	return findPidsUnix(port)
}

func findPidsWindows(port int) []int {
	out, err := exec.Command("netstat", "-ano", "-p", "TCP").Output()
	if err != nil {
		return nil
	}
	seen := map[int]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		if pid, ok := WindowsNetstatLinePID(line, port); ok {
			seen[pid] = true
		}
	}
	var pids []int
	for pid := range seen {
		pids = append(pids, pid)
	}
	return pids
}

// WindowsNetstatLinePID extracts the PID from one Windows netstat line when it
// is a TCP listener on the exact requested local port.
func WindowsNetstatLinePID(line string, port int) (int, bool) {
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "TCP" || fields[3] != "LISTENING" {
		return 0, false
	}
	if !localAddressHasPort(fields[1], port) {
		return 0, false
	}
	pid, err := strconv.Atoi(fields[len(fields)-1])
	return pid, err == nil && pid > 0
}

func localAddressHasPort(addr string, port int) bool {
	portText := strconv.Itoa(port)
	if _, parsedPort, err := net.SplitHostPort(addr); err == nil {
		return parsedPort == portText
	}
	idx := strings.LastIndex(addr, ":")
	return idx >= 0 && addr[idx+1:] == portText
}

func findPidsUnix(port int) []int {
	out, err := exec.Command("lsof", "-i", fmt.Sprintf(":%d", port), "-t").Output()
	if err != nil {
		return nil
	}
	var pids []int
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		pid, err := strconv.Atoi(strings.TrimSpace(line))
		if err == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}

func killPid(pid int) error {
	if runtime.GOOS == "windows" {
		return exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/F").Run()
	}
	return exec.Command("kill", strconv.Itoa(pid)).Run()
}

func smallSleep() {
	time.Sleep(200 * time.Millisecond)
}
