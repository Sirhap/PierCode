package tool

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/sirhap/piercode/internal/procutil"
	"github.com/sirhap/piercode/internal/security"
	"github.com/sirhap/piercode/internal/types"
)

type ExecCmdTool struct {
	config *types.Config
}

func NewExecCmdTool(config *types.Config) *ExecCmdTool {
	return &ExecCmdTool{config: config}
}

func (t *ExecCmdTool) Name() string {
	return "exec_cmd"
}

func (t *ExecCmdTool) Description() string {
	timeoutSec := 60
	if t.config != nil && t.config.Timeout > 0 {
		timeoutSec = t.config.Timeout
	}
	return fmt.Sprintf(`Executes a shell command and returns its output. Starts in the configured working directory; shell access is not an OS-level sandbox.

The working directory persists between commands, but shell state (env vars, functions) does not.

IMPORTANT: Avoid using this tool to run `+"`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`"+` unless explicitly instructed or after you have verified a dedicated tool cannot do the job. Prefer the dedicated tools — they give a better experience and are easier to review/approve:
- Find files: use glob (NOT find or ls)
- Search contents: use grep (NOT grep or rg)
- Read files: use read_file (NOT cat/head/tail)
- Edit files: use edit (NOT sed/awk)
- Write files: use write_file (NOT echo >/cat <<EOF)
- Communicate: output text directly (NOT echo/printf)

# Instructions
- If your command creates new dirs/files, first run `+"`ls`"+` to verify the parent directory exists and is correct.
- Always quote paths containing spaces with double quotes.
- Maintain your cwd by using absolute paths and avoiding `+"`cd`"+`. Use `+"`cd`"+` only if the user explicitly requests it.
- Commands time out after %ds by default (configurable at server start).
- When issuing multiple commands:
  - Independent commands that can run in parallel: emit multiple exec_cmd calls. (When the host page serializes tool calls, chain with `+"`&&`"+` instead.)
  - Commands that depend on each other: use a single call chained with `+"`&&`"+`.
  - Use `+"`;`"+` only when running sequentially and you do not care if earlier commands fail.
  - Do NOT use newlines to separate commands (newlines are ok inside quoted strings).
- For long-running commands, set `+"`background: true`"+` instead of blocking; check task_output later. No trailing `+"`&`"+` needed.
- Avoid unnecessary `+"`sleep`"+`:
  - Do not sleep between commands that can run immediately.
  - Do not retry failing commands in a sleep loop — diagnose the root cause.
  - If you must poll an external process, use a check command (e.g. `+"`gh run view`"+`) rather than sleeping first; keep any needed sleep short (1-5s).
- For git commits/PRs follow the Git Workflow guidance in the system prompt. NEVER skip hooks (--no-verify, --no-gpg-sign) or run destructive git commands (push --force, reset --hard, clean -f) unless the user explicitly asks.`, timeoutSec)
}

func (t *ExecCmdTool) Parameters() interface{} {
	return map[string]string{
		"command": "string (required) - shell command to execute",
	}
}

func (t *ExecCmdTool) Validate(args map[string]interface{}) error {
	if t.config != nil && !t.config.AllowShell {
		return errors.New("exec_cmd is disabled. Restart the server with --allow-shell to enable shell execution (see SECURITY.md for risk).")
	}
	cmd, ok := args["command"].(string)
	if !ok {
		cmd, ok = args["cmd"].(string)
	}
	if !ok || cmd == "" {
		return errors.New("command is required")
	}
	if security.IsDangerousCommand(cmd) {
		return errors.New("dangerous command blocked")
	}
	return nil
}

func getShell() (string, string) {
	if runtime.GOOS == "windows" {
		comspec := os.Getenv("COMSPEC")
		if comspec == "" {
			comspec = "cmd.exe"
		}
		return comspec, "/C"
	}
	return "sh", "-c"
}

func decodeCommandOutput(data []byte) string {
	return procutil.DecodeCommandOutput(data)
}

