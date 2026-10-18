// The X1-Alpha's animation, the original's (fcop-fidelity.md G11): which AnmD
// track its legs play and which frame, the cockpit's frame, and the event codes
// the legs hand the walker's movement loop. Pure and allocation-free; the
// renderer poses the mesh by the two frames (render/avatarRig.ts) and the audio
// plays the codes (audio/cues.ts, `snd_loop_set_mode`).
//
// A copy of the animation half of `player_walk_tick` (RE
// src/game/actor/player_walk.c 171-744, retail 0x00444100), of the transform's
// ramp (`player_transform_step`, player.c 1394-1500) and of the AnmD player
// itself (`cact_anim_set_track` / `cact_anim_step`, block.c 133-363):
//
// - The walker runs one step per 8 units of the 300 Hz clock (`eighths`,
//   player.c 1971-1978): at the sim's 30 Hz, 10 units a tick, 1, 1, 1, 2 steps.
// - Each step the input word becomes a command, the command the state (unless
//   the leg track playing holds it, flag 0x02), the state asks for a track (the
//   jump table at 0x00444eb0, X1_STATE_TRACKS below), a new track is started
//   with its STARTED bit, and the track is stepped by a `rate`: 0xa0 in seven
//   states, else the speed >> 8 floored at 0x300 (0x0e), 0x100 (1-4) or 0x1e.
//   A frame advances each time the track's clock passes its period (+0x0c).
// - The events the step passes go to the movement loop, and a track that falls
//   back to track 0 ends the state with code 0x27.
// - The transform plays legs track 0x0c (330 -> 359) and cockpit track 2
//   (0 -> 29) in mode 3, by the ramp's progress, 160 a unit of the clock; the
//   hover holds legs 359 / cockpit 29 (tracks 0x0d and 1); the walker end puts
//   both back on track 0.
//
// What the sim decides is the sim's. The walker's state is not sim state in
// Metropolis, so this runs off the avatar snapshot (sim avatarSnapshot.ts):
// the button word the movement read, the velocity, the airborne bit, the
// transform's lock. Where the two models part:
// - The jumps. The original winds up first (state 0x0a / 0x0f plays track 4 /
//   0x11 on the ground) and leaves the ground when the track reaches one with
//   flag 0x04 (LAUNCH), ~0.38 s / ~0.2 s after the press; Metropolis' sim
//   leaves the ground on the press. So the jump bit of the fast row is not read
//   here, and the take-off the sim reports puts the legs where the original's
//   are at its take-off: the high jump in state 0x0c on track 0x1b (its LAUNCH
//   track), the hop in 0x11 on 0x3a, the leap in 0x0e on 0x36 or 0x37 by the
//   frame. Which jump it was is read off the lift, the vertical speed of the
//   first airborne tick. The wind-ups are not shown (fcop-fidelity.md G11).
// - Airborne and landed are the sim's: the step that finds the sim grounded
//   with the airborne bit set is a landing, faster than 0x50000 (0x80000 on a
//   TOUGH track, flag 0x10) a hard one (state 0x12).
// - Not read: the steep bit (flags_b9 0x40), the probe ahead, the stick, the
//   facing snap, the slow row's ledge hold (the original drops states 1, 2 and 5
//   to 0 and track 0 at a ledge; here only where the sim lets the mech fall).

import {
  ANIM_AIRBORNE,
  ANIM_HOVER,
  AVATAR_SNAP_ANIM,
  AVATAR_SNAP_BUTTONS,
  AVATAR_SNAP_GROUND_MODE,
  AVATAR_SNAP_ID,
  AVATAR_SNAP_LOCK,
  AVATAR_SNAP_STRIDE,
  AVATAR_SNAP_VX,
  AVATAR_SNAP_VY,
  AVATAR_SNAP_VZ,
  BTN_ACTION,
  BTN_BACK,
  BTN_FORWARD,
  BTN_JINK_LEFT,
  BTN_JINK_RIGHT,
  BTN_JUMP,
  BTN_TURN_LEFT,
  BTN_TURN_RIGHT,
  JINKS,
  MAX_PLAYERS,
  TICK_DT,
  TRANSFORM_LOCK_TICKS,
  WALKER_HIGH_LIFT,
  WALKER_HOP_LIFT,
  WALKER_LEAP_LIFT,
  X1_GRAVITY,
  X1_SPEED_UNIT,
  X1_TERMINAL_FALL,
  X1_UNITS_PER_TICK,
} from "@metropolis/sim";
import { X1_COCKPIT_TRACKS, X1_LEG_TRACKS, type X1Track } from "./x1Rig.generated";

