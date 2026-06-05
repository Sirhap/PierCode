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

func TestReadOnlyLocksCanRunConcurrently(t *testing.T) {
	e := New(testConfig(t))
	unlockRead := e.lockForTool("read_file")
	defer unlockRead()

	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("grep")
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
	unlockRead := e.lockForTool("read_file")

	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("edit")
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
	unlockWrite := e.lockForTool("edit")

	var once sync.Once
	acquired := make(chan func(), 1)
	go func() {
		acquired <- e.lockForTool("exec_cmd")
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
