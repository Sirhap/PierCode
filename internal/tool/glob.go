package tool

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/types"
)

type GlobTool struct {
	config *types.Config
}

func NewGlobTool(config *types.Config) *GlobTool {
	return &GlobTool{config: config}
}

func (t *GlobTool) Name() string { return "glob" }
func (t *GlobTool) Description() string {
	return `Fast file search by glob pattern. Use this to find files by name — prefer it over running find/ls via exec_cmd.

Usage:
- Supports patterns like ` + "`**/*.go`" + `, ` + "`src/**/*.ts`" + `, ` + "`*.md`" + `.
- Use glob to find files by path; use grep to search file contents.
- For open-ended searches that may need multiple rounds, narrow the pattern instead of listing the whole tree.`
}
func (t *GlobTool) Parameters() interface{} {
	return map[string]string{
		"pattern": "string (required) - glob pattern, e.g. **/*.go or *.ts",
		"path":    "string (optional) - directory to search in (default: root)",
	}
}

func (t *GlobTool) Validate(args map[string]interface{}) error {
	if p, ok := args["pattern"].(string); !ok || p == "" {
		return errors.New("pattern is required")
	}
	return nil
}

func (t *GlobTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	pattern, _ := ctx.Args["pattern"].(string)
	searchPath, _ := ctx.Args["path"].(string)
	if searchPath == "" {
		searchPath = "."
	}

	safePath, err := ctx.ResolvePath(searchPath)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	type fileEntry struct {
		path  string
		mtime time.Time
	}
	var files []fileEntry

	basePat := filepath.Base(pattern)
	isRecursive := strings.Contains(pattern, "**")

	filepath.WalkDir(safePath, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			// Prune heavy/VCS/hidden directories, but never the walk root
			// itself (its base name may legitimately be e.g. "node_modules"
			// if the user pointed -dir there).
			if p != safePath && shouldSkipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		name := d.Name()
		var matched bool
		if isRecursive {
			matched, _ = filepath.Match(basePat, name)
		} else {
			rel, _ := filepath.Rel(safePath, p)
			matched, _ = filepath.Match(pattern, rel)
		}
		if matched {
			info, err := d.Info()
			if err != nil {
				return nil // skip files we can't stat (race, permission, etc.)
			}
			files = append(files, fileEntry{
				path:  filepath.ToSlash(p),
				mtime: info.ModTime(),
			})
		}
		return nil
	})

	sort.Slice(files, func(i, j int) bool {
		return files[i].mtime.After(files[j].mtime)
	})

	const limit = 100
	truncated := len(files) > limit
	if truncated {
		files = files[:limit]
	}

	var lines []string
	for _, f := range files {
		lines = append(lines, f.path)
	}
	if truncated {
		lines = append(lines, fmt.Sprintf("(结果已截断，仅显示前 %d 条)", limit))
	}

	result.Status = "success"
	if len(lines) == 0 {
		result.Output = "No files found"
	} else {
		result.Output = strings.Join(lines, "\n")
	}
	result.EndTime = time.Now()
	return result
}
