// The sustained weapons' damage (fcop-fidelity.md W1; RE M3-OR,
// `disasm/map-open.md` "Flame, beam and shockwave: what spreads the damage").
//
// The Flamethrower (kind 0x0e), the Concussion Beam (0x11) and the Shockwave
// Generator (0x0f) hurt nothing when they fire: the original's damage comes from
// the effects they raise, and this module is those effects, as sim state.
//
// - A **trail** (the type-87 effect, `cact_effect_trail_tick` 0x00449430, and
//   the node it rides, `sustain.h`): a chain of nodes laid at an emission point
//   one per `spacing` the newest has flown from it, each flying at its own
//   velocity, ramping through three colour stages and given back when it and
//   the node before it are done, or when the chain is cut at a node.
//   - The Flamethrower's (`sustain_attached_fire` 0x0044ae10, its callback
//     0x0044afd0, `sustain_attached_sweep` 0x0044b2b0, `sustain_attached_touch`
//     0x0044b470): emitted at the muzzle while the trigger refreshes its 0x32
//     units, each new node flying at the lock's reference point (or ahead) at
//     2048 plus the mech's own forward speed. Each node not waiting hurts the
//     lock and every live body within 8 m of the shooter that it reaches,
//     then waits 10 trail ticks and ends the stream there. A terrain segment
//     between two nodes ends the stream.
//   - The Concussion Beam's (`sustain_aimed_fire` 0x0044b5b0, callback
//     0x0044b7b0, `sustain_aimed_sweep` 0x0044b880): emitted from the muzzle
//     where it fired along the aimed direction at 16384 for 0x96 units, cut
//     where it meets terrain, and hurting every live body near the segment
//     from its newest to its oldest node once per shot (ten at most,
//     `sustain_aimed_already_hit` 0x0044bee0), with its impact at the nearest
//     point (`sustain_aimed_impact` 0x0044be00 for terrain hits).
// - A **shell** (the type-92 effect, `cact_effect_type92_tick_chain`
//   0x00418860, `cact_effect_type92_blast` 0x00418b50, `cact_area_damage_band`
//   0x0042f3b0 / `cact_area_damage` 0x0042f170): a radius growing every pass,
//   blasting the band swept since its last blast on every fourth pass of the
//   frame loop, once more at its limit, and once when its colours have faded;
//   each body in the band takes `amount * (outer - d) / outer` from the current
//   outer radius, d the octagonal flat distance. The Shockwave raises one on the
//   mech (`sustain_launch_effect` 0x0044b570); the powered beam's impact
//   (record 107) is one too.
//
// The effect module ticks after every actor (`mission_effect_tick` 0x0042d6d0):
// first the shells, then every trail, then every trail's callback; an effect
// raised this frame is filed at its end and first ticked the next frame
// (0x0042d7df). Integer, in the original's units: positions in world units
// (8192 a metre; x, y up, z = the sim's x, height, y), widths and radii in
// sixteenths, time in engine units (10 a sim tick).
//
// Metropolis' own, said where it is done: the body's horizontal half-extent
// (`half_h`) is its hit radius (Metropolis carries `radius_68` only); terrain is
// the wall lattice (`segmentBlockT`), not the floors; own team and rounds are
// never hurt (no friendly fire); the trails and shells live in fixed pools.

import { ARCHETYPE } from "./archetypes";
import {
  BLAST_BAND_MARGIN,
  MAX_PLAYERS,
  MUZZLE_HEIGHT,
  MUZZLE_OFFSET,
  SHELL_BEAM_IMPACT_B,
  SHELL_FLAG_DOUBLE,
  SHELL_FLAG_NO_FLOOR,
  SHELL_SHOCKWAVE_A,
  SHELL_SHOCKWAVE_B,
  type ShellRecord,
  SUSTAIN_AIMED_UNITS,
  SUSTAIN_ATTACHED_UNITS,
  SUSTAIN_BEAM_BOX,
  SUSTAIN_HIT_SLOTS,
  SUSTAIN_IMPACT_WAIT,
  SUSTAIN_SHELLS,
  SUSTAIN_SWEEP_BOX,
  SUSTAIN_TOUCH_WAIT,
  SUSTAIN_TRAILS_PER_PLAYER,
  TRAIL_BEAM_A,
  TRAIL_BEAM_B,
  TRAIL_FLAME_A,
  TRAIL_FLAME_B,
  TRAIL_NODES,
  type TrailRecord,
  WEAPON_UNITS_PER_TICK,
  WU_PER_METRE,
} from "./balance";
import { segmentBlockT } from "./collision";
import { EV_EXPLOSION, pushEvent } from "./events";
import { fnv1aU32 } from "./hash";
import type { SimState } from "./sim";

/** What the module asks of the sim (sim.ts holds the damage bookkeeping and the bodies' sizes). */
export interface SustainHost {
  /** Damage `amount` to `target`, credited to `player` (an X1-Alpha's weapon). */
  hurt(state: SimState, target: number, amount: number, player: number): void;
  /** A body's hit radius, metres (`radius_68`). */
  radius(state: SimState, id: number): number;
  /** How far a body's reference point stands above its height, metres. */
  refHeight(state: SimState, id: number): number;
}

export const TRAIL_FLAME = 1;
export const TRAIL_BEAM = 2;

// A trail slot's flags.
/** SUSTAIN_EXPIRED: the countdown ran out (or the shooter went). */
const T_EXPIRED = 1;
/** CACT_TRAIL_FLAG_NO_HEAD: no more nodes (the countdown's mark, 0x0044a20d). */
const T_NO_HEAD = 2;
/** Raised this frame: filed at the frame's end, first ticked the next. */
const T_FRESH = 4;

// A shell's flags.
const S_USED = 1;
const S_FRESH = 2;
/** It rides its shooter (raised on the mech): the blast's centre is the mech's. */
const S_ATTACHED = 4;

/** The trail slots, MAX_PLAYERS * SUSTAIN_TRAILS_PER_PLAYER, and their nodes (TRAIL_NODES each). */
export interface SustainState {
  /** TRAIL_FLAME / TRAIL_BEAM, 0 free. */
  readonly kind: Uint8Array;
  readonly flags: Uint8Array;
  /** The trail record: 0 block A, 1 block B. */
  readonly powered: Uint8Array;
  readonly shooter: Int32Array;
  readonly team: Int32Array;
  /** The lock at the last call, -1 none (forgotten when it dies). */
  readonly target: Int32Array;
  /** Engine units left, counted only while not negative. */
  readonly countdown: Int32Array;
  readonly damage: Int32Array;
  /** The node's `point`, wu: the muzzle where it started (x, y, z). */
  readonly point: Int32Array;
  /** The flame's emission point this frame (its muzzle), wu. */
  readonly emit: Int32Array;
  /** The beam's node velocity, the halfwords (x, y, z). */
  readonly velocity: Int16Array;
  /** The beam's hit set and its count; its impact wait. */
  readonly hits: Int32Array;
  readonly hitCount: Uint8Array;
  readonly impactWait: Int8Array;
  /** Nodes in the chain; node 0 is the newest (the head). */
  readonly count: Uint8Array;
  readonly nPos: Int32Array;
  readonly nVel: Int16Array;
  readonly nHalf: Int16Array;
  readonly nStage: Uint8Array;
  readonly nRgb: Uint8Array;
  readonly nWait: Int8Array;
  /** The end bit (+0x18 bit 0): the chain is cut here on the next trail tick. */
  readonly nEnd: Uint8Array;
  // The shells.
  readonly sFlags: Uint8Array;
  /** Which record: index into SHELL_RECORDS. */
  readonly sRecord: Uint8Array;
  readonly sPlayer: Int8Array;
  readonly sShooter: Int32Array;
  readonly sTeam: Int32Array;
  readonly sAmount: Int32Array;
  /** +0x12, +0x9a, +0x68, +0x6a, +0x86: radius, the last blast's, growth, decay, intensity. */
  readonly sRadius: Int16Array;
  readonly sLast: Int16Array;
  readonly sGrowth: Int16Array;
  readonly sDecay: Int16Array;
  readonly sIntensity: Int16Array;
  /** The six colour bytes the fade empties. */
  readonly sRgb: Uint8Array;
  /** The centre, wu (a riding shell's is its shooter's position). */
  readonly sCentre: Int32Array;
}

