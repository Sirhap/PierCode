package tool

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/types"
)

type ApplyPatchTool struct {
	config *types.Config
}

func NewApplyPatchTool(config *types.Config) *ApplyPatchTool {
	return &ApplyPatchTool{config: config}
}

func (t *ApplyPatchTool) Name() string { return "apply_patch" }

func (t *ApplyPatchTool) Description() string {
	return "Apply a multi-file patch with contextual hunks. Prefer this for code edits; all hunks must apply cleanly or no files are written."
}

func (t *ApplyPatchTool) Parameters() interface{} {
	return map[string]string{
		"patch":         "string (required) - patch text delimited by *** Begin Patch and *** End Patch",
		"dry_run":       "bool (optional, default false) - validate and report changes without writing files",
		"final_newline": "string (optional) - 'keep' (default, preserve each file's existing trailing-newline state), 'add' (ensure a trailing newline), or 'strip' (remove it)",
	}
}

func (t *ApplyPatchTool) Validate(args map[string]interface{}) error {
	patch, ok := args["patch"].(string)
	if !ok || strings.TrimSpace(patch) == "" {
		return errors.New("patch is required")
	}
	if !strings.Contains(patch, "*** Begin Patch") || !strings.Contains(patch, "*** End Patch") {
		return errors.New("patch must include *** Begin Patch and *** End Patch")
	}
	if v, ok := args["final_newline"]; ok && v != nil {
		s, ok := v.(string)
		if !ok {
			return errors.New("final_newline must be a string")
		}
		switch s {
		case "", "keep", "add", "strip":
		default:
			return errors.New("final_newline must be 'keep', 'add', or 'strip'")
		}
	}
	return nil
}

func (t *ApplyPatchTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()
	patch, _ := ctx.Args["patch"].(string)
	dryRun, _ := ctx.Args["dry_run"].(bool)

	ops, err := parsePatch(patch)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	plans, err := planPatch(ctx, ops)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	// Optionally force the trailing-newline state of every written (non-delete)
	// file, overriding the default of preserving each file's existing state.
	if fn, _ := ctx.Args["final_newline"].(string); fn == "add" || fn == "strip" {
		for i := range plans {
			if plans[i].delete {
				continue
			}
			plans[i].content = applyFinalNewline(plans[i].content, fn)
		}
	}

	if !dryRun {
		// Snapshot every touched path before writing so `undo` can restore the
		// whole patch as one unit. commitPlans still does its own in-call
		// rollback on partial failure; this is the cross-call undo layer.
		paths := make([]string, 0, len(plans))
		for _, p := range plans {
			paths = append(paths, p.absPath)
		}
		_ = snapshotPaths(ctx.EffectiveRootDir(), "apply_patch", paths...)
		if err := commitPlans(plans); err != nil {
			result.Status = "error"
			result.Error = err.Error()
			return result
		}
	}

	result.Status = "success"
	result.Output = formatPatchSummary(plans, dryRun)
	return result
}

// fileBackup records the prior state of a path so it can be restored if a later
// step in the same patch fails, keeping multi-file patches all-or-nothing on disk.
type fileBackup struct {
	absPath string
	existed bool
	content []byte
	mode    os.FileMode
	created bool // true if the commit created this path (restore = remove)
}

// commitPlans applies every plan, restoring all touched files to their original
// state if any single operation fails.
func commitPlans(plans []patchPlan) error {
	backups := make([]fileBackup, 0, len(plans))
	rollback := func() {
		// Restore in reverse so directory creation/removal nests correctly.
		for i := len(backups) - 1; i >= 0; i-- {
			b := backups[i]
			if b.existed {
				_ = os.WriteFile(b.absPath, b.content, b.mode)
			} else if b.created {
				_ = os.Remove(b.absPath)
			}
		}
	}

	for _, plan := range plans {
		info, statErr := os.Stat(plan.absPath)
		existed := statErr == nil
		backup := fileBackup{absPath: plan.absPath, existed: existed}
		if existed {
			raw, err := os.ReadFile(plan.absPath)
			if err != nil {
				rollback()
				return err
			}
			backup.content = raw
			backup.mode = info.Mode().Perm()
		}

		if plan.delete {
			if err := os.Remove(plan.absPath); err != nil {
				rollback()
				return err
			}
			backups = append(backups, backup)
			continue
		}

		if err := os.MkdirAll(filepath.Dir(plan.absPath), 0755); err != nil {
			rollback()
			return err
		}
		if err := os.WriteFile(plan.absPath, []byte(plan.content), plan.mode); err != nil {
			rollback()
			return err
		}
		backup.created = !existed
		backups = append(backups, backup)
	}
	return nil
}

