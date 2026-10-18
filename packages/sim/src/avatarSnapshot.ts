// The X1-Alpha's per-player snapshot (architecture.md §3): what the client's
// copy of the original's walker animation reads (packages/client/src/render/
// x1Walk.ts, fcop-fidelity.md G11). The original's legs are not sim state in
// Metropolis -- they are render-only, as two peers showing different leg frames
// is not a desync -- but the state machine that picks their track runs off the
// mech's own movement state: the button word the walker read, the velocity
// whose length sets the legs' rate, the airborne bit, the transform's lock and
// the ground's movement mode. All of it is sim state already; this only copies
// it out. A pure read, like writeMatchSnapshot: never hashed, never written
// back.

import { MAX_PLAYERS } from "./balance";
import type { SimState } from "./sim";

/** Floats per player slot. */
export const AVATAR_SNAP_STRIDE = 9;
/** Length of the buffer writeAvatarSnapshot fills. */
export const AVATAR_SNAPSHOT_LEN = MAX_PLAYERS * AVATAR_SNAP_STRIDE;
/** The slot's X1 entity id, -1 while it is down -- and always for the Warden's slot. */
export const AVATAR_SNAP_ID = 0;
/**
 * The button word the movement read this tick (`lastButtons`): already
 * filtered the way the original filters it -- nothing while sinking, only the
 * three fire buttons while a transform runs -- and with both jinks as pressed
 * (the walker cancels a held pair itself).
 */
export const AVATAR_SNAP_BUTTONS = 1;
/** Velocity, m/s: the sim's x and y, and the vertical (up positive). */
export const AVATAR_SNAP_VX = 2;
export const AVATAR_SNAP_VY = 3;
export const AVATAR_SNAP_VZ = 4;
/** The entity's ANIM_* bits (sim.ts). */
export const AVATAR_SNAP_ANIM = 5;
/** Ticks left of the transform's lock (TRANSFORM_LOCK_TICKS down to 1), 0 when none runs. */
export const AVATAR_SNAP_LOCK = 6;
/** The walker's ground movement mode for its next tick (`avatarMode`, 0 on plain ground). */
export const AVATAR_SNAP_GROUND_MODE = 7;
/** Ticks left of the cloak (`buffInvis`), 0 when none runs. */
export const AVATAR_SNAP_CLOAK = 8;

/** Writes every player slot into `out` (length AVATAR_SNAPSHOT_LEN). */
export function writeAvatarSnapshot(state: SimState, out: Float32Array): void {
  const ent = state.ent;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const o = p * AVATAR_SNAP_STRIDE;
    const id = p === state.wardenPlayer ? -1 : state.avatarId[p];
    out[o + AVATAR_SNAP_ID] = id;
    if (id < 0) {
      for (let k = 1; k < AVATAR_SNAP_STRIDE; k++) out[o + k] = 0;
      continue;
    }
    out[o + AVATAR_SNAP_BUTTONS] = state.lastButtons[p];
    out[o + AVATAR_SNAP_VX] = ent.velX[id];
    out[o + AVATAR_SNAP_VY] = ent.velY[id];
    out[o + AVATAR_SNAP_VZ] = ent.timerB[id];
    out[o + AVATAR_SNAP_ANIM] = ent.animState[id];
    out[o + AVATAR_SNAP_LOCK] = ent.timerA[id];
    out[o + AVATAR_SNAP_GROUND_MODE] = state.avatarMode[p];
    out[o + AVATAR_SNAP_CLOAK] = state.buffInvis.length > 0 ? state.buffInvis[p] : 0;
  }
}
