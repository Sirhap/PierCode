package browser

import (
	"archive/zip"
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

func makePNGFrame(t *testing.T, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 20, 20))
	for y := 0; y < 20; y++ {
		for x := 0; x < 20; x++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png encode: %v", err)
	}
	return buf.Bytes()
}

func TestEncodeGIFProducesMultiFrameGIF(t *testing.T) {
	frames := [][]byte{
		makePNGFrame(t, color.RGBA{255, 0, 0, 255}),
		makePNGFrame(t, color.RGBA{0, 255, 0, 255}),
		makePNGFrame(t, color.RGBA{0, 0, 255, 255}),
	}
	out, err := encodeGIF(frames, 20)
	if err != nil {
		t.Fatalf("encodeGIF: %v", err)
	}
	if out == nil {
		t.Fatal("expected non-nil gif bytes")
	}
	g, err := gif.DecodeAll(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("output is not a valid gif: %v", err)
	}
	if len(g.Image) != 3 {
		t.Fatalf("expected 3 frames, got %d", len(g.Image))
	}
	for _, d := range g.Delay {
		if d != 20 {
			t.Fatalf("expected 20cs delay, got %d", d)
		}
	}
}

func TestEncodeGIFSkipsBadFramesReturnsNilIfAllBad(t *testing.T) {
	if out, err := encodeGIF([][]byte{[]byte("not an image")}, 10); err != nil || out != nil {
		t.Fatalf("all-bad frames should yield nil,nil; got %v err=%v", out, err)
	}
	// one good among bad → still encodes
	out, err := encodeGIF([][]byte{[]byte("garbage"), makePNGFrame(t, color.White)}, 10)
	if err != nil || out == nil {
		t.Fatalf("expected one-frame gif, got %v err=%v", out, err)
	}
}

func TestEncodeFramesZipContainsFrames(t *testing.T) {
	f := jpegBytes(2, 2)
	zipped, err := encodeFramesZip([][]byte{f, f, f})
	if err != nil {
		t.Fatalf("zip err: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(zipped), int64(len(zipped)))
	if err != nil {
		t.Fatalf("read zip: %v", err)
	}
	if len(zr.File) != 3 {
		t.Fatalf("expected 3 frames in zip, got %d", len(zr.File))
	}
}

func jpegBytes(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	return buf.Bytes()
}
