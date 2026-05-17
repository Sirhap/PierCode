package tool

import (
	"bytes"
	"io"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sirhap/piercode/internal/types"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

func TestExecCmdValidate(t *testing.T) {
	// AllowShell=true: exercise the legacy validation paths.
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10, AllowShell: true}
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

	// AllowShell=false: even a perfectly safe command must be rejected so
	// operators can't accidentally hand the AI a shell.
	disabledCfg := &types.Config{RootDir: t.TempDir(), Timeout: 10}
	disabled := NewExecCmdTool(disabledCfg)
	if err := disabled.Validate(map[string]interface{}{"command": "ls"}); err == nil {
		t.Error("expected exec_cmd to be disabled when AllowShell is false")
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
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 10, AllowShell: true}
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

	t.Run("streamer receives chunks in foreground mode", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("uses POSIX echo; skipped on Windows")
		}
		var (
			mu     sync.Mutex
			chunks []string
		)
		ctx := testCtx(cfg, map[string]interface{}{"command": "echo streamed"})
		ctx.Streamer = func(stream, text string) {
			mu.Lock()
			defer mu.Unlock()
			chunks = append(chunks, text)
		}
		res := tool.Execute(ctx)
		if res.Status != "success" {
			t.Fatalf("expected success, got %s (err=%s)", res.Status, res.Error)
		}
		if !strings.Contains(res.Output, "streamed") {
			t.Errorf("expected combined output to contain streamed, got %q", res.Output)
		}
		mu.Lock()
		defer mu.Unlock()
		if !strings.Contains(strings.Join(chunks, ""), "streamed") {
			t.Errorf("expected streamer to receive 'streamed', got %v", chunks)
		}
	})

	t.Run("background mode returns running status immediately", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("uses POSIX sleep; skipped on Windows")
		}
		runner := &fakeTaskRunner{}
		ctx := testCtx(cfg, map[string]interface{}{
			"command":    "sleep 30",
			"background": true,
		})
		ctx.TaskRunner = runner
		res := tool.Execute(ctx)
		if res.Status != "running" {
			t.Fatalf("expected status=running, got %s", res.Status)
		}
		if !strings.Contains(res.Output, "backgrounded as task") {
			t.Errorf("expected backgrounded marker in output, got %q", res.Output)
		}
		if runner.lastCommand != "sleep 30" {
			t.Errorf("expected runner to receive command, got %q", runner.lastCommand)
		}
	})

	t.Run("background mode without task runner errors", func(t *testing.T) {
		ctx := testCtx(cfg, map[string]interface{}{
			"command":    "echo x",
			"background": true,
		})
		res := tool.Execute(ctx)
		if res.Status != "error" {
			t.Fatalf("expected error when TaskRunner is nil, got %s", res.Status)
		}
	})

	t.Run("timeout returns partial output", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("uses POSIX sleep; skipped on Windows")
		}
		// 1-second budget for the tool but the command echoes early then
		// sleeps past the deadline. The pre-fix behavior threw the early
		// 'before timeout' output away; we expect to see it now.
		shortCfg := &types.Config{RootDir: t.TempDir(), Timeout: 1, AllowShell: true}
		tool := NewExecCmdTool(shortCfg)
		res := tool.Execute(testCtx(shortCfg, map[string]interface{}{
			"command": "echo before timeout && sleep 10",
		}))
		if res.Status != "error" {
			t.Fatalf("expected error from timeout, got %s", res.Status)
		}
		if res.Error != "execution timeout" {
			t.Fatalf("expected 'execution timeout', got %q", res.Error)
		}
		if !strings.Contains(res.Output, "before timeout") {
			t.Errorf("expected partial output to survive timeout, got %q", res.Output)
		}
	})

	t.Run("timeout kills shell children promptly", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("uses POSIX sleep; skipped on Windows")
		}
		shortCfg := &types.Config{RootDir: t.TempDir(), Timeout: 1, AllowShell: true}
		tool := NewExecCmdTool(shortCfg)

		start := time.Now()
		res := tool.Execute(testCtx(shortCfg, map[string]interface{}{
			"command": "echo before timeout; sleep 30; echo should-not-run",
		}))
		elapsed := time.Since(start)

		if res.Status != "error" {
			t.Fatalf("expected timeout error, got %s", res.Status)
		}
		if elapsed > 3*time.Second {
			t.Fatalf("timeout took too long, likely left a shell child running: %s", elapsed)
		}
		if !strings.Contains(res.Output, "before timeout") {
			t.Errorf("expected partial output to survive timeout, got %q", res.Output)
		}
		if strings.Contains(res.Output, "\nshould-not-run\n") {
			t.Fatalf("child command kept running after timeout: %q", res.Output)
		}
	})
}

