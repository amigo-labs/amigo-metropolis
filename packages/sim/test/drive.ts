// Test helpers for driving an avatar on the original's button word (inputs.ts).
// The original has no heading to send — the hull turns by its turn buttons — so
// a test that wants to move along a world direction either faces the hull there
// first (`face`, a direct write of the state a long turn would reach) or steers
// to it closed-loop (`steer`), as the golden scripts do.

import { BTN_FORWARD, BTN_TURN_LEFT, BTN_TURN_RIGHT, type PlayerInput } from "../src/inputs";
import type { SimState } from "../src/sim";
import { atan2Poly, cosLUT, sinLUT } from "../src/simMath";

/** Sets entity `id`'s hull to face `yaw` (sim radians), as a finished turn leaves it. */
export function face(sim: SimState, id: number, yaw: number): void {
  sim.ent.yaw[id] = yaw;
  sim.ent.aimX[id] = cosLUT(yaw);
  sim.ent.aimY[id] = sinLUT(yaw);
}

/** Faces entity `id`'s hull along (dx, dy). */
export function faceAlong(sim: SimState, id: number, dx: number, dy: number): void {
  face(sim, id, atan2Poly(dy, dx));
}

/** Faces entity `id`'s hull at the point (x, y). */
export function faceToward(sim: SimState, id: number, x: number, y: number): void {
  faceAlong(sim, id, x - sim.ent.posX[id], y - sim.ent.posY[id]);
}

/**
 * Player `p`'s buttons for one tick of steering along (dx, dy): the turn
 * button toward it while more than about 4° off, and Move Forward once within
 * 22.5° of it (`drive`). ORs into `out.buttons`.
 */
export function steer(
  sim: SimState,
  p: number,
  dx: number,
  dy: number,
  out: PlayerInput,
  drive = true,
): void {
  const a = sim.avatarId[p];
  const d = Math.sqrt(dx * dx + dy * dy);
  if (a < 0 || d < 1e-9) return;
  const hx = sim.ent.aimX[a];
  const hy = sim.ent.aimY[a];
  const across = (hx * dy - hy * dx) / d;
  const along = (hx * dx + hy * dy) / d;
  if (along < 0 || Math.abs(across) > 0.07) {
    out.buttons |= across >= 0 ? BTN_TURN_RIGHT : BTN_TURN_LEFT;
  }
  if (drive && along > 0.9238795325112867) out.buttons |= BTN_FORWARD;
}
