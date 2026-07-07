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

import { ARCHETYPE, TEAM_NEUTRAL } from "./archetypes";
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
  BASE_TURRET_RESPAWN_TICKS,
  CONSOLE_RADIUS,
  DUMMY_RESPAWN_TICKS,
  FORTRESS_ALIVE_LIMIT,
  GRAVITY,
  HEAVY_AOE_RADIUS,
  HEAVY_COOLDOWN_TICKS,
  HEAVY_DAMAGE,
  HEAVY_SPEED,
  HEAVY_TTL_TICKS,
  HOVER_CLEARANCE,
  HOVER_TRACTION_ACCEL,
  HOVER_TRACTION_BRAKE,
  HOVER_TRACTION_COAST,
  JUGGERNAUT_ALIVE_LIMIT,
  MAX_PLAYERS,
  PAD_REPAIR_HP_PER_TICK,
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
  UNIT_DAMAGE,
  UNIT_FIRE_COOLDOWN_TICKS,
  UNIT_RANGE,
} from "./balance";
import { createEntityStore, despawn, type EntityStore, spawn } from "./entities";
import {
  clearEvents,
  createEventBuffer,
  EV_BREACH,
  EV_DEATH,
  EV_EXPLOSION,
  EV_HIT,
  EV_PURCHASE,
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
  BUTTON_INTERACT,
  BUTTON_JUMP,
  BUTTON_TRANSFORM,
  type TickInputs,
} from "./inputs";
import { isWater, type MapData, sampleHeight, worldExtent } from "./map";
import { atan2Poly, cosLUT, sinLUT } from "./simMath";
import {
  isGroundUnit,
  isUnit,
  nearestEnemyInRange,
  snapUnitHeight,
  systemUnitMovement,
  UNIT_MODE_PATROL,
} from "./units";

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
  /** Winning team, -1 while the match runs. Set once; the sim then freezes. */
  winner: number;
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
  /** Next lane index per player (ground-unit round-robin). */
  readonly laneCounter: Uint8Array;
  /** Sandbox dummy turrets: entity id (-1 dead) + respawn countdown per spot. */
  readonly dummyEntity: Int32Array;
  readonly dummyRespawn: Int32Array;
  /** Base ring turrets, slots flattened base 0 then base 1 (rules.md §5). */
  readonly baseTurretEntity: Int32Array;
  readonly baseTurretRespawn: Int32Array;
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

/**
 * Spawns the sandbox dummy turret for map dummy spot `k`. Dummies are NEUTRAL
 * (they only ever engage avatars — Phase 1 target-practice behavior) so units
 * neither engage them nor get shredded by them.
 */
function spawnDummy(state: SimState, k: number): number {
  const ent = state.ent;
  const spot = state.map.dummySpots[k];
  const id = spawn(ent, ARCHETYPE.TURRET, TEAM_NEUTRAL);
  if (id < 0) return -1;
  ent.posX[id] = spot.x;
  ent.posY[id] = spot.y;
  ent.height[id] = sampleHeight(state.map, spot.x, spot.y);
  ent.hp[id] = ARCHETYPE_MAX_HP[ARCHETYPE.TURRET];
  ent.ownerId[id] = -1;
  state.dummyEntity[k] = id;
  return id;
}

/** Resolves flattened ring slot `k` to its map spot (base 0 slots first). */
function baseTurretSpot(map: MapData, k: number): { team: number; x: number; y: number } {
  const n0 = map.bases[0].turrets.length;
  const team = k < n0 ? 0 : 1;
  const spot = map.bases[team].turrets[k < n0 ? k : k - n0];
  return { team, x: spot.x, y: spot.y };
}

/** Spawns the base ring turret for slot `k`; owned, so it defends its base. */
function spawnBaseTurret(state: SimState, k: number): number {
  const ent = state.ent;
  const { team, x, y } = baseTurretSpot(state.map, k);
  const id = spawn(ent, ARCHETYPE.TURRET, team);
  if (id < 0) return -1;
  ent.posX[id] = x;
  ent.posY[id] = y;
  ent.height[id] = sampleHeight(state.map, x, y);
  ent.hp[id] = ARCHETYPE_MAX_HP[ARCHETYPE.TURRET];
  ent.ownerId[id] = team;
  state.baseTurretEntity[k] = id;
  return id;
}