type patchOpKind int

const (
	patchAdd patchOpKind = iota
	patchUpdate
	patchDelete
)

type patchOp struct {
	kind  patchOpKind
	path  string
	hunks []patchHunk
	lines []string
}

type patchHunk struct {
	oldLines []string
	newLines []string
	lines    []patchLine
}

type patchLine struct {
	prefix byte
	text   string
}

type patchPlan struct {
	path    string
	absPath string
	content string
	mode    os.FileMode
	delete  bool
	added   int
	removed int
}

func parsePatch(patch string) ([]patchOp, error) {
	lines := strings.Split(strings.ReplaceAll(patch, "\r\n", "\n"), "\n")
	if len(lines) < 2 || strings.TrimSpace(lines[0]) != "*** Begin Patch" {
		return nil, errors.New("patch must start with *** Begin Patch")
	}
	var ops []patchOp
	for i := 1; i < len(lines); {
		line := strings.TrimRight(lines[i], "\r")
		if strings.TrimSpace(line) == "*** End Patch" {
			return ops, nil
		}
		switch {
		case strings.HasPrefix(line, "*** Add File: "):
			op, next, err := parseAddFile(lines, i)
			if err != nil {
				return nil, err
			}
			ops = append(ops, op)
			i = next
		case strings.HasPrefix(line, "*** Update File: "):
			op, next, err := parseUpdateFile(lines, i)
			if err != nil {
				return nil, err
			}
			ops = append(ops, op)
			i = next
		case strings.HasPrefix(line, "*** Delete File: "):
			path := strings.TrimSpace(strings.TrimPrefix(line, "*** Delete File: "))
			if path == "" {
				return nil, fmt.Errorf("delete file header at line %d has empty path", i+1)
			}
			ops = append(ops, patchOp{kind: patchDelete, path: path})
			i++
		case strings.TrimSpace(line) == "":
			i++
		default:
			return nil, fmt.Errorf("unexpected patch line %d: %s", i+1, line)
		}
	}
	return nil, errors.New("patch missing *** End Patch")
}

func parseAddFile(lines []string, start int) (patchOp, int, error) {
	path := strings.TrimSpace(strings.TrimPrefix(lines[start], "*** Add File: "))
	if path == "" {
		return patchOp{}, start, fmt.Errorf("add file header at line %d has empty path", start+1)
	}
	op := patchOp{kind: patchAdd, path: path}
	i := start + 1
	for i < len(lines) {
		line := lines[i]
		if strings.HasPrefix(line, "*** ") {
			break
		}
		if !strings.HasPrefix(line, "+") {
			return patchOp{}, start, fmt.Errorf("add file line %d must start with +", i+1)
		}
		op.lines = append(op.lines, strings.TrimPrefix(line, "+"))
		i++
	}
	return op, i, nil
}

func parseUpdateFile(lines []string, start int) (patchOp, int, error) {
	path := strings.TrimSpace(strings.TrimPrefix(lines[start], "*** Update File: "))
	if path == "" {
		return patchOp{}, start, fmt.Errorf("update file header at line %d has empty path", start+1)
	}
	op := patchOp{kind: patchUpdate, path: path}
	i := start + 1
	for i < len(lines) {
		line := lines[i]
		if strings.HasPrefix(line, "*** ") {
			break
		}
		if strings.TrimSpace(line) == "" {
			i++
			continue
		}
		if strings.TrimSpace(line) != "@@" && !strings.HasPrefix(line, "@@ ") {
			return patchOp{}, start, fmt.Errorf("update file %s expected @@ hunk at line %d", path, i+1)
		}
		hunk, next, err := parseHunk(lines, i+1)
		if err != nil {
			return patchOp{}, start, err
		}
		op.hunks = append(op.hunks, hunk)
		i = next
	}
	if len(op.hunks) == 0 {
		return patchOp{}, start, fmt.Errorf("update file %s has no hunks", path)
	}
	return op, i, nil
}

