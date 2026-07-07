// The simulation core. API surface per architecture.md §2 — keep this exact
// shape: createSim / step / hash / writeSnapshot.
//
// System order inside step() is FIXED and part of determinism (order is
// behavior — document any change):
//   input → avatar movement → unit lane-following → targeting → projectiles →
//   damage/death → capture progress → economy → spawning → win check.
// Phase 0 implements input + avatar movement; later phases fill in the rest
// WITHOUT reordering.

import { ARCHETYPE } from "./archetypes";
import { ARCHETYPE_MAX_HP, AVATAR_HP, AVATAR_WALKER_SPEED, MAX_PLAYERS, TICK_DT } from "./balance";
import { createEntityStore, type EntityStore, spawn } from "./entities";
import { fnv1aBytes, fnv1aInit, fnv1aU32 } from "./hash";
import type { TickInputs } from "./inputs";
import { type MapData, sampleHeight, worldExtent } from "./map";
import { atan2Poly } from "./simMath";

export interface SimState {
  /** The only clock the sim knows. */
  tick: number;
  /** mulberry32 state word. */
  prng: number;
  readonly map: MapData;
  readonly ent: EntityStore;
  /** Entity id of each player's avatar, -1 when none exists. */
  readonly avatarId: Int32Array;
}

export function createSim(map: MapData, seed: number): SimState {
  const ent = createEntityStore();
  const avatarId = new Int32Array(MAX_PLAYERS).fill(-1);
  const state: SimState = { tick: 0, prng: seed | 0, map, ent, avatarId };
  // Phase 0: one debug avatar for player 0 at the map center.
  const half = worldExtent(map) / 2;
  const id = spawn(ent, ARCHETYPE.AVATAR, 0);
  if (id >= 0) {
    ent.posX[id] = half;
    ent.posY[id] = half;
    ent.height[id] = sampleHeight(map, half, half);
    ent.hp[id] = AVATAR_HP;
    avatarId[0] = id;
  }
  return state;
}

const AXIS_SCALE = 1 / 127;

/** input + avatar movement (Phase 0: walker rules only, no jump/transform). */
function systemAvatarMovement(state: SimState, inputs: TickInputs): void {
  const ent = state.ent;
  const extent = worldExtent(state.map);
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const id = state.avatarId[p];
    if (id < 0) continue;
    const input = inputs.players[p];
    let mx = input.moveX * AXIS_SCALE;
    let my = input.moveY * AXIS_SCALE;
    const l2 = mx * mx + my * my;
    if (l2 > 1) {
      const inv = 1 / Math.sqrt(l2);
      mx *= inv;
      my *= inv;
    }
    ent.velX[id] = mx * AVATAR_WALKER_SPEED;
    ent.velY[id] = my * AVATAR_WALKER_SPEED;
    const x = Math.min(Math.max(ent.posX[id] + ent.velX[id] * TICK_DT, 0), extent);
    const y = Math.min(Math.max(ent.posY[id] + ent.velY[id] * TICK_DT, 0), extent);
    ent.posX[id] = x;
    ent.posY[id] = y;
    ent.height[id] = sampleHeight(state.map, x, y);
    if (l2 > 0) {
      ent.yaw[id] = atan2Poly(my, mx);
      ent.animState[id] = 1;
    } else {
      ent.animState[id] = 0;
    }
  }
}

/** Advances the sim by exactly one tick. Synchronous, allocation-free. */
export function step(state: SimState, inputs: TickInputs): void {
  systemAvatarMovement(state, inputs);
  // systemLaneFollowing(state)   — Phase 2
  // systemTargeting(state)       — Phase 1
  // systemProjectiles(state)     — Phase 1
  // systemDamageDeath(state)     — Phase 1
  // systemCapture(state)         — Phase 3
  // systemEconomy(state)         — Phase 3
  // systemSpawning(state)        — Phase 2
  // systemWinCheck(state)        — Phase 2
  state.tick += 1;
}

/**
 * FNV-1a 32-bit over canonical state: scalars, the contiguous entity-field
 * byte region, the live part of the free-list, and player→avatar ids.
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
  }
  return h;
}

/** Snapshot record layout (architecture.md §3). */
export const SNAPSHOT_STRIDE = 10;
/** Snapshot buffers must hold MAX_ENTITIES * SNAPSHOT_STRIDE floats. */

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
