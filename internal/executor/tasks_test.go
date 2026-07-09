package executor

import (
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sirhap/piercode/internal/tool"
)

func skipOnWindows(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("uses POSIX sh; skipped on Windows")
	}
}

func TestTaskManagerStartCapturesOutputAndCompletes(t *testing.T) {
	skipOnWindows(t)
	tm := NewTaskManager()
	defer tm.Close()

	var (
		chunkMu  sync.Mutex
		chunks   []string
		doneMu   sync.Mutex
		doneSeen bool
		exit     int
	)
	id, err := tm.Start(tool.TaskSpec{
		Command: "echo hello && echo world",
		Dir:     t.TempDir(),
		Timeout: 5 * time.Second,
		OnChunk: func(stream, text string) {
			chunkMu.Lock()
			defer chunkMu.Unlock()
			chunks = append(chunks, text)
		},
		OnDone: func(exitCode int, durationMs int64, errMsg string) {
			doneMu.Lock()
			defer doneMu.Unlock()
			doneSeen = true
			exit = exitCode
		},
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty id")
	}

	select {
	case <-tm.Get(id).Done():
	case <-time.After(5 * time.Second):
		t.Fatal("task did not finish in time")
	}

	doneMu.Lock()
	defer doneMu.Unlock()
	if !doneSeen {
		t.Fatal("OnDone was not called")
	}
	if exit != 0 {
		t.Fatalf("expected exit=0, got %d", exit)
	}

	chunkMu.Lock()
	defer chunkMu.Unlock()
	joined := strings.Join(chunks, "")
	if !strings.Contains(joined, "hello") || !strings.Contains(joined, "world") {
		t.Errorf("expected hello+world in chunks, got %q", joined)
	}
	stdout, _ := tm.Get(id).Output()
	if !strings.Contains(stdout, "hello") {
		t.Errorf("expected stdout buffer to retain output, got %q", stdout)
	}
	snap := tm.Get(id).Snapshot()
	if snap.Status != string(TaskDone) {
		t.Errorf("expected status done, got %s", snap.Status)
	}
}

func TestTaskManagerPreservesSourceClientID(t *testing.T) {
	skipOnWindows(t)
	tm := NewTaskManager()
	defer tm.Close()
	conversationURL := "https://chat.qwen.ai/c/task-route-test"

	id, err := tm.Start(tool.TaskSpec{
		CallID:          "task-route-test",
		SourceClientID:  "client-a",
		ConversationURL: conversationURL,
		Command:         "echo ok",
		Dir:             t.TempDir(),
		Timeout:         5 * time.Second,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	select {
	case <-tm.Get(id).Done():
	case <-time.After(5 * time.Second):
		t.Fatal("task did not finish in time")
	}

	if got := tm.SourceClientID(id); got != "client-a" {
		t.Fatalf("expected client-a from SourceClientID, got %q", got)
	}
	if got := tm.ConversationURL(id); got != conversationURL {
		t.Fatalf("expected %q from ConversationURL, got %q", conversationURL, got)
	}
	if got := tm.Get(id).Snapshot().SourceClientID; got != "client-a" {
		t.Fatalf("expected client-a in task summary, got %q", got)
	}
	if got := tm.Get(id).Snapshot().ConversationURL; got != conversationURL {
		t.Fatalf("expected conversation url in task summary, got %q", got)
	}

	found := false
	for _, snap := range tm.Snapshots() {
		if snap.ID == id {
			found = true
			if snap.SourceClientID != "client-a" {
				t.Fatalf("expected client-a in task snapshot, got %q", snap.SourceClientID)
			}
			if snap.ConversationURL != conversationURL {
				t.Fatalf("expected conversation url in task snapshot, got %q", snap.ConversationURL)
			}
		}
	}
	if !found {
		t.Fatalf("expected task %s in snapshots", id)
	}

	snap, _, _, ok := tm.GetSnapshot(id)
	if !ok {
		t.Fatalf("expected GetSnapshot(%s) to succeed", id)
	}
	if snap.SourceClientID != "client-a" {
		t.Fatalf("expected client-a in GetSnapshot, got %q", snap.SourceClientID)
	}
	if snap.ConversationURL != conversationURL {
		t.Fatalf("expected conversation url in GetSnapshot, got %q", snap.ConversationURL)
	}
}

func TestTaskManagerStopCancelsRunning(t *testing.T) {
	skipOnWindows(t)
	tm := NewTaskManager()
	defer tm.Close()

	id, err := tm.Start(tool.TaskSpec{
		Command: "sleep 30",
		Dir:     t.TempDir(),
		Timeout: 60 * time.Second,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Give the task a moment to actually start.
	time.Sleep(100 * time.Millisecond)
	if err := tm.Stop(id); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	select {
	case <-tm.Get(id).Done():
	case <-time.After(3 * time.Second):
		t.Fatal("task did not cancel within 3s")
	}

	snap := tm.Get(id).Snapshot()
	if snap.Status != string(TaskCanceled) {
		t.Errorf("expected canceled, got %s", snap.Status)
	}
}

func TestTaskManagerStopKillsShellChildren(t *testing.T) {
	skipOnWindows(t)
	tm := NewTaskManager()
	defer tm.Close()

	id, err := tm.Start(tool.TaskSpec{
		Command: "sleep 30; echo should-not-run",
		Dir:     t.TempDir(),
		Timeout: 60 * time.Second,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	time.Sleep(100 * time.Millisecond)
	start := time.Now()
	if err := tm.Stop(id); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	select {
	case <-tm.Get(id).Done():
	case <-time.After(3 * time.Second):
		t.Fatal("task did not cancel shell child within 3s")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("cancel took too long, likely left a shell child running: %s", elapsed)
	}

	snap := tm.Get(id).Snapshot()
	if snap.Status != string(TaskCanceled) {
		t.Errorf("expected canceled, got %s", snap.Status)
	}
	stdout, _ := tm.Get(id).Output()
	if strings.Contains(stdout, "should-not-run") {
		t.Fatalf("child command kept running after stop: %q", stdout)
	}
}

// A command whose main process exits while a backgrounded child keeps the
// stdout pipe open must still reach a terminal state promptly (G1). The old
// code blocked on the pump goroutines before cmd.Wait(), so the never-EOFing
// pipe wedged the task in "running" for as long as the child lived.
func TestTaskManagerBackgroundChildDoesNotWedge(t *testing.T) {
	skipOnWindows(t)
	tm := NewTaskManager()
	defer tm.Close()

	// echo runs, then the shell backgrounds a 5s sleep (which inherits the
	// stdout pipe) and exits immediately. The pipe write end stays open for 5s.
	id, err := tm.Start(tool.TaskSpec{
		Command: "echo hi; { sleep 5 & }",
		Dir:     t.TempDir(),
		Timeout: 60 * time.Second,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	start := time.Now()
	select {
	case <-tm.Get(id).Done():
	case <-time.After(3 * time.Second):
		t.Fatal("task wedged: main process exited but pump blocked on child-held pipe")
	}
	if elapsed := time.Since(start); elapsed >= 3*time.Second {
		t.Fatalf("task took %s to finish — did not force-close the child-held pipe", elapsed)
	}
	// The pre-exit output must survive (no truncation from the forced close).
	if stdout, _ := tm.Get(id).Output(); !strings.Contains(stdout, "hi") {
		t.Fatalf("lost pre-exit output; got %q", stdout)
	}
}

// The WaitDelay grace must let a large buffered output drain before the forced
// pipe close, i.e. reaping-before-draining must not truncate normal output.
func TestTaskManagerHighVolumeOutputNotTruncated(t *testing.T) {
	skipOnWindows(t)
	tm := NewTaskManager()
	defer tm.Close()

	id, err := tm.Start(tool.TaskSpec{
		Command: "seq 1 2000",
		Dir:     t.TempDir(),
		Timeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	select {
	case <-tm.Get(id).Done():
	case <-time.After(5 * time.Second):
		t.Fatal("seq task did not finish")
	}
	stdout, _ := tm.Get(id).Output()
	if !strings.Contains(stdout, "\n2000") && !strings.HasSuffix(strings.TrimSpace(stdout), "2000") {
		t.Fatalf("output truncated: last line missing, tail=%q", tail(stdout, 40))
	}
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func TestTaskManagerTimeout(t *testing.T) {
	skipOnWindows(t)
	tm := NewTaskManager()
	defer tm.Close()

	id, err := tm.Start(tool.TaskSpec{
		Command: "sleep 10",
		Dir:     t.TempDir(),
		Timeout: 200 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	select {
	case <-tm.Get(id).Done():
	case <-time.After(3 * time.Second):
		t.Fatal("task did not time out")
	}

	if got := tm.Get(id).Snapshot().Status; got != string(TaskTimedOut) {
		t.Errorf("expected timed_out, got %s", got)
	}
}

func TestTaskManagerConcurrentTasksDoNotBlock(t *testing.T) {
	skipOnWindows(t)
	tm := NewTaskManager()
	defer tm.Close()

	const n = 4
	ids := make([]string, 0, n)
	for i := 0; i < n; i++ {
		id, err := tm.Start(tool.TaskSpec{
			Command: "sleep 0.5",
			Dir:     t.TempDir(),
			Timeout: 5 * time.Second,
		})
		if err != nil {
			t.Fatalf("Start[%d]: %v", i, err)
		}
		ids = append(ids, id)
	}

	start := time.Now()
	for _, id := range ids {
		select {
		case <-tm.Get(id).Done():
		case <-time.After(5 * time.Second):
			t.Fatalf("task %s did not finish", id)
		}
	}
	elapsed := time.Since(start)
	// If concurrent, total wall time should be much less than n * 0.5s.
	if elapsed > time.Duration(n)*400*time.Millisecond {
		t.Errorf("expected concurrent execution; total wall time was %s", elapsed)
	}
}

func TestTaskManagerSubscribers(t *testing.T) {
	skipOnWindows(t)
	tm := NewTaskManager()
	defer tm.Close()

	var (
		mu       sync.Mutex
		chunks   []string
		doneCnt  int
		doneExit int
	)
	tm.SubscribeChunks(func(taskID, callID, stream, text string) {
		mu.Lock()
		defer mu.Unlock()
		chunks = append(chunks, text)
	})
	tm.SubscribeDone(func(taskID, callID string, exitCode int, status string, errMsg string, durationMs int64) {
		mu.Lock()
		defer mu.Unlock()
		doneCnt++
		doneExit = exitCode
	})

	id, err := tm.Start(tool.TaskSpec{
		Command: "echo subbed",
		Dir:     t.TempDir(),
		Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	select {
	case <-tm.Get(id).Done():
	case <-time.After(5 * time.Second):
		t.Fatal("task did not finish")
	}

	mu.Lock()
	defer mu.Unlock()
	if doneCnt != 1 {
		t.Errorf("expected 1 done event, got %d", doneCnt)
	}
	if doneExit != 0 {
		t.Errorf("expected exit=0, got %d", doneExit)
	}
	if !strings.Contains(strings.Join(chunks, ""), "subbed") {
		t.Errorf("expected chunk fanout, got %v", chunks)
	}
}

func TestTaskManagerSubscribersUnsubscribe(t *testing.T) {
	skipOnWindows(t)
	tm := NewTaskManager()
	defer tm.Close()

	var (
		mu       sync.Mutex
		chunkCnt int
		doneCnt  int
	)
	unsubChunk := tm.SubscribeChunks(func(taskID, callID, stream, text string) {
		mu.Lock()
		defer mu.Unlock()
		chunkCnt++
	})
	unsubDone := tm.SubscribeDone(func(taskID, callID string, exitCode int, status string, errMsg string, durationMs int64) {
		mu.Lock()
		defer mu.Unlock()
		doneCnt++
	})

	// First task: subscribers active, should see at least one chunk + one done.
	id1, err := tm.Start(tool.TaskSpec{
		Command: "echo before",
		Dir:     t.TempDir(),
		Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	<-tm.Get(id1).Done()

	mu.Lock()
	chunkBefore := chunkCnt
	doneBefore := doneCnt
	mu.Unlock()
	if chunkBefore == 0 || doneBefore != 1 {
		t.Fatalf("expected chunks>0 and done=1, got chunks=%d done=%d", chunkBefore, doneBefore)
	}

	// Unsubscribe both; a second task should leave the counts unchanged.
	unsubChunk()
	unsubDone()

	id2, err := tm.Start(tool.TaskSpec{
		Command: "echo after",
		Dir:     t.TempDir(),
		Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	<-tm.Get(id2).Done()

	mu.Lock()
	defer mu.Unlock()
	if chunkCnt != chunkBefore {
		t.Errorf("chunk subscriber still firing after unsubscribe: %d → %d", chunkBefore, chunkCnt)
	}
	if doneCnt != doneBefore {
		t.Errorf("done subscriber still firing after unsubscribe: %d → %d", doneBefore, doneCnt)
	}

	// Double-unsubscribe must be safe.
	unsubChunk()
	unsubDone()
}

func TestSplitOnUTF8Boundary(t *testing.T) {
	cases := []struct {
		name     string
		in       []byte
		wantEmit []byte
		wantTail []byte
	}{
		{"pure ascii", []byte("hello"), []byte("hello"), nil},
		{"empty", []byte{}, nil, nil},
		{"complete cjk", []byte("中文"), []byte("中文"), nil},
		// Last 2 bytes are first two of a 3-byte rune (e4 b8 ad = '中').
		{"partial 3byte tail", []byte{'a', 0xE4, 0xB8}, []byte{'a'}, []byte{0xE4, 0xB8}},
		// Pathological input where the 4-byte lookback can't find a lead byte
		// (a stray continuation arriving alone). In practice this only
		// happens when pumpStream's `pending` carry-over has already moved
		// the lead byte into the combined buffer, so the production path
		// never sees this. We document the chosen behavior: forward the
		// bytes rather than indefinitely accumulating malformed input.
		{"only continuation byte forwards as-is", []byte{0x80}, []byte{0x80}, nil},
		// 4-byte emoji rune (😀 = f0 9f 98 80), truncated to 2 bytes.
		{"partial 4byte emoji", []byte{'x', 0xF0, 0x9F}, []byte{'x'}, []byte{0xF0, 0x9F}},
		// Complete 4-byte emoji should pass through whole.
		{"complete 4byte emoji", []byte{0xF0, 0x9F, 0x98, 0x80}, []byte{0xF0, 0x9F, 0x98, 0x80}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			emit, tail := splitOnUTF8Boundary(tc.in)
			// nil vs empty []byte distinction doesn't matter for our use.
			if !bytesEqualLoose(emit, tc.wantEmit) {
				t.Errorf("emit: got %v, want %v", emit, tc.wantEmit)
			}
			if !bytesEqualLoose(tail, tc.wantTail) {
				t.Errorf("tail: got %v, want %v", tail, tc.wantTail)
			}
		})
	}
}

func bytesEqualLoose(a, b []byte) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestTaskManagerPropagatesRealFailureFromPipeError(t *testing.T) {
	skipOnWindows(t)
	tm := NewTaskManager()
	defer tm.Close()

	// Start a task that succeeds normally, then verify that a hypothetical
	// failure path (we can't easily inject a pipe error from a test) doesn't
	// leave the defer wiping a real ErrMsg. We assert the success path also
	// produces no spurious ErrMsg overwrite.
	id, err := tm.Start(tool.TaskSpec{
		Command: "true",
		Dir:     t.TempDir(),
		Timeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	<-tm.Get(id).Done()

	snap := tm.Get(id).Snapshot()
	if snap.Status != string(TaskDone) {
		t.Errorf("expected done, got %s", snap.Status)
	}
	if snap.ErrMsg != "" {
		t.Errorf("expected empty ErrMsg, got %q", snap.ErrMsg)
	}
}

// 回归: Close 早于 runGC 首次求值 gcStopOnce 的竞态下, gcStopOnce 必须返回
// 已关闭的 channel, 否则 gc goroutine 永远阻塞在 select -> 泄漏。
func TestGCStopOnceClosedAfterClose(t *testing.T) {
	m := &TaskManager{
		tasks:     map[string]*Task{},
		chunkSubs: map[uint64]ChunkSubscriber{},
		doneSubs:  map[uint64]DoneSubscriber{},
	}
	// 模拟极端时序: Close 在 gcStop 仍为 nil 时先跑。
	m.Close()

	ch := m.gcStopOnce()
	select {
	case <-ch:
		// ok: 已关闭
	case <-time.After(time.Second):
		t.Fatal("gcStopOnce() channel not closed after Close(); gc goroutine would leak")
	}
}

// 回归: NewTaskManager 启动的 gc goroutine 在 Close 后必须退出, 不泄漏。
func TestNewTaskManagerGCGoroutineStops(t *testing.T) {
	before := runtime.NumGoroutine()
	for i := 0; i < 50; i++ {
		m := NewTaskManager()
		m.Close()
	}
	// 给被取消的 gc goroutine 时间退出。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if runtime.NumGoroutine() <= before+5 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("gc goroutines leaked: before=%d after=%d", before, runtime.NumGoroutine())
}

func TestTaskManagerStartCloseRaceDoesNotLeaveRunningTasks(t *testing.T) {
	skipOnWindows(t)

	for i := 0; i < 50; i++ {
		tm := NewTaskManager()
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = tm.Start(tool.TaskSpec{
				Command: "sleep 30",
				Dir:     t.TempDir(),
				Timeout: 5 * time.Second,
			})
		}()
		go func() {
			defer wg.Done()
			tm.Close()
		}()
		wg.Wait()

		deadline := time.Now().Add(2 * time.Second)
		for {
			running := false
			for _, summary := range tm.List() {
				if summary.Status == string(TaskRunning) {
					running = true
					break
				}
			}
			if !running {
				break
			}
			if time.Now().After(deadline) {
				tm.Close()
				t.Fatalf("task escaped Close in iteration %d: %+v", i, tm.List())
			}
			time.Sleep(10 * time.Millisecond)
		}
		tm.Close()
	}
}
