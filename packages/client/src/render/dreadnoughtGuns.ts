// The Dreadnought's guns aim (fcop-fidelity.md G8, I6). Each gun is a mount of
// its own in the original, standing on its hull's attach point and turning
// about its own origin at 237.3°/s (RE mount.c 0x004258d0). The sim models the
// mounts since SIM_VERSION 77 and writes each gun's yaw relative to its hull
// per sim tick (writeGunSnapshot). The client keeps two such ticks, as it does
// for the entities, and draws the guns between them (render/arenaUnits.ts
// gunMatrix).
//
// Only the yaw moves. No Dreadnought gun on the six arenas sets the mount's
// pitch bit (CACT_MOUNT_AIM_PITCH, 0x0010 of +0xe8, filled from the record's
// mount byte, which is 0 on all 24 guns), nor its animated fire bit (0x0080),
// and the gun models are static, one frame and no AnmD. So the original
// neither pitches them nor plays a recoil track on them (RE pa_models.json
// `guns[].by_side.*.mount_flags`, `models.*.anim`).
//
// Renderer rule 1: lerpGunYaws runs per Dreadnought per frame and allocates
// nothing.

import { DREADNOUGHT_GUNS } from "@metropolis/sim";

const TAU = Math.PI * 2;

/**
 * `d` folded into [-PI, PI): the shortest arc between two yaws, the fold
 * main.ts interpolates an entity's yaw with.
 */
function wrapAngleDelta(d: number): number {
  return ((((d + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/**
 * Writes Juggernaut `id`'s gun yaws (relative to its hull, radians, entity yaw
 * sense) into `out[0..DREADNOUGHT_GUNS)`. They lie `alpha` of the way from the
 * previous tick's gun snapshot to the current one, on the shortest arc, as the
 * renderer interpolates an entity's yaw. Without a previous tick (`hasPrev`
 * false: the hull is new this tick) they are the current tick's.
 */
export function lerpGunYaws(
  prev: Float32Array,
  curr: Float32Array,
  id: number,
  alpha: number,
  hasPrev: boolean,
  out: Float32Array,
): Float32Array {
  const o = id * DREADNOUGHT_GUNS;
  for (let g = 0; g < DREADNOUGHT_GUNS; g++) {
    const c = curr[o + g];
    out[g] = hasPrev ? prev[o + g] + wrapAngleDelta(c - prev[o + g]) * alpha : c;
  }
  return out;
}
