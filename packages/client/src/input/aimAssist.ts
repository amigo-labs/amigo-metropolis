// Aim-assist (input.spec §4.4, §8) — a LOCAL client setting, never synchronized.
//
//   off    pure free aim (mouse raycast / right stick)
//   assist free aim, magnetically nudged toward the nearest enemy in a cone
//          BEFORE quantization — it only shapes the player's own transmitted
//          aim, so it can never diverge the sim (input.spec §2 boundary)
//   lock   hard lock handled IN the sim via BUTTON_TARGET_CYCLE (input.spec §4.4);
//          the client only binds the cycle key, the sim tracks the target
//
// `off`/`lock` do no local aim shaping here; only `assist` calls applyAimAssist.

import type { Vec2 } from "./gamepadMapping";

export type AimAssistMode = "off" | "assist" | "lock";

export function parseAimAssistMode(v: string | null): AimAssistMode {
  return v === "assist" || v === "lock" ? v : "off";
}

/** Boot-time local config; set once from `?aim=` and read by the input sources. */
export const aimAssist: { mode: AimAssistMode } = { mode: "off" };

// Starting values (input.spec §9 — "tune in playtest"): a 25° half-cone and a
// half-strength pull toward the acquired target.
export const ASSIST_CONE_COS = Math.cos((25 * Math.PI) / 180);
export const ASSIST_STRENGTH = 0.5;

/**
 * "assist" magnetism: nudge the free-aim unit vector `(aimX,aimY)` toward the
 * nearest enemy whose direction lies within `coneCos` of it, by `strength`
 * (0..1), then renormalize. `enemies` is packed `[x0,y0,x1,y1,…]` in sim coords;
 * `count` is the number of pairs. Writes the result into `out` and returns true
 * when it pulled — otherwise leaves `out = (aimX,aimY)` and returns false. Pure
 * and allocation-free (caller owns `out`).
 */
export function applyAimAssist(
  aimX: number,
  aimY: number,
  selfX: number,
  selfY: number,
  enemies: Float32Array,
  count: number,
  coneCos: number,
  strength: number,
  out: Vec2,
): boolean {
  out.x = aimX;
  out.y = aimY;
  const aLen2 = aimX * aimX + aimY * aimY;
  if (aLen2 < 1e-6 || count === 0) return false;
  const aInv = 1 / Math.sqrt(aLen2);
  const nax = aimX * aInv;
  const nay = aimY * aInv;

  let bestD2 = Number.POSITIVE_INFINITY;
  let bx = 0;
  let by = 0;
  let found = false;
  for (let i = 0; i < count; i++) {
    const ex = enemies[i * 2] - selfX;
    const ey = enemies[i * 2 + 1] - selfY;
    const d2 = ex * ex + ey * ey;
    if (d2 < 1e-6) continue;
    const dInv = 1 / Math.sqrt(d2);
    const dot = ex * dInv * nax + ey * dInv * nay; // cos(angle) aim↔enemy dir
    if (dot < coneCos) continue; // outside the cone
    if (d2 < bestD2) {
      bestD2 = d2;
      bx = ex * dInv;
      by = ey * dInv;
      found = true;
    }
  }
  if (!found) return false;

  const rx = nax + (bx - nax) * strength;
  const ry = nay + (by - nay) * strength;
  const rl2 = rx * rx + ry * ry;
  if (rl2 < 1e-6) return false;
  const rInv = 1 / Math.sqrt(rl2);
  out.x = rx * rInv;
  out.y = ry * rInv;
  return true;
}
