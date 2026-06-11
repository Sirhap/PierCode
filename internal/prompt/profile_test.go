package prompt

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/skill"
	"github.com/sirhap/piercode/internal/tool"
	"github.com/sirhap/piercode/prompts"
)

func TestProfileRegistryFallsBackToDefault(t *testing.T) {
	registry := NewProfileRegistry([]byte("system\n{{TOOLS}}"))
	profile := registry.Select("unknown-adapter")

	if profile.ID != DefaultProfileID {
		t.Fatalf("expected default profile for unknown adapter, got %q", profile.ID)
	}

	rendered := string(profile.Render("C:/repo", []tool.ToolInfo{{
		Name:        "read_file",
		Description: "read a file",
	}}, nil))
	if !strings.Contains(rendered, "read_file") {
		t.Fatalf("expected default prompt to render all tools, got %q", rendered)
	}
}

func TestProfileCanAppendWithoutReplacingDefaultPrompt(t *testing.T) {
	profile := Profile{
		ID:           "qwen",
		Prompt:       []byte("base {{TOOLS}}"),
		PromptAppend: []byte("append {{TOOLS}}"),
	}

	rendered := string(profile.Render("C:/repo", []tool.ToolInfo{{
		Name:        "grep",
		Description: "search files",
	}}, nil))
	if !strings.Contains(rendered, "base") || !strings.Contains(rendered, "append") {
		t.Fatalf("expected base and append prompt content, got %q", rendered)
	}
	if strings.Count(rendered, "grep") < 2 {
		t.Fatalf("expected placeholders in base and append to render tools, got %q", rendered)
	}
}

func TestProfilePromptOverridesDefaultWhenRegistered(t *testing.T) {
	registry := NewProfileRegistry([]byte("default {{TOOLS}}"))
	registry.Register(Profile{
		ID:     "locked",
		Prompt: []byte("override {{TOOLS}}"),
	})

	rendered := string(registry.Select("locked").Render("C:/repo", []tool.ToolInfo{{
		Name:        "read_file",
		Description: "read",
	}}, nil))
	if strings.Contains(rendered, "default") {
		t.Fatalf("expected override prompt to replace default, got %q", rendered)
	}
	if !strings.Contains(rendered, "override") || !strings.Contains(rendered, "read_file") {
		t.Fatalf("expected override prompt to render, got %q", rendered)
	}
}

func TestRenderedToolDocsDoNotIncludeExecutableToolFenceExamples(t *testing.T) {
	rendered := string(Render([]byte("{{TOOLS}}"), "C:/repo", []tool.ToolInfo{{
		Name:        "browser_snapshot",
		Description: "snapshot page",
		Parameters:  map[string]string{"tabId": "optional tab id"},
	}}))

	if strings.Contains(rendered, "```piercode-tool") || strings.Contains(rendered, "```tool") {
		t.Fatalf("rendered tool docs must not include executable tool-call examples, got %q", rendered)
	}
	if !strings.Contains(rendered, "browser_snapshot") || !strings.Contains(rendered, "name") || !strings.Contains(rendered, "call_id") || !strings.Contains(rendered, "args") {
		t.Fatalf("rendered tool docs should still describe the protocol fields, got %q", rendered)
	}
	if !strings.Contains(rendered, "`text` fence") {
		t.Fatalf("rendered tool docs should direct non-executed examples to text fences, got %q", rendered)
	}
}

func TestRenderedToolDocsAreCompactRouteIndex(t *testing.T) {
	rendered := string(Render([]byte("{{TOOLS}}"), "C:/repo", []tool.ToolInfo{{
		Name:        "browser_snapshot",
		Description: "snapshot page",
		Parameters:  map[string]string{"tabId": "optional tab id"},
	}}))

	if !strings.Contains(rendered, "compact route index") || !strings.Contains(rendered, "tool_help") {
		t.Fatalf("rendered tool docs should route detailed docs through tool_help, got %q", rendered)
	}
	if strings.Contains(rendered, "optional tab id") {
		t.Fatalf("rendered tool docs should not inline detailed parameter docs, got %q", rendered)
	}
}

