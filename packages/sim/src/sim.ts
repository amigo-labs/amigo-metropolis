// The simulation core. API surface per architecture.md §2 — keep this exact
// shape: createSim / step / hash / writeSnapshot.
//
// System order inside step() is FIXED and part of determinism (order is
// behavior — document any change):
//   input → avatar movement+weapons → unit lane-following → targeting →
//   projectiles → damage/death → capture progress → economy → spawning →
//   win check.
// Phase 1 implements avatar movement/weapons, turret targeting (sandbox
// dummies), projectiles, damage/death and (re)spawning; later phases fill in
// the rest WITHOUT reordering.

import { ARCHETYPE } from "./archetypes";
import {
  ARCHETYPE_MAX_HP,
  ARCHETYPE_RADIUS,
  AVATAR_AMMO_HEAVY,
  AVATAR_AMMO_SPECIAL,
  AVATAR_HOVER_MAX_SLOPE,
  AVATAR_HOVER_SPEED,
  AVATAR_HP,
  AVATAR_JUMP_SPEED,
  AVATAR_WALKER_MAX_SLOPE,
  AVATAR_WALKER_SPEED,
  DUMMY_RESPAWN_TICKS,
  GRAVITY,
  HEAVY_AOE_RADIUS,
  HEAVY_COOLDOWN_TICKS,
  HEAVY_DAMAGE,
  HEAVY_SPEED,
  HEAVY_TTL_TICKS,
  HOVER_CLEARANCE,
  HOVER_TRACTION,
  MAX_PLAYERS,
  POINTS_KILL_AVATAR,
  POINTS_KILL_TURRET,
  POINTS_KILL_UNIT,
  PRIMARY_COOLDOWN_TICKS,
  PRIMARY_DAMAGE,
  PRIMARY_RANGE,
  RESPAWN_TICKS,
  SPECIAL_AOE_RADIUS,
  SPECIAL_COOLDOWN_TICKS,
  SPECIAL_DAMAGE,
  SPECIAL_SPEED,
  SPECIAL_TTL_TICKS,
  TICK_DT,
  TRANSFORM_LOCK_TICKS,
  TURRET_COOLDOWN_TICKS,
  TURRET_DAMAGE,
  TURRET_RANGE,
} from "./balance";
import { createEntityStore, despawn, type EntityStore, spawn } from "./entities";
import {
  clearEvents,
  createEventBuffer,
  EV_DEATH,
  EV_EXPLOSION,
  EV_HIT,
  EV_RESPAWN,
  EV_SHOT,
  type EventBuffer,
  pushEvent,
} from "./events";
import { fnv1aBytes, fnv1aInit, fnv1aU32 } from "./hash";
import {
  BUTTON_FIRE1,
  BUTTON_FIRE2,
  BUTTON_FIRE3,
  BUTTON_JUMP,
  BUTTON_TRANSFORM,
  type TickInputs,
} from "./inputs";
import { isWater, type MapData, sampleHeight, worldExtent } from "./map";
import { atan2Poly, cosLUT, sinLUT } from "./simMath";

// Avatar modes (EntityStore.mode).
export const MODE_WALKER = 0;
export const MODE_HOVER = 1;

// Projectile kinds (EntityStore.mode on PROJECTILE entities).
export const PROJ_HEAVY = 1;
export const PROJ_SPECIAL = 2;

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
  /** Sandbox dummy turrets: entity id (-1 dead) + respawn countdown per spot. */
  readonly dummyEntity: Int32Array;
  readonly dummyRespawn: Int32Array;
  /** Per-tick transient events (NOT hashed). */
  readonly events: EventBuffer;
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
  ent.aimX[id] = cosLUT(s.yaw);
  ent.aimY[id] = sinLUT(s.yaw);
  ent.hp[id] = AVATAR_HP;
  ent.mode[id] = MODE_WALKER;
  ent.ammoA[id] = AVATAR_AMMO_HEAVY;
  ent.ammoB[id] = AVATAR_AMMO_SPECIAL;
  ent.ownerId[id] = player;
  state.avatarId[player] = id;
  return id;
}

/** Spawns the sandbox dummy turret for map dummy spot `k` (team 1). */
function spawnDummy(state: SimState, k: number): number {
  const ent = state.ent;
  const spot = state.map.dummySpots[k];
  const id = spawn(ent, ARCHETYPE.TURRET, 1);
  if (id < 0) return -1;
  ent.posX[id] = spot.x;
  ent.posY[id] = spot.y;
  ent.height[id] = sampleHeight(state.map, spot.x, spot.y);
  ent.hp[id] = ARCHETYPE_MAX_HP[ARCHETYPE.TURRET];
  ent.ownerId[id] = -1;
  state.dummyEntity[k] = id;
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
    dummyEntity: new Int32Array(map.dummySpots.length).fill(-1),
    dummyRespawn: new Int32Array(map.dummySpots.length),
    events: createEventBuffer(),
  };
  for (let p = 0; p < MAX_PLAYERS; p++) {
    spawnAvatar(state, p);
  }
  for (let k = 0; k < map.dummySpots.length; k++) {
    spawnDummy(state, k);
  }
  return state;
}

