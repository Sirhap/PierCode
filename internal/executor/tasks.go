package executor

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sirhap/piercode/internal/procutil"
	"github.com/sirhap/piercode/internal/tool"
)

// TaskStatus is the lifecycle state of a background task.
type TaskStatus string

const (
	TaskRunning  TaskStatus = "running"
	TaskDone     TaskStatus = "done"
	TaskFailed   TaskStatus = "failed"
	TaskCanceled TaskStatus = "canceled"
	TaskTimedOut TaskStatus = "timed_out"
)

// Task is a single background command launch. It is safe for concurrent
// reads via Snapshot; mutation happens only from the task's own goroutine.
type Task struct {
	ID        string
	CallID    string
	Command   string
	Dir       string
	StartedAt time.Time
	EndedAt   time.Time
	ExitCode  int
	ErrMsg    string

	mu        sync.Mutex
	status    TaskStatus
	stdoutBuf []byte
	stderrBuf []byte
	stdin     io.WriteCloser
	cancel    context.CancelFunc
	doneCh    chan struct{}
}

// TaskSummary is a JSON-friendly snapshot, used by /tasks endpoints.
type TaskSummary struct {
	ID         string `json:"id"`
	CallID     string `json:"call_id,omitempty"`
	Command    string `json:"command"`
	Status     string `json:"status"`
	StartedAt  string `json:"started_at"`
	EndedAt    string `json:"ended_at,omitempty"`
	ExitCode   int    `json:"exit_code,omitempty"`
	ErrMsg     string `json:"error,omitempty"`
	StdoutSize int    `json:"stdout_size"`
	StderrSize int    `json:"stderr_size"`
}

// Snapshot returns the current state of the task in a JSON-friendly form.
func (t *Task) Snapshot() TaskSummary {
	t.mu.Lock()
	defer t.mu.Unlock()
	s := TaskSummary{
		ID:         t.ID,
		CallID:     t.CallID,
		Command:    t.Command,
		Status:     string(t.status),
		StartedAt:  t.StartedAt.Format(time.RFC3339),
		ExitCode:   t.ExitCode,
		ErrMsg:     t.ErrMsg,
		StdoutSize: len(t.stdoutBuf),
		StderrSize: len(t.stderrBuf),
	}
	if !t.EndedAt.IsZero() {
		s.EndedAt = t.EndedAt.Format(time.RFC3339)
	}
	return s
}

// Output returns the accumulated stdout and stderr captured so far.
func (t *Task) Output() (stdout, stderr string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.stdoutBuf), string(t.stderrBuf)
}

// WriteStdin writes data to the task's stdin pipe. Returns an error if the
// task is no longer running or if stdin was not wired up (which currently
// never happens — every task gets a stdin pipe).
func (t *Task) WriteStdin(data string) error {
	t.mu.Lock()
	if t.status != TaskRunning {
		t.mu.Unlock()
		return fmt.Errorf("task is %s, not running", t.status)
	}
	w := t.stdin
	t.mu.Unlock()
	if w == nil {
		return errors.New("task has no stdin pipe")
	}
	_, err := w.Write([]byte(data))
	return err
}

// Done returns a channel that is closed when the task finishes for any reason.
func (t *Task) Done() <-chan struct{} {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.doneCh
}

// TaskManager owns the in-process background task registry. It is safe for
// concurrent use. The zero value is not usable; construct via NewTaskManager.
type TaskManager struct {
	mu     sync.RWMutex
	tasks  map[string]*Task
	seq    atomic.Uint64
	closed atomic.Bool

	subMu     sync.RWMutex
	subSeq    uint64
	chunkSubs map[uint64]ChunkSubscriber
	doneSubs  map[uint64]DoneSubscriber

	gcMu   sync.Mutex
	gcStop chan struct{}
}

// ChunkSubscriber receives every stdout/stderr chunk from every task.
// Implementations must not block — chunks arrive from the task's own
// goroutine and a slow subscriber will back up command output.
type ChunkSubscriber func(taskID, callID, stream, text string)

