package tool

import "testing"

func TestReadOnlyToolsDeclareMetadata(t *testing.T) {
	readOnly := []Tool{
		&ReadFileTool{}, &ListDirTool{}, &GlobTool{}, &GrepTool{},
		&WebFetchTool{}, &SkillTool{}, &QuestionTool{}, &ToolHelpTool{},
		&TodoReadTool{}, &TaskListTool{}, &TaskOutputTool{},
	}
	for _, tl := range readOnly {
		p, ok := tl.(MetadataProvider)
		if !ok {
			t.Errorf("%s does not implement MetadataProvider", tl.Name())
			continue
		}
		if !p.Metadata().ReadOnly {
			t.Errorf("%s Metadata().ReadOnly = false, want true", tl.Name())
		}
	}
}