const TRAIL_SLOTS = MAX_PLAYERS * SUSTAIN_TRAILS_PER_PLAYER;

export function createSustainState(): SustainState {
  const nodes = TRAIL_SLOTS * TRAIL_NODES;
  return {
    kind: new Uint8Array(TRAIL_SLOTS),
    flags: new Uint8Array(TRAIL_SLOTS),
    powered: new Uint8Array(TRAIL_SLOTS),
    shooter: new Int32Array(TRAIL_SLOTS),
    team: new Int32Array(TRAIL_SLOTS),
    target: new Int32Array(TRAIL_SLOTS),
    countdown: new Int32Array(TRAIL_SLOTS),
    damage: new Int32Array(TRAIL_SLOTS),
    point: new Int32Array(TRAIL_SLOTS * 3),
    emit: new Int32Array(TRAIL_SLOTS * 3),
    velocity: new Int16Array(TRAIL_SLOTS * 3),
    hits: new Int32Array(TRAIL_SLOTS * SUSTAIN_HIT_SLOTS),
    hitCount: new Uint8Array(TRAIL_SLOTS),
    impactWait: new Int8Array(TRAIL_SLOTS),
    count: new Uint8Array(TRAIL_SLOTS),
    nPos: new Int32Array(nodes * 3),
    nVel: new Int16Array(nodes * 3),
    nHalf: new Int16Array(nodes),
    nStage: new Uint8Array(nodes),
    nRgb: new Uint8Array(nodes * 3),
    nWait: new Int8Array(nodes),
    nEnd: new Uint8Array(nodes),
    sFlags: new Uint8Array(SUSTAIN_SHELLS),
    sRecord: new Uint8Array(SUSTAIN_SHELLS),
    sPlayer: new Int8Array(SUSTAIN_SHELLS),
    sShooter: new Int32Array(SUSTAIN_SHELLS),
    sTeam: new Int32Array(SUSTAIN_SHELLS),
    sAmount: new Int32Array(SUSTAIN_SHELLS),
    sRadius: new Int16Array(SUSTAIN_SHELLS),
    sLast: new Int16Array(SUSTAIN_SHELLS),
    sGrowth: new Int16Array(SUSTAIN_SHELLS),
    sDecay: new Int16Array(SUSTAIN_SHELLS),
    sIntensity: new Int16Array(SUSTAIN_SHELLS),
    sRgb: new Uint8Array(SUSTAIN_SHELLS * 6),
    sCentre: new Int32Array(SUSTAIN_SHELLS * 3),
  };
}

// --- The records, as the factories derive them ------------------------------

/** The frame's delta, engine units (10 at the lockstep's 30 fps). */
const DELTA = WEAPON_UNITS_PER_TICK;
/** `delta << 4` (0x0044943c). */
const DELTA16 = DELTA << 4;
/** The stage both a node and the node before it must read to be given back: 3 + 3 (0x0044984d). */
const STAGES = 3;

function i16(v: number): number {
  return (v << 16) >> 16;
}

/** `(span << 12) / ticks`, truncated, as a halfword (`trail_rate`, 0x00449e74). */
function trailRate(span: number, ticks: number): number {
  return i16(Math.trunc((span * 4096) / ticks));
}

/** A trail record's rates: three stages of three channels, and the width's. */
interface TrailDerived {
  readonly rec: TrailRecord;
  readonly rate: Int16Array;
  /** The half-width a node gains each pass: `width_rate * delta16 >> 12` (0x00449456). */
  readonly grow: number;
}

function deriveTrail(rec: TrailRecord): TrailDerived {
  const rate = new Int16Array(9);
  for (let k = 0; k < 3; k++) {
    const ticks = rec.stageLength[k];
    // A stage shorter than 0x10 gets zero rates (0x00449e52); the last fades to black.
    if (ticks < 0x10) continue;
    for (let c = 0; c < 3; c++) {
      const from = rec.rgb[k * 3 + c];
      const to = k === 2 ? 0 : rec.rgb[(k + 1) * 3 + c];
      rate[k * 3 + c] = trailRate(k === 2 ? -from : to - from, ticks);
    }
  }
  const total = i16(rec.stageLength[0] + rec.stageLength[1] + rec.stageLength[2]);
  const widthRate = total !== 0 ? trailRate(rec.widthGrowth, total) : total;
  return { rec, rate, grow: (widthRate * DELTA16) >> 12 };
}

/** The four trails, as `trailOf` indexes them: flame A, flame B, beam A, beam B. */
const TRAILS: readonly TrailDerived[] = [
  deriveTrail(TRAIL_FLAME_A),
  deriveTrail(TRAIL_FLAME_B),
  deriveTrail(TRAIL_BEAM_A),
  deriveTrail(TRAIL_BEAM_B),
];
/** The three shells a shell's `sRecord` names. */
const SHELL_RECORDS: readonly ShellRecord[] = [
  SHELL_SHOCKWAVE_A,
  SHELL_SHOCKWAVE_B,
  SHELL_BEAM_IMPACT_B,
];
const SHELL_SHOCKWAVE_A_INDEX = 0;
const SHELL_SHOCKWAVE_B_INDEX = 1;
const SHELL_BEAM_IMPACT_INDEX = 2;

function trailOf(state: SimState, slot: number): TrailDerived {
  const s = state.sustain;
  return TRAILS[(s.kind[slot] === TRAIL_BEAM ? 2 : 0) + s.powered[slot]];
}

// --- Fixed-point helpers ------------------------------------------------------

/** `math_fixed_mul`: the 16.16 product, floored (exact while |a * b| < 2^53). */
function fixedMul(a: number, b: number): number {
  return Math.floor((a * b) / 65536);
}

/** `vec_magnitude` (0x00457b10): max + (the other two) / 4. */
function magnitude(x: number, y: number, z: number): number {
  let a = x < 0 ? -x : x;
  let b = y < 0 ? -y : y;
  let c = z < 0 ? -z : z;
  if (a < b) {
    const t = a;
    a = b;
    b = t;
  }
  if (a < c) {
    const t = a;
    a = c;
    c = t;
  }
  return a + ((b + c) >> 2);
}

