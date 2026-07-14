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

func (t *GlobTool) Metadata() ToolMetadata { return ToolMetadata{ReadOnly: true} }

func (t *GlobTool) Name() string { return "glob" }
func (t *GlobTool) Description() string {
	return `Fast file search by glob pattern. Use this to find files by name — prefer it over running find/ls via exec_cmd.

Usage:
- Supports patterns like ` + "`**/*.go`" + `, ` + "`src/**/*.ts`" + `, ` + "`*.md`" + `.
- Use glob to find files by name; use grep to search file contents.
- Narrow the pattern/path for large repos rather than scanning the whole tree.`
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
	// For recursive patterns like "src/**/*.go", extract the directory prefix
	// ("src/") so we can verify the file is under the right subtree.
	var prefixDir string
	if isRecursive {
		idx := strings.Index(pattern, "**")
		if idx > 0 {
			prefixDir = pattern[:idx]
			prefixDir = strings.TrimSuffix(prefixDir, "/")
			prefixDir = strings.TrimSuffix(prefixDir, string(filepath.Separator))
		}
	}

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
			// If the pattern has a directory prefix (e.g. "src" in "src/**/*.go"),
			// verify the file is under that prefix relative to the search root.
			if matched && prefixDir != "" {
				rel, _ := filepath.Rel(safePath, p)
				relDir := filepath.Dir(rel)
				if relDir != "." && relDir != prefixDir &&
					!strings.HasPrefix(relDir, prefixDir+string(filepath.Separator)) {
					matched = false
				}
			}
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
		lines = append(lines, fmt.Sprintf("(results truncated, showing first %d)", limit))
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