/**
 * Spawns a combat unit for `team` at (x, y). Ground units pick their lane via
 * the per-player round-robin counter; flyers start their patrol orbit at the
 * bearing from their anchor. `mode` is the Guardian spawn-site switch
 * (UNIT_MODE_PATROL at a base, UNIT_MODE_ASSAULT at an outpost — Phase 3).
 */
export function spawnUnit(
  state: SimState,
  archetype: number,
  team: number,
  x: number,
  y: number,
  mode: number = UNIT_MODE_PATROL,
): number {
  const ent = state.ent;
  const id = spawn(ent, archetype as 1 | 2 | 3 | 4, team);
  if (id < 0) return -1;
  ent.posX[id] = x;
  ent.posY[id] = y;
  ent.hp[id] = ARCHETYPE_MAX_HP[archetype];
  ent.ownerId[id] = team;
  ent.mode[id] = mode;
  const gate = state.map.bases[team ^ 1].gate;
  ent.yaw[id] = atan2Poly(gate.y - y, gate.x - x);
  if (isGroundUnit(archetype)) {
    const lanes = state.map.lanes;
    if (lanes.length > 0) {
      const lane = state.laneCounter[team] % lanes.length;
      state.laneCounter[team] = (lane + 1) % lanes.length;
      ent.timerA[id] = lane;
      ent.timerB[id] = team === 0 ? 0 : lanes[lane].length - 1;
    } else {
      ent.timerA[id] = 0;
      ent.timerB[id] = -1; // no lanes on this map: beeline the gate
    }
    snapUnitHeight(state, id, false);
  } else {
    const core = state.map.bases[team].core;
    ent.timerA[id] = atan2Poly(y - core.y, x - core.x);
    snapUnitHeight(state, id, true);
  }
  return id;
}

