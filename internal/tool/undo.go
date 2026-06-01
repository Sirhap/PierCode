package tool

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/sirhap/piercode/internal/types"
)

// UndoTool lists and reverts file snapshots taken before destructive edits
// (write_file, edit, multi_edit, apply_patch, move). With action="list" (the
// default) it shows recent snapshots newest-first; with action="revert" it
// restores a snapshot — the most recent one if no id is given — and removes it.
type UndoTool struct {
	config *types.Config
}

func NewUndoTool(config *types.Config) *UndoTool {
	return &UndoTool{config: config}
}

func (t *UndoTool) Name() string { return "undo" }

func (t *UndoTool) Description() string {
	return "List or revert file snapshots taken before edits. action=list (default) or action=revert with optional id (defaults to the most recent)."
}

func (t *UndoTool) Parameters() interface{} {
	return map[string]string{
		"action": "string (optional) - 'list' (default) or 'revert'",
		"id":     "string (optional) - snapshot id to revert; defaults to the most recent",
	}
}

func (t *UndoTool) Validate(args map[string]interface{}) error {
	if v, ok := args["action"]; ok && v != nil {
		s, ok := v.(string)
		if !ok {
			return errors.New("action must be a string")
		}
		if s != "" && s != "list" && s != "revert" {
			return errors.New("action must be 'list' or 'revert'")
		}
	}
	return nil
}

func (t *UndoTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}
	defer func() { result.EndTime = time.Now() }()

	rootDir := ctx.EffectiveRootDir()
	if rootDir == "" {
		result.Status = "error"
		result.Error = "no workspace root"
		return result
	}

	action, _ := ctx.Args["action"].(string)
	if action == "" {
		action = "list"
	}
	id, _ := ctx.Args["id"].(string)
	id = strings.TrimSpace(id)

	if action == "list" {
		result.Status = "success"
		result.Output = formatSnapshotList(rootDir)
		return result
	}

	// revert
	if id == "" {
		ids := listSnapshotIDs(rootDir)
		if len(ids) == 0 {
			result.Status = "error"
			result.Error = "no snapshots to revert"
			return result
		}
		id = ids[0] // newest
	}
	summary, err := revertSnapshot(rootDir, id)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	result.Status = "success"
	result.Output = fmt.Sprintf("已回滚快照 %s:\n%s", id, summary)
	return result
}

// formatSnapshotList renders recent snapshots newest-first for display.
func formatSnapshotList(rootDir string) string {
	ids := listSnapshotIDs(rootDir)
	if len(ids) == 0 {
		return "No snapshots. Edits create snapshots automatically; use undo with action=revert to roll one back."
	}
	const limit = 30
	var b strings.Builder
	b.WriteString("Snapshots (newest first):\n")
	for i, id := range ids {
		if i >= limit {
			b.WriteString(fmt.Sprintf("... (%d more)\n", len(ids)-limit))
			break
		}
		entries, err := readSnapshotForDisplay(rootDir, id)
		if err != nil {
			b.WriteString(fmt.Sprintf("- %s (unreadable)\n", id))
			continue
		}
		paths := make([]string, 0, len(entries))
		op := ""
		var when int64
		for _, e := range entries {
			paths = append(paths, e.RelPath)
			op = e.Op
			when = e.When
		}
		ts := time.Unix(0, when).Format("15:04:05")
		b.WriteString(fmt.Sprintf("- %s  [%s %s]  %s\n", id, op, ts, strings.Join(paths, ", ")))
	}
	b.WriteString("\nRevert with: undo action=revert id=<id> (omit id for the most recent).")
	return b.String()
}

// readSnapshotForDisplay reads a snapshot's manifest for listing.
func readSnapshotForDisplay(rootDir, id string) ([]SnapshotEntry, error) {
	return readSnapshotManifest(filepath.Join(snapshotRoot(rootDir), id))
}