/** The squared length the touches compare: three `math_fixed_mul` squares. */
function squareSum(x: number, y: number, z: number): number {
  return fixedMul(x, x) + fixedMul(y, y) + fixedMul(z, z);
}

/** The beam's cut measure: `math_sqrt_16_16` of the squares, `>> 4` (0x0044b96c). */
function muzzleDistance(x: number, y: number, z: number): number {
  return Math.floor(Math.sqrt(squareSum(x, y, z) * 65536)) >> 4;
}

/** A metre value as world units. */
function wu(m: number): number {
  return Math.floor(m * WU_PER_METRE);
}

/** Scratch (no allocation per call): a body's reference point, wu. */
const refScratch = new Int32Array(3);

function refPoint(state: SimState, host: SustainHost, id: number): Int32Array {
  const ent = state.ent;
  refScratch[0] = wu(ent.posX[id]);
  refScratch[1] = wu(ent.height[id] + host.refHeight(state, id));
  refScratch[2] = wu(ent.posY[id]);
  return refScratch;
}

/** A body's `half_h` in sixteenths: Metropolis' hit radius stands in for it. */
function halfH(state: SimState, host: SustainHost, id: number): number {
  return Math.floor((host.radius(state, id) * WU_PER_METRE) / 16);
}

/** What the trails and shells may hurt: a live body of another side, not a round. */
function hurtable(state: SimState, id: number, team: number): boolean {
  const ent = state.ent;
  return ent.alive[id] !== 0 && ent.team[id] !== team && ent.archetype[id] !== ARCHETYPE.PROJECTILE;
}

/** The shooter is still there: alive and still its player's mech. */
function shooterLive(state: SimState, slotPlayer: number, shooter: number): boolean {
  return shooter >= 0 && state.ent.alive[shooter] !== 0 && state.avatarId[slotPlayer] === shooter;
}

/** The terrain trace between two points, wu: the wall lattice's t, -1 for none. */
function wallT(state: SimState, x0: number, z0: number, x1: number, z1: number): number {
  return segmentBlockT(
    state.map,
    x0 / WU_PER_METRE,
    z0 / WU_PER_METRE,
    x1 / WU_PER_METRE,
    z1 / WU_PER_METRE,
  );
}

// --- The trail slots ----------------------------------------------------------

function slotPlayer(slot: number): number {
  return Math.floor(slot / SUSTAIN_TRAILS_PER_PLAYER);
}

/** `sustain_*_find`: the player's live (not expired) sustain of `kind`, -1 none. */
function findLive(state: SimState, player: number, kind: number): number {
  const s = state.sustain;
  const base = player * SUSTAIN_TRAILS_PER_PLAYER;
  for (let k = 0; k < SUSTAIN_TRAILS_PER_PLAYER; k++) {
    const slot = base + k;
    if (s.kind[slot] === kind && (s.flags[slot] & T_EXPIRED) === 0) return slot;
  }
  return -1;
}

function freeSlot(state: SimState, player: number): number {
  const s = state.sustain;
  const base = player * SUSTAIN_TRAILS_PER_PLAYER;
  for (let k = 0; k < SUSTAIN_TRAILS_PER_PLAYER; k++) {
    if (s.kind[base + k] === 0) return base + k;
  }
  return -1;
}

function retire(state: SimState, slot: number): void {
  const s = state.sustain;
  s.kind[slot] = 0;
  s.flags[slot] = 0;
  s.count[slot] = 0;
}

/** Writes the muzzle of `shooter` (MUZZLE_OFFSET along its facing, MUZZLE_HEIGHT up) into `out[o..o+2]`, wu. */
function muzzle(state: SimState, shooter: number, out: Int32Array, o: number): void {
  const ent = state.ent;
  out[o] = wu(ent.posX[shooter] + ent.aimX[shooter] * MUZZLE_OFFSET);
  out[o + 1] = wu(ent.height[shooter] + MUZZLE_HEIGHT);
  out[o + 2] = wu(ent.posY[shooter] + ent.aimY[shooter] * MUZZLE_OFFSET);
}

/**
 * A new node at the head of the chain, at `p[o..o+2]` (`cact_trail_node_take`
 * and `cact_trail_node_init` 0x00449b90). False when the pool is empty.
 */
function layNode(
  state: SimState,
  host: SustainHost,
  slot: number,
  p: Int32Array,
  o: number,
): boolean {
  const s = state.sustain;
  const n = s.count[slot];
  if (n >= TRAIL_NODES) return false;
  const base = slot * TRAIL_NODES;
  // Shift the chain one down: node 0 is the newest.
  for (let i = n; i > 0; i--) copyNode(s, base + i - 1, base + i);
  s.count[slot] = n + 1;
  const d = trailOf(state, slot);
  const at = base;
  s.nPos[at * 3] = p[o];
  s.nPos[at * 3 + 1] = p[o + 1];
  s.nPos[at * 3 + 2] = p[o + 2];
  s.nHalf[at] = d.rec.headHalf;
  s.nStage[at] = 0;
  s.nRgb[at * 3] = d.rec.rgb[0];
  s.nRgb[at * 3 + 1] = d.rec.rgb[1];
  s.nRgb[at * 3 + 2] = d.rec.rgb[2];
  s.nWait[at] = 0;
  s.nEnd[at] = 0;
  if (s.kind[slot] === TRAIL_BEAM) {
    // The aimed callback answers nothing to the velocity question (its default,
    // 0x0044b870): the record's emission velocity, turned by the aimed frame.
    s.nVel[at * 3] = s.velocity[slot * 3];
    s.nVel[at * 3 + 1] = s.velocity[slot * 3 + 1];
    s.nVel[at * 3 + 2] = s.velocity[slot * 3 + 2];
  } else {
    flameVelocity(state, host, slot, at);
  }
  return true;
}

function copyNode(s: SustainState, from: number, to: number): void {
  s.nPos[to * 3] = s.nPos[from * 3];
  s.nPos[to * 3 + 1] = s.nPos[from * 3 + 1];
  s.nPos[to * 3 + 2] = s.nPos[from * 3 + 2];
  s.nVel[to * 3] = s.nVel[from * 3];
  s.nVel[to * 3 + 1] = s.nVel[from * 3 + 1];
  s.nVel[to * 3 + 2] = s.nVel[from * 3 + 2];
  s.nHalf[to] = s.nHalf[from];
  s.nStage[to] = s.nStage[from];
  s.nRgb[to * 3] = s.nRgb[from * 3];
  s.nRgb[to * 3 + 1] = s.nRgb[from * 3 + 1];
  s.nRgb[to * 3 + 2] = s.nRgb[from * 3 + 2];
  s.nWait[to] = s.nWait[from];
  s.nEnd[to] = s.nEnd[from];
}

