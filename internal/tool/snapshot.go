package tool

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sirhap/piercode/internal/security"
)

// Snapshot infrastructure: before a destructive write (write_file overwrite,
// edit, multi_edit, apply_patch, move) we record the prior state of each
// touched file so the `undo` tool can restore it. Snapshots live under
// <root>/.piercode/snapshots/ (already gitignored) and are pruned to a bounded
// count so a long session can't fill the disk.

const (
	snapshotDirName  = "snapshots"
	piercodeDirName  = ".piercode"
	maxSnapshots     = 100
	snapshotManifest = "manifest.json"
)

var snapshotSeq struct {
	sync.Mutex
	n uint64
}

// SnapshotEntry is one recorded change to one path.
type SnapshotEntry struct {
	ID       string `json:"id"`
	RelPath  string `json:"rel_path"` // path relative to root, for display + restore
	AbsPath  string `json:"abs_path"`
	Op       string `json:"op"`      // tool that caused it: edit, write_file, move, ...
	Existed  bool   `json:"existed"` // false → undo means delete the created file
	Backup   string `json:"backup"`  // backup file name inside the snapshot dir (empty if !Existed)
	ModeBits uint32 `json:"mode"`
	When     int64  `json:"when_unix_nano"`
}

func snapshotRoot(rootDir string) string {
	return filepath.Join(rootDir, piercodeDirName, snapshotDirName)
}

// isInsideSnapshotDir reports whether absPath lives under the snapshot tree, so
// snapshotting never recurses on its own backups.
func isInsideSnapshotDir(rootDir, absPath string) bool {
	root := snapshotRoot(rootDir)
	return absPath == root || strings.HasPrefix(absPath, root+string(filepath.Separator))
}

// snapshotPaths records the pre-edit state of the given absolute paths under
// rootDir. It is best-effort: a failure to snapshot never blocks the actual
// edit (the caller still proceeds), but is returned so callers may log it.
// Paths inside the snapshot dir itself are skipped.
func snapshotPaths(rootDir, op string, absPaths ...string) error {
	if rootDir == "" || len(absPaths) == 0 {
		return nil
	}
	id := newSnapshotID()
	dir := filepath.Join(snapshotRoot(rootDir), id)
	var entries []SnapshotEntry

	for i, abs := range absPaths {
		if abs == "" || isInsideSnapshotDir(rootDir, abs) {
			continue
		}
		rel, err := filepath.Rel(rootDir, abs)
		if err != nil {
			rel = abs
		}
		entry := SnapshotEntry{
			ID:      id,
			RelPath: filepath.ToSlash(rel),
			AbsPath: abs,
			Op:      op,
			When:    time.Now().UnixNano(),
		}
		info, statErr := os.Stat(abs)
		if statErr == nil && !info.IsDir() {
			if err := os.MkdirAll(dir, 0755); err != nil {
				return err
			}
			raw, err := os.ReadFile(abs)
			if err != nil {
				continue // skip files we can't read; snapshot remaining files
			}
			backupName := fmt.Sprintf("%d.bak", i)
			if err := os.WriteFile(filepath.Join(dir, backupName), raw, 0644); err != nil {
				return err
			}
			entry.Existed = true
			entry.Backup = backupName
			entry.ModeBits = uint32(info.Mode().Perm())
		} else if statErr == nil && info.IsDir() {
			// Directories (e.g. moving a dir) are not backed up byte-for-byte;
			// record existence so undo can at least report it. Skip for now.
			continue
		}
		// statErr != nil → file does not exist yet; record so undo can delete
		// a newly created file.
		entries = append(entries, entry)
	}

	if len(entries) == 0 {
		return nil
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	if err := writeSnapshotManifest(dir, entries); err != nil {
		return err
	}
	pruneSnapshots(rootDir)
	return nil
}

func newSnapshotID() string {
	snapshotSeq.Lock()
	snapshotSeq.n++
	n := snapshotSeq.n
	snapshotSeq.Unlock()
	return fmt.Sprintf("%d_%d", time.Now().UnixNano(), n)
}

func writeSnapshotManifest(dir string, entries []SnapshotEntry) error {
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, snapshotManifest), data, 0644)
}

func readSnapshotManifest(dir string) ([]SnapshotEntry, error) {
	raw, err := os.ReadFile(filepath.Join(dir, snapshotManifest))
	if err != nil {
		return nil, err
	}
	var entries []SnapshotEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, err
	}
	return entries, nil
}

