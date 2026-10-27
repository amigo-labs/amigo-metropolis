// The bodies' orientations beyond the yaw (fcop-fidelity.md I6, U1, A19, G1):
// what the original's model matrices hold and the sim's yaw does not.
//
// * A route follower (the tank, the Dreadnought) on an imported arena: the
//   hull's matrix `cnet_route_orient` (0x00424bc0) builds from the cursor's
//   yaw, pitch and bank, `math_matrix_from_angles(yaw, pitch, bank)` (route.ts
//   orient; RouteCursors.hullYaw / hullPitch / hullBank).
// * An aircraft (the jet, the Flying Fortress, the Sky Captain): its heading
//   for row 2 and the up row `math_matrix_from_forward_up` (0x0043fbc0) last
//   built, in flight from the steer, in the crash from the last up row
//   (units.ts AirState hx..hz, ux..uz).
// * The X1's cockpit (the type-0x12 partner): `math_matrix_from_angles(facing
//   + aim_yaw, aim_pitch, roll)` (`player_partner_tick`, 0x004472c2), its aim
//   stepped toward the lock here (CockpitAim; the roll is the mech's, 0 in
//   every arm the sim plays).
//
// A frame is the model's three axes in the sim's axes (x, y, height): `ax`
// the model's x, `ay` its up, `az` its forward. The sim's (x, y, height) is a
// cyclic turn of the engine's (z, x, y), so the engine's row-vector products
// carry over unchanged: row k of `Mz Mx My` is row k of `Mz Mx` taken over the
// yaw's three rows.

import { ARCHETYPE } from "./archetypes";
import {
  AIRCRAFT_HEADING_ONE,
  COCKPIT_AIM_PITCH_LIMIT,
  COCKPIT_AIM_STEP,
  COCKPIT_AIM_YAW_LIMIT,
  MAX_ENTITIES,
  MAX_PLAYERS,
  WU_PER_METRE,
} from "./balance";
import { angleOf, followsRoutes } from "./route";
import { entityRefHeight, type SimState } from "./sim";
import { cosLUT, sinLUT } from "./simMath";
import { X1_LEGS_POINT0 } from "./x1Shapes.generated";

/** An angle unit (4096 a turn), radians. */
const ANGLE_UNIT = (2 * Math.PI) / 4096;
/** The models' raw halfwords (1/512 m) a metre. */
const RAW_PER_METRE = 512;

/** A model's three axes in the sim's axes (x, y, height). */
export interface Frame {
  readonly ax: Float64Array;
  readonly ay: Float64Array;
  readonly az: Float64Array;
}

export function createFrame(): Frame {
  return { ax: new Float64Array(3), ay: new Float64Array(3), az: new Float64Array(3) };
}

/** A 12-bit angle as radians, -pi..pi. */
export function unitsRadians(units: number): number {
  const u = units & 0xfff;
  return (u > 0x800 ? u - 0x1000 : u) * ANGLE_UNIT;
}

/**
 * The yaw alone (`math_matrix_from_angles(yaw, 0, 0)`): forward along (cos,
 * sin), up the height, x the forward turned a quarter to the left.
 */
export function yawFrame(f: Frame, yaw: number): void {
  const co = cosLUT(yaw);
  const si = sinLUT(yaw);
  f.ax[0] = -si;
  f.ax[1] = co;
  f.ax[2] = 0;
  f.ay[0] = 0;
  f.ay[1] = 0;
  f.ay[2] = 1;
  f.az[0] = co;
  f.az[1] = si;
  f.az[2] = 0;
}

/**
 * `math_matrix_from_angles(yaw, pitch, bank)` (0x0043f470, `Mz Mx My`): the
 * bank about the model's forward, then the pitch about its x (a positive pitch
 * puts the nose down, the original's sign), then the yaw. `yaw` radians,
 * `pitch` and `bank` 12-bit.
 */