/**
 * The flame node's velocity, the attached callback's answer (0x0044b113): the
 * direction from the new node to the lock's reference point at the trail's
 * speed (2048), or straight ahead with no lock, plus the mech's own speed along
 * its facing (`velocity_84 << 4` projected on the forward row, 0x0044b14a) --
 * `velocity_84` is the mech's speed in wu an engine unit (player_walk.c
 * 0x00444e3c), so a node keeps the mech's forward motion. Computed in world
 * axes: the model-frame round trip's fixed-point rounding is not reproduced.
 */
function flameVelocity(state: SimState, host: SustainHost, slot: number, at: number): void {
  const s = state.sustain;
  const ent = state.ent;
  const speed = trailOf(state, slot).rec.emitSpeed;
  const shooter = s.shooter[slot];
  const fx = ent.aimX[shooter];
  const fz = ent.aimY[shooter];
  let vx = 0;
  let vy = 0;
  let vz = 0;
  const target = s.target[slot];
  if (target >= 0) {
    const r = refPoint(state, host, target);
    const dx = r[0] - s.nPos[at * 3];
    const dy = r[1] - s.nPos[at * 3 + 1];
    const dz = r[2] - s.nPos[at * 3 + 2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len > 0) {
      vx = Math.trunc((dx / len) * speed);
      vy = Math.trunc((dy / len) * speed);
      vz = Math.trunc((dz / len) * speed);
    }
  } else {
    vx = Math.trunc(fx * speed);
    vz = Math.trunc(fz * speed);
  }
  const mvx = ent.velX[shooter];
  const mvz = ent.velY[shooter];
  const mspeed = Math.sqrt(mvx * mvx + mvz * mvz);
  const own = Math.floor((mspeed * WU_PER_METRE) / 300);
  if (own > 0) {
    const dot = Math.trunc(((mvx * fx + mvz * fz) / mspeed) * 65536);
    const forward = ((dot >> 4) * (own << 4)) >> 12;
    vx += Math.trunc(fx * forward);
    vz += Math.trunc(fz * forward);
  }
  s.nVel[at * 3] = i16(vx);
  s.nVel[at * 3 + 1] = i16(vy);
  s.nVel[at * 3 + 2] = i16(vz);
}

// --- Firing -------------------------------------------------------------------

/**
 * The Flamethrower's call, every tick its trigger fires (`sustain_attached_fire`
 * 0x0044ae10): the player's live sustain takes a new countdown (0x32) and the
 * current lock (0x0044afa7); with none, a new one starts at the muzzle, its
 * trail's first node laid there (the trail's construct, 0x0044a168), the
 * record's damage on it (0x0044af8e). A full pool raises nothing.
 */
export function flameFire(
  state: SimState,
  host: SustainHost,
  shooter: number,
  player: number,
  lock: number,
  damage: number,
  powered: boolean,
): void {
  const s = state.sustain;
  let slot = findLive(state, player, TRAIL_FLAME);
  if (slot >= 0) {
    s.countdown[slot] = SUSTAIN_ATTACHED_UNITS;
    s.target[slot] = lock;
    return;
  }
  slot = freeSlot(state, player);
  if (slot < 0) return;
  s.kind[slot] = TRAIL_FLAME;
  s.flags[slot] = T_FRESH;
  s.powered[slot] = powered ? 1 : 0;
  s.shooter[slot] = shooter;
  s.team[slot] = state.ent.team[shooter];
  s.target[slot] = lock;
  s.countdown[slot] = SUSTAIN_ATTACHED_UNITS;
  s.damage[slot] = damage;
  s.count[slot] = 0;
  muzzle(state, shooter, s.point, slot * 3);
  muzzle(state, shooter, s.emit, slot * 3);
  layNode(state, host, slot, s.point, slot * 3);
}

/**
 * The Concussion Beam's shot (`sustain_aimed_fire` 0x0044b5b0): a refresh of
 * the player's live sustain (0x96 units, the lock), or a new one at the muzzle
 * aimed along (dx, dy, dz) -- a unit vector, the caller's lead on the lock or
 * the facing -- its trail's nodes flying at the record's 16384 that way. Its hit
 * set starts empty (0x0044b77d).
 */
export function beamFire(
  state: SimState,
  host: SustainHost,
  shooter: number,
  player: number,
  lock: number,
  damage: number,
  powered: boolean,
  dx: number,
  dy: number,
  dz: number,
): void {
  const s = state.sustain;
  let slot = findLive(state, player, TRAIL_BEAM);
  if (slot >= 0) {
    s.countdown[slot] = SUSTAIN_AIMED_UNITS;
    s.target[slot] = lock;
    return;
  }
  slot = freeSlot(state, player);
  if (slot < 0) return;
  s.kind[slot] = TRAIL_BEAM;
  s.flags[slot] = T_FRESH;
  s.powered[slot] = powered ? 1 : 0;
  s.shooter[slot] = shooter;
  s.team[slot] = state.ent.team[shooter];
  s.target[slot] = lock;
  s.countdown[slot] = SUSTAIN_AIMED_UNITS;
  s.damage[slot] = damage;
  s.hitCount[slot] = 0;
  s.impactWait[slot] = 0;
  s.count[slot] = 0;
  const speed = TRAILS[2 + s.powered[slot]].rec.emitSpeed;
  s.velocity[slot * 3] = i16(Math.trunc(dx * speed));
  s.velocity[slot * 3 + 1] = i16(Math.trunc(dy * speed));
  s.velocity[slot * 3 + 2] = i16(Math.trunc(dz * speed));
  muzzle(state, shooter, s.point, slot * 3);
  layNode(state, host, slot, s.point, slot * 3);
}

/** A shell from the pool, -1 when full. */
function raiseShell(
  state: SimState,
  record: number,
  player: number,
  shooter: number,
  team: number,
  x: number,
  y: number,
  z: number,
  radius: number,
  amount: number,
): number {
  const s = state.sustain;
  let k = -1;
  for (let i = 0; i < SUSTAIN_SHELLS; i++) {
    if (s.sFlags[i] === 0) {
      k = i;
      break;
    }
  }
  if (k < 0) return -1;
  const rec = SHELL_RECORDS[record];
  s.sFlags[k] = S_USED | S_FRESH | (shooter >= 0 ? S_ATTACHED : 0);
  s.sRecord[k] = record;
  s.sPlayer[k] = player;
  s.sShooter[k] = shooter;
  s.sTeam[k] = team;
  s.sAmount[k] = amount;
  s.sRadius[k] = i16(radius);
  // The construct (0x004198ca): the intensity, and the first band from the start radius.
  s.sLast[k] = i16(radius);
  s.sGrowth[k] = i16(rec.growth);
  s.sDecay[k] = i16(rec.decay);
  for (let c = 0; c < 6; c++) s.sRgb[k * 6 + c] = rec.rgb[c];
  s.sIntensity[k] = intensity(rec);
  s.sCentre[k * 3] = x;
  s.sCentre[k * 3 + 1] = y;
  s.sCentre[k * 3 + 2] = z;
  return k;
}

/**
 * `cact_effect_type92_intensity` (0x004199d0): the fade's rate, `((0x80000000 /
 * (param * 2400)) >> 4) * brightest >> 4`, as a word; under 0x10 it is 0.
 */
