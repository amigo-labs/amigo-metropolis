// Pure stick math for the MENU's gamepad navigation (ui/navFocus.ts) — NO DOM,
// NO three, so it is unit-testable under `bun test`. A match reads the pad as
// the original does, digitally (input/gamepad.ts); none of this reaches the sim.

export interface Vec2 {
  x: number;
  y: number;
}

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
