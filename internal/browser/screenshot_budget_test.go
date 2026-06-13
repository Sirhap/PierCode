package browser

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func encodePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), 128, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestBudgetScreenshotDownscalesLargeImage(t *testing.T) {
	data := encodePNG(t, 4000, 2000) // longest edge 4000 > 1568
	out, format := budgetScreenshot(data, "png")
	if format != "jpeg" {
		t.Fatalf("expected jpeg after budget, got %s", format)
	}
	img, _, err := image.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("decode budgeted image: %v", err)
	}
	longest := img.Width
	if img.Height > longest {
		longest = img.Height
	}
	if longest > maxScreenshotEdgePx {
		t.Fatalf("longest edge %d still exceeds cap %d", longest, maxScreenshotEdgePx)
	}
	if len(out) > maxScreenshotBytes {
		t.Fatalf("budgeted bytes %d exceed cap %d", len(out), maxScreenshotBytes)
	}
}

func TestBudgetScreenshotSmallImagePasses(t *testing.T) {
	// Small JPEG well under the budget should re-encode small, never grow huge.
	img := image.NewRGBA(image.Rect(0, 0, 200, 100))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 80})
	out, format := budgetScreenshot(buf.Bytes(), "jpeg")
	if format != "jpeg" {
		t.Fatalf("expected jpeg, got %s", format)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if cfg.Width != 200 || cfg.Height != 100 {
		t.Fatalf("small image should not be resized, got %dx%d", cfg.Width, cfg.Height)
	}
}

func TestBudgetScreenshotGarbagePassthrough(t *testing.T) {
	junk := []byte("not an image")
	out, format := budgetScreenshot(junk, "png")
	if !bytes.Equal(out, junk) || format != "png" {
		t.Fatal("undecodable bytes should pass through unchanged")
	}
}