export function angleFrame(f: Frame, yaw: number, pitch: number, bank: number): void {
  yawFrame(f, yaw);
  if ((pitch & 0xfff) === 0 && (bank & 0xfff) === 0) return;
  const p = unitsRadians(pitch);
  const b = unitsRadians(bank);
  const cx = cosLUT(p);
  const sx = sinLUT(p);
  const cz = cosLUT(b);
  const sz = sinLUT(b);
  for (let k = 0; k < 3; k++) {
    const x = f.ax[k];
    const y = f.ay[k];
    const z = f.az[k];
    // Rows of Mz Mx: [cz, sz cx, sz sx], [-sz, cz cx, cz sx], [0, -sx, cx].
    f.ax[k] = cz * x + sz * cx * y + sz * sx * z;
    f.ay[k] = -sz * x + cz * cx * y + cz * sx * z;
    f.az[k] = -sx * y + cx * z;
  }
}

/**
 * An aircraft's matrix (`math_matrix_from_forward_up`, 0x0043fbc0): row 2 its
 * heading, row 1 the up row it built, row 0 their cross -- the AirState words
 * are (sim x, height, sim y).
 */
export function airFrame(f: Frame, state: SimState, id: number): void {
  const air = state.air;
  const one = AIRCRAFT_HEADING_ONE;
  let zx = air.hx[id] / one;
  let zy = air.hz[id] / one;
  let zh = air.hy[id] / one;
  const zl = Math.sqrt(zx * zx + zy * zy + zh * zh);
  if (!(zl > 0)) {
    yawFrame(f, state.ent.yaw[id]);
    return;
  }
  zx /= zl;
  zy /= zl;
  zh /= zl;
  let yx = air.ux[id] / one;
  let yy = air.uz[id] / one;
  let yh = air.uy[id] / one;
  // Re-orthogonalised against the stored heading (the matrix holds them so).
  const d = yx * zx + yy * zy + yh * zh;
  yx -= d * zx;
  yy -= d * zy;
  yh -= d * zh;
  const yl = Math.sqrt(yx * yx + yy * yy + yh * yh);
  if (!(yl > 0)) {
    yawFrame(f, state.ent.yaw[id]);
    return;
  }
  f.az[0] = zx;
  f.az[1] = zy;
  f.az[2] = zh;
  f.ay[0] = yx / yl;
  f.ay[1] = yy / yl;
  f.ay[2] = yh / yl;
  // x = y cross z.
  f.ax[0] = f.ay[1] * zh - f.ay[2] * zy;
  f.ax[1] = f.ay[2] * zx - f.ay[0] * zh;
  f.ax[2] = f.ay[0] * zy - f.ay[1] * zx;
}

/** Does `id` carry an orientation beyond its yaw (a route follower's hull, an aircraft)? */
export function isTilted(state: SimState, id: number): boolean {
  const a = state.ent.archetype[id];
  if (a === ARCHETYPE.RUNNER || a === ARCHETYPE.JUGGERNAUT) return followsRoutes(state);
  return a === ARCHETYPE.GUARDIAN || a === ARCHETYPE.FORTRESS || a === ARCHETYPE.WARDEN;
}

/**
 * Body `id`'s model axes as its matrix holds them: a route follower's hull
 * (the cursor's last `cnet_route_orient`), an aircraft's (airFrame), and
 * everything else on the sim's yaw.
 */
export function bodyFrame(f: Frame, state: SimState, id: number): void {
  const a = state.ent.archetype[id];
  if ((a === ARCHETYPE.RUNNER || a === ARCHETYPE.JUGGERNAUT) && followsRoutes(state)) {
    const c = state.route;
    angleFrame(f, unitsRadians(c.hullYaw[id]), c.hullPitch[id], c.hullBank[id]);
    return;
  }
  if (a === ARCHETYPE.GUARDIAN || a === ARCHETYPE.FORTRESS || a === ARCHETYPE.WARDEN) {
    airFrame(f, state, id);
    return;
  }
  yawFrame(f, state.ent.yaw[id]);
}