func (t *ExecCmdTool) Execute(ctx *Context) *Result {
	result := &Result{StartTime: time.Now()}

	cmd, _ := ctx.Args["command"].(string)
	if cmd == "" {
		cmd, _ = ctx.Args["cmd"].(string)
	}

	background, _ := ctx.Args["background"].(bool)
	if background {
		return t.executeBackground(ctx, cmd, result)
	}

	parentCtx := ctx.Context
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	execCtx, cancel := context.WithTimeout(parentCtx, time.Duration(t.config.Timeout)*time.Second)
	defer cancel()

	shell, flag := getShell()
	proc := exec.CommandContext(execCtx, shell, flag, cmd)
	proc.Dir = ctx.EffectiveRootDir()
	procutil.ConfigureCommand(proc)

	// Foreground mode: keep the original CombinedOutput semantics for callers
	// that did not register a streamer, so existing behavior is unchanged.
	if ctx.Streamer == nil {
		output, err := proc.CombinedOutput()
		return t.finalizeForeground(result, cmd, output, err, execCtx)
	}

	// Streamed foreground mode: forward stdout/stderr to the streamer as the
	// command runs, but still return the full collected output synchronously.
	combined, err := runWithStreamer(proc, ctx.Streamer)
	return t.finalizeForeground(result, cmd, combined, err, execCtx)
}

func (t *ExecCmdTool) finalizeForeground(result *Result, cmd string, output []byte, err error, execCtx context.Context) *Result {
	result.EndTime = time.Now()

	// Always decode + truncate whatever we collected first, even on
	// timeout — otherwise a long-running command that produced useful
	// stdout before being killed at the 60s mark returns an empty string
	// to the user, which is much worse than truncated output plus a
	// timeout note.
	outputStr, _ := Truncate(decodeCommandOutput(output))

	if execCtx.Err() == context.DeadlineExceeded {
		result.Status = "error"
		result.Error = "execution timeout"
		if outputStr != "" {
			result.Output = fmt.Sprintf("command: %s\n\n%s\n\n[timeout — output above is partial]", cmd, outputStr)
		}
		return result
	}

	if err != nil {
		// Some commands use nonzero exit codes to convey information other than
		// failure (grep exit 1 = no matches, diff exit 1 = files differ, test
		// exit 1 = condition false). Apply command-specific semantics so we
		// don't mislabel a working command as an error — otherwise the model
		// thinks `grep foo file` "failed" when it simply found nothing.
		if code, ok := exitCodeFrom(err); ok {
			sem := interpretCommandResult(cmd, code)
			if !sem.isError {
				result.Status = "success"
				if outputStr == "" {
					outputStr = sem.message
				}
				if outputStr == "" {
					outputStr = "empty"
				}
				result.Output = fmt.Sprintf("command: %s\n\n%s", cmd, outputStr)
				return result
			}
		}
		result.Status = "error"
		result.Error = err.Error()
		result.Output = outputStr
		return result
	}

	result.Status = "success"
	if outputStr == "" {
		outputStr = "empty"
	}
	result.Output = fmt.Sprintf("command: %s\n\n%s", cmd, outputStr)
	return result
}

