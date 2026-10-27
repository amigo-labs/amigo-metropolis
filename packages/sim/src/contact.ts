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
// Every body turns as its matrix does (orient.ts, SIM_VERSION 114): a route
// follower's hull on the cursor's yaw, pitch and bank, an aircraft on its
// heading and up row (its crash tumble too), the cockpit by its aim's yaw and
// pitch, a turret's gun by its pitch. Kept from Metropolis: the mech's legs
// turn by its yaw alone (its own matrix's heading y and roll not modelled); the
// octagon and
// the boxes are in floating metres (the original truncates to 1/16 world unit
// on the way); a body with no imported model, or a round with none, meets the
// other at Metropolis' flat circle (sim.ts roundMeets).

import { ARCHETYPE } from "./archetypes";
import {
  DREADNOUGHT_GUNS,
  PUSH_BOX_STEP,
  PUSH_BOX_STEP_WIDE,
  PUSH_TARGET_GAP,
  SHAPE_BAND_CENTRE,
  SHAPE_BAND_HALF,
  SHAPE_CROUCH_DROP,
  X1_RAMP_FULL,
} from "./balance";
import { type MapShapeTable, type MapTurretShape, SHAPE_WORDS } from "./map";
import { bodyFrame, cockpitAt, cockpitMount, createFrame, type Frame } from "./orient";
import { followsRoutes } from "./route";
import type { SimState } from "./sim";
import { cosLUT, sinLUT } from "./simMath";
import { X1_BOX_WORDS, X1_COCKPIT_BOXES, X1_LEGS_BOXES } from "./x1Shapes.generated";

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

/** Takes frame `f`'s axes into collider `c`. */
function frameAxes(c: Collider, f: Frame): void {
  for (let k = 0; k < 3; k++) {
    c.ax[k] = f.ax[k];
    c.ay[k] = f.ay[k];
    c.az[k] = f.az[k];
  }
}

/**
 * Turns a collider placed on a hull's axes by a mount's yaw within the hull
 * (`math_matrix_from_angles(yaw, 0, 0)` over the hull's matrix, mount.c
 * 0x00425b8e..0x00425bb3): forward `sin g x + cos g z`, x `cos g x - sin g z`.
 */
function mountYaw(c: Collider, g: number): void {
  if (g === 0) return;
  const co = cosLUT(g);
  const si = sinLUT(g);
  for (let k = 0; k < 3; k++) {
    const x = c.ax[k];
    const z = c.az[k];
    c.az[k] = si * x + co * z;
    c.ax[k] = co * x - si * z;
  }
}