// DoneSubscriber receives a notification when any task finishes.
type DoneSubscriber func(taskID, callID string, exitCode int, status string, errMsg string, durationMs int64)

// taskRetention is how long a finished task is kept in the registry before
// the GC sweep removes it. Long enough that a TUI / extension can still pull
// /tasks/<id> output for a while after the task ended; short enough that a
// long-running server with many short tasks doesn't accumulate them forever.
const taskRetention = 30 * time.Minute

// gcInterval is how often the GC goroutine sweeps for finished tasks past
// their retention window.
const gcInterval = 5 * time.Minute

// NewTaskManager returns an empty manager.
func NewTaskManager() *TaskManager {
	m := &TaskManager{
		tasks:     make(map[string]*Task),
		chunkSubs: make(map[uint64]ChunkSubscriber),
		doneSubs:  make(map[uint64]DoneSubscriber),
	}
	go m.runGC()
	return m
}

// runGC removes finished tasks past their retention window. Without this the
// tasks map grows unbounded: each task carries up to 256KB of stdout/stderr
// buffer, and a long-running server eventually OOMs.
func (m *TaskManager) runGC() {
	ticker := time.NewTicker(gcInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			m.gcOnce(time.Now())
		case <-m.gcStopOnce():
			return
		}
	}
}

// gcStopOnce returns a channel closed when Close is called. We can't reuse
// the existing closed flag for select, so we expose a derived channel.
//
// If Close already ran before the GC loop first evaluated this (the manager is
// closed but gcStop was still nil), we create the channel and close it
// immediately. Otherwise the GC loop would receive a fresh, never-closed
// channel and block forever, leaking the goroutine.
func (m *TaskManager) gcStopOnce() <-chan struct{} {
	m.gcMu.Lock()
	defer m.gcMu.Unlock()
	if m.gcStop == nil {
		m.gcStop = make(chan struct{})
		if m.closed.Load() {
			close(m.gcStop)
		}
	}
	return m.gcStop
}

func (m *TaskManager) gcOnce(now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, t := range m.tasks {
		t.mu.Lock()
		ended := t.EndedAt
		status := t.status
		t.mu.Unlock()
		if status == TaskRunning || ended.IsZero() {
			continue
		}
		if now.Sub(ended) >= taskRetention {
			delete(m.tasks, id)
		}
	}
}

// SubscribeChunks registers a callback for every chunk produced by any task.
// Subscribers added later only see chunks from tasks started after the call.
// Returns an unsubscribe function; calling it multiple times is safe.
func (m *TaskManager) SubscribeChunks(cb ChunkSubscriber) func() {
	if cb == nil {
		return func() {}
	}
	m.subMu.Lock()
	m.subSeq++
	id := m.subSeq
	m.chunkSubs[id] = cb
	m.subMu.Unlock()
	return func() {
		m.subMu.Lock()
		delete(m.chunkSubs, id)
		m.subMu.Unlock()
	}
}

// SubscribeDone registers a callback for every task completion. Returns an
// unsubscribe function; calling it multiple times is safe.
func (m *TaskManager) SubscribeDone(cb DoneSubscriber) func() {
	if cb == nil {
		return func() {}
	}
	m.subMu.Lock()
	m.subSeq++
	id := m.subSeq
	m.doneSubs[id] = cb
	m.subMu.Unlock()
	return func() {
		m.subMu.Lock()
		delete(m.doneSubs, id)
		m.subMu.Unlock()
	}
}

func (m *TaskManager) fanoutChunk(taskID, callID, stream, text string) {
	m.subMu.RLock()
	subs := make([]ChunkSubscriber, 0, len(m.chunkSubs))
	for _, cb := range m.chunkSubs {
		subs = append(subs, cb)
	}
	m.subMu.RUnlock()
	// Chunk dispatch is synchronous so subscribers see chunks in order and
	// callers waiting on tm.Get(id).Done() can safely read accumulated state
	// immediately afterwards. Subscribers MUST NOT block — a slow subscriber
	// will stall pumpStream, the OS pipe fills up, and the child process gets
	// backpressured. The TUI logger and WS broadcast both copy text into a
	// buffered channel and return; new subscribers should follow that pattern.
	// safeChunkCB isolates panics so a buggy subscriber can't kill the pump.
	for _, cb := range subs {
		safeChunkCB(cb, taskID, callID, stream, text)
	}
}

