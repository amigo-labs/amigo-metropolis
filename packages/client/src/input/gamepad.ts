// Gamepad input (PLAN Phase 5, primary splitscreen device). Reads the W3C
// Standard Gamepad each tick and quantizes at the boundary — analog sticks
// become int8 axes, so raw gamepad floats never enter the sim (architecture.md
// §2). Controls are world-relative, matching the keyboard/mouse scheme (WASD +
// absolute aim): left stick drives, right stick aims (and holds the last
// facing when released, like the mouse). Allocation-free in sample().

import { type PlayerInput, quantizeAxis } from "@metropolis/sim";
import { GAMEPAD_BUTTON_MAP, STICK_DEADZONE, stickWithDeadzone, type Vec2 } from "./gamepadMapping";
import type { LocalInputSource } from "./types";

// Module-scope scratch: sample() runs inside the tick loop for every player in
// turn, so a shared scratch is safe (synchronous, non-reentrant).
const move: Vec2 = { x: 0, y: 0 };
const aim: Vec2 = { x: 0, y: 0 };
const swallow = (): void => {};

export class GamepadInput implements LocalInputSource {
  readonly label: string;
  readonly hint =
    "L-stick drive · R-stick aim · RT/LT/RB fire · Y transform · A jump · hold X to buy/claim/capture";
  private readonly index: number;
  // Last non-neutral aim direction (unit vector). Defaults to +x facing.
  private aimX = 1;
  private aimY = 0;

  constructor(index: number) {
    this.index = index;
    this.label = `Gamepad ${index + 1}`;
  }

  private pad(): Gamepad | null {
    // getGamepads snapshots live state; the slot may be null if unplugged. The
    // API itself can be absent/disabled (?. guards that) — treat it as no pad.
    const pads = navigator.getGamepads?.();
    return pads ? (pads[this.index] ?? null) : null;
  }

  isConnected(): boolean {
    return this.pad()?.connected ?? false;
  }

  // Stick aim is world-relative and needs no camera projection.
  updateAim(): void {}

  sample(out: PlayerInput): void {
    const p = this.pad();
    if (p === null) {
      out.moveX = 0;
      out.moveY = 0;
      out.aimX = quantizeAxis(this.aimX);
      out.aimY = quantizeAxis(this.aimY);
      out.buttons = 0;
      return;
    }
    const ax = p.axes;
    // Left stick → analog move. Gamepad Y is +down, sim +y is forward: invert.
    stickWithDeadzone(ax[0] ?? 0, ax[1] ?? 0, STICK_DEADZONE, move);
    out.moveX = quantizeAxis(move.x);
    out.moveY = quantizeAxis(-move.y);
    // Right stick → aim. Beyond the deadzone we snap to a unit vector (crisp
    // facing that clears the sim's aim threshold) and remember it; released,
    // the avatar keeps facing where it last aimed (parity with the mouse).
    const mag = stickWithDeadzone(ax[2] ?? 0, ax[3] ?? 0, STICK_DEADZONE, aim);
    if (mag > 0) {
      const inv = 1 / Math.sqrt(aim.x * aim.x + aim.y * aim.y);
      this.aimX = aim.x * inv;
      this.aimY = -aim.y * inv;
    }
    out.aimX = quantizeAxis(this.aimX);
    out.aimY = quantizeAxis(this.aimY);
    const b = p.buttons;
    let buttons = 0;
    for (let i = 0; i < GAMEPAD_BUTTON_MAP.length; i++) {
      if (b[GAMEPAD_BUTTON_MAP[i][0]]?.pressed) buttons |= GAMEPAD_BUTTON_MAP[i][1];
    }
    out.buttons = buttons;
  }

  rumble(strength: number, durationMs: number): void {
    const act = this.pad()?.vibrationActuator;
    if (!act) return;
    const s = Math.min(Math.max(strength, 0), 1);
    // Not every browser resolves the promise; swallow rejections either way.
    act
      .playEffect("dual-rumble", {
        duration: durationMs,
        strongMagnitude: s,
        weakMagnitude: s * 0.6,
      })
      .then(swallow, swallow);
  }
}