/** Scratch: a body's frame (module scope). */
const bodyF = createFrame();

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
      place(out[0], X1_LEGS_SHAPE, legs, x, y, h, yaw);
      // The partner on the legs' point 0 of the frame, in the legs' placement,
      // turned by the facing plus its aim's yaw and pitched by its aim's pitch
      // (`player_partner_tick` 0x004472c2).
      cockpitMount(state, p, id);
      const aim = state.cockpitAim;
      const c = out[1];
      place(
        c,
        X1_COCKPIT_SHAPE,
        state.walker.cockpit.frame[p],
        cockpitAt.x,
        cockpitAt.y,
        cockpitAt.h,
        yaw + aim.yaw[p] * ANGLE_UNIT,
      );
      pitchAxes(c, aim.pitch[p]);
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
      const hull = out[0];
      place(hull, sh.tables[s], frame, x, y, h, yaw);
      bodyFrame(bodyF, state, id);
      frameAxes(hull, bodyF);
      if ((team !== 0 && team !== 1) || sh.dreadnoughtGuns.length === 0) return 1;
      // Each gun on its hull point of the frame (glb x is the model's
      // negated, sim.ts placeGun), through the hull's matrix, on its own yaw
      // within it.
      const jug = state.map.bases[team].juggernaut;
      let n = 1;
      for (let g = 0; g < jug.guns && g < sh.dreadnoughtGuns.length && n < MAX_PARTS; g++) {
        const m = jug.mounts[g];
        const fr = m.frames;
        const pt = fr !== undefined && frame >= 0 && frame < fr.length ? fr[frame] : m;
        const gx = x - pt.x * hull.ax[0] + pt.y * hull.ay[0] + pt.z * hull.az[0];
        const gy = y - pt.x * hull.ax[1] + pt.y * hull.ay[1] + pt.z * hull.az[1];
        const gh = h - pt.x * hull.ax[2] + pt.y * hull.ay[2] + pt.z * hull.az[2];
        const gc = out[n];
        place(gc, sh.tables[sh.dreadnoughtGuns[g]], 0, gx, gy, gh, 0);
        frameAxes(gc, bodyF);
        mountYaw(gc, state.gunYaw[id * DREADNOUGHT_GUNS + g] * ANGLE_UNIT);
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
      // On its matrix (orient.ts bodyFrame). A tank off the road graph stands
      // on the ground, its model's origin off the position by the drawing's
      // lift; a route follower's position is its origin (the cursor's height,
      // route.ts), as an aircraft's is.
      const c = out[0];
      place(c, sh.tables[u.table], 0, x, y, h, yaw);
      bodyFrame(bodyF, state, id);
      frameAxes(c, bodyF);
      if (arch === ARCHETYPE.RUNNER && !followsRoutes(state)) {
        for (let k = 0; k < 3; k++) c.p[k] += u.lx * c.ax[k] + u.ly * c.ay[k] + u.lz * c.az[k];
      }
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
 * either has no imported hit boxes. `bumpable`: only the colliders whose actor
 * a route follower's contact answers -- the Dreadnought's hull, not its four
 * gun mounts, which spawn with the hull's flags less bit 31 (`and` 0x7fffdfff
 * at 0x00425fdd) that `cnet_route_contact` asks of the other party
 * (0x004247e5), so a tank's touch on a mount alone transfers nothing.
 */