func (m *TaskManager) fanoutDone(taskID, callID string, exitCode int, status string, errMsg string, durationMs int64) {
	m.subMu.RLock()
	subs := make([]DoneSubscriber, 0, len(m.doneSubs))
	for _, cb := range m.doneSubs {
		subs = append(subs, cb)
	}
	m.subMu.RUnlock()
	// Done events are one-shot per task and fire only after the pump finishes,
	// so synchronous dispatch can't stall the child process. Keeping it
	// synchronous preserves the "task.Done() returned ⇒ subscribers were
	// notified" contract that callers (and tests) rely on.
	for _, cb := range subs {
		safeDoneCB(cb, taskID, callID, exitCode, status, errMsg, durationMs)
	}
}

func safeChunkCB(cb ChunkSubscriber, taskID, callID, stream, text string) {
	defer func() { _ = recover() }()
	cb(taskID, callID, stream, text)
}

func safeDoneCB(cb DoneSubscriber, taskID, callID string, exitCode int, status string, errMsg string, durationMs int64) {
	defer func() { _ = recover() }()
	cb(taskID, callID, exitCode, status, errMsg, durationMs)
}

// Start launches a background task. The spec's OnChunk / OnDone callbacks are
// invoked from the task's own goroutine (which means the callbacks must not
// block on locks that the caller will hold while Start runs).
//
// Returns the new task's ID, or an error if the manager is closed or the spec
// is invalid.
func (m *TaskManager) Start(spec tool.TaskSpec) (string, error) {
	if spec.Command == "" {
		return "", errors.New("command is required")
	}

	id := fmt.Sprintf("bg-%d-%d", time.Now().UnixNano(), m.seq.Add(1))

	parent := context.Background()
	var cancel context.CancelFunc
	var ctx context.Context
	if spec.Timeout > 0 {
		ctx, cancel = context.WithTimeout(parent, spec.Timeout)
	} else {
		ctx, cancel = context.WithCancel(parent)
	}

	t := &Task{
		ID:        id,
		CallID:    spec.CallID,
		Command:   spec.Command,
		Dir:       spec.Dir,
		StartedAt: time.Now(),
		status:    TaskRunning,
		cancel:    cancel,
		doneCh:    make(chan struct{}),
	}

	m.mu.Lock()
	if m.closed.Load() {
		m.mu.Unlock()
		cancel()
		return "", errors.New("task manager is closed")
	}
	m.tasks[id] = t
	m.mu.Unlock()

	go m.run(ctx, t, spec)
	return id, nil
}

// Stop cancels a running task. Returns ErrTaskNotFound if the id is unknown
// or ErrTaskAlreadyDone if the task already finished.
func (m *TaskManager) Stop(id string) error {
	m.mu.RLock()
	t, ok := m.tasks[id]
	m.mu.RUnlock()
	if !ok {
		return ErrTaskNotFound
	}
	t.mu.Lock()
	if t.status != TaskRunning {
		t.mu.Unlock()
		return ErrTaskAlreadyDone
	}
	cancel := t.cancel
	t.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return nil
}

// SendStdin forwards data to the named task's stdin. Returns ErrTaskNotFound
// if the id is unknown, ErrTaskAlreadyDone if it already finished, or the
// underlying write error.
func (m *TaskManager) SendStdin(id, data string) error {
	m.mu.RLock()
	t, ok := m.tasks[id]
	m.mu.RUnlock()
	if !ok {
		return ErrTaskNotFound
	}
	return t.WriteStdin(data)
}

// Get returns the task, or nil if not found.
func (m *TaskManager) Get(id string) *Task {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.tasks[id]
}

