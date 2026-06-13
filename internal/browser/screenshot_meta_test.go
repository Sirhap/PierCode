package browser

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"testing"

	"github.com/sirhap/piercode/internal/tool"
)

// makePNG 返回给定设备像素尺寸的 base64 PNG。
func makePNG(w, h int) string {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func TestScreenshotPopulatesCoordinateMetadata(t *testing.T) {
	dir := t.TempDir()
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		var data json.RawMessage
		switch cmd.Method {
		case "getLayoutMetrics":
			// CSS viewport 700×500; at DPR 2 the capture is 1400×1000 device px —
			// both edges below maxScreenshotEdgePx (1568), so budgetScreenshot does
			// no integer downscale and the final px stays 2× the CSS layout viewport.
			data = json.RawMessage(`{"cssLayoutViewport":{"clientWidth":700,"clientHeight":500},"visualViewport":{"scale":1,"pageX":0,"pageY":0}}`)
		case "evaluate":
			data = json.RawMessage(`{"result":{"value":2}}`)
		case "captureScreenshot":
			data = json.RawMessage(`{"data":"` + makePNG(1400, 1000) + `"}`)
		default:
			data = json.RawMessage(`{}`)
		}
		go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: data})
		return true
	})
	c := NewController(relay, func([]byte) {})
	c.tabs.SetDefault(tool.BrowserTab{TabID: 1, URL: "https://example.com"})

	shot, err := c.Screenshot(context.Background(), tool.BrowserScreenshotRequest{Format: "png", OutputDir: dir})
	if err != nil {
		t.Fatalf("Screenshot error: %v", err)
	}
	defer os.Remove(shot.FilePath)
	if shot.CSSWidth != 700 || shot.CSSHeight != 500 {
		t.Fatalf("css dims wrong: %dx%d", shot.CSSWidth, shot.CSSHeight)
	}
	if shot.DevicePixelRatio != 2 {
		t.Fatalf("dpr wrong: %v", shot.DevicePixelRatio)
	}
	if shot.Width != 1400 || shot.Height != 1000 {
		t.Fatalf("pixel dims wrong: %dx%d", shot.Width, shot.Height)
	}
	if shot.ScreenshotScale != 2 {
		t.Fatalf("scale wrong: %v (want 2 = 1400/700)", shot.ScreenshotScale)
	}
}

// TestScreenshotMetadataUnavailable verifies that when getLayoutMetrics fails
// the screenshot still succeeds but leaves CSS dims / scale at zero (so the
// tool footer reports "css/scale unavailable" rather than a misleading 0.00).
func TestScreenshotMetadataUnavailable(t *testing.T) {
	dir := t.TempDir()
	var relay *RelayManager
	relay = NewRelayManagerFromSend(func(payload []byte) bool {
		var cmd Command
		_ = json.Unmarshal(payload, &cmd)
		switch cmd.Method {
		case "getLayoutMetrics":
			// Simulate a failed metrics query: the controller keeps its safe
			// defaults (DPR=1, zero CSS dims) instead of being blocked.
			go relay.DeliverResult(Result{ID: cmd.ID, Success: false, Error: "metrics unavailable"})
		case "evaluate":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: false, Error: "evaluate unavailable"})
		case "captureScreenshot":
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{"data":"` + makePNG(1400, 1000) + `"}`)})
		default:
			go relay.DeliverResult(Result{ID: cmd.ID, Success: true, Data: json.RawMessage(`{}`)})
		}
		return true
	})
	c := NewController(relay, func([]byte) {})
	c.tabs.SetDefault(tool.BrowserTab{TabID: 1, URL: "https://example.com"})

	shot, err := c.Screenshot(context.Background(), tool.BrowserScreenshotRequest{Format: "png", OutputDir: dir})
	if err != nil {
		t.Fatalf("Screenshot error: %v", err)
	}
	defer os.Remove(shot.FilePath)
	if shot.CSSWidth != 0 || shot.CSSHeight != 0 {
		t.Fatalf("css dims should be zero on failure, got %dx%d", shot.CSSWidth, shot.CSSHeight)
	}
	if shot.ScreenshotScale != 0 {
		t.Fatalf("scale should be zero on failure, got %v", shot.ScreenshotScale)
	}
	if shot.DevicePixelRatio != 1 {
		t.Fatalf("dpr should fall back to 1, got %v", shot.DevicePixelRatio)
	}
	if shot.Width != 1400 || shot.Height != 1000 {
		t.Fatalf("pixel dims wrong: %dx%d", shot.Width, shot.Height)
	}
}