func parseHunk(lines []string, start int) (patchHunk, int, error) {
	var oldLines, newLines []string
	var hunkLines []patchLine
	i := start
	for i < len(lines) {
		line := lines[i]
		if strings.HasPrefix(line, "*** ") || strings.TrimSpace(line) == "@@" || strings.HasPrefix(line, "@@ ") {
			break
		}
		if strings.HasPrefix(line, `\ No newline`) {
			i++
			continue
		}
		if line == "" {
			if i+1 >= len(lines) || strings.HasPrefix(lines[i+1], "*** ") ||
				strings.TrimSpace(lines[i+1]) == "@@" || strings.HasPrefix(lines[i+1], "@@ ") {
				break
			}
			return patchHunk{}, start, fmt.Errorf("hunk line %d is empty; use a leading space for blank context lines", i+1)
		}
		prefix := line[0]
		text := line[1:]
		switch prefix {
		case ' ':
			oldLines = append(oldLines, text)
			newLines = append(newLines, text)
		case '-':
			oldLines = append(oldLines, text)
		case '+':
			newLines = append(newLines, text)
		default:
			return patchHunk{}, start, fmt.Errorf("hunk line %d must start with space, -, or +", i+1)
		}
		hunkLines = append(hunkLines, patchLine{prefix: prefix, text: text})
		i++
	}
	if len(oldLines) == 0 {
		return patchHunk{}, start, fmt.Errorf("hunk starting at line %d has no context or removed lines", start+1)
	}
	return patchHunk{oldLines: oldLines, newLines: newLines, lines: hunkLines}, i, nil
}

// lineStyle records how a file's lines should be re-joined: whether it ended
// with a trailing newline and whether its line endings are CRLF. Matching is
// always done on \r-stripped lines so a patch authored with LF endings applies
// cleanly to a CRLF file; on write the original style is restored.
type lineStyle struct {
	trailingNewline bool
	crlf            bool
}

// splitContentLines splits file content into logical lines with \r stripped,
// and reports the file's line-ending style so it can be reconstructed. An empty
// file yields no lines. CRLF is detected as the dominant ending: a file counts
// as CRLF when it has at least one "\r\n" and no bare "\n" without a preceding
// "\r" (i.e. it isn't mixed toward LF).
func splitContentLines(content string) (lines []string, style lineStyle) {
	if content == "" {
		return nil, lineStyle{}
	}
	style.crlf = detectCRLF(content)
	style.trailingNewline = strings.HasSuffix(content, "\n")
	body := content
	if style.trailingNewline {
		body = strings.TrimSuffix(body, "\n")
	}
	raw := strings.Split(body, "\n")
	lines = make([]string, len(raw))
	for i, l := range raw {
		lines[i] = strings.TrimSuffix(l, "\r")
	}
	return lines, style
}

// detectCRLF reports whether content predominantly uses CRLF endings. A file is
// CRLF when every \n is preceded by \r (no bare LF). This keeps a single stray
// LF from forcing the whole file to LF, while still treating genuinely
// LF-dominant files as LF.
func detectCRLF(content string) bool {
	crlf := strings.Count(content, "\r\n")
	if crlf == 0 {
		return false
	}
	totalLF := strings.Count(content, "\n")
	return crlf == totalLF
}

// joinContentLines is the inverse of splitContentLines: it re-joins lines using
// the recorded style's separator and trailing-newline state.
func joinContentLines(lines []string, style lineStyle) string {
	sep := "\n"
	if style.crlf {
		sep = "\r\n"
	}
	if len(lines) == 0 {
		if style.trailingNewline {
			return sep
		}
		return ""
	}
	joined := strings.Join(lines, sep)
	if style.trailingNewline {
		joined += sep
	}
	return joined
}