func TestRenderedToolDocsUseCurrentArgumentNames(t *testing.T) {
	doc := BuildToolsDoc([]tool.ToolInfo{
		{Name: "skill", Description: "load skill"},
		{Name: "tool_help", Description: "show help"},
	})

	if !strings.Contains(doc, "`tool_help` uses {\"tool\":\"list_dir\"}") || !strings.Contains(doc, "`skill` uses {\"skill\":\"piercode-tool-protocol\"}") {
		t.Fatalf("expected current argument names in tool docs, got:\n%s", doc)
	}
	if strings.Contains(doc, "{\"name\":\"list_dir\"}") || strings.Contains(doc, "{\"name\":\"piercode-tool-protocol\"}") {
		t.Fatalf("rendered tool docs must not advertise stale name args, got:\n%s", doc)
	}
}

func TestBrowserToolsCollapseIntoCategoryLine(t *testing.T) {
	var tools []tool.ToolInfo
	tools = append(tools,
		tool.ToolInfo{Name: "read_file", Description: "read a file"},
		tool.ToolInfo{Name: "exec_cmd", Description: "run a command"},
	)
	for _, n := range []string{"browser_click", "browser_type", "browser_snapshot", "browser_navigate", "browser_wait"} {
		tools = append(tools, tool.ToolInfo{Name: n, Description: "browser op " + n})
	}

	doc := BuildToolsDoc(tools)

	// Core tools still listed individually.
	if !strings.Contains(doc, "`read_file`") || !strings.Contains(doc, "`exec_cmd`") {
		t.Fatalf("core tools must stay listed, got:\n%s", doc)
	}
	// Browser tools collapse: no per-tool line, one category pointer instead.
	if strings.Contains(doc, "`browser_click`") || strings.Contains(doc, "`browser_snapshot`") {
		t.Fatalf("browser tools should be collapsed, not listed individually, got:\n%s", doc)
	}
	if !strings.Contains(doc, "browser_") || !strings.Contains(doc, "tool_help") {
		t.Fatalf("expected a browser_* category pointer routed through tool_help, got:\n%s", doc)
	}
	// The count should be surfaced so the model knows how many exist.
	if !strings.Contains(doc, "5") {
		t.Fatalf("expected browser tool count in the category line, got:\n%s", doc)
	}
}

func TestFewBrowserToolsNotCollapsed(t *testing.T) {
	// Below the threshold, keep them inline — collapsing 1-2 tools saves nothing
	// and hides them for no benefit.
	tools := []tool.ToolInfo{
		{Name: "read_file", Description: "read"},
		{Name: "browser_click", Description: "click"},
	}
	doc := BuildToolsDoc(tools)
	if !strings.Contains(doc, "`browser_click`") {
		t.Fatalf("a single browser tool should stay listed, got:\n%s", doc)
	}
}

func TestRenderBodyCacheReusesAndBustsCorrectly(t *testing.T) {
	// Use a tool name that does NOT appear in BuildToolsDoc's static schema
	// footer, so a presence check actually reflects the tool list.
	p := Profile{ID: "cachetest", Prompt: []byte("body {{TOOLS}} {{SYSTEM_INFO}}")}
	toolsA := []tool.ToolInfo{{Name: "read_file", Description: "read"}}
	toolsB := []tool.ToolInfo{{Name: "read_file", Description: "read"}, {Name: "zzz_unique_tool", Description: "search"}}

	b1 := p.renderBodyCached("/repo", toolsA, nil)
	b2 := p.renderBodyCached("/repo", toolsA, nil)
	// Same inputs → identical backing slice returned from cache.
	if &b1[0] != &b2[0] {
		t.Error("expected cache hit to return the same cached slice")
	}

	// Different tool set → cache miss → different content (includes the new tool).
	b3 := p.renderBodyCached("/repo", toolsB, nil)
	if strings.Contains(string(b1), "zzz_unique_tool") {
		t.Error("toolsA body should not contain the toolsB-only tool")
	}
	if !strings.Contains(string(b3), "zzz_unique_tool") {
		t.Error("toolsB body should contain its tool")
	}

	// The cached body keeps the SYSTEM_INFO placeholder so Render can re-stamp it.
	if !strings.Contains(string(b1), systemInfoPlaceholder) {
		t.Error("cached body must retain {{SYSTEM_INFO}} for fresh timestamping")
	}
	full := string(p.Render("/repo", toolsA, nil))
	if strings.Contains(full, systemInfoPlaceholder) {
		t.Error("Render output must have substituted {{SYSTEM_INFO}}")
	}
	if !strings.Contains(full, "工作目录") {
		t.Error("Render output should contain rendered system info")
	}
}

