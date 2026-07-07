// The simulation core. API surface per architecture.md §2 — keep this exact
// shape: createSim / step / hash / writeSnapshot.
//
// System order inside step() is FIXED and part of determinism (order is
// behavior — document any change):
//   input → avatar movement → unit lane-following → targeting → projectiles →
//   damage/death → capture progress → economy → spawning → win check.
// Phase 1 implements input + avatar movement (walker/hover/jump/transform);
// later phases fill in the rest WITHOUT reordering.

import { ARCHETYPE } from "./archetypes";
import {
  ARCHETYPE_MAX_HP,
  AVATAR_AMMO_HEAVY,
  AVATAR_AMMO_SPECIAL,
  AVATAR_HOVER_MAX_SLOPE,
  AVATAR_HOVER_SPEED,
  AVATAR_HP,
  AVATAR_JUMP_SPEED,
  AVATAR_WALKER_MAX_SLOPE,
  AVATAR_WALKER_SPEED,
  GRAVITY,
  HOVER_CLEARANCE,
  HOVER_TRACTION,
  MAX_PLAYERS,
  TICK_DT,
  TRANSFORM_LOCK_TICKS,
} from "./balance";
import { createEntityStore, type EntityStore, spawn } from "./entities";
import { fnv1aBytes, fnv1aInit, fnv1aU32 } from "./hash";
import { BUTTON_JUMP, BUTTON_TRANSFORM, type TickInputs } from "./inputs";
import { isWater, type MapData, sampleHeight, worldExtent } from "./map";
import { atan2Poly } from "./simMath";

// Avatar modes (EntityStore.mode).
export const MODE_WALKER = 0;
export const MODE_HOVER = 1;

// animState bits (renderer-facing; snapshot field 7).
export const ANIM_MOVING = 1 << 0;
export const ANIM_HOVER = 1 << 1;
export const ANIM_AIRBORNE = 1 << 2;
export const ANIM_TRANSFORMING = 1 << 3;

export interface SimState {
  /** The only clock the sim knows. */
  tick: number;
  /** mulberry32 state word. */
  prng: number;
  readonly map: MapData;
  readonly ent: EntityStore;
  /** Entity id of each player's avatar, -1 while dead/none. */
  readonly avatarId: Int32Array;
  /** Ticks until the player's avatar respawns (0 = not pending). */
  readonly respawnTimer: Int32Array;
  /** Previous tick's buttons per player, for edge detection. */
  readonly lastButtons: Uint8Array;
  /** Points ledger per player (stub economy until Phase 3). */
  readonly points: Uint32Array;
}

/** Spawns a fresh avatar for `player` at its map spawn point. */
export function spawnAvatar(state: SimState, player: number): number {
  const ent = state.ent;
  const s = state.map.spawns[player];
  const id = spawn(ent, ARCHETYPE.AVATAR, player);
  if (id < 0) return -1;
  ent.posX[id] = s.x;
  ent.posY[id] = s.y;
  ent.height[id] = sampleHeight(state.map, s.x, s.y);
  ent.yaw[id] = s.yaw;
  ent.hp[id] = AVATAR_HP;
  ent.mode[id] = MODE_WALKER;
  ent.ammoA[id] = AVATAR_AMMO_HEAVY;
  ent.ammoB[id] = AVATAR_AMMO_SPECIAL;
  ent.ownerId[id] = -1;
  state.avatarId[player] = id;
  return id;
}

export function createSim(map: MapData, seed: number): SimState {
  const state: SimState = {
    tick: 0,
    prng: seed | 0,
    map,
    ent: createEntityStore(),
    avatarId: new Int32Array(MAX_PLAYERS).fill(-1),
    respawnTimer: new Int32Array(MAX_PLAYERS),
    lastButtons: new Uint8Array(MAX_PLAYERS),
    points: new Uint32Array(MAX_PLAYERS),
  };
  for (let p = 0; p < MAX_PLAYERS; p++) {
    spawnAvatar(state, p);
  }
  return state;
}

const AXIS_SCALE = 1 / 127;
const GROUND_EPS = 0.001;
/** Height changes up to this snap to the terrain; larger drops become falls. */
const STEP_SNAP = 0.35;

/**
 * Ground the avatar rides on: hover floats on the water surface wherever the
 * terrain dips below it (not just on masked cells — the mask is per-vertex
 * while terrain is bilinear, so banks dip below the surface slightly before
 * the mask starts; without this the hover would be slope-blocked at banks).
 */
function rideHeight(map: MapData, x: number, y: number, hover: boolean): number {
  const g = sampleHeight(map, x, y);
  if (hover && g < map.waterLevel) return map.waterLevel;
  return g;
}

