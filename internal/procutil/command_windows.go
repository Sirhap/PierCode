//go:build windows

package procutil

import (
	"os"
	osexec "os/exec"
	"strconv"
	"time"
)

// ConfigureCommand wires context cancellation to terminate the process tree.
func ConfigureCommand(cmd *osexec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.WaitDelay = 500 * time.Millisecond
	cmd.Cancel = func() error {
		return KillProcessTree(cmd)
	}
}

// KillProcessTree terminates the process tree rooted at cmd.Process.
func KillProcessTree(cmd *osexec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	pid := strconv.Itoa(cmd.Process.Pid)
	if err := osexec.Command("taskkill", "/T", "/F", "/PID", pid).Run(); err != nil {
		_ = cmd.Process.Kill()
		return err
	}
	return nil
}
