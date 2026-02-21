package security

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// SafePath joins rootDir+targetPath and validates the result stays within rootDir.
// targetPath must be relative.
func SafePath(rootDir, targetPath string) (string, error) {
	absRoot, err := filepath.EvalSymlinks(rootDir)
	if err != nil {
		absRoot, err = filepath.Abs(rootDir)
		if err != nil {
			return "", err
		}
	}
	joined := filepath.Join(absRoot, targetPath)
	// EvalSymlinks 解析符号链接；文件不存在时（新建场景）fallback 到 Abs
	absTarget, err := filepath.EvalSymlinks(joined)
	if err != nil {
		absTarget, err = filepath.Abs(joined)
		if err != nil {
			return "", err
		}
	}
	if !strings.HasPrefix(absTarget, absRoot+string(filepath.Separator)) && absTarget != absRoot {
		return "", errors.New("path outside sandbox")
	}
	return absTarget, nil
}

// SafeAbsPath validates an already-absolute (or ~-prefixed) path against one or more allowed roots.
func SafeAbsPath(targetPath string, allowedRoots ...string) (string, error) {
	if strings.HasPrefix(targetPath, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		targetPath = filepath.Join(home, targetPath[2:])
	}
	if !filepath.IsAbs(targetPath) {
		return "", errors.New("not an absolute path")
	}
	absTarget, err := filepath.EvalSymlinks(targetPath)
	if err != nil {
		absTarget, err = filepath.Abs(targetPath)
		if err != nil {
			return "", err
		}
	}
	for _, rootDir := range allowedRoots {
		absRoot, err := filepath.EvalSymlinks(rootDir)
		if err != nil {
			absRoot, err = filepath.Abs(rootDir)
			if err != nil {
				continue
			}
		}
		if strings.HasPrefix(absTarget, absRoot+string(filepath.Separator)) || absTarget == absRoot {
			return absTarget, nil
		}
	}
	return "", errors.New("path outside sandbox")
}

var DangerousCommands = []string{
	"rm -rf", "rm -fr", "mkfs", "dd", "format",
	"> /dev/", "curl", "wget", "nc", "netcat",
	"sudo", "chmod 777", "kill -9", "reboot", "shutdown",
}

func IsDangerousCommand(cmd string) bool {
	lower := strings.ToLower(cmd)
	for _, dangerous := range DangerousCommands {
		if strings.Contains(lower, dangerous) {
			return true
		}
	}
	return false
}