// --- the AnmD track's fields (x1Rig.generated.ts X1Track) --------------------

const T_FROM = 0;
const T_TO = 1;
const T_MODE = 2;
const T_END = 3;
const T_LINK = 4;
const T_LINK_B = 5;
const T_LINK_C = 6;
const T_FLAGS = 7;
const T_PERIOD = 8;
const T_EVENT = 9;

/** A new track's first step offers its frame to the event channel (block.c CACT_ANIM_STARTED). */
const STARTED = 1;

/**
 * One AnmD player per slot (the 0x14-byte block, block.c): the track playing,
 * its frame, the clock against its period, the direction and the frame the end
 * action waits for.
 */
export interface AnimPlayer {
  readonly tracks: readonly X1Track[];
  readonly index: Uint8Array;
  readonly frame: Int16Array;
  readonly clock: Int32Array;
  readonly direction: Int8Array;
  readonly target: Int16Array;
  readonly flags: Uint8Array;
}

export function createAnimPlayer(tracks: readonly X1Track[], slots: number): AnimPlayer {
  return {
    tracks,
    index: new Uint8Array(slots),
    frame: new Int16Array(slots),
    clock: new Int32Array(slots),
    direction: new Int8Array(slots),
    target: new Int16Array(slots),
    flags: new Uint8Array(slots),
  };
}

/**
 * `cact_anim_set_track` (0x00431140): mode's sign picks the direction, 2 also
 * keeps the clock (a link followed mid-step); a track whose from > to plays
 * backwards.
 */
export function animSetTrack(a: AnimPlayer, s: number, index: number, mode: number, flags: number) {
  const t = a.tracks[index];
  a.index[s] = index;
  if (mode !== 2) a.clock[s] = 0;
  if (mode > 0) {
    a.direction[s] = 1;
    a.target[s] = t[T_TO];
  } else {
    a.direction[s] = -1;
    a.target[s] = t[T_FROM];
  }
  if (t[T_FROM] > t[T_TO]) a.direction[s] = -a.direction[s];
  a.frame[s] = t[T_FROM];
  a.flags[s] |= flags;
}

/** The step's result: bit 0 "a track ended", up to five 6-bit codes from bit 1. */
let result = 0;
let shift = 1;

/** `anim_fire_event` (0x00431550): the code when the packed frame is passed. */
function fire(event: number, frame: number): void {
  if (frame !== (event & 0x3ff) || shift > 0x19) return;
  result |= ((event >> 10) & 0x3f) << shift;
  shift += 6;
}

/**
 * `cact_anim_step` (0x00431200): one step of `delta` -- clock units for modes 1
 * and 2, a 16.16 progress for mode 3 -- following the end action's link for
 * `variant` (0, 1, 2). Returns the events (bit 0 ended, codes from bit 1).
 * Flags 0x20 and 0x40 (jitter, a random link) are set on no shipped track
 * (gen:x1 checks) and are left out.
 */
export function animStep(a: AnimPlayer, s: number, delta: number, variant: number): number {
  result = 0;
  shift = 1;
  let d = delta;
  for (;;) {
    const t = a.tracks[a.index[s]];
    const event = t[T_EVENT];
    if ((a.flags[s] & STARTED) !== 0) {
      a.flags[s] &= ~STARTED;
      if (event !== 0) fire(event, a.frame[s]);
    }
    const mode = t[T_MODE];
    if (mode === 0) {
      if (event !== 0) fire(event, a.frame[s]);
      return result;
    }
    if (mode === 3) {
      a.frame[s] = t[T_FROM] + (((t[T_TO] - t[T_FROM]) * d) >> 16);
      return result;
    }
    const dir = a.direction[s];
    if (dir === 0) return result;
    a.clock[s] += d;
    d = 0;
    const period = t[T_PERIOD];
    // Track 0x12 has period 0, which would never leave this loop; no state asks for it.
    if (period <= 0) return result;
    let relinked = false;
    while (a.clock[s] > period) {
      a.frame[s] += a.direction[s];
      a.clock[s] -= period;
      if (event !== 0) fire(event, a.frame[s]);
      const end = t[T_END];
      if (end === 0) {
        if (a.frame[s] === a.target[s] + a.direction[s]) {
          result |= 1;
          const next = variant === 0 ? t[T_LINK] : variant === 1 ? t[T_LINK_B] : t[T_LINK_C];
          if (a.index[s] === next) {
            a.frame[s] = t[T_TO] + t[T_FROM] - a.target[s];
            if (event !== 0) fire(event, a.frame[s]);
          } else {
            animSetTrack(a, s, next, 2, STARTED);
            relinked = true;
            break;
          }
        }
      } else if (end === 1) {
        if (a.frame[s] === a.target[s]) {
          a.direction[s] = -a.direction[s];
          a.target[s] = t[T_TO] + t[T_FROM] - a.target[s];
        }
      } else if (end === 2) {
        if (a.frame[s] === a.target[s] + a.direction[s]) {
          a.frame[s] = a.target[s];
          if (event !== 0) fire(event, a.target[s]);
          result |= 1;
        }
      }
    }
    if (!relinked) return result;
  }
}

