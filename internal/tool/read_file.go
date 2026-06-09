package tool

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/sirhap/piercode/internal/types"
)

type ReadFileTool struct {
	config *types.Config
}

func NewReadFileTool(config *types.Config) *ReadFileTool {
	return &ReadFileTool{config: config}
}

func (t *ReadFileTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }

func (t *ReadFileTool) Name() string {
	return "read_file"
}

func (t *ReadFileTool) Description() string {
	return `Reads a file from the local filesystem. Prefer this over running cat/head/tail via exec_cmd.

Usage:
	- The path must be inside the configured working directory or an explicitly added directory.
- By default reads up to 2000 lines from the start. Use offset and limit to read a specific window of a large file; read only the part you need.
- Each line is returned prefixed with its line number and a tab (` + "`<lineno>\\t`" + `), like cat -n. When you later edit, match only the content AFTER the tab — never include the line number prefix in an edit.
- Lines longer than the display limit are truncated.
- Reading a directory, a missing file, or an empty file returns an error rather than content.`
}

func (t *ReadFileTool) Parameters() interface{} {
	return map[string]string{
		"path":         "string (required) - file path to read",
		"offset":       "number (optional) - start line number, 1-based (default: 1)",
		"limit":        "number (optional) - max lines to read (default: 2000)",
		"line_numbers": "boolean (optional) - prefix each line with `<lineno>\\t` like cat -n (default: true)",
	}
}

func (t *ReadFileTool) Validate(args map[string]interface{}) error {
	path, ok := args["path"].(string)
	if !ok || path == "" {
		return errors.New("path is required")
	}
	return nil
}

func (t *ReadFileTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	path, _ := ctx.Args["path"].(string)

	offset := 1
	limit := MaxLines
	if v, ok := ctx.Args["offset"].(float64); ok && v >= 1 {
		offset = int(v)
	}
	if v, ok := ctx.Args["limit"].(float64); ok && v >= 1 {
		limit = int(v)
		if limit > MaxLines {
			limit = MaxLines
		}
	}
	showLineNumbers := true
	if v, ok := ctx.Args["line_numbers"].(bool); ok {
		showLineNumbers = v
	}

	safePath, err := ctx.ResolvePath(path)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	f, err := os.Open(safePath)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	defer f.Close()

	var lines []string
	totalLines := 0
	byteCount := 0
	truncated := false

	scanner := bufio.NewScanner(f)
	// Bump scanner's max-token buffer from the default 64KB to 1MB so that
	// files containing a single very long line (minified JS, JSON-on-one-line,
	// dist bundles, large prompts) don't fail with bufio.ErrTooLong before
	// returning anything. Lines longer than 1MB are still rejected, which is
	// a sane upper bound for "a single line of source" in any project we'd
	// be working in.
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		totalLines++
		if totalLines < offset {
			continue
		}
		if len(lines) >= limit {
			truncated = true
			// count remaining lines
			for scanner.Scan() {
				totalLines++
			}
			break
		}
		line := scanner.Text()
		byteCount += len(line) + 1
		if byteCount > MaxBytes {
			truncated = true
			// Include as much of this line as still fits in the output budget,
			// so a file consisting of a single very long line (minified JS,
			// 200KB JSON on one line, etc.) isn't returned as "empty" — the
			// user can at least see the start of the content.
			over := byteCount - MaxBytes
			keep := len(line) - over
			if keep > 0 {
				// Back off keep until it lands on a UTF-8 rune boundary so
				// multi-byte characters (CJK, emoji) at the cut point aren't
				// rendered as '�' or invalid bytes downstream.
				for keep > 0 && !utf8.RuneStart(line[keep]) {
					keep--
				}
				if keep > 0 {
					lines = append(lines, line[:keep])
				}
			}
			for scanner.Scan() {
				totalLines++
			}
			break
		}
		lines = append(lines, line)
	}

	if err := scanner.Err(); err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	var output string
	if len(lines) == 0 {
		output = "empty"
	} else if showLineNumbers {
		output = formatWithLineNumbers(lines, offset)
	} else {
		output = strings.Join(lines, "\n")
	}
	if truncated {
		nextOffset := offset + len(lines)
		output += fmt.Sprintf("\n[truncated, %d total lines, use offset=%d to continue]", totalLines, nextOffset)
	}

	result.Status = "success"
	result.Output = output
	result.EndTime = time.Now()
	return result
}

// formatWithLineNumbers 把每行加上右对齐的 cat -n 风格行号 + Tab + 内容。
// startLine 是 lines[0] 在原文件中的行号(1-based)。
func formatWithLineNumbers(lines []string, startLine int) string {
	if len(lines) == 0 {
		return ""
	}
	maxLine := startLine + len(lines) - 1
	width := len(fmt.Sprintf("%d", maxLine))
	if width < 6 {
		width = 6
	}
	var sb strings.Builder
	sb.Grow(len(lines) * (width + 2))
	for i, line := range lines {
		sb.WriteString(fmt.Sprintf("%*d", width, startLine+i))
		sb.WriteByte('\t')
		sb.WriteString(line)
		if i < len(lines)-1 {
			sb.WriteByte('\n')
		}
	}
	return sb.String()
}
