package tool

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/types"
)

type GrepTool struct {
	config *types.Config
}

func NewGrepTool(config *types.Config) *GrepTool {
	return &GrepTool{config: config}
}

func (t *GrepTool) Name() string { return "grep" }
func (t *GrepTool) Description() string {
	return `Searches file contents with a regular expression. Prefer this over running grep/rg via exec_cmd.

Usage:
- pattern is a regular expression (RE2 syntax). Escape literal special chars: ` + "`func\\(`" + ` to match "func(".
- Use include to filter by file type, e.g. ` + "`*.go`" + ` or ` + "`*.{ts,tsx}`" + `.
- Use grep to search contents; use glob to find files by name.
- Narrow the path or include filter for large repos rather than scanning everything.`
}
func (t *GrepTool) Parameters() interface{} {
	return map[string]string{
		"pattern": "string (required) - regex pattern to search",
		"path":    "string (optional) - directory to search (default: root)",
		"include": "string (optional) - file glob filter, e.g. *.go",
	}
}

func (t *GrepTool) Validate(args map[string]interface{}) error {
	if p, ok := args["pattern"].(string); !ok || p == "" {
		return errors.New("pattern is required")
	}
	if inc, ok := args["include"].(string); ok && strings.ContainsAny(inc, "/\\") {
		return errors.New("include pattern must not contain path separators")
	}
	return nil
}

func (t *GrepTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	pattern, _ := ctx.Args["pattern"].(string)
	searchPath, _ := ctx.Args["path"].(string)
	include, _ := ctx.Args["include"].(string)
	if searchPath == "" {
		searchPath = "."
	}

	safePath, err := ctx.ResolvePath(searchPath)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	var output string
	if rgPath, err := exec.LookPath("rg"); err == nil {
		output, err = grepWithRg(rgPath, pattern, safePath, include)
		if err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
	} else {
		output, err = grepNative(pattern, safePath, include)
		if err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
	}

	result.Status = "success"
	result.Output = output
	result.EndTime = time.Now()
	return result
}

func grepWithRg(rgPath, pattern, searchPath, include string) (string, error) {
	args := []string{"-n", "--no-heading"}
	if include != "" {
		if strings.ContainsAny(include, "/\\") {
			return "", errors.New("include pattern must not contain path separators")
		}
		args = append(args, "--glob", include)
	}
	args = append(args, "--", pattern, searchPath)
	cmd := exec.Command(rgPath, args...)
	out, err := cmd.Output()
	// ripgrep exit codes: 0 = matches found, 1 = no matches (not an error),
	// 2 = an actual error (e.g. invalid regex). Surface code 2 instead of
	// silently returning "no matches", matching the native path's behavior.
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			switch exitErr.ExitCode() {
			case 1:
				// no matches — fall through with empty output
			default:
				msg := strings.TrimSpace(string(exitErr.Stderr))
				if msg == "" {
					msg = "ripgrep failed"
				}
				return "", fmt.Errorf("invalid pattern or search error: %s", msg)
			}
		} else {
			return "", err
		}
	}
	lines := strings.Split(strings.ReplaceAll(string(out), "\r\n", "\n"), "\n")
	return formatGrepLines(lines, 100), nil
}

func grepNative(pattern, searchPath, include string) (string, error) {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return "", fmt.Errorf("invalid pattern: %w", err)
	}

	type match struct {
		line  string
		mtime time.Time
	}
	var matches []match

	filepath.WalkDir(searchPath, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			// Match ripgrep's default pruning so the native fallback returns
			// comparable results: skip node_modules/.git/etc. Never prune the
			// walk root itself.
			if p != searchPath && shouldSkipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if include != "" {
			if !matchIncludeGlob(include, d.Name()) {
				return nil
			}
		}
		info, err := d.Info()
		if err != nil {
			return nil // skip files we can't stat
		}
		mtime := info.ModTime()

		f, err := os.Open(p)
		if err != nil {
			return nil
		}
		defer f.Close()

		lineNum := 0
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			lineNum++
			text := scanner.Text()
			if re.MatchString(text) {
				matches = append(matches, match{
					line:  fmt.Sprintf("%s:%d:%s", filepath.ToSlash(p), lineNum, text),
					mtime: mtime,
				})
			}
		}
		// Silently ignore scanner errors (e.g. file truncated mid-read);
		// partial results for this file are still useful.
		_ = scanner.Err()
		return nil
	})

	sort.Slice(matches, func(i, j int) bool {
		return matches[i].mtime.After(matches[j].mtime)
	})

	lines := make([]string, len(matches))
	for i, m := range matches {
		lines[i] = m.line
	}
	return formatGrepLines(lines, 100), nil
}

// matchIncludeGlob matches a base name against an include pattern, adding the
// single-level brace alternation (e.g. *.{ts,tsx}) that the tool description
// advertises but Go's filepath.Match does not support. Each alternative is
// matched with filepath.Match; any hit passes.
func matchIncludeGlob(include, name string) bool {
	open := strings.IndexByte(include, '{')
	close := strings.IndexByte(include, '}')
	if open < 0 || close < open {
		ok, _ := filepath.Match(include, name)
		return ok
	}
	prefix := include[:open]
	suffix := include[close+1:]
	for _, alt := range strings.Split(include[open+1:close], ",") {
		if ok, _ := filepath.Match(prefix+alt+suffix, name); ok {
			return true
		}
	}
	return false
}

func formatGrepLines(lines []string, limit int) string {
	var out []string
	count := 0
	truncated := false
	for _, l := range lines {
		if l == "" {
			continue
		}
		if count >= limit {
			// A further non-empty result exists beyond the limit; only now is the
			// truncation hint warranted (exactly `limit` results is NOT truncated).
			truncated = true
			break
		}
		out = append(out, l)
		count++
	}
	if truncated {
		out = append(out, fmt.Sprintf("(结果已截断，仅显示前 %d 条)", limit))
	}
	if len(out) == 0 {
		return "No matches found"
	}
	return strings.Join(out, "\n")
}