export function bodiesContact(state: SimState, a: number, b: number, bumpable = false): number {
  let na = bodyColliders(state, a, partsA);
  if (na < 0) return -1;
  let nb = bodyColliders(state, b, partsB);
  if (nb < 0) return -1;
  if (bumpable) {
    if (state.ent.archetype[a] === ARCHETYPE.JUGGERNAUT) na = 1;
    if (state.ent.archetype[b] === ARCHETYPE.JUGGERNAUT) nb = 1;
  }
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

// ---------------------------------------------------------------------------
// The actors' contacts' push (fcop-fidelity.md P4)
// ---------------------------------------------------------------------------
//
// The mech's own contacts, every movement step of either form
// (`player_push_contacts` 0x00442e70, from the walker's tick at 0x00444b6b and
// the hover's at 0x00442dc1): who is tried is the viewport's target record --
// every actor carrying flag 0x40 that `cact_pair_test` found within a sphere
// gap of 0x1800 wu of the mech's legs (0x00450257..0x00450283; the mech carries
// 0x40000000, 0x00446b22) -- and, with two viewports, the other mech
// (0x00442f27..0x00442f4d). Each is met by the mech's own contact model, a
// one-box model `player_shape_bind` (0x00441c40) plants and
// `player_transform_shape` (0x00441cf0) / `player_bounds_pair` (0x00444f00)
// fill (SimState.avatarShape): `player_push_pair` (0x00442f70) gates on the
// horizontal octagon between the two reference points less sixteen times both
// blocks' +0x46 and on |dy| less sixteen times both +0x44 -- no radii -- then
// asks `cact_hit_boxes_blocks` (0x0044f640) with the contact model first; each
// of the other's met boxes pushes the mech (`player_push_from_box` 0x004431d0):
// the mech's reference point in that box's frame, against its centre, a step of
// +-0x2400 per axis (0x4000 for an actor with flag 0x400), the vertical step
// dropped and the horizontal ones halved or dropped while inside the box's
// vertical half extent, back through the box's frame, and its horizontal part
// x16 into the impulse the wall push fills (`cact_view` +0x150 is the ride
// block's impulse, RE M3-OV). Every PA model carries hit boxes, so the sphere
// arm (bit 0, a model without boxes) never runs there.

/** Words a player's contact model holds in SimState.avatarShape (box halfwords). */
export const SHAPE_STATE_WORDS = 8;
/** Its box's centre x, y, z and half x, y, z; then the block's +0x44 and +0x46. */
const S_HALF_Y = 6;
const S_WORD_E = 7;

/**
 * `player_transform_shape` (0x00441cf0) at transform progress `progress`
 * (0..0x10000) on the legs' frame `frame`: the legs' box 0 of that frame, its
 * half x widened by a quarter, its centre z walked forward by its half depth and
 * its half depth doubled at full progress; the vertical band A = 0x126 falling
 * to 0x73, B = 0x19 falling to 0; the block's +0x44 = A and +0x46 the
 * horizontal radius `math_sqrt_16_16(sum >> 8) >> 4`. Retail's shifts and
 * truncations as written there.
 */
export function shapeTransform(state: SimState, p: number, frame: number, progress: number): void {
  const f = frame >= 0 && frame < X1_LEGS_SHAPE.frames ? frame : 0;
  const o = f * X1_BOX_WORDS;
  const cx = X1_LEGS_BOXES[o];
  const cz = X1_LEGS_BOXES[o + 2];
  const hx = X1_LEGS_BOXES[o + 3];
  const hz = X1_LEGS_BOXES[o + 5];
  const wideX = hx + (Math.imul(progress >> 2, hx) >> 16);
  const walkZ = cz + (Math.imul(hz, progress) >> 16);
  const longZ = Math.imul((progress >> 4) + 0x1000, hz) >> 12;
  const bandCentre = (-Math.imul(358, progress) >> 17) + SHAPE_BAND_CENTRE;
  const bandHalf = Math.imul(X1_RAMP_FULL - progress, 51) >> 17;
  const sum2d = Math.imul(longZ, longZ) + Math.imul(wideX, wideX);
  const radius2d = Math.floor(Math.sqrt((sum2d >> 8) * 65536));
  const s = state.avatarShape;
  const b = p * SHAPE_STATE_WORDS;
  s[b] = cx;
  s[b + 1] = bandCentre + bandHalf;
  s[b + 2] = walkZ;
  s[b + 3] = wideX;
  s[b + 4] = bandCentre - bandHalf;
  s[b + 5] = longZ;
  s[b + S_HALF_Y] = bandCentre;
  s[b + S_WORD_E] = radius2d >> 4;
}

/**
 * `player_bounds_pair` (0x00444f00): the contact box's centre y and half height
 * standing (0x126 +- 0x19) or crouched (0x126 - 0x5a +- 0x19); nothing else.
 */
export function shapeBounds(state: SimState, p: number, lowered: boolean): void {
  const centre = SHAPE_BAND_CENTRE - (lowered ? SHAPE_CROUCH_DROP : 0);
  const b = p * SHAPE_STATE_WORDS;
  state.avatarShape[b + 1] = centre + SHAPE_BAND_HALF;
  state.avatarShape[b + 4] = centre - SHAPE_BAND_HALF;
}

/** The two players' contact models as tables (one box, one frame), metres. */
const shapeTables: MapShapeTable[] = Array.from({ length: 2 }, () => ({
  perFrame: 1,
  frames: 1,
  boxes: new Float64Array(SHAPE_WORDS),
}));
const mineC = collider();
const theirsC = collider();
const mineRef = new Float64Array(3);
const theirRef = new Float64Array(3);
const perS = new Int32Array(32);
const stepW = new Float64Array(3);

/** Player `p`'s contact model placed on its mech `id`, or false where it has no shape. */
function placeShape(state: SimState, p: number, id: number, c: Collider): boolean {
  if (p < 0 || p >= shapeTables.length) return false;
  const t = shapeTables[p];
  const s = state.avatarShape;
  const b = p * SHAPE_STATE_WORDS;
  for (let k = 0; k < 6; k++) t.boxes[k] = s[b + k] / RAW_PER_METRE;
  t.boxes[RADIUS] = 0;
  t.boxes[HALF_H] = s[b + S_WORD_E] / RAW_PER_METRE;
  const ent = state.ent;
  place(c, t, 0, ent.posX[id], ent.posY[id], ent.height[id], ent.yaw[id]);
  return true;
}

/**
 * `cact_hit_boxes_blocks`' both-boxes arm (0x0044f71a..0x0044f8f0) with `a`
 * first: the boxes of `b` that a pair both passes name met, bit j for box j.
 */
function hitBoxMaskB(a: Collider, b: Collider): number {
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
    perS[i] = boxMask(a, i, rot, trans, b);
    union |= perS[i];
  }
  if (union === 0) return 0;
  for (let k = 0; k < 3; k++) {
    for (let j = 0; j < 3; j++) rotT[k * 3 + j] = rot[j * 3 + k];
  }
  for (let k = 0; k < 3; k++) {
    transT[k] = -(rotT[k * 3] * trans[0] + rotT[k * 3 + 1] * trans[1] + rotT[k * 3 + 2] * trans[2]);
  }
  let result = 0;
  for (let j = firstBox(tb); j < tb.perFrame; j++) {
    if ((union & (1 << j)) === 0) continue;
    const mask = boxMask(b, j, rotT, transT, a);
    for (let i = firstBox(ta); i < ta.perFrame; i++) {
      if ((mask & (1 << i)) !== 0 && (perS[i] & (1 << j)) !== 0) result |= 1 << j;
    }
  }
  return result;
}