const AXIS_SCALE = 1 / 127;
const GROUND_EPS = 0.001;
/** Height changes up to this snap to the terrain; larger drops become falls. */
const STEP_SNAP = 0.35;
const MUZZLE_OFFSET = 2;

/** input + avatar movement: transform, jump/gravity, slope/water rules. */
function systemAvatarMovement(state: SimState, inputs: TickInputs): void {
  const ent = state.ent;
  const map = state.map;
  const extent = worldExtent(map);
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const id = state.avatarId[p];
    if (id < 0) {
      state.lastButtons[p] = inputs.players[p].buttons;
      continue;
    }
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

    // Weapons (sub-step of the avatar system): cooldowns, fire, ammo stub.
    avatarWeapons(state, p, id, input.buttons, nowLocked);
  }
}

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

function avatarWeapons(
  state: SimState,
  player: number,
  id: number,
  buttons: number,
  locked: boolean,
): void {
  const ent = state.ent;
  if (ent.cooldownA[id] > 0) ent.cooldownA[id] -= 1;
  if (ent.cooldownB[id] > 0) ent.cooldownB[id] -= 1;
  if (ent.cooldownC[id] > 0) ent.cooldownC[id] -= 1;

  // Ammo/repair stub until base pads exist (Phase 2): standing on the own
  // base plot refills heavy/special.
  const plot = state.map.basePlots[player];
  const pdx = ent.posX[id] - plot.x;
  const pdy = ent.posY[id] - plot.y;
  if (pdx * pdx + pdy * pdy <= plot.radius * plot.radius) {
    ent.ammoA[id] = AVATAR_AMMO_HEAVY;
    ent.ammoB[id] = AVATAR_AMMO_SPECIAL;
  }

  if (locked) return;
  const dirX = ent.aimX[id];
  const dirY = ent.aimY[id];
  if (dirX === 0 && dirY === 0) return;

  if ((buttons & BUTTON_FIRE1) !== 0 && ent.cooldownA[id] <= 0) {
    ent.cooldownA[id] = PRIMARY_COOLDOWN_TICKS;
    pushEvent(state.events, EV_SHOT, id, 0, 0);
    hitscan(state, id, player, dirX, dirY);
  }
  if ((buttons & BUTTON_FIRE2) !== 0 && ent.cooldownB[id] <= 0 && ent.ammoA[id] > 0) {
    ent.cooldownB[id] = HEAVY_COOLDOWN_TICKS;
    ent.ammoA[id] -= 1;
    pushEvent(state.events, EV_SHOT, id, 1, 0);
    spawnProjectile(state, id, player, PROJ_HEAVY, dirX, dirY, HEAVY_SPEED, HEAVY_TTL_TICKS);
  }
  if ((buttons & BUTTON_FIRE3) !== 0 && ent.cooldownC[id] <= 0 && ent.ammoB[id] > 0) {
    ent.cooldownC[id] = SPECIAL_COOLDOWN_TICKS;
    ent.ammoB[id] -= 1;
    pushEvent(state.events, EV_SHOT, id, 2, 0);
    spawnProjectile(state, id, player, PROJ_SPECIAL, dirX, dirY, SPECIAL_SPEED, SPECIAL_TTL_TICKS);
  }
}

/** First enemy hit along the 2D ray within PRIMARY_RANGE, if any. */
function hitscan(state: SimState, shooter: number, player: number, dx: number, dy: number): void {
  const ent = state.ent;
  const ox = ent.posX[shooter];
  const oy = ent.posY[shooter];
  const team = ent.team[shooter];
  let bestT = PRIMARY_RANGE;
  let bestId = -1;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || id === shooter) continue;
    if (ent.team[id] === team) continue;
    if (ent.archetype[id] === ARCHETYPE.PROJECTILE) continue;
    const rx = ent.posX[id] - ox;
    const ry = ent.posY[id] - oy;
    const t = rx * dx + ry * dy;
    if (t <= 0 || t >= bestT) continue;
    const px = rx - dx * t;
    const py = ry - dy * t;
    const r = ARCHETYPE_RADIUS[ent.archetype[id]];
    if (px * px + py * py <= r * r) {
      bestT = t;
      bestId = id;
    }
  }
  if (bestId >= 0) {
    applyDamage(state, bestId, PRIMARY_DAMAGE, player);
  }
}

