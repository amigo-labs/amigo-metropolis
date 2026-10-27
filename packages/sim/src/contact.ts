// The contact sweep: a round against a body, as the original's pair test
// decides it (fcop-fidelity.md G1, I6, P4).
//
// `cact_pair_test` (RE 0x00450190, game/actor/collide.c) runs on every pair the
// broad phase offers and posts the collision notice (operation 0x0b) only when
// all four rungs of its ladder hold, each on the two actors' current model
// frames:
//
//   1. the spheres: the octagonal distance (`cact_octagonal_norm`, 0x004501a5)
//      between the two REFERENCE POINTS -- box 0's centre of the frame placed
//      through the actor's orientation (`previous`, `math_matrix_place_point`
//      0x00458850) -- less the two `radius_68`s, below zero;
//   2. the coarse cylinder (0x004502f4): the horizontal octagon below the two
//      boxes' horizontal radii (`half_h`, the box's +0x0e) and the vertical
//      distance below their half heights (`half_v`, +0x08);
//   3. the hit boxes (`cact_hit_boxes` 0x0044f640): every Precinct Assault model
//      carries them (4DGI bit 0x08000000), so the both-boxes arm -- each box of
//      one (box 0 only when it is the frame's one, else boxes 1..) rotated into
//      the other's frame and bounded axis-aligned there against each of the
//      other's, and the same the other way round; a pair counts when both
//      passes name it (`box_against_boxes` 0x0044fad0).
//
// A body here is every actor that answers for it: the mech is its legs (the
// type-1 actor, Cobj 15 at the legs' frame) and its cockpit (the type-0x12
// partner, Cobj 16 at the cockpit's frame, standing on the legs' model point 0
// and forwarding a contact to the mech: player_partner.c op 0x0b); a turret its
// gun and its base part (turret_part.c op 0x0b), the gun on the base's attach
// point 0; the Dreadnought its hull and its four gun mounts (mount.c op 0x0b,
// none INDEPENDENT on a Precinct Assault hull). Each round is its own model
// (the catalogue entry's aRSL slot 0), oriented along its flight
// (`math_matrix_from_forward_up`, missile.c 989-1017).
//
// Kept from Metropolis: every orientation is the sim's yaw alone, a turret's gun
// with its pitch (the original tilts the mech and the ground units to the
// ground, banks and pitches the aircraft and turns the cockpit by its aim, none
// of which the sim's bodies carry); the octagon and
// the boxes are in floating metres (the original truncates to 1/16 world unit
// on the way); a body with no imported model, or a round with none, meets the
// other at Metropolis' flat circle (sim.ts roundMeets).

import { ARCHETYPE } from "./archetypes";
import { DREADNOUGHT_GUNS } from "./balance";
import { type MapShapeTable, type MapTurretShape, SHAPE_WORDS } from "./map";
import type { SimState } from "./sim";
import { cosLUT, sinLUT } from "./simMath";
import {
  X1_BOX_WORDS,
  X1_COCKPIT_BOXES,
  X1_LEGS_BOXES,
  X1_LEGS_POINT0,
} from "./x1Shapes.generated";

/** The models' raw halfwords (1/512 m) a metre. */
const RAW_PER_METRE = 512;
/** An angle unit (4096 a turn), radians: the sim's gunYaw unit. */
const ANGLE_UNIT = (2 * Math.PI) / 4096;

/** One frame's table in the metres MapShapeTable holds, from a generated raw list. */
function x1Table(raw: readonly number[]): MapShapeTable {
  const boxes = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) boxes[i] = raw[i] / RAW_PER_METRE;
  return { perFrame: 1, frames: raw.length / X1_BOX_WORDS, boxes };
}

/** The mech's legs (Cobj 15) and cockpit (Cobj 16), one box a frame, on every arena. */
export const X1_LEGS_SHAPE = x1Table(X1_LEGS_BOXES);
export const X1_COCKPIT_SHAPE = x1Table(X1_COCKPIT_BOXES);

/** Word offsets inside a table row (MapShapeTable). */
const CY = 1;
const HY = 4;
const RADIUS = 6;
const HALF_H = 7;

/** A collider: a model's table at a frame, placed and oriented in the world. */
interface Collider {
  table: MapShapeTable | null;
  frame: number;
  /** The model's origin, sim axes (x, y, height). */
  readonly p: Float64Array;
  /** The model's x, y and z axes in sim axes, three each. */
  readonly ax: Float64Array;
  readonly ay: Float64Array;
  readonly az: Float64Array;
}

