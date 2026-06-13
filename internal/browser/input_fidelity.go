package browser

import (
	"context"
	"time"
)

// InputFidelity carries the human-realism knobs for pointer/keyboard/scroll
// dispatch. Zero on any field disables that behavior (instant mode), so an
// InputFidelity{} value reproduces the pre-fidelity dispatch exactly.
type InputFidelity struct {
	ClickHoldMS     int // press→release hold
	MoveSteps       int // interpolated mouseMoved points per move
	DragSteps       int // interpolated moves during a drag
	DragHoldMS      int // pause after press before first drag move
	WheelTickPx     int // max px per synthesized wheel tick
	TypeCharDelayMS int // inter-keystroke delay for typed text
	SettleMS        int // post-action settle (opt-in; default 0)
}

func defaultInputFidelity() InputFidelity {
	return InputFidelity{
		ClickHoldMS: 45, MoveSteps: 5, DragSteps: 16, DragHoldMS: 60,
		WheelTickPx: 110, TypeCharDelayMS: 18, SettleMS: 0,
	}
}

// SetInputFidelity overrides the realism config (tests, CLI flags).
func (c *Controller) SetInputFidelity(f InputFidelity) { c.fidelity = f }

// ctxSleep sleeps d respecting context cancellation. d<=0 returns immediately.
func ctxSleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// settle 在动作后等 SettleMS(>0 时)让 SPA 重渲染，再让调用方返回/下次截图。
// SettleMS=0 时无操作；network-idle 等待是 browser_wait 的职责，不在此。
func (c *Controller) settle(ctx context.Context, tabID int) error {
	if c.fidelity.SettleMS <= 0 {
		return nil
	}
	return c.sleep(ctx, time.Duration(c.fidelity.SettleMS)*time.Millisecond)
}

// lerpPoints returns `steps` linearly-interpolated points from `from`
// (exclusive) to `to` (inclusive). steps<=1 returns just [to].
func lerpPoints(from, to Point, steps int) []Point {
	if steps <= 1 {
		return []Point{to}
	}
	out := make([]Point, 0, steps)
	for i := 1; i <= steps; i++ {
		t := float64(i) / float64(steps)
		out = append(out, Point{
			X: from.X + (to.X-from.X)*t,
			Y: from.Y + (to.Y-from.Y)*t,
		})
	}
	return out
}
