package tool

import (
	"bytes"
	"io"
	"runtime"
	"strings"
	"testing"

	"github.com/afumu/openlink/internal/types"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

func TestExecCmdValidate(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	tool := NewExecCmdTool(cfg)

	if err := tool.Validate(map[string]interface{}{"command": "ls"}); err != nil {
		t.Errorf("expected valid: %v", err)
	}
	if err := tool.Validate(map[string]interface{}{}); err == nil {
		t.Error("expected error for missing command")
	}
	if err := tool.Validate(map[string]interface{}{"command": "sudo rm -rf /"}); err == nil {
		t.Error("expected error for dangerous command")
	}
}

func TestDecodeCommandOutputPreservesUTF8(t *testing.T) {
	want := "中文输出🙂"
	if got := decodeCommandOutput([]byte(want)); got != want {
		t.Fatalf("expected UTF-8 output preserved, got %q", got)
	}
}

func TestDecodeCommandOutputFallsBackToGBKOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("GBK fallback is Windows-only")
	}
	reader := transform.NewReader(bytes.NewReader([]byte("中文输出")), simplifiedchinese.GBK.NewEncoder())
	gbk, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if got := decodeCommandOutput(gbk); got != "中文输出" {
		t.Fatalf("expected GBK fallback on Windows, got %q", got)
	}
}

func TestExecCmdExecute(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	tool := NewExecCmdTool(cfg)

	t.Run("runs echo", func(t *testing.T) {
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"command": "echo hello"}))
		if res.Status != "success" {
			t.Fatalf("expected success: %s", res.Error)
		}
		if !strings.Contains(res.Output, "hello") {
			t.Errorf("expected 'hello' in output, got %q", res.Output)
		}
	})

	t.Run("cmd alias works", func(t *testing.T) {
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"cmd": "echo hi"}))
		if res.Status != "success" {
			t.Fatalf("expected success: %s", res.Error)
		}
	})

	t.Run("failed command returns error status", func(t *testing.T) {
		res := tool.Execute(testCtx(cfg, map[string]interface{}{"command": "exit 1"}))
		if res.Status != "error" {
			t.Error("expected error status for non-zero exit")
		}
	})
}
