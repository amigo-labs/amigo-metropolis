// The X1-Alpha's animation as the renderer and the audio read it
// (fcop-fidelity.md G11, A9): which frame the legs and the cockpit show, which
// form's tick runs, and the event codes the legs handed the movement loop this
// tick. The machine that picks them is the sim's (packages/sim/src/walker.ts:
// the original's walker state machine, the transform's ramp and the AnmD
// player, stepped as the original steps them), and this copies its state off
// the avatar snapshot (sim avatarSnapshot.ts) once a sim tick: no second copy
// of the machine runs here. The renderer poses the mesh by the two frames
// (render/avatarRig.ts), the audio plays the codes (audio/cues.ts,
// `snd_loop_set_mode`). Allocation-free.
//
// What stays here is the cockpit's aim at the lock (`player_partner_tick`),
// which turns the cockpit on its mount and moves nothing in the sim.

import {
  AVATAR_SNAP_COCKPIT_FRAME,
  AVATAR_SNAP_COCKPIT_TRACK,
  AVATAR_SNAP_CODE_COUNT,
  AVATAR_SNAP_CODES,
  AVATAR_SNAP_FORM,
  AVATAR_SNAP_ID,
  AVATAR_SNAP_LEGS_FRAME,
  AVATAR_SNAP_LEGS_TRACK,
  AVATAR_SNAP_STRIDE,
  AVATAR_SNAP_WALK_ASKED,
  AVATAR_SNAP_WALK_FLAGS,
  AVATAR_SNAP_WALK_STATE,
  MAX_PLAYERS,
  WALK_CODES_PER_TICK,
  X1_HOVER_LEG_TRACK,
} from "@metropolis/sim";

/** At most this many codes a slot a tick (the sim's WALK_CODES_PER_TICK). */
export const X1_CODES_PER_TICK = WALK_CODES_PER_TICK;

/**
 * The three draw forms the original's partner tells apart by the transform's
 * progress `chase_sink` (player_partner.c 299-320): 0 the walker, 0x10000 the
 * hover, anything between the ramp. Indices into x1Rig.generated.ts' layer
 * masks.
 */
export const X1_FORM_WALKER = 0;
export const X1_FORM_RAMP = 1;
export const X1_FORM_HOVER = 2;

export interface X1Walk {
  /** Each slot's X1 entity id, -1 while it has none. */
  readonly owner: Int32Array;
  /** 1 while the hover form's tick runs the slot (hover, or either ramp), else 0. */
  readonly form: Uint8Array;
  /** The frames to draw: the legs' (0-370) and the cockpit's (0-29). */
  readonly legsFrame: Int16Array;
  readonly cockpitFrame: Int16Array;
  /** The tracks they play (the debug readout's). */
  readonly legsTrack: Uint8Array;
  readonly cockpitTrack: Uint8Array;
  /** The walker's state (`state_bb`), its flags byte (`flags_b9`), the last track asked (`byte_ba`). */
  readonly state: Uint8Array;
  readonly flagsB9: Uint8Array;
  readonly asked: Uint8Array;
  /** This tick's codes for the movement loop, X1_CODES_PER_TICK a slot. */
  readonly codes: Uint8Array;
  readonly codeCount: Uint8Array;
  /** The cockpit's aim off the facing toward the lock, 4096 a turn (the mech's +0xc6 / +0xc4). */
  readonly aimYaw: Int16Array;
  readonly aimPitch: Int16Array;
}

export function createX1Walk(slots = MAX_PLAYERS): X1Walk {
  return {
    owner: new Int32Array(slots).fill(-1),
    form: new Uint8Array(slots),
    legsFrame: new Int16Array(slots),
    cockpitFrame: new Int16Array(slots),
    legsTrack: new Uint8Array(slots),
    cockpitTrack: new Uint8Array(slots),
    state: new Uint8Array(slots),
    flagsB9: new Uint8Array(slots),
    asked: new Uint8Array(slots),
    codes: new Uint8Array(slots * X1_CODES_PER_TICK),
    codeCount: new Uint8Array(slots),
    aimYaw: new Int16Array(slots),
    aimPitch: new Int16Array(slots),
  };
}

/**
 * One sim tick for every slot, off the avatar snapshot (sim avatarSnapshot.ts):
 * the sim's frames, form, state and codes. Call once after each sim step; it
 * allocates nothing. A new X1 in a slot (a spawn or a respawn) starts its aim
 * straight ahead.
 */