func planPatch(ctx *Context, ops []patchOp) ([]patchPlan, error) {
	if len(ops) == 0 {
		return nil, errors.New("patch contains no operations")
	}
	type fileState struct {
		path    string
		absPath string
		content string
		mode    os.FileMode
		exists  bool
		delete  bool
		added   int
		removed int
	}
	states := map[string]*fileState{}
	order := []string{}

	getState := func(path string) (*fileState, error) {
		absPath, err := resolvePatchPath(ctx, path)
		if err != nil {
			return nil, err
		}
		key := absPath
		if state, ok := states[key]; ok {
			return state, nil
		}
		info, statErr := os.Stat(absPath)
		state := &fileState{path: path, absPath: absPath, mode: 0644}
		if statErr == nil {
			if info.IsDir() {
				return nil, fmt.Errorf("%s is a directory", path)
			}
			raw, err := os.ReadFile(absPath)
			if err != nil {
				return nil, err
			}
			state.content = string(raw)
			state.mode = info.Mode().Perm()
			state.exists = true
		} else if !os.IsNotExist(statErr) {
			return nil, statErr
		}
		states[key] = state
		order = append(order, key)
		return state, nil
	}

	for _, op := range ops {
		state, err := getState(op.path)
		if err != nil {
			return nil, err
		}
		switch op.kind {
		case patchAdd:
			if state.exists && !state.delete {
				return nil, fmt.Errorf("cannot add %s: file already exists", op.path)
			}
			// Added files end with a trailing newline (LF), matching the
			// convention that each "+" line in the patch is a full line of the
			// new file. New files default to LF regardless of other files in
			// the patch.
			state.content = joinContentLines(op.lines, lineStyle{trailingNewline: true})
			state.exists = true
			state.delete = false
			state.added += len(op.lines)
		case patchDelete:
			if !state.exists || state.delete {
				return nil, fmt.Errorf("cannot delete %s: file does not exist", op.path)
			}
			state.delete = true
			state.removed += countPatchLines(state.content)
		case patchUpdate:
			if !state.exists || state.delete {
				return nil, fmt.Errorf("cannot update %s: file does not exist", op.path)
			}
			for _, hunk := range op.hunks {
				next, removed, added, err := applyPatchHunk(state.content, hunk)
				if err != nil {
					return nil, fmt.Errorf("%s: %w", op.path, err)
				}
				state.content = next
				state.removed += removed
				state.added += added
			}
		}
	}

	plans := make([]patchPlan, 0, len(order))
	for _, key := range order {
		state := states[key]
		plans = append(plans, patchPlan{
			path:    state.path,
			absPath: state.absPath,
			content: state.content,
			mode:    state.mode,
			delete:  state.delete,
			added:   state.added,
			removed: state.removed,
		})
	}
	return plans, nil
}

// applyFinalNewline forces content to end with ("add") or without ("strip") a
// trailing newline, matching the content's dominant line ending (CRLF vs LF).
// Any other mode returns content unchanged.
func applyFinalNewline(content, mode string) string {
	switch mode {
	case "add":
		if content == "" {
			return content
		}
		if strings.HasSuffix(content, "\n") {
			return content
		}
		if detectCRLF(content) {
			return content + "\r\n"
		}
		return content + "\n"
	case "strip":
		content = strings.TrimSuffix(content, "\n")
		return strings.TrimSuffix(content, "\r")
	default:
		return content
	}
}

func resolvePatchPath(ctx *Context, path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", errors.New("path is required")
	}
	return ctx.ResolvePath(path)
}