/** input + avatar movement: transform, jump/gravity, slope/water rules. */
function systemAvatarMovement(state: SimState, inputs: TickInputs): void {
  const ent = state.ent;
  const map = state.map;
  const extent = worldExtent(map);
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const id = state.avatarId[p];
    if (id < 0) continue;
    const input = inputs.players[p];
    const pressed = input.buttons & ~state.lastButtons[p];
    state.lastButtons[p] = input.buttons;

    const locked = ent.timerA[id] > 0;
    if (locked) ent.timerA[id] -= 1;

    let x = ent.posX[id];
    let y = ent.posY[id];
    let hover = ent.mode[id] === MODE_HOVER;
    let ride = rideHeight(map, x, y, hover);
    // Hover always counts as grounded (it rides its clearance height).
    const grounded = hover || (ent.height[id] <= ride + GROUND_EPS && ent.timerB[id] <= 0);

    // Transform (edge-triggered): grounded only, never into walker over water.
    if (!locked && (pressed & BUTTON_TRANSFORM) !== 0 && grounded) {
      if (!(hover && isWater(map, x, y))) {
        hover = !hover;
        ent.mode[id] = hover ? MODE_HOVER : MODE_WALKER;
        ent.timerA[id] = TRANSFORM_LOCK_TICKS;
        ride = rideHeight(map, x, y, hover);
      }
    }
    const nowLocked = ent.timerA[id] > 0;

    // Desired move direction (unit-clamped); zero while transform-locked.
    let mx = nowLocked ? 0 : input.moveX * AXIS_SCALE;
    let my = nowLocked ? 0 : input.moveY * AXIS_SCALE;
    const l2 = mx * mx + my * my;
    if (l2 > 1) {
      const inv = 1 / Math.sqrt(l2);
      mx *= inv;
      my *= inv;
    }

    // Traction model: walker is exact, hover drifts toward the target.
    if (hover) {
      ent.velX[id] += (mx * AVATAR_HOVER_SPEED - ent.velX[id]) * HOVER_TRACTION;
      ent.velY[id] += (my * AVATAR_HOVER_SPEED - ent.velY[id]) * HOVER_TRACTION;
    } else {
      ent.velX[id] = mx * AVATAR_WALKER_SPEED;
      ent.velY[id] = my * AVATAR_WALKER_SPEED;
    }

    // Jump (walker only, grounded, edge-triggered).
    if (!hover && !nowLocked && grounded && (pressed & BUTTON_JUMP) !== 0) {
      ent.timerB[id] = AVATAR_JUMP_SPEED;
    }
    const airborne = !hover && (ent.height[id] > ride + GROUND_EPS || ent.timerB[id] > 0);

    // Horizontal movement, axis-separated for wall sliding. Uphill steps
    // beyond the slope limit are blocked; walkers never enter water. The
    // slope compares ride heights (ground to ground) — never ent.height,
    // which includes hover clearance. Airborne walkers skip the check so a
    // jump can carry them onto a ledge.
    const maxSlope = hover ? AVATAR_HOVER_MAX_SLOPE : AVATAR_WALKER_MAX_SLOPE;
    const stepX = ent.velX[id] * TICK_DT;
    if (stepX !== 0) {
      const nx = Math.min(Math.max(x + stepX, 0), extent);
      let ok = true;
      if (!hover && isWater(map, nx, y)) ok = false;
      if (ok && !airborne) {
        const rise = rideHeight(map, nx, y, hover) - rideHeight(map, x, y, hover);
        if (rise > GROUND_EPS && rise > Math.abs(nx - x) * maxSlope) ok = false;
      }
      if (ok) x = nx;
      else ent.velX[id] = 0;
    }
    const stepY = ent.velY[id] * TICK_DT;
    if (stepY !== 0) {
      const ny = Math.min(Math.max(y + stepY, 0), extent);
      let ok = true;
      if (!hover && isWater(map, x, ny)) ok = false;
      if (ok && !airborne) {
        const rise = rideHeight(map, x, ny, hover) - rideHeight(map, x, y, hover);
        if (rise > GROUND_EPS && rise > Math.abs(ny - y) * maxSlope) ok = false;
      }
      if (ok) y = ny;
      else ent.velY[id] = 0;
    }
    ent.posX[id] = x;
    ent.posY[id] = y;

    // Vertical: hover snaps to its ride height; walker snaps to terrain for
    // step-sized height changes and integrates gravity for real falls/jumps.
    ride = rideHeight(map, x, y, hover);
    if (hover) {
      ent.height[id] = ride + HOVER_CLEARANCE;
      ent.timerB[id] = 0;
    } else {
      let h = ent.height[id];
      if (ent.timerB[id] > 0 || h > ride + STEP_SNAP) {
        ent.timerB[id] -= GRAVITY * TICK_DT;
        h += ent.timerB[id] * TICK_DT;
        if (h <= ride) {
          h = ride;
          ent.timerB[id] = 0;
        }
      } else {
        h = ride;
        ent.timerB[id] = 0;
      }
      ent.height[id] = h;
    }

    // Facing: aim wins over movement; both quantized already.
    const ax = input.aimX * AXIS_SCALE;
    const ay = input.aimY * AXIS_SCALE;
    if (ax * ax + ay * ay > 0.04) {
      const inv = 1 / Math.sqrt(ax * ax + ay * ay);
      ent.aimX[id] = ax * inv;
      ent.aimY[id] = ay * inv;
      ent.yaw[id] = atan2Poly(ay, ax);
    } else if (l2 > 0) {
      const inv = 1 / Math.sqrt(l2);
      ent.aimX[id] = mx * inv;
      ent.aimY[id] = my * inv;
      ent.yaw[id] = atan2Poly(my, mx);
    }

    ent.animState[id] =
      (l2 > 0 ? ANIM_MOVING : 0) |
      (hover ? ANIM_HOVER : 0) |
      (ent.height[id] > rideHeight(map, x, y, hover) + GROUND_EPS ? ANIM_AIRBORNE : 0) |
      (ent.timerA[id] > 0 ? ANIM_TRANSFORMING : 0);
  }
}

