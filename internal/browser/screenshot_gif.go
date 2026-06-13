package browser

import (
	"bytes"
	"image"
	"image/color/palette"
	"image/draw"
	"image/gif"
	_ "image/jpeg" // decoders for captured frames
	_ "image/png"
)

// encodeGIF assembles a sequence of encoded frame images (jpeg/png bytes) into a
// single animated GIF. delayCs is the inter-frame delay in centiseconds. Frames
// that fail to decode are skipped. Returns nil if no frame decoded. To bound the
// GIF size, frames are downscaled to at most maxGIFEdgePx on the longest edge.
func encodeGIF(frames [][]byte, delayCs int) ([]byte, error) {
	if delayCs <= 0 {
		delayCs = 10 // 100ms default
	}
	out := &gif.GIF{}
	for _, raw := range frames {
		img, _, err := image.Decode(bytes.NewReader(raw))
		if err != nil {
			continue
		}
		img = downscaleForGIF(img)
		b := img.Bounds()
		// Paletted frame via Floyd–Steinberg against the web-safe palette.
		pal := image.NewPaletted(image.Rect(0, 0, b.Dx(), b.Dy()), palette.Plan9)
		draw.FloydSteinberg.Draw(pal, pal.Bounds(), img, b.Min)
		out.Image = append(out.Image, pal)
		out.Delay = append(out.Delay, delayCs)
	}
	if len(out.Image) == 0 {
		return nil, nil
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, out); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

const maxGIFEdgePx = 800

func downscaleForGIF(src image.Image) image.Image {
	b := src.Bounds()
	longest := b.Dx()
	if b.Dy() > longest {
		longest = b.Dy()
	}
	if longest <= maxGIFEdgePx {
		return src
	}
	factor := (longest + maxGIFEdgePx - 1) / maxGIFEdgePx
	return downscaleBox(src, factor)
}
