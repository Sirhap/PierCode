package tool

import (
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
)

// commandSemantic interprets a process exit code for a specific command.
// Many tools use nonzero exit codes to convey information other than failure
// (grep returns 1 for "no matches", diff returns 1 for "files differ"), so a
// blanket "nonzero == error" rule mislabels successful runs as failures and
// makes the model think a working command broke.
//
// Ported from Claude Code's commandSemantics.ts.
type commandSemantic func(exitCode int) semanticResult

type semanticResult struct {
	isError bool
	// message is an optional human note explaining a nonzero-but-not-error
	// exit (e.g. "No matches found"). Empty for plain success/failure.
	message string
}

// defaultSemantic: only exit 0 is success.
func defaultSemantic(exitCode int) semanticResult {
	if exitCode == 0 {
		return semanticResult{}
	}
	return semanticResult{isError: true}
}

// grepLikeSemantic: 0 = found, 1 = nothing found (ok), 2+ = real error.
func grepLikeSemantic(exitCode int) semanticResult {
	switch {
	case exitCode == 0:
		return semanticResult{}
	case exitCode == 1:
		return semanticResult{message: "No matches found"}
	default:
		return semanticResult{isError: true}
	}
}

var commandSemantics = map[string]commandSemantic{
	// grep family: exit 1 means no matches, not an error.
	"grep":  grepLikeSemantic,
	"egrep": grepLikeSemantic,
	"fgrep": grepLikeSemantic,
	"rg":    grepLikeSemantic,
	"ag":    grepLikeSemantic,

	// diff: 0 = identical, 1 = differ (ok), 2+ = error.
	"diff": func(exitCode int) semanticResult {
		switch {
		case exitCode == 0:
			return semanticResult{}
		case exitCode == 1:
			return semanticResult{message: "Files differ"}
		default:
			return semanticResult{isError: true}
		}
	},

	// test / [: 0 = true, 1 = false (ok), 2+ = error.
	"test": testSemantic,
	"[":    testSemantic,

	// find: 0 = success, 1 = some dirs inaccessible (partial, ok), 2+ = error.
	"find": func(exitCode int) semanticResult {
		switch {
		case exitCode == 0:
			return semanticResult{}
		case exitCode == 1:
			return semanticResult{message: "Some directories were inaccessible"}
		default:
			return semanticResult{isError: true}
		}
	},
}

func testSemantic(exitCode int) semanticResult {
	switch {
	case exitCode == 0:
		return semanticResult{}
	case exitCode == 1:
		return semanticResult{message: "Condition is false"}
	default:
		return semanticResult{isError: true}
	}
}

// extractLastBaseCommand returns the base command name of the LAST segment of a
// shell command line — that segment determines the overall exit code. It splits
// on pipes and chain operators, strips leading VAR=val assignments, and takes
// the basename of the executable. Heuristic only; never use for security.
func extractLastBaseCommand(command string) string {
	// Split on pipe / chain operators, keep the last non-empty segment.
	segment := command
	for _, sep := range []string{"&&", "||", "|", ";", "&"} {
		if idx := strings.LastIndex(segment, sep); idx >= 0 {
			candidate := strings.TrimSpace(segment[idx+len(sep):])
			if candidate != "" {
				segment = candidate
			}
		}
	}
	fields := strings.Fields(segment)
	// Skip leading FOO=bar environment assignments.
	for len(fields) > 0 && strings.Contains(fields[0], "=") && !strings.HasPrefix(fields[0], "=") {
		fields = fields[1:]
	}
	if len(fields) == 0 {
		return ""
	}
	return filepath.Base(fields[0])
}

// interpretCommandResult applies command-specific exit-code semantics.
func interpretCommandResult(command string, exitCode int) semanticResult {
	base := extractLastBaseCommand(command)
	semantic, ok := commandSemantics[base]
	if !ok {
		semantic = defaultSemantic
	}
	return semantic(exitCode)
}

// exitCodeFrom extracts the process exit code from a CombinedOutput-style error.
// Returns (0, true) for nil err. Returns (code, true) for a normal nonzero exit.
// Returns (-1, false) when the process did not run or was killed by a signal
// without an exit code, so callers fall back to treating err as a hard failure.
func exitCodeFrom(err error) (int, bool) {
	if err == nil {
		return 0, true
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if code := ee.ExitCode(); code >= 0 {
			return code, true
		}
	}
	return -1, false
}