export function createSim(map: MapData, seed: number): SimState {
  const ringSlots = map.bases[0].turrets.length + map.bases[1].turrets.length;
  const state: SimState = {
    tick: 0,
    prng: seed | 0,
    winner: -1,
    map,
    ent: createEntityStore(),
    avatarId: new Int32Array(MAX_PLAYERS).fill(-1),
    respawnTimer: new Int32Array(MAX_PLAYERS),
    lastButtons: new Uint8Array(MAX_PLAYERS),
    points: new Uint32Array(MAX_PLAYERS),
    laneCounter: new Uint8Array(MAX_PLAYERS),
    dummyEntity: new Int32Array(map.dummySpots.length).fill(-1),
    dummyRespawn: new Int32Array(map.dummySpots.length),
    baseTurretEntity: new Int32Array(ringSlots).fill(-1),
    baseTurretRespawn: new Int32Array(ringSlots),
    events: createEventBuffer(),
  };
  for (let p = 0; p < MAX_PLAYERS; p++) {
    spawnAvatar(state, p);
  }
  for (let k = 0; k < ringSlots; k++) {
    spawnBaseTurret(state, k);
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

    // Traction model: walker is exact; hover drifts toward the target with
    // stick-dependent grip — throttle accelerates, counter-steer brakes hard,
    // a released stick coasts (rules.md §2 "fast, drifty").
    if (hover) {
      let traction = HOVER_TRACTION_COAST;
      if (l2 > 0) {
        const along = mx * ent.velX[id] + my * ent.velY[id];
        traction = along < 0 ? HOVER_TRACTION_BRAKE : HOVER_TRACTION_ACCEL;
      }
      ent.velX[id] += (mx * AVATAR_HOVER_SPEED - ent.velX[id]) * traction;
      ent.velY[id] += (my * AVATAR_HOVER_SPEED - ent.velY[id]) * traction;
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
    // Console purchases (Phase 2 stub: edge-triggered and free; Phase 3
    // replaces this with hold-to-buy against the points ledger).
    if ((pressed & BUTTON_INTERACT) !== 0) {
      consolePurchase(state, p, id, input.buttons);
    }
  }
}

/**
 * Interact at the own base's ground/air console spawns a unit there. Holding
 * FIRE2 upgrades the order to the heavy variant (Juggernaut/Fortress), which
 * are capped at one alive each (rules.md §3).
 */
function consolePurchase(state: SimState, player: number, id: number, buttons: number): void {
  const ent = state.ent;
  const base = state.map.bases[player];
  const heavy = (buttons & BUTTON_FIRE2) !== 0;
  const x = ent.posX[id];
  const y = ent.posY[id];
  const r2 = CONSOLE_RADIUS * CONSOLE_RADIUS;
  let archetype = -1;
  let cx = 0;
  let cy = 0;
  const gdx = x - base.groundConsole.x;
  const gdy = y - base.groundConsole.y;
  const adx = x - base.airConsole.x;
  const ady = y - base.airConsole.y;
  if (gdx * gdx + gdy * gdy <= r2) {
    archetype = heavy ? ARCHETYPE.JUGGERNAUT : ARCHETYPE.RUNNER;
    cx = base.groundConsole.x;
    cy = base.groundConsole.y;
  } else if (adx * adx + ady * ady <= r2) {
    archetype = heavy ? ARCHETYPE.FORTRESS : ARCHETYPE.GUARDIAN;
    cx = base.airConsole.x;
    cy = base.airConsole.y;
  }
  if (archetype < 0) return;
  if (archetype === ARCHETYPE.JUGGERNAUT || archetype === ARCHETYPE.FORTRESS) {
    const limit =
      archetype === ARCHETYPE.JUGGERNAUT ? JUGGERNAUT_ALIVE_LIMIT : FORTRESS_ALIVE_LIMIT;
    if (countAliveOfArchetype(state, archetype, player) >= limit) return;
  }
  const uid = spawnUnit(state, archetype, player, cx, cy, UNIT_MODE_PATROL);
  if (uid >= 0) {
    pushEvent(state.events, EV_PURCHASE, uid, player, archetype);
  }
}

function countAliveOfArchetype(state: SimState, archetype: number, team: number): number {
  const ent = state.ent;
  let n = 0;
  for (let id = 0; id < ent.high; id++) {
    if (ent.alive[id] && ent.archetype[id] === archetype && ent.team[id] === team) n += 1;
  }
  return n;
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

  // Ammo/repair pad (rules.md §5): ammo refills instantly, hp regenerates.
  const pad = state.map.bases[player].pad;
  const pdx = ent.posX[id] - pad.x;
  const pdy = ent.posY[id] - pad.y;
  if (pdx * pdx + pdy * pdy <= pad.radius * pad.radius) {
    ent.ammoA[id] = AVATAR_AMMO_HEAVY;
    ent.ammoB[id] = AVATAR_AMMO_SPECIAL;
    if (ent.hp[id] < AVATAR_HP) {
      ent.hp[id] += PAD_REPAIR_HP_PER_TICK;
      if (ent.hp[id] > AVATAR_HP) ent.hp[id] = AVATAR_HP;
    }
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

/**
 * Turrets and units acquire the nearest hostile and fire. All non-avatar
 * shots are instant hits at this stage (Phase 1/2 simplicity — the Fortress'
 * homing projectiles are flavor for a later pass). Owned turrets defend
 * against avatars AND units; neutral dummies keep their Phase 1 behavior and
 * only ever engage avatars. Turrets never target turrets.
 */
function systemTargeting(state: SimState): void {
  const ent = state.ent;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id]) continue;
    const archetype = ent.archetype[id];
    if (archetype === ARCHETYPE.TURRET) {
      if (ent.cooldownA[id] > 0) ent.cooldownA[id] -= 1;
      const target =
        ent.ownerId[id] < 0
          ? nearestEnemyAvatar(state, id, TURRET_RANGE)
          : nearestEnemyInRange(state, id, TURRET_RANGE);
      if (target < 0) continue;
      ent.yaw[id] = atan2Poly(ent.posY[target] - ent.posY[id], ent.posX[target] - ent.posX[id]);
      if (ent.cooldownA[id] <= 0) {
        ent.cooldownA[id] = TURRET_COOLDOWN_TICKS;
        pushEvent(state.events, EV_SHOT, id, 0, 0);
        // ownerId is the owning player for base turrets (kill credit) and
        // -1 for dummies (no credit) — exactly the Phase 1 rule.
        applyDamage(state, target, TURRET_DAMAGE, ent.ownerId[id]);
      }
    } else if (isUnit(archetype)) {
      if (ent.cooldownA[id] > 0) ent.cooldownA[id] -= 1;
      const target = nearestEnemyInRange(state, id, UNIT_RANGE[archetype]);
      if (target < 0) continue;
      ent.yaw[id] = atan2Poly(ent.posY[target] - ent.posY[id], ent.posX[target] - ent.posX[id]);
      if (ent.cooldownA[id] <= 0) {
        ent.cooldownA[id] = UNIT_FIRE_COOLDOWN_TICKS[archetype];
        pushEvent(state.events, EV_SHOT, id, 0, 0);
        applyDamage(state, target, UNIT_DAMAGE[archetype], ent.ownerId[id]);
      }
    }
  }
}

