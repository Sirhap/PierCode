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

func TestBrowserReadOnlyToolsMetadata(t *testing.T) {
	readOnlyNames := map[string]bool{
		"browser_tabs": true, "browser_snapshot": true, "browser_screenshot": true,
		"browser_wait": true, "browser_wait_for_function": true, "browser_get_content": true,
		"browser_console": true, "browser_network": true, "browser_pdf": true,
		"browser_find": true, "browser_get_attributes": true,
	}

	// Every browser tool constructor, built the same way the executor registers them.
	browserTools := []Tool{
		NewBrowserTabsTool(), NewBrowserNewTabTool(), NewBrowserUseTabTool(),
		NewBrowserNavigateTool(), NewBrowserSnapshotTool(), NewBrowserClickTool(),
		NewBrowserTypeTool(), NewBrowserScreenshotTool(), NewBrowserWaitTool(),
		NewBrowserWaitForFunctionTool(), NewBrowserHoverTool(), NewBrowserScrollTool(),
		NewBrowserEvaluateTool(), NewBrowserGetContentTool(), NewBrowserSelectTool(),
		NewBrowserGoBackTool(), NewBrowserGoForwardTool(), NewBrowserReloadTool(),
		NewBrowserFocusTool(), NewBrowserPressKeyTool(), NewBrowserDragTool(),
		NewBrowserPDFTool(), NewBrowserUploadTool(), NewBrowserHandleDialogTool(),
		NewBrowserFindTool(), NewBrowserZoomTool(), NewBrowserResizeTool(),
		NewBrowserFormInputTool(), NewBrowserConsoleTool(), NewBrowserNetworkTool(),
		NewBrowserCookiesTool(), NewBrowserFinalizeTabsTool(), NewBrowserViewportTool(),
		NewBrowserDownloadsTool(), NewBrowserStorageTool(), NewBrowserSetCookieTool(),
		NewBrowserWaitForNavigationTool(), NewBrowserEmulateTool(), NewBrowserGetAttributesTool(),
	}

	seen := map[string]bool{}
	for _, tl := range browserTools {
		seen[tl.Name()] = true
		p, ok := tl.(MetadataProvider)
		if !ok {
			t.Errorf("%s does not implement MetadataProvider", tl.Name())
			continue
		}
		want := readOnlyNames[tl.Name()]
		if got := p.Metadata().ReadOnly; got != want {
			t.Errorf("%s Metadata().ReadOnly = %v, want %v", tl.Name(), got, want)
		}
	}

	// Guard: every expected read-only name was actually enumerated above.
	for name := range readOnlyNames {
		if !seen[name] {
			t.Errorf("read-only browser tool %q was not enumerated by the test", name)
		}
	}
}
