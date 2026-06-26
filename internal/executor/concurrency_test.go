package executor

import (
	"sync"
	"testing"
	"time"
)

func TestToolConcurrencyPolicy(t *testing.T) {
	e := New(testConfig(t))

	for _, name := range []string{
		"read_file", "list_dir", "glob", "grep", "web_fetch", "skill", "question",
		"tool_help", "browser_find", "browser_console", "browser_network", "browser_get_attributes",
	} {
		tool, ok := e.registry.Get(name)
		if !ok {
			t.Fatalf("expected %s to be registered", name)
		}
		if !toolIsReadOnly(tool) {
			t.Fatalf("expected %s to be read-only", name)
		}
	}

	for _, name := range []string{"write_file", "edit", "exec_cmd", "todo_write", "unknown_tool", "",
		"browser_storage", "browser_cookies", "browser_set_cookie", "browser_emulate", "browser_wait_for_navigation"} {
		tool, ok := e.registry.Get(name)
		if ok && toolIsReadOnly(tool) {
			t.Fatalf("expected %s to require exclusive lock", name)
		}
	}
}

// question BLOCKS for a human answer (minutes). It must hold NO lock, or a
// pending prompt would let the next exclusive-lock tool wedge the whole server
// (RWMutex writer-priority queues every later reader behind it). Guard: while a
// question "lock" is held, an exclusive-lock tool must still acquire immediately.
func TestQuestionHoldsNoLock(t *testing.T) {
	e := New(testConfig(t))
	unlockQuestion := e.lockForTool("question", nil, "")
	defer unlockQuestion()

	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("todo_write", nil, "")
	}()

	select {
	case unlock := <-acquired:
		unlock()
	case <-time.After(500 * time.Millisecond):
		t.Fatal("exclusive lock must not block on a held question lock (question must hold no lock)")
	}
}

func TestReadOnlyLocksCanRunConcurrently(t *testing.T) {
	e := New(testConfig(t))
	unlockRead := e.lockForTool("read_file", nil, "")
	defer unlockRead()

	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("grep", nil, "")
	}()

	select {
	case unlock := <-acquired:
		unlock()
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected a second read-only lock to be acquired concurrently")
	}
}

func TestWriteLockWaitsForReadLocks(t *testing.T) {
	e := New(testConfig(t))
	unlockRead := e.lockForTool("read_file", nil, "")

	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("todo_write", nil, "")
	}()

	select {
	case unlock := <-acquired:
		unlock()
		t.Fatal("write lock should wait while a read lock is held")
	case <-time.After(50 * time.Millisecond):
	}

	unlockRead()

	select {
	case unlock := <-acquired:
		unlock()
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected write lock to acquire after read lock is released")
	}
}

func TestWriteLocksAreExclusive(t *testing.T) {
	e := New(testConfig(t))
	unlockWrite := e.lockForTool("todo_write", nil, "")

	var once sync.Once
	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("apply_patch", nil, "")
	}()

	select {
	case unlock := <-acquired:
		once.Do(unlock)
		t.Fatal("second write lock should wait while first write lock is held")
	case <-time.After(50 * time.Millisecond):
	}

	unlockWrite()

	select {
	case unlock := <-acquired:
		once.Do(unlock)
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected second write lock to acquire after first write lock is released")
	}
}

func TestBrowserWriteToolsParallelAcrossTabs(t *testing.T) {
	e := New(testConfig(t))
	unlockTab1 := e.lockForTool("browser_click", map[string]interface{}{"tabId": float64(1)}, "")
	defer unlockTab1()

	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("browser_type", map[string]interface{}{"tabId": float64(2)}, "")
	}()

	select {
	case unlock := <-acquired:
		unlock()
	case <-time.After(500 * time.Millisecond):
		t.Fatal("browser write tools on DIFFERENT tabs must acquire concurrently")
	}
}

func TestBrowserWriteToolsSerializeOnSameTab(t *testing.T) {
	e := New(testConfig(t))
	unlockFirst := e.lockForTool("browser_click", map[string]interface{}{"tabId": float64(7)}, "")

	var once sync.Once
	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("browser_type", map[string]interface{}{"tabId": float64(7)}, "")
	}()

	select {
	case unlock := <-acquired:
		once.Do(unlock)
		t.Fatal("browser write tools on the SAME tab must serialize")
	case <-time.After(50 * time.Millisecond):
	}

	unlockFirst()

	select {
	case unlock := <-acquired:
		once.Do(unlock)
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected the same-tab lock to acquire after release")
	}
}

