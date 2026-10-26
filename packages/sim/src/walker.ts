// The X1-Alpha's walker state machine and its legs (fcop-fidelity.md G11, P4):
// `player_walk_tick` (RE src/game/actor/player_walk.c 171-744, retail
// 0x00444100), the transform's ramp of both AnmD blocks (`player_transform_step`,
// player.c 1394-1500), the reset (`player_reset`, player_transform.c 318-360)
// and the AnmD player itself (`cact_anim_set_track` / `cact_anim_step`, block.c
// 133-363). Integer as the original's, and stepped as it steps:
//
// - one walker step per 8 units of the 300 Hz clock (`byte_b6`, player.c
//   1971-1978): at the sim's 10 units a tick, 1, 1, 1, 2 steps, in either form;
// - each step the tick's command (decoded once a tick from the button word, a
//   fast-row jump by the probe ahead) becomes the state unless the playing leg
//   track holds it (flag 0x02, HOLD), the state's arm (the jump table at
//   0x00444eb0, balance.ts WALK_ARMS) pushes, lifts and asks for a track, a new
//   track starts with its STARTED bit, and the legs step by a rate: 0xa0 in
//   seven states, else the speed >> 8 over the state's floor;
// - the take-offs are arms: 0x0b (the high jump) and 0x10 (the hop), reached
//   from their wind-ups 0x0a / 0x0f only when the legs' track carries LAUNCH
//   (flag 0x04), and 0x0d (the leap), which the run's third continuation starts.
//
// The sim's movement is per tick (balance.ts "HOW THEY RUN AT 30 Hz"), the
// original's per step. sim.ts runs a step's halves around it: the arm of the
// tick's first step before the movement (its push, lift, impulse, settle and
// turn drive the tick), the landing and the legs after it (`walkerLand`,
// `walkerLegs`); a tick's second step runs whole after the movement, its lift
// and impulse going into the velocity the next tick integrates.
//
// The facing snap (`player_snap_facing`, 0x004437d0) is here as `snapFacing`;
// sim.ts runs it, with the wall contacts' push, on the facing it keeps.
//
// Not modelled: the stick (dead in retail), the bounds' pairs (the crouch's
// lowered box; its bit 0x80 is kept), the actors' contacts' push
// (`player_push_contacts`, Metropolis has no hit boxes for it), block +0xdf's
// lifts (bit 0 clear in PA) and the legs' model box per frame.

import {
  HOVER_IMPACT_HARD,
  SNAP_STEP,
  TRANSFORM_LOCK_TICKS,
  WALK_ARMS,
  WALK_CODES_PER_TICK,
  WALK_IDLE_TRACK,
  WALK_IMPACT_SOFT,
  WALK_IMPACT_TOUGH,
  WALK_LEAP_FRAMES_B,
  WALK_LEAP_TRACK,
  WALK_LEAP_TRACK_B,
  WALK_LOOP_STOP,
  WALK_LUNGE_COUNT,
  WALK_RATE_FIXED,
  WALK_RATE_LEAP,
  WALK_RATE_MIN,
  WALK_RATE_RUN,
  WALK_SHORT_TAIL,
  WALK_TRACK_HOLD,
  WALK_TRACK_LAUNCH,
  WALK_TRACK_TOUGH,
  WALK_TURN_SPEED_SHIFT,
  WALKER_HIGH_RISE,
  WALKER_LUNGE_MAX_RISE,
  WALKER_TURN_STEP,
  X1_HOVER_COCKPIT_TRACK,
  X1_HOVER_LEG_TRACK,
  X1_RAMP_FULL,
  X1_RAMP_RATE,
  X1_TRANSFORM_COCKPIT_TRACK,
  X1_TRANSFORM_LEG_TRACK,
  X1_UNITS_PER_TICK,
} from "./balance";
import {
  BTN_ACTION,
  BTN_BACK,
  BTN_FORWARD,
  BTN_JINK_LEFT,
  BTN_JINK_RIGHT,
  BTN_JUMP,
  BTN_TURN_LEFT,
  BTN_TURN_RIGHT,
} from "./inputs";
import { X1_COCKPIT_TRACKS, X1_LEG_TRACKS, type X1Track } from "./x1Tracks.generated";