// ---------------------------------------------------------------------------
// The snapshot (renderer-facing only)
// ---------------------------------------------------------------------------

/**
 * The tilt snapshot: per entity id, TILT_SNAP_STRIDE floats at `id *
 * TILT_SNAP_STRIDE` -- the model's forward (x, y, height) and its up (x, y,
 * height), unit vectors in the sim's axes -- for every body whose matrix is
 * more than its yaw (isTilted); all six 0 for the rest, which the client turns
 * by the entity's yaw alone. Pure read, invisible to hashState.
 */
export const TILT_SNAP_STRIDE = 6;
export const TILT_SNAPSHOT_LEN = MAX_ENTITIES * TILT_SNAP_STRIDE;

const snapFrame = createFrame();

export function writeTiltSnapshot(state: SimState, out: Float32Array): void {
  const ent = state.ent;
  for (let id = 0; id < ent.high; id++) {
    const o = id * TILT_SNAP_STRIDE;
    if (!ent.alive[id] || !isTilted(state, id)) {
      for (let k = 0; k < TILT_SNAP_STRIDE; k++) out[o + k] = 0;
      continue;
    }
    bodyFrame(snapFrame, state, id);
    out[o] = snapFrame.az[0];
    out[o + 1] = snapFrame.az[1];
    out[o + 2] = snapFrame.az[2];
    out[o + 3] = snapFrame.ay[0];
    out[o + 4] = snapFrame.ay[1];
    out[o + 5] = snapFrame.ay[2];
  }
}

// ---------------------------------------------------------------------------
// The cockpit's aim (player_partner_tick 0x004470d0)
// ---------------------------------------------------------------------------

/**
 * Each player's cockpit aim, 12-bit (the mech's +0xec / +0xee): the yaw off the
 * facing and the pitch, the original's sign (a target above pitches it
 * negative). `owner` is the avatar it belongs to: a new X1 starts straight
 * ahead. Hashed.
 */
export interface CockpitAim {
  readonly yaw: Int16Array;
  readonly pitch: Int16Array;
  readonly owner: Int32Array;
}

export function createCockpitAim(): CockpitAim {
  return {
    yaw: new Int16Array(MAX_PLAYERS),
    pitch: new Int16Array(MAX_PLAYERS),
    owner: new Int32Array(MAX_PLAYERS).fill(-1),
  };
}

/** `aim_step` (0x004471df / 0x0044725e): toward `target`, at most COCKPIT_AIM_STEP. */
function aimStep(current: number, target: number): number {
  const diff = target - current;
  if (diff < 0) return diff > -COCKPIT_AIM_STEP ? target : current - COCKPIT_AIM_STEP;
  return diff < COCKPIT_AIM_STEP ? target : current + COCKPIT_AIM_STEP;
}

/** The horizontal distance to the lock (0x00447155..0x004471af): two octagonal folds. */
function aimHorizontal(dx: number, dz: number): number {
  let major = dx < 0 ? -dx : dx;
  let minor = dz < 0 ? -dz : dz;
  if (minor > major) {
    const t = major;
    major = minor;
    minor = t;
  }
  if (minor > major >> 1) {
    const folded = (75 * major + 106 * minor) >> 7;
    minor = major - minor;
    major = folded;
  }
  return (minor >> 2) - (minor >> 6) + major;
}

/** Scratch: the cockpit's mount, metres (module scope, no allocation per tick). */
export const cockpitAt = { x: 0, y: 0, h: 0 };
const mechFrame = createFrame();

/**
 * Where player `p`'s cockpit stands: the legs' model point 0 of their frame
 * (`cact_model_point(mech, .., 0)`, 0x004470f7) placed through the mech's
 * matrix (its yaw), into cockpitAt.
 */