// List returns a snapshot of every task currently tracked by the manager.
func (m *TaskManager) List() []TaskSummary {
	m.mu.RLock()
	tasks := make([]*Task, 0, len(m.tasks))
	for _, t := range m.tasks {
		tasks = append(tasks, t)
	}
	m.mu.RUnlock()

	out := make([]TaskSummary, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, t.Snapshot())
	}
	return out
}

// Close cancels every running task and prevents future Start calls. Safe to
// call multiple times.
func (m *TaskManager) Close() {
	if !m.closed.CompareAndSwap(false, true) {
		return
	}
	// Mark closed (above) before touching gcStop so a concurrent gcStopOnce
	// that creates the channel sees closed==true and closes it itself. Here we
	// create-and-close if it doesn't exist yet, or close it if it does. Either
	// way the GC loop's next select observes a closed channel and returns.
	m.gcMu.Lock()
	if m.gcStop == nil {
		m.gcStop = make(chan struct{})
	}
	select {
	case <-m.gcStop:
	default:
		close(m.gcStop)
	}
	m.gcMu.Unlock()
	m.mu.Lock()
	tasks := make([]*Task, 0, len(m.tasks))
	for _, t := range m.tasks {
		tasks = append(tasks, t)
	}
	m.mu.Unlock()
	for _, t := range tasks {
		t.mu.Lock()
		cancel := t.cancel
		t.mu.Unlock()
		if cancel != nil {
			cancel()
		}
	}
}

// Errors returned by TaskManager.
var (
	ErrTaskNotFound    = errors.New("task not found")
	ErrTaskAlreadyDone = errors.New("task already finished")
)

// Max bytes we keep per stream buffer; chunks past this are still forwarded
// to OnChunk but dropped from in-memory history.
const maxStreamBufBytes = 256 * 1024

func (m *TaskManager) run(ctx context.Context, t *Task, spec tool.TaskSpec) {
	// finishedExplicitly guards the defer fallback below: if any code path
	// already called m.finish, we must not overwrite its status/err in the
	// defer, otherwise real errors like "stdout pipe: ..." get silently
	// replaced with a generic "task exited without explicit status".
	finishedExplicitly := false
	defer func() {
		// Always release the WithTimeout/WithCancel resources from Start.
		// Stop() also calls this cancel; double-cancel is safe.
		t.mu.Lock()
		cancel := t.cancel
		t.mu.Unlock()
		if cancel != nil {
			cancel()
		}

		t.mu.Lock()
		if !finishedExplicitly && t.status == TaskRunning {
			t.status = TaskFailed
			if t.ErrMsg == "" {
				t.ErrMsg = "task exited without explicit status"
			}
		}
		if t.EndedAt.IsZero() {
			t.EndedAt = time.Now()
		}
		// doneCh is closed exactly once, here, under the lock.
		select {
		case <-t.doneCh:
			// already closed (shouldn't happen, but make this defensive
			// against future refactors)
		default:
			close(t.doneCh)
		}
		t.mu.Unlock()
	}()

	finish := func(exitCode int, errMsg string, status TaskStatus) {
		finishedExplicitly = true
		m.finish(t, exitCode, errMsg, status, spec)
	}

	shell, flag := backgroundShell()
	cmd := exec.CommandContext(ctx, shell, flag, spec.Command)
	cmd.Dir = spec.Dir
	procutil.ConfigureCommand(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		finish(-1, fmt.Sprintf("stdin pipe: %v", err), TaskFailed)
		return
	}
	t.mu.Lock()
	t.stdin = stdin
	t.mu.Unlock()
	// Ensure stdin is closed when run() returns so any pending WriteStdin
	// caller doesn't hang on a half-closed pipe after the task ends.
	defer func() {
		t.mu.Lock()
		s := t.stdin
		t.stdin = nil
		t.mu.Unlock()
		if s != nil {
			_ = s.Close()
		}
	}()

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		finish(-1, fmt.Sprintf("stdout pipe: %v", err), TaskFailed)
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		finish(-1, fmt.Sprintf("stderr pipe: %v", err), TaskFailed)
		return
	}
	if err := cmd.Start(); err != nil {
		finish(-1, fmt.Sprintf("start: %v", err), TaskFailed)
		return
	}

	// Wrap OnChunk so both the per-task subscriber and the global fanout
	// receive every chunk. Either may be nil.
	onChunk := func(stream, text string) {
		if spec.OnChunk != nil {
			spec.OnChunk(stream, text)
		}
		m.fanoutChunk(t.ID, t.CallID, stream, text)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go m.pumpStream(t, "stdout", stdout, onChunk, &wg)
	go m.pumpStream(t, "stderr", stderr, onChunk, &wg)
	wg.Wait()

	waitErr := cmd.Wait()
	exitCode := 0
	errMsg := ""
	status := TaskDone
	switch {
	case ctx.Err() == context.DeadlineExceeded:
		status = TaskTimedOut
		errMsg = "execution timeout"
		exitCode = -1
	case ctx.Err() == context.Canceled:
		status = TaskCanceled
		errMsg = "canceled"
		exitCode = -1
	case waitErr != nil:
		status = TaskFailed
		errMsg = waitErr.Error()
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}

	finish(exitCode, errMsg, status)
}

