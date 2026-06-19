// Input dispatch — faithful port of controller.go moveTo/dispatchClick/
// dispatchTypedKeys/sendOneRune/sendNamedKey/sendKeyChordMods + input_fidelity.go.
// All issue Input.dispatchMouseEvent / Input.dispatchKeyEvent / Input.insertText via
// the injected Cdp. fidelity + sleep are injectable so tests run instantly.
import type { Cdp } from './cdp'
import type { Point } from './types'
import type { TabRegistry } from './registry'

type Debuggee = chrome.debugger.Debuggee
type Sleep = (ms: number) => Promise<void>
const realSleep: Sleep = (ms) => new Promise(r => setTimeout(r, ms))

export interface InputFidelity {
  clickHoldMs: number; moveSteps: number; dragSteps: number; dragHoldMs: number
  wheelTickPx: number; typeCharDelayMs: number
}
export const DEFAULT_FIDELITY: InputFidelity = {
  clickHoldMs: 45, moveSteps: 5, dragSteps: 16, dragHoldMs: 60, wheelTickPx: 110, typeCharDelayMs: 18,
}

// CDP modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8 (port chordModifierBit).
const CHORD_MOD: Record<string, number> = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 }

export function lerpPoints(from: Point, to: Point, steps: number): Point[] {
  if (steps <= 1) return [to]
  const out: Point[] = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
  }
  return out
}

export interface InputDeps { fidelity?: InputFidelity; sleep?: Sleep; registry?: TabRegistry }

export class Input {
  private f: InputFidelity
  private sleep: Sleep
  private registry?: TabRegistry
  constructor(private cdp: Cdp, deps: InputDeps = {}) {
    this.f = deps.fidelity ?? DEFAULT_FIDELITY
    this.sleep = deps.sleep ?? realSleep
    this.registry = deps.registry
  }

  async moveTo(target: Debuggee, tabId: number, x: number, y: number, button = 'none', buttons = 0): Promise<void> {
    let from: Point = { x, y }
    const last = this.registry?.lastPointerOf(tabId)
    if (last) from = last
    for (const pt of lerpPoints(from, { x, y }, this.f.moveSteps)) {
      const ev: Record<string, unknown> = { type: 'mouseMoved', x: pt.x, y: pt.y, button }
      if (buttons !== 0) ev.buttons = buttons
      await this.cdp.sendCommand(target, 'Input', 'dispatchMouseEvent', ev)
    }
    this.registry?.setLastPointer(tabId, { x, y })
  }

  async dispatchClick(target: Debuggee, tabId: number, x: number, y: number, button = 'left', clickCount = 1): Promise<void> {
    if (!button) button = 'left'
    if (clickCount <= 0) clickCount = 1
    const buttons = button === 'left' ? 1 : button === 'right' ? 2 : button === 'middle' ? 4 : 0
    await this.moveTo(target, tabId, x, y, 'none', 0)
    await this.cdp.sendCommand(target, 'Input', 'dispatchMouseEvent',
      { type: 'mousePressed', x, y, button, buttons, clickCount })
    await this.sleep(this.f.clickHoldMs)
    await this.cdp.sendCommand(target, 'Input', 'dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button, buttons: 0, clickCount })
  }

  async dispatchMouseWheel(target: Debuggee, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.cdp.sendCommand(target, 'Input', 'dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
  }

  async dispatchTypedKeys(target: Debuggee, text: string): Promise<void> {
    for (const r of [...text]) {
      await this.sendOneRune(target, r)
      await this.sleep(this.f.typeCharDelayMs)
    }
  }

  private async sendOneRune(target: Debuggee, ch: string): Promise<void> {
    if (ch === '\n' || ch === '\r') return this.sendNamedKey(target, 'Enter', '\r')
    if (ch === '\t') return this.sendNamedKey(target, 'Tab', '\t')
    const code = ch.charCodeAt(0)
    if (code >= 0x20 && code < 0x7f) {
      await this.cdp.sendCommand(target, 'Input', 'dispatchKeyEvent',
        { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch })
      await this.cdp.sendCommand(target, 'Input', 'dispatchKeyEvent', { type: 'keyUp', key: ch })
      return
    }
    // Non-ASCII rune: no reliable key event — insert so it still lands.
    await this.cdp.sendCommand(target, 'Input', 'insertText', { text: ch })
  }

  async sendNamedKey(target: Debuggee, key: string, text: string): Promise<void> {
    await this.cdp.sendCommand(target, 'Input', 'dispatchKeyEvent', { type: 'keyDown', key, text })
    await this.cdp.sendCommand(target, 'Input', 'dispatchKeyEvent', { type: 'keyUp', key })
  }

  /** mods-down (cumulative mask) → key down → key up → mods-up (reverse). Port sendKeyChordMods. */
  async sendKeyChordMods(target: Debuggee, mods: string[], key: string): Promise<void> {
    let mask = 0
    for (const m of mods) {
      const bit = CHORD_MOD[m]
      if (bit == null) throw new Error(`unsupported modifier ${JSON.stringify(m)}; use Alt, Ctrl, Meta, or Shift`)
      mask |= bit
    }
    for (const m of mods) await this.cdp.sendCommand(target, 'Input', 'dispatchKeyEvent', { type: 'keyDown', key: m, modifiers: mask })
    await this.cdp.sendCommand(target, 'Input', 'dispatchKeyEvent', { type: 'keyDown', key, modifiers: mask })
    await this.cdp.sendCommand(target, 'Input', 'dispatchKeyEvent', { type: 'keyUp', key, modifiers: mask })
    for (let i = mods.length - 1; i >= 0; i--) {
      await this.cdp.sendCommand(target, 'Input', 'dispatchKeyEvent', { type: 'keyUp', key: mods[i], modifiers: mask })
    }
  }
}

/** Parse a chord like "Ctrl+a" / "Meta+Shift+k" → {mods, key}. */
export function parseKeyChord(chord: string): { mods: string[]; key: string } {
  const parts = chord.split('+').map(s => s.trim()).filter(Boolean)
  const mods: string[] = []
  let key = ''
  const canon: Record<string, string> = {
    alt: 'Alt', option: 'Alt', ctrl: 'Ctrl', control: 'Ctrl',
    meta: 'Meta', cmd: 'Meta', command: 'Meta', shift: 'Shift',
  }
  for (const p of parts) {
    const c = canon[p.toLowerCase()]
    if (c) mods.push(c)
    else key = p
  }
  return { mods, key }
}
