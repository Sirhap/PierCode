package portutil

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// KillPortProcess 查找并终止占用指定端口的进程，返回是否成功
func KillPortProcess(port int) bool {
	pids := findPidsOnPort(port)
	if len(pids) == 0 {
		return false
	}
	for _, pid := range pids {
		if pid == os.Getpid() {
			continue
		}
		fmt.Printf("   终止进程 PID %d\n", pid)
		if err := killPid(pid); err != nil {
			fmt.Printf("   终止 PID %d 失败: %v\n", pid, err)
		}
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