export function cockpitMount(state: SimState, p: number, id: number): void {
  const ent = state.ent;
  const legs = state.walker.legs.frame[p];
  const n = X1_LEGS_POINT0.length / 3;
  const fr = legs >= 0 && legs < n ? legs : 0;
  const mx = X1_LEGS_POINT0[fr * 3] / RAW_PER_METRE;
  const my = X1_LEGS_POINT0[fr * 3 + 1] / RAW_PER_METRE;
  const mz = X1_LEGS_POINT0[fr * 3 + 2] / RAW_PER_METRE;
  yawFrame(mechFrame, ent.yaw[id]);
  cockpitAt.x = ent.posX[id] + mx * mechFrame.ax[0] + mz * mechFrame.az[0];
  cockpitAt.y = ent.posY[id] + mx * mechFrame.ax[1] + mz * mechFrame.az[1];
  cockpitAt.h = ent.height[id] + my;
}

/**
 * The partner's aim, once a tick for every X1 (`player_partner_tick`
 * 0x004470d0, after the mech has moved): toward the lock's reference point
 * from the cockpit's mount -- the pitch `(-angle_of(run, rise)) >> 12`
 * (the `neg` before the `sar`, 0x004471b7), clamped to +-0x190; the yaw the
 * bearing less the facing, above 0x800 a turn less, clamped to +-0x80 -- each
 * stepped COCKPIT_AIM_STEP a tick; straight ahead with no lock. The lock's
 * reference point is its position at its reference height (entityRefHeight),
 * as the sim's other aims take it.
 */
export function systemCockpitAim(state: SimState): void {
  const ent = state.ent;
  const aim = state.cockpitAim;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const id = state.avatarId[p];
    if (
      p === state.wardenPlayer ||
      id < 0 ||
      !ent.alive[id] ||
      ent.archetype[id] !== ARCHETYPE.AVATAR
    ) {
      aim.owner[p] = -1;
      aim.yaw[p] = 0;
      aim.pitch[p] = 0;
      continue;
    }
    if (aim.owner[p] !== id) {
      aim.owner[p] = id;
      aim.yaw[p] = 0;
      aim.pitch[p] = 0;
    }
    const lock = state.lockTarget[p];
    let pitch = 0;
    let yaw = 0;
    if (lock >= 0 && ent.alive[lock]) {
      cockpitMount(state, p, id);
      // World units, the engine's axes: x the sim's y, z the sim's x.
      const dz = Math.round((ent.posX[lock] - cockpitAt.x) * WU_PER_METRE);
      const dx = Math.round((ent.posY[lock] - cockpitAt.y) * WU_PER_METRE);
      const dy = Math.round(
        (ent.height[lock] + entityRefHeight(state, lock) - cockpitAt.h) * WU_PER_METRE,
      );
      pitch = -angleOf(aimHorizontal(dx, dz), dy) >> 12;
      if (pitch < -COCKPIT_AIM_PITCH_LIMIT) pitch = -COCKPIT_AIM_PITCH_LIMIT;
      else if (pitch > COCKPIT_AIM_PITCH_LIMIT) pitch = COCKPIT_AIM_PITCH_LIMIT;
      const facing = Math.floor(ent.yaw[id] / ANGLE_UNIT + 0.5) & 0xfff;
      yaw = ((angleOf(dz, dx) >> 12) - facing) & 0xfff;
      if (yaw > 0x800) yaw -= 0x1000;
      if (yaw < -COCKPIT_AIM_YAW_LIMIT) yaw = -COCKPIT_AIM_YAW_LIMIT;
      else if (yaw > COCKPIT_AIM_YAW_LIMIT) yaw = COCKPIT_AIM_YAW_LIMIT;
    }
    aim.pitch[p] = aimStep(aim.pitch[p], pitch);
    aim.yaw[p] = aimStep(aim.yaw[p], yaw);
  }
}