/**
 * `player_push_from_box` (0x004431d0): box `j` of `c` pushes the mech whose
 * reference point is `mineRef` by `mag` per axis of the box's frame.
 */
function pushFromBox(c: Collider, j: number, mag: number, out: PushOut): void {
  const rx = mineRef[0] - c.p[0];
  const ry = mineRef[1] - c.p[1];
  const rh = mineRef[2] - c.p[2];
  for (let k = 0; k < 3; k++) {
    const ak = axis(c, k);
    const err = ak[0] * rx + ak[1] * ry + ak[2] * rh - word(c, j, k);
    // `jge` (0x0044325e): an error of zero steps positive.
    stepW[k] = err < 0 ? -mag : mag;
    boxC[k] = err;
  }
  // 0x004432a0: gated on the box's vertical half extent alone.
  if (Math.abs(boxC[1]) < word(c, j, 4)) {
    stepW[1] = 0;
    const in0 = Math.abs(boxC[0]) < word(c, j, 3);
    const in2 = Math.abs(boxC[2]) < word(c, j, 5);
    if (in0 && in2) {
      stepW[0] /= 2;
      stepW[2] /= 2;
    } else if (in0) {
      stepW[0] = 0;
    } else if (in2) {
      stepW[2] = 0;
    }
  }
  // Back through the box's frame, its axes as the 16.16 words retail's matrix
  // holds (`math_matrix_transform_i16`, the sum shifted down sixteen); only the
  // two horizontal words, x16 (0x0044332a, 0x0044334d).
  out.ix += placeStep(c.ax[0], c.ay[0], c.az[0]) * 16;
  out.iy += placeStep(c.ax[1], c.ay[1], c.az[1]) * 16;
}

/** One world word of the step through a frame row (x, y, z), floored as `sar 16`. */
function placeStep(x: number, y: number, z: number): number {
  const sum =
    Math.round(x * 65536) * stepW[0] +
    Math.round(y * 65536) * stepW[1] +
    Math.round(z * 65536) * stepW[2];
  return Math.floor(sum / 65536);
}

/** What one mech's push met this step: the impulse it adds and who touched it. */
export interface PushOut {
  ix: number;
  iy: number;
  count: number;
  /** The entity whose actor met the mech, one row per actor (a hull and two mounts: three). */
  readonly touched: Int32Array;
}

export const PUSH_OUT: PushOut = { ix: 0, iy: 0, count: 0, touched: new Int32Array(64) };

/**
 * `player_push_pair` (0x00442f70) for the mech's contact model against `c`,
 * whose coarse half extents are its box 0's (`halfH` +0x46, `halfY` +0x44):
 * the two gates on the reference points, the boxes, the push. True when met.
 */