// --- the walker (player_walk.c) ------------------------------------------------

/** The button word as the walker reads it: the original's bits >> 16 (sim inputs.ts). */
const BIT_SLOW = BTN_ACTION;
const BIT_FORWARD = BTN_FORWARD;
const BIT_BACK = BTN_BACK;
const BIT_SIDE_A = BTN_JINK_RIGHT;
const BIT_SIDE_B = BTN_JINK_LEFT;
const BIT_TURN_A = BTN_TURN_RIGHT;
const BIT_TURN_B = BTN_TURN_LEFT;
/** The command byte's two turn flags over its five-bit state. */
const CMD_TURN_A = 0x40;
const CMD_TURN_B = 0x20;
const CMD_STATE = 0x1f;
/** The leg track's flags byte (actor_player_walk.h 96-106). */
export const TRACK_HOLD = 0x02;
export const TRACK_LAUNCH = 0x04;
export const TRACK_TOUGH = 0x10;
/** The legs' rate (0x00444c84..0x00444cb6). */
export const RATE_FIXED = 0xa0;
export const RATE_LEAP = 0x300;
export const RATE_RUN = 0x100;
export const RATE_MIN = 0x1e;
/** A landing faster than this is an impact (0x00444a1f), 16.16 a step. */
const IMPACT_SOFT = 0x50000;
const IMPACT_TOUGH = 0x80000;
/** The turn track is asked while the speed word (+0x84, |v| >> 11) leaves a turn. */
const TURN_SPEED_LIMIT = 512;

/**
 * The track each state asks for on the ground: the jump table at 0x00444eb0
 * (player_walk.c 362-465). -1 asks nothing, which leaves the step's own ask --
 * track 0, or a turn's 0x0e / 0x0f -- standing (state 0's arm adds 0x10, the
 * idle; 0x0c, the high jump in the air, is the default arm).
 */
export const X1_STATE_TRACKS: readonly number[] = [
  -1, 6, 7, 8, 9, 1, 2, 0x0a, 0x0b, 3, 4, 4, -1, 8, 8, 0x11, 0x11, 0x11, 5,
];

/** The legs track the transform plays (actor_player_transform.h 286-288), and the cockpit's. */
export const X1_TRANSFORM_LEG_TRACK = 0x0c;
export const X1_TRANSFORM_COCKPIT_TRACK = 2;
/** The hover's holds: legs 0x0d (frame 359), cockpit 1 (frame 29). */
export const X1_HOVER_LEG_TRACK = 0x0d;
export const X1_HOVER_COCKPIT_TRACK = 1;
/** The ramp: 160 a clock unit to 0x10000 (PLAYER_FORM_RAMP_RATE, PLAYER_TRANSFORM_FULL). */
const RAMP_RATE = 160;
const RAMP_FULL = 0x10000;

/** The movement loop's "stop" code: a state that ends on track 0 sends it. */
export const X1_LOOP_STOP = 0x27;
/** At most this many codes a slot a tick (two steps of five, and the ends). */
export const X1_CODES_PER_TICK = 16;

/** The three jumps the sim can start, by their lift (balance.ts). */
const JUMP_LEAP = 1;
const JUMP_HIGH = 2;
const JUMP_HOP = 3;

