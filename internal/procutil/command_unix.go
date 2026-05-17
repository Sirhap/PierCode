//go:build !windows

package procutil

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// ConfigureCommand starts the command in its own process group and wires
// context cancellation to terminate the whole group, not just the shell.
func ConfigureCommand(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 500 * time.Millisecond
	cmd.Cancel = func() error {
		return KillProcessTree(cmd)
	}
}

// KillProcessTree terminates the process group rooted at cmd.Process.
func KillProcessTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return os.ErrProcessDone
	}
	pgid := -cmd.Process.Pid
	if err := syscall.Kill(pgid, syscall.SIGTERM); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	time.Sleep(150 * time.Millisecond)
	if err := syscall.Kill(pgid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}