// applyPatchHunk locates hunk.oldLines as a contiguous run of whole lines within
// content and replaces it with hunk.newLines. Matching is anchored to line
// boundaries, so a context line can never match the tail of a longer line or a
// substring inside a word. The match must be unique; otherwise the caller must
// supply more surrounding context.
func applyPatchHunk(content string, hunk patchHunk) (string, int, int, error) {
	if len(hunk.oldLines) == 0 {
		return "", 0, 0, errors.New("empty hunk context")
	}

	lines, endings, trailingNewline, style := splitContentLinesRaw(content)
	idx, count := findLineRun(lines, hunk.oldLines)
	fuzzyMatch := false
	if count == 0 {
		// Exact whole-line match failed. Fall back to comparing lines with
		// leading/trailing whitespace trimmed, which absorbs indentation
		// differences in the patch the model produced. Only accept it when the
		// trimmed match is unique, so we never guess between candidates.
		tIdx, tCount := findLineRunTrimmed(lines, hunk.oldLines)
		if tCount == 1 {
			idx = tIdx
			fuzzyMatch = true
		} else {
			return "", 0, 0, errors.New("hunk context not found")
		}
	} else if count > 1 {
		return "", 0, 0, errors.New("hunk context is ambiguous; add more surrounding context")
	}

	newLines := hunk.newLines
	if fuzzyMatch {
		newLines = materializeFuzzyHunkNewLines(lines[idx:idx+len(hunk.oldLines)], hunk)
	}

	// Splice the new region back over the matched run while leaving every line
	// the hunk did NOT touch byte-for-byte intact (mirrors edit.go's raw-splice
	// strategy). splitContentLines used to strip \r from every line and rejoin
	// with a single dominant separator — for a mixed-ending file that was
	// LF-dominant, untouched CRLF lines silently lost their \r. By rebuilding
	// the head/tail from the original per-line endings we touch only the
	// replaced lines. New/replacement lines use the dominant separator so a hunk
	// added to a CRLF file gets CRLF and to an LF file gets LF.
	sep := "\n"
	if style.crlf {
		sep = "\r\n"
	}
	var b strings.Builder
	// Head: lines before the match, with their original terminators preserved.
	for i := 0; i < idx; i++ {
		b.WriteString(lines[i])
		b.WriteString(endings[i])
	}
	// Replacement region. The terminator of the last replaced line follows the
	// terminator that the last matched line had on disk: if the match ran to the
	// final line of a file with no trailing newline, the replacement also ends
	// without one; otherwise each new line is separated by the dominant sep.
	lastMatched := idx + len(hunk.oldLines) - 1
	matchEndsFile := lastMatched == len(lines)-1
	lastMatchedHadTerminator := endings[lastMatched] != ""
	for i, nl := range newLines {
		b.WriteString(nl)
		isLastNew := i == len(newLines)-1
		if isLastNew {
			// Preserve "no trailing newline at EOF" only when the matched run
			// ended the file and that final line had no terminator.
			if matchEndsFile && !lastMatchedHadTerminator {
				// no terminator
			} else {
				b.WriteString(sep)
			}
		} else {
			b.WriteString(sep)
		}
	}
	// Tail: lines after the match, with their original terminators preserved.
	for i := idx + len(hunk.oldLines); i < len(lines); i++ {
		b.WriteString(lines[i])
		b.WriteString(endings[i])
	}
	_ = trailingNewline // retained for symmetry/clarity; EOF handling is per-line above

	return b.String(), len(hunk.oldLines), len(newLines), nil
}

// splitContentLinesRaw is like splitContentLines but also returns each line's
// original terminator ("\r\n", "\n", or "" for a final line with no trailing
// newline). The endings slice is parallel to lines. This lets the patch splice
// rebuild untouched regions byte-for-byte instead of forcing a single dominant
// separator across the whole file (which corrupted untouched lines in
// mixed-ending files). trailingNewline and style mirror splitContentLines.
func splitContentLinesRaw(content string) (lines []string, endings []string, trailingNewline bool, style lineStyle) {
	if content == "" {
		return nil, nil, false, lineStyle{}
	}
	style.crlf = detectCRLF(content)
	trailingNewline = strings.HasSuffix(content, "\n")
	style.trailingNewline = trailingNewline

	lines = make([]string, 0, strings.Count(content, "\n")+1)
	endings = make([]string, 0, cap(lines))
	rest := content
	for {
		nl := strings.IndexByte(rest, '\n')
		if nl < 0 {
			// Final segment with no trailing '\n'.
			line := rest
			ending := ""
			if strings.HasSuffix(line, "\r") {
				// A lone trailing '\r' with no '\n' is an odd ending; keep it as
				// part of the terminator so the line text matches the
				// \r-stripped logical form used elsewhere.
				line = strings.TrimSuffix(line, "\r")
				ending = "\r"
			}
			lines = append(lines, line)
			endings = append(endings, ending)
			break
		}
		segment := rest[:nl]
		ending := "\n"
		if strings.HasSuffix(segment, "\r") {
			segment = strings.TrimSuffix(segment, "\r")
			ending = "\r\n"
		}
		lines = append(lines, segment)
		endings = append(endings, ending)
		rest = rest[nl+1:]
		if rest == "" {
			// content ended exactly on a '\n'; there is no further line.
			break
		}
	}
	return lines, endings, trailingNewline, style
}

