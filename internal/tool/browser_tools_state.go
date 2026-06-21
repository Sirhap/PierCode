// Deprecated: these browser_* tool definitions are superseded by the extension
// service worker (extension/src/background/browser/*). See the package note in
// browser_tools.go. Commands dispatched here reach no browser.
package tool

import (
	"fmt"
	"strings"
)

func NewBrowserStorageTool() Tool {
	return &browserTool{
		name:        "browser_storage",
		description: "Read or write localStorage/sessionStorage in the controlled browser tab. Actions: get, set, remove, clear, keys.",
		parameters: map[string]string{
			"action":  "string (required, get|set|remove|clear|keys)",
			"storage": "string (optional, local|session, default local)",
			"key":     "string (required for get|set|remove)",
			"value":   "string (required for set)",
			"tabId":   "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			action := strings.ToLower(stringArg(args, "action"))
			switch action {
			case "get", "set", "remove", "clear", "keys":
			default:
				return fmt.Errorf("action must be get, set, remove, clear, or keys")
			}
			storage := strings.ToLower(stringArg(args, "storage"))
			if storage != "" && storage != "local" && storage != "session" {
				return fmt.Errorf("storage must be local or session")
			}
			switch action {
			case "get", "remove":
				if stringArg(args, "key") == "" {
					return fmt.Errorf("key is required for %s", action)
				}
			case "set":
				if stringArg(args, "key") == "" {
					return fmt.Errorf("key is required for set")
				}
				if _, ok := args["value"]; !ok {
					return fmt.Errorf("value is required for set")
				}
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			storage := strings.ToLower(stringArg(ctx.Args, "storage"))
			if storage == "" {
				storage = "local"
			}
			return ctx.Browser.Storage(ctx.Context, BrowserStorageRequest{
				TabID:   optionalInt(ctx.Args, "tabId"),
				Action:  strings.ToLower(stringArg(ctx.Args, "action")),
				Storage: storage,
				Key:     stringArg(ctx.Args, "key"),
				Value:   stringArg(ctx.Args, "value"),
			})
		},
	}
}

func NewBrowserSetCookieTool() Tool {
	return &browserTool{
		name:        "browser_set_cookie",
		description: "Write or delete a browser cookie after user approval. Complements the read-only browser_cookies. Requires a domain or url scope; the target domain must be in the extension host permissions.",
		parameters: map[string]string{
			"action":         "string (required, set|delete)",
			"name":           "string (required) - cookie name",
			"value":          "string (required for set) - cookie value",
			"domain":         "string (optional) - cookie domain, e.g. .example.com (provide domain or url)",
			"url":            "string (optional) - cookie URL scope, e.g. https://example.com (provide domain or url)",
			"path":           "string (optional, default /) - cookie path",
			"secure":         "boolean (optional, default false)",
			"httpOnly":       "boolean (optional, default false)",
			"sameSite":       "string (optional, no_restriction|lax|strict)",
			"expirationDate": "number (optional) - unix seconds; omit for session cookie",
		},
		validate: func(args map[string]interface{}) error {
			action := strings.ToLower(stringArg(args, "action"))
			if action != "set" && action != "delete" {
				return fmt.Errorf("action must be set or delete")
			}
			if stringArg(args, "name") == "" {
				return fmt.Errorf("name is required")
			}
			if stringArg(args, "domain") == "" && stringArg(args, "url") == "" {
				return fmt.Errorf("domain or url is required")
			}
			if action == "set" {
				if _, ok := args["value"]; !ok {
					return fmt.Errorf("value is required for set")
				}
			}
			sameSite := strings.ToLower(stringArg(args, "sameSite"))
			if sameSite != "" && sameSite != "no_restriction" && sameSite != "lax" && sameSite != "strict" {
				return fmt.Errorf("sameSite must be no_restriction, lax, or strict")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			var exp float64
			if v := optionalFloat(ctx.Args, "expirationDate"); v != nil {
				exp = *v
			}
			return ctx.Browser.SetCookie(ctx.Context, BrowserSetCookieRequest{
				Action:         strings.ToLower(stringArg(ctx.Args, "action")),
				Name:           stringArg(ctx.Args, "name"),
				Value:          stringArg(ctx.Args, "value"),
				Domain:         stringArg(ctx.Args, "domain"),
				URL:            stringArg(ctx.Args, "url"),
				Path:           stringArg(ctx.Args, "path"),
				Secure:         boolArg(ctx.Args, "secure"),
				HTTPOnly:       boolArg(ctx.Args, "httpOnly"),
				SameSite:       stringArg(ctx.Args, "sameSite"),
				ExpirationDate: exp,
				CallID:         stringArg(ctx.Args, "call_id"),
			})
		},
	}
}

func NewBrowserWaitForNavigationTool() Tool {
	return &browserTool{
		name:        "browser_wait_for_navigation",
		description: "Wait for the controlled tab to navigate (URL change) and reach a load state. Use after triggering a click that causes navigation.",
		parameters: map[string]string{
			"urlPattern": "string (optional) - substring or regex the new URL must match",
			"waitUntil":  "string (optional, load|domcontentloaded|networkidle, default load) - event-driven, survives real navigation",
			"timeout":    "number (optional, default 10, max 60) - seconds",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			waitUntil := strings.ToLower(stringArg(args, "waitUntil"))
			if waitUntil != "" && waitUntil != "load" && waitUntil != "domcontentloaded" && waitUntil != "networkidle" {
				return fmt.Errorf("waitUntil must be load, domcontentloaded, or networkidle")
			}
			if t := intArgDefault(args, "timeout", 10); t > 60 {
				return fmt.Errorf("timeout must be <= 60")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.WaitForNavigation(ctx.Context, BrowserWaitForNavigationRequest{
				TabID:          optionalInt(ctx.Args, "tabId"),
				URLPattern:     stringArg(ctx.Args, "urlPattern"),
				WaitUntil:      stringArg(ctx.Args, "waitUntil"),
				TimeoutSeconds: intArgDefault(ctx.Args, "timeout", 10),
				CallID:         stringArg(ctx.Args, "call_id"),
			})
		},
	}
}

func NewBrowserEmulateTool() Tool {
	return &browserTool{
		name:        "browser_emulate",
		description: "Emulate device and environment conditions on the controlled tab: user agent, device scale factor, mobile, color scheme, timezone, geolocation. Use reset=true to clear overrides.",
		parameters: map[string]string{
			"userAgent":         "string (optional) - override navigator.userAgent",
			"deviceScaleFactor": "number (optional) - device pixel ratio, e.g. 2",
			"mobile":            "boolean (optional) - emulate mobile viewport/touch",
			"colorScheme":       "string (optional, light|dark|no-preference) - prefers-color-scheme",
			"timezone":          "string (optional) - IANA timezone, e.g. America/New_York",
			"latitude":          "number (optional, with longitude) - geolocation latitude",
			"longitude":         "number (optional, with latitude) - geolocation longitude",
			"accuracy":          "number (optional, default 100) - geolocation accuracy meters",
			"network":           "string (optional, slow-3g|fast-3g|slow-4g|offline) - throttle network conditions",
			"offline":           "boolean (optional) - force offline; combine with or instead of network",
			"reset":             "boolean (optional, default false) - clear all emulation overrides incl. network",
			"tabId":             "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			if boolArg(args, "reset") {
				return nil
			}
			cs := strings.ToLower(stringArg(args, "colorScheme"))
			if cs != "" && cs != "light" && cs != "dark" && cs != "no-preference" {
				return fmt.Errorf("colorScheme must be light, dark, or no-preference")
			}
			hasLat := optionalFloat(args, "latitude") != nil
			hasLng := optionalFloat(args, "longitude") != nil
			if hasLat != hasLng {
				return fmt.Errorf("latitude and longitude must be provided together")
			}
			net := strings.ToLower(stringArg(args, "network"))
			if net != "" && net != "slow-3g" && net != "fast-3g" && net != "slow-4g" && net != "offline" {
				return fmt.Errorf("network must be slow-3g, fast-3g, slow-4g, or offline")
			}
			hasAny := stringArg(args, "userAgent") != "" ||
				optionalFloat(args, "deviceScaleFactor") != nil ||
				hasBoolArg(args, "mobile") ||
				cs != "" ||
				stringArg(args, "timezone") != "" ||
				hasLat ||
				net != "" ||
				hasBoolArg(args, "offline")
			if !hasAny {
				return fmt.Errorf("provide at least one emulation override or reset=true")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			var dsf float64
			if v := optionalFloat(ctx.Args, "deviceScaleFactor"); v != nil {
				dsf = *v
			}
			var mobile *bool
			if hasBoolArg(ctx.Args, "mobile") {
				m := boolArg(ctx.Args, "mobile")
				mobile = &m
			}
			return ctx.Browser.Emulate(ctx.Context, BrowserEmulateRequest{
				TabID:             optionalInt(ctx.Args, "tabId"),
				UserAgent:         stringArg(ctx.Args, "userAgent"),
				DeviceScaleFactor: dsf,
				Mobile:            mobile,
				ColorScheme:       strings.ToLower(stringArg(ctx.Args, "colorScheme")),
				Timezone:          stringArg(ctx.Args, "timezone"),
				Latitude:          optionalFloat(ctx.Args, "latitude"),
				Longitude:         optionalFloat(ctx.Args, "longitude"),
				Accuracy:          optionalFloat(ctx.Args, "accuracy"),
				Network:           strings.ToLower(stringArg(ctx.Args, "network")),
				Offline: func() *bool {
					if hasBoolArg(ctx.Args, "offline") {
						b := boolArg(ctx.Args, "offline")
						return &b
					}
					return nil
				}(),
				Reset:  boolArg(ctx.Args, "reset"),
				CallID: stringArg(ctx.Args, "call_id"),
			})
		},
	}
}

func NewBrowserGetAttributesTool() Tool {
	return &browserTool{
		name:        "browser_get_attributes",
		readOnly:    true,
		description: "Read element attributes and computed styles from the controlled tab. Useful for verifying colors, sizes, and state without writing JavaScript.",
		parameters: map[string]string{
			"ref":        "string (optional) - target ref from browser_snapshot",
			"snapshotId": "string (required with ref) - snapshot id from browser_snapshot",
			"selector":   "string (optional) - CSS selector fallback",
			"attributes": "array (optional) - attribute names to read, e.g. [href, class, disabled]",
			"styles":     "array (optional) - computed style properties, e.g. [color, font-size]",
			"tabId":      "number (optional) - controlled tab id",
		},
		validate: func(args map[string]interface{}) error {
			if err := validateElementTarget(args); err != nil {
				return err
			}
			if len(stringListArg(args, "attributes")) == 0 && len(stringListArg(args, "styles")) == 0 {
				return fmt.Errorf("provide at least one of attributes or styles")
			}
			return nil
		},
		execute: func(ctx *Context) (string, error) {
			return ctx.Browser.GetAttributes(ctx.Context, BrowserGetAttributesRequest{
				TabID:      optionalInt(ctx.Args, "tabId"),
				Ref:        stringArg(ctx.Args, "ref"),
				Selector:   stringArg(ctx.Args, "selector"),
				SnapshotID: stringArg(ctx.Args, "snapshotId"),
				Attributes: stringListArg(ctx.Args, "attributes"),
				Styles:     stringListArg(ctx.Args, "styles"),
			})
		},
	}
}
