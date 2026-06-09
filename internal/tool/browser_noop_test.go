package tool

import (
	"context"
	"testing"
)

// The base must satisfy the full BrowserController interface at compile time.
var _ BrowserController = (*noopBrowserController)(nil)

func TestNoopBrowserControllerReturnsErrorNotPanic(t *testing.T) {
	var b noopBrowserController
	if _, err := b.Click(context.Background(), BrowserClickRequest{}); err == nil {
		t.Error("Click on noop base must return an error")
	}
	if _, err := b.ListTabs(context.Background(), false); err == nil {
		t.Error("ListTabs on noop base must return an error")
	}
	if _, err := b.Evaluate(context.Background(), BrowserEvaluateRequest{}); err == nil {
		t.Error("Evaluate on noop base must return an error")
	}
}