export interface X1Walk {
  /** Each slot's X1 entity id, -1 while it has none. */
  readonly owner: Int32Array;
  /** 1 while the hover form runs the slot's tick (hover, or either ramp), else 0. */
  readonly form: Uint8Array;
  /** The frames to draw: the legs' (0-370) and the cockpit's (0-29). */
  readonly legsFrame: Int16Array;
  readonly cockpitFrame: Int16Array;
  /** The walker's state (`state_bb`), its flags byte (`flags_b9`), the last track asked (`byte_ba`), the idle count (`byte_c3`). */
  readonly state: Uint8Array;
  readonly flagsB9: Uint8Array;
  readonly asked: Uint8Array;
  readonly idle: Uint8Array;
  /** The eighths' carry of the clock (player.c 1971-1978). */
  readonly carry: Uint8Array;
  readonly legs: AnimPlayer;
  readonly cockpit: AnimPlayer;
  /** Last tick's airborne bit and vertical speed, for the take-off and the landing. */
  readonly wasAirborne: Uint8Array;
  readonly lastVz: Float32Array;
  /** This tick's codes for the movement loop, X1_CODES_PER_TICK a slot. */
  readonly codes: Uint8Array;
  readonly codeCount: Uint8Array;
}

export function createX1Walk(slots = MAX_PLAYERS): X1Walk {
  return {
    owner: new Int32Array(slots).fill(-1),
    form: new Uint8Array(slots),
    legsFrame: new Int16Array(slots),
    cockpitFrame: new Int16Array(slots),
    state: new Uint8Array(slots),
    flagsB9: new Uint8Array(slots),
    asked: new Uint8Array(slots),
    idle: new Uint8Array(slots),
    carry: new Uint8Array(slots),
    legs: createAnimPlayer(X1_LEG_TRACKS, slots),
    cockpit: createAnimPlayer(X1_COCKPIT_TRACKS, slots),
    wasAirborne: new Uint8Array(slots),
    lastVz: new Float32Array(slots),
    codes: new Uint8Array(slots * X1_CODES_PER_TICK),
    codeCount: new Uint8Array(slots),
  };
}

function pushCodes(w: X1Walk, s: number, events: number): void {
  // Each 6-bit code above bit 0, low first (0x00444d9a); a zero is no call.
  for (let codes = events >>> 1; codes !== 0; codes >>>= 6) {
    const code = codes & 0x3f;
    if (code !== 0) pushCode(w, s, code);
  }
}

function pushCode(w: X1Walk, s: number, code: number): void {
  const n = w.codeCount[s];
  if (n >= X1_CODES_PER_TICK) return;
  w.codes[s * X1_CODES_PER_TICK + n] = code;
  w.codeCount[s] = n + 1;
}

/** The walker's reset (player_reset 0x00441ab0): stand on track 0. */
function resetWalker(w: X1Walk, s: number): void {
  w.form[s] = 0;
  w.state[s] = 0;
  w.flagsB9[s] = 0;
  w.asked[s] = 0;
  w.idle[s] = 0;
  w.legs.flags[s] = 0;
  w.cockpit.flags[s] = 0;
  animSetTrack(w.legs, s, 0, 1, 0);
  animSetTrack(w.cockpit, s, 0, 1, 0);
}

/** A mech spawned or reset as a hover (player_transform.c 344-359). */
function resetHover(w: X1Walk, s: number): void {
  resetWalker(w, s);
  w.form[s] = 1;
  animSetTrack(w.legs, s, X1_HOVER_LEG_TRACK, 1, 0);
  animSetTrack(w.cockpit, s, X1_HOVER_COCKPIT_TRACK, 1, 0);
}

/** The eight moving states and 0x0e (0x00444307). */
function moving(state: number): boolean {
  return (state >= 1 && state <= 8) || state === 0x0e;
}