/** Advances the sim by exactly one tick. Synchronous, allocation-free. */
export function step(state: SimState, inputs: TickInputs): void {
  systemAvatarMovement(state, inputs);
  // systemLaneFollowing(state)   — Phase 2
  // systemTargeting(state)       — Phase 1 (weapons commit)
  // systemProjectiles(state)     — Phase 1 (weapons commit)
  // systemDamageDeath(state)     — Phase 1 (weapons commit)
  // systemCapture(state)         — Phase 3
  // systemEconomy(state)         — Phase 3
  // systemSpawning(state)        — Phase 1 (respawn, weapons commit)
  // systemWinCheck(state)        — Phase 2
  state.tick += 1;
}

/**
 * FNV-1a 32-bit over canonical state: scalars, the contiguous entity-field
 * byte region, the live part of the free-list, and per-player state.
 * The map is immutable per match and identified in the replay header, so it
 * is deliberately not hashed per tick.
 */
export function hash(state: SimState): number {
  const ent = state.ent;
  let h = fnv1aInit();
  h = fnv1aU32(h, state.tick >>> 0);
  h = fnv1aU32(h, state.prng >>> 0);
  h = fnv1aU32(h, ent.high >>> 0);
  h = fnv1aU32(h, ent.freeCount >>> 0);
  h = fnv1aBytes(h, ent.bytes, 0, ent.fieldBytes);
  for (let i = 0; i < ent.freeCount; i++) {
    h = fnv1aU32(h, ent.freeList[i] >>> 0);
  }
  for (let p = 0; p < MAX_PLAYERS; p++) {
    h = fnv1aU32(h, state.avatarId[p] >>> 0);
    h = fnv1aU32(h, state.respawnTimer[p] >>> 0);
    h = fnv1aU32(h, state.lastButtons[p]);
    h = fnv1aU32(h, state.points[p] >>> 0);
  }
  return h;
}

/** Snapshot record layout (architecture.md §3). */
export const SNAPSHOT_STRIDE = 10;

/**
 * Writes all live entities into `out` (stride 10, dense id order):
 * [id, archetype, teamId, x, y, height, yaw, animState, hpFrac, aux].
 * Returns the entity count. The renderer consumes ONLY this.
 */
export function writeSnapshot(state: SimState, out: Float32Array): number {
  const ent = state.ent;
  let n = 0;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id]) continue;
    const o = n * SNAPSHOT_STRIDE;
    out[o] = id;
    out[o + 1] = ent.archetype[id];
    out[o + 2] = ent.team[id];
    out[o + 3] = ent.posX[id];
    out[o + 4] = ent.posY[id];
    out[o + 5] = ent.height[id];
    out[o + 6] = ent.yaw[id];
    out[o + 7] = ent.animState[id];
    out[o + 8] = ent.hp[id] / ARCHETYPE_MAX_HP[ent.archetype[id]];
    out[o + 9] = ent.aux[id];
    n += 1;
  }
  return n;
}
