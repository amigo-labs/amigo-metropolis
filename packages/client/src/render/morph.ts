// Walker <-> hover transformation, client side (rules.md §2, assets.md §4).
//
// The sim flips the mode byte on the tick the change starts and freezes the
// avatar for TRANSFORM_LOCK_TICKS. It publishes that as a single EV_TRANSFORM
// event rather than a per-tick progress field, because there is nowhere clean to
// put one: `animState` is a Uint8Array whose low bits are already spoken for,
// and the avatar's snapshot `aux` slot carries kill attribution. So the morph
// runs on the client's own clock off that one event — the same one-way street
// the fx pools already use (architecture.md §3: cosmetics drain the event
// buffer, never feed back).
//
// The clock is the SIM's, not the wall's: `advance()` is fed the sim time the
// frame is interpolating to, converted to seconds, so a morph and the lock it
// belongs to cannot drift apart. Wall time was the obvious choice and it was
// wrong — the frame loop caps a frame at 250 ms, a third of the whole
// transformation, so one hitch (a shader compile, a GC, a tab refocus) would
// fast-forward the mech into its new form and leave it standing frozen for the
// rest of the lock. Under the headless pin harness that is not an edge case at
// all: a `page.evaluate` round trip stalls the loop and the morph was finishing
// in a quarter of the time.
//
// Being on the sim clock also means the morph FREEZES when the sim does, which
// is what makes a mid-transformation pin worth taking.
//
// `release()` still exists for the cases the clock cannot see: a death or a
// rollback that ends the lock early.
//
// Why a phase split rather than a cross-fade: walker and hover are two unrelated
// meshes on two unrelated render paths, and fading between them would need
// per-instance opacity, i.e. a shader. The client has none and is not getting one
// for this. So the outgoing form collapses, the discharge covers the swap, and
// the incoming form unfolds — only ever one of them on screen, which also means
// neither the rig nor the hover bucket needs extra capacity.

import { TICK_HZ, TRANSFORM_LOCK_TICKS } from "@metropolis/sim";

/** One per avatar the renderer can draw at once — matches RIG_CAPACITY. */
export const MORPH_SLOTS = 4;

/** Length of one transformation in SIM seconds, straight off the sim's lock. */
export const MORPH_DURATION_SEC = TRANSFORM_LOCK_TICKS / TICK_HZ;

/** How flat the mech gets at the swap, as a fraction of its standing height. */
const SQUASH_Y = 0.32;
/** How far it spreads sideways while it folds — volume has to go somewhere. */
const SPREAD_XZ = 1.22;
/** Hip angle at full fold. Well past the gait's 0.44 rad swing: this is a tuck. */
const FOLD_RADIANS = 1.15;
/** Net rotation across the morph. A whole turn, so it ends facing where it began. */
const SPIN_RADIANS = Math.PI * 2;

/**
 * 0 at both ends, 1 at the swap.
 *
 * A bare tent would start and stop the collapse with a corner; smoothstep on it
 * settles both ends, so the shape eases out of its standing pose and eases back
 * into the new one instead of snapping into motion.
 */
export function foldAt(t: number): number {
  const tent = 1 - Math.abs(2 * t - 1);
  return tent * tent * (3 - 2 * tent);
}

/** Vertical scale over the morph: 1 -> SQUASH_Y -> 1. */
export function squashYAt(t: number): number {
  return 1 - foldAt(t) * (1 - SQUASH_Y);
}

/** Horizontal scale over the morph: 1 -> SPREAD_XZ -> 1. */
export function spreadXZAt(t: number): number {
  return 1 + foldAt(t) * (SPREAD_XZ - 1);
}

/** Hip tuck over the morph: 0 -> FOLD_RADIANS -> 0. */
export function foldRadiansAt(t: number): number {
  return foldAt(t) * FOLD_RADIANS;
}

/**
 * Visual yaw offset over the morph: a single turn, eased at both ends so it
 * spins up and settles rather than cutting in at speed. Monotonic, and a whole
 * turn, so the mech finishes pointing exactly where it started.
 */