/** The input word into the command byte (0x00444212 / 0x0044427a), the fast row's jump left to the sim. */
export function walkerCommand(buttons: number): number {
  let bits = buttons;
  if ((bits & JINKS) === JINKS) bits &= ~JINKS;
  let command = 0;
  if ((bits & BIT_SLOW) !== 0) {
    if ((bits & BIT_FORWARD) !== 0) command = 1;
    else if ((bits & BIT_BACK) !== 0) command = 2;
    else if ((bits & BTN_JUMP) !== 0) command = 9;
    else if ((bits & BIT_SIDE_A) !== 0) command = 6;
    else if ((bits & BIT_SIDE_B) !== 0) command = 5;
  } else {
    if ((bits & BIT_FORWARD) !== 0) command = 3;
    else if ((bits & BIT_BACK) !== 0) command = 4;
    else if ((bits & BIT_SIDE_A) !== 0) command = 8;
    else if ((bits & BIT_SIDE_B) !== 0) command = 7;
  }
  if ((bits & BIT_TURN_A) !== 0) command |= CMD_TURN_A;
  else if ((bits & BIT_TURN_B) !== 0) command |= CMD_TURN_B;
  return command;
}

/** The legs' rate for `state` at `speed` (|v|, 16.16 a step) on ground mode `lean` (0x00444bb4). */
export function legRate(state: number, speed: number, lean: number): number {
  if (
    state === 0x0a ||
    state === 0x0f ||
    state === 0x0b ||
    state === 0x0c ||
    state === 0x12 ||
    state === 9 ||
    state === 0x11
  ) {
    return RATE_FIXED;
  }
  let rate = Math.floor(speed) >> 8;
  if (lean !== 0) rate *= 4 - lean;
  if (state === 0x0e) return rate < RATE_LEAP ? RATE_LEAP : rate;
  if (state >= 1 && state <= 4) return rate < RATE_RUN ? RATE_RUN : rate;
  return rate < RATE_MIN ? RATE_MIN : rate;
}

/** A m/s speed as the original's 16.16 a movement step. */
function perStep(mps: number): number {
  return (mps / X1_SPEED_UNIT) * 65536;
}

/** The first airborne tick's vertical speed after each lift: the lift less a tick of gravity. */
const FIRST_VZ_LEAP = WALKER_LEAP_LIFT - X1_GRAVITY * TICK_DT;
const FIRST_VZ_HIGH = WALKER_HIGH_LIFT - X1_GRAVITY * TICK_DT;
const FIRST_VZ_HOP = WALKER_HOP_LIFT - X1_GRAVITY * TICK_DT;

/** Which jump left the ground with vertical speed `vz` on its first tick. */
export function jumpOf(vz: number): number {
  const dl = Math.abs(vz - FIRST_VZ_LEAP);
  const dh = Math.abs(vz - FIRST_VZ_HIGH);
  const dp = Math.abs(vz - FIRST_VZ_HOP);
  if (dh <= dl && dh <= dp) return JUMP_HIGH;
  return dl <= dp ? JUMP_LEAP : JUMP_HOP;
}

/**
 * Puts the legs where the original's are as the sim's jump leaves the ground
 * (see the header): the state after the launch arm, the track it asks for,
 * and the LAUNCH track (or the leap's) under way.
 */
function takeOff(w: X1Walk, s: number, jump: number): void {
  if (jump === JUMP_LEAP) {
    // 0x00444cf4: 0x37 from the frames 2..5 and 0x12..0x1f, 0x36 from any other.
    const f = w.legs.frame[s];
    const leap = (f >= 2 && f <= 5) || (f >= 0x12 && f <= 0x1f) ? 0x37 : 0x36;
    animSetTrack(w.legs, s, leap, 1, STARTED);
    w.flagsB9[s] &= 0xcf;
    w.state[s] = 0x0e;
    w.asked[s] = 8;
  } else if (jump === JUMP_HIGH) {
    // 0x0a's track 4 links into 0x1b (LAUNCH): 0x0b, then 0x0c and the lift.
    animSetTrack(w.legs, s, 0x1b, 1, STARTED);
    w.state[s] = 0x0c;
    w.asked[s] = 4;
  } else {
    // 0x0f's track 0x11 links into 0x3a (LAUNCH): 0x10, then 0x11 and the lift.
    animSetTrack(w.legs, s, 0x3a, 1, STARTED);
    w.state[s] = 0x11;
    w.asked[s] = 0x11;
  }
  w.flagsB9[s] |= 1;
}

/**
 * One movement step of the walker's animation (player_walk.c 230-722, the
 * loop body, its animation half). `airborne` is the sim's; `impact` the
 * landing's speed (16.16 a step) for the step that lands, else 0.
 */
