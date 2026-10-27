// The original's route followers on the Cnet road graph (fcop-fidelity.md U1/U2;
// fcop-re/ai-and-rules.md §4): the PA tank (Runner) and the Dreadnought
// (Juggernaut) on the imported Precinct Assault arenas.
//
// This is the original's route cursor, ported from the RE's transcriptions in
// integer arithmetic so that it walks what the original walks:
//
//   cnet_route_init         0x004415f0  route_init.c   startRoute
//   cnet_route_next         0x00440f70  route.c        chooseNext
//   cnet_route_plan_leg     0x00440920  route_step.c   planLeg
//   cnet_route_corner_blend 0x00441260  route_step.c   cornerBlend
//   cnet_route_tick         0x004402a0  route_tick.c   routeTick
//   cnet_route_contact      0x004247a0  route_near.c   routeContacts
//   cnet_route_near_actor   0x004248f0  route_near.c   routeTraffic
//   type-5 operation 5      0x00425134  type5.c        releaseRoute
//
// What that buys over the straight-leg walker it replaces (SIM_VERSION 44-106):
//
// * The one-leg look-ahead. The follower chooses the node after the one it is
//   walking to while it is still on the leg — on the first tick of the leg, or
//   on the first tick past the corner it has just turned — not on arrival.
// * The corner window. When the next leg turns, the follower turns through a
//   window `corner_half` node units either side of the waypoint (half of either
//   leg at most, never more than what is left of this one): the heading blends
//   linearly across it, and the position is pulled to the inside of the turn by
//   `corner_half * (unit(next) - unit(leg)) / 4` times the square of the
//   window fraction, so the path through the waypoint is a quadratic.
// * The legs are the original's length: `vec3_length_approx` (two octagonal
//   estimates, up to ~5 % long) of the leg in node units including the nodes'
//   heights, so a leg takes the original's time.
// * The speed word, its ramp and the hold timer in the original's units:
//   `velocity_84` ramps to the commanded speed (accel and decel per engine
//   tick), a hold freezes the accel arm (not the decel) and counts down by
//   the frame delta, contacts write it signed.
// * The occupancy counter: a nibble per node, incremented for the node a
//   follower turns toward and decremented for the one it leaves or dies on the
//   way to — not a live count (the first leg is never counted).
// * The rear-end contact transfer between a Dreadnought and a route follower
//   it touches, and the script-closed node bit.
//
// Axes. The cursor works in the engine's frame: axis 0 is the engine's x, which
// is the sim's y; axis 1 the height; axis 2 the engine's z, the sim's x
// (`cnet_load` 0x00441900 reads the node's +8 as x and +6 as z, the extract's z
// and x). A node unit is 1/32 m (256 world units); positions are world units,
// 8192 to the metre.
//
// And what the actor makes of the cursor:
//
// * The cursor's own height (SIM_VERSION 114): the follower stands on the leg
//   between the nodes' heights plus the record's height bias `<< 4` (the
//   tick's 0x004405f4..0x00440672), the corner cut on all three axes
//   (0x00441410..0x0044144a), not on the sim surface; a halted follower sinks
//   to the highest ground plus its box's lower half (`cnet_route_vertical`
//   0x004414b0's descent).
// * The hull's orientation (SIM_VERSION 114): `cnet_route_orient` (0x00424bc0)
//   takes its fourth arm on every Precinct Assault record -- neither 0x200
//   (CNET_ROUTE_ON_GROUND, the surface normal's arm) nor 0x100
//   (CNET_ROUTE_NO_PITCH) is set (map.ts MapRouteParams) -- so the matrix is
//   `math_matrix_from_angles(yaw, pitch, bank)` of the cursor's channels
//   (0x00424ced), rebuilt only on a tick whose step answers bit 1 (the corner
//   window, a leg planned on arrival; `cact_pathed_move` 0x00424e1e). It is
//   kept apart (`hullYaw`, `hullPitch`, `hullBank`) from the entity's yaw,
//   which is the cursor's own yaw every tick, as the mount reads it
//   (`word_12a`, mount.c 0x004259c9).
// * The bank (Hk's tanks, CNET_ROUTE_BANK 0x20): the peak `-3/8` of the
//   corner's yaw delta times the speed's share of the top (`cnet_route_plan_leg`
//   0x00440be6..0x00440c90), tapered linearly across the window
//   (`cnet_route_corner_blend` 0x00441296), zeroed past it (0x004406f3).
//
// Not modelled, and why:
// * The contact's hit-box confirmation (`cact_hit_boxes` 0x0044f640) on an
//   arena without imported models: there a contact is the sphere overlap
//   (`cact_pair_test` 0x00450190, gap < 0). Where the models are imported the
//   whole ladder decides since SIM_VERSION 112 (contact.ts bodiesContact).

import { ARCHETYPE, TEAM_NEUTRAL } from "./archetypes";
import {
  FRAME_CLOCK_PER_TICK,
  MAX_ENTITIES,
  ROUTE_ACCEL_WORD,
  ROUTE_CONE_COS,
  ROUTE_CONTACT_HOLD,
  ROUTE_DECEL_WORD,
  ROUTE_HOLD_ENGINE_TICKS,
  ROUTE_HOLD_RELEASE,
  ROUTE_NEAR_BLOCK,
  ROUTE_NEAR_GAP,
  ROUTE_NEAR_MIN_LEN,
  ROUTE_NEAR_RISE,
  ROUTE_NODE_UNITS,
  ROUTE_SCORE_CLOSED,
  ROUTE_SCORE_NO_LINK,
  ROUTE_SCORE_PREV,
  ROUTE_SCORE_PREV2,
  ROUTE_SEEK_RANGE,
  ROUTE_SPEED_UNIT,
  ROUTE_SPEED_WORD,
  ROUTE_WANDER,
  WU_PER_METRE,
} from "./balance";
import { bodiesContact } from "./contact";
import { type MapData, type MapLaneGraph, type MapRouteParams, SHAPE_WORDS } from "./map";
import { ANIM_MOVING, entityRadius, entityRefHeight, type SimState, toldFirst } from "./sim";
import { octagonalLength, randInt, TAU } from "./simMath";
import { isGroundUnit, resolveWalker, surfaceBelow } from "./units";

// ---------------------------------------------------------------------------
// The engine's fixed-point arithmetic (RE fcop/math.h, game/math/angle.c)
// ---------------------------------------------------------------------------

/** `math_fixed_mul`: the 64-bit product shifted down 16, its low 32 bits. */
export function fixedMul(a: number, b: number): number {
  const x = a | 0;
  const y = b | 0;
  // x = hi * 65536 + lo with lo unsigned, so floor(x * y / 65536) is
  // hi * y + floor(lo * y / 65536); lo * y stays inside 2^47, exact.
  return (Math.imul(x >> 16, y) + Math.floor(((x & 0xffff) * y) / 65536)) | 0;
}

/** `math_reciprocal_span`: 0x80000000 / (span >> 1) unsigned, 0 for a zero half. */
export function reciprocalSpan(span: number): number {
  const half = span >> 1;
  return half !== 0 ? Math.floor(0x80000000 / (half >>> 0)) : 0;
}

