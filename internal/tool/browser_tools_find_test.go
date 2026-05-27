package tool

import (
	"testing"
)

// --- browser_find ---

func TestBrowserFindValidationQueryRequired(t *testing.T) {
	tool := NewBrowserFindTool()
	if err := tool.Validate(map[string]interface{}{}); err == nil {
		t.Fatal("expected missing query to fail")
	}
	if err := tool.Validate(map[string]interface{}{"query": ""}); err == nil {
		t.Fatal("expected empty query to fail")
	}
}

func TestBrowserFindValidationQueryWhitespaceOnlyFails(t *testing.T) {
	tool := NewBrowserFindTool()
	if err := tool.Validate(map[string]interface{}{"query": "   "}); err == nil {
		t.Fatal("expected whitespace-only query to fail")
	}
	if err := tool.Validate(map[string]interface{}{"query": "\t\n"}); err == nil {
		t.Fatal("expected tab/newline query to fail")
	}
}

func TestBrowserFindValidationValidQueryPasses(t *testing.T) {
	tool := NewBrowserFindTool()
	if err := tool.Validate(map[string]interface{}{"query": "submit button"}); err != nil {
		t.Fatalf("expected valid query to pass: %v", err)
	}
}

func TestBrowserFindValidationMaxResultsOptional(t *testing.T) {
	tool := NewBrowserFindTool()
	// Without maxResults should pass
	if err := tool.Validate(map[string]interface{}{"query": "login"}); err != nil {
		t.Fatalf("expected query without maxResults to pass: %v", err)
	}
	// With maxResults should also pass
	if err := tool.Validate(map[string]interface{}{"query": "login", "maxResults": float64(10)}); err != nil {
		t.Fatalf("expected query with maxResults to pass: %v", err)
	}
}

// --- browser_zoom ---

func TestBrowserZoomValidationWidthHeightRequired(t *testing.T) {
	tool := NewBrowserZoomTool()
	// Missing both width and height
	if err := tool.Validate(map[string]interface{}{"selector": ".target"}); err == nil {
		t.Fatal("expected missing width/height to fail")
	}
	// Missing height
	if err := tool.Validate(map[string]interface{}{"selector": ".target", "width": float64(200)}); err == nil {
		t.Fatal("expected missing height to fail")
	}
	// Missing width
	if err := tool.Validate(map[string]interface{}{"selector": ".target", "height": float64(200)}); err == nil {
		t.Fatal("expected missing width to fail")
	}
}

func TestBrowserZoomValidationRequiresOneTarget(t *testing.T) {
	tool := NewBrowserZoomTool()
	// No target at all
	if err := tool.Validate(map[string]interface{}{"width": float64(200), "height": float64(200)}); err == nil {
		t.Fatal("expected missing target to fail")
	}
}

func TestBrowserZoomValidationRefWithoutSnapshotIdFails(t *testing.T) {
	tool := NewBrowserZoomTool()
	if err := tool.Validate(map[string]interface{}{
		"ref": "e0", "width": float64(200), "height": float64(200),
	}); err == nil {
		t.Fatal("expected ref without snapshotId to fail")
	}
}

func TestBrowserZoomValidationXWithoutYFails(t *testing.T) {
	tool := NewBrowserZoomTool()
	if err := tool.Validate(map[string]interface{}{
		"x": float64(100), "width": float64(200), "height": float64(200),
	}); err == nil {
		t.Fatal("expected x without y to fail")
	}
}

func TestBrowserZoomValidationSelectorWithDimensionsPasses(t *testing.T) {
	tool := NewBrowserZoomTool()
	if err := tool.Validate(map[string]interface{}{
		"selector": ".target", "width": float64(200), "height": float64(200),
	}); err != nil {
		t.Fatalf("expected selector+dimensions to pass: %v", err)
	}
}

// --- browser_resize ---

func TestBrowserResizeValidationWidthHeightRequired(t *testing.T) {
	tool := NewBrowserResizeTool()
	if err := tool.Validate(map[string]interface{}{}); err == nil {
		t.Fatal("expected missing width/height to fail")
	}
	if err := tool.Validate(map[string]interface{}{"width": float64(1024)}); err == nil {
		t.Fatal("expected missing height to fail")
	}
	if err := tool.Validate(map[string]interface{}{"height": float64(768)}); err == nil {
		t.Fatal("expected missing width to fail")
	}
}

