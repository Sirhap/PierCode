package procutil

import (
	"bytes"
	"io"
	"runtime"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

// DecodeCommandOutput converts process output bytes into display text.
// Windows shells may emit GBK when the bytes are not valid UTF-8.
func DecodeCommandOutput(data []byte) string {
	if utf8.Valid(data) {
		return string(data)
	}
	if runtime.GOOS == "windows" {
		return decodeGBK(data)
	}
	return string(data)
}

func decodeGBK(data []byte) string {
	reader := transform.NewReader(bytes.NewReader(data), simplifiedchinese.GBK.NewDecoder())
	decoded, err := io.ReadAll(reader)
	if err != nil {
		return string(data)
	}
	return string(decoded)
}