func (m *TaskManager) pumpStream(t *Task, stream string, r io.ReadCloser, onChunk func(string, string), wg *sync.WaitGroup) {
	defer wg.Done()
	defer r.Close()

	br := bufio.NewReaderSize(r, 4096)
	buf := make([]byte, 4096)
	// pending holds the tail of the previous Read when it ended mid–UTF-8
	// sequence (e.g. a 3-byte CJK rune split across two 4 KB reads). We
	// prepend it to the next chunk so onChunk callers never see a partial
	// rune and the receiver doesn't render '�' in the middle of words.
	var pending []byte
	for {
		n, err := br.Read(buf)
		if n > 0 {
			combined := buf[:n]
			if len(pending) > 0 {
				combined = append(pending, combined...)
				pending = nil
			}
			emit, leftover := splitOnUTF8Boundary(combined)
			if len(leftover) > 0 {
				// Keep an independent copy — combined may share buf's backing
				// array and the next Read will overwrite it.
				pending = append([]byte(nil), leftover...)
			}
			if len(emit) > 0 {
				chunk := procutil.DecodeCommandOutput(emit)
				t.mu.Lock()
				switch stream {
				case "stdout":
					t.stdoutBuf = appendBounded(t.stdoutBuf, []byte(chunk))
				case "stderr":
					t.stderrBuf = appendBounded(t.stderrBuf, []byte(chunk))
				}
				t.mu.Unlock()
				if onChunk != nil {
					onChunk(stream, chunk)
				}
			}
		}
		if err != nil {
			// On EOF flush any remaining bytes (likely a truly malformed
			// trailer, but better to surface them than silently drop).
			if len(pending) > 0 {
				chunk := procutil.DecodeCommandOutput(pending)
				t.mu.Lock()
				switch stream {
				case "stdout":
					t.stdoutBuf = appendBounded(t.stdoutBuf, []byte(chunk))
				case "stderr":
					t.stderrBuf = appendBounded(t.stderrBuf, []byte(chunk))
				}
				t.mu.Unlock()
				if onChunk != nil {
					onChunk(stream, chunk)
				}
			}
			return
		}
	}
}

