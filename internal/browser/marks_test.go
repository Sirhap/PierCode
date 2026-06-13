package browser

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

func TestEnumerateInteractiveReturnsBoxes(t *testing.T) {
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		// enumerateInteractive runs one Runtime.evaluate; return 3 elements.
		data := json.RawMessage(`{"result":{"value":"[` +
			`{\"index\":1,\"x\":10,\"y\":20,\"w\":100,\"h\":30,\"cx\":60,\"cy\":35,\"role\":\"button\",\"text\":\"OK\",\"ref\":\"#ok\"},` +
			`{\"index\":2,\"x\":0,\"y\":60,\"w\":200,\"h\":24,\"cx\":100,\"cy\":72,\"role\":\"link\",\"text\":\"Home\",\"ref\":\"a[name=home]\"},` +
			`{\"index\":3,\"x\":5,\"y\":100,\"w\":150,\"h\":40,\"cx\":80,\"cy\":120,\"role\":\"textbox\",\"text\":\"\",\"ref\":\"#q\"}` +
			`]"}}`)
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		return true
	})
	c := NewController(relay, func([]byte) {})
	marks, err := c.enumerateInteractive(context.Background(), 1)
	if err != nil {
		t.Fatalf("enumerate err: %v", err)
	}
	if len(marks) != 3 {
		t.Fatalf("expected 3 marks, got %d", len(marks))
	}
	for i, m := range marks {
		if m.Index != i+1 {
			t.Fatalf("index not 1-based sequential: %#v", m)
		}
		if m.W == 0 || m.H == 0 {
			t.Fatalf("mark %d missing bbox: %#v", m.Index, m)
		}
	}
	if marks[0].Role != "button" || marks[0].Ref != "#ok" {
		t.Fatalf("mark fields wrong: %#v", marks[0])
	}
}

func TestMarkOverlayExpressionContainsBadges(t *testing.T) {
	expr := buildMarkOverlayExpression([]tool.MarkedElement{
		{Index: 1, X: 10, Y: 20, W: 40, H: 16, CenterX: 30, CenterY: 28},
	})
	for _, must := range []string{"attachShadow", "mode:'closed'", "__piercode_som__"} {
		if !strings.Contains(expr, must) {
			t.Fatalf("overlay expr missing %q", must)
		}
	}
	clr := buildClearOverlayExpression()
	if !strings.Contains(clr, "remove") {
		t.Fatalf("clear expr should remove the overlay host")
	}
}