type fakeTaskRunner struct {
	lastCommand string
	lastSpec    TaskSpec
}

func (f *fakeTaskRunner) Start(spec TaskSpec) (string, error) {
	f.lastCommand = spec.Command
	f.lastSpec = spec
	return "fake-bg-123", nil
}
func (f *fakeTaskRunner) Snapshots() []TaskSnapshot { return nil }
func (f *fakeTaskRunner) GetSnapshot(id string) (TaskSnapshot, string, string, bool) {
	return TaskSnapshot{}, "", "", false
}
func (f *fakeTaskRunner) Stop(id string) error            { return nil }
func (f *fakeTaskRunner) SendStdin(id, data string) error { return nil }

func TestExecCmdBackgroundDefaultsToNoTimeout(t *testing.T) {
	cfg := &types.Config{RootDir: t.TempDir(), Timeout: 60, AllowShell: true}
	tool := NewExecCmdTool(cfg)

	t.Run("default has zero timeout", func(t *testing.T) {
		runner := &fakeTaskRunner{}
		ctx := testCtx(cfg, map[string]interface{}{
			"command":    "sleep 9999",
			"background": true,
		})
		ctx.TaskRunner = runner
		if res := tool.Execute(ctx); res.Status != "running" {
			t.Fatalf("expected running, got %s", res.Status)
		}
		if runner.lastSpec.Timeout != 0 {
			t.Errorf("expected background default timeout=0, got %v", runner.lastSpec.Timeout)
		}
	})

	t.Run("explicit timeout arg is forwarded", func(t *testing.T) {
		runner := &fakeTaskRunner{}
		ctx := testCtx(cfg, map[string]interface{}{
			"command":    "sleep 5",
			"background": true,
			"timeout":    float64(45), // JSON numbers decode as float64
		})
		ctx.TaskRunner = runner
		if res := tool.Execute(ctx); res.Status != "running" {
			t.Fatalf("expected running, got %s", res.Status)
		}
		if got := runner.lastSpec.Timeout; got != 45*time.Second {
			t.Errorf("expected timeout=45s, got %v", got)
		}
	})

	t.Run("zero timeout arg keeps no-timeout default", func(t *testing.T) {
		runner := &fakeTaskRunner{}
		ctx := testCtx(cfg, map[string]interface{}{
			"command":    "sleep 5",
			"background": true,
			"timeout":    float64(0),
		})
		ctx.TaskRunner = runner
		tool.Execute(ctx)
		if runner.lastSpec.Timeout != 0 {
			t.Errorf("expected timeout=0 when arg=0, got %v", runner.lastSpec.Timeout)
		}
	})
}

func TestSplitOnUTF8BoundaryToolPkg(t *testing.T) {
	cases := []struct {
		name     string
		in       []byte
		wantEmit []byte
		wantTail []byte
	}{
		{"pure ascii", []byte("hello"), []byte("hello"), nil},
		{"empty", []byte{}, nil, nil},
		{"complete cjk", []byte("中文"), []byte("中文"), nil},
		// 3-byte rune '中' = e4 b8 ad, truncated to first 2 bytes.
		{"partial 3byte tail", []byte{'a', 0xE4, 0xB8}, []byte{'a'}, []byte{0xE4, 0xB8}},
		// 4-byte emoji '😀' = f0 9f 98 80, truncated to first 2 bytes.
		{"partial 4byte emoji", []byte{'x', 0xF0, 0x9F}, []byte{'x'}, []byte{0xF0, 0x9F}},
		{"complete 4byte emoji", []byte{0xF0, 0x9F, 0x98, 0x80}, []byte{0xF0, 0x9F, 0x98, 0x80}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			emit, tail := splitOnUTF8Boundary(tc.in)
			if !bytes.Equal(coalesce(emit), coalesce(tc.wantEmit)) {
				t.Errorf("emit: got %v, want %v", emit, tc.wantEmit)
			}
			if !bytes.Equal(coalesce(tail), coalesce(tc.wantTail)) {
				t.Errorf("tail: got %v, want %v", tail, tc.wantTail)
			}
		})
	}
}

func coalesce(b []byte) []byte {
	if b == nil {
		return []byte{}
	}
	return b
}
