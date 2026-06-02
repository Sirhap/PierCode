package tool

import "testing"

// --- browser_storage ---

func TestBrowserStorageValidation(t *testing.T) {
	tool := NewBrowserStorageTool()
	cases := []struct {
		name string
		args map[string]interface{}
		ok   bool
	}{
		{"missing action", map[string]interface{}{}, false},
		{"bad action", map[string]interface{}{"action": "frob"}, false},
		{"bad storage", map[string]interface{}{"action": "get", "key": "k", "storage": "disk"}, false},
		{"get needs key", map[string]interface{}{"action": "get"}, false},
		{"remove needs key", map[string]interface{}{"action": "remove"}, false},
		{"set needs key", map[string]interface{}{"action": "set", "value": "v"}, false},
		{"set needs value", map[string]interface{}{"action": "set", "key": "k"}, false},
		{"get ok", map[string]interface{}{"action": "get", "key": "k"}, true},
		{"set ok", map[string]interface{}{"action": "set", "key": "k", "value": "v"}, true},
		{"clear ok", map[string]interface{}{"action": "clear"}, true},
		{"keys ok", map[string]interface{}{"action": "keys"}, true},
		{"session ok", map[string]interface{}{"action": "get", "key": "k", "storage": "session"}, true},
	}
	for _, c := range cases {
		err := tool.Validate(c.args)
		if c.ok && err != nil {
			t.Errorf("%s: expected pass, got %v", c.name, err)
		}
		if !c.ok && err == nil {
			t.Errorf("%s: expected fail", c.name)
		}
	}
}

// --- browser_set_cookie ---

func TestBrowserSetCookieValidation(t *testing.T) {
	tool := NewBrowserSetCookieTool()
	cases := []struct {
		name string
		args map[string]interface{}
		ok   bool
	}{
		{"bad action", map[string]interface{}{"action": "frob", "name": "n", "domain": ".x.com"}, false},
		{"missing name", map[string]interface{}{"action": "set", "domain": ".x.com", "value": "1"}, false},
		{"missing scope", map[string]interface{}{"action": "set", "name": "n", "value": "1"}, false},
		{"set needs value", map[string]interface{}{"action": "set", "name": "n", "domain": ".x.com"}, false},
		{"bad sameSite", map[string]interface{}{"action": "set", "name": "n", "domain": ".x.com", "value": "1", "sameSite": "weird"}, false},
		{"set ok domain", map[string]interface{}{"action": "set", "name": "n", "domain": ".x.com", "value": "1"}, true},
		{"set ok url", map[string]interface{}{"action": "set", "name": "n", "url": "https://x.com", "value": "1"}, true},
		{"delete ok", map[string]interface{}{"action": "delete", "name": "n", "domain": ".x.com"}, true},
		{"sameSite lax ok", map[string]interface{}{"action": "set", "name": "n", "domain": ".x.com", "value": "1", "sameSite": "lax"}, true},
	}
	for _, c := range cases {
		err := tool.Validate(c.args)
		if c.ok && err != nil {
			t.Errorf("%s: expected pass, got %v", c.name, err)
		}
		if !c.ok && err == nil {
			t.Errorf("%s: expected fail", c.name)
		}
	}
}

// --- browser_wait_for_navigation ---

func TestBrowserWaitForNavigationValidation(t *testing.T) {
	tool := NewBrowserWaitForNavigationTool()
	if err := tool.Validate(map[string]interface{}{}); err != nil {
		t.Errorf("empty args should pass: %v", err)
	}
	if err := tool.Validate(map[string]interface{}{"waitUntil": "load"}); err != nil {
		t.Errorf("load should pass: %v", err)
	}
	if err := tool.Validate(map[string]interface{}{"waitUntil": "networkidle"}); err == nil {
		t.Error("bad waitUntil should fail")
	}
	if err := tool.Validate(map[string]interface{}{"timeout": float64(120)}); err == nil {
		t.Error("timeout > 60 should fail")
	}
	if err := tool.Validate(map[string]interface{}{"urlPattern": "/done", "timeout": float64(30)}); err != nil {
		t.Errorf("valid args should pass: %v", err)
	}
}

// --- browser_emulate ---

func TestBrowserEmulateValidation(t *testing.T) {
	tool := NewBrowserEmulateTool()
	cases := []struct {
		name string
		args map[string]interface{}
		ok   bool
	}{
		{"empty no override", map[string]interface{}{}, false},
		{"reset ok", map[string]interface{}{"reset": true}, true},
		{"bad colorScheme", map[string]interface{}{"colorScheme": "neon"}, false},
		{"lat without lng", map[string]interface{}{"latitude": float64(1)}, false},
		{"lng without lat", map[string]interface{}{"longitude": float64(2)}, false},
		{"colorScheme ok", map[string]interface{}{"colorScheme": "dark"}, true},
		{"ua ok", map[string]interface{}{"userAgent": "Mozilla/5.0 custom"}, true},
		{"dsf ok", map[string]interface{}{"deviceScaleFactor": float64(2)}, true},
		{"geo pair ok", map[string]interface{}{"latitude": float64(37.7), "longitude": float64(-122.4)}, true},
		{"timezone ok", map[string]interface{}{"timezone": "America/New_York"}, true},
		{"mobile ok", map[string]interface{}{"mobile": true}, true},
	}
	for _, c := range cases {
		err := tool.Validate(c.args)
		if c.ok && err != nil {
			t.Errorf("%s: expected pass, got %v", c.name, err)
		}
		if !c.ok && err == nil {
			t.Errorf("%s: expected fail", c.name)
		}
	}
}

// --- browser_get_attributes ---

func TestBrowserGetAttributesValidation(t *testing.T) {
	tool := NewBrowserGetAttributesTool()
	// no target
	if err := tool.Validate(map[string]interface{}{"attributes": []interface{}{"href"}}); err == nil {
		t.Error("missing target should fail")
	}
	// target but no attrs/styles
	if err := tool.Validate(map[string]interface{}{"selector": "a"}); err == nil {
		t.Error("missing attributes/styles should fail")
	}
	// both ref and selector
	if err := tool.Validate(map[string]interface{}{"ref": "e0", "selector": "a", "snapshotId": "s1", "attributes": []interface{}{"href"}}); err == nil {
		t.Error("both ref and selector should fail")
	}
	// ref without snapshotId
	if err := tool.Validate(map[string]interface{}{"ref": "e0", "attributes": []interface{}{"href"}}); err == nil {
		t.Error("ref without snapshotId should fail")
	}
	// valid selector + attributes
	if err := tool.Validate(map[string]interface{}{"selector": "a", "attributes": []interface{}{"href"}}); err != nil {
		t.Errorf("valid selector+attributes should pass: %v", err)
	}
	// valid selector + styles
	if err := tool.Validate(map[string]interface{}{"selector": "body", "styles": []interface{}{"color"}}); err != nil {
		t.Errorf("valid selector+styles should pass: %v", err)
	}
	// valid ref + snapshotId
	if err := tool.Validate(map[string]interface{}{"ref": "e0", "snapshotId": "s1", "styles": []interface{}{"color"}}); err != nil {
		t.Errorf("valid ref+snapshotId should pass: %v", err)
	}
}
