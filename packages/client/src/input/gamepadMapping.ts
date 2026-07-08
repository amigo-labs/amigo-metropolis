// Pure gamepad-mapping math — NO DOM, NO three, so it is unit-testable under
// `bun test`. The stateful device polling (navigator.getGamepads, rumble)
// lives in gamepad.ts; everything numeric that decides how a stick or button
// becomes a quantized PlayerInput lives here.

import {
  BUTTON_FIRE1,
  BUTTON_FIRE2,
  BUTTON_FIRE3,
  BUTTON_INTERACT,
  BUTTON_JUMP,
  BUTTON_TRANSFORM,
} from "@metropolis/sim";

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Standard Gamepad button index → our input bit (W3C "standard" mapping).
 * Twin-stick layout: triggers/shoulders fire, face buttons do the rest.
 *   RT primary · LT heavy · RB special · A jump · Y transform · X interact.
 */
export const GAMEPAD_BUTTON_MAP: readonly (readonly [number, number])[] = [
  [7, BUTTON_FIRE1], // RT — primary hitscan
  [6, BUTTON_FIRE2], // LT — heavy (also the buy-heavy modifier)
  [5, BUTTON_FIRE3], // RB — special
  [0, BUTTON_JUMP], // A
  [3, BUTTON_TRANSFORM], // Y
  [2, BUTTON_INTERACT], // X — buy / claim / capture
];

/** Below this stick magnitude the axis reads as centered (drift rejection). */
export const STICK_DEADZONE = 0.2;

/**
 * Radial deadzone with rescale: magnitudes at/under `dz` collapse to zero, and
 * the remaining range is stretched back to a full unit disk so movement stays
 * analog right off the deadzone edge. Writes the rescaled vector into `out` and
 * returns its magnitude (0..1). Allocation-free (caller supplies `out`).
 */
export function stickWithDeadzone(x: number, y: number, dz: number, out: Vec2): number {
  const mag = Math.sqrt(x * x + y * y);
  if (mag <= dz) {
    out.x = 0;
    out.y = 0;
    return 0;
  }
  let scaled = (mag - dz) / (1 - dz);
  if (scaled > 1) scaled = 1;
  const inv = scaled / mag;
  out.x = x * inv;
  out.y = y * inv;
  return scaled;
}