function collider(): Collider {
  return {
    table: null,
    frame: 0,
    p: new Float64Array(3),
    ax: new Float64Array(3),
    ay: new Float64Array(3),
    az: new Float64Array(3),
  };
}

// Scratch, module scope: the sweep allocates nothing.
const roundC = collider();
const refA = new Float64Array(3);
const refB = new Float64Array(3);
/** A in B's frame: rotation (row k = B's axis k, column j = A's axis j) and translation. */
const rot = new Float64Array(9);
const trans = new Float64Array(3);
const rotT = new Float64Array(9);
const transT = new Float64Array(3);
const boxC = new Float64Array(3);
const boxH = new Float64Array(3);
const perA = new Int32Array(32);

/**
 * The model's axes for a yaw: +z forward along (cos, sin), y up, x the forward
 * turned a quarter to the left -- the frame the sim places every model-frame
 * point in (sim.ts placeGun: a glb's x is the model's negated).
 */
function yawAxes(c: Collider, yaw: number): void {
  const co = cosLUT(yaw);
  const si = sinLUT(yaw);
  c.ax[0] = -si;
  c.ax[1] = co;
  c.ax[2] = 0;
  c.ay[0] = 0;
  c.ay[1] = 0;
  c.ay[2] = 1;
  c.az[0] = co;
  c.az[1] = si;
  c.az[2] = 0;
}

/**
 * Tilts a yaw-placed collider by a gun's pitch (EntityStore.pitch: 12-bit
 * units, negative raising the muzzle), about its own x axis: the turret's
 * `math_matrix_from_angles(yaw, pitch, 0)` (0x0041c7a9).
 */
function pitchAxes(c: Collider, pitch: number): void {
  if (pitch === 0) return;
  const e = -pitch * ANGLE_UNIT;
  const ce = cosLUT(e);
  const se = sinLUT(e);
  for (let k = 0; k < 3; k++) {
    const z = c.az[k];
    const y = c.ay[k];
    c.az[k] = z * ce + y * se;
    c.ay[k] = y * ce - z * se;
  }
}

/**
 * A round's axes: +z along its flight (dx, dy, dh), x level and across it, y
 * completing the frame (`math_matrix_from_forward_up` against the world's up);
 * straight up or down, or not moving, it keeps `yaw`'s level axes.
 */
function flightAxes(c: Collider, dx: number, dy: number, dh: number, yaw: number): void {
  const len = Math.sqrt(dx * dx + dy * dy + dh * dh);
  const level = Math.sqrt(dx * dx + dy * dy);
  if (!(len > 0) || !(level > len * 1e-6)) {
    yawAxes(c, yaw);
    if (len > 0) {
      // Vertical: z along the flight, x level, y = z cross x.
      const zx = 0;
      const zy = 0;
      const zh = dh > 0 ? 1 : -1;
      c.az[0] = zx;
      c.az[1] = zy;
      c.az[2] = zh;
      c.ay[0] = zy * c.ax[2] - zh * c.ax[1];
      c.ay[1] = zh * c.ax[0] - zx * c.ax[2];
      c.ay[2] = zx * c.ax[1] - zy * c.ax[0];
    }
    return;
  }
  const zx = dx / len;
  const zy = dy / len;
  const zh = dh / len;
  c.az[0] = zx;
  c.az[1] = zy;
  c.az[2] = zh;
  // x = up cross z, normalised: level.
  c.ax[0] = -dy / level;
  c.ax[1] = dx / level;
  c.ax[2] = 0;
  // y = z cross x.
  c.ay[0] = zy * c.ax[2] - zh * c.ax[1];
  c.ay[1] = zh * c.ax[0] - zx * c.ax[2];
  c.ay[2] = zx * c.ax[1] - zy * c.ax[0];
}

/** Row `w` of box `i` of the collider's frame. */
function word(c: Collider, i: number, w: number): number {
  const t = c.table as MapShapeTable;
  return t.boxes[(i * t.frames + c.frame) * SHAPE_WORDS + w];
}

/** The collider's reference point: box 0's centre of its frame, placed (`previous`). */
function refPoint(c: Collider, out: Float64Array): void {
  const x = word(c, 0, 0);
  const y = word(c, 0, CY);
  const z = word(c, 0, 2);
  for (let k = 0; k < 3; k++) out[k] = c.p[k] + x * c.ax[k] + y * c.ay[k] + z * c.az[k];
}