function intensity(rec: ShellRecord): number {
  const param = i16(rec.fade);
  if (param < 0x10) return 0;
  let bright = 0;
  for (let c = 0; c < 6; c++) if (rec.rgb[c] > bright) bright = rec.rgb[c];
  const divisor = ((param * 75) << 6) >> 1;
  const recip = Math.floor(0x80000000 / divisor);
  return i16(((recip >>> 4) * bright) >>> 4);
}

/**
 * The Shockwave's shot (`sustain_launch_effect` 0x0044b570): its block's
 * shell on the mech, the block's damage written into its amount (0x0044b5a5).
 * The start radius is Metropolis' (balance.ts SHOCKWAVE_START_RADIUS).
 */
export function shockwaveFire(
  state: SimState,
  shooter: number,
  player: number,
  damage: number,
  powered: boolean,
  startRadius: number,
): void {
  const ent = state.ent;
  raiseShell(
    state,
    powered ? SHELL_SHOCKWAVE_B_INDEX : SHELL_SHOCKWAVE_A_INDEX,
    player,
    shooter,
    ent.team[shooter],
    wu(ent.posX[shooter]),
    wu(ent.height[shooter]),
    wu(ent.posY[shooter]),
    startRadius,
    damage,
  );
}

// --- The frame ----------------------------------------------------------------

/**
 * The effect module's frame for the sustained weapons: what the original's
 * `mission_effect_tick` does to them, in its order -- forget dead locks and
 * shooters (`sustain_attached_prune` 0x0044c520 / `sustain_aimed_prune`
 * 0x0044c580, from `sustain_frame`), the shells
 * (0x00418860), every trail's tick (0x00449430), every trail's callback (the
 * countdown and the sweep), then file what this frame raised.
 */
export function systemSustain(state: SimState, host: SustainHost, projBeam: number): void {
  const s = state.sustain;
  for (let slot = 0; slot < TRAIL_SLOTS; slot++) {
    if (s.kind[slot] === 0) continue;
    const t = s.target[slot];
    if (t >= 0 && state.ent.alive[t] === 0) s.target[slot] = -1;
  }
  for (let k = 0; k < SUSTAIN_SHELLS; k++) {
    if ((s.sFlags[k] & (S_USED | S_FRESH)) === S_USED) shellTick(state, host, k);
  }
  for (let slot = 0; slot < TRAIL_SLOTS; slot++) {
    if (s.kind[slot] === 0 || (s.flags[slot] & T_FRESH) !== 0) continue;
    trailTick(state, host, slot);
  }
  for (let slot = 0; slot < TRAIL_SLOTS; slot++) {
    if (s.kind[slot] === 0 || (s.flags[slot] & T_FRESH) !== 0) continue;
    if (s.kind[slot] === TRAIL_FLAME) flameStep(state, host, slot);
    else beamStep(state, host, slot, projBeam);
  }
  // The drain (0x0042d7df): what was raised this frame is ticked from the next.
  for (let slot = 0; slot < TRAIL_SLOTS; slot++) s.flags[slot] &= ~T_FRESH;
  for (let k = 0; k < SUSTAIN_SHELLS; k++) s.sFlags[k] &= ~S_FRESH;
}

/** `cact_trail_node_ramp` (0x004498d0): one channel toward its stage's goal; true on arrival. */
function rampChannel(s: SustainState, i: number, step: number, to: number): boolean {
  const v = s.nRgb[i];
  if (step > 0) {
    if (step + v < to) {
      s.nRgb[i] = v + step;
      return false;
    }
    s.nRgb[i] = to;
    return true;
  }
  if (step < 0) {
    if (step + v > to) {
      s.nRgb[i] = v + step;
      return false;
    }
    s.nRgb[i] = to;
    return true;
  }
  return true;
}

/**
 * `cact_effect_trail_tick` (0x00449430) for one trail: new nodes at the
 * emission point, one per `spacing` sixteenths the head is from it (a 16-bit
 * count, 0x00449625), unless the countdown's mark stopped them; then every
 * node, newest first: its wait counted down, the end bit cutting it and every
 * older node (0x00449683), the colour ramp, the width, the move `(v * (delta <<
 * 4)) >> 8` (0x004497f0), and the node given back once it and the node before
 * it are both done (0x0044984d). An emptied chain retires (RETIRE_EMPTY, which
 * both sustains raise).
 */
function trailTick(state: SimState, host: SustainHost, slot: number): void {
  const s = state.sustain;
  if (s.count[slot] === 0) {
    retire(state, slot);
    return;
  }
  const d = trailOf(state, slot);
  const base = slot * TRAIL_NODES;
  // The emission point: the flame's rides the mech's muzzle; the beam's stays
  // where it was placed.
  const flame = s.kind[slot] === TRAIL_FLAME;
  const shooter = s.shooter[slot];
  if (flame && shooterLive(state, slotPlayer(slot), shooter))
    muzzle(state, shooter, s.emit, slot * 3);
  const pts = flame ? s.emit : s.point;
  if ((s.flags[slot] & T_NO_HEAD) === 0) {
    const h = base * 3;
    let left = i16(
      magnitude(
        pts[slot * 3] - s.nPos[h],
        pts[slot * 3 + 1] - s.nPos[h + 1],
        pts[slot * 3 + 2] - s.nPos[h + 2],
      ) >> 4,
    );
    while (left >= d.rec.spacing) {
      left = i16(left - d.rec.spacing);
      layNode(state, host, slot, pts, slot * 3);
    }
  }
  const n = s.count[slot];
  let lastStage = STAGES;
  let cut = false;
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const at = base + i;
    if (s.nWait[at] > 0) {
      s.nWait[at] -= 1;
      if (s.nWait[at] <= 0) s.nEnd[at] = 1;
    }
    if (s.nEnd[at] !== 0) cut = true;
    const stage = s.nStage[at];
    if (stage < STAGES) {
      let arrived = 0;
      for (let c = 0; c < 3; c++) {
        const step = (d.rate[stage * 3 + c] * DELTA) >> 8;
        const to = stage === 2 ? 0 : d.rec.rgb[(stage + 1) * 3 + c];
        if (rampChannel(s, at * 3 + c, step, to)) arrived++;
      }
      if (arrived === 3) {
        const now = stage + 1;
        s.nStage[at] = now;
        if (now < STAGES) {
          s.nRgb[at * 3] = d.rec.rgb[now * 3];
          s.nRgb[at * 3 + 1] = d.rec.rgb[now * 3 + 1];
          s.nRgb[at * 3 + 2] = d.rec.rgb[now * 3 + 2];
        }
      }
    }
    s.nHalf[at] = i16(s.nHalf[at] + d.grow);
    s.nPos[at * 3] += (s.nVel[at * 3] * DELTA16) >> 8;
    s.nPos[at * 3 + 1] += (s.nVel[at * 3 + 1] * DELTA16) >> 8;
    s.nPos[at * 3 + 2] += (s.nVel[at * 3 + 2] * DELTA16) >> 8;
    const now = s.nStage[at];
    if (!cut && lastStage + now !== STAGES * 2) {
      if (kept !== i) copyNode(s, at, base + kept);
      kept++;
    }
    lastStage = now;
  }
  s.count[slot] = kept;
  if (kept === 0) retire(state, slot);
}