func TestProfileRegistryCanFilterToolsAndSkills(t *testing.T) {
	registry := NewProfileRegistry([]byte("default {{TOOLS}}"))
	registry.Register(Profile{
		ID:         "claude",
		Prompt:     []byte("custom {{TOOLS}}"),
		ToolNames:  []string{"read_file"},
		SkillNames: []string{"debug"},
	})

	profile := registry.Select(" CLAUDE ")
	tools := []tool.ToolInfo{
		{Name: "read_file", Description: "read"},
		{Name: "write_file", Description: "write"},
	}
	skills := []skill.Info{
		{Name: "debug", Description: "debugging"},
		{Name: "deploy", Description: "deployment"},
	}

	rendered := string(profile.Render("C:/repo", tools, skills))
	if !strings.Contains(rendered, "custom") {
		t.Fatalf("expected custom prompt, got %q", rendered)
	}
	if !strings.Contains(rendered, "read_file") || strings.Contains(rendered, "write_file") {
		t.Fatalf("expected only read_file to be rendered, got %q", rendered)
	}
	if !strings.Contains(rendered, "debugging") || strings.Contains(rendered, "deployment") {
		t.Fatalf("expected only debug skill to be rendered, got %q", rendered)
	}
}

func TestSkillsSubstituteAtPlaceholderWhenPresent(t *testing.T) {
	profile := Profile{
		ID:     "default",
		Prompt: []byte("guidance\n{{SKILLS}}\ntail"),
	}
	skills := []skill.Info{
		{Name: "debug", Description: "debugging"},
		{Name: "deploy", Description: "deployment"},
	}

	rendered := string(profile.Render("C:/repo", nil, skills))
	if strings.Contains(rendered, skillsPlaceholder) {
		t.Fatalf("placeholder must be substituted, got %q", rendered)
	}
	if strings.Contains(rendered, "## 当前可用 Skills") {
		t.Fatalf("placeholder mode should not add the append-only heading, got %q", rendered)
	}
	// List sits between the guidance and the tail, not at the very end.
	gi := strings.Index(rendered, "guidance")
	di := strings.Index(rendered, "debugging")
	ti := strings.Index(rendered, "tail")
	if !(gi < di && di < ti) {
		t.Fatalf("skills list should render at the placeholder position, got %q", rendered)
	}
}

func TestSkillsAppendAtEndWhenNoPlaceholder(t *testing.T) {
	profile := Profile{
		ID:     "default",
		Prompt: []byte("body without placeholder"),
	}
	skills := []skill.Info{{Name: "debug", Description: "debugging"}}

	rendered := string(profile.Render("C:/repo", nil, skills))
	if !strings.Contains(rendered, "## 当前可用 Skills") || !strings.Contains(rendered, "debugging") {
		t.Fatalf("expected skills appended at end for templates without placeholder, got %q", rendered)
	}
}

func TestSkillsListUsesConciseDescriptions(t *testing.T) {
	skills := []skill.Info{{
		Name:        "debug",
		Description: "First sentence. Second sentence with noisy trigger details that should not be rendered.",
	}}

	doc := buildSkillsList(skills)
	if !strings.Contains(doc, "`debug`: First sentence.") {
		t.Fatalf("expected concise skill description, got %q", doc)
	}
	if strings.Contains(doc, "Second sentence") {
		t.Fatalf("expected later sentence to be omitted, got %q", doc)
	}
}

func TestGuidanceDoesNotReinjectFullPromptWhenDisabled(t *testing.T) {
	profile := Profile{Prompt: []byte("full prompt")}
	renderFull := func() []byte { return []byte("rendered full prompt") }

	// Even at turn 20 — the old reinjection trigger — the full prompt must not
	// be re-embedded now that the cadence is disabled.
	for _, n := range []int64{20, 40, 60} {
		guidance := profile.GuidanceFor(n, renderFull)
		if strings.Contains(guidance, "系统重新注入提示词") || strings.Contains(guidance, "rendered full prompt") {
			t.Fatalf("full prompt reinjection should be disabled at n=%d, got %q", n, guidance)
		}
	}

	// Turn 1 always primes the protocol with the compact operating reminder.
	first := profile.GuidanceFor(1, renderFull)
	if !strings.Contains(first, "piercode-tool") || !strings.Contains(first, "tool_help") {
		t.Fatalf("turn 1 should carry the compact operating reminder, got %q", first)
	}
}