// splitOnUTF8Boundary scans backwards from the end of data looking for the
// last byte that begins a complete UTF-8 sequence. Returns the prefix that's
// safe to emit as a string and a trailing remainder to carry into the next
// read.
//
// We look at most 4 bytes back (the longest valid UTF-8 sequence is 4 bytes).
// Bytes ≤ 0x7F are single-byte ASCII; bytes 0x80-0xBF are continuation bytes;
// 0xC0-0xFF start a multi-byte sequence with a known length.
func splitOnUTF8Boundary(data []byte) (emit, leftover []byte) {
	if len(data) == 0 {
		return nil, nil
	}
	// Walk back up to 4 bytes to find the most recent sequence start.
	const maxLookback = 4
	limit := len(data) - maxLookback
	if limit < 0 {
		limit = 0
	}
	for i := len(data) - 1; i >= limit; i-- {
		b := data[i]
		if b < 0x80 {
			// ASCII byte at position i is itself a complete sequence; everything
			// up to and including i is safe.
			return data, nil
		}
		if b&0xC0 == 0xC0 {
			// Start of a multi-byte sequence. Figure out how many bytes it needs.
			need := 0
			switch {
			case b&0xE0 == 0xC0:
				need = 2
			case b&0xF0 == 0xE0:
				need = 3
			case b&0xF8 == 0xF0:
				need = 4
			default:
				// Invalid lead byte; treat it as already done so we keep moving.
				return data, nil
			}
			tail := len(data) - i
			if tail >= need {
				// The sequence at i is complete within data.
				return data, nil
			}
			// The sequence is incomplete — emit everything before i, defer the
			// rest to the next read.
			return data[:i], data[i:]
		}
		// Continuation byte (0x80-0xBF); keep walking back to find its lead.
	}
	// Couldn't find a sequence start in the lookback window — emit it all.
	return data, nil
}

func appendBounded(dst, src []byte) []byte {
	if len(dst)+len(src) <= maxStreamBufBytes {
		return append(dst, src...)
	}
	keep := maxStreamBufBytes - len(src)
	if keep < 0 {
		// src alone is bigger than the budget; keep just the tail of src
		return append([]byte(nil), src[len(src)-maxStreamBufBytes:]...)
	}
	tail := dst[len(dst)-keep:]
	out := make([]byte, 0, maxStreamBufBytes)
	out = append(out, tail...)
	out = append(out, src...)
	return out
}

func (m *TaskManager) finish(t *Task, exitCode int, errMsg string, status TaskStatus, spec tool.TaskSpec) {
	t.mu.Lock()
	t.status = status
	t.ExitCode = exitCode
	t.ErrMsg = errMsg
	if t.EndedAt.IsZero() {
		t.EndedAt = time.Now()
	}
	duration := t.EndedAt.Sub(t.StartedAt).Milliseconds()
	t.mu.Unlock()
	if spec.OnDone != nil {
		spec.OnDone(exitCode, duration, errMsg)
	}
	m.fanoutDone(t.ID, t.CallID, exitCode, string(status), errMsg, duration)
}

func backgroundShell() (string, string) {
	if runtime.GOOS == "windows" {
		return "cmd.exe", "/C"
	}
	return "sh", "-c"
}

// Snapshots returns the tool-package-friendly view of every task currently
// tracked by the manager. Implements tool.TaskRunner.Snapshots.
func (m *TaskManager) Snapshots() []tool.TaskSnapshot {
	summaries := m.List()
	out := make([]tool.TaskSnapshot, 0, len(summaries))
	for _, s := range summaries {
		out = append(out, taskSummaryToSnapshot(s))
	}
	return out
}

// GetSnapshot returns a snapshot of the named task plus its captured stdout
// and stderr. Implements tool.TaskRunner.GetSnapshot.
func (m *TaskManager) GetSnapshot(id string) (tool.TaskSnapshot, string, string, bool) {
	t := m.Get(id)
	if t == nil {
		return tool.TaskSnapshot{}, "", "", false
	}
	stdout, stderr := t.Output()
	return taskSummaryToSnapshot(t.Snapshot()), stdout, stderr, true
}

func taskSummaryToSnapshot(s TaskSummary) tool.TaskSnapshot {
	return tool.TaskSnapshot{
		ID:         s.ID,
		CallID:     s.CallID,
		Command:    s.Command,
		Status:     s.Status,
		StartedAt:  s.StartedAt,
		EndedAt:    s.EndedAt,
		ExitCode:   s.ExitCode,
		ErrMsg:     s.ErrMsg,
		StdoutSize: s.StdoutSize,
		StderrSize: s.StderrSize,
	}
}