function walkStep(
  w: X1Walk,
  s: number,
  command: number,
  speed: number,
  lean: number,
  airborne: boolean,
  impact: number,
): void {
  const legs = w.legs;
  const wanted = command & CMD_STATE;
  let b9 = w.flagsB9[s];
  let state = w.state[s];
  let track = 0;

  // 0x004442fa: on the ground a moving state with nothing commanded stops.
  if ((b9 & 1) === 0 && moving(state) && command === 0) state = 0;
  // 0x0044432c: bit 5 goes with either of bits 0 and 6.
  if ((b9 & 0x41) !== 0) b9 &= 0xdf;
  if (state === 0 && wanted === 0) b9 &= 0xcd;
  // 0x00444351: the continuation the legs follow at a track's end.
  let variant = (b9 & 0x10) !== 0 ? 1 : (b9 >> 4) & 2;
  // 0x00444376: the command into the state, unless the track holds it.
  const flags = legs.tracks[legs.index[s]][T_FLAGS];
  if ((flags & TRACK_HOLD) === 0) {
    if (wanted === state || (legs.index[s] === 0 && (b9 & 2) === 0)) {
      state = wanted;
    } else {
      b9 &= 0xfd;
      variant = 1;
    }
  } else if ((b9 & 2) !== 0) {
    b9 &= 0xfd;
    variant = 1;
    if (wanted !== 0) state = wanted;
  }
  // 0x004443c3: the landing bit is spent; on the ground a turn asks for its track.
  b9 &= 0xfd;
  if ((b9 & 1) === 0 && speed < TURN_SPEED_LIMIT * 2048) {
    if ((command & CMD_TURN_A) !== 0) track = 0x0f;
    else if ((command & CMD_TURN_B) !== 0) track = 0x0e;
  }

  // 0x004444d9: in the air the legs keep their track; on the ground the state's.
  if ((b9 & 1) !== 0) {
    track = w.asked[s];
  } else if (state === 0) {
    // 0x0044468d: +0xc3 counts the idle steps; its wrap to 0 asks for 0x10.
    if (command !== 0) {
      w.idle[s] = 0;
    } else {
      w.idle[s] = (w.idle[s] + 1) & 0xff;
      if (w.idle[s] === 0) {
        track = 0x10;
      } else if (legs.index[s] !== 0 && w.asked[s] === 0x10) {
        w.idle[s] = 0;
        track = 0x10;
      }
    }
  } else if (state < X1_STATE_TRACKS.length && X1_STATE_TRACKS[state] >= 0) {
    track = X1_STATE_TRACKS[state];
    // The launch arms (unreached here: the sim's take-off stands in for them).
    if (state === 0x0b) state = 0x0c;
    else if (state === 0x0d) state = 0x0e;
    else if (state === 0x10) state = 0x11;
  }

  // 0x004449de: the surface. Grounded with the airborne bit set is a landing.
  if (!airborne) {
    if ((b9 & 1) !== 0) {
      b9 = (b9 & 0xfe) | 2;
      const limit =
        (legs.tracks[legs.index[s]][T_FLAGS] & TRACK_TOUGH) !== 0 ? IMPACT_TOUGH : IMPACT_SOFT;
      if (impact > limit) state = 0x12;
    }
  } else if ((b9 & 1) === 0) {
    // 0x00444a88: it falls; states 1, 2 and 5 are put back to 0 on track 0.
    if (state === 1 || state === 2 || state === 5) {
      state = 0;
      track = 0;
    }
    b9 |= 1;
  }
  // 0x00444b4f: the leap is airborne until it lands.
  if (state === 0x0e && (b9 & 2) === 0) b9 |= 1;

  // 0x00444b7a: a new track, or the asked one again when the legs fell back to 0.
  if (track !== w.asked[s] || (legs.index[s] === 0 && track !== 0)) {
    animSetTrack(legs, s, track, 1, STARTED);
    w.asked[s] = track;
  }

  const events = animStep(legs, s, legRate(state, speed, lean), variant);
  const ended = events & 1;
  if (ended !== 0) b9 &= 0xef;
  else if (variant !== 0) b9 |= 8 << variant;
  pushCodes(w, s, events);

  // 0x00444db6: a LAUNCH track moves the wind-ups on.
  if ((legs.tracks[legs.index[s]][T_FLAGS] & TRACK_LAUNCH) !== 0) {
    if (state === 0x0a) state = 0x0b;
    else if (state === 0x0f) state = 0x10;
  }
  // 0x00444de0: a track that ends on track 0 ends the state.
  if (legs.index[s] === 0 && ended !== 0) {
    state = 0;
    pushCode(w, s, X1_LOOP_STOP);
  }
  w.state[s] = state;
  w.flagsB9[s] = b9 & 0xff;
}