/** The retail table at 0x0048c110: atan(i / 16) in 32-bit turns, and the word after it. */
const ATAN_TABLE = [
  0x00000000, 0x028a085d, 0x05120e1a, 0x078cd337, 0x09fc3396, 0x0c57cc3e, 0x0e9fa458, 0x10cf5246,
  0x12e5b5b8, 0x14e21525, 0x16c41e42, 0x188bd22d, 0x1a399574, 0x1bce284b, 0x1d4aaef8, 0x1eb172c8,
  0x20000000, 0x00000001,
];
const QUARTER_24 = 0x400000;
const HALF_24 = 0x800000;

/**
 * `math_angle_of` (0x00439170): atan2(b, a) as a 24-bit angle. The ratio of the
 * smaller magnitude to the larger by the reciprocal of half the larger, the
 * table entry and a linear step to the next, the octant put back.
 */
export function angleOf(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  let octant = ((a < 0 ? 1 : 0) | (b < 0 ? 2 : 0)) << 1;
  const absA = a < 0 ? -a : a;
  const absB = b < 0 ? -b : b;
  let smaller = absB;
  let larger = absA;
  if (absA < absB) {
    octant |= 1;
    smaller = absA;
    larger = absB;
  }
  const divisor = larger >> 1;
  const ratio = divisor === 0 ? 0 : fixedMul(Math.floor(0x80000000 / divisor) | 0, smaller);
  let index = ratio >> 12;
  if (index < 0) index = 0;
  else if (index > 16) index = 16;
  const fraction = ratio & 0xfff;
  const slope = ((ATAN_TABLE[index + 1] - ATAN_TABLE[index]) * 16 + 8) | 0;
  const angle = ((Math.floor((slope * fraction) / 65536) + ATAN_TABLE[index]) | 0) >> 8;
  switch (octant) {
    case 0:
      return angle;
    case 1:
      return QUARTER_24 - angle;
    case 2:
      return HALF_24 - angle;
    case 3:
      return angle + QUARTER_24;
    case 4:
      return -angle;
    case 5:
      return angle - QUARTER_24;
    case 6:
      return angle - HALF_24;
    default:
      return -QUARTER_24 - angle;
  }
}

/**
 * `vec3_length_approx` (0x00457bb0): approx2(approx2(v0, v1), v2) — the
 * engine's x and the height first, then z.
 */
function length3(v0: number, v1: number, v2: number): number {
  return octagonalLength(octagonalLength(v0, v1), v2);
}

/**
 * The signed 16.16 quotient route_step.c spells seven times: both operands
 * made positive, `num * (0x80000000 / (den >> 1)) >> 16`, the sign put back
 * when exactly one was not positive.
 */
function fixDiv(num: number, den: number): number {
  const negate = num > 0 !== den > 0;
  const n = num > 0 ? num : -num;
  const d = den > 0 ? den : -den;
  const q = fixedMul(n, reciprocalSpan(d) | 0);
  return negate ? -q | 0 : q;
}

/** A 12-bit angle difference folded to -0x7ff..0x800 (0x00440b5d). */
function shortest(masked: number): number {
  return masked > 0x800 ? masked - 0x1000 : masked;
}

/** Sixteen bits, sign-extended: the cursor's halfword fields. */
function i16(v: number): number {
  return (v << 16) >> 16;
}

/** A 12-bit angle (4096 a turn, the sim's yaw sense) in radians, -pi..pi. */
function radians(angle12: number): number {
  return (angle12 > 0x800 ? angle12 - 0x1000 : angle12) * (TAU / 0x1000);
}

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

/** Cursor phase bits: the corner the follower turns through, and the halt. */
const AHEAD = 1; // CNET_ROUTE_CORNER_AHEAD: the corner fields are filled, not yet reached
const PASSED = 2; // CNET_ROUTE_CORNER_PASSED: past the waypoint, inside the window
const HALTED = 4; // CNET_ROUTE_HALTED: the chooser refused on arrival
const GROUNDED = 8; // CNET_ROUTE_NO_HEIGHT_BIAS, set by the halted descent's landing
/** CNET_ROUTE_BANK: the bank channel (Hk's tanks). */
const ROUTE_FLAG_BANK = 0x20;

/**
 * Every route follower's cursor (the original's 0x7c-byte block at a pathed
 * actor's +0xdc), at the entity id; the vectors at `id * 3 + axis` in the
 * engine's axes. The node walked to, the one left and the one before are the
 * entity's own `timerA`, `cooldownB` and `ammoB - 1` (units.ts). Read and
 * hashed for live ground units on an arena with the graph only.
 */
export interface RouteCursors {
  /** Where this leg started, node units. */
  readonly legFrom: Int16Array;
  /** The leg, and the leg after the corner (`next_leg`). */
  readonly leg: Int16Array;
  readonly nextLeg: Int16Array;
  /** The corner-cut offset at the apex, node units. */
  readonly corner: Int16Array;
  /** The actor's heading (+0x78/+0x7c/+0x80): this leg's 16.16 unit vector. */
  readonly heading: Int32Array;
  /** The next leg's 16.16 unit vector. */
  readonly nextDir: Int32Array;
  /** Along `leg`, world units (node units << 8). */
  readonly travelled: Int32Array;
  readonly legLength: Int16Array;
  readonly nextLegLength: Int16Array;
  /** Half the corner window, node units, and ~16384 / it. */
  readonly cornerHalf: Int16Array;
  readonly cornerRecip: Int16Array;
  /** The three angle channels, 12-bit, and each turn through the corner. */
  readonly yawFrom: Int16Array;
  readonly yaw: Int16Array;
  readonly yawTo: Int16Array;
  readonly yawTurn: Int16Array;
  readonly pitchFrom: Int16Array;
  readonly pitch: Int16Array;
  readonly pitchTo: Int16Array;
  readonly pitchTurn: Int16Array;
  /** The commanded speed, world units an engine tick (`speed`, +0x32). */
  readonly speed: Int16Array;
  /** The speed override's hold, engine ticks, signed (+0x40). */
  readonly hold: Int16Array;
  /** The actor's speed word (`velocity_84`), world units an engine tick. */
  readonly velocity: Int32Array;
  /** The node after the one walked to: -1 not chosen yet, -2 refused. */
  readonly next: Int16Array;
  /** The roll at the apex of the corner and the roll now, 12-bit (BANK only). */
  readonly bankPeak: Int16Array;
  readonly bank: Int16Array;
  /**
   * The actor's matrix (`cnet_route_orient`'s fourth arm): the yaw, pitch and
   * bank it was last built from, 12-bit. The drawn hull, its colliders and its
   * mounts stand on it; the entity's yaw is the cursor's.
   */
  readonly hullYaw: Int16Array;
  readonly hullPitch: Int16Array;
  readonly hullBank: Int16Array;
  /** AHEAD | PASSED | HALTED | GROUNDED. */
  readonly phase: Uint8Array;
  /**
   * Per node: the occupancy nibble (node +4, 0..15), how many followers have
   * turned toward the node and not left it or died on the way.
   */
  readonly occupancy: Uint8Array;
}