// listSnapshotIDs returns snapshot directory names sorted newest-first.
func listSnapshotIDs(rootDir string) []string {
	root := snapshotRoot(rootDir)
	ents, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	ids := make([]string, 0, len(ents))
	for _, e := range ents {
		if e.IsDir() {
			ids = append(ids, e.Name())
		}
	}
	// IDs are "<unixnano>_<seq>"; lexical sort on the numeric prefix is wrong
	// for varying widths, so sort by parsed components.
	sort.Slice(ids, func(i, j int) bool {
		return snapshotIDLess(ids[j], ids[i]) // reverse → newest first
	})
	return ids
}

// snapshotIDLess orders snapshot IDs by their (timestamp, seq) components.
func snapshotIDLess(a, b string) bool {
	at, aseq := splitSnapshotID(a)
	bt, bseq := splitSnapshotID(b)
	if at != bt {
		return at < bt
	}
	return aseq < bseq
}

func splitSnapshotID(id string) (int64, uint64) {
	parts := strings.SplitN(id, "_", 2)
	if len(parts) != 2 {
		return 0, 0
	}
	// strconv is ~11x cheaper than fmt.Sscanf here, and this runs once per
	// snapshot dir on every prune (i.e. after every edit/write). Malformed
	// parts yield 0, matching the old Sscanf-on-error behavior, so ordering
	// semantics are unchanged.
	ts, _ := strconv.ParseInt(parts[0], 10, 64)
	seq, _ := strconv.ParseUint(parts[1], 10, 64)
	return ts, seq
}

// pruneSnapshots removes the oldest snapshot directories beyond maxSnapshots.
func pruneSnapshots(rootDir string) {
	ids := listSnapshotIDs(rootDir) // newest first
	if len(ids) <= maxSnapshots {
		return
	}
	root := snapshotRoot(rootDir)
	for _, id := range ids[maxSnapshots:] {
		_ = os.RemoveAll(filepath.Join(root, id))
	}
}

// revertSnapshot restores every file recorded in the snapshot to its prior
// state and then removes the snapshot. Returns a human-readable summary of what
// was restored.
func revertSnapshot(rootDir, id string) (string, error) {
	dir := filepath.Join(snapshotRoot(rootDir), id)
	entries, err := readSnapshotManifest(dir)
	if err != nil {
		return "", fmt.Errorf("snapshot %s not found", id)
	}
	var restored []string
	for _, e := range entries {
		// Never trust the AbsPath stored in the manifest blindly: a manifest can
		// be forged inside the sandbox (write_file into .piercode/snapshots/<id>/)
		// to point AbsPath anywhere on disk, and a snapshot captured under a
		// different rootDir would otherwise write outside the current sandbox.
		// SafeAbsPath re-resolves symlinks on both sides and requires the target
		// to stay within the current rootDir, rejecting both attacks. Backup is
		// restricted to a single segment inside the snapshot dir for the same
		// reason.
		safeAbs, err := security.SafeAbsPath(e.AbsPath, rootDir)
		if err != nil {
			return "", fmt.Errorf("snapshot entry %s escapes sandbox: %w", e.RelPath, err)
		}
		if e.Existed {
			if err := validateSnapshotID(e.Backup); err != nil {
				return "", fmt.Errorf("invalid backup name for %s", e.RelPath)
			}
			raw, err := os.ReadFile(filepath.Join(dir, e.Backup))
			if err != nil {
				return "", fmt.Errorf("backup missing for %s: %w", e.RelPath, err)
			}
			mode := os.FileMode(e.ModeBits)
			if mode == 0 {
				mode = 0644
			}
			if err := os.MkdirAll(filepath.Dir(safeAbs), 0755); err != nil {
				return "", err
			}
			if err := os.WriteFile(safeAbs, raw, mode); err != nil {
				return "", err
			}
			restored = append(restored, "restored "+e.RelPath)
		} else {
			// File was created by the edit; undo means removing it.
			if err := os.Remove(safeAbs); err != nil && !os.IsNotExist(err) {
				return "", err
			}
			restored = append(restored, "removed "+e.RelPath)
		}
	}
	_ = os.RemoveAll(dir)
	return strings.Join(restored, "\n"), nil
}
