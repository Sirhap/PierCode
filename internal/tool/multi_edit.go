package tool

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/types"
)

// MultiEditTool applies several string replacements to a single file in one
// atomic operation. Each edit is applied in order to the running content; if
// any edit fails to match (or matches ambiguously), nothing is written. This
// saves the round trips of issuing many separate `edit` calls and guarantees
// the file is never left half-edited.
type MultiEditTool struct {
	config *types.Config
}

func NewMultiEditTool(config *types.Config) *MultiEditTool {
	return &MultiEditTool{config: config}
}

func (t *MultiEditTool) Name() string { return "multi_edit" }

func (t *MultiEditTool) Description() string {
	return "Apply multiple exact string replacements to one file atomically, in order. All edits must apply or none are written."
}

func (t *MultiEditTool) Parameters() interface{} {
	return map[string]string{
		"path":  "string (required) - file path",
		"edits": "array (required) - list of {old_string, new_string, replace_all?} applied in order",
	}
}

func (t *MultiEditTool) Validate(args map[string]interface{}) error {
	if p, ok := args["path"].(string); !ok || p == "" {
		return errors.New("path is required")
	}
	raw, ok := args["edits"].([]interface{})
	if !ok || len(raw) == 0 {
		return errors.New("edits must be a non-empty array")
	}
	for i, item := range raw {
		m, ok := item.(map[string]interface{})
		if !ok {
			return fmt.Errorf("edit %d must be an object", i)
		}
		if _, ok := m["old_string"].(string); !ok {
			return fmt.Errorf("edit %d: old_string is required", i)
		}
		if _, ok := m["new_string"].(string); !ok {
			return fmt.Errorf("edit %d: new_string is required", i)
		}
	}
	return nil
}

type multiEditOp struct {
	oldStr     string
	newStr     string
	replaceAll bool
}

func (t *MultiEditTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()

	path, _ := ctx.Args["path"].(string)
	ops, err := parseMultiEditOps(ctx.Args["edits"])
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	safePath, err := ctx.ResolvePath(path)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	rawContent, err := os.ReadFile(safePath)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	// Operate on LF-normalized content so edits authored with LF line endings
	// match regardless of the file's on-disk endings, then restore the file's
	// dominant ending on write (mirrors apply_patch). This keeps multi_edit
	// atomic: every op runs against the in-memory string and we only touch
	// disk after all succeed.
	original := string(rawContent)
	content := normalizeLineEndings(original)
	style := lineStyleOf(original)

	total := 0
	for i, op := range ops {
		next, count, err := replace(content, op.oldStr, op.newStr, op.replaceAll)
		if err != nil {
			result.Status = "error"
			result.Error = fmt.Sprintf("edit %d: %s", i, err.Error())
			return result
		}
		content = next
		total += count
	}

	out := restoreLineStyle(content, style)
	// Snapshot the prior state before writing so `undo` can restore it.
	_ = snapshotPaths(ctx.EffectiveRootDir(), "multi_edit", safePath)
	if err := os.WriteFile(safePath, []byte(out), 0644); err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}

	result.Status = "success"
	result.Output = fmt.Sprintf("已对 %s 应用 %d 处编辑（共 %d 次替换）", path, len(ops), total)
	return result
}

func parseMultiEditOps(raw interface{}) ([]multiEditOp, error) {
	list, ok := raw.([]interface{})
	if !ok || len(list) == 0 {
		return nil, errors.New("edits must be a non-empty array")
	}
	ops := make([]multiEditOp, 0, len(list))
	for i, item := range list {
		m, ok := item.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("edit %d must be an object", i)
		}
		oldStr, _ := m["old_string"].(string)
		newStr, _ := m["new_string"].(string)
		replaceAll, _ := m["replace_all"].(bool)
		ops = append(ops, multiEditOp{oldStr: oldStr, newStr: newStr, replaceAll: replaceAll})
	}
	return ops, nil
}

// lineStyleOf reports a file's dominant line-ending style for round-tripping.
// Reuses apply_patch's detection so multi_edit and apply_patch agree.
func lineStyleOf(content string) lineStyle {
	return lineStyle{
		trailingNewline: strings.HasSuffix(content, "\n"),
		crlf:            detectCRLF(content),
	}
}

// restoreLineStyle converts LF-normalized content back to the file's original
// ending style. trailingNewline is already encoded in the content itself
// (normalizeLineEndings preserves a trailing \n), so we only swap separators.
func restoreLineStyle(lfContent string, style lineStyle) string {
	if !style.crlf {
		return lfContent
	}
	// Collapse any CRLF that entered via a replacement's new_string (the model may
	// author a block with literal \r\n) back to LF first, so the single \n→\r\n
	// expansion below doesn't double it into \r\r\n on CRLF files.
	lfContent = strings.ReplaceAll(lfContent, "\r\n", "\n")
	return strings.ReplaceAll(lfContent, "\n", "\r\n")
}
