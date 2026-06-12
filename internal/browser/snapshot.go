package browser

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/sirhap/piercode/internal/tool"
)

const (
	defaultMaxSnapshotNodes = 200
	defaultMaxSnapshotDepth = 15
	maxSnapshotOutputChars  = 12000
	maxSnapshotValueChars   = 120
)

type axTreeResponse struct {
	Nodes []axNode `json:"nodes"`
}

type axNode struct {
	NodeID       string       `json:"nodeId"`
	BackendDOMID int          `json:"backendDOMNodeId"`
	ChildIDs     []string     `json:"childIds"`
	ParentID     string       `json:"parentId"`
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

// CompactSnapshot renders the accessibility tree as an indented hierarchy.
// Parent-child context is preserved (each kept node is indented under its
// nearest kept ancestor), refs (e0, e1, …) are assigned to actionable nodes,
// and output is bounded by opts.MaxNodes / opts.MaxChars / opts.Depth. When
// opts.RefID is set, only that ref's subtree is rendered. The legacy flat
// behavior is gone; refs remain document-ordered so they stay stable.
func CompactSnapshot(raw json.RawMessage, tab tool.BrowserTab, snapshotID string, opts tool.SnapshotOptions) (tool.BrowserSnapshot, []RefTarget, error) {
	maxNodes := opts.MaxNodes
	if maxNodes <= 0 {
		maxNodes = defaultMaxSnapshotNodes
	}
	maxChars := opts.MaxChars
	if maxChars <= 0 {
		maxChars = maxSnapshotOutputChars
	}
	maxDepth := opts.Depth
	if maxDepth <= 0 {
		maxDepth = defaultMaxSnapshotDepth
	}

	var tree axTreeResponse
	if err := json.Unmarshal(raw, &tree); err != nil {
		return tool.BrowserSnapshot{}, nil, err
	}

	// Index nodes by id and find roots (nodes with no parent in the set).
	byID := make(map[string]*axNode, len(tree.Nodes))
	for i := range tree.Nodes {
		byID[tree.Nodes[i].NodeID] = &tree.Nodes[i]
	}
	var roots []*axNode
	for i := range tree.Nodes {
		n := &tree.Nodes[i]
		if n.ParentID == "" || byID[n.ParentID] == nil {
			roots = append(roots, n)
		}
	}
	// If RefID is requested, re-root at the node whose ref maps to it. We need a
	// first pass to assign refs in document order so RefID resolves to the same
	// node a prior snapshot returned.

	var out strings.Builder
	fmt.Fprintf(&out, "snapshotId=%s url=%q title=%q\n\n", snapshotID, tab.URL, tab.SafeTitle())
	refs := make([]RefTarget, 0)
	state := &snapshotWalk{
		out:      &out,
		refs:     &refs,
		maxNodes: maxNodes,
		maxChars: maxChars,
		maxDepth: maxDepth,
		byID:     byID,
	}

	// Determine the walk roots. When RefID is set we still need to assign refs
	// consistently, so we walk the whole tree but only EMIT the matching
	// subtree. Simplicity beats cleverness: assign refs during a structural
	// walk, and gate emission on whether we're inside the requested subtree.
	state.targetRef = strings.TrimSpace(opts.RefID)
	state.emitting = state.targetRef == "" // emit from the top unless filtering

	for _, root := range roots {
		state.walk(root, 0)
	}

	if state.targetRef != "" && !state.matchedRef {
		return tool.BrowserSnapshot{}, nil, fmt.Errorf("ref %q not found in this snapshot; take a fresh browser_snapshot", state.targetRef)
	}

	if state.truncated {
		fmt.Fprintf(&out, "\n... snapshot truncated at %d nodes / %d chars. Narrow it: pass a smaller depth, or focus a subtree with ref_id=<ref>.\n", maxNodes, maxChars)
	}
	return tool.BrowserSnapshot{
		SnapshotID: snapshotID,
		Tab:        tab,
		Text:       strings.TrimSpace(out.String()),
		NodeCount:  len(tree.Nodes),
		RefCount:   len(refs),
		Truncated:  state.truncated,
	}, refs, nil
}

type snapshotWalk struct {
	out        *strings.Builder
	refs       *[]RefTarget
	byID       map[string]*axNode
	maxNodes   int
	maxChars   int
	maxDepth   int
	shown      int
	truncated  bool
	targetRef  string // when non-empty, only emit this ref's subtree
	emitting   bool   // currently inside the emit scope
	matchedRef bool   // the targetRef was found
}

// walk descends the AX subtree rooted at node. visualDepth is the indentation
// level among KEPT nodes (so skipped wrapper nodes don't inflate indentation).
func (s *snapshotWalk) walk(node *axNode, visualDepth int) {
	if s.truncated || node == nil {
		return
	}
	role := node.Role.String()
	name := trimText(node.Name.String(), maxSnapshotValueChars)
	value := trimText(node.Value.String(), maxSnapshotValueChars)
	desc := trimText(node.Description.String(), maxSnapshotValueChars)
	keep := shouldKeepAXNode(*node, role, name, value, desc)

	childDepth := visualDepth
	if keep {
		// Assign a ref to actionable nodes regardless of emit scope, so refs
		// stay stable whether or not a subtree filter is active.
		refName := ""
		if isImportantRole(role) || isFocusable(*node) || isEditable(*node) {
			refName = fmt.Sprintf("e%d", len(*s.refs))
			*s.refs = append(*s.refs, RefTarget{
				Ref:       refName,
				NodeID:    node.NodeID,
				BackendID: node.BackendDOMID,
				Role:      role,
				Name:      name,
				Bounds:    boundsFromNode(*node),
			})
		}

		// Subtree filtering: enter emit scope when we hit the target ref.
		enteredHere := false
		if s.targetRef != "" && !s.emitting && refName == s.targetRef {
			s.emitting = true
			s.matchedRef = true
			enteredHere = true
		}

		if s.emitting {
			if s.shown >= s.maxNodes || s.out.Len() >= s.maxChars {
				s.truncated = true
				return
			}
			s.writeNode(node, role, name, value, desc, refName, visualDepth)
			s.shown++
			childDepth = visualDepth + 1
		}

		// Stop descending past the depth cap (within emit scope).
		if s.emitting && childDepth > s.maxDepth {
			if enteredHere {
				s.emitting = false
			}
			return
		}

		for _, cid := range node.ChildIDs {
			s.walk(s.byID[cid], childDepth)
			if s.truncated {
				break
			}
		}
		if enteredHere {
			s.emitting = false // leave the requested subtree
		}
		return
	}

	// Node not kept: descend without indenting or emitting it.
	for _, cid := range node.ChildIDs {
		s.walk(s.byID[cid], visualDepth)
		if s.truncated {
			break
		}
	}
}

func (s *snapshotWalk) writeNode(node *axNode, role, name, value, desc, refName string, depth int) {
	out := s.out
	for i := 0; i < depth; i++ {
		out.WriteString("  ")
	}
	if refName != "" {
		out.WriteString("[")
		out.WriteString(refName)
		out.WriteString("] ")
	} else {
		out.WriteString("- ")
	}
	out.WriteString(role)
	if name != "" {
		fmt.Fprintf(out, " %q", name)
	}
	if value != "" && value != name {
		fmt.Fprintf(out, " value=%q", value)
	}
	if desc != "" && desc != name {
		fmt.Fprintf(out, " desc=%q", desc)
	}
	for _, flag := range compactFlags(*node) {
		out.WriteByte(' ')
		out.WriteString(flag)
	}
	out.WriteByte('\n')
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