export function createRouteCursors(map: MapData): RouteCursors {
  const n = MAX_ENTITIES;
  const nodes = map.laneGraph?.nodes.length ?? 0;
  return {
    legFrom: new Int16Array(n * 3),
    leg: new Int16Array(n * 3),
    nextLeg: new Int16Array(n * 3),
    corner: new Int16Array(n * 3),
    heading: new Int32Array(n * 3),
    nextDir: new Int32Array(n * 3),
    travelled: new Int32Array(n),
    legLength: new Int16Array(n),
    nextLegLength: new Int16Array(n),
    cornerHalf: new Int16Array(n),
    cornerRecip: new Int16Array(n),
    yawFrom: new Int16Array(n),
    yaw: new Int16Array(n),
    yawTo: new Int16Array(n),
    yawTurn: new Int16Array(n),
    pitchFrom: new Int16Array(n),
    pitch: new Int16Array(n),
    pitchTo: new Int16Array(n),
    pitchTurn: new Int16Array(n),
    speed: new Int16Array(n),
    hold: new Int16Array(n),
    velocity: new Int32Array(n),
    next: new Int16Array(n),
    bankPeak: new Int16Array(n),
    bank: new Int16Array(n),
    hullYaw: new Int16Array(n),
    hullPitch: new Int16Array(n),
    hullBank: new Int16Array(n),
    phase: new Uint8Array(n),
    occupancy: new Uint8Array(nodes),
  };
}

/** A node's coordinate on an engine axis, node units. */
function nodeAxis(g: MapLaneGraph, node: number, axis: number): number {
  if (axis === 1) return g.heights[node];
  const p = g.nodes[node];
  return Math.round((axis === 0 ? p.y : p.x) * ROUTE_NODE_UNITS);
}

/**
 * A node's index within its own Cnet: what the original compares, since each
 * side's net is its own resource (the merged list puts them end to end).
 */
function localNode(g: MapLaneGraph, node: number): number {
  if (node < 0) return node;
  let start = 0;
  for (let k = 0; k < g.netStart.length; k++) {
    if (g.netStart[k] <= node) start = g.netStart[k];
  }
  return node - start;
}

/** True when ground units on this map follow the original's routes (rules.md §9). */
export function followsRoutes(state: SimState): boolean {
  return state.map.laneGraph !== undefined;
}

/** The route block `id` runs on: its record's (map.ts MapRouteParams). */
function paramsOf(state: SimState, id: number): MapRouteParams {
  const g = state.map.laneGraph as MapLaneGraph;
  return state.ent.archetype[id] === ARCHETYPE.JUGGERNAUT ? g.juggernautRoute : g.runnerRoute;
}

/**
 * `cnet_route_orient` (0x00424bc0) on a Precinct Assault record: neither
 * CNET_ROUTE_ON_GROUND (0x200, `test dh, 2` at 0x00424bcf) nor
 * CNET_ROUTE_NO_PITCH (0x100, 0x00424c82) is set (map.ts refuses both), so the
 * fourth arm: `math_matrix_from_angles(yaw, pitch, bank)` of the cursor's
 * channels, +0x12a, +0x130 and +0x136 (0x00424cbc..0x00424ced; the external
 * attitude of bits 30-31 is the break-up's, which no PA record arms).
 */
function orient(c: RouteCursors, id: number): void {
  c.hullYaw[id] = c.yaw[id];
  c.hullPitch[id] = c.pitch[id];
  c.hullBank[id] = c.bank[id];
}

/** The world units a node unit's height and the bias land on, as metres. */
function metres(wu: number): number {
  return wu / WU_PER_METRE;
}

/** Is `id` a route follower that has stopped for good (refused, or parked off its road)? */
function isHalted(state: SimState, id: number): boolean {
  return state.ent.timerA[id] < 0 || (state.route.phase[id] & HALTED) !== 0;
}

// ---------------------------------------------------------------------------
// The step chooser (cnet_route_next 0x00440f70)
// ---------------------------------------------------------------------------

/** floor(log2(v)) for a positive 32-bit integer, 0 for 0 (`math_top_bit`). */
function topBit(v: number): number {
  return v <= 0 ? 0 : 31 - Math.clz32(v);
}

/** Per-candidate scores of the step chooser (module scratch, no allocation). */
const routeScores = new Int32Array(4);

/**
 * Which neighbour of `from` the follower steps to next, or -1 when every link is
 * refused. `from` is the node the cursor is walking to (the look-ahead) or, at
 * the spawn, the node it stands on.
 *
 * - A Runner (the PA tank: SEEK_TEAM, wander 1638/4096, search 16 m) first rolls
 *   the wander: 40 % of steps are random. Otherwise it looks for the nearest
 *   enemy-team actor within ROUTE_SEEK_RANGE; none found makes the step random.
 *   The target is found afresh at every step (retail drops the held one).
 * - A Juggernaut (the Dreadnought: mode 0) always steps at random.
 * - Each of up to four links, in the engine's order (the node's first word
 *   from bits 22-31 down, then +4; the arena import writes them so), is
 *   scored: no link -4, the node just left -2 (refused), the node before that
 *   -1 (the dead-end escape), a node a script has closed -3 (refused). Seeking
 *   scores the dot product of the step with the direction to the target, in
 *   node units (1/32 m), by octave: 32 + floor(log2 dot) for dot >= 0,
 *   31 - floor(log2 -dot) below. Random scores a 16-bit draw. Then the
 *   occupancy: a positive score is shifted right by the candidate's nibble.
 * - The pick walks the links from the fourth to the first, keeping the higher
 *   score; a tie is a coin flip.
 */
function chooseNext(state: SimState, id: number, from: number): number {
  const ent = state.ent;
  const g = state.map.laneGraph;
  if (g === undefined || from < 0 || from >= g.nodes.length) return -1;
  const prev = ent.cooldownB[id];
  const prev2 = ent.ammoB[id] - 1;
  const here = g.nodes[from];
  const hx = Math.round(here.x * ROUTE_NODE_UNITS);
  const hy = Math.round(here.y * ROUTE_NODE_UNITS);
  const occupancy = state.route.occupancy;

  // The roll and the target, before any candidate (retail's order).
  let seek = -1;
  if (ent.archetype[id] === ARCHETYPE.RUNNER) {
    if (randInt(state, 4096) >= ROUTE_WANDER) seek = seekTarget(state, id);
  }
  // Retail's `>> 8` of a world position is a floor in node units.
  const tx = seek >= 0 ? Math.floor(ent.posX[seek] * ROUTE_NODE_UNITS) : 0;
  const ty = seek >= 0 ? Math.floor(ent.posY[seek] * ROUTE_NODE_UNITS) : 0;

  for (let s = 0; s < 4; s++) {
    const link = g.edges[from * 4 + s];
    let score: number;
    if (link < 0) score = ROUTE_SCORE_NO_LINK;
    else if (link === prev) score = ROUTE_SCORE_PREV;
    else if (link === prev2) score = ROUTE_SCORE_PREV2;
    else if (g.closed[link] !== 0) score = ROUTE_SCORE_CLOSED;
    else {
      if (seek >= 0) {
        const c = g.nodes[link];
        const cx = Math.round(c.x * ROUTE_NODE_UNITS);
        const cy = Math.round(c.y * ROUTE_NODE_UNITS);
        const dot = (cx - hx) * (tx - hx) + (cy - hy) * (ty - hy);
        score = dot >= 0 ? topBit(dot) + 0x20 : 0x1f - topBit(-dot);
      } else {
        score = randInt(state, 0x10000);
      }
      const crowd = occupancy[link];
      if (crowd > 0 && score > 0) score >>= crowd;
    }
    routeScores[s] = score;
  }
  let best = ROUTE_SCORE_NO_LINK;
  let chosen = -1;
  for (let s = 3; s >= 0; s--) {
    const score = routeScores[s];
    if (score < ROUTE_SCORE_PREV2 || score < best) continue;
    if (score === best && randInt(state, 2) !== 0) continue;
    best = score;
    chosen = s;
  }
  return chosen < 0 ? -1 : g.edges[from * 4 + chosen];
}