func TestBrowserResizeValidationWidthTooSmall(t *testing.T) {
	tool := NewBrowserResizeTool()
	if err := tool.Validate(map[string]interface{}{"width": float64(399), "height": float64(768)}); err == nil {
		t.Fatal("expected width < 400 to fail")
	}
}

func TestBrowserResizeValidationWidthTooLarge(t *testing.T) {
	tool := NewBrowserResizeTool()
	if err := tool.Validate(map[string]interface{}{"width": float64(7681), "height": float64(768)}); err == nil {
		t.Fatal("expected width > 7680 to fail")
	}
}

func TestBrowserResizeValidationHeightTooSmall(t *testing.T) {
	tool := NewBrowserResizeTool()
	if err := tool.Validate(map[string]interface{}{"width": float64(1024), "height": float64(299)}); err == nil {
		t.Fatal("expected height < 300 to fail")
	}
}

func TestBrowserResizeValidationHeightTooLarge(t *testing.T) {
	tool := NewBrowserResizeTool()
	if err := tool.Validate(map[string]interface{}{"width": float64(1024), "height": float64(4321)}); err == nil {
		t.Fatal("expected height > 4320 to fail")
	}
}

func TestBrowserResizeValidationValidDimensionsPass(t *testing.T) {
	tool := NewBrowserResizeTool()
	// Boundary values should pass
	if err := tool.Validate(map[string]interface{}{"width": float64(400), "height": float64(300)}); err != nil {
		t.Fatalf("expected 400x300 to pass: %v", err)
	}
	if err := tool.Validate(map[string]interface{}{"width": float64(7680), "height": float64(4320)}); err != nil {
		t.Fatalf("expected 7680x4320 to pass: %v", err)
	}
	// Typical value
	if err := tool.Validate(map[string]interface{}{"width": float64(1920), "height": float64(1080)}); err != nil {
		t.Fatalf("expected 1920x1080 to pass: %v", err)
	}
}

// --- browser_form_input ---

func TestBrowserFormInputValidationValueRequired(t *testing.T) {
	tool := NewBrowserFormInputTool()
	if err := tool.Validate(map[string]interface{}{"selector": "input"}); err == nil {
		t.Fatal("expected missing value to fail")
	}
	if err := tool.Validate(map[string]interface{}{}); err == nil {
		t.Fatal("expected missing value to fail")
	}
}

func TestBrowserFormInputValidationRefWithoutSnapshotIdFails(t *testing.T) {
	tool := NewBrowserFormInputTool()
	if err := tool.Validate(map[string]interface{}{"ref": "e0", "value": "hello"}); err == nil {
		t.Fatal("expected ref without snapshotId to fail")
	}
}

func TestBrowserFormInputValidationSelectorPasses(t *testing.T) {
	tool := NewBrowserFormInputTool()
	if err := tool.Validate(map[string]interface{}{"selector": "input", "value": "hello"}); err != nil {
		t.Fatalf("expected selector+value to pass: %v", err)
	}
}

func TestBrowserFormInputValidationRefAndSnapshotIdPasses(t *testing.T) {
	tool := NewBrowserFormInputTool()
	if err := tool.Validate(map[string]interface{}{"ref": "e0", "snapshotId": "snap", "value": "hello"}); err != nil {
		t.Fatalf("expected ref+snapshotId+value to pass: %v", err)
	}
}

// --- browser_console ---

func TestBrowserConsoleValidationInvalidRegexFails(t *testing.T) {
	tool := NewBrowserConsoleTool()
	if err := tool.Validate(map[string]interface{}{"pattern": "[invalid"}); err == nil {
		t.Fatal("expected invalid regex to fail")
	}
	if err := tool.Validate(map[string]interface{}{"pattern": "(unclosed"}); err == nil {
		t.Fatal("expected unclosed group regex to fail")
	}
}

func TestBrowserConsoleValidationValidRegexPasses(t *testing.T) {
	tool := NewBrowserConsoleTool()
	if err := tool.Validate(map[string]interface{}{"pattern": "^error.*timeout"}); err != nil {
		t.Fatalf("expected valid regex to pass: %v", err)
	}
}

func TestBrowserConsoleValidationEmptyPatternPasses(t *testing.T) {
	tool := NewBrowserConsoleTool()
	// Empty pattern is optional and should pass
	if err := tool.Validate(map[string]interface{}{}); err != nil {
		t.Fatalf("expected no pattern to pass: %v", err)
	}
	if err := tool.Validate(map[string]interface{}{"pattern": ""}); err != nil {
		t.Fatalf("expected empty pattern to pass: %v", err)
	}
}