function pushPair(
  state: SimState,
  p: number,
  c: Collider,
  ref: Float64Array,
  halfH: number,
  halfY: number,
  mag: number,
  out: PushOut,
): boolean {
  const s = state.avatarShape;
  const b = p * SHAPE_STATE_WORDS;
  const flat = octagonalNorm(mineRef[0] - ref[0], mineRef[1] - ref[1]);
  if (flat - halfH - s[b + S_WORD_E] / RAW_PER_METRE >= 0) return false;
  if (Math.abs(mineRef[2] - ref[2]) - halfY - s[b + S_HALF_Y] / RAW_PER_METRE >= 0) return false;
  const mask = hitBoxMaskB(mineC, c);
  if (mask === 0) return false;
  const t = c.table as MapShapeTable;
  for (let j = 0; j < t.perFrame; j++) if ((mask & (1 << j)) !== 0) pushFromBox(c, j, mag, out);
  return true;
}

/**
 * Player `p`'s actors' contacts this step (`player_push_contacts` 0x00442e70):
 * fills PUSH_OUT with the impulse (16.16 a step, sim x and y) and the touchers,
 * and answers how many met. `twoViews`: the other mech is tried too, by its own
 * contact model where it stands. Only on an arena that imports its models.
 */
export function pushContacts(state: SimState, p: number, twoViews: boolean): number {
  const out = PUSH_OUT;
  out.ix = 0;
  out.iy = 0;
  out.count = 0;
  const ent = state.ent;
  const id = state.avatarId[p];
  if (id < 0 || state.map.shapes.tables.length === 0) return 0;
  if (bodyColliders(state, id, partsA) < 0) return 0;
  const legs = partsA[0];
  refPoint(legs, mineRef);
  const rLegs = word(legs, 0, RADIUS);
  if (!placeShape(state, p, id, mineC)) return 0;
  let met = 0;
  for (let e = 0; e < ent.high; e++) {
    if (!ent.alive[e] || e === id) continue;
    const arch = ent.archetype[e];
    // The bodies whose actors carry flag 0x40: tank 0x82148, jet 0x80148,
    // Fortress 0x90348, Dreadnought 0x82748 (its mounts copy it, 0x00425fdd),
    // turret 0x148 (gun and base part, 0x0041cfdd), neutral 0x110148, Sky
    // Captain 0x92348. Not the mech (0x00446b22 clears it), not a round.
    if (arch === ARCHETYPE.AVATAR || arch === ARCHETYPE.PROJECTILE || arch === ARCHETYPE.CONSOLE) {
      continue;
    }
    const n = bodyColliders(state, e, partsB);
    if (n < 0) continue;
    const mag = arch === ARCHETYPE.JUGGERNAUT ? PUSH_BOX_STEP_WIDE : PUSH_BOX_STEP;
    for (let i = 0; i < n; i++) {
      const c = partsB[i];
      refPoint(c, theirRef);
      const flat = octagonalNorm(mineRef[0] - theirRef[0], mineRef[1] - theirRef[1]);
      const gap = octagonalNorm(flat, mineRef[2] - theirRef[2]) - rLegs - word(c, 0, RADIUS);
      if (gap >= PUSH_TARGET_GAP) continue;
      if (pushPair(state, p, c, theirRef, word(c, 0, HALF_H), word(c, 0, HY), mag, out)) {
        met++;
        if (out.count < out.touched.length) out.touched[out.count++] = e;
      }
    }
  }
  if (twoViews) {
    // The other slot (0x511fd4 - 4 * slot), by its contact model where it
    // stands now: the shape its own last call filled.
    const q = p ^ 1;
    const other = q < state.avatarId.length ? state.avatarId[q] : -1;
    if (
      other >= 0 &&
      ent.alive[other] &&
      ent.archetype[other] === ARCHETYPE.AVATAR &&
      bodyColliders(state, other, partsB) >= 0 &&
      placeShape(state, q, other, theirsC)
    ) {
      refPoint(partsB[0], theirRef);
      const b = q * SHAPE_STATE_WORDS;
      const halfH = state.avatarShape[b + S_WORD_E] / RAW_PER_METRE;
      const halfY = state.avatarShape[b + S_HALF_Y] / RAW_PER_METRE;
      if (pushPair(state, p, theirsC, theirRef, halfH, halfY, PUSH_BOX_STEP, out)) {
        met++;
        if (out.count < out.touched.length) out.touched[out.count++] = other;
      }
    }
  }
  return met;
}
