package browser

import (
	"bytes"
	"image"
	"image/jpeg"
	_ "image/png" // register PNG decoder for captures taken as png
)

// Image-token budget constants. Vision models bill roughly by pixel area, so a
// huge full-page capture wastes tokens and may be downscaled server-side anyway.
// We cap the longest edge and the encoded byte size to keep a screenshot within
// a sane budget before it ever reaches the model.
const (
	maxScreenshotEdgePx  = 1568    // longest-edge cap (matches common vision tiling)
	maxScreenshotBytes   = 900_000 // encoded JPEG byte ceiling
	minScreenshotJPEGQ   = 35      // do not degrade quality below this
	startScreenshotJPEGQ = 75      // first quality to try when re-encoding
	screenshotQStepDown  = 10      // quality decrement per step-down pass
)

// budgetScreenshot takes raw encoded image bytes (jpeg or png) and returns a
// JPEG re-encoded to fit the edge + byte budget. If the input already fits and
// is JPEG, it is returned unchanged. On any decode failure the original bytes
// are returned untouched (best-effort: never make a screenshot unusable).
func budgetScreenshot(data []byte, format string) ([]byte, string) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return data, format
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w == 0 || h == 0 {
		return data, format
	}

	// Downscale by an integer factor if the longest edge exceeds the cap. An
	// integer box average keeps it dependency-free and artifact-light.
	longest := w
	if h > longest {
		longest = h
	}
	if longest > maxScreenshotEdgePx {
		factor := (longest + maxScreenshotEdgePx - 1) / maxScreenshotEdgePx
		if factor > 1 {
			img = downscaleBox(img, factor)
		}
	}

	// Encode JPEG, stepping quality down until under the byte ceiling.
	q := startScreenshotJPEGQ
	var buf bytes.Buffer
	for {
		buf.Reset()
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
			return data, format // give up gracefully
		}
		if buf.Len() <= maxScreenshotBytes || q <= minScreenshotJPEGQ {
			break
		}
		q -= screenshotQStepDown
		if q < minScreenshotJPEGQ {
			q = minScreenshotJPEGQ
		}
	}
	return append([]byte(nil), buf.Bytes()...), "jpeg"
}

// budgetScreenshotWithDims 同 budgetScreenshot，额外返回最终解码后的像素尺寸，
// 供调用方计算截图↔CSS 缩放系数。
func budgetScreenshotWithDims(data []byte, format string) (out []byte, outFormat string, w, h int) {
	out, outFormat = budgetScreenshot(data, format)
	if img, _, err := image.Decode(bytes.NewReader(out)); err == nil {
		b := img.Bounds()
		return out, outFormat, b.Dx(), b.Dy()
	}
	return out, outFormat, 0, 0
}

// downscaleBox shrinks an image by an integer factor using box averaging.
func downscaleBox(src image.Image, factor int) image.Image {
	if factor < 2 {
		return src
	}
	b := src.Bounds()
	dw := b.Dx() / factor
	dh := b.Dy() / factor
	if dw < 1 {
		dw = 1
	}
	if dh < 1 {
		dh = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for dy := 0; dy < dh; dy++ {
		for dx := 0; dx < dw; dx++ {
			var rs, gs, bs, as uint32
			var n uint32
			for sy := 0; sy < factor; sy++ {
				for sx := 0; sx < factor; sx++ {
					r, g, bb, a := src.At(b.Min.X+dx*factor+sx, b.Min.Y+dy*factor+sy).RGBA()
					rs += r
					gs += g
					bs += bb
					as += a
					n++
				}
			}
			if n == 0 {
				n = 1
			}
			i := dst.PixOffset(dx, dy)
			dst.Pix[i+0] = uint8((rs / n) >> 8)
			dst.Pix[i+1] = uint8((gs / n) >> 8)
			dst.Pix[i+2] = uint8((bs / n) >> 8)
			dst.Pix[i+3] = uint8((as / n) >> 8)
		}
	}
	return dst
}
