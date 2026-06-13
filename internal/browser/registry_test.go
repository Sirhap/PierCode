package browser

import (
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

func TestConsumeDefaultSwitchReportsTabChange(t *testing.T) {
	r := NewTabRegistry()
	r.SetDefault(tool.BrowserTab{TabID: 100, URL: "https://a.com"})
	// First default → no switch.
	if _, _, ok := r.ConsumeDefaultSwitch(); ok {
		t.Fatal("first SetDefault should not record a switch")
	}
	// Changing to a different tab records a switch.
	r.SetDefault(tool.BrowserTab{TabID: 200, URL: "https://b.com"})
	from, to, ok := r.ConsumeDefaultSwitch()
	if !ok || from != 100 || to != 200 {
		t.Fatalf("expected switch 100→200, got from=%d to=%d ok=%v", from, to, ok)
	}
	// Consumed once: second consume returns nothing.
	if _, _, ok := r.ConsumeDefaultSwitch(); ok {
		t.Fatal("switch should be consumed once")
	}
	// Re-setting the SAME default does not record a switch.
	r.SetDefault(tool.BrowserTab{TabID: 200, URL: "https://b.com/x"})
	if _, _, ok := r.ConsumeDefaultSwitch(); ok {
		t.Fatal("re-setting same default must not record a switch")
	}
}