function spawnProjectile(
  state: SimState,
  shooter: number,
  player: number,
  kind: number,
  dx: number,
  dy: number,
  speed: number,
  ttl: number,
): void {
  const ent = state.ent;
  const id = spawn(ent, ARCHETYPE.PROJECTILE, ent.team[shooter]);
  if (id < 0) return;
  ent.posX[id] = ent.posX[shooter] + dx * MUZZLE_OFFSET;
  ent.posY[id] = ent.posY[shooter] + dy * MUZZLE_OFFSET;
  ent.height[id] = ent.height[shooter] + 1;
  ent.velX[id] = dx * speed;
  ent.velY[id] = dy * speed;
  ent.yaw[id] = atan2Poly(dy, dx);
  ent.hp[id] = 1;
  ent.mode[id] = kind;
  ent.timerA[id] = ttl;
  ent.ownerId[id] = player;
}

/** Damage bookkeeping; deaths are collected by systemDamageDeath afterwards. */
function applyDamage(state: SimState, target: number, damage: number, attacker: number): void {
  const ent = state.ent;
  ent.hp[target] -= damage;
  // aux stores 1 + last attacking player for kill attribution (0 = none).
  ent.aux[target] = attacker + 1;
  pushEvent(state.events, EV_HIT, target, attacker, damage);
}

/** Sandbox dummy turrets: face and shoot the nearest enemy avatar in range. */
function systemTargeting(state: SimState): void {
  const ent = state.ent;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || ent.archetype[id] !== ARCHETYPE.TURRET) continue;
    if (ent.cooldownA[id] > 0) ent.cooldownA[id] -= 1;
    let bestD2 = TURRET_RANGE * TURRET_RANGE;
    let bestId = -1;
    for (let p = 0; p < MAX_PLAYERS; p++) {
      const a = state.avatarId[p];
      if (a < 0 || ent.team[a] === ent.team[id]) continue;
      const dx = ent.posX[a] - ent.posX[id];
      const dy = ent.posY[a] - ent.posY[id];
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestId = a;
      }
    }
    if (bestId < 0) continue;
    const dx = ent.posX[bestId] - ent.posX[id];
    const dy = ent.posY[bestId] - ent.posY[id];
    ent.yaw[id] = atan2Poly(dy, dx);
    if (ent.cooldownA[id] <= 0) {
      ent.cooldownA[id] = TURRET_COOLDOWN_TICKS;
      pushEvent(state.events, EV_SHOT, id, 0, 0);
      // Turret shots always connect at this range (Phase 1 simplicity);
      // attacker -1 = no player gets kill credit for dummy fire.
      applyDamage(state, bestId, TURRET_DAMAGE, -1);
    }
  }
}

/** Projectiles: fly, expire, explode on contact or terrain. */
function systemProjectiles(state: SimState): void {
  const ent = state.ent;
  const map = state.map;
  const extent = worldExtent(map);
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || ent.archetype[id] !== ARCHETYPE.PROJECTILE) continue;
    ent.timerA[id] -= 1;
    const x = ent.posX[id] + ent.velX[id] * TICK_DT;
    const y = ent.posY[id] + ent.velY[id] * TICK_DT;
    ent.posX[id] = x;
    ent.posY[id] = y;
    const ground = sampleHeight(map, x, y);
    let boom = ent.timerA[id] <= 0;
    if (x <= 0 || x >= extent || y <= 0 || y >= extent) boom = true;
    if (!boom && ground >= ent.height[id]) boom = true;
    if (!boom) {
      // Contact fuze: any enemy non-projectile within its hit radius + 0.5.
      for (let t = 0; t < ent.high; t++) {
        if (!ent.alive[t] || t === id) continue;
        if (ent.team[t] === ent.team[id]) continue;
        if (ent.archetype[t] === ARCHETYPE.PROJECTILE) continue;
        const r = ARCHETYPE_RADIUS[ent.archetype[t]] + 0.5;
        const dx = ent.posX[t] - x;
        const dy = ent.posY[t] - y;
        if (dx * dx + dy * dy <= r * r) {
          boom = true;
          break;
        }
      }
    }
    if (boom) {
      explode(state, id);
    }
  }
}