/**
 * One sim tick for every slot, off the avatar snapshot (sim avatarSnapshot.ts).
 * Call once after each sim step; it allocates nothing.
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
    const anim = snap[o + AVATAR_SNAP_ANIM];
    const hover = (anim & ANIM_HOVER) !== 0;
    const lock = snap[o + AVATAR_SNAP_LOCK];
    const vz = snap[o + AVATAR_SNAP_VZ];
    const airborne = (anim & ANIM_AIRBORNE) !== 0;
    if (w.owner[s] !== id) {
      // A new mech (a spawn or a respawn): the reset's tracks, by its form.
      w.owner[s] = id;
      w.carry[s] = 0;
      if (hover && lock === 0) resetHover(w, s);
      else resetWalker(w, s);
      w.wasAirborne[s] = airborne ? 1 : 0;
      w.lastVz[s] = vz;
    }

    if (lock > 0) {
      // The ramp (player.c 1442-1500), `k` ticks into it; the sim flips the
      // mode on its first tick, so ANIM_HOVER is the form it ramps to.
      const k = TRANSFORM_LOCK_TICKS - lock;
      const ramp = RAMP_RATE * X1_UNITS_PER_TICK * (k + 1);
      if (w.form[s] === 0 || w.legs.index[s] !== X1_TRANSFORM_LEG_TRACK) {
        // The request: both blocks onto the transform's tracks, forward or back.
        const dir = hover ? 1 : -1;
        animSetTrack(w.legs, s, X1_TRANSFORM_LEG_TRACK, dir, 0);
        animSetTrack(w.cockpit, s, X1_TRANSFORM_COCKPIT_TRACK, dir, 0);
      }
      w.form[s] = 1;
      if (hover && ramp > RAMP_FULL) {
        // The hover end.
        animSetTrack(w.legs, s, X1_HOVER_LEG_TRACK, 1, 0);
        animSetTrack(w.cockpit, s, X1_HOVER_COCKPIT_TRACK, 1, 0);
      } else if (!hover && RAMP_FULL - ramp < 0) {
        // The walker end: both blocks back on track 0.
        resetWalker(w, s);
      } else {
        const progress = hover ? ramp : RAMP_FULL - ramp;
        animStep(w.cockpit, s, progress, 0);
        animStep(w.legs, s, progress, 0);
      }
    } else if (hover) {
      // The hover's tick steps neither block: legs 359, cockpit 29.
      if (w.form[s] === 0 || w.legs.index[s] !== X1_HOVER_LEG_TRACK) resetHover(w, s);
    } else {
      // The walker. A ramp that ended without its walker end (cut short) ends here.
      if (w.form[s] !== 0) resetWalker(w, s);
      const vx = snap[o + AVATAR_SNAP_VX];
      const vy = snap[o + AVATAR_SNAP_VY];
      const speed = perStep(Math.sqrt(vx * vx + vy * vy + vz * vz));
      const lean = snap[o + AVATAR_SNAP_GROUND_MODE];
      const command = walkerCommand(snap[o + AVATAR_SNAP_BUTTONS]);
      let impact = 0;
      if (airborne && w.wasAirborne[s] === 0 && vz > 0) {
        takeOff(w, s, jumpOf(vz));
      } else if (!airborne && w.wasAirborne[s] !== 0) {
        // The fall's last tick, one more tick of gravity to the ground.
        let fall = -w.lastVz[s] + X1_GRAVITY * TICK_DT;
        if (fall > X1_TERMINAL_FALL) fall = X1_TERMINAL_FALL;
        impact = perStep(fall);
      }
      const units = w.carry[s] + X1_UNITS_PER_TICK;
      const eighths = units >> 3;
      w.carry[s] = units & 7;
      for (let e = 0; e < eighths; e++) {
        walkStep(w, s, command, speed, lean, airborne, e === 0 ? impact : 0);
      }
    }
    w.wasAirborne[s] = airborne ? 1 : 0;
    w.lastVz[s] = vz;
    w.legsFrame[s] = w.legs.frame[s];
    w.cockpitFrame[s] = w.cockpit.frame[s];
  }
}