// --- the AnmD player (block.c) -------------------------------------------------

/** The track's fields (x1Tracks.generated.ts X1Track). */
export const T_FROM = 0;
export const T_TO = 1;
export const T_MODE = 2;
export const T_END = 3;
export const T_LINK = 4;
export const T_LINK_B = 5;
export const T_LINK_C = 6;
export const T_FLAGS = 7;
export const T_PERIOD = 8;
export const T_EVENT = 9;

/** Any actor's AnmD track (the X1's, the Dreadnought hull's): block.c `anmd_track`. */
export type AnmdTrack = X1Track;

/** A new track's first step offers its frame to the event channel (CACT_ANIM_STARTED). */
export const ANIM_STARTED = 1;

/**
 * One AnmD block per slot (the 0x14-byte `cact_anim`): the track playing, its
 * frame, the clock against its period, the direction, the frame the end action
 * waits for, and the flags byte (STARTED).
 */
export interface AnimPlayer {
  readonly tracks: readonly AnmdTrack[];
  readonly index: Uint8Array;
  readonly frame: Int16Array;
  readonly clock: Int32Array;
  readonly direction: Int8Array;
  readonly target: Int16Array;
  readonly flags: Uint8Array;
}

export function createAnimPlayer(tracks: readonly AnmdTrack[], slots: number): AnimPlayer {
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
 * backwards; `flags` is or-ed in.
 */
export function animSetTrack(
  a: AnimPlayer,
  s: number,
  index: number,
  mode: number,
  flags: number,
): void {
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
 * (gen:x1 checks) and are left out; so are the orders (STOPPED).
 */
export function animStep(a: AnimPlayer, s: number, delta: number, variant: number): number {
  result = 0;
  shift = 1;
  let d = delta;
  for (;;) {
    const t = a.tracks[a.index[s]];
    const event = t[T_EVENT];
    if ((a.flags[s] & ANIM_STARTED) !== 0) {
      a.flags[s] &= ~ANIM_STARTED;
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
    if (a.direction[s] === 0) return result;
    a.clock[s] += d;
    d = 0;
    const period = t[T_PERIOD];
    // Track 0x12 has period 0, which would never leave the loop; no state asks for it.
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
            animSetTrack(a, s, next, 2, ANIM_STARTED);
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

// --- the walker's per-player state (actor_player.h +0xb6..+0xc3, +0xc8) -------

/** The command byte's two turn flags over its five-bit state (0x0044413d, 0x004442d6). */
export const WALK_CMD_TURN_A = 0x40;
export const WALK_CMD_TURN_B = 0x20;
export const WALK_CMD_STATE = 0x1f;
/** `flags_b9`'s bits: no control (airborne), a landing this step, a wall ahead of a jump, the second / third continuation pending, steep, the crouch's pair. */
export const WALK_AIRBORNE = 0x01;
export const WALK_LANDED = 0x02;
export const WALK_WALL = 0x08;
export const WALK_STEEP = 0x40;
export const WALK_CROUCHED = 0x80;

export interface WalkerState {
  /** `state_bb`: the walker's state, the jump table's selector (0..0x12; the hover writes its own). */
  readonly state: Uint8Array;
  /** `flags_b9` (WALK_AIRBORNE ... WALK_CROUCHED). */
  readonly flags: Uint8Array;
  /** `byte_ba`: the leg track the walker last asked for. */
  readonly asked: Uint8Array;
  /** `byte_c3`: the idle count; its wrap asks for the fidget. */
  readonly idle: Uint8Array;
  /** `byte_c2`: the high jump's lunge countdown. */
  readonly lunge: Uint8Array;
  /** `byte_b6`: the clock's remainder of eighths. */
  readonly carry: Uint8Array;
  /** 1 while the hover's tick runs (the hover and both ramps), else 0: the block's `row`. */
  readonly form: Uint8Array;
  /** The legs' AnmD block (`player_actor::anim`) and the cockpit's (the partner's). */
  readonly legs: AnimPlayer;
  readonly cockpit: AnimPlayer;
  /**
   * This tick's movement steps, `walkerEighths`' answer (transient: 0 for a slot
   * whose mech did not step this tick). The floors and the lifts' tags hurt by
   * it, as the original's floor check runs in each step (sim.ts systemFloors).
   */
  readonly steps: Uint8Array;
  /** This tick's codes for the movement loop, WALK_CODES_PER_TICK a slot (transient). */
  readonly codes: Uint8Array;
  readonly codeCount: Uint8Array;
  /** A step's locals between its arm and its legs: the track asked, the continuation (transient). */
  readonly stepTrack: Uint8Array;
  readonly stepVariant: Uint8Array;
}

export function createWalkerState(slots: number): WalkerState {
  const w: WalkerState = {
    state: new Uint8Array(slots),
    flags: new Uint8Array(slots),
    asked: new Uint8Array(slots),
    idle: new Uint8Array(slots),
    lunge: new Uint8Array(slots),
    carry: new Uint8Array(slots),
    form: new Uint8Array(slots),
    legs: createAnimPlayer(X1_LEG_TRACKS, slots),
    cockpit: createAnimPlayer(X1_COCKPIT_TRACKS, slots),
    steps: new Uint8Array(slots),
    codes: new Uint8Array(slots * WALK_CODES_PER_TICK),
    codeCount: new Uint8Array(slots),
    stepTrack: new Uint8Array(slots),
    stepVariant: new Uint8Array(slots),
  };
  for (let s = 0; s < slots; s++) walkerReset(w, s, false);
  return w;
}

/**
 * `player_reset` (0x00441ab0) of the machine: state 0, flags 1 (no control
 * until the first step finds the ground), nothing asked, the legs on track 0
 * (0x0d as a hover) and the cockpit on 0 (1), their flags cleared as the
 * construct's `cact_anim_init` leaves them. The eighths' carry is the
 * construct's only (0x00446b57) and is not reset.
 */
export function walkerReset(w: WalkerState, s: number, hover: boolean): void {
  w.state[s] = 0;
  w.flags[s] = WALK_AIRBORNE;
  w.asked[s] = 0;
  w.idle[s] = 0;
  w.lunge[s] = 0;
  w.form[s] = hover ? 1 : 0;
  w.legs.flags[s] = 0;
  w.cockpit.flags[s] = 0;
  animSetTrack(w.legs, s, hover ? X1_HOVER_LEG_TRACK : 0, 1, 0);
  animSetTrack(w.cockpit, s, hover ? X1_HOVER_COCKPIT_TRACK : 0, 1, 0);
}

/**
 * This tick's movement steps (player.c 1971-1978): the clock's 10 units over the
 * carry, in eighths; kept in `steps` for the tick's later systems.
 */
export function walkerEighths(w: WalkerState, s: number): number {
  const units = w.carry[s] + X1_UNITS_PER_TICK;
  w.carry[s] = units & 7;
  w.steps[s] = units >> 3;
  return units >> 3;
}

function pushCode(w: WalkerState, s: number, code: number): void {
  const n = w.codeCount[s];
  if (n >= WALK_CODES_PER_TICK) return;
  w.codes[s * WALK_CODES_PER_TICK + n] = code;
  w.codeCount[s] = n + 1;
}

function pushCodes(w: WalkerState, s: number, events: number): void {
  // Each 6-bit code above bit 0, low first (0x00444d9a); a zero is no call.
  for (let codes = events >>> 1; codes !== 0; codes >>>= 6) {
    const code = codes & 0x3f;
    if (code !== 0) pushCode(w, s, code);
  }
}

/** The leg track's flags byte, `[[anim.track]+3]` (0x00444396, 0x00444a15, 0x00444dbc). */
function trackFlags(w: WalkerState, s: number): number {
  return w.legs.tracks[w.legs.index[s]][T_FLAGS];
}

/** The eight moving states and 0x0e (0x00444307). */
function moving(state: number): boolean {
  return (state >= 1 && state <= 8) || state === 0x0e;
}

/** `player_velocity_delta`'s short tail (0x0044506d): no control, whether airborne or not. */
export function walkerShortTail(state: number): boolean {
  for (let k = 0; k < WALK_SHORT_TAIL.length; k++) if (WALK_SHORT_TAIL[k] === state) return true;
  return false;
}

/**
 * Whether this tick's command is the fast row's jump, which the probe of the
 * ground ahead decides (0x00444142): Jump without the Action Key, unless the
 * walker runs (3) or leaps (0x0d, 0x0e) or stands on steep ground.
 */
export function walkerProbes(w: WalkerState, s: number, bits: number): boolean {
  const st = w.state[s];
  return (
    (bits & BTN_JUMP) !== 0 &&
    (bits & BTN_ACTION) === 0 &&
    st !== 3 &&
    st !== 0x0d &&
    st !== 0x0e &&
    (w.flags[s] & WALK_STEEP) === 0
  );
}

/**
 * The tick's command byte (0x00444142..0x004442db): the fast row's jump by the
 * probe's `rise` (m) -- 0x0a over 0xae1, 0x0f else, no turn bit; over 0x2333
 * it also sets the wall bit, which takes the lunge away -- else the slow or
 * the fast row and the turn bits. `bits` has both jinks cancelled.
 */
export function walkerCommand(w: WalkerState, s: number, bits: number, rise: number): number {
  if (walkerProbes(w, s, bits)) {
    if (rise > WALKER_HIGH_RISE) {
      if (rise > WALKER_LUNGE_MAX_RISE) w.flags[s] |= WALK_WALL;
      return 0x0a;
    }
    return 0x0f;
  }
  let command = 0;
  if ((bits & BTN_ACTION) !== 0) {
    if ((bits & BTN_FORWARD) !== 0) command = 1;
    else if ((bits & BTN_BACK) !== 0) command = 2;
    else if ((bits & BTN_JUMP) !== 0) command = 9;
    else if ((bits & BTN_JINK_RIGHT) !== 0) command = 6;
    else if ((bits & BTN_JINK_LEFT) !== 0) command = 5;
  } else {
    if ((bits & BTN_FORWARD) !== 0) command = 3;
    else if ((bits & BTN_BACK) !== 0) command = 4;
    else if ((bits & BTN_JINK_RIGHT) !== 0) command = 8;
    else if ((bits & BTN_JINK_LEFT) !== 0) command = 7;
  }
  if ((bits & BTN_TURN_RIGHT) !== 0) command |= WALK_CMD_TURN_A;
  else if ((bits & BTN_TURN_LEFT) !== 0) command |= WALK_CMD_TURN_B;
  return command;
}

/** What a step's arm hands the movement (`player_velocity_delta`'s arguments and the turn). */
export interface WalkArmOut {
  /** The push, 16.16 a step: along the heading, or across it (`sideways`, + toward Jink Right). */
  push: number;
  sideways: boolean;
  /** States 1-4 with a jink and no Jump: the diagonal, 1 toward Jink Right, -1 Jink Left. */
  diagonal: number;
  /** The push is one step's (a take-off's or the lunge), not a steady drive. */
  impulse: boolean;
  /** The take-off's vertical lift, 16.16 a step, 0 for none. */
  lift: number;
  /** The stop test runs (states 0, 9, 0x12 on the ground). */
  settle: boolean;
  /** The step's turn, 4096 a turn, after the speed's share; 0 for none. */
  turn: number;
}

/** The last arm's outputs (one sim, one player at a time). */
export const WALK_ARM: WalkArmOut = {
  push: 0,
  sideways: false,
  diagonal: 0,
  impulse: false,
  lift: 0,
  settle: false,
  turn: 0,
};

/**
 * The first half of a walker step (0x004442fa..0x0044476b): the command into
 * the state, unless the leg track holds it; the turn on the ground (`speed`,
 * the instance's +0x84 word, |v| >> 11 16.16 a step); the lunge countdown; and
 * the state's arm -- in the air the legs keep their track and only the lunge
 * pushes. Writes WALK_ARM and the step's track and continuation.
 */
export function walkerArm(
  w: WalkerState,
  s: number,
  command: number,
  bits: number,
  speed: number,
  snap = false,
): void {
  const legs = w.legs;
  const wanted = command & WALK_CMD_STATE;
  let track = 0;
  let b9 = w.flags[s];
  // 0x004442fa: on the ground a moving state with nothing commanded stops.
  if ((b9 & WALK_AIRBORNE) === 0 && moving(w.state[s]) && command === 0) w.state[s] = 0;
  // 0x0044432c: bit 5 goes with either of bits 0 and 6.
  if ((b9 & 0x41) !== 0) w.flags[s] = b9 & 0xdf;
  const state = w.state[s];
  if (state === 0 && wanted === 0) w.flags[s] &= 0xcd;
  // 0x00444351: which continuation the legs follow at a track's end.
  b9 = w.flags[s];
  let variant = (b9 & 0x10) !== 0 ? 1 : (b9 >> 4) & 2;
  // 0x00444376: the command into the state.
  if ((bits & BTN_JUMP) !== 0 && state === 3 && variant === 0) {
    variant = 2;
  } else if ((trackFlags(w, s) & WALK_TRACK_HOLD) === 0) {
    if (wanted === state || (legs.index[s] === 0 && (b9 & WALK_LANDED) === 0)) {
      w.state[s] = wanted;
    } else {
      w.flags[s] = b9 & 0xfd;
      variant = 1;
    }
  } else if ((b9 & WALK_LANDED) !== 0) {
    w.flags[s] = b9 & 0xfd;
    variant = 1;
    if (wanted !== 0) w.state[s] = wanted;
  }
  // 0x004443c3: the landing bit is spent. On the ground, the turn: 0x20 a step
  // less `speed * turn >> 9`, and the turn's track.
  w.flags[s] &= 0xfd;
  let turn = 0;
  if ((w.flags[s] & WALK_AIRBORNE) === 0) {
    if ((command & WALK_CMD_TURN_A) !== 0) turn = WALKER_TURN_STEP;
    else if ((command & WALK_CMD_TURN_B) !== 0) turn = -WALKER_TURN_STEP;
    if (turn !== 0) {
      turn -= Math.imul(speed, turn) >> WALK_TURN_SPEED_SHIFT;
      track = turn > 0 ? 0x0f : 0x0e;
    }
  }
  // 0x00444426: a pending snap (`snap`; sim.ts turns the facing) puts a moving
  // state that differs from the command back to 0.
  if (snap) {
    const now = w.state[s];
    if (now !== wanted && moving(now)) w.state[s] = 0;
  }
  // 0x00444497: the lunge countdown.
  if (w.lunge[s] !== 0) w.lunge[s] -= 1;
  // 0x004444a9: leaving state 9 puts the bounds' standing pair back.
  if ((w.flags[s] & WALK_CROUCHED) !== 0 && w.state[s] !== 9) w.flags[s] &= 0x7f;

  const out = WALK_ARM;
  out.push = 0;
  out.sideways = false;
  out.impulse = false;
  out.lift = 0;
  out.settle = false;
  b9 = w.flags[s];
  if ((b9 & WALK_AIRBORNE) !== 0) {
    // 0x004446dd: in the air the legs keep their track; on the jump's last
    // count (state 0x0c) the lunge -- unless the probe found a wall.
    track = w.asked[s];
    if (w.lunge[s] === 1 && w.state[s] === 0x0c) {
      if ((b9 & WALK_WALL) === 0) {
        out.push = 0x1cccc;
        out.impulse = true;
      }
      w.flags[s] = b9 & 0xf7;
    }
  } else {
    const st = w.state[s];
    if (st === 0) {
      // 0x0044468d: +0xc3 counts the steps with nothing commanded; its wrap to
      // 0 asks for the fidget, and so does a fidget the legs have moved off 0 with.
      out.settle = true;
      if (command !== 0) {
        w.idle[s] = 0;
      } else {
        w.idle[s] = (w.idle[s] + 1) & 0xff;
        if (w.idle[s] === 0) {
          track = WALK_IDLE_TRACK;
        } else if (legs.index[s] !== 0 && w.asked[s] === WALK_IDLE_TRACK) {
          w.idle[s] = 0;
          track = WALK_IDLE_TRACK;
        }
      }
    } else if (st < WALK_ARMS.length) {
      const a = WALK_ARMS[st];
      if (a.track >= 0) track = a.track;
      out.push = a.push;
      out.sideways = a.sideways;
      out.settle = a.settle;
      // 0x004444ff: the crouch's lowered pair, once.
      if (st === 9) w.flags[s] |= WALK_CROUCHED;
      if (a.lift !== 0) {
        // 0x00444529 / 0x004445a2 / 0x00444562: the take-off.
        out.lift = a.lift;
        out.impulse = true;
        w.state[s] = a.becomes;
        if (st === 0x0b) w.lunge[s] = WALK_LUNGE_COUNT;
      }
    }
    // 0x0c and anything above 0x12: the default arm, nothing.
  }
  // 0x0044470d: in states 1..4 without Jump a jink makes it the diagonal.
  out.diagonal = 0;
  const now = w.state[s];
  if (now >= 1 && now <= 4 && (bits & BTN_JUMP) === 0) {
    if ((bits & BTN_JINK_RIGHT) !== 0) out.diagonal = 1;
    else if ((bits & BTN_JINK_LEFT) !== 0) out.diagonal = -1;
  }
  out.turn = turn;
  w.stepTrack[s] = track;
  w.stepVariant[s] = variant;
}

/**
 * The step's surface (0x004449de..0x00444b48), from the movement's outcome:
 * `ledge` the slow row's hold put it back (states 1, 2 and 5: state 0, track
 * 0); else on the ground (`airborne` false) a walker without control lands --
 * the landing bit, and a `fall` (16.16 a step) over 0x50000 (0x80000 on a TOUGH
 * track) is an impact, state 0x12; off the ground it loses control. A sinking
 * walker is held to its own surface: neither (the caller skips it).
 */
export function walkerLand(
  w: WalkerState,
  s: number,
  airborne: boolean,
  fall: number,
  ledge: boolean,
): void {
  if (ledge) {
    const st = w.state[s];
    if (st === 1 || st === 2 || st === 5) {
      w.state[s] = 0;
      w.stepTrack[s] = 0;
    }
    return;
  }
  if (!airborne) {
    if ((w.flags[s] & WALK_AIRBORNE) !== 0) {
      w.flags[s] = (w.flags[s] & 0xfe) | WALK_LANDED;
      const limit =
        (trackFlags(w, s) & WALK_TRACK_TOUGH) !== 0 ? WALK_IMPACT_TOUGH : WALK_IMPACT_SOFT;
      if (fall > limit) w.state[s] = 0x12;
    }
  } else {
    w.flags[s] |= WALK_AIRBORNE;
  }
}

/** The legs' rate for `state` at `speed` (|v|, 16.16 a step) on ground mode `lean` (0x00444bb4). */
export function walkerRate(state: number, speed: number, lean: number): number {
  if (
    state === 0x0a ||
    state === 0x0f ||
    state === 0x0b ||
    state === 0x0c ||
    state === 0x12 ||
    state === 9 ||
    state === 0x11
  ) {
    return WALK_RATE_FIXED;
  }
  let rate = speed >> 8;
  if (lean !== 0) rate *= 4 - lean;
  if (state === 0x0e) return rate < WALK_RATE_LEAP ? WALK_RATE_LEAP : rate;
  if (state >= 1 && state <= 4) return rate < WALK_RATE_RUN ? WALK_RATE_RUN : rate;
  return rate < WALK_RATE_MIN ? WALK_RATE_MIN : rate;
}

/** The leap's track from the legs' frame (0x00444cf4). */
function leapTrack(frame: number): number {
  for (let k = 0; k < WALK_LEAP_FRAMES_B.length; k++) {
    const r = WALK_LEAP_FRAMES_B[k];
    if (frame >= r[0] && frame <= r[1]) return WALK_LEAP_TRACK_B;
  }
  return WALK_LEAP_TRACK;
}

/**
 * The second half of a walker step (0x00444b4f..0x00444e0c): the leap stays
 * airborne until it lands; the asked track starts if it is new (or the legs
 * fell back to track 0); the steep bit from the surface (`steep`); the third
 * continuation starts the leap on the ground (state 0x0d); the legs step at the
 * state's rate (`speed` |v| 16.16 a step, `lean` the ground's mode); their
 * codes go to the movement loop; a LAUNCH track moves the wind-ups on, and a
 * track that ends on track 0 ends the state.
 */
export function walkerLegs(
  w: WalkerState,
  s: number,
  speed: number,
  lean: number,
  steep: boolean,
): void {
  const legs = w.legs;
  const track = w.stepTrack[s];
  const variant = w.stepVariant[s];
  // 0x00444b4f: the leap is airborne until it lands.
  if (w.state[s] === 0x0e && (w.flags[s] & WALK_LANDED) === 0) w.flags[s] |= WALK_AIRBORNE;
  // 0x00444b7a
  if (track !== w.asked[s] || (legs.index[s] === 0 && track !== 0)) {
    animSetTrack(legs, s, track, 1, ANIM_STARTED);
    w.asked[s] = track;
  }
  const rate = walkerRate(w.state[s], speed, lean);
  // 0x00444cbb: the steep bit.
  w.flags[s] &= 0xbf;
  if (steep) w.flags[s] |= WALK_STEEP;
  // 0x00444cf4: the third continuation, on the ground, starts the leap.
  let follow = variant;
  if (variant === 2 && (w.flags[s] & WALK_AIRBORNE) === 0) {
    if ((w.flags[s] & WALK_STEEP) === 0) {
      animSetTrack(legs, s, leapTrack(legs.frame[s]), 1, ANIM_STARTED);
      w.flags[s] &= 0xcf;
      w.state[s] = 0x0d;
    }
    follow = 0;
  }
  const events = animStep(legs, s, rate, follow);
  const ended = events & 1;
  if (ended !== 0) w.flags[s] &= 0xef;
  else if (follow !== 0) w.flags[s] |= 8 << follow;
  pushCodes(w, s, events);
  // 0x00444db6: a LAUNCH track moves the wind-ups on.
  if ((trackFlags(w, s) & WALK_TRACK_LAUNCH) !== 0) {
    if (w.state[s] === 0x0a) w.state[s] = 0x0b;
    else if (w.state[s] === 0x0f) w.state[s] = 0x10;
  }
  // 0x00444de0: a track that ends on track 0 ends the state.
  if (legs.index[s] === 0 && ended !== 0) {
    w.state[s] = 0;
    pushCode(w, s, WALK_LOOP_STOP);
  }
}

/**
 * `player_snap_facing`'s target (0x004437d0, the jump table at 0x004438c4) for
 * `snap`'s low three bits, a wall kind, and `facing` (4096 a turn): the
 * direction that wall runs in -- kind 1 (a wall across the sim's y) 0, 0x800 or
 * 0x1000, kind 2 (across x) 0x400 or 0xc00, the diagonals' 3 and 4 the eighths
 * between; anything else 0. Not reduced modulo a turn (0x1000), and state 3's
 * low arm is -1, as retail has them.
 */
export function snapTarget(snap: number, facing: number): number {
  switch (snap & 7) {
    case 1:
      return facing < 0x400 ? 0 : facing <= 0xc00 ? 0x800 : 0x1000;
    case 2:
      return facing >= 0x800 ? 0xc00 : 0x400;
    case 3:
      return facing > 0xa00 ? 0xe00 : facing >= 0x200 ? 0x600 : -1;
    case 4:
      return facing < 0x600 ? 0x200 : facing <= 0xe00 ? 0xa00 : 0x1000;
    default:
      return 0;
  }
}

/**
 * The facing (0..0xfff) after `steps` calls of `player_snap_facing` for `snap`:
 * each moves it at most SNAP_STEP units toward its target, and the step masks
 * it into a turn after (0x00444462, 0x004427fa).
 */
export function snapFacing(snap: number, facing: number, steps: number): number {
  let f = facing;
  for (let k = 0; k < steps; k++) {
    let d = snapTarget(snap, f) - f;
    if (d > SNAP_STEP) d = SNAP_STEP;
    else if (d < -SNAP_STEP) d = -SNAP_STEP;
    f = (f + d) & 0xfff;
  }
  return f;
}

/**
 * The hover's command state (player_hover.c 0x0044255b..0x00442644), which its
 * tick writes into `state_bb` each frame: the brake 0x13 over the rows.
 */
export function hoverCommandState(bits: number): number {
  if ((bits & BTN_JUMP) !== 0) return 0x13;
  if ((bits & BTN_ACTION) !== 0) {
    if ((bits & BTN_FORWARD) !== 0) return 1;
    if ((bits & BTN_BACK) !== 0) return 2;
    if ((bits & BTN_JINK_RIGHT) !== 0) return 6;
    if ((bits & BTN_JINK_LEFT) !== 0) return 5;
    return 0;
  }
  if ((bits & BTN_FORWARD) !== 0) return 3;
  if ((bits & BTN_BACK) !== 0) return 4;
  if ((bits & BTN_JINK_RIGHT) !== 0) return 8;
  if ((bits & BTN_JINK_LEFT) !== 0) return 7;
  return 0;
}

/**
 * The bytes the hover's tick shares with the walker's: its command state, and
 * its surface (0x00442c7e..0x00442d3e) -- at its ride height (`grounded`) a
 * hover without control lands, over 0x50000 (`fall`, 16.16 a step) state
 * 0x12; held down within its band, nothing; above it (`airborne`) it loses
 * control. `ledge`: the slow row's ledge test ran (states 1 and 2 over the
 * band, 0x00442d1e), which leaves state 0 whether it held or not. What the
 * walker finds at the walker end.
 */
export function walkerHover(
  w: WalkerState,
  s: number,
  bits: number,
  grounded: boolean,
  airborne: boolean,
  fall: number,
  ledge = false,
): void {
  w.state[s] = hoverCommandState(bits);
  if (ledge) w.state[s] = 0;
  if (grounded) {
    if ((w.flags[s] & WALK_AIRBORNE) !== 0) {
      w.flags[s] = (w.flags[s] & 0xfe) | WALK_LANDED;
      if (fall > HOVER_IMPACT_HARD) w.state[s] = 0x12;
    }
  } else if (airborne) {
    w.flags[s] |= WALK_AIRBORNE;
  }
}

/**
 * The transform's ramp of both blocks (player.c 1442-1500) on a tick the lock
 * runs, `lock` ticks of it left (TRANSFORM_LOCK_TICKS down to 1) toward the
 * form `hover`: the request puts the legs on 0x0c and the cockpit on 2,
 * forward or backward; both step by the progress, 160 a clock unit; the hover
 * end holds legs 0x0d and cockpit 1, the walker end puts both on track 0.
 */
export function walkerRamp(w: WalkerState, s: number, hover: boolean, lock: number): void {
  const k = TRANSFORM_LOCK_TICKS - lock;
  const ramp = X1_RAMP_RATE * X1_UNITS_PER_TICK * (k + 1);
  if (w.form[s] === 0 || w.legs.index[s] !== X1_TRANSFORM_LEG_TRACK) {
    const dir = hover ? 1 : -1;
    animSetTrack(w.legs, s, X1_TRANSFORM_LEG_TRACK, dir, 0);
    animSetTrack(w.cockpit, s, X1_TRANSFORM_COCKPIT_TRACK, dir, 0);
  }
  w.form[s] = 1;
  if (hover && ramp > X1_RAMP_FULL) {
    // The hover end.
    animSetTrack(w.cockpit, s, X1_HOVER_COCKPIT_TRACK, 1, 0);
    animSetTrack(w.legs, s, X1_HOVER_LEG_TRACK, 1, 0);
  } else if (!hover && X1_RAMP_FULL - ramp < 0) {
    // The walker end: both blocks on track 0, the walker's tick from here on.
    animSetTrack(w.cockpit, s, 0, 1, 0);
    animSetTrack(w.legs, s, 0, 1, 0);
    w.form[s] = 0;
  } else {
    const progress = hover ? ramp : X1_RAMP_FULL - ramp;
    animStep(w.cockpit, s, progress, 0);
    animStep(w.legs, s, progress, 0);
  }
}
