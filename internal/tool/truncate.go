package tool

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

const MaxLines = 2000
const MaxBytes = 50 * 1024

var (
	truncateUserHomeDir = os.UserHomeDir
	truncateMkdirAll    = os.MkdirAll
	truncateWriteFile   = os.WriteFile
)

// Truncate 检查输出是否超限，超限则写入临时文件并返回截断提示
func Truncate(output string) (string, bool) {
	normalized := strings.ReplaceAll(output, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")

	if len(lines) <= MaxLines && len(normalized) <= MaxBytes {
		return output, false
	}

	end := MaxLines
	if end > len(lines) {
		end = len(lines)
	}
	preview := strings.Join(lines[:end], "\n")
	if len(preview) > MaxBytes {
		preview = truncateUTF8(preview, MaxBytes)
	}

	hint := truncationHint(output, len(lines))
	return preview + hint, true
}

func truncationHint(output string, totalLines int) string {
	home, err := truncateUserHomeDir()
	if err != nil {
		return fmt.Sprintf(
			"\n\n...输出已截断（共 %d 行），完整内容保存失败: %v",
			totalLines, err,
		)
	}

	dir := filepath.Join(home, ".piercode", "tool-output")
	if err := truncateMkdirAll(dir, 0755); err != nil {
		return fmt.Sprintf(
			"\n\n...输出已截断（共 %d 行），完整内容保存失败: %v",
			totalLines, err,
		)
	}

	id := fmt.Sprintf("%d", time.Now().UnixNano())
	fullPath := filepath.Join(dir, id)
	if err := truncateWriteFile(fullPath, []byte(output), 0644); err != nil {
		return fmt.Sprintf(
			"\n\n...输出已截断（共 %d 行），完整内容保存失败: %v",
			totalLines, err,
		)
	}

	return fmt.Sprintf(
		"\n\n...输出已截断（共 %d 行），完整内容保存至:\n%s\n使用 read_file 工具加 offset 参数分段读取",
		totalLines, fullPath,
	)
}

func truncateUTF8(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	cut := maxBytes
	for cut > 0 && cut < len(s) && !utf8.RuneStart(s[cut]) {
		cut--
	}
	if cut <= 0 {
		return ""
	}
	preview := s[:cut]
	if utf8.ValidString(preview) {
		return preview
	}
	for len(preview) > 0 && !utf8.ValidString(preview) {
		_, size := utf8.DecodeLastRuneInString(preview)
		if size <= 0 || size > len(preview) {
			return ""
		}
		preview = preview[:len(preview)-size]
	}
	return preview
}
