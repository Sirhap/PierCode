package security

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func realPathForSandbox(path string) (string, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if realPath, err := filepath.EvalSymlinks(absPath); err == nil {
		return realPath, nil
	}

	var missing []string
	for cur := absPath; ; cur = filepath.Dir(cur) {
		realBase, err := filepath.EvalSymlinks(cur)
		if err == nil {
			for i := len(missing) - 1; i >= 0; i-- {
				realBase = filepath.Join(realBase, missing[i])
			}
			return filepath.Abs(realBase)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return "", err
		}
		missing = append(missing, filepath.Base(cur))
	}
}

func isWithinRoot(path, root string) bool {
	return path == root || strings.HasPrefix(path, root+string(filepath.Separator))
}

// SafePath joins rootDir+targetPath and validates the result stays within rootDir.
// targetPath must be relative.
func SafePath(rootDir, targetPath string) (string, error) {
	if filepath.IsAbs(targetPath) {
		return "", errors.New("target path must be relative")
	}
	absRoot, err := realPathForSandbox(rootDir)
	if err != nil {
		return "", err
	}
	joined := filepath.Join(absRoot, targetPath)
	// Resolve existing parents too, so creating a new file under a symlinked
	// directory cannot escape the sandbox.
	absTarget, err := realPathForSandbox(joined)
	if err != nil {
		return "", err
	}
	if !isWithinRoot(absTarget, absRoot) {
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
	absTarget, err := realPathForSandbox(targetPath)
	if err != nil {
		return "", err
	}
	for _, rootDir := range allowedRoots {
		absRoot, err := realPathForSandbox(rootDir)
		if err != nil {
			continue
		}
		if isWithinRoot(absTarget, absRoot) {
			return absTarget, nil
		}
	}
	return "", errors.New("path outside sandbox")
}

// dangerousPatterns 需要子串匹配的多词危险模式（含空格或特殊字符，不会误匹配普通路径）
var dangerousPatterns = []string{
	"rm -rf", "rm -fr", "> /dev/", "chmod 777", "kill -9",
	"del /f", "del /q", "rmdir /s", "rd /s",
	"remove-item", "invoke-webrequest", "invoke-restmethod", "start-bitstransfer",
	"powershell -e ", "powershell.exe -e ",
	"powershell -en ", "powershell.exe -en ",
	"powershell -enc", "powershell.exe -enc",
	"powershell -encoded", "powershell.exe -encoded",
	"executionpolicy bypass", "executionpolicy unrestricted",
	"certutil -urlcache", "certutil -decode", "certutil -f",
	"iex(", "iex (", "invoke-expression",
	"downloadstring", "downloadfile",
	"curl.exe", "wget.exe", "certutil", "bitsadmin",
}

var dangerousCommands = []string{
	"mkfs", "format", "nc", "netcat",
	"sudo", "reboot", "shutdown",
	"curl", "wget", "iwr", "irm",
	"mshta", "rundll32", "regsvr32",
}

// isCmdSeparator 判断字符是否为 shell 命令分隔符或空白
func isCmdSeparator(b byte) bool {
	switch b {
	case ' ', '\t', '\n', ';', '|', '&', '(', ')', '`', '\'', '"', '<', '>':
		return true
	}
	return false
}

func IsDangerousCommand(cmd string) bool {
	lower := strings.ToLower(cmd)

	// 多词模式：直接子串匹配
	for _, p := range dangerousPatterns {
		if strings.Contains(lower, p) {
			return true
		}
	}

	// 单词命令：要求前后是分隔符或字符串边界
	for _, word := range dangerousCommands {
		idx := 0
		for {
			pos := strings.Index(lower[idx:], word)
			if pos < 0 {
				break
			}
			abs := idx + pos
			before := abs == 0 || isCmdSeparator(lower[abs-1])
			after := abs+len(word) >= len(lower) || isCmdSeparator(lower[abs+len(word)])
			if before && after {
				return true
			}
			idx = abs + 1
		}
	}
	return false
}