/**
 * The SEEK_TEAM search: the nearest live enemy-team actor within
 * ROUTE_SEEK_RANGE (horizontal), in dense id order (`cact_find_target`, mode
 * NEAREST, no cone, no line of sight). Projectiles and Metropolis' outpost
 * consoles are not actors of the original; a cloaked avatar is skipped as the
 * original's searches skip it (fcop-fidelity.md P7). -1 for none.
 */
function seekTarget(state: SimState, id: number): number {
  const ent = state.ent;
  const team = ent.team[id];
  const x = ent.posX[id];
  const y = ent.posY[id];
  let hidden0 = -1;
  let hidden1 = -1;
  if (state.buffInvis.length > 0) {
    if (state.buffInvis[0] > 0) hidden0 = state.avatarId[0];
    if (state.buffInvis[1] > 0) hidden1 = state.avatarId[1];
  }
  let best = -1;
  let bestD2 = ROUTE_SEEK_RANGE * ROUTE_SEEK_RANGE;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || t === id || t === hidden0 || t === hidden1) continue;
    const tt = ent.team[t];
    if (tt === team || tt === TEAM_NEUTRAL) continue;
    const a = ent.archetype[t];
    if (a === ARCHETYPE.PROJECTILE || a === ARCHETYPE.CONSOLE) continue;
    const dx = ent.posX[t] - x;
    const dy = ent.posY[t] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = t;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The construct (cnet_route_init 0x004415f0)
// ---------------------------------------------------------------------------

/** Scratch for a leg in world units (no allocation per call). */
const dir = new Int32Array(3);

/**
 * Puts a new ground unit on its side's road, from where it stands. The spawn
 * node is the first node of its own net at the unit's position in node units
 * (`cnet_node_find` 0x004418b0: x and z, floored, the height not compared);
 * it is both the node left and the one before, so the first step refuses only
 * a link back to it, and the step chooser picks the node walked to at once.
 * The first leg runs from the spawn node; the unit's x and z are left where it
 * was placed (the first tick puts it on the leg). The speed word starts at 0,
 * the commanded speed at the top, no hold, no corner; the first leg is not
 * counted on any node's occupancy.
 *
 * Every spawner the arenas import stands on a node (base tanks, outpost tanks,
 * the Dreadnought). A unit placed anywhere else (the sandbox, the tests) — which
 * the original's lookup cannot answer — walks from where it stands to the
 * nearest node of its own net first, with no node behind it.
 */
export function startRoute(state: SimState, id: number): void {
  const ent = state.ent;
  const c = state.route;
  const g = state.map.laneGraph;
  if (g === undefined) return;
  const team = ent.team[id];
  const ux = Math.floor(ent.posY[id] * ROUTE_NODE_UNITS);
  const uz = Math.floor(ent.posX[id] * ROUTE_NODE_UNITS);
  // Its own net (the merged list labels each side's, MapLaneGraph.net).
  const own = team === 1 ? 1 : 0;
  const n = g.nodes.length;
  let spawn = -1;
  for (let k = 0; k < n; k++) {
    if (g.net[k] === own && nodeAxis(g, k, 0) === ux && nodeAxis(g, k, 2) === uz) {
      spawn = k;
      break;
    }
  }
  const k3 = id * 3;
  c.travelled[id] = 0;
  c.velocity[id] = 0;
  c.speed[id] = ROUTE_SPEED_WORD;
  c.hold[id] = 0;
  c.phase[id] = 0;
  c.next[id] = -1;
  c.yawTurn[id] = 0;
  c.pitchTurn[id] = 0;
  c.cornerHalf[id] = 0;
  c.cornerRecip[id] = 0;
  // 0x00441721..0x00441729: the hold and both bank words cleared.
  c.bank[id] = 0;
  c.bankPeak[id] = 0;
  let node: number;
  if (spawn >= 0) {
    ent.cooldownB[id] = spawn;
    ent.ammoB[id] = spawn + 1;
    for (let a = 0; a < 3; a++) c.legFrom[k3 + a] = nodeAxis(g, spawn, a);
    node = chooseNext(state, id, spawn);
  } else {
    ent.cooldownB[id] = -1;
    ent.ammoB[id] = 0;
    c.legFrom[k3] = ux;
    c.legFrom[k3 + 1] = (Math.round(ent.height[id] * WU_PER_METRE) + 0x7f) >> 8;
    c.legFrom[k3 + 2] = uz;
    node = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let k = 0; k < n; k++) {
      if (g.net[k] !== own) continue;
      const dx = g.nodes[k].x - ent.posX[id];
      const dy = g.nodes[k].y - ent.posY[id];
      const d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
        node = k;
      }
    }
  }
  ent.timerA[id] = node;
  if (node < 0) c.phase[id] = HALTED;
  for (let a = 0; a < 3; a++) {
    const to = node >= 0 ? nodeAxis(g, node, a) : c.legFrom[k3 + a];
    c.leg[k3 + a] = i16(to - c.legFrom[k3 + a]);
    dir[a] = c.leg[k3 + a] << 8;
  }
  const length = length3(dir[0], dir[1], dir[2]);
  c.legLength[id] = i16(length >> 8);
  const r = reciprocalSpan(length) | 0;
  for (let a = 0; a < 3; a++) c.heading[k3 + a] = fixedMul(dir[a], r);
  const yaw = (angleOf(c.heading[k3 + 2], c.heading[k3]) >> 12) & 0xfff;
  c.yawTo[id] = yaw;
  c.yaw[id] = yaw;
  c.yawFrom[id] = yaw;
  // `~(angle >> 12)`, one unit off the planner's `neg` (route_init.c,
  // 0x00441878): a level first leg pitches 0xfff here.
  const horizontal = octagonalLength(c.heading[k3], c.heading[k3 + 2]);
  const pitch = ~(angleOf(horizontal, c.heading[k3 + 1]) >> 12) & 0xfff;
  c.pitchTo[id] = pitch;
  c.pitch[id] = pitch;
  c.pitchFrom[id] = pitch;
  ent.yaw[id] = radians(yaw);
  ent.velX[id] = 0;
  ent.velY[id] = 0;
  // 0x00441899..0x004418a6: the spawn node's height plus the bias (which the
  // construct drops only when positive with bit 4, a bit no PA record carries).
  ent.height[id] = metres((c.legFrom[k3 + 1] << 8) + (paramsOf(state, id).bias << 4));
  ent.entLayer[id] = resolveWalker(state.map, ent.posX[id], ent.posY[id], ent.height[id]).layer;
  // The construct orients it from the cursor (0x00425265).
  orient(c, id);
}