/**
 * The attached callback's step (0x0044b06f): the countdown, counted while not
 * negative; the pass that takes it below zero marks the trail (no more nodes)
 * and sweeps nothing; a gone shooter retires the trail; otherwise the sweep.
 */
function flameStep(state: SimState, host: SustainHost, slot: number): void {
  const s = state.sustain;
  if (s.countdown[slot] >= 0) {
    s.countdown[slot] -= DELTA;
    if (s.countdown[slot] < 0) {
      s.flags[slot] |= T_EXPIRED | T_NO_HEAD;
      return;
    }
  }
  if (!shooterLive(state, slotPlayer(slot), s.shooter[slot])) {
    retire(state, slot);
    return;
  }
  flameSweep(state, host, slot);
}

/**
 * `sustain_attached_sweep` (0x0044b2b0): every node, newest first. One whose
 * wait is not positive is asked about the lock and then about every live body
 * within SUSTAIN_SWEEP_BOX of the shooter's reference point on every axis -- the
 * lock among them again: retail does not skip it, and the wait is read once
 * before both (0x0044b2f0), so a node that reaches the lock hurts it twice.
 * Then the segment from the node before it (the sustain's `point` for the
 * newest) is traced; a hit marks this node's end bit and stops the walk.
 */
function flameSweep(state: SimState, host: SustainHost, slot: number): void {
  const s = state.sustain;
  const ent = state.ent;
  const base = slot * TRAIL_NODES;
  const n = s.count[slot];
  const shooter = s.shooter[slot];
  const team = s.team[slot];
  const player = slotPlayer(slot);
  const sr = refPoint(state, host, shooter);
  const sx = sr[0];
  const sy = sr[1];
  const sz = sr[2];
  let px = s.point[slot * 3];
  let pz = s.point[slot * 3 + 2];
  for (let i = 0; i < n; i++) {
    const at = base + i;
    if (s.nWait[at] <= 0) {
      const target = s.target[slot];
      if (target >= 0) flameTouch(state, host, slot, at, target, player);
      for (let t = 0; t < ent.high; t++) {
        if (t === shooter || !hurtable(state, t, team)) continue;
        const r = refPoint(state, host, t);
        if (Math.abs(r[0] - sx) >= SUSTAIN_SWEEP_BOX) continue;
        if (Math.abs(r[1] - sy) >= SUSTAIN_SWEEP_BOX) continue;
        if (Math.abs(r[2] - sz) >= SUSTAIN_SWEEP_BOX) continue;
        flameTouch(state, host, slot, at, t, player);
      }
    }
    const nx = s.nPos[at * 3];
    const nz = s.nPos[at * 3 + 2];
    if (wallT(state, px, pz, nx, nz) >= 0) {
      // The impact (record 42/47, a particle emitter) hurts nothing.
      s.nEnd[at] = 1;
      return;
    }
    px = nx;
    pz = nz;
  }
}

/**
 * `sustain_attached_touch` (0x0044b470): within `(half_10 + half_h) * 16` of the
 * body's reference point (the squares compared `>> 16` and `>> 8`, the
 * boundary out), the node's damage, and the node waits SUSTAIN_TOUCH_WAIT.
 */
function flameTouch(
  state: SimState,
  host: SustainHost,
  slot: number,
  at: number,
  t: number,
  player: number,
): void {
  const s = state.sustain;
  if (!hurtable(state, t, s.team[slot])) return;
  const r = refPoint(state, host, t);
  const dist = squareSum(
    s.nPos[at * 3] - r[0],
    s.nPos[at * 3 + 1] - r[1],
    s.nPos[at * 3 + 2] - r[2],
  );
  const reach = s.nHalf[at] + halfH(state, host, t);
  if (dist >= (reach * reach) >> 8) return;
  host.hurt(state, t, s.damage[slot], player);
  s.nWait[at] = SUSTAIN_TOUCH_WAIT;
}

/**
 * The aimed callback's step (0x0044b80f): the countdown as the attached one's,
 * but nothing returns early -- it marks the trail and still sweeps; a gone
 * shooter retires it after this frame's sweep.
 */
function beamStep(state: SimState, host: SustainHost, slot: number, projBeam: number): void {
  const s = state.sustain;
  if (s.countdown[slot] >= 0) {
    s.countdown[slot] -= DELTA;
    if (s.countdown[slot] < 0) s.flags[slot] |= T_EXPIRED | T_NO_HEAD;
  }
  const gone = !shooterLive(state, slotPlayer(slot), s.shooter[slot]);
  if (gone) s.flags[slot] |= T_EXPIRED;
  beamSweep(state, host, slot, projBeam);
  if (gone) retire(state, slot);
}

/** Scratch: the beam's terrain hit, its segment's direction and the nearest point, wu. */
const hitScratch = new Int32Array(3);
const dirScratch = new Int32Array(3);
const nearScratch = new Int32Array(3);

/**
 * `sustain_aimed_impact` (0x0044be00): one call in six raises the impact (the
 * first at once); block B's (record 107) is a 50-point shell credited to the
 * shooter's player, block A's (102) carries nothing.
 */
function beamImpact(
  state: SimState,
  slot: number,
  x: number,
  y: number,
  z: number,
  projBeam: number,
) {
  const s = state.sustain;
  const wait = s.impactWait[slot] - 1;
  s.impactWait[slot] = wait;
  if (wait >= 0) return;
  raiseImpact(state, slot, x, y, z, projBeam);
  s.impactWait[slot] = SUSTAIN_IMPACT_WAIT;
}

function raiseImpact(
  state: SimState,
  slot: number,
  x: number,
  y: number,
  z: number,
  projBeam: number,
) {
  const s = state.sustain;
  pushEvent(
    state.events,
    EV_EXPLOSION,
    Math.floor((x * 16) / WU_PER_METRE),
    Math.floor((z * 16) / WU_PER_METRE),
    projBeam,
  );
  if (s.powered[slot] === 0) return;
  // Record 107's start radius is 0, so the impact context's scale does not
  // reach it; its amount is the record's own.
  raiseShell(
    state,
    SHELL_BEAM_IMPACT_INDEX,
    slotPlayer(slot),
    -1,
    s.team[slot],
    x,
    y,
    z,
    SHELL_BEAM_IMPACT_B.start,
    SHELL_BEAM_IMPACT_B.amount,
  );
}

/**
 * `sustain_aimed_sweep` (0x0044b880): the beam traced from its `point` to its
 * oldest node and cut where it meets terrain -- a hit nearer than the head
 * moves the head there (an expired beam just ends there) and touches nothing
 * this frame; a farther one moves the node the spacing puts just past it there
 * and ends the chain behind it -- then every live body near the segment from
 * the head to the end, while that segment is under SUSTAIN_BEAM_BOX on every
 * axis, is hurt once a shot (the hit set) at the segment's nearest point.
 */
