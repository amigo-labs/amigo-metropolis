// The X1-Alpha's per-player snapshot (architecture.md §3): the walker's state
// machine and the two AnmD blocks it and the transform's ramp step (walker.ts,
// fcop-fidelity.md G11, P4) -- which frames the renderer poses the mech by
// (packages/client/src/render/x1Walk.ts, avatarRig.ts) and which codes the legs
// hand the movement loop this tick (audio/cues.ts) -- beside the movement state
// they ran off: the button word, the velocity, the airborne bit, the
// transform's lock and the ground's movement mode. All of it is sim state
// already; this only copies it out. A pure read, like writeMatchSnapshot:
// never hashed, never written back.

import { MAX_PLAYERS, RAW_PER_METRE, WALK_CODES_PER_TICK } from "./balance";
import type { SimState } from "./sim";

/** Length of the codes block at AVATAR_SNAP_CODES. */
export const AVATAR_SNAP_CODE_SLOTS = WALK_CODES_PER_TICK;
/** Floats per player slot. */
export const AVATAR_SNAP_STRIDE = 27 + AVATAR_SNAP_CODE_SLOTS;
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
/** The walker's state (`state_bb`; the hover's command state while the hover's tick runs). */
export const AVATAR_SNAP_WALK_STATE = 9;
/** Its flags byte (`flags_b9`, walker.ts WALK_AIRBORNE ... WALK_CROUCHED). */
export const AVATAR_SNAP_WALK_FLAGS = 10;
/** The leg track it last asked for (`byte_ba`). */
export const AVATAR_SNAP_WALK_ASKED = 11;
/** The idle count (`byte_c3`) and the lunge countdown (`byte_c2`). */
export const AVATAR_SNAP_WALK_IDLE = 12;
export const AVATAR_SNAP_WALK_LUNGE = 13;
/** 1 while the hover's tick runs (the hover and both ramps), 0 on the walker's. */
export const AVATAR_SNAP_FORM = 14;
/** The legs' AnmD block: track, frame (0-370), clock, direction, target frame and flags (STARTED). */
export const AVATAR_SNAP_LEGS_TRACK = 15;
export const AVATAR_SNAP_LEGS_FRAME = 16;
export const AVATAR_SNAP_LEGS_CLOCK = 17;
export const AVATAR_SNAP_LEGS_DIRECTION = 18;
export const AVATAR_SNAP_LEGS_TARGET = 19;
export const AVATAR_SNAP_LEGS_FLAGS = 20;
/** The cockpit's: track and frame (0-29). */
export const AVATAR_SNAP_COCKPIT_TRACK = 21;
export const AVATAR_SNAP_COCKPIT_FRAME = 22;
/** The eighths' carry (`byte_b6`): the clock's units short of the next movement step. */
export const AVATAR_SNAP_CARRY = 23;
/** How many codes the legs passed this tick, then the codes, low first (AVATAR_SNAP_CODE_SLOTS). */
export const AVATAR_SNAP_CODE_COUNT = 24;
export const AVATAR_SNAP_CODES = 25;
/**
 * The Riot Shield's sphere (sim.ts ShieldState): its radius in metres while it
 * is up, 0 when it is down or the match offers no Riot Shield. Drawn about the
 * mech's position raised 0.5 m (SHIELD_CENTRE_RAISE).
 */
export const AVATAR_SNAP_SHIELD_RADIUS = 25 + AVATAR_SNAP_CODE_SLOTS;
/**
 * Its look: SHIELD_SNAP_WHOLE (block B, the whole sphere; else the front half
 * of block A) and SHIELD_SNAP_FLASH (the flash after a contact).
 */
export const AVATAR_SNAP_SHIELD_FLAGS = 26 + AVATAR_SNAP_CODE_SLOTS;
export const SHIELD_SNAP_WHOLE = 1;
export const SHIELD_SNAP_FLASH = 2;

/** Writes every player slot into `out` (length AVATAR_SNAPSHOT_LEN). */
export function writeAvatarSnapshot(state: SimState, out: Float32Array): void {
  const ent = state.ent;
  const w = state.walker;
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
    out[o + AVATAR_SNAP_WALK_STATE] = w.state[p];
    out[o + AVATAR_SNAP_WALK_FLAGS] = w.flags[p];
    out[o + AVATAR_SNAP_WALK_ASKED] = w.asked[p];
    out[o + AVATAR_SNAP_WALK_IDLE] = w.idle[p];
    out[o + AVATAR_SNAP_WALK_LUNGE] = w.lunge[p];
    out[o + AVATAR_SNAP_FORM] = w.form[p];
    out[o + AVATAR_SNAP_LEGS_TRACK] = w.legs.index[p];
    out[o + AVATAR_SNAP_LEGS_FRAME] = w.legs.frame[p];
    out[o + AVATAR_SNAP_LEGS_CLOCK] = w.legs.clock[p];
    out[o + AVATAR_SNAP_LEGS_DIRECTION] = w.legs.direction[p];
    out[o + AVATAR_SNAP_LEGS_TARGET] = w.legs.target[p];
    out[o + AVATAR_SNAP_LEGS_FLAGS] = w.legs.flags[p];
    out[o + AVATAR_SNAP_COCKPIT_TRACK] = w.cockpit.index[p];
    out[o + AVATAR_SNAP_COCKPIT_FRAME] = w.cockpit.frame[p];
    out[o + AVATAR_SNAP_CARRY] = w.carry[p];
    const n = w.codeCount[p];
    out[o + AVATAR_SNAP_CODE_COUNT] = n;
    const at = p * WALK_CODES_PER_TICK;
    for (let k = 0; k < AVATAR_SNAP_CODE_SLOTS; k++) {
      out[o + AVATAR_SNAP_CODES + k] = k < n ? w.codes[at + k] : 0;
    }
    const sh = state.shield;
    const on = (sh.flags[p] & 1) !== 0;
    out[o + AVATAR_SNAP_SHIELD_RADIUS] = on ? sh.radius[p] / RAW_PER_METRE : 0;
    out[o + AVATAR_SNAP_SHIELD_FLAGS] = on
      ? ((sh.flags[p] & 4) !== 0 ? SHIELD_SNAP_WHOLE : 0) |
        (sh.flash[p] > 0 ? SHIELD_SNAP_FLASH : 0)
      : 0;
  }
}
