package prompt

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

// TestProjectRulesInjectedFromClaudeMd verifies that a RootDir containing a
// CLAUDE.md has its content rendered into the prompt via {{PROJECT_RULES}}.
func TestProjectRulesInjectedFromClaudeMd(t *testing.T) {
	dir := t.TempDir()
	rule := "# Project Rules\n\nAlways use tabs, never spaces.\n"
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte(rule), 0644); err != nil {
		t.Fatal(err)
	}

	rendered := string(Render([]byte("intro {{PROJECT_RULES}} outro"), dir, nil))
	if !strings.Contains(rendered, "Always use tabs, never spaces.") {
		t.Fatalf("expected CLAUDE.md content in rendered prompt, got %q", rendered)
	}
	if !strings.Contains(rendered, "CLAUDE.md") {
		t.Fatalf("expected the rule file name to be labeled in the prompt, got %q", rendered)
	}
	if strings.Contains(rendered, projectRulesPlaceholder) {
		t.Fatalf("placeholder token must be substituted away, got %q", rendered)
	}
}

// TestProjectRulesFallsBackToAgentsMd verifies AGENTS.md is used when CLAUDE.md
// is absent.
func TestProjectRulesFallsBackToAgentsMd(t *testing.T) {
	dir := t.TempDir()
	rule := "Run go test ./... before every commit.\n"
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(rule), 0644); err != nil {
		t.Fatal(err)
	}

	got := BuildProjectRules(dir)
	if !strings.Contains(got, "Run go test ./... before every commit.") {
		t.Fatalf("expected AGENTS.md content, got %q", got)
	}
	if !strings.Contains(got, "AGENTS.md") {
		t.Fatalf("expected AGENTS.md label, got %q", got)
	}
}

// TestProjectRulesPrefersClaudeMdOverAgentsMd verifies CLAUDE.md wins when both
// exist.
func TestProjectRulesPrefersClaudeMdOverAgentsMd(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("from claude\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("from agents\n"), 0644); err != nil {
		t.Fatal(err)
	}
	got := BuildProjectRules(dir)
	if !strings.Contains(got, "from claude") || strings.Contains(got, "from agents") {
		t.Fatalf("expected CLAUDE.md to win over AGENTS.md, got %q", got)
	}
}

// TestProjectRulesEmptyWhenNoRuleFile verifies no leakage when neither file
// exists: BuildProjectRules returns empty and Render leaves no placeholder token
// nor any rule-section header behind.
func TestProjectRulesEmptyWhenNoRuleFile(t *testing.T) {
	dir := t.TempDir()
	if got := BuildProjectRules(dir); got != "" {
		t.Fatalf("expected empty project rules for a workspace with no rule file, got %q", got)
	}

	rendered := string(Render([]byte("intro {{PROJECT_RULES}} outro"), dir, nil))
	if strings.Contains(rendered, projectRulesPlaceholder) {
		t.Fatalf("placeholder token must be substituted away even when empty, got %q", rendered)
	}
	if strings.Contains(rendered, "项目规则") {
		t.Fatalf("no rule section header should appear when no rule file exists, got %q", rendered)
	}
}

// TestProjectRulesTruncatesOversizeFile verifies an oversized rule file is
// capped (no unbounded prompt growth) and marked as truncated.
func TestProjectRulesTruncatesOversizeFile(t *testing.T) {
	dir := t.TempDir()
	big := strings.Repeat("x", projectRulesMaxBytes+5000)
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte(big), 0644); err != nil {
		t.Fatal(err)
	}
	got := BuildProjectRules(dir)
	// The injected body must not contain the full oversized content. Allowing
	// for the section header, it should stay close to the cap, not the full size.
	if strings.Count(got, "x") > projectRulesMaxBytes {
		t.Fatalf("expected rule body capped at %d bytes, got %d x's", projectRulesMaxBytes, strings.Count(got, "x"))
	}
	if !strings.Contains(got, "截断") {
		t.Fatalf("expected truncation marker for oversize rule file, got tail %q", got[len(got)-80:])
	}
}

// TestProjectRulesRenderedThroughProfile verifies the profile render path (used
// by the live /prompt route) also substitutes {{PROJECT_RULES}}.
func TestProjectRulesRenderedThroughProfile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("profile-path rule\n"), 0644); err != nil {
		t.Fatal(err)
	}
	profile := Profile{ID: "p", Prompt: []byte("base {{PROJECT_RULES}} {{TOOLS}}")}
	rendered := string(profile.Render(dir, []tool.ToolInfo{{Name: "read_file", Description: "read"}}, nil))
	if !strings.Contains(rendered, "profile-path rule") {
		t.Fatalf("expected profile render to inject project rules, got %q", rendered)
	}
	if strings.Contains(rendered, projectRulesPlaceholder) {
		t.Fatalf("profile render must substitute the placeholder, got %q", rendered)
	}
}