/**
 * `cact_octagonal_norm` (0x004501a5): `max + 0.234375 min` while `min <= max /
 * 2`, past that `(75 max + 106 min) / 128 + 0.234375 (max - min)`.
 */
export function octagonalNorm(a: number, b: number): number {
  const p = Math.abs(a);
  const q = Math.abs(b);
  let hi = p > q ? p : q;
  const lo = p > q ? q : p;
  let t = lo;
  if (hi * 0.5 < lo) {
    t = hi - lo;
    hi = (hi * 75 + lo * 106) / 128;
  }
  return hi + t * 0.234375;
}

/** The first box `cact_hit_boxes` walks: 1 when the frame has several (box 0 is the whole). */
function firstBox(t: MapShapeTable): number {
  return t.perFrame > 1 ? 1 : 0;
}

/**
 * `box_against_boxes` (0x0044fad0): box `i` of `a`, through `m` and `t` (a's
 * frame in b's), bounded axis-aligned in b's frame (its half extents' absolute
 * column sums), against every box of `b`: bit j set where box j overlaps it on
 * all three axes, strictly.
 */
function boxMask(a: Collider, i: number, m: Float64Array, t: Float64Array, b: Collider): number {
  for (let k = 0; k < 3; k++) {
    boxC[k] = word(a, i, k);
    boxH[k] = word(a, i, 3 + k);
  }
  const tb = b.table as MapShapeTable;
  let mask = 0;
  for (let j = firstBox(tb); j < tb.perFrame; j++) {
    let overlap = true;
    for (let k = 0; k < 3 && overlap; k++) {
      const c = m[k * 3] * boxC[0] + m[k * 3 + 1] * boxC[1] + m[k * 3 + 2] * boxC[2] + t[k];
      const h =
        Math.abs(m[k * 3]) * boxH[0] +
        Math.abs(m[k * 3 + 1]) * boxH[1] +
        Math.abs(m[k * 3 + 2]) * boxH[2];
      const oc = word(b, j, k);
      const oh = word(b, j, 3 + k);
      overlap = oc - oh < c + h && c - h < oc + oh;
    }
    if (overlap) mask |= 1 << j;
  }
  return mask;
}

/** The collider's model axis `k` (0 x, 1 y, 2 z) in sim axes. */
function axis(c: Collider, k: number): Float64Array {
  return k === 0 ? c.ax : k === 1 ? c.ay : c.az;
}

/** `cact_hit_boxes_blocks`' both-boxes arm (0x0044f71a..0x0044f8f0): a pair both passes name. */
function hitBoxes(a: Collider, b: Collider): boolean {
  // A's frame in B's: rows B's axes, columns A's.
  for (let k = 0; k < 3; k++) {
    const bk = axis(b, k);
    for (let j = 0; j < 3; j++) {
      const aj = axis(a, j);
      rot[k * 3 + j] = bk[0] * aj[0] + bk[1] * aj[1] + bk[2] * aj[2];
    }
    trans[k] = bk[0] * (a.p[0] - b.p[0]) + bk[1] * (a.p[1] - b.p[1]) + bk[2] * (a.p[2] - b.p[2]);
  }
  const ta = a.table as MapShapeTable;
  const tb = b.table as MapShapeTable;
  let union = 0;
  for (let i = firstBox(ta); i < ta.perFrame; i++) {
    perA[i] = boxMask(a, i, rot, trans, b);
    union |= perA[i];
  }
  if (union === 0) return false;
  // And back: B's frame in A's, the transpose.
  for (let k = 0; k < 3; k++) {
    for (let j = 0; j < 3; j++) rotT[k * 3 + j] = rot[j * 3 + k];
  }
  for (let k = 0; k < 3; k++) {
    transT[k] = -(rotT[k * 3] * trans[0] + rotT[k * 3 + 1] * trans[1] + rotT[k * 3 + 2] * trans[2]);
  }
  for (let j = firstBox(tb); j < tb.perFrame; j++) {
    if ((union & (1 << j)) === 0) continue;
    const mask = boxMask(b, j, rotT, transT, a);
    for (let i = firstBox(ta); i < ta.perFrame; i++) {
      if ((mask & (1 << i)) !== 0 && (perA[i] & (1 << j)) !== 0) return true;
    }
  }
  return false;
}

