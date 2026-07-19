// Pure touch-mapping math — NO DOM, NO three, so it is unit-testable under
// `bun test` (the gamepadMapping.ts split, same rationale). The stateful
// pointer tracking and the on-screen overlay live in input/touch.ts /
// touchControls.ts; everything numeric that decides how a finger displacement
// or an on-screen button becomes a quantized PlayerInput lives here.
//
// Screen→input frame: DOM y grows downward, the movement layer's screen frame
// (input/movement.ts) has "forward" growing up-screen — so both stick helpers
// invert y here, once, at the boundary.

import {
  BUTTON_FIRE1,
  BUTTON_FIRE2,
  BUTTON_FIRE3,
  BUTTON_INTERACT,
  BUTTON_JUMP,
  BUTTON_TRANSFORM,
} from "@metropolis/sim";
import { STICK_DEADZONE, stickWithDeadzone, type Vec2 } from "./gamepadMapping";

/** Knob travel (CSS px) from a floating stick's base for full deflection. */
export const TOUCH_STICK_RADIUS_PX = 56;

export interface TouchButtonSpec {
  /** Stable element id suffix / test hook. */
  readonly id: string;
  /** Short on-screen label (the buttons are thumb-sized). */
  readonly label: string;
  /** PlayerInput button bit set while the on-screen button is held. */
  readonly bit: number;
}

/**
 * On-screen button cluster → input bits (the GAMEPAD_BUTTON_MAP analogue).
 * FIRE1 is deliberately absent: primary auto-fires while the aim stick is
 * engaged (twin-stick convention — see autoFirePrimary).
 */
export const TOUCH_BUTTONS: readonly TouchButtonSpec[] = [
  { id: "heavy", label: "HVY", bit: BUTTON_FIRE2 },
  { id: "special", label: "SPC", bit: BUTTON_FIRE3 },
  { id: "jump", label: "JUMP", bit: BUTTON_JUMP },
  { id: "transform", label: "MODE", bit: BUTTON_TRANSFORM },
  { id: "interact", label: "USE", bit: BUTTON_INTERACT },
];

/**
 * Move stick: finger displacement from the stick base (CSS px, DOM y-down) →
 * deadzoned analog vector in the screen frame (x = screen right, y = up-screen)
 * on the unit disk. Returns the rescaled magnitude (0..1). Allocation-free.
 */
export function applyStick(dxPx: number, dyPx: number, radiusPx: number, out: Vec2): number {
  return stickWithDeadzone(dxPx / radiusPx, -dyPx / radiusPx, STICK_DEADZONE, out);
}

/**
 * Aim stick: same displacement, but snapped to a UNIT direction — the sim only
 * uses aim for facing (sim.ts facing threshold: quantized magnitude > 0.2), so
 * a unit vector both survives int8 quantization and always clears it. Writes
 * into `out` ONLY while the stick is engaged past the deadzone (hold-last is
 * the caller keeping the previous value) and returns whether it was engaged.
 */
export function snapAimStick(dxPx: number, dyPx: number, radiusPx: number, out: Vec2): boolean {
  const len = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
  if (len <= STICK_DEADZONE * radiusPx) return false;
  out.x = dxPx / len;
  out.y = -dyPx / len;
  return true;
}

/** Twin-stick primary: FIRE1 is held exactly while the aim stick is engaged. */
export function autoFirePrimary(aimEngaged: boolean): number {
  return aimEngaged ? BUTTON_FIRE1 : 0;
}