func TestBrowserDefaultTabCallsShareOneLock(t *testing.T) {
	e := New(testConfig(t))
	unlockFirst := e.lockForTool("browser_click", nil, "")

	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("browser_navigate", map[string]interface{}{}, "")
	}()

	select {
	case unlock := <-acquired:
		unlock()
		t.Fatal("default-tab browser calls must serialize together")
	case <-time.After(50 * time.Millisecond):
	}
	unlockFirst()
	(<-acquired)()
}

func TestBrowserWriteDoesNotBlockOnOtherDomains(t *testing.T) {
	e := New(testConfig(t))
	// A browser action holds only the shared side of toolMu + its tab lock…
	unlockBrowser := e.lockForTool("browser_click", map[string]interface{}{"tabId": float64(3)}, "")
	defer unlockBrowser()

	// …so read-only tools still acquire concurrently.
	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("read_file", nil, "")
	}()
	select {
	case unlock := <-acquired:
		unlock()
	case <-time.After(500 * time.Millisecond):
		t.Fatal("read-only tool must not block behind a browser write tool")
	}

	// …but a filesystem WRITE still waits for the shared lock to clear.
	fsAcquired := make(chan func(), 1)
	go func() {
		fsAcquired <- e.lockForTool("todo_write", nil, "")
	}()
	select {
	case unlock := <-fsAcquired:
		unlock()
		t.Fatal("filesystem write lock should wait while a browser tool holds the shared lock")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestPathWritersParallelAcrossFiles(t *testing.T) {
	e := New(testConfig(t))
	unlockA := e.lockForTool("write_file", map[string]interface{}{"path": "a.txt"}, "/root")
	defer unlockA()

	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("edit", map[string]interface{}{"path": "b.txt"}, "/root")
	}()
	select {
	case unlock := <-acquired:
		unlock()
	case <-time.After(500 * time.Millisecond):
		t.Fatal("writers on DIFFERENT files must acquire concurrently")
	}
}

func TestPathWritersSerializeOnSameFileEvenWithAliasSpelling(t *testing.T) {
	e := New(testConfig(t))
	unlockFirst := e.lockForTool("write_file", map[string]interface{}{"path": "./dir/../a.txt"}, "/root")

	var once sync.Once
	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("edit", map[string]interface{}{"path": "A.TXT"}, "/root")
	}()
	select {
	case unlock := <-acquired:
		once.Do(unlock)
		t.Fatal("writers on the SAME normalized path must serialize")
	case <-time.After(50 * time.Millisecond):
	}
	unlockFirst()
	select {
	case unlock := <-acquired:
		once.Do(unlock)
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected the same-path lock to acquire after release")
	}
}

func TestExecCmdRunsConcurrently(t *testing.T) {
	e := New(testConfig(t))
	unlockShell := e.lockForTool("exec_cmd", nil, "")
	defer unlockShell()

	for _, peer := range []struct {
		name string
		args map[string]interface{}
	}{
		{"exec_cmd", nil},
		{"write_file", map[string]interface{}{"path": "x.txt"}},
		{"read_file", nil},
	} {
		acquired := make(chan func(), 1)
		go func() {
			acquired <- e.lockForTool(peer.name, peer.args, "/root")
		}()
		select {
		case unlock := <-acquired:
			unlock()
		case <-time.After(500 * time.Millisecond):
			t.Fatalf("%s must not queue behind a running exec_cmd", peer.name)
		}
	}
}

func TestGlobalExclusiveStillBlocksScopedWriters(t *testing.T) {
	e := New(testConfig(t))
	unlockExclusive := e.lockForTool("apply_patch", nil, "")

	var once sync.Once
	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("write_file", map[string]interface{}{"path": "a.txt"}, "/root")
	}()
	select {
	case unlock := <-acquired:
		once.Do(unlock)
		t.Fatal("a path writer must wait while apply_patch holds the exclusive lock")
	case <-time.After(50 * time.Millisecond):
	}
	unlockExclusive()
	select {
	case unlock := <-acquired:
		once.Do(unlock)
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected the path writer to acquire after the exclusive lock released")
	}
}

// TestBrowserBatchHoldsNoLock verifies browser_batch acquires no executor lock,
// so its re-dispatched items (which take their own locks) cannot deadlock on a
// recursive RLock and a concurrent exclusive writer is not blocked by the batch.
func TestBrowserBatchHoldsNoLock(t *testing.T) {
	e := New(testConfig(t))
	// browser_batch's lock must be a no-op: taking it then taking a write lock
	// from another goroutine must not block.
	unlock := e.lockForTool("browser_batch", map[string]interface{}{}, "/tmp")
	done := make(chan struct{})
	go func() {
		// An exclusive-lock tool must be able to acquire toolMu while the batch
		// "holds" its (no-op) lock.
		w := e.lockForTool("todo_write", map[string]interface{}{}, "/tmp")
		w()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("exclusive writer blocked while browser_batch lock held — batch must hold no lock")
	}
	unlock()
}