func (t *ExecCmdTool) executeBackground(ctx *Context, cmd string, result *Result) *Result {
	result.EndTime = time.Now()
	if ctx.TaskRunner == nil {
		result.Status = "error"
		result.Error = "background mode is not available in this invocation"
		return result
	}
	callID, _ := ctx.Args["call_id"].(string)

	// IMPORTANT: do not wire ctx.Streamer into spec.OnChunk. In background
	// mode the server has already registered a TaskManager-level chunk
	// subscriber (SubscribeChunks) that broadcasts the same WS event. If we
	// also forwarded chunks through spec.OnChunk -> ctx.Streamer, every
	// chunk would be broadcast twice and the extension's streamBox would
	// duplicate every line of stdout. Foreground mode is different: it
	// relies on ctx.Streamer because it doesn't go through TaskManager at
	// all.
	//
	// Background mode runs with no timeout by default — the whole point is to
	// let long-running commands (servers, watchers, builds) outlive the
	// foreground 60s budget. Callers can still cap a single task by passing
	// `timeout` (seconds) in args; `0` or unset means "no limit".
	var taskTimeout time.Duration
	switch v := ctx.Args["timeout"].(type) {
	case float64:
		if v > 0 {
			taskTimeout = time.Duration(v * float64(time.Second))
		}
	case int:
		if v > 0 {
			taskTimeout = time.Duration(v) * time.Second
		}
	}
	spec := TaskSpec{
		CallID:          callID,
		SourceClientID:  ctx.SourceClientID,
		ConversationURL: ctx.ConversationURL,
		Command:         cmd,
		Dir:             ctx.EffectiveRootDir(),
		Timeout:         taskTimeout,
	}
	id, err := ctx.TaskRunner.Start(spec)
	if err != nil {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	result.Status = "running"
	result.Output = fmt.Sprintf("command: %s\n\n[backgrounded as task %s — watch via /tasks/%s]", cmd, id, id)
	return result
}

// runWithStreamer launches proc, splits its stdout/stderr into UTF-8-safe
// chunks, forwards each chunk to streamer, and returns the full combined
// output once the process exits.
func runWithStreamer(proc *exec.Cmd, streamer func(stream, text string)) ([]byte, error) {
	stdoutPipe, err := proc.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderrPipe, err := proc.StderrPipe()
	if err != nil {
		stdoutPipe.Close()
		return nil, err
	}
	if err := proc.Start(); err != nil {
		return nil, err
	}

	var (
		combined bytes.Buffer
		mu       sync.Mutex
		wg       sync.WaitGroup
	)
	pump := func(name string, r io.ReadCloser) {
		defer wg.Done()
		defer r.Close()
		br := bufio.NewReaderSize(r, 4096)
		buf := make([]byte, 4096)
		// pending holds the tail of the previous Read when it ended mid–UTF-8
		// sequence (a CJK or emoji rune split across two 4 KB reads). We
		// prepend it to the next chunk so streamer callers never see a
		// partial rune rendered as '�' in the middle of words. The combined
		// buffer always receives the original bytes (no carry-over), since
		// foreground callers expect the full raw output regardless of split.
		var pending []byte
		for {
			n, readErr := br.Read(buf)
			if n > 0 {
				raw := append([]byte(nil), buf[:n]...)
				mu.Lock()
				combined.Write(raw)
				mu.Unlock()
				if streamer != nil {
					chunk := raw
					if len(pending) > 0 {
						chunk = append(pending, chunk...)
						pending = nil
					}
					emit, leftover := splitOnUTF8Boundary(chunk)
					if len(leftover) > 0 {
						pending = append([]byte(nil), leftover...)
					}
					if len(emit) > 0 {
						streamer(name, decodeCommandOutput(emit))
					}
				}
			}
			if readErr != nil {
				// Flush any trailing bytes that never completed a rune so
				// stream subscribers don't silently drop partial output on EOF.
				if streamer != nil && len(pending) > 0 {
					streamer(name, decodeCommandOutput(pending))
				}
				return
			}
		}
	}
	wg.Add(2)
	go pump("stdout", stdoutPipe)
	go pump("stderr", stderrPipe)
	wg.Wait()

	waitErr := proc.Wait()
	return combined.Bytes(), waitErr
}

// splitOnUTF8Boundary returns the prefix of data that ends on a complete UTF-8
// sequence, plus the trailing remainder to carry into the next read. Mirrors
// executor.splitOnUTF8Boundary; duplicated here to avoid a package cycle.
//
// We look at most 4 bytes back (the longest valid UTF-8 sequence is 4 bytes).
// Bytes ≤ 0x7F are single-byte ASCII; bytes 0x80-0xBF are continuation bytes;
// 0xC0-0xFF start a multi-byte sequence with a known length.
func splitOnUTF8Boundary(data []byte) (emit, leftover []byte) {
	if len(data) == 0 {
		return nil, nil
	}
	const maxLookback = 4
	limit := len(data) - maxLookback
	if limit < 0 {
		limit = 0
	}
	for i := len(data) - 1; i >= limit; i-- {
		b := data[i]
		if b < 0x80 {
			return data, nil
		}
		if b&0xC0 == 0xC0 {
			need := 0
			switch {
			case b&0xE0 == 0xC0:
				need = 2
			case b&0xF0 == 0xE0:
				need = 3
			case b&0xF8 == 0xF0:
				need = 4
			default:
				return data, nil
			}
			tail := len(data) - i
			if tail >= need {
				return data, nil
			}
			return data[:i], data[i:]
		}
	}
	return data, nil
}