// ---------------------------------------------------------------------------
// The leg planner and the corner blend (route_step.c)
// ---------------------------------------------------------------------------

/**
 * `cnet_route_plan_leg` (0x00440920): ask the chooser where to go after the node
 * walked to, and turn the answer into the next leg. `midLeg` 0 (on arrival)
 * snaps both angle channels to the new leg; 1 (on the leg) sizes the corner
 * window, the two turns and the corner-cut offset, and marks the corner AHEAD.
 * A refusal writes only `next` (-2). Route flags 0 (the tank) and 0x8 (the
 * Dreadnought) reach only these arms; Hk's tanks' 0x20 (CNET_ROUTE_BANK) adds
 * the bank: both words cleared on every plan (0x00440a90), and on a corner
 * with a yaw the peak, `-3/8` of the raw yaw delta wrapped and clamped to half
 * a turn, times the speed word's share of the top, at most 1 (0x00440be6..
 * 0x00440c90).
 */
function planLeg(state: SimState, id: number, midLeg: boolean): void {
  const c = state.route;
  const g = state.map.laneGraph as MapLaneGraph;
  const choice = chooseNext(state, id, state.ent.timerA[id]);
  if (choice < 0) {
    c.next[id] = -2;
    return;
  }
  c.next[id] = choice;
  const k3 = id * 3;
  // The new leg runs from the end of this one, sixteen bits wide.
  for (let a = 0; a < 3; a++) {
    const nl = i16(nodeAxis(g, choice, a) - c.legFrom[k3 + a] - c.leg[k3 + a]);
    c.nextLeg[k3 + a] = nl;
    dir[a] = nl << 8;
  }
  const length = length3(dir[0], dir[1], dir[2]);
  c.nextLegLength[id] = i16(length >> 8);
  const r = reciprocalSpan(length) | 0;
  for (let a = 0; a < 3; a++) c.nextDir[k3 + a] = fixedMul(dir[a], r);
  // The yaw catches up with the last target, then takes the new one: atan2(x, z).
  if (c.yaw[id] !== c.yawTo[id]) c.yaw[id] = c.yawTo[id];
  c.yawTo[id] = (angleOf(c.nextDir[k3 + 2], c.nextDir[k3]) >> 12) & 0xfff;
  const horizontal = octagonalLength(c.nextDir[k3], c.nextDir[k3 + 2]);
  c.pitchTo[id] = -(angleOf(horizontal, c.nextDir[k3 + 1]) >> 12) & 0xfff;
  c.phase[id] &= ~(AHEAD | PASSED);
  const bankOn = (paramsOf(state, id).flags & ROUTE_FLAG_BANK) !== 0;
  if (bankOn) {
    c.bank[id] = 0;
    c.bankPeak[id] = 0;
  }

  if (!midLeg) {
    c.pitchFrom[id] = c.pitchTo[id];
    c.pitch[id] = c.pitchTo[id];
    c.yawFrom[id] = c.yawTo[id];
    c.yaw[id] = c.yawTo[id];
    return;
  }

  const yawDelta = (c.yawTo[id] - c.yawFrom[id]) & 0xfff;
  if (yawDelta === 0) c.yawTurn[id] = 0;
  const pitchDelta = (c.pitchTo[id] - c.pitchFrom[id]) & 0xfff;
  if (pitchDelta === 0) c.pitchTurn[id] = 0;
  if (yawDelta === 0 && pitchDelta === 0) return; // a straight on: no corner
  if (pitchDelta !== 0) c.pitchTurn[id] = shortest(pitchDelta);

  // The window: half of either leg, and never more than what is left of this one.
  const legLength = c.legLength[id];
  const half = (legLength / 2) | 0;
  const along = legLength - (c.travelled[id] >> 8);
  let span = along < half ? along : half;
  const nextHalf = (c.nextLegLength[id] / 2) | 0;
  if (nextHalf < span) span = nextHalf;
  if (span < 0) span = 0;
  c.cornerHalf[id] = span;
  c.cornerRecip[id] = span > 0 ? i16(reciprocalSpan(span << 8) >>> 10) : 0x7fff;
  if (yawDelta !== 0) {
    c.yawTurn[id] = shortest(yawDelta);
    if (bankOn) {
      // The raw difference, wrapped once each way and clamped to half a turn.
      let d = c.yawTo[id] - c.yawFrom[id];
      if (d > 0x800) d -= 0x1000;
      else if (d < -0x800) d += 0x1000;
      if (d < -0x800) d = -0x800;
      else if (d > 0x800) d = 0x800;
      // `-3d << 8` and a toward-zero `>> 11`: -3d/8, against the turn.
      const peak = Math.trunc((-3 * d) / 8);
      let ratio = fixDiv(c.velocity[id], ROUTE_SPEED_WORD);
      if (ratio > 0x10000) ratio = 0x10000;
      c.bankPeak[id] = i16(fixedMul(peak << 16, ratio) >> 16);
    }
  }

  // The corner cut: corner_half * (unit(next) - unit(leg)) / 4, node units.
  const a = fixDiv(span << 8, legLength << 8);
  const b = fixDiv(span << 8, c.nextLegLength[id] << 8);
  for (let x = 0; x < 3; x++) {
    const out = fixedMul(c.nextLeg[k3 + x] << 8, b);
    const inn = fixedMul(c.leg[k3 + x] << 8, a);
    c.corner[k3 + x] = i16((out - inn) >> 10);
  }
  c.phase[id] = (c.phase[id] & ~PASSED) | AHEAD;
}

/** The position the tick and the blend write, world units (engine x, z, y). */
const at = new Int32Array(3);

/**
 * `cnet_route_corner_blend` (0x00441260), `offset` world units from the
 * waypoint (negative before it): the bank tapered linearly from its peak at the
 * waypoint (0x00441296), the yaw linear across the window, the position pulled
 * inward by `corner` times the square of the window fraction (added to the
 * straight-line position the tick wrote, on all three axes: 0x00441410,
 * 0x0044142d, 0x0044144a), the pitch linear.
 */
function cornerBlend(state: SimState, id: number, offset: number): void {
  const c = state.route;
  const k3 = id * 3;
  const span = c.cornerHalf[id] << 8;
  const away = offset < 0 ? -offset : offset;
  const recip = c.cornerRecip[id];
  if (c.bankPeak[id] !== 0 && (c.phase[id] & (AHEAD | PASSED)) !== 0) {
    const taper = fixDiv(span - away, span);
    c.bank[id] = (fixedMul(c.bankPeak[id] << 16, taper) >> 16) & 0xfff;
  }
  if (c.yawTurn[id] !== 0) {
    const rate = Math.imul(recip << 2, c.yawTurn[id]) >> 9;
    const step = Math.imul(rate, span + offset) >> 16;
    c.yaw[id] = (step + c.yawFrom[id]) & 0xfff;
    const s = fixedMul(span - away, recip << 10);
    const weight = Math.imul(s >> 2, s >> 2) >> 12;
    at[0] = (at[0] + fixedMul(c.corner[k3] << 8, weight)) | 0;
    at[1] = (at[1] + fixedMul(c.corner[k3 + 2] << 8, weight)) | 0;
    at[2] = (at[2] + fixedMul(c.corner[k3 + 1] << 8, weight)) | 0;
  }
  if (c.pitchTurn[id] !== 0) {
    const u = fixedMul((span + offset) >> 1, recip << 10);
    const step = fixedMul(c.pitchTurn[id] << 16, u) >> 16;
    c.pitch[id] = (c.pitchFrom[id] + step) & 0xfff;
  }
}

