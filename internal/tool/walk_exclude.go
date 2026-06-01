package tool

// Shared directory-exclusion rules for filesystem walks (glob, grep native
// fallback). These mirror what ripgrep skips by default so the native path
// returns comparable results: heavy dependency/build/VCS directories that
// almost never hold the file the caller wants, and would otherwise drown real
// matches and slow the walk.
//
// We exclude by directory name only (not full paths) and prune the whole
// subtree via fs.SkipDir at the WalkDir callback, which is both fast and
// avoids descending into millions of node_modules entries.

// defaultSkipDirs are directory names pruned during a walk. dot-directories
// (.git, .idea, .vscode, …) are handled separately by isHiddenDir so we don't
// have to enumerate every tool's config folder.
var defaultSkipDirs = map[string]struct{}{
	"node_modules":     {},
	"vendor":           {},
	"dist":             {},
	"build":            {},
	"target":           {}, // rust/java
	"__pycache__":      {},
	".git":             {},
	".hg":              {},
	".svn":             {},
	".idea":            {},
	".vscode":          {},
	".next":            {},
	".nuxt":            {},
	".cache":           {},
	"bower_components": {},
}

// isHiddenDir reports whether a directory name is a dot-directory (".git",
// ".venv", …). The walk root itself is "." and must never be treated as
// hidden, so callers pass the entry's base name, not the root path.
func isHiddenDir(name string) bool {
	return len(name) > 1 && name[0] == '.'
}

// shouldSkipDir reports whether a directory (by base name) should be pruned
// from the walk. The walk root has base name "." or "" and is never skipped.
func shouldSkipDir(name string) bool {
	if name == "" || name == "." || name == ".." {
		return false
	}
	if _, ok := defaultSkipDirs[name]; ok {
		return true
	}
	return isHiddenDir(name)
}