/** Phase 1 dummy-turret targeting: nearest enemy avatar in range, or -1. */
function nearestEnemyAvatar(state: SimState, id: number, range: number): number {
  const ent = state.ent;
  let bestD2 = range * range;
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
  return bestId;
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
      let slotted = false;
      for (let k = 0; k < state.dummyEntity.length; k++) {
        if (state.dummyEntity[k] === id) {
          state.dummyEntity[k] = -1;
          state.dummyRespawn[k] = DUMMY_RESPAWN_TICKS;
          slotted = true;
          break;
        }
      }
      if (!slotted) {
        for (let k = 0; k < state.baseTurretEntity.length; k++) {
          if (state.baseTurretEntity[k] === id) {
            state.baseTurretEntity[k] = -1;
            state.baseTurretRespawn[k] = BASE_TURRET_RESPAWN_TICKS;
            break;
          }
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
  for (let k = 0; k < state.baseTurretRespawn.length; k++) {
    if (state.baseTurretRespawn[k] > 0) {
      state.baseTurretRespawn[k] -= 1;
      if (state.baseTurretRespawn[k] === 0) {
        const id = spawnBaseTurret(state, k);
        if (id >= 0) pushEvent(state.events, EV_RESPAWN, id, -1, 0);
      }
    }
  }
}

/**
 * Win check (rules.md §1): a friendly GROUND unit physically inside the
 * enemy gate volume ends the match — nothing else does. Lowest entity id
 * wins a same-tick tie deterministically.
 */
function systemWinCheck(state: SimState): void {
  const ent = state.ent;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || !isGroundUnit(ent.archetype[id])) continue;
    const team = ent.team[id];
    if (team !== 0 && team !== 1) continue;
    const gate = state.map.bases[team ^ 1].gate;
    const dx = ent.posX[id] - gate.x;
    const dy = ent.posY[id] - gate.y;
    if (dx * dx + dy * dy <= gate.radius * gate.radius) {
      state.winner = team;
      pushEvent(state.events, EV_BREACH, id, team, 0);
      return;
    }
  }
}

/** Advances the sim by exactly one tick. Synchronous, allocation-free. */
export function step(state: SimState, inputs: TickInputs): void {
  clearEvents(state.events);
  // A breached match freezes: the tick (and thus the hash stream) keeps
  // advancing for replays/netcode, but no gameplay system runs anymore.
  if (state.winner === -1) {
    systemAvatarMovement(state, inputs);
    systemUnitMovement(state);
    systemTargeting(state);
    systemProjectiles(state);
    systemDamageDeath(state);
    // systemCapture(state)         — Phase 3
    // systemEconomy(state)         — Phase 3
    systemSpawning(state);
    systemWinCheck(state);
  }
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
  h = fnv1aU32(h, state.winner >>> 0);
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
    h = fnv1aU32(h, state.laneCounter[p]);
  }
  for (let k = 0; k < state.dummyEntity.length; k++) {
    h = fnv1aU32(h, state.dummyEntity[k] >>> 0);
    h = fnv1aU32(h, state.dummyRespawn[k] >>> 0);
  }
  for (let k = 0; k < state.baseTurretEntity.length; k++) {
    h = fnv1aU32(h, state.baseTurretEntity[k] >>> 0);
    h = fnv1aU32(h, state.baseTurretRespawn[k] >>> 0);
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