// ---------------------------------------------------------------------------
// The tick (cnet_route_tick 0x004402a0)
// ---------------------------------------------------------------------------

/**
 * A route follower's tick: the hold clock, the speed word's ramp, the walk
 * along the leg (an overshoot carries into the next leg, several if need be),
 * and on each arrival the rotation of the cursor and the occupancy. Then the
 * position on the leg and the corner: inside the window past a waypoint the
 * blend with the distance travelled; inside it before the next one, with what
 * is left; and otherwise, with no next node chosen yet, the look-ahead.
 *
 * A tick that moves nothing (speed word 0), or lands exactly on a waypoint,
 * leaves the position where the last tick put it, as the original does. A
 * follower whose chooser refuses on arrival halts there for good, its speed
 * word 0 (the wrapper sends a halted cursor to the vertical mover only, which
 * lowers it to the ground: haltedDescent).
 *
 * The position is the cursor's on all three axes: the leg's straight line
 * between the nodes' heights plus the bias `<< 4` (0x004405f4..0x00440672),
 * then the corner. The hull's matrix (`hullYaw`/`hullPitch`/`hullBank`) is
 * rebuilt only on a tick whose step answers bit 1 -- inside a corner window
 * (0x00440716, 0x0044078b) or a leg planned on arrival (0x004403c2) --
 * which `cact_pathed_move` (0x00424e1e) requires before it calls
 * `cnet_route_orient`; leaving the window snaps the channels (0x004406d1..
 * 0x004406f3) but answers bit 0 alone, so the matrix keeps the window's last
 * blend until the next corner.
 */
export function routeTick(state: SimState, id: number): void {
  const ent = state.ent;
  const c = state.route;
  const g = state.map.laneGraph;
  if (g === undefined) return;
  if (isHalted(state, id)) {
    c.velocity[id] = 0;
    ent.velX[id] = 0;
    ent.velY[id] = 0;
    ent.animState[id] = 0;
    haltedDescent(state, id);
    return;
  }
  const dt = FRAME_CLOCK_PER_TICK;
  const k3 = id * 3;

  // The hold: |hold| -= dt, the sign put back, and the commanded speed back to
  // the top when it runs out. The original restores only when the count passes
  // zero (`jns` at 0x004402c4) and leaves the override in place when it lands
  // on zero exactly; its frame delta is the clock's elapsed ticks, at least 8
  // and varying frame to frame (`frame_step` 0x00406a30), so a 300-tick hold
  // lands on zero only by chance. Lockstep's delta is always 10, on which every
  // hold would land on zero and a follower stopped for an obstacle would never
  // move again; this restores on landing too (see fcop-fidelity.md U1).
  const hold = c.hold[id];
  if (hold !== 0) {
    let left = (hold < 0 ? -hold : hold) - dt;
    if (left <= 0) {
      c.speed[id] = ROUTE_SPEED_WORD;
      left = 0;
    }
    c.hold[id] = hold < 0 ? -left : left;
  }

  // The ramp: accel only without a hold, decel regardless; toward-zero / 16.
  const commanded = c.speed[id];
  let vel = c.velocity[id];
  if (vel < commanded) {
    if (c.hold[id] === 0) {
      vel += Math.floor((ROUTE_ACCEL_WORD * dt) / 16);
      if (vel > commanded) vel = commanded;
    }
  } else if (vel > commanded) {
    vel -= Math.floor((ROUTE_DECEL_WORD * dt) / 16);
    if (vel < commanded) vel = commanded;
    if (vel < 0) vel = 0;
  }
  c.velocity[id] = vel;
  const step = vel * dt;

  let write = false;
  // Bit 1 of the step's answer: a heading or a new leg (TICK_DIRTY_HEAD).
  let head = false;
  if (step > 0) {
    c.travelled[id] += step;
    write = true;
    // Arrival is a loop: an overshoot walks on into the next leg.
    while (c.travelled[id] >> 8 >= c.legLength[id]) {
      if (c.next[id] < 0) {
        planLeg(state, id, false);
        if (c.next[id] < 0) {
          // Stuck: halted where the last tick left it (0x004408f9).
          c.phase[id] |= HALTED;
          c.velocity[id] = 0;
          c.travelled[id] = c.legLength[id] << 8;
          ent.velX[id] = 0;
          ent.velY[id] = 0;
          ent.animState[id] = 0;
          return;
        }
        head = true;
      } else if ((c.phase[id] & (AHEAD | PASSED)) === AHEAD) {
        c.phase[id] = (c.phase[id] & ~AHEAD) | PASSED;
      }
      // Commit: the waypoint reached starts the next leg.
      for (let a = 0; a < 3; a++) {
        c.legFrom[k3 + a] = i16(c.legFrom[k3 + a] + c.leg[k3 + a]);
        c.heading[k3 + a] = c.nextDir[k3 + a];
        c.leg[k3 + a] = c.nextLeg[k3 + a];
      }
      const reached = ent.timerA[id];
      const next = c.next[id];
      const occupancy = c.occupancy;
      if (occupancy[reached] > 0) occupancy[reached] -= 1;
      if (occupancy[next] < 15) occupancy[next] += 1;
      const remaining = c.travelled[id] - (c.legLength[id] << 8);
      ent.ammoB[id] = ent.cooldownB[id] + 1;
      ent.cooldownB[id] = reached;
      ent.timerA[id] = next;
      c.next[id] = -1;
      c.legLength[id] = c.nextLegLength[id];
      c.travelled[id] = 0;
      if (remaining <= 0) {
        write = false; // an exact landing writes no position this tick
        break;
      }
      c.travelled[id] = remaining;
    }
  }

  if (write) {
    // The straight line between the waypoints, then the corner.
    const frac = fixedMul(c.travelled[id], reciprocalSpan(c.legLength[id]) | 0);
    at[0] = ((c.legFrom[k3] << 8) + fixedMul(frac, c.leg[k3])) | 0;
    at[1] = ((c.legFrom[k3 + 2] << 8) + fixedMul(frac, c.leg[k3 + 2])) | 0;
    // The height, and the bias over it (0x00440672: no PA record sets bit 4).
    at[2] =
      ((c.legFrom[k3 + 1] << 8) + fixedMul(frac, c.leg[k3 + 1]) + (paramsOf(state, id).bias << 4)) |
      0;
    const phase = c.phase[id] & (AHEAD | PASSED);
    const travelled = c.travelled[id];
    if (phase === PASSED) {
      if (travelled >> 8 >= c.cornerHalf[id]) {
        // Out of the window: the channels take their targets, the corner is done.
        c.yawFrom[id] = c.yawTo[id];
        c.yaw[id] = c.yawTo[id];
        c.pitchFrom[id] = c.pitchTo[id];
        c.pitch[id] = c.pitchTo[id];
        c.phase[id] &= ~(AHEAD | PASSED);
        if ((paramsOf(state, id).flags & ROUTE_FLAG_BANK) !== 0) {
          c.bank[id] = 0;
          c.bankPeak[id] = 0;
        }
      } else {
        head = true;
        cornerBlend(state, id, travelled);
      }
    } else {
      const left = (c.legLength[id] << 8) - travelled;
      if (phase === AHEAD && left >> 8 < c.cornerHalf[id]) {
        head = true;
        cornerBlend(state, id, -left);
      } else if (c.next[id] < 0) {
        planLeg(state, id, true);
      }
    }
    ent.posX[id] = at[1] / WU_PER_METRE;
    ent.posY[id] = at[0] / WU_PER_METRE;
    ent.height[id] = metres(at[2]);
    // The deck it rides (issue #33): the surface under the cursor.
    ent.entLayer[id] = resolveWalker(state.map, ent.posX[id], ent.posY[id], ent.height[id]).layer;
  }
  if (head) orient(c, id);

  // A commanded speed under an eighth of the top with no hold is not kept
  // (0x004408ae; a tick that moved nothing returned before it).
  if (step > 0 && c.speed[id] < ROUTE_SPEED_WORD >> 3 && c.hold[id] === 0) {
    c.speed[id] = ROUTE_SPEED_WORD;
  }

  const v = c.velocity[id] * ROUTE_SPEED_UNIT;
  ent.velX[id] = (c.heading[k3 + 2] / 65536) * v;
  ent.velY[id] = (c.heading[k3] / 65536) * v;
  ent.yaw[id] = radians(c.yaw[id]);
  ent.animState[id] = c.velocity[id] > 0 ? ANIM_MOVING : 0;
}