export function spinAt(t: number): number {
  return SPIN_RADIANS * t * t * (3 - 2 * t);
}

/** Layout of the array `sample()` fills. */
export const MORPH_OUT_LEN = 5;
export const MORPH_SCALE_XZ = 0;
export const MORPH_SCALE_Y = 1;
export const MORPH_SPIN = 2;
export const MORPH_FOLD = 3;
/** 1 when this frame should draw the hover mesh, 0 for the walker rig. */
export const MORPH_DRAW_HOVER = 4;

export interface AvatarMorph {
  /**
   * Begin (or restart) a morph for `id`. `toHover` is the form being ENTERED —
   * the sim has already flipped the mode byte when EV_TRANSFORM fires, so the
   * form being left is its negation.
   */
  start(id: number, toHover: boolean): void;
  /**
   * Age every live morph. Call once per frame, before sampling.
   *
   * `simDtSec` is how far the SIM advanced since the last frame, interpolation
   * included — zero while it is paused. Never the frame's wall-clock delta.
   */
  advance(simDtSec: number): void;
  /**
   * Fills `out` (length MORPH_OUT_LEN) for `id` and returns true, or returns
   * false and leaves `out` alone when `id` is not morphing.
   */
  sample(id: number, out: Float32Array): boolean;
  /** End a morph early — the sim says this avatar is no longer transforming. */
  release(id: number): void;
  /** Test/debug: how many morphs are running. */
  readonly live: number;
}

export function createAvatarMorph(): AvatarMorph {
  // Parallel arrays over a fixed slot count: no map, no per-morph object, and
  // nothing allocated after this call (renderer rule 1).
  const ids = new Int32Array(MORPH_SLOTS).fill(-1);
  const elapsed = new Float32Array(MORPH_SLOTS);
  const toHover = new Uint8Array(MORPH_SLOTS);
  let live = 0;

  function slotOf(id: number): number {
    for (let i = 0; i < MORPH_SLOTS; i++) if (ids[i] === id) return i;
    return -1;
  }

  function free(i: number): void {
    if (ids[i] === -1) return;
    ids[i] = -1;
    elapsed[i] = 0;
    live -= 1;
  }

  return {
    start(id, hover) {
      let i = slotOf(id);
      if (i === -1) {
        for (let s = 0; s < MORPH_SLOTS; s++) {
          if (ids[s] === -1) {
            i = s;
            break;
          }
        }
        // Every avatar that can be on screen has a slot, so this cannot happen
        // from the sim side. Dropping the morph is the right failure: the swap
        // still lands, it just lands without the animation.
        if (i === -1) return;
        live += 1;
      }
      ids[i] = id;
      elapsed[i] = 0;
      toHover[i] = hover ? 1 : 0;
    },
    advance(simDtSec) {
      if (simDtSec <= 0) return;
      for (let i = 0; i < MORPH_SLOTS; i++) {
        if (ids[i] === -1) continue;
        elapsed[i] += simDtSec;
        if (elapsed[i] >= MORPH_DURATION_SEC) free(i);
      }
    },
    sample(id, out) {
      const i = slotOf(id);
      if (i === -1) return false;
      const t = elapsed[i] / MORPH_DURATION_SEC;
      out[MORPH_SCALE_XZ] = spreadXZAt(t);
      out[MORPH_SCALE_Y] = squashYAt(t);
      out[MORPH_SPIN] = spinAt(t);
      out[MORPH_FOLD] = foldRadiansAt(t);
      // First half belongs to the form being left, second half to the one being
      // entered. The snapshot already carries the destination in ANIM_HOVER, so
      // the source is simply its negation — no extra state to track.
      const entering = toHover[i] === 1;
      const showDestination = t >= 0.5;
      out[MORPH_DRAW_HOVER] = (showDestination ? entering : !entering) ? 1 : 0;
      return true;
    },
    release(id) {
      const i = slotOf(id);
      if (i !== -1) free(i);
    },
    get live() {
      return live;
    },
  };
}