/** `cact_pair_test`'s ladder for two colliders: spheres, cylinder, boxes. */
export function pairTouches(a: Collider, b: Collider): boolean {
  refPoint(a, refA);
  refPoint(b, refB);
  const dx = refA[0] - refB[0];
  const dy = refA[1] - refB[1];
  const dh = refA[2] - refB[2];
  const flat = octagonalNorm(dx, dy);
  const radii = word(a, 0, RADIUS) + word(b, 0, RADIUS);
  if (octagonalNorm(flat, dh) - radii >= 0) return false;
  if (!(flat < word(a, 0, HALF_H) + word(b, 0, HALF_H))) return false;
  if (!(Math.abs(dh) < word(a, 0, HY) + word(b, 0, HY))) return false;
  return hitBoxes(a, b);
}

/** Places `c` at (x, y, h) on `yaw` with `table` at `frame` (clamped into the table). */
function place(
  c: Collider,
  table: MapShapeTable,
  frame: number,
  x: number,
  y: number,
  h: number,
  yaw: number,
): void {
  c.table = table;
  c.frame = frame >= 0 && frame < table.frames ? frame : 0;
  c.p[0] = x;
  c.p[1] = y;
  c.p[2] = h;
  yawAxes(c, yaw);
}

/** A turret's colliders, by its `EntityStore.shape`: 0 the type-8 set, k + 1 neutral spot k's. */
function turretShape(state: SimState, v: number): MapTurretShape | null {
  const sh = state.map.shapes;
  if (v === 0) return sh.baseTurret;
  if (v > 0 && v <= sh.neutral.length) return sh.neutral[v - 1];
  return null;
}

/** Colliders a body has at most: the Dreadnought's hull and four guns. */
const MAX_PARTS = 1 + DREADNOUGHT_GUNS;
const partsA: Collider[] = Array.from({ length: MAX_PARTS }, collider);
const partsB: Collider[] = Array.from({ length: MAX_PARTS }, collider);

/**
 * Fills `out` with body `id`'s colliders as they stand this tick and answers
 * how many, or -1 where it has no imported hit boxes.
 */
function bodyColliders(state: SimState, id: number, out: Collider[]): number {
  const ent = state.ent;
  const sh = state.map.shapes;
  const x = ent.posX[id];
  const y = ent.posY[id];
  const h = ent.height[id];
  const yaw = ent.yaw[id];
  switch (ent.archetype[id]) {
    case ARCHETYPE.AVATAR: {
      // Only an arena that imports its models plays the mech's by frame.
      if (sh.tables.length === 0) return -1;
      const p = ent.ownerId[id];
      if (p < 0 || p >= state.avatarId.length || state.avatarId[p] !== id) return -1;
      const legs = state.walker.legs.frame[p];
      const c = out[0];
      place(c, X1_LEGS_SHAPE, legs, x, y, h, yaw);
      // The partner on the legs' point 0 of the frame, in the legs' placement.
      const f = legs >= 0 && legs < X1_LEGS_SHAPE.frames ? legs : 0;
      const mx = X1_LEGS_POINT0[f * 3] / RAW_PER_METRE;
      const my = X1_LEGS_POINT0[f * 3 + 1] / RAW_PER_METRE;
      const mz = X1_LEGS_POINT0[f * 3 + 2] / RAW_PER_METRE;
      const px = x + mx * c.ax[0] + mz * c.az[0];
      const py = y + mx * c.ax[1] + mz * c.az[1];
      place(out[1], X1_COCKPIT_SHAPE, state.walker.cockpit.frame[p], px, py, h + my, yaw);
      return 2;
    }
    case ARCHETYPE.TURRET: {
      const t = turretShape(state, ent.shape[id]);
      if (t === null) return -1;
      // The base stands at the turret's position on its rest yaw; the gun on
      // the base's point 0, on its own yaw and pitch.
      const c = out[0];
      place(c, sh.tables[t.base], 0, x, y, h, ent.restYaw[id]);
      const gx = x + t.px * c.ax[0] + t.pz * c.az[0];
      const gy = y + t.px * c.ax[1] + t.pz * c.az[1];
      place(out[1], sh.tables[t.gun], 0, gx, gy, h + t.py, yaw);
      pitchAxes(out[1], ent.pitch[id]);
      return 2;
    }
    case ARCHETYPE.JUGGERNAUT: {
      const s = ent.shape[id];
      if (s < 0) return -1;
      const team = ent.team[id];
      const walk = team === 0 || team === 1 ? state.hullWalk[team] : null;
      const frame = walk ? walk.frame[id] : 0;
      place(out[0], sh.tables[s], frame, x, y, h, yaw);
      if ((team !== 0 && team !== 1) || sh.dreadnoughtGuns.length === 0) return 1;
      // Each gun on its hull point of the frame, on its own yaw (sim.ts placeGun).
      const jug = state.map.bases[team].juggernaut;
      const co = cosLUT(yaw);
      const si = sinLUT(yaw);
      let n = 1;
      for (let g = 0; g < jug.guns && g < sh.dreadnoughtGuns.length && n < MAX_PARTS; g++) {
        const m = jug.mounts[g];
        const fr = m.frames;
        const pt = fr !== undefined && frame >= 0 && frame < fr.length ? fr[frame] : m;
        const gx = x + pt.z * co + pt.x * si;
        const gy = y + pt.z * si - pt.x * co;
        const gyaw = yaw + state.gunYaw[id * DREADNOUGHT_GUNS + g] * ANGLE_UNIT;
        place(out[n], sh.tables[sh.dreadnoughtGuns[g]], 0, gx, gy, h + pt.y, gyaw);
        n++;
      }
      return n;
    }
    case ARCHETYPE.RUNNER:
    case ARCHETYPE.GUARDIAN:
    case ARCHETYPE.FORTRESS:
    case ARCHETYPE.WARDEN: {
      const s = ent.shape[id];
      if (s < 0) return -1;
      const arch = ent.archetype[id];
      const u =
        arch === ARCHETYPE.RUNNER
          ? sh.tank
          : arch === ARCHETYPE.GUARDIAN
            ? sh.jet
            : arch === ARCHETYPE.FORTRESS
              ? sh.fortress
              : s < sh.skyCaptain.length
                ? sh.skyCaptain[s]
                : null;
      if (u === null) return -1;
      // The model's origin stands off the position by the unit's lift (the
      // tank's drawn grounding; none for an aircraft).
      const c = out[0];
      place(c, sh.tables[u.table], 0, x, y, h, yaw);
      for (let k = 0; k < 3; k++) c.p[k] += u.lx * c.ax[k] + u.ly * c.ay[k] + u.lz * c.az[k];
      return 1;
    }
    default:
      return -1;
  }
}