// --- browser_network ---

func TestBrowserNetworkValidationAlwaysPasses(t *testing.T) {
	tool := NewBrowserNetworkTool()
	// Empty args should pass
	if err := tool.Validate(map[string]interface{}{}); err != nil {
		t.Fatalf("expected empty args to pass: %v", err)
	}
	// With urlPattern should pass
	if err := tool.Validate(map[string]interface{}{"urlPattern": "api.example.com"}); err != nil {
		t.Fatalf("expected urlPattern to pass: %v", err)
	}
	// With all optional params should pass
	if err := tool.Validate(map[string]interface{}{
		"urlPattern": "api", "clear": true, "limit": float64(50),
	}); err != nil {
		t.Fatalf("expected all params to pass: %v", err)
	}
}

// --- browser_cookies ---

func TestBrowserCookiesValidationRequiresScope(t *testing.T) {
	tool := NewBrowserCookiesTool()
	if err := tool.Validate(map[string]interface{}{}); err == nil {
		t.Fatal("expected missing domain/url to fail")
	}
	if err := tool.Validate(map[string]interface{}{"domain": "", "url": ""}); err == nil {
		t.Fatal("expected empty domain/url to fail")
	}
}

func TestBrowserCookiesValidationDomainOrURLPasses(t *testing.T) {
	tool := NewBrowserCookiesTool()
	if err := tool.Validate(map[string]interface{}{"domain": ".example.com"}); err != nil {
		t.Fatalf("expected domain scope to pass: %v", err)
	}
	if err := tool.Validate(map[string]interface{}{"url": "https://example.com"}); err != nil {
		t.Fatalf("expected URL scope to pass: %v", err)
	}
}

func TestBrowserCookiesValidationLimitTooHighFails(t *testing.T) {
	tool := NewBrowserCookiesTool()
	if err := tool.Validate(map[string]interface{}{"domain": ".example.com", "limit": float64(1001)}); err == nil {
		t.Fatal("expected limit > 1000 to fail")
	}
}

// --- browser_click (extended) ---

func TestBrowserClickValidationInvalidButtonFails(t *testing.T) {
	tool := NewBrowserClickTool()
	if err := tool.Validate(map[string]interface{}{"selector": "button", "button": "xbutton"}); err == nil {
		t.Fatal("expected invalid button to fail")
	}
}

func TestBrowserClickValidationClickCountZeroDefaultsToPass(t *testing.T) {
	tool := NewBrowserClickTool()
	// intArgDefault treats values <= 0 as "use fallback (1)", so 0 passes
	if err := tool.Validate(map[string]interface{}{"selector": "button", "clickCount": float64(0)}); err != nil {
		t.Fatalf("expected clickCount=0 (treated as default) to pass: %v", err)
	}
	// Negative values also fall back to the default
	if err := tool.Validate(map[string]interface{}{"selector": "button", "clickCount": float64(-1)}); err != nil {
		t.Fatalf("expected clickCount=-1 (treated as default) to pass: %v", err)
	}
}

func TestBrowserClickValidationClickCountTooHigh(t *testing.T) {
	tool := NewBrowserClickTool()
	if err := tool.Validate(map[string]interface{}{"selector": "button", "clickCount": float64(4)}); err == nil {
		t.Fatal("expected clickCount > 3 to fail")
	}
}

func TestBrowserClickValidationValidButtonAndClickCount(t *testing.T) {
	tool := NewBrowserClickTool()
	if err := tool.Validate(map[string]interface{}{"selector": "button", "button": "right", "clickCount": float64(2)}); err != nil {
		t.Fatalf("expected right+double to pass: %v", err)
	}
	if err := tool.Validate(map[string]interface{}{"selector": "button", "button": "middle", "clickCount": float64(3)}); err != nil {
		t.Fatalf("expected middle+triple to pass: %v", err)
	}
}

func TestBrowserClickValidationDefaultsStillWork(t *testing.T) {
	tool := NewBrowserClickTool()
	// No button or clickCount — defaults should be applied by validate (left, 1)
	if err := tool.Validate(map[string]interface{}{"selector": "button"}); err != nil {
		t.Fatalf("expected default button/clickCount to pass: %v", err)
	}
}