function explode(state: SimState, id: number): void {
  const ent = state.ent;
  const kind = ent.mode[id];
  const radius = kind === PROJ_SPECIAL ? SPECIAL_AOE_RADIUS : HEAVY_AOE_RADIUS;
  const damage = kind === PROJ_SPECIAL ? SPECIAL_DAMAGE : HEAVY_DAMAGE;
  const x = ent.posX[id];
  const y = ent.posY[id];
  const team = ent.team[id];
  const owner = ent.ownerId[id];
  pushEvent(state.events, EV_EXPLOSION, Math.floor(x * 16), Math.floor(y * 16), kind);
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t] || t === id) continue;
    if (ent.team[t] === team) continue;
    if (ent.archetype[t] === ARCHETYPE.PROJECTILE) continue;
    const r = radius + ARCHETYPE_RADIUS[ent.archetype[t]];
    const dx = ent.posX[t] - x;
    const dy = ent.posY[t] - y;
    if (dx * dx + dy * dy <= r * r) {
      applyDamage(state, t, damage, owner);
    }
  }
  despawn(ent, id);
}

/** Collects deaths: points, events, avatar/dummy respawn scheduling. */
function systemDamageDeath(state: SimState): void {
  const ent = state.ent;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || ent.hp[id] > 0) continue;
    if (ent.archetype[id] === ARCHETYPE.PROJECTILE) continue;
    const killer = ent.aux[id] - 1; // -1 = environment/dummy
    const archetype = ent.archetype[id];
    pushEvent(state.events, EV_DEATH, id, killer, archetype);
    if (killer >= 0 && killer < MAX_PLAYERS && ent.team[id] !== killer) {
      if (archetype === ARCHETYPE.AVATAR) state.points[killer] += POINTS_KILL_AVATAR;
      else if (archetype === ARCHETYPE.TURRET) state.points[killer] += POINTS_KILL_TURRET;
      else state.points[killer] += POINTS_KILL_UNIT;
    }
    if (archetype === ARCHETYPE.AVATAR) {
      const player = ent.ownerId[id];
      state.avatarId[player] = -1;
      state.respawnTimer[player] = RESPAWN_TICKS;
    } else if (archetype === ARCHETYPE.TURRET) {
      for (let k = 0; k < state.dummyEntity.length; k++) {
        if (state.dummyEntity[k] === id) {
          state.dummyEntity[k] = -1;
          state.dummyRespawn[k] = DUMMY_RESPAWN_TICKS;
          break;
        }
      }
    }
    despawn(ent, id);
  }
}

/** Respawns avatars and sandbox dummies when their timers elapse. */
function systemSpawning(state: SimState): void {
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if (state.respawnTimer[p] > 0) {
      state.respawnTimer[p] -= 1;
      if (state.respawnTimer[p] === 0) {
        const id = spawnAvatar(state, p);
        if (id >= 0) pushEvent(state.events, EV_RESPAWN, id, p, 0);
      }
    }
  }
  for (let k = 0; k < state.dummyRespawn.length; k++) {
    if (state.dummyRespawn[k] > 0) {
      state.dummyRespawn[k] -= 1;
      if (state.dummyRespawn[k] === 0) {
        const id = spawnDummy(state, k);
        if (id >= 0) pushEvent(state.events, EV_RESPAWN, id, -1, 0);
      }
    }
  }
}

/** Advances the sim by exactly one tick. Synchronous, allocation-free. */
export function step(state: SimState, inputs: TickInputs): void {
  clearEvents(state.events);
  systemAvatarMovement(state, inputs);
  // systemLaneFollowing(state)   — Phase 2
  systemTargeting(state);
  systemProjectiles(state);
  systemDamageDeath(state);
  // systemCapture(state)         — Phase 3
  // systemEconomy(state)         — Phase 3
  systemSpawning(state);
  // systemWinCheck(state)        — Phase 2
  state.tick += 1;
}

/**
 * FNV-1a 32-bit over canonical state: scalars, the contiguous entity-field
 * byte region, the live part of the free-list, per-player state, and dummy
 * spot state. Events are transient render data and deliberately NOT hashed;
 * the map is immutable per match and identified in the replay header.
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
  for (let k = 0; k < state.dummyEntity.length; k++) {
    h = fnv1aU32(h, state.dummyEntity[k] >>> 0);
    h = fnv1aU32(h, state.dummyRespawn[k] >>> 0);
  }
  return h;
}

/** Snapshot record layout (architecture.md §3). */
export const SNAPSHOT_STRIDE = 10;

/**
 * Writes all live entities into `out` (stride 10, dense id order):
 * [id, archetype, teamId, x, y, height, yaw, animState, hpFrac, aux].
 * aux carries the projectile kind for PROJECTILE entities.
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
    out[o + 9] = ent.archetype[id] === ARCHETYPE.PROJECTILE ? ent.mode[id] : ent.aux[id];
    n += 1;
  }
  return n;
}