function beamSweep(state: SimState, host: SustainHost, slot: number, projBeam: number): void {
  const s = state.sustain;
  const ent = state.ent;
  const n = s.count[slot];
  if (n === 0) return;
  const base = slot * TRAIL_NODES;
  const head = base;
  let end = base + n - 1;
  const px = s.point[slot * 3];
  const py = s.point[slot * 3 + 1];
  const pz = s.point[slot * 3 + 2];
  const expired = (s.flags[slot] & T_EXPIRED) !== 0;
  const spacing = trailOf(state, slot).rec.spacing;
  // The trace: the wall lattice's t along the segment, the hit by lerp.
  const ex = s.nPos[end * 3];
  const ey = s.nPos[end * 3 + 1];
  const ez = s.nPos[end * 3 + 2];
  const t = wallT(state, px, pz, ex, ez);
  if (t >= 0) {
    hitScratch[0] = Math.floor(px + (ex - px) * t);
    hitScratch[1] = Math.floor(py + (ey - py) * t);
    hitScratch[2] = Math.floor(pz + (ez - pz) * t);
    if (n === 1) {
      if (expired) s.nEnd[head] = 1;
      else setNodePos(s, head, hitScratch);
      beamImpact(state, slot, hitScratch[0], hitScratch[1], hitScratch[2], projBeam);
    } else {
      const beyond =
        muzzleDistance(hitScratch[0] - px, hitScratch[1] - py, hitScratch[2] - pz) -
        muzzleDistance(s.nPos[head * 3] - px, s.nPos[head * 3 + 1] - py, s.nPos[head * 3 + 2] - pz);
      if (beyond < 0) {
        if (expired) {
          s.nEnd[head] = 1;
          return;
        }
        setNodePos(s, head, hitScratch);
        s.nEnd[head + 1] = 1;
        beamImpact(state, slot, hitScratch[0], hitScratch[1], hitScratch[2], projBeam);
        return;
      }
      let i = 0;
      let left = beyond;
      let found = true;
      while (left >= 0) {
        i++;
        left -= spacing;
        if (i >= n) {
          found = false;
          break;
        }
      }
      if (found) {
        end = base + i;
        if (i + 1 < n) {
          s.nEnd[end + 1] = 1;
          beamImpact(state, slot, hitScratch[0], hitScratch[1], hitScratch[2], projBeam);
        }
        setNodePos(s, end, hitScratch);
      }
    }
  }
  if (end === head) return;
  const hx = s.nPos[head * 3];
  const hy = s.nPos[head * 3 + 1];
  const hz = s.nPos[head * 3 + 2];
  const ex2 = s.nPos[end * 3];
  const ey2 = s.nPos[end * 3 + 1];
  const ez2 = s.nPos[end * 3 + 2];
  const sdx = ex2 - hx;
  const sdy = ey2 - hy;
  const sdz = ez2 - hz;
  if (
    Math.abs(sdx) >= SUSTAIN_BEAM_BOX ||
    Math.abs(sdy) >= SUSTAIN_BEAM_BOX ||
    Math.abs(sdz) >= SUSTAIN_BEAM_BOX
  ) {
    return;
  }
  const len = Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz);
  if (!(len > 0)) return;
  // `vec3_normalise`: the 16.16 unit vector (its rsqrt table's rounding not reproduced).
  dirScratch[0] = Math.trunc((sdx / len) * 65536);
  dirScratch[1] = Math.trunc((sdy / len) * 65536);
  dirScratch[2] = Math.trunc((sdz / len) * 65536);
  const shooter = s.shooter[slot];
  const team = s.team[slot];
  const endHalf = s.nHalf[end];
  for (let a = 0; a < ent.high; a++) {
    if (a === shooter || !hurtable(state, a, team)) continue;
    const reach = halfH(state, host, a) + endHalf;
    const limit = (reach * reach) >> 8;
    const r = refPoint(state, host, a);
    let ox = r[0] - ex2;
    let oy = r[1] - ey2;
    let oz = r[2] - ez2;
    const along =
      fixedMul(ox, dirScratch[0]) + fixedMul(oy, dirScratch[1]) + fixedMul(oz, dirScratch[2]);
    if (along >= 0) {
      nearScratch[0] = ex2;
      nearScratch[1] = ey2;
      nearScratch[2] = ez2;
    } else {
      const back =
        fixedMul(r[0] - hx, dirScratch[0]) +
        fixedMul(r[1] - hy, dirScratch[1]) +
        fixedMul(r[2] - hz, dirScratch[2]);
      if (back <= 0) continue;
      nearScratch[0] = fixedMul(dirScratch[0], along) + ex2;
      nearScratch[1] = fixedMul(dirScratch[1], along) + ey2;
      nearScratch[2] = fixedMul(dirScratch[2], along) + ez2;
      ox = r[0] - nearScratch[0];
      oy = r[1] - nearScratch[1];
      oz = r[2] - nearScratch[2];
    }
    if (squareSum(ox, oy, oz) >= limit) continue;
    if (alreadyHit(s, slot, a)) continue;
    host.hurt(state, a, s.damage[slot], slotPlayer(slot));
    raiseImpact(state, slot, nearScratch[0], nearScratch[1], nearScratch[2], projBeam);
  }
}

function setNodePos(s: SustainState, at: number, p: Int32Array): void {
  s.nPos[at * 3] = p[0];
  s.nPos[at * 3 + 1] = p[1];
  s.nPos[at * 3 + 2] = p[2];
}

/** `sustain_aimed_already_hit` (0x0044bee0): a full set answers yes; else the body is added. */
function alreadyHit(s: SustainState, slot: number, id: number): boolean {
  const count = s.hitCount[slot];
  if (count >= SUSTAIN_HIT_SLOTS) return true;
  const base = slot * SUSTAIN_HIT_SLOTS;
  for (let i = 0; i < count; i++) if (s.hits[base + i] === id) return true;
  s.hits[base + count] = id;
  s.hitCount[slot] = count + 1;
  return false;
}

// --- The shells ---------------------------------------------------------------

/**
 * `cact_effect_type92_tick_chain` (0x00418860) for one shell: the colour fade
 * (all six bytes emptied: a blast and retire, 0x0041898f), the growth
 * (0x00418a28), the growth's decay (0x00418ac5), the pulse -- a blast on every
 * fourth pass of the frame loop (0x00418af9: the sim's tick stands for the
 * loop's pass count) -- and the limit: a last blast unless the last one used
 * this radius, and retire (0x00418b10). Nothing returns early.
 */
