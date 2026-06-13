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

func TestMarksRoundTripAndPurge(t *testing.T) {
	r := NewTabRegistry()
	r.SetMarks(3, []tool.MarkedElement{{Index: 1, CenterX: 10, CenterY: 20}})
	got, ok := r.Marks(3)
	if !ok || len(got) != 1 || got[0].CenterX != 10 {
		t.Fatalf("marks round-trip failed: %#v ok=%v", got, ok)
	}
	r.ClearDefault(3)
	if _, ok := r.Marks(3); ok {
		t.Fatal("ClearDefault should purge marks")
	}
}

func TestClearDefaultPurgesLastPointer(t *testing.T) {
	r := NewTabRegistry()
	r.SetLastPointer(7, Point{X: 10, Y: 20})
	if _, ok := r.LastPointer(7); !ok {
		t.Fatal("last pointer should be set")
	}
	// Closing the tab must purge its last-pointer so a reused tabId does not
	// interpolate from a stale prior position.
	r.ClearDefault(7)
	if _, ok := r.LastPointer(7); ok {
		t.Fatal("ClearDefault should delete the tab's last pointer")
	}
}