/**
 * Whether round `round`, flying along (dx, dy, dh), meets body `target` this
 * tick: 1 or 0 by the original's ladder against each of the body's colliders,
 * -1 where either has no imported hit boxes (the caller then uses Metropolis'
 * flat circle).
 */
export function roundContact(
  state: SimState,
  round: number,
  target: number,
  dx: number,
  dy: number,
  dh: number,
): number {
  const ent = state.ent;
  const sh = state.map.shapes;
  const rs = ent.shape[round];
  if (rs < 0 || rs >= sh.tables.length) return -1;
  const n = bodyColliders(state, target, partsB);
  if (n < 0) return -1;
  const r = roundC;
  r.table = sh.tables[rs];
  r.frame = 0;
  r.p[0] = ent.posX[round];
  r.p[1] = ent.posY[round];
  r.p[2] = ent.height[round];
  flightAxes(r, dx, dy, dh, ent.yaw[round]);
  for (let i = 0; i < n; i++) if (pairTouches(r, partsB[i])) return 1;
  return 0;
}

/**
 * Whether bodies `a` and `b` touch by the original's ladder, any collider of one
 * against any of the other (each forwards its notice to its body), or -1 where
 * either has no imported hit boxes.
 */
export function bodiesContact(state: SimState, a: number, b: number): number {
  const na = bodyColliders(state, a, partsA);
  if (na < 0) return -1;
  const nb = bodyColliders(state, b, partsB);
  if (nb < 0) return -1;
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nb; j++) if (pairTouches(partsA[i], partsB[j])) return 1;
  }
  return 0;
}

/**
 * The mech's legs' `radius_68` and box-0 centre height at legs frame `frame`
 * (`walk_select_frame`, player_walk.c 118-130), metres.
 */
export function legsRadius(frame: number): number {
  const f = frame >= 0 && frame < X1_LEGS_SHAPE.frames ? frame : 0;
  return X1_LEGS_SHAPE.boxes[f * SHAPE_WORDS + RADIUS];
}

export function legsRefHeight(frame: number): number {
  const f = frame >= 0 && frame < X1_LEGS_SHAPE.frames ? frame : 0;
  return X1_LEGS_SHAPE.boxes[f * SHAPE_WORDS + CY];
}
