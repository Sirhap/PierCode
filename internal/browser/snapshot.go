package browser

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/sirhap/piercode/internal/tool"
)

const (
	defaultMaxSnapshotNodes = 200
	maxSnapshotOutputChars  = 12000
	maxSnapshotValueChars   = 120
)

type axTreeResponse struct {
	Nodes []axNode `json:"nodes"`
}

type axNode struct {
	NodeID       string       `json:"nodeId"`
	BackendDOMID int          `json:"backendDOMNodeId"`
	Role         axValue      `json:"role"`
	Name         axValue      `json:"name"`
	Value        axValue      `json:"value"`
	Description  axValue      `json:"description"`
	Ignored      bool         `json:"ignored"`
	Properties   []axProperty `json:"properties"`
}

type axProperty struct {
	Name  string  `json:"name"`
	Value axValue `json:"value"`
}

type axValue struct {
	Type  string          `json:"type"`
	Value json.RawMessage `json:"value"`
}

func CompactSnapshot(raw json.RawMessage, tab tool.BrowserTab, snapshotID string, maxNodes int) (tool.BrowserSnapshot, []RefTarget, error) {
	if maxNodes <= 0 {
		maxNodes = defaultMaxSnapshotNodes
	}
	var tree axTreeResponse
	if err := json.Unmarshal(raw, &tree); err != nil {
		return tool.BrowserSnapshot{}, nil, err
	}

	var out strings.Builder
	fmt.Fprintf(&out, "snapshotId=%s url=%q title=%q\n\n", snapshotID, tab.URL, tab.SafeTitle())
	refs := make([]RefTarget, 0)
	shown := 0
	truncated := false

	for _, node := range tree.Nodes {
		if shown >= maxNodes || out.Len() >= maxSnapshotOutputChars {
			truncated = true
			break
		}
		role := node.Role.String()
		name := trimText(node.Name.String(), maxSnapshotValueChars)
		value := trimText(node.Value.String(), maxSnapshotValueChars)
		desc := trimText(node.Description.String(), maxSnapshotValueChars)
		if !shouldKeepAXNode(node, role, name, value, desc) {
			continue
		}

		refName := ""
		if isImportantRole(role) || isFocusable(node) || isEditable(node) {
			refName = fmt.Sprintf("e%d", len(refs))
		}
		if refName != "" {
			refs = append(refs, RefTarget{
				Ref:       refName,
				NodeID:    node.NodeID,
				BackendID: node.BackendDOMID,
				Role:      role,
				Name:      name,
				Bounds:    boundsFromNode(node),
			})
			out.WriteString("[")
			out.WriteString(refName)
			out.WriteString("] ")
		} else {
			out.WriteString("- ")
		}
		out.WriteString(role)
		if name != "" {
			fmt.Fprintf(&out, " %q", name)
		}
		if value != "" && value != name {
			fmt.Fprintf(&out, " value=%q", value)
		}
		if desc != "" && desc != name {
			fmt.Fprintf(&out, " desc=%q", desc)
		}
		for _, flag := range compactFlags(node) {
			out.WriteByte(' ')
			out.WriteString(flag)
		}
		out.WriteByte('\n')
		shown++
	}

	if truncated {
		out.WriteString("\n... snapshot truncated; use maxNodes carefully or inspect a narrower page state.\n")
	}
	return tool.BrowserSnapshot{
		SnapshotID: snapshotID,
		Tab:        tab,
		Text:       strings.TrimSpace(out.String()),
		NodeCount:  len(tree.Nodes),
		RefCount:   len(refs),
		Truncated:  truncated,
	}, refs, nil
}

func (v axValue) String() string {
	if len(v.Value) == 0 || string(v.Value) == "null" {
		return ""
	}
	var s string
	if err := json.Unmarshal(v.Value, &s); err == nil {
		return s
	}
	var b bool
	if err := json.Unmarshal(v.Value, &b); err == nil {
		if b {
			return "true"
		}
		return "false"
	}
	var n float64
	if err := json.Unmarshal(v.Value, &n); err == nil {
		return fmt.Sprintf("%g", n)
	}
	return strings.Trim(string(v.Value), `"`)
}

func shouldKeepAXNode(node axNode, role, name, value, desc string) bool {
	if node.Ignored {
		return false
	}
	if role == "" || role == "none" || role == "generic" {
		return false
	}
	if name == "" && value == "" && desc == "" && !isImportantRole(role) && !isFocusable(node) && !isEditable(node) {
		return false
	}
	return true
}

func isImportantRole(role string) bool {
	switch strings.ToLower(role) {
	case "button", "textbox", "searchbox", "link", "checkbox", "radio", "combobox",
		"menuitem", "tab", "heading", "slider", "spinbutton", "switch", "listbox",
		"option", "treeitem", "gridcell", "cell":
		return true
	default:
		return false
	}
}

func compactFlags(node axNode) []string {
	flags := make([]string, 0, 6)
	for _, prop := range node.Properties {
		name := strings.ToLower(prop.Name)
		value := prop.Value.String()
		switch name {
		case "disabled", "focused", "selected", "checked", "pressed", "expanded":
			if value != "" && value != "false" {
				flags = append(flags, name+"="+value)
			}
		case "editable":
			if value != "" && value != "false" {
				flags = append(flags, "editable")
			}
		case "level":
			if value != "" {
				flags = append(flags, "level="+value)
			}
		case "url":
			if value != "" {
				flags = append(flags, "href="+fmt.Sprintf("%q", trimText(value, maxSnapshotValueChars)))
			}
		}
	}
	return flags
}

func isFocusable(node axNode) bool {
	for _, prop := range node.Properties {
		if strings.EqualFold(prop.Name, "focusable") && prop.Value.String() == "true" {
			return true
		}
	}
	return false
}

func isEditable(node axNode) bool {
	for _, prop := range node.Properties {
		if strings.EqualFold(prop.Name, "editable") {
			v := prop.Value.String()
			return v != "" && v != "false"
		}
	}
	return false
}

func boundsFromNode(node axNode) *Bounds {
	for _, prop := range node.Properties {
		if !strings.EqualFold(prop.Name, "bounds") || len(prop.Value.Value) == 0 {
			continue
		}
		var b Bounds
		if err := json.Unmarshal(prop.Value.Value, &b); err == nil && b.Width > 0 && b.Height > 0 {
			return &b
		}
	}
	return nil
}

func trimText(s string, limit int) string {
	s = strings.Join(strings.Fields(strings.TrimSpace(s)), " ")
	if limit <= 0 || len([]rune(s)) <= limit {
		return s
	}
	runes := []rune(s)
	return string(runes[:limit]) + "..."
}
