package browser

import (
	"context"
	"testing"
	"time"
)

func TestDefaultInputFidelity(t *testing.T) {
	f := defaultInputFidelity()
	if f.ClickHoldMS != 45 || f.MoveSteps != 5 || f.DragSteps != 16 ||
		f.DragHoldMS != 60 || f.WheelTickPx != 110 || f.TypeCharDelayMS != 18 || f.SettleMS != 0 {
		t.Fatalf("unexpected defaults: %#v", f)
	}
}

func TestControllerHasFidelityAndSleep(t *testing.T) {
	c := NewController(nil, func([]byte) {})
	if c.fidelity.ClickHoldMS != 45 {
		t.Fatalf("controller fidelity not initialized: %#v", c.fidelity)
	}
	if err := c.sleep(context.Background(), 0); err != nil {
		t.Fatalf("sleep(0) should be nil, got %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.sleep(ctx, time.Second); err == nil {
		t.Fatalf("sleep should return ctx error when cancelled")
	}
}

func TestSetInputFidelity(t *testing.T) {
	c := NewController(nil, func([]byte) {})
	c.SetInputFidelity(InputFidelity{})
	if c.fidelity.ClickHoldMS != 0 || c.fidelity.MoveSteps != 0 {
		t.Fatalf("SetInputFidelity did not apply zero config")
	}
}

func TestSettleSleepsWhenConfigured(t *testing.T) {
	c := NewController(nil, func([]byte) {})
	c.SetInputFidelity(InputFidelity{SettleMS: 200})
	var got time.Duration
	c.sleep = func(ctx context.Context, d time.Duration) error { got = d; return nil }
	if err := c.settle(context.Background(), 1); err != nil {
		t.Fatalf("settle err: %v", err)
	}
	if got != 200*time.Millisecond {
		t.Fatalf("expected 200ms settle, got %v", got)
	}
}

func TestSettleNoopAtZero(t *testing.T) {
	c := NewController(nil, func([]byte) {})
	c.SetInputFidelity(InputFidelity{SettleMS: 0})
	called := false
	c.sleep = func(ctx context.Context, d time.Duration) error { called = true; return nil }
	_ = c.settle(context.Background(), 1)
	if called {
		t.Fatalf("settle should not sleep at SettleMS=0")
	}
}