func materializeFuzzyHunkNewLines(matchedOldLines []string, hunk patchHunk) []string {
	if len(hunk.lines) == 0 {
		return hunk.newLines
	}
	out := make([]string, 0, len(hunk.newLines))
	oldIdx := 0
	// Fuzzy match fired because the patch's indentation differs from the file's.
	// Track the leading-whitespace delta between the patch's context lines and
	// the file's actual matched lines, and re-indent inserted '+' lines by the
	// same delta so they align with the file instead of keeping the patch's
	// (wrong) indentation — which would corrupt indentation-sensitive files.
	patchIndent, fileIndent := "", ""
	haveIndent := false
	for _, line := range hunk.lines {
		switch line.prefix {
		case ' ':
			if oldIdx < len(matchedOldLines) {
				matched := matchedOldLines[oldIdx]
				patchIndent = leadingWhitespace(line.text)
				fileIndent = leadingWhitespace(matched)
				haveIndent = true
				out = append(out, matched)
			} else {
				out = append(out, line.text)
			}
			oldIdx++
		case '-':
			oldIdx++
		case '+':
			out = append(out, reindentLine(line.text, patchIndent, fileIndent, haveIndent))
		}
	}
	return out
}

// leadingWhitespace returns the run of spaces/tabs at the start of s.
func leadingWhitespace(s string) string {
	i := 0
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	return s[:i]
}

// reindentLine swaps a '+' line's patch-derived base indent for the file's base
// indent, derived from the nearest matched context line. If the line doesn't
// start with the patch indent (or no context was seen yet), it's left as-is.
func reindentLine(text, patchIndent, fileIndent string, have bool) string {
	if !have || patchIndent == fileIndent {
		return text
	}
	if patchIndent != "" && strings.HasPrefix(text, patchIndent) {
		return fileIndent + text[len(patchIndent):]
	}
	if patchIndent == "" {
		return fileIndent + text
	}
	return text
}

// findLineRun returns the start index of the first occurrence of run within
// lines and the total number of (non-overlapping) occurrences. A zero count
// means run was not found.
func findLineRun(lines, run []string) (firstIdx, count int) {
	firstIdx = -1
	if len(run) == 0 || len(run) > len(lines) {
		return -1, 0
	}
	for i := 0; i+len(run) <= len(lines); {
		if linesEqual(lines[i:i+len(run)], run) {
			if firstIdx == -1 {
				firstIdx = i
			}
			count++
			i += len(run) // non-overlapping
			continue
		}
		i++
	}
	return firstIdx, count
}

func linesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// findLineRunTrimmed is like findLineRun but compares lines after trimming
// leading/trailing whitespace, so a hunk whose indentation differs from the
// file still matches. Used only as a fallback when the exact match fails.
func findLineRunTrimmed(lines, run []string) (firstIdx, count int) {
	firstIdx = -1
	if len(run) == 0 || len(run) > len(lines) {
		return -1, 0
	}
	for i := 0; i+len(run) <= len(lines); {
		if linesEqualTrimmed(lines[i:i+len(run)], run) {
			if firstIdx == -1 {
				firstIdx = i
			}
			count++
			i += len(run)
			continue
		}
		i++
	}
	return firstIdx, count
}

func linesEqualTrimmed(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if strings.TrimSpace(a[i]) != strings.TrimSpace(b[i]) {
			return false
		}
	}
	return true
}

func formatPatchSummary(plans []patchPlan, dryRun bool) string {
	var b strings.Builder
	if dryRun {
		b.WriteString("dry run: ")
	}
	b.WriteString(fmt.Sprintf("applied patch to %d file(s)", len(plans)))
	for _, plan := range plans {
		action := "updated"
		if plan.delete {
			action = "deleted"
		} else if plan.removed == 0 && plan.added > 0 {
			action = "added"
		}
		b.WriteString(fmt.Sprintf("\n- %s %s (+%d -%d)", action, plan.path, plan.added, plan.removed))
	}
	return b.String()
}

func countPatchLines(s string) int {
	if s == "" {
		return 0
	}
	trimmed := strings.TrimSuffix(s, "\n")
	if trimmed == "" {
		return 1
	}
	return strings.Count(trimmed, "\n") + 1
}