func TestOperatingReminderCadence(t *testing.T) {
	profile := Profile{Prompt: []byte("full prompt")}
	renderFull := func() []byte { return nil }
	const marker = "[系统提示]"
	// Cadence is 1: every guidance-bearing turn carries the operating reminder.
	for _, on := range []int64{1, 2, 3, 4, 5, 7, 10} {
		if !strings.Contains(profile.GuidanceFor(on, renderFull), marker) {
			t.Fatalf("turn %d should carry operating reminder", on)
		}
	}
}

func TestEmbeddedDefaultPromptSubstitutesSkillsPlaceholder(t *testing.T) {
	registry := DefaultProfileRegistry(prompts.DefaultPrompt)
	rendered := string(registry.Select("").Render("C:/repo", nil, []skill.Info{
		{Name: "piercode-debug", Description: "diagnose runtime failures"},
	}))
	if strings.Contains(rendered, skillsPlaceholder) {
		t.Fatalf("embedded prompt left an unsubstituted {{SKILLS}} placeholder")
	}
	if !strings.Contains(rendered, "piercode-debug") {
		t.Fatalf("embedded prompt should render the injected skills, got tail %q", tail(rendered))
	}
}

func TestWorkerProfileCarriesResultPacketContract(t *testing.T) {
	registry := DefaultProfileRegistry(prompts.DefaultPrompt)
	profile := registry.Select("worker")
	if profile.ID != "worker" {
		t.Fatalf("expected worker profile, got %q", profile.ID)
	}

	rendered := string(profile.Render("C:/repo", nil, nil))
	// Worker role + result packet contract must both be present.
	if !strings.Contains(rendered, "PierCode Worker Role") {
		t.Fatalf("worker prompt should carry the worker role section, got tail %q", tail(rendered))
	}
	if !strings.Contains(rendered, "piercode-agent-result") {
		t.Fatalf("worker prompt should describe the result packet fence, got tail %q", tail(rendered))
	}
	// Default operating contract is inherited (not replaced) via PromptAppend.
	if !strings.Contains(rendered, "PierCode") {
		t.Fatalf("worker prompt should inherit the default prompt body, got tail %q", tail(rendered))
	}

	// The per-call handoff reminder is wired and mentions the packet.
	if !strings.Contains(profile.ContextHandoff, "piercode-agent-result") {
		t.Fatalf("worker ContextHandoff should remind about the result packet, got %q", profile.ContextHandoff)
	}
}

func TestProfileRenderAppendsMemoryOutsideCache(t *testing.T) {
	root := t.TempDir()
	memDir := filepath.Join(root, ".piercode")
	if err := os.MkdirAll(memDir, 0755); err != nil {
		t.Fatal(err)
	}
	memPath := filepath.Join(memDir, "memory.md")
	if err := os.WriteFile(memPath, []byte("first memory\n"), 0644); err != nil {
		t.Fatal(err)
	}

	profile := Profile{ID: "memtest", Prompt: []byte("body {{SYSTEM_INFO}}")}
	first := string(profile.Render(root, nil, nil))
	if !strings.Contains(first, "first memory") || !strings.Contains(first, "Project memory") {
		t.Fatalf("expected memory in rendered prompt, got %q", tail(first))
	}

	if err := os.WriteFile(memPath, []byte("second memory\n"), 0644); err != nil {
		t.Fatal(err)
	}
	second := string(profile.Render(root, nil, nil))
	if !strings.Contains(second, "second memory") || strings.Contains(second, "first memory") {
		t.Fatalf("memory should be loaded outside render cache, got %q", tail(second))
	}
}

func tail(s string) string {
	if len(s) > 400 {
		return s[len(s)-400:]
	}
	return s
}

func TestProfileEmptyFiltersExposeNothing(t *testing.T) {
	profile := Profile{
		ID:         "locked",
		Prompt:     []byte("{{TOOLS}}"),
		ToolNames:  []string{},
		SkillNames: []string{},
	}

	if got := profile.FilterTools([]tool.ToolInfo{{Name: "read_file"}}); len(got) != 0 {
		t.Fatalf("expected no tools, got %#v", got)
	}
	if got := profile.FilterSkills([]skill.Info{{Name: "debug"}}); len(got) != 0 {
		t.Fatalf("expected no skills, got %#v", got)
	}
}