/**
 * The vertical mover's descent (`cnet_route_vertical` 0x004414b0, the arm at
 * 0x0044157a), which `cnet_route_drive` (0x004400f3) runs for a halted cursor
 * with a positive bias: the follower sinks `top_speed * dt / 2` world units a
 * tick toward the highest ground under it (`terrain_height_at(.., -1)`,
 * 0x00441586) plus its model's box-0 lower half, `half_y - centre_y`
 * (0x004415a3..0x004415b0), and lands on it, the cursor's bit 4 set
 * (0x004415cb) so it moves no more. The matrix is not rebuilt (it answers 1).
 */
function haltedDescent(state: SimState, id: number): void {
  const ent = state.ent;
  const c = state.route;
  if ((c.phase[id] & GROUNDED) !== 0 || paramsOf(state, id).bias <= 0) return;
  const map = state.map;
  const top = surfaceBelow(map, ent.posX[id], ent.posY[id], Number.POSITIVE_INFINITY);
  const ground = Math.floor((top.height + boxLower(state, id)) * WU_PER_METRE);
  let y = Math.round(ent.height[id] * WU_PER_METRE);
  if (y > ground) {
    y -= (ROUTE_SPEED_WORD * FRAME_CLOCK_PER_TICK) >> 1;
    if (y > ground) {
      ent.height[id] = metres(y);
      return;
    }
  }
  c.phase[id] |= GROUNDED;
  ent.height[id] = metres(ground);
  ent.entLayer[id] = top.layer;
}

/**
 * `half_y - centre_y` of box 0 of the follower's model at its frame, metres
 * (`drive_box_offset`, route_drive.c): the tank's, the Dreadnought hull's at
 * its walk's frame; 0 on an arena without imported models, as for an actor
 * with none (0x00441591).
 */
function boxLower(state: SimState, id: number): number {
  const sh = state.map.shapes;
  const ent = state.ent;
  let table = -1;
  let frame = 0;
  if (ent.archetype[id] === ARCHETYPE.JUGGERNAUT) {
    table = sh.dreadnought;
    const team = ent.team[id];
    const walk = team === 0 || team === 1 ? state.hullWalk[team] : null;
    if (walk) frame = walk.frame[id];
  } else if (sh.tank !== null) {
    table = sh.tank.table;
  }
  if (table < 0 || table >= sh.tables.length) return 0;
  const t = sh.tables[table];
  const f = frame >= 0 && frame < t.frames ? frame : 0;
  const o = f * SHAPE_WORDS; // box 0's row of frame f
  return t.boxes[o + 4] - t.boxes[o + 1];
}

/**
 * Type-5 operation 5 (0x00425134): a follower leaving the game takes one off
 * the occupancy of the node it was walking to, floored at 0.
 */
export function releaseRoute(state: SimState, id: number): void {
  const g = state.map.laneGraph;
  if (g === undefined || !isGroundUnit(state.ent.archetype[id])) return;
  const node = state.ent.timerA[id];
  if (node >= 0 && node < g.nodes.length && state.route.occupancy[node] > 0) {
    state.route.occupancy[node] -= 1;
  }
}

// ---------------------------------------------------------------------------
// Two followers touching (cnet_route_contact 0x004247a0)
// ---------------------------------------------------------------------------

/**
 * The pair test's verdict on two bodies (`cact_pair_test` 0x00450190): the
 * octagonal gap between their reference points, horizontal then vertical, less
 * both radii, world units: where the two have no imported hit boxes, a contact
 * is a negative gap (inContact).
 */
function pairGap(state: SimState, a: number, b: number): number {
  const ent = state.ent;
  const dx = Math.round((ent.posX[a] - ent.posX[b]) * WU_PER_METRE);
  const dz = Math.round((ent.posY[a] - ent.posY[b]) * WU_PER_METRE);
  const flat = octagonalLength(dx, dz);
  const radii = Math.round((entityRadius(state, a) + entityRadius(state, b)) * WU_PER_METRE);
  const ha = ent.height[a] + entityRefHeight(state, a);
  const hb = ent.height[b] + entityRefHeight(state, b);
  const dy = Math.round((ha - hb) * WU_PER_METRE);
  return octagonalLength(flat, dy) - radii;
}

/**
 * Whether the pair walk tells these two of a contact (operation 0x0b): both
 * route followers, one of them a Dreadnought — the only route follower whose
 * record carries 0x200, the collision rung (`cact_pair_test` 0x00450257 tests
 * the pair's flags OR'd: the tank's 0x82148 lacks it, the Dreadnought's 0x82748
 * has it, so two tanks are never in contact) — and the pair test passes.
 */
function inContact(state: SimState, a: number, b: number): boolean {
  const ent = state.ent;
  if (!isGroundUnit(ent.archetype[a]) || !isGroundUnit(ent.archetype[b])) return false;
  if (ent.archetype[a] !== ARCHETYPE.JUGGERNAUT && ent.archetype[b] !== ARCHETYPE.JUGGERNAUT) {
    return false;
  }
  // The whole ladder -- the spheres about the reference points, the coarse
  // cylinder, the hit boxes -- where both have imported models (contact.ts,
  // fcop-fidelity.md G1); the sphere alone elsewhere. The Dreadnought's hull
  // only: a gun mount lacks the bit 31 the contact asks of the other party.
  const boxes = bodiesContact(state, a, b, true);
  if (boxes >= 0) return boxes === 1;
  return pairGap(state, a, b) < 0;
}