export function tickX1Walk(w: X1Walk, snap: Float32Array): void {
  const slots = w.owner.length;
  for (let s = 0; s < slots; s++) {
    w.codeCount[s] = 0;
    const o = s * AVATAR_SNAP_STRIDE;
    const id = snap[o + AVATAR_SNAP_ID];
    if (id < 0) {
      w.owner[s] = -1;
      continue;
    }
    if (w.owner[s] !== id) {
      w.owner[s] = id;
      w.aimYaw[s] = 0;
      w.aimPitch[s] = 0;
    }
    w.form[s] = snap[o + AVATAR_SNAP_FORM];
    w.legsFrame[s] = snap[o + AVATAR_SNAP_LEGS_FRAME];
    w.cockpitFrame[s] = snap[o + AVATAR_SNAP_COCKPIT_FRAME];
    w.legsTrack[s] = snap[o + AVATAR_SNAP_LEGS_TRACK];
    w.cockpitTrack[s] = snap[o + AVATAR_SNAP_COCKPIT_TRACK];
    w.state[s] = snap[o + AVATAR_SNAP_WALK_STATE];
    w.flagsB9[s] = snap[o + AVATAR_SNAP_WALK_FLAGS];
    w.asked[s] = snap[o + AVATAR_SNAP_WALK_ASKED];
    const n = Math.min(snap[o + AVATAR_SNAP_CODE_COUNT], X1_CODES_PER_TICK);
    for (let k = 0; k < n; k++)
      w.codes[s * X1_CODES_PER_TICK + k] = snap[o + AVATAR_SNAP_CODES + k];
    w.codeCount[s] = n;
  }
}

/**
 * Slot `s`'s draw form off the snapshot: the walker while the walker's tick
 * runs it (the progress is 0 exactly then: out of the walker `row` turns 1 as
 * the ramp starts, and back only at the walker end, player.c 1442-1483); the
 * hover while the legs hold their hover track (put there at the hover end and
 * by a hover reset, with the progress at 0x10000, player.c 1484-1500,
 * player_transform.c 344-359; either ramp moves them onto 0x0c on the tick it
 * starts); the ramp otherwise. The sim's ramp moves 1600 a tick (walker.ts), so
 * no ramp tick lands on 0 or 0x10000 exactly.
 */
export function x1DrawForm(w: X1Walk, s: number): number {
  // Every load and compare on every call, no early return: an operation the
  // walker never reaches has no type feedback until the first transform, and
  // the frame loop, optimised before then, deopts on it and comes back
  // allocating (x1Alloc.test.ts). X1_FORM_* are 0 / 1 / 2: the ramp times two
  // on the hover track.
  const moving = w.form[s] !== 0 ? X1_FORM_RAMP : X1_FORM_WALKER;
  const hover = w.legsTrack[s] === X1_HOVER_LEG_TRACK ? X1_FORM_HOVER : X1_FORM_RAMP;
  return moving * hover;
}

// --- the cockpit's aim (player_partner_tick, player.c 1611-1690) -----------------

/** A step of the aim a partner tick (PLAYER_AIM_STEP) and its limits, 4096 a turn. */
export const AIM_STEP = 0x18;
export const AIM_PITCH_LIMIT = 0x190;
export const AIM_YAW_LIMIT = 0x80;
const TAU = Math.PI * 2;
const TURN = 4096;

/** `aim_step`: toward `target`, at most AIM_STEP a tick. */
function aimStep(current: number, target: number): number {
  // At most AIM_STEP either way, onto the target within it; a clamp rather
  // than branches, for the reason aimX1 gives.
  return current + Math.max(-AIM_STEP, Math.min(AIM_STEP, target - current));
}

/**
 * One partner tick of the cockpit's aim for slot `s`: toward the lock, if
 * `locked`, at (dx, dy) on the ground and dz up from the cockpit's mount, the
 * hull facing `yaw` (sim radians); back to straight ahead without one. The
 * pitch is minus the elevation (a target above pitches the cockpit up), the yaw
 * the bearing off the facing, each clamped and stepped AIM_STEP a tick.
 */
export function aimX1(
  w: X1Walk,
  s: number,
  locked: boolean,
  dx: number,
  dy: number,
  dz: number,
  yaw: number,
): void {
  // Every operation on every call, the lock picking the result at the end:
  // an operation behind `if (locked)` has no type feedback while nothing is
  // locked, and the frame loop, optimised before the first lock, deopts on it
  // and comes back allocating (x1Alloc.test.ts). With nothing locked the
  // callers pass zeros, whose angles are 0.
  // `(-math_angle_of(horizontal, dy)) >> 12`: the negated angle rounded down.
  const rawPitch = Math.floor((-Math.atan2(dz, Math.sqrt(dx * dx + dy * dy)) * TURN) / TAU);
  // The bearing less the facing, to the nearest turn (above 0x800 loses one).
  const bearing = Math.floor(((Math.atan2(dy, dx) - yaw) * TURN) / TAU) & 0xfff;
  const rawTurn = bearing - (bearing > 0x800 ? 0x1000 : 0);
  const clampedPitch = Math.max(-AIM_PITCH_LIMIT, Math.min(AIM_PITCH_LIMIT, rawPitch));
  const clampedTurn = Math.max(-AIM_YAW_LIMIT, Math.min(AIM_YAW_LIMIT, rawTurn));
  const pitch = locked ? clampedPitch : 0;
  const turn = locked ? clampedTurn : 0;
  w.aimPitch[s] = aimStep(w.aimPitch[s], pitch);
  w.aimYaw[s] = aimStep(w.aimYaw[s], turn);
}

/**
 * The aim as the model-space turns render/x1Pose.ts applies: the yaw about +y
 * against the facing's sense (the rig turns the hull by MODEL_YAW - yaw), the
 * pitch about +x as the original's matrix has it (row-vector Mx = column Rx).
 */
export function aimYawModel(aim: number): number {
  return (-aim * TAU) / TURN;
}

export function aimPitchModel(aim: number): number {
  return (aim * TAU) / TURN;
}
