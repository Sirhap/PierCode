package executor

import (
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

// Every tool the name-list marks read-only must ALSO implement MetadataProvider,
// so the list is now pure fallback. A new read-only tool should add Metadata()
// rather than extend the list.
func TestReadOnlyNameListIsFallbackOnly(t *testing.T) {
	e := New(testConfig(t))

	// These are all names declared in isReadOnlyToolName.
	nameListedReadOnly := []string{
		"read_file", "list_dir", "glob", "grep", "web_fetch", "skill", "question", "tool_help",
		"todo_read", "task_list", "task_output",
		"browser_tabs", "browser_snapshot", "browser_screenshot",
		"browser_wait", "browser_wait_for_function",
		"browser_get_content", "browser_pdf", "browser_console", "browser_network",
		"browser_find", "browser_get_attributes",
	}

	for _, name := range nameListedReadOnly {
		tl, ok := e.registry.Get(name)
		if !ok {
			t.Errorf("tool %q is in isReadOnlyToolName but is not registered in the executor", name)
			continue
		}
		provider, ok := tl.(tool.MetadataProvider)
		if !ok {
			t.Errorf("tool %q is in isReadOnlyToolName but does not implement MetadataProvider — add Metadata() to the tool", name)
			continue
		}
		if !provider.Metadata().ReadOnly {
			t.Errorf("tool %q implements MetadataProvider but Metadata().ReadOnly = false, want true", name)
		}
	}
}
