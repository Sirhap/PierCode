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

func TestParseFoldedDescription(t *testing.T) {
	path := filepath.Join(t.TempDir(), "caveman", "SKILL.md")
	info := parse(path, "---\nname: caveman\ndescription: >\n  Ultra-compressed communication mode.\n  Keeps technical accuracy.\n---\n")

	if info.Name != "caveman" {
		t.Fatalf("expected name caveman, got %q", info.Name)
	}
	if want := "Ultra-compressed communication mode. Keeps technical accuracy."; info.Description != want {
		t.Fatalf("expected folded description %q, got %q", want, info.Description)
	}
}

func TestSkillDirsIncludesUserAgentsSkills(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}

	want := filepath.Join(home, ".agents", "skills")
	found := false
	for _, dir := range SkillDirs(t.TempDir()) {
		if dir == want {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected user agents skills dir %q in SkillDirs", want)
	}
}

func TestLoadInfosCaching(t *testing.T) {
	root := t.TempDir()
	mk := func(name string) {
		dir := filepath.Join(root, ".skills", name)
		os.MkdirAll(dir, 0755)
		os.WriteFile(filepath.Join(dir, "SKILL.md"),
			[]byte("---\nname: "+name+"\ndescription: x\n---\n"), 0644)
	}

	mk("first")
	if got := len(LoadInfos(root)); got < 1 {
		t.Fatalf("expected 1 skill, got %d", got)
	}

	// Add a second skill. Without invalidation the cache still serves the old
	// listing (proves caching is active).
	mk("second")
	if got := len(LoadInfos(root)); got < 1 {
		t.Errorf("expected cached listing of 1, got %d", got)
	}

	// After invalidation the new skill is visible.
	InvalidateCache(root)
	infos := LoadInfos(root)
	found := map[string]bool{}
	for _, info := range infos {
		found[info.Name] = true
	}
	if !found["first"] || !found["second"] {
		t.Errorf("expected first and second skills after invalidate, got %+v", infos)
	}
}

func TestProjectPierCodeSkillsAreDiscoverable(t *testing.T) {
	repoRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}

	infos := LoadInfos(repoRoot)
	found := map[string]bool{}
	for _, info := range infos {
		found[info.Name] = true
	}

	for _, name := range []string{
		"piercode-platforms",
		"piercode-tool-protocol",
		"piercode-security",
		"piercode-edit-test",
		"piercode-self-dev",
		"piercode-code-review",
		"piercode-debug",
		"piercode-safe-shell",
	} {
		if !found[name] {
			t.Errorf("expected project skill %q to be discoverable; got %+v", name, infos)
		}
	}
}