function shellTick(state: SimState, host: SustainHost, k: number): void {
  const s = state.sustain;
  const rec = SHELL_RECORDS[s.sRecord[k]];
  let retireIt = false;
  if ((rec.flags & 1) === 0 && s.sIntensity[k] !== 0) {
    const step = (DELTA * s.sIntensity[k]) >> 8;
    let emptied = 0;
    for (let c = 0; c < 6; c++) {
      const i = k * 6 + c;
      if (step > s.sRgb[i]) {
        s.sRgb[i] = 0;
        emptied++;
      } else {
        s.sRgb[i] = (s.sRgb[i] - step) & 0xff;
      }
    }
    if (emptied === 6) {
      if (s.sAmount[k] !== 0) shellBlast(state, host, k);
      retireIt = true;
    }
  }
  s.sRadius[k] = i16(s.sRadius[k] + ((DELTA * s.sGrowth[k]) >> 8));
  if (s.sDecay[k] > 0) {
    s.sGrowth[k] = i16(s.sGrowth[k] - ((DELTA * s.sDecay[k]) >> 7));
    if (s.sGrowth[k] < 0x1000) {
      s.sGrowth[k] = 0x1000;
      s.sDecay[k] = 0;
    }
  }
  if (s.sAmount[k] !== 0 && (state.tick & 3) === 3) shellBlast(state, host, k);
  const radius = s.sRadius[k];
  if (radius >= i16(rec.limit)) {
    if (s.sAmount[k] !== 0 && s.sLast[k] !== radius) shellBlast(state, host, k);
    retireIt = true;
  }
  if (retireIt) s.sFlags[k] = 0;
}

/**
 * The band arm of `cact_effect_type92_blast` (0x00418c23): `cact_area_damage_band`
 * over [last << 4, (radius + thickness) << 4), the thickness doubled with
 * SHELL_FLAG_DOUBLE, gated vertically on the body's reference point (no floor
 * with SHELL_FLAG_NO_FLOOR); each body `amount * (outer - d) / outer` as
 * `cact_area_damage` (0x0042f170) forms it, d the octagonal flat distance
 * (`vec_distance_xz` 0x00458000) to the body's position. The radius it reached
 * becomes the next band's inner edge.
 */
function shellBlast(state: SimState, host: SustainHost, k: number): void {
  const s = state.sustain;
  const ent = state.ent;
  const rec = SHELL_RECORDS[s.sRecord[k]];
  const shooter = s.sShooter[k];
  if ((s.sFlags[k] & S_ATTACHED) !== 0 && shooterLive(state, s.sPlayer[k], shooter)) {
    s.sCentre[k * 3] = wu(ent.posX[shooter]);
    s.sCentre[k * 3 + 1] = wu(ent.height[shooter]);
    s.sCentre[k * 3 + 2] = wu(ent.posY[shooter]);
  }
  const cx = s.sCentre[k * 3];
  const cy = s.sCentre[k * 3 + 1];
  const cz = s.sCentre[k * 3 + 2];
  const thickness = (rec.flags & SHELL_FLAG_DOUBLE) !== 0 ? 2 * rec.thickness : rec.thickness;
  const outer = (s.sRadius[k] + thickness) << 4;
  const inner = s.sLast[k] << 4;
  const noFloor = (rec.flags & SHELL_FLAG_NO_FLOOR) !== 0;
  s.sLast[k] = s.sRadius[k];
  if (outer >> 1 <= 0) return;
  // `(amount << 16) / radius` in 16.16 through the reciprocal of `radius >> 1`.
  // `(amount << 16) * (0x80000000 / (radius >> 1)) >> 16` (0x0042f184).
  const falloff = s.sAmount[k] * Math.floor(0x80000000 / (outer >> 1));
  const team = s.sTeam[k];
  const player = s.sPlayer[k];
  for (let t = 0; t < ent.high; t++) {
    if (!hurtable(state, t, team)) continue;
    let dx = wu(ent.posX[t]) - cx;
    let dz = wu(ent.posY[t]) - cz;
    if (dx < 0) dx = -dx;
    if (dz < 0) dz = -dz;
    const d = dx + dz - ((dx < dz ? dx : dz) >> 1);
    if (d >= outer || d < inner) continue;
    const ry = wu(ent.height[t] + host.refHeight(state, t));
    const r68 = wu(host.radius(state, t));
    if (ry + r68 + BLAST_BAND_MARGIN < cy) continue;
    if (!noFloor && ry - r68 - BLAST_BAND_MARGIN > cy) continue;
    const damage = Math.floor(Math.floor(((outer - d) * falloff) / 65536) / 65536);
    if (damage !== 0) host.hurt(state, t, damage, player);
  }
}

// --- The hash -----------------------------------------------------------------

/**
 * Folds every live trail (and its nodes) and every live shell into `h`, in slot
 * order. Nothing live, nothing folded: a match that never fires the three hashes
 * as before them.
 */
export function hashSustain(state: SimState, h0: number): number {
  const s = state.sustain;
  let h = h0;
  for (let slot = 0; slot < TRAIL_SLOTS; slot++) {
    if (s.kind[slot] === 0) continue;
    h = fnv1aU32(h, slot | (s.kind[slot] << 8) | (s.flags[slot] << 16) | (s.powered[slot] << 24));
    h = fnv1aU32(h, s.shooter[slot] >>> 0);
    h = fnv1aU32(h, s.target[slot] >>> 0);
    h = fnv1aU32(h, s.countdown[slot] >>> 0);
    h = fnv1aU32(h, s.damage[slot] >>> 0);
    for (let c = 0; c < 3; c++) {
      h = fnv1aU32(h, s.point[slot * 3 + c] >>> 0);
      h = fnv1aU32(h, s.emit[slot * 3 + c] >>> 0);
      h = fnv1aU32(h, s.velocity[slot * 3 + c] & 0xffff);
    }
    h = fnv1aU32(h, s.hitCount[slot] | ((s.impactWait[slot] & 0xff) << 8) | (s.count[slot] << 16));
    for (let i = 0; i < s.hitCount[slot]; i++) {
      h = fnv1aU32(h, s.hits[slot * SUSTAIN_HIT_SLOTS + i] >>> 0);
    }
    const base = slot * TRAIL_NODES;
    for (let i = 0; i < s.count[slot]; i++) {
      const at = base + i;
      for (let c = 0; c < 3; c++) {
        h = fnv1aU32(h, s.nPos[at * 3 + c] >>> 0);
        h = fnv1aU32(h, (s.nVel[at * 3 + c] & 0xffff) | (s.nRgb[at * 3 + c] << 16));
      }
      h = fnv1aU32(
        h,
        (s.nHalf[at] & 0xffff) |
          (s.nStage[at] << 16) |
          ((s.nWait[at] & 0x7f) << 24) |
          (s.nEnd[at] << 31),
      );
    }
  }
  for (let k = 0; k < SUSTAIN_SHELLS; k++) {
    if (s.sFlags[k] === 0) continue;
    h = fnv1aU32(h, k | (s.sFlags[k] << 8) | (s.sRecord[k] << 16) | ((s.sPlayer[k] & 0xff) << 24));
    h = fnv1aU32(h, s.sShooter[k] >>> 0);
    h = fnv1aU32(h, s.sAmount[k] >>> 0);
    h = fnv1aU32(h, (s.sRadius[k] & 0xffff) | (s.sLast[k] << 16));
    h = fnv1aU32(h, (s.sGrowth[k] & 0xffff) | (s.sDecay[k] << 16));
    h = fnv1aU32(h, s.sIntensity[k] & 0xffff);
    for (let c = 0; c < 6; c++) h = fnv1aU32(h, s.sRgb[k * 6 + c]);
    for (let c = 0; c < 3; c++) h = fnv1aU32(h, s.sCentre[k * 3 + c] >>> 0);
  }
  return h;
}
