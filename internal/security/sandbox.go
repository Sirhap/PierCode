package security

import (
	"errors"
	"path/filepath"
	"strings"
)

func SafePath(rootDir, targetPath string) (string, error) {
	absRoot, err := filepath.Abs(rootDir)
	if err != nil {
		return "", err
	}

	absTarget, err := filepath.Abs(filepath.Join(rootDir, targetPath))
	if err != nil {
		return "", err
	}

	if !strings.HasPrefix(absTarget, absRoot+string(filepath.Separator)) && absTarget != absRoot {
		return "", errors.New("path outside sandbox")
	}
	return absTarget, nil
}

var DangerousCommands = []string{
	"rm -rf", "rm -fr", "mkfs", "dd", "format",
	"> /dev/", "curl", "wget", "nc", "netcat",
	"sudo", "chmod 777", "kill -9", "reboot", "shutdown",
}

func IsDangerousCommand(cmd string) bool {
	cmd = strings.ToLower(strings.ReplaceAll(cmd, " ", ""))
	for _, dangerous := range DangerousCommands {
		check := strings.ReplaceAll(dangerous, " ", "")
		if strings.Contains(cmd, check) {
			return true
		}
	}
	return false
}
