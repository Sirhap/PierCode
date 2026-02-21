package skill

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGet(t *testing.T) {
	root := t.TempDir()
	skillDir := filepath.Join(root, ".skills")
	os.MkdirAll(skillDir, 0755)

	t.Run("finds subdir skill", func(t *testing.T) {
		sub := filepath.Join(skillDir, "mysub")
		os.MkdirAll(sub, 0755)
		os.WriteFile(filepath.Join(sub, "SKILL.md"), []byte("---\nname: mysub\ndescription: test\n---\n"), 0644)
		info, ok := Get(root, "mysub")
		if !ok || info.Name != "mysub" || info.Location == "" {
			t.Errorf("got ok=%v info=%+v", ok, info)
		}
	})

	t.Run("path traversal blocked", func(t *testing.T) {
		_, ok := Get(root, "../../etc/passwd")
		if ok {
			t.Error("expected not found for path traversal")
		}
	})

	t.Run("unknown skill returns false", func(t *testing.T) {
		_, ok := Get(root, "nonexistent")
		if ok {
			t.Error("expected not found")
		}
	})
}

func TestLoadInfos(t *testing.T) {
	root := t.TempDir()
	skillDir := filepath.Join(root, ".skills", "myskill")
	os.MkdirAll(skillDir, 0755)
	os.WriteFile(filepath.Join(skillDir, "skill.md"), []byte("---\nname: myskill\ndescription: does stuff\n---\n"), 0644)

	infos := LoadInfos(root)
	if len(infos) == 0 {
		t.Fatal("expected at least one skill")
	}
	found := false
	for _, info := range infos {
		if info.Name == "myskill" && info.Description == "does stuff" {
			found = true
		}
	}
	if !found {
		t.Errorf("skill not found in %+v", infos)
	}
}