/** What is left of a follower's leg, world units: the contact's and the yield's measure. */
function legLeft(state: SimState, id: number): number {
  return (state.route.legLength[id] << 8) - state.route.travelled[id];
}

/**
 * One side's contact handler, `self` told of `other`. The Dreadnought's cursor
 * carries flag 0x8 and skips it (0x004247da); a halted cursor (0x40) and an
 * `other` already pushed (a negative hold, 0x004247fb) make no transfer. The
 * one with less of its leg left is in front — when both walk to the same node;
 * otherwise `other` is in front if it comes from where `self` is going — and
 * the pair has to be on one stretch (same node, or the front one comes from
 * where the one behind is going). The front one gains half the speed word of
 * the one behind, to at most twice its top, and a hold of -300; the one
 * behind keeps half its speed word and a hold of +300. Node indices are each
 * net's own, as the original compares them.
 */
function contact(state: SimState, self: number, other: number): void {
  const ent = state.ent;
  const c = state.route;
  const g = state.map.laneGraph as MapLaneGraph;
  if (ent.archetype[self] === ARCHETYPE.JUGGERNAUT) return;
  if (isHalted(state, self) || c.hold[other] < 0) return;
  const selfNode = localNode(g, ent.timerA[self]);
  const otherNode = localNode(g, ent.timerA[other]);
  const swap =
    selfNode === otherNode
      ? legLeft(state, other) < legLeft(state, self)
      : localNode(g, ent.cooldownB[other]) === selfNode;
  const front = swap ? other : self;
  const behind = swap ? self : other;
  const frontNode = localNode(g, ent.timerA[front]);
  const behindNode = localNode(g, ent.timerA[behind]);
  if (behindNode !== frontNode && localNode(g, ent.cooldownB[front]) !== behindNode) return;
  const half = c.velocity[behind] >> 1;
  let pushed = c.velocity[front] + half;
  const limit = ROUTE_SPEED_WORD << 1;
  if (pushed > limit) pushed = limit;
  c.velocity[front] = pushed;
  c.hold[front] = -ROUTE_CONTACT_HOLD;
  c.velocity[behind] = half;
  c.hold[behind] = ROUTE_CONTACT_HOLD;
}

/**
 * The pair walk's contacts among route followers, after every unit has moved:
 * each pair in contact in dense id order, the one the walk tells first
 * (sim.ts toldFirst) handling it first.
 */
export function routeContacts(state: SimState): void {
  const ent = state.ent;
  for (let a = 0; a < ent.high; a++) {
    if (!ent.alive[a] || !isGroundUnit(ent.archetype[a])) continue;
    for (let b = a + 1; b < ent.high; b++) {
      if (!ent.alive[b] || !inContact(state, a, b)) continue;
      const first = toldFirst(state, a, b) ? a : b;
      const second = first === a ? b : a;
      contact(state, first, second);
      contact(state, second, first);
    }
  }
}

// ---------------------------------------------------------------------------
// Traffic (cnet_route_near_actor 0x004248f0)
// ---------------------------------------------------------------------------

/**
 * The original's answer to "something came close", the frame's last actor pass
 * (`cact_post_impulse` 0x0043bf00): it decides how fast, never where. The
 * follower reacts to its single nearest neighbour (the pair test's) whose gap —
 * centre distance less both radii — is under ROUTE_NEAR_GAP, within
 * ROUTE_NEAR_RISE vertically and inside the ROUTE_CONE_COS cone of its heading;
 * a pair the walk told of a contact is not a neighbour.
 * - another route follower: on the same net heading for the same node, the one
 *   with more of its leg left yields; for another node it yields if the other
 *   comes from where it is going or goes where it goes next, and otherwise its
 *   hold is cut to a tick. Yielding is half the other's speed word, capped at
 *   its own top, held 300 engine ticks, and cuts the other's positive hold to
 *   a tick (the deadlock breaker). The other net (the enemy team's) always
 *   yields.
 * - anything else: within ROUTE_NEAR_BLOCK dead ahead it stops; otherwise half
 *   its own speed word plus a quarter of the top, held 300.
 * The Juggernaut (the Dreadnought's route flag 0x8) and a halted follower
 * (CNET_ROUTE_NO_TRAFFIC is 0x48) do not react at all. Aircraft sit far outside the vertical band.
 */
export function routeTraffic(state: SimState, id: number): void {
  const ent = state.ent;
  const c = state.route;
  // CNET_ROUTE_NO_TRAFFIC is 0x48 (0x00424911): the Dreadnought's flag 0x8, and
  // a halted cursor.
  if (ent.archetype[id] === ARCHETYPE.JUGGERNAUT || isHalted(state, id)) return;
  const x = ent.posX[id];
  const y = ent.posY[id];
  const h = ent.height[id];
  const r = entityRadius(state, id);
  let near = -1;
  let nearGap = ROUTE_NEAR_GAP;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || t === id) continue;
    const a = ent.archetype[t];
    if (a === ARCHETYPE.PROJECTILE || a === ARCHETYPE.CONSOLE) continue;
    const dz = ent.height[t] - h;
    if (dz > ROUTE_NEAR_RISE || dz < -ROUTE_NEAR_RISE) continue;
    const dx = ent.posX[t] - x;
    const dy = ent.posY[t] - y;
    const gap = Math.sqrt(dx * dx + dy * dy) - r - entityRadius(state, t);
    if (gap < nearGap && !inContact(state, id, t)) {
      nearGap = gap;
      near = t;
    }
  }
  if (near < 0) return;
  const k3 = id * 3;
  const hx = c.heading[k3 + 2] / 65536;
  const hy = c.heading[k3] / 65536;
  const dx = ent.posX[near] - x;
  const dy = ent.posY[near] - y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len >= ROUTE_NEAR_MIN_LEN && (dx * hx + dy * hy) / len <= ROUTE_CONE_COS) return;

  const top = ROUTE_SPEED_WORD;
  if (isGroundUnit(ent.archetype[near])) {
    let yieldNow = true;
    if (ent.team[near] === ent.team[id]) {
      const node = ent.timerA[id];
      if (ent.timerA[near] === node) {
        yieldNow = legLeft(state, near) < legLeft(state, id);
      } else if (node !== ent.cooldownB[near] && c.next[id] !== ent.timerA[near]) {
        c.hold[id] = ROUTE_HOLD_RELEASE; // not in each other's way: release the hold
        return;
      }
    }
    if (!yieldNow) return;
    const half = i16(c.velocity[near] >> 1);
    c.speed[id] = half > top ? top : half;
    c.hold[id] = ROUTE_HOLD_ENGINE_TICKS;
    if (c.hold[near] > 0) c.hold[near] = ROUTE_HOLD_RELEASE;
    return;
  }
  if (len < ROUTE_NEAR_BLOCK) {
    c.speed[id] = 0;
  } else {
    c.speed[id] = i16((c.velocity[id] >> 1) + (top >> 2));
  }
  c.hold[id] = ROUTE_HOLD_ENGINE_TICKS;
}
