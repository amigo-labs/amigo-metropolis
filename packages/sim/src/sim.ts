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
  AVATAR_LOCK_RANGE,
  AVATAR_WALKER_MAX_SLOPE,
  AVATAR_WALKER_SPEED,
  BASE_TURRET_RESPAWN_TICKS,
  CAPTURE_RADIUS,
  CAPTURE_TICKS,
  CONSOLE_HOLD_TICKS,
  CONSOLE_RADIUS,
  CORE_ATTACK_RADIUS,
  CORE_DAMAGE_PER_SHOT,
  COST_FORTRESS,
  COST_GUARDIAN,
  COST_JUGGERNAUT,
  COST_OUTPOST_CLAIM,
  COST_RUNNER,
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
  NEUTRAL_TURRET_RESPAWN_TICKS,
  OUTPOST_CONSOLE_RESPAWN_TICKS,
  OUTPOST_COST_MULTIPLIER,
  OUTPOST_PAD_RADIUS,
  PA_PRODUCTION_ALIVE_LIMIT,
  PAD_REPAIR_HP_PER_TICK,
  PICKUP_HEALTH,
  PICKUP_HEALTH_AMOUNT,
  PICKUP_HEAVY_AMMO,
  PICKUP_INVIS,
  PICKUP_INVIS_TICKS,
  PICKUP_INVULN,
  PICKUP_INVULN_TICKS,
  PICKUP_POWER,
  PICKUP_POWER_MULTIPLIER,
  PICKUP_POWER_TICKS,
  PICKUP_RADIUS,
  PICKUP_SPECIAL_AMMO,
  POINTS_CAPTURE_TURRET,
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
  STARTING_POINTS,
  TICK_DT,
  TRANSFORM_LOCK_TICKS,
  TRICKLE_INTERVAL_TICKS,
  TRICKLE_POINTS,
  TRIGGER_REARM_TICKS,
  TRIGGER_WATCH_ENEMY_AVATAR,
  TRIGGER_WATCH_ENEMY_UNITS,
  TRIGGER_WATCH_OWN_AVATAR,
  TURRET_COOLDOWN_TICKS,
  TURRET_DAMAGE,
  TURRET_RANGE,
  UNIT_DAMAGE,
  UNIT_FIRE_COOLDOWN_TICKS,
  UNIT_RANGE,
  WARDEN_ALTITUDE,
  WARDEN_HEAVY_AOE_RADIUS,
  WARDEN_HEAVY_DAMAGE,
  WARDEN_HP,
  WARDEN_INCOME_PERCENT,
} from "./balance";
import { crossesWallX, crossesWallY, segmentBlocked } from "./collision";
import { createEntityStore, despawn, type EntityStore, spawn } from "./entities";
import {
  clearEvents,
  createEventBuffer,
  EV_ALARM,
  EV_BREACH,
  EV_CAPTURE,
  EV_CLAIM,
  EV_CORE_HIT,
  EV_DEATH,
  EV_EXPLOSION,
  EV_HIT,
  EV_PICKUP,
  EV_PRODUCE,
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
  BUTTON_TARGET_CYCLE,
  BUTTON_TRANSFORM,
  type TickInputs,
} from "./inputs";
import {
  isWater,
  type MapBaseTurret,
  type MapData,
  type MapTriggerVolume,
  sampleHeight,
  worldExtent,
} from "./map";
import { atan2Poly, cosLUT, sinLUT } from "./simMath";
import {
  GRAPH_MODE,
  isGroundUnit,
  isUnit,
  nearestEnemyInRange,
  resolveWalker,
  snapUnitHeight,
  systemUnitMovement,
  UNIT_MODE_ASSAULT,
  UNIT_MODE_PATROL,
} from "./units";
import { systemWarden, WGOAL_IDLE } from "./warden";

// Avatar modes (EntityStore.mode).
export const MODE_WALKER = 0;
export const MODE_HOVER = 1;

// Projectile kinds (EntityStore.mode on PROJECTILE entities).
export const PROJ_HEAVY = 1;
export const PROJ_SPECIAL = 2;
export const PROJ_WARDEN = 3; // the Warden's bomb (own damage/AoE numbers)

// Turret kinds (EntityStore.mode on TURRET entities).
export const TURRET_BASE = 0; //        base ring: full targeting
export const TURRET_DUMMY = 1; //       Phase 1 sandbox: engages avatars only
export const TURRET_CAPTURABLE = 2; //  neutral spot: dormant until captured

// animState bits (renderer-facing; snapshot field 7).
export const ANIM_MOVING = 1 << 0;
export const ANIM_HOVER = 1 << 1;
export const ANIM_AIRBORNE = 1 << 2;
export const ANIM_TRANSFORMING = 1 << 3;

/**
 * Match configuration beyond map+seed. Part of the replay header (format 2)
 * and the online handshake — every peer must create the sim identically.
 */
export interface SimOptions {
  /** Player slot driven by the in-sim Warden AI (rules.md §7). */
  wardenPlayer?: number;
  /** Warden difficulty 1–10 (clamped). */
  wardenDifficulty?: number;
}

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
  /** Capturable turrets, one slot per map turretSpot (rules.md §5). */
  readonly neutralTurretEntity: Int32Array;
  readonly neutralTurretRespawn: Int32Array;
  /** Capture progress per turret spot: capturing team (-1 none) + held ticks. */
  readonly captureTeam: Int8Array;
  readonly captureProgress: Int32Array;
  /** Outposts, one slot per map outpostSpot: owner, console entity, respawn. */
  readonly outpostOwner: Int8Array;
  readonly outpostConsole: Int32Array;
  readonly outpostRespawn: Int32Array;
  /** Hold-to-buy per player: encoded console target (-1 none) + held ticks. */
  readonly buyTarget: Int32Array;
  readonly buyProgress: Int32Array;
  /** Soft-lock target entity per player (-1 none); acquired/cycled in-sim. */
  readonly lockTarget: Int32Array;
  /** Player slot the Warden AI drives, -1 for a match without one (config). */
  readonly wardenPlayer: number;
  /** Warden difficulty 1–10 (config; 0 when wardenPlayer is -1). */
  readonly wardenDifficulty: number;
  /** Warden decision state: current goal (WGOAL_* in warden.ts). */
  wardenGoal: number;
  /** Goal operand: entity id, spot index or remaining-purchase count. */
  wardenSlot: number;
  /** Ticks until the next decision re-plan (the reaction delay). */
  wardenThink: number;
  /** Fixed-point (percent) remainder of the Warden's trickle multiplier. */
  wardenIncomeAcc: number;

  // --- Precinct Assault state (rules.md §9) --------------------------------
  // Every array here is sized from the map's own feature lists, so on an arena
  // without PA data they are zero-length and every PA system iterates nothing.
  /** Built-in base defence weapons, flattened base 0 then base 1 (§8.1). */
  readonly baseDefenceEntity: Int32Array;
  readonly baseDefenceRespawn: Int32Array;
  /** Remaining core HP per team. Length 0 when no base carries a core. */
  readonly coreHp: Int32Array;
  /** Ticks until each base produces its next free unit. Length 0 = no production. */
  readonly productionTimer: Int32Array;
  /** Ticks until each pickup spot re-arms (0 = available). */
  readonly pickupCooldown: Int32Array;
  /** Power-up timers per player; length 0 when the arena has no pickups. */
  readonly buffInvuln: Int32Array;
  readonly buffInvis: Int32Array;
  readonly buffPower: Int32Array;
  /** Ticks until each intrusion volume can fire again. */
  readonly triggerArm: Int32Array;

  /** Per-tick transient events (NOT hashed). */
  readonly events: EventBuffer;
}

/**
 * Spawns a fresh avatar for `player` at its map spawn point. The Warden's
 * slot gets the superplane instead (rules.md §7) — same spawn point, riding
 * its cruise altitude.
 */
export function spawnAvatar(state: SimState, player: number): number {
  const ent = state.ent;
  const s = state.map.spawns[player];
  const warden = player === state.wardenPlayer;
  const id = spawn(ent, warden ? ARCHETYPE.WARDEN : ARCHETYPE.AVATAR, player);
  if (id < 0) return -1;
  ent.posX[id] = s.x;
  ent.posY[id] = s.y;
  const ground = sampleHeight(state.map, s.x, s.y);
  ent.height[id] = warden ? Math.max(ground, state.map.waterLevel) + WARDEN_ALTITUDE : ground;
  ent.yaw[id] = s.yaw;
  ent.aimX[id] = cosLUT(s.yaw);
  ent.aimY[id] = sinLUT(s.yaw);
  ent.hp[id] = warden ? WARDEN_HP : AVATAR_HP;
  ent.mode[id] = MODE_WALKER;
  ent.ammoA[id] = warden ? 0 : AVATAR_AMMO_HEAVY;
  ent.ammoB[id] = warden ? 0 : AVATAR_AMMO_SPECIAL;
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
  ent.mode[id] = TURRET_DUMMY;
  state.dummyEntity[k] = id;
  return id;
}

/** Spawns the capturable turret for map turret spot `k`, neutral + dormant. */
function spawnNeutralTurret(state: SimState, k: number): number {
  const ent = state.ent;
  const spot = state.map.turretSpots[k];
  const id = spawn(ent, ARCHETYPE.TURRET, TEAM_NEUTRAL);
  if (id < 0) return -1;
  ent.posX[id] = spot.x;
  ent.posY[id] = spot.y;
  ent.height[id] = sampleHeight(state.map, spot.x, spot.y);
  ent.hp[id] =
    state.map.turretHp.length > 0 ? state.map.turretHp[k] : ARCHETYPE_MAX_HP[ARCHETYPE.TURRET];
  ent.ownerId[id] = -1;
  ent.mode[id] = TURRET_CAPTURABLE;
  // Per-spot original parameters (rules.md §9); empty lists leave the profile at
  // -1 and the yaw at 0, i.e. the pre-PA behavior.
  if (state.map.turretParams.length > 0) ent.weaponProfile[id] = state.map.turretParams[k];
  if (state.map.turretYaw.length > 0) {
    const yaw = state.map.turretYaw[k];
    ent.yaw[id] = yaw;
    ent.aimX[id] = cosLUT(yaw);
    ent.aimY[id] = sinLUT(yaw);
  }
  state.neutralTurretEntity[k] = id;
  return id;
}

/** Spawns outpost `k`'s console, neutral (claimable) unless owned. */
function spawnOutpostConsole(state: SimState, k: number): number {
  const ent = state.ent;
  const spot = state.map.outpostSpots[k];
  const team = state.outpostOwner[k];
  const id = spawn(ent, ARCHETYPE.CONSOLE, team);
  if (id < 0) return -1;
  ent.posX[id] = spot.x;
  ent.posY[id] = spot.y;
  ent.height[id] = sampleHeight(state.map, spot.x, spot.y);
  ent.hp[id] = ARCHETYPE_MAX_HP[ARCHETYPE.CONSOLE];
  ent.ownerId[id] = team;
  state.outpostConsole[k] = id;
  return id;
}

/** Resolves flattened ring slot `k` to its map entry (base 0 slots first). */
function baseTurretSpot(map: MapData, k: number): { team: number; spot: MapBaseTurret } {
  const n0 = map.bases[0].turrets.length;
  const team = k < n0 ? 0 : 1;
  return { team, spot: map.bases[team].turrets[k < n0 ? k : k - n0] };
}

/**
 * Spawns the base ring turret for slot `k`; owned, so it defends its base.
 *
 * The ring gets the original Turret actor's own weapon profile, gun rotation and
 * health when the arena carries them, exactly like the capturable pads
 * (spawnNeutralTurret) and the built-in base guns (spawnBaseDefence). It did not,
 * for one release, and the effect was not subtle: with weaponProfile at -1 the
 * ring fell through to the global TURRET_RANGE of 28 m against an imported
 * engage_range of 6 m, so 32 turrets covered the whole midfield and shot every
 * produced unit dead from outside the units' own reach. Sentinels keep the pre-PA
 * arenas on the globals.
 */
function spawnBaseTurret(state: SimState, k: number): number {
  const ent = state.ent;
  const { team, spot } = baseTurretSpot(state.map, k);
  const id = spawn(ent, ARCHETYPE.TURRET, team);
  if (id < 0) return -1;
  ent.posX[id] = spot.x;
  ent.posY[id] = spot.y;
  ent.height[id] = sampleHeight(state.map, spot.x, spot.y);
  ent.hp[id] = spot.hp > 0 ? spot.hp : ARCHETYPE_MAX_HP[ARCHETYPE.TURRET];
  ent.ownerId[id] = team;
  ent.weaponProfile[id] = spot.weapon;
  if (spot.yaw !== 0) {
    ent.yaw[id] = spot.yaw;
    ent.aimX[id] = cosLUT(spot.yaw);
    ent.aimY[id] = sinLUT(spot.yaw);
  }
  state.baseTurretEntity[k] = id;
  return id;
}

/** Resolves flattened defence slot `k` to its base and map entry. */
function baseDefenceSpot(
  map: MapData,
  k: number,
): { team: number; x: number; y: number; weapon: number; hp: number } {
  const n0 = map.bases[0].defence.length;
  const team = k < n0 ? 0 : 1;
  const d = map.bases[team].defence[k < n0 ? k : k - n0];
  return { team, x: d.x, y: d.y, weapon: d.weapon, hp: d.hp };
}

/**
 * Spawns one of a base's built-in defence weapons (fcop-logic.md §8.1).
 *
 * Modelled as a team-owned turret entity, because that is what it behaves like:
 * it sits on the base, engages the enemy and can be shot. It is kept as its own
 * slot list rather than folded into the ring so the ring's max-8 concept — and
 * the "destroy an enemy base turret" scoring — keep their meaning.
 */
function spawnBaseDefence(state: SimState, k: number): number {
  const ent = state.ent;
  const { team, x, y, weapon, hp } = baseDefenceSpot(state.map, k);
  const id = spawn(ent, ARCHETYPE.TURRET, team);
  if (id < 0) return -1;
  ent.posX[id] = x;
  ent.posY[id] = y;
  ent.height[id] = sampleHeight(state.map, x, y);
  ent.hp[id] = hp;
  ent.ownerId[id] = team;
  ent.weaponProfile[id] = weapon;
  state.baseDefenceEntity[k] = id;
  return id;
}

/**
 * Spawns a combat unit for `team` at (x, y). Ground units pick their lane via
 * the per-player round-robin counter — or, when `forward` (outpost spawn),
 * join at the nearest waypoint of the nearest lane. Flyers start their patrol
 * orbit at the bearing from their anchor. `mode` is the Guardian spawn-site
 * switch (UNIT_MODE_PATROL at a base, UNIT_MODE_ASSAULT at an outpost).
 */
export function spawnUnit(
  state: SimState,
  archetype: number,
  team: number,
  x: number,
  y: number,
  mode: number = UNIT_MODE_PATROL,
  forward = false,
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
    const graph = state.map.laneGraph;
    const lanes = state.map.lanes;
    if (graph !== undefined) {
      // Original waypoint graph (rules.md §9). A base-built unit starts at its
      // team's entry node; a forward (outpost) spawn joins at the nearest node,
      // scanned in index order so ties break identically on every peer.
      let node = graph.entry[team];
      if (forward) {
        let best = Infinity;
        for (let k = 0; k < graph.nodes.length; k++) {
          const dx = graph.nodes[k].x - x;
          const dy = graph.nodes[k].y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < best) {
            best = d2;
            node = k;
          }
        }
      }
      ent.timerA[id] = node;
      ent.timerB[id] = GRAPH_MODE;
      ent.cooldownB[id] = -1; // no previous node yet
    } else if (lanes.length > 0) {
      let lane: number;
      let wp: number;
      if (forward) {
        lane = 0;
        wp = 0;
        let best = Infinity;
        for (let li = 0; li < lanes.length; li++) {
          for (let wi = 0; wi < lanes[li].length; wi++) {
            const dx = lanes[li][wi].x - x;
            const dy = lanes[li][wi].y - y;
            const d2 = dx * dx + dy * dy;
            if (d2 < best) {
              best = d2;
              lane = li;
              wp = wi;
            }
          }
        }
      } else {
        lane = state.laneCounter[team] % lanes.length;
        state.laneCounter[team] = (lane + 1) % lanes.length;
        wp = team === 0 ? 0 : lanes[lane].length - 1;
      }
      ent.timerA[id] = lane;
      ent.timerB[id] = wp;
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

export function createSim(map: MapData, seed: number, options?: SimOptions): SimState {
  const ringSlots = map.bases[0].turrets.length + map.bases[1].turrets.length;
  // Precinct Assault feature sizes (rules.md §9). Each stays 0 on arenas without
  // the corresponding map data, which is what makes the PA systems no-ops there.
  const defenceSlots = map.bases[0].defence.length + map.bases[1].defence.length;
  const hasCore = map.bases[0].coreHp > 0 || map.bases[1].coreHp > 0;
  const produces = map.bases[0].productionTicks > 0 || map.bases[1].productionTicks > 0;
  // Both config values end up as array indices (avatarId[player], the
  // difficulty knob tables), so coerce to integers — a fractional or NaN
  // input must degrade to a sane config, never poison the sim.
  const rawPlayer = options?.wardenPlayer ?? -1;
  const wardenPlayer = rawPlayer >= 0 ? Math.min(Math.floor(rawPlayer), MAX_PLAYERS - 1) : -1; // NaN fails the >=
  const rawDifficulty = options?.wardenDifficulty ?? 5;
  const wardenDifficulty =
    wardenPlayer >= 0
      ? Math.min(Math.max(rawDifficulty >= 1 ? Math.floor(rawDifficulty) : 1, 1), 10)
      : 0;
  const state: SimState = {
    tick: 0,
    prng: seed | 0,
    winner: -1,
    map,
    ent: createEntityStore(),
    avatarId: new Int32Array(MAX_PLAYERS).fill(-1),
    respawnTimer: new Int32Array(MAX_PLAYERS),
    lastButtons: new Uint8Array(MAX_PLAYERS),
    points: new Uint32Array(MAX_PLAYERS).fill(STARTING_POINTS),
    laneCounter: new Uint8Array(MAX_PLAYERS),
    dummyEntity: new Int32Array(map.dummySpots.length).fill(-1),
    dummyRespawn: new Int32Array(map.dummySpots.length),
    baseTurretEntity: new Int32Array(ringSlots).fill(-1),
    baseTurretRespawn: new Int32Array(ringSlots),
    neutralTurretEntity: new Int32Array(map.turretSpots.length).fill(-1),
    neutralTurretRespawn: new Int32Array(map.turretSpots.length),
    captureTeam: new Int8Array(map.turretSpots.length).fill(-1),
    captureProgress: new Int32Array(map.turretSpots.length),
    outpostOwner: new Int8Array(map.outpostSpots.length).fill(-1),
    outpostConsole: new Int32Array(map.outpostSpots.length).fill(-1),
    outpostRespawn: new Int32Array(map.outpostSpots.length),
    buyTarget: new Int32Array(MAX_PLAYERS).fill(-1),
    lockTarget: new Int32Array(MAX_PLAYERS).fill(-1),
    buyProgress: new Int32Array(MAX_PLAYERS),
    wardenPlayer,
    wardenDifficulty,
    wardenGoal: WGOAL_IDLE,
    wardenSlot: -1,
    wardenThink: 0,
    wardenIncomeAcc: 0,
    baseDefenceEntity: new Int32Array(defenceSlots).fill(-1),
    baseDefenceRespawn: new Int32Array(defenceSlots),
    coreHp: hasCore
      ? Int32Array.from([map.bases[0].coreHp, map.bases[1].coreHp])
      : new Int32Array(0),
    // Seeded to the full cadence so the first free unit appears one interval in,
    // not on tick 0 — otherwise both bases open with a free wave.
    productionTimer: produces
      ? Int32Array.from([map.bases[0].productionTicks, map.bases[1].productionTicks])
      : new Int32Array(0),
    pickupCooldown: new Int32Array(map.pickups.length),
    buffInvuln: new Int32Array(map.pickups.length > 0 ? MAX_PLAYERS : 0),
    buffInvis: new Int32Array(map.pickups.length > 0 ? MAX_PLAYERS : 0),
    buffPower: new Int32Array(map.pickups.length > 0 ? MAX_PLAYERS : 0),
    triggerArm: new Int32Array(map.triggerVolumes.length),
    events: createEventBuffer(),
  };
  for (let p = 0; p < MAX_PLAYERS; p++) {
    spawnAvatar(state, p);
  }
  for (let k = 0; k < ringSlots; k++) {
    spawnBaseTurret(state, k);
  }
  for (let k = 0; k < defenceSlots; k++) {
    spawnBaseDefence(state, k);
  }
  for (let k = 0; k < map.dummySpots.length; k++) {
    spawnDummy(state, k);
  }
  for (let k = 0; k < map.turretSpots.length; k++) {
    spawnNeutralTurret(state, k);
  }
  for (let k = 0; k < map.outpostSpots.length; k++) {
    spawnOutpostConsole(state, k);
  }
  return state;
}

const AXIS_SCALE = 1 / 127;
const GROUND_EPS = 0.001;
/** Height changes up to this snap to the terrain; larger drops become falls. */
export const STEP_SNAP = 0.35;
const MUZZLE_OFFSET = 2;

/** input + avatar movement: transform, jump/gravity, slope/water rules. */
function systemAvatarMovement(state: SimState, inputs: TickInputs): void {
  const ent = state.ent;
  const map = state.map;
  const extent = worldExtent(map);
  for (let p = 0; p < MAX_PLAYERS; p++) {
    // The Warden's slot ignores TickInputs entirely: its superplane is moved
    // by systemWarden, deterministically on every peer.
    if (p === state.wardenPlayer) continue;
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
    // Walkers resolve their deck (base or an upper layer reachable within a
    // step); hover ignores layers and rides the base/water surface.
    let ride = hover
      ? rideHeight(map, x, y, hover)
      : resolveWalker(map, x, y, ent.height[id]).height;
    // Hover always counts as grounded (it rides its clearance height).
    const grounded = hover || (ent.height[id] <= ride + GROUND_EPS && ent.timerB[id] <= 0);

    // Transform (edge-triggered): grounded only, never into walker over water.
    if (!locked && (pressed & BUTTON_TRANSFORM) !== 0 && grounded) {
      if (!(hover && isWater(map, x, y))) {
        hover = !hover;
        ent.mode[id] = hover ? MODE_HOVER : MODE_WALKER;
        ent.timerA[id] = TRANSFORM_LOCK_TICKS;
        ride = hover
          ? rideHeight(map, x, y, hover)
          : resolveWalker(map, x, y, ent.height[id]).height;
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
      if (ok && crossesWallX(map, x, nx, y)) ok = false;
      if (ok && !airborne) {
        const rise = hover
          ? rideHeight(map, nx, y, hover) - rideHeight(map, x, y, hover)
          : resolveWalker(map, nx, y, ent.height[id]).height -
            resolveWalker(map, x, y, ent.height[id]).height;
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
      if (ok && crossesWallY(map, x, y, ny)) ok = false;
      if (ok && !airborne) {
        const rise = hover
          ? rideHeight(map, x, ny, hover) - rideHeight(map, x, y, hover)
          : resolveWalker(map, x, ny, ent.height[id]).height -
            resolveWalker(map, x, y, ent.height[id]).height;
        if (rise > GROUND_EPS && rise > Math.abs(ny - y) * maxSlope) ok = false;
      }
      if (ok) y = ny;
      else ent.velY[id] = 0;
    }
    ent.posX[id] = x;
    ent.posY[id] = y;

    // Vertical: hover snaps to its ride height; walker snaps to terrain for
    // step-sized height changes and integrates gravity for real falls/jumps.
    if (hover) {
      ride = rideHeight(map, x, y, hover);
      ent.height[id] = ride + HOVER_CLEARANCE;
      ent.timerB[id] = 0;
    } else {
      const wr = resolveWalker(map, x, y, ent.height[id]);
      ent.entLayer[id] = wr.layer;
      ride = wr.height;
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

    // Soft-lock (input.spec §4.4 "lock"): the Target-Cycle button acquires or
    // cycles an enemy; the lock lives in the sim so it tracks deterministically
    // on every peer. A lock that dies or drifts out of range releases to free
    // aim (re-lock via the key). The transmitted aim is the fallback.
    if ((pressed & BUTTON_TARGET_CYCLE) !== 0) cycleLockTarget(state, p, id, x, y);
    let lockId = state.lockTarget[p];
    if (lockId >= 0 && !isLockValid(state, p, id, lockId, x, y)) {
      lockId = -1;
      state.lockTarget[p] = -1;
    }

    // Facing: a valid lock tracks its target; else aim wins over movement.
    if (lockId >= 0) {
      const dx = ent.posX[lockId] - x;
      const dy = ent.posY[lockId] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1e-6) {
        const inv = 1 / Math.sqrt(d2);
        ent.aimX[id] = dx * inv;
        ent.aimY[id] = dy * inv;
        ent.yaw[id] = atan2Poly(dy, dx);
      }
    } else {
      // aim wins over movement; both quantized already.
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
    }

    ent.animState[id] =
      (l2 > 0 ? ANIM_MOVING : 0) |
      (hover ? ANIM_HOVER : 0) |
      (ent.height[id] > ride + GROUND_EPS ? ANIM_AIRBORNE : 0) |
      (ent.timerA[id] > 0 ? ANIM_TRANSFORMING : 0);

    // Weapons (sub-step of the avatar system): cooldowns, fire, ammo stub.
    avatarWeapons(state, p, id, input.buttons, nowLocked);
    // Hold-to-buy at consoles (rules.md §3): runs every tick, holds decay.
    systemBuy(state, p, id, input.buttons);
  }
}

/** Lockable = enemy combat entities: avatars, spawned units, and the Warden. */
function isLockable(archetype: number): boolean {
  return archetype <= ARCHETYPE.FORTRESS || archetype === ARCHETYPE.WARDEN;
}

/** A lock holds while its target is a live enemy within AVATAR_LOCK_RANGE. */
function isLockValid(
  state: SimState,
  player: number,
  selfId: number,
  targetId: number,
  x: number,
  y: number,
): boolean {
  const ent = state.ent;
  if (targetId === selfId || !ent.alive[targetId]) return false;
  const team = ent.team[targetId];
  if (team < 0 || team === player) return false; // neutral or own team
  if (!isLockable(ent.archetype[targetId])) return false;
  const dx = ent.posX[targetId] - x;
  const dy = ent.posY[targetId] - y;
  if (dx * dx + dy * dy > AVATAR_LOCK_RANGE * AVATAR_LOCK_RANGE) return false;
  // A wall breaks (and prevents) the lock — same visibility rule as targeting.
  return !segmentBlocked(state.map, x, y, ent.posX[targetId], ent.posY[targetId]);
}

/**
 * Target-Cycle (input.spec §4.4): with no lock, acquire the nearest in-range
 * enemy (ties broken by lowest entity id); with a lock, cycle to the next valid
 * enemy by ascending id, wrapping. Sets `lockTarget[player]` to -1 when nothing
 * is in range. Scans entity arrays in dense id order — identical on every peer.
 */
function cycleLockTarget(
  state: SimState,
  player: number,
  selfId: number,
  x: number,
  y: number,
): void {
  const ent = state.ent;
  const cur = state.lockTarget[player];
  if (cur < 0) {
    let best = -1;
    let bestD2 = AVATAR_LOCK_RANGE * AVATAR_LOCK_RANGE + 1;
    for (let e = 0; e < ent.high; e++) {
      if (!isLockValid(state, player, selfId, e, x, y)) continue;
      const dx = ent.posX[e] - x;
      const dy = ent.posY[e] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        best = e;
        bestD2 = d2;
      }
    }
    state.lockTarget[player] = best;
    return;
  }
  // Already locked: advance to the next valid id after cur, wrapping to 0..cur.
  for (let e = cur + 1; e < ent.high; e++) {
    if (isLockValid(state, player, selfId, e, x, y)) {
      state.lockTarget[player] = e;
      return;
    }
  }
  for (let e = 0; e <= cur; e++) {
    if (isLockValid(state, player, selfId, e, x, y)) {
      state.lockTarget[player] = e;
      return;
    }
  }
  state.lockTarget[player] = -1;
}

/**
 * Hold-to-buy (rules.md §3): standing on a console pad with INTERACT held
 * buys one unit per completed CONSOLE_HOLD_TICKS hold. Switching consoles,
 * toggling the FIRE2 heavy modifier, releasing the button, running out of
 * points or hitting an alive-limit all reset the hold. FIRE2 orders the
 * heavy variant at base consoles and the (assault) air unit at outposts;
 * a neutral outpost console sells the outpost itself — the 30-point claim.
 * Exported for the Warden, which buys through the exact same rules with
 * synthesized buttons (rules.md §7: same rules and economy as a player).
 */
export function systemBuy(state: SimState, player: number, id: number, buttons: number): void {
  const ent = state.ent;
  const map = state.map;
  const r2 = CONSOLE_RADIUS * CONSOLE_RADIUS;
  const heavy = (buttons & BUTTON_FIRE2) !== 0 ? 1 : 0;
  const x = ent.posX[id];
  const y = ent.posY[id];

  let target = -1;
  let cost = 0;
  let archetype = -1;
  let spawnX = 0;
  let spawnY = 0;
  let mode = UNIT_MODE_PATROL;
  let forward = false;
  let claim = -1;

  if ((buttons & BUTTON_INTERACT) !== 0) {
    const base = map.bases[player];
    const gdx = x - base.groundConsole.x;
    const gdy = y - base.groundConsole.y;
    const adx = x - base.airConsole.x;
    const ady = y - base.airConsole.y;
    if (gdx * gdx + gdy * gdy <= r2) {
      target = 256 + heavy;
      archetype = heavy ? ARCHETYPE.JUGGERNAUT : ARCHETYPE.RUNNER;
      cost = heavy ? COST_JUGGERNAUT : COST_RUNNER;
      spawnX = base.groundConsole.x;
      spawnY = base.groundConsole.y;
    } else if (adx * adx + ady * ady <= r2) {
      target = 512 + heavy;
      archetype = heavy ? ARCHETYPE.FORTRESS : ARCHETYPE.GUARDIAN;
      cost = heavy ? COST_FORTRESS : COST_GUARDIAN;
      spawnX = base.airConsole.x;
      spawnY = base.airConsole.y;
    } else {
      for (let k = 0; k < map.outpostSpots.length; k++) {
        const s = map.outpostSpots[k];
        const dx = x - s.x;
        const dy = y - s.y;
        if (dx * dx + dy * dy > r2) continue;
        const owner = state.outpostOwner[k];
        if (owner === player) {
          // Forward spawn at 2× cost (rules.md §3); guardians leave in
          // assault mode — the outpost spawn-site switch (rules.md §4).
          target = 768 + k * 2 + heavy;
          archetype = heavy ? ARCHETYPE.GUARDIAN : ARCHETYPE.RUNNER;
          cost = (heavy ? COST_GUARDIAN : COST_RUNNER) * OUTPOST_COST_MULTIPLIER;
          spawnX = s.x;
          spawnY = s.y;
          mode = heavy ? UNIT_MODE_ASSAULT : UNIT_MODE_PATROL;
          forward = true;
        } else if (owner === -1 && state.outpostConsole[k] >= 0) {
          target = 1024 + k * 2;
          cost = COST_OUTPOST_CLAIM;
          claim = k;
        }
        break;
      }
    }
  }

  // Affordability and alive-limits gate the hold itself.
  if (target >= 0) {
    if (state.points[player] < cost) {
      target = -1;
    } else if (
      archetype === ARCHETYPE.JUGGERNAUT &&
      countAliveOfArchetype(state, archetype, player) >= JUGGERNAUT_ALIVE_LIMIT
    ) {
      target = -1;
    } else if (
      archetype === ARCHETYPE.FORTRESS &&
      countAliveOfArchetype(state, archetype, player) >= FORTRESS_ALIVE_LIMIT
    ) {
      target = -1;
    }
  }

  if (state.buyTarget[player] !== target) {
    state.buyTarget[player] = target;
    state.buyProgress[player] = 0;
  }
  if (target < 0) return;
  state.buyProgress[player] += 1;
  if (state.buyProgress[player] < CONSOLE_HOLD_TICKS) return;
  state.buyProgress[player] = 0; // per-unit hold: the next unit starts fresh

  state.points[player] -= cost;
  if (claim >= 0) {
    state.outpostOwner[claim] = player;
    const cid = state.outpostConsole[claim];
    ent.team[cid] = player;
    ent.ownerId[cid] = player;
    ent.hp[cid] = ARCHETYPE_MAX_HP[ARCHETYPE.CONSOLE];
    pushEvent(state.events, EV_CLAIM, cid, player, claim);
    return;
  }
  const uid = spawnUnit(state, archetype, player, spawnX, spawnY, mode, forward);
  if (uid >= 0) {
    pushEvent(state.events, EV_PURCHASE, uid, player, archetype);
  } else {
    state.points[player] += cost; // entity cap hit: refund, nothing spawned
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
  // Owned outposts also refill ammo — but never repair (rules.md §5).
  for (let k = 0; k < state.outpostOwner.length; k++) {
    if (state.outpostOwner[k] !== player) continue;
    const s = state.map.outpostSpots[k];
    const odx = ent.posX[id] - s.x;
    const ody = ent.posY[id] - s.y;
    if (odx * odx + ody * ody <= OUTPOST_PAD_RADIUS * OUTPOST_PAD_RADIUS) {
      ent.ammoA[id] = AVATAR_AMMO_HEAVY;
      ent.ammoB[id] = AVATAR_AMMO_SPECIAL;
    }
  }

  if (locked) return;
  const dirX = ent.aimX[id];
  const dirY = ent.aimY[id];
  if (dirX === 0 && dirY === 0) return;

  if ((buttons & BUTTON_FIRE1) !== 0 && ent.cooldownA[id] <= 0) {
    ent.cooldownA[id] = PRIMARY_COOLDOWN_TICKS;
    pushEvent(state.events, EV_SHOT, id, 0, 0);
    hitscan(state, id, player, dirX, dirY, PRIMARY_RANGE, PRIMARY_DAMAGE);
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

/** First enemy hit along the 2D ray within `range`, if any (shared w/ Warden). */
export function hitscan(
  state: SimState,
  shooter: number,
  player: number,
  dx: number,
  dy: number,
  range: number,
  damage: number,
): void {
  const ent = state.ent;
  const ox = ent.posX[shooter];
  const oy = ent.posY[shooter];
  const team = ent.team[shooter];
  let bestT = range;
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
    // Walls stop the ray: bestId is the CLOSEST body hit, so a wall on the
    // way to it means the shot hits the wall and nothing else.
    if (segmentBlocked(state.map, ox, oy, ox + dx * bestT, oy + dy * bestT)) return;
    applyDamage(state, bestId, damage, player);
  }
}

export function spawnProjectile(
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
  // Power-up effects (rules.md §9). Both are gated on a non-empty buff array, so
  // an arena without pickups reaches the arithmetic below unchanged.
  if (state.buffInvuln.length > 0) {
    // An invulnerable avatar takes nothing — but the hit still registers as an
    // attribution, so a shielded player can still be credited a kill assist.
    for (let p = 0; p < MAX_PLAYERS; p++) {
      if (state.avatarId[p] === target && state.buffInvuln[p] > 0) return;
    }
    if (attacker >= 0 && attacker < MAX_PLAYERS && state.buffPower[attacker] > 0) {
      damage *= PICKUP_POWER_MULTIPLIER;
    }
  }
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
/**
 * Shortest signed angular difference from `from` to `to`, in (-PI, PI].
 * Plain arithmetic only — no trig, no Math.atan2 (CLAUDE.md rule 1).
 */
function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function systemTargeting(state: SimState): void {
  const ent = state.ent;
  const weapons = state.map.weapons;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id]) continue;
    const archetype = ent.archetype[id];
    if (archetype === ARCHETYPE.TURRET) {
      // Capturable neutral turrets are dormant: no owner, nobody to fire at
      // (rules.md §5 "fires at enemies of its owner").
      if (ent.mode[id] === TURRET_CAPTURABLE && ent.ownerId[id] < 0) continue;
      if (ent.cooldownA[id] > 0) ent.cooldownA[id] -= 1;
      // Per-turret original parameters when the arena carries them (rules.md §9);
      // otherwise the globals, producing bit-identical arithmetic to before.
      const profile = ent.weaponProfile[id];
      const w = profile >= 0 ? weapons[profile] : undefined;
      const range = w ? w.range : TURRET_RANGE;
      const target =
        ent.ownerId[id] < 0
          ? nearestEnemyAvatar(state, id, range)
          : nearestEnemyInRange(state, id, range, true); // mobile targets only
      if (target < 0) continue;
      const bearing = atan2Poly(ent.posY[target] - ent.posY[id], ent.posX[target] - ent.posX[id]);
      let onTarget = true;
      if (w !== undefined && w.turnSpeed > 0) {
        // Slew toward the bearing at the original's turn speed, and only fire
        // once the gun is actually pointing there.
        const d = angleDelta(ent.yaw[id], bearing);
        if (d > w.turnSpeed) {
          ent.yaw[id] += w.turnSpeed;
          onTarget = false;
        } else if (d < -w.turnSpeed) {
          ent.yaw[id] -= w.turnSpeed;
          onTarget = false;
        } else {
          ent.yaw[id] = bearing;
        }
      } else {
        ent.yaw[id] = bearing;
      }
      if (w !== undefined && w.fovCos > -1 && onTarget) {
        // Field of view against the gun's facing. Dot product versus the
        // precomputed cos(fov/2) — no trig at runtime.
        const dx = ent.posX[target] - ent.posX[id];
        const dy = ent.posY[target] - ent.posY[id];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          const fx = cosLUT(ent.yaw[id]);
          const fy = sinLUT(ent.yaw[id]);
          if ((dx * fx + dy * fy) / len < w.fovCos) onTarget = false;
        }
      }
      if (onTarget && ent.cooldownA[id] <= 0) {
        ent.cooldownA[id] = w ? w.delay : TURRET_COOLDOWN_TICKS;
        pushEvent(state.events, EV_SHOT, id, 0, 0);
        // ownerId is the owning player for base turrets (kill credit) and
        // -1 for dummies (no credit) — exactly the Phase 1 rule.
        applyDamage(state, target, w ? w.damage : TURRET_DAMAGE, ent.ownerId[id]);
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

/** Phase 1 dummy-turret targeting: nearest VISIBLE enemy avatar in range. */
function nearestEnemyAvatar(state: SimState, id: number, range: number): number {
  const ent = state.ent;
  let bestD2 = range * range;
  let bestId = -1;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const a = state.avatarId[p];
    if (a < 0 || ent.team[a] === ent.team[id]) continue;
    // An invisible avatar cannot be acquired (rules.md §9). Gated on the buff
    // array so arenas without pickups skip the check entirely.
    if (state.buffInvis.length > 0 && state.buffInvis[p] > 0) continue;
    const dx = ent.posX[a] - ent.posX[id];
    const dy = ent.posY[a] - ent.posY[id];
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      if (segmentBlocked(state.map, ent.posX[id], ent.posY[id], ent.posX[a], ent.posY[a])) {
        continue; // wall between us — not a valid target
      }
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
    const px = ent.posX[id];
    const py = ent.posY[id];
    const x = px + ent.velX[id] * TICK_DT;
    const y = py + ent.velY[id] * TICK_DT;
    // A wall stops the shell on the near side: don't advance into it, so the
    // explosion (and its AOE center) stays on the shooter's side.
    const walled = segmentBlocked(map, px, py, x, y);
    if (!walled) {
      ent.posX[id] = x;
      ent.posY[id] = y;
    }
    const ground = sampleHeight(map, ent.posX[id], ent.posY[id]);
    let boom = walled || ent.timerA[id] <= 0;
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
  const radius =
    kind === PROJ_SPECIAL
      ? SPECIAL_AOE_RADIUS
      : kind === PROJ_WARDEN
        ? WARDEN_HEAVY_AOE_RADIUS
        : HEAVY_AOE_RADIUS;
  const damage =
    kind === PROJ_SPECIAL
      ? SPECIAL_DAMAGE
      : kind === PROJ_WARDEN
        ? WARDEN_HEAVY_DAMAGE
        : HEAVY_DAMAGE;
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
    // Earn table (rules.md §3): avatars 10 (the Warden counts as one),
    // ENEMY-OWNED turrets 2, units 1. Neutral turrets (dummies, dormant
    // capturables) and consoles pay nothing.
    if (killer >= 0 && killer < MAX_PLAYERS && ent.team[id] !== killer) {
      if (archetype === ARCHETYPE.AVATAR || archetype === ARCHETYPE.WARDEN)
        state.points[killer] += POINTS_KILL_AVATAR;
      else if (archetype === ARCHETYPE.TURRET && ent.ownerId[id] >= 0)
        state.points[killer] += POINTS_KILL_TURRET;
      else if (isUnit(archetype)) state.points[killer] += POINTS_KILL_UNIT;
    }
    if (archetype === ARCHETYPE.AVATAR || archetype === ARCHETYPE.WARDEN) {
      const player = ent.ownerId[id];
      state.avatarId[player] = -1;
      state.respawnTimer[player] = RESPAWN_TICKS;
      state.buyTarget[player] = -1; // death drops any buy hold
      state.buyProgress[player] = 0;
      state.lockTarget[player] = -1; // and any soft-lock
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
            slotted = true;
            break;
          }
        }
      }
      if (!slotted) {
        for (let k = 0; k < state.baseDefenceEntity.length; k++) {
          if (state.baseDefenceEntity[k] === id) {
            state.baseDefenceEntity[k] = -1;
            state.baseDefenceRespawn[k] = BASE_TURRET_RESPAWN_TICKS;
            slotted = true;
            break;
          }
        }
      }
      if (!slotted) {
        // Capturable turret: husk now, back as NEUTRAL in 45 s (rules.md §5)
        // regardless of who owned it when it died.
        for (let k = 0; k < state.neutralTurretEntity.length; k++) {
          if (state.neutralTurretEntity[k] === id) {
            state.neutralTurretEntity[k] = -1;
            state.neutralTurretRespawn[k] = NEUTRAL_TURRET_RESPAWN_TICKS;
            break;
          }
        }
      }
    } else if (archetype === ARCHETYPE.CONSOLE) {
      // Console destruction reverts the outpost to neutral (rules.md §5).
      for (let k = 0; k < state.outpostConsole.length; k++) {
        if (state.outpostConsole[k] === id) {
          state.outpostConsole[k] = -1;
          state.outpostOwner[k] = -1;
          state.outpostRespawn[k] = OUTPOST_CONSOLE_RESPAWN_TICKS;
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
  for (let k = 0; k < state.baseTurretRespawn.length; k++) {
    if (state.baseTurretRespawn[k] > 0) {
      state.baseTurretRespawn[k] -= 1;
      if (state.baseTurretRespawn[k] === 0) {
        const id = spawnBaseTurret(state, k);
        if (id >= 0) pushEvent(state.events, EV_RESPAWN, id, -1, 0);
      }
    }
  }
  // Built-in base defence weapons respawn on the ring turret timer: they are the
  // same kind of thing, a structure you can shoot off a base that comes back.
  for (let k = 0; k < state.baseDefenceRespawn.length; k++) {
    if (state.baseDefenceRespawn[k] > 0) {
      state.baseDefenceRespawn[k] -= 1;
      if (state.baseDefenceRespawn[k] === 0) {
        const id = spawnBaseDefence(state, k);
        if (id >= 0) pushEvent(state.events, EV_RESPAWN, id, -1, 0);
      }
    }
  }
  for (let k = 0; k < state.neutralTurretRespawn.length; k++) {
    if (state.neutralTurretRespawn[k] > 0) {
      state.neutralTurretRespawn[k] -= 1;
      if (state.neutralTurretRespawn[k] === 0) {
        const id = spawnNeutralTurret(state, k);
        if (id >= 0) pushEvent(state.events, EV_RESPAWN, id, -1, 0);
      }
    }
  }
  for (let k = 0; k < state.outpostRespawn.length; k++) {
    if (state.outpostRespawn[k] > 0) {
      state.outpostRespawn[k] -= 1;
      if (state.outpostRespawn[k] === 0) {
        const id = spawnOutpostConsole(state, k);
        if (id >= 0) pushEvent(state.events, EV_RESPAWN, id, -1, 0);
      }
    }
  }
}

/**
 * Capture progress (rules.md §5): a lone team's avatar inside the capture
 * radius of a NEUTRAL capturable turret for 3 s takes ownership. An enemy
 * avatar in the radius contests — progress resets. Presence is currency:
 * only avatars capture, units never do.
 */
function systemCapture(state: SimState): void {
  const ent = state.ent;
  const spots = state.map.turretSpots;
  for (let k = 0; k < spots.length; k++) {
    const tid = state.neutralTurretEntity[k];
    if (tid < 0 || ent.ownerId[tid] >= 0) {
      state.captureTeam[k] = -1;
      state.captureProgress[k] = 0;
      continue;
    }
    let present = 0; // team presence bitmask
    for (let p = 0; p < MAX_PLAYERS; p++) {
      const a = state.avatarId[p];
      if (a < 0) continue;
      const dx = ent.posX[a] - spots[k].x;
      const dy = ent.posY[a] - spots[k].y;
      if (dx * dx + dy * dy <= CAPTURE_RADIUS * CAPTURE_RADIUS) present |= 1 << p;
    }
    const team = present === 1 ? 0 : present === 2 ? 1 : -1; // both/none = -1
    if (team < 0 || state.captureTeam[k] !== team) {
      state.captureTeam[k] = team;
      state.captureProgress[k] = 0;
      if (team < 0) continue;
    }
    state.captureProgress[k] += 1;
    if (state.captureProgress[k] < CAPTURE_TICKS) continue;
    state.captureProgress[k] = 0;
    state.captureTeam[k] = -1;
    ent.team[tid] = team;
    ent.ownerId[tid] = team;
    state.points[team] += POINTS_CAPTURE_TURRET;
    pushEvent(state.events, EV_CAPTURE, tid, team, k);
  }
}

/**
 * Trickle income (rules.md §3): +1 to both ledgers every 10 s. The Warden's
 * trickle is scaled by its difficulty's income multiplier (PLAN Phase 4) —
 * the ONLY resource asymmetry it gets; every other earn event is the shared
 * table. Fixed-point percent accumulator keeps the math integer-exact.
 */
function systemEconomy(state: SimState): void {
  if (state.tick === 0 || state.tick % TRICKLE_INTERVAL_TICKS !== 0) return;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if (p === state.wardenPlayer) {
      const pct = WARDEN_INCOME_PERCENT[state.wardenDifficulty - 1];
      const total = TRICKLE_POINTS * pct + state.wardenIncomeAcc;
      state.points[p] += Math.floor(total / 100);
      state.wardenIncomeAcc = total % 100;
    } else {
      state.points[p] += TRICKLE_POINTS;
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
  // Precinct Assault objective (rules.md §9): a razed base ends the match, and
  // it REPLACES the gate breach on arenas that carry a core. Arenas with
  // coreHp 0 fall straight through to the original gate rule below.
  if (state.coreHp.length > 0) {
    for (let team = 0; team < 2; team++) {
      if (state.map.bases[team].coreHp === 0) continue;
      if (state.coreHp[team] > 0) continue;
      state.winner = team ^ 1;
      pushEvent(state.events, EV_BREACH, -1, team ^ 1, 0);
      return;
    }
    return;
  }
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

/**
 * Free base production (rules.md §9): each base puts one Runner on its own lane
 * every `productionTicks`.
 *
 * Additive to the points economy — consoles and costs are untouched — so a base
 * is a slow, free trickle of pressure the player must escort or intercept, the
 * way it works in the original.
 */
function systemProduction(state: SimState): void {
  if (state.productionTimer.length === 0) return; // arena has no production
  for (let team = 0; team < 2; team++) {
    const base = state.map.bases[team];
    if (base.productionTicks === 0) continue;
    state.productionTimer[team] -= 1;
    if (state.productionTimer[team] > 0) continue;
    state.productionTimer[team] = base.productionTicks;
    // The map's ceiling, hard-capped by ours: the entity store is finite and a
    // free 12 units/minute per base would eventually exhaust it.
    const limit = Math.min(base.productionLimit, PA_PRODUCTION_ALIVE_LIMIT);
    let alive = 0;
    const ent = state.ent;
    for (let id = 0; id < ent.high; id++) {
      if (ent.alive[id] && ent.team[id] === team && ent.archetype[id] === ARCHETYPE.RUNNER) {
        alive += 1;
      }
    }
    if (alive >= limit) continue;
    const uid = spawnUnit(
      state,
      ARCHETYPE.RUNNER,
      team,
      base.groundConsole.x,
      base.groundConsole.y,
    );
    if (uid >= 0) pushEvent(state.events, EV_PRODUCE, uid, team, ARCHETYPE.RUNNER);
  }
}

/**
 * Power-ups (rules.md §9). Runs AFTER damage/death so a pickup can never heal an
 * avatar that died on this tick, and before the triggers so intrusion detection
 * sees final positions.
 */
function systemPickups(state: SimState): void {
  const spots = state.map.pickups;
  if (spots.length === 0) return;
  const ent = state.ent;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if (state.buffInvuln[p] > 0) state.buffInvuln[p] -= 1;
    if (state.buffInvis[p] > 0) state.buffInvis[p] -= 1;
    if (state.buffPower[p] > 0) state.buffPower[p] -= 1;
  }
  const r2 = PICKUP_RADIUS * PICKUP_RADIUS;
  for (let k = 0; k < spots.length; k++) {
    if (state.pickupCooldown[k] > 0) {
      state.pickupCooldown[k] -= 1;
      continue;
    }
    // Player slot order is the tie-break when both stand on a spot: arbitrary,
    // but identical on every peer, which is what matters.
    for (let p = 0; p < MAX_PLAYERS; p++) {
      const a = state.avatarId[p];
      if (a < 0) continue;
      const dx = ent.posX[a] - spots[k].x;
      const dy = ent.posY[a] - spots[k].y;
      if (dx * dx + dy * dy > r2) continue;
      const kind = spots[k].kind;
      if (kind === PICKUP_HEAVY_AMMO) ent.ammoA[a] = AVATAR_AMMO_HEAVY;
      else if (kind === PICKUP_SPECIAL_AMMO) ent.ammoB[a] = AVATAR_AMMO_SPECIAL;
      else if (kind === PICKUP_HEALTH) {
        ent.hp[a] = Math.min(AVATAR_HP, ent.hp[a] + PICKUP_HEALTH_AMOUNT);
      } else if (kind === PICKUP_INVULN) state.buffInvuln[p] = PICKUP_INVULN_TICKS;
      else if (kind === PICKUP_INVIS) state.buffInvis[p] = PICKUP_INVIS_TICKS;
      else if (kind === PICKUP_POWER) state.buffPower[p] = PICKUP_POWER_TICKS;
      state.pickupCooldown[k] = spots[k].respawnTicks;
      pushEvent(
        state.events,
        EV_PICKUP,
        Math.round(spots[k].x * 16),
        Math.round(spots[k].y * 16),
        kind,
      );
      break;
    }
  }
}

/**
 * Base-intrusion detection (rules.md §9, fcop-logic.md §8.6): fires an alarm when
 * a watched actor enters a base's volume.
 *
 * Detection only, exactly as the original data is — the alert SOUND lived in the
 * undecoded Cfun script. Re-arming is gated here rather than in the client so
 * every peer (and every replay) agrees on when the alarm sounded.
 */
function systemTriggers(state: SimState): void {
  const volumes = state.map.triggerVolumes;
  if (volumes.length === 0) return;
  const ent = state.ent;
  for (let v = 0; v < volumes.length; v++) {
    if (state.triggerArm[v] > 0) {
      state.triggerArm[v] -= 1;
      continue;
    }
    const vol = volumes[v];
    const foe = vol.team ^ 1;
    let intruder = -1;
    if ((vol.watch & TRIGGER_WATCH_ENEMY_AVATAR) !== 0) {
      const a = state.avatarId[foe];
      if (a >= 0 && insideVolume(ent, a, vol)) intruder = a;
    }
    if (intruder < 0 && (vol.watch & TRIGGER_WATCH_ENEMY_UNITS) !== 0) {
      for (let id = 0; id < ent.high; id++) {
        if (!ent.alive[id] || ent.team[id] !== foe || !isUnit(ent.archetype[id])) continue;
        if (insideVolume(ent, id, vol)) {
          intruder = id;
          break;
        }
      }
    }
    if (intruder < 0 && (vol.watch & TRIGGER_WATCH_OWN_AVATAR) !== 0) {
      const a = state.avatarId[vol.team];
      if (a >= 0 && insideVolume(ent, a, vol)) intruder = a;
    }
    if (intruder < 0) continue;
    state.triggerArm[v] = TRIGGER_REARM_TICKS;
    pushEvent(state.events, EV_ALARM, Math.round(vol.x * 16), Math.round(vol.y * 16), vol.team);
  }
}

/** Axis-aligned containment test for an intrusion volume. */
function insideVolume(ent: EntityStore, id: number, vol: MapTriggerVolume): boolean {
  const dx = ent.posX[id] - vol.x;
  const dy = ent.posY[id] - vol.y;
  return dx <= vol.halfW && dx >= -vol.halfW && dy <= vol.halfL && dy >= -vol.halfL;
}

/**
 * Ground units chew through the enemy base core (rules.md §9).
 *
 * Only units, never the Avatar or the Warden — pillar 1 says the player is escort
 * and disruptor, never the win condition, and that survives the change of
 * objective. Reuses the unit's own fire cooldown so a unit either shoots a target
 * or the core, not both in one tick.
 */
function systemCoreAttack(state: SimState): void {
  if (state.coreHp.length === 0) return;
  const ent = state.ent;
  const r2 = CORE_ATTACK_RADIUS * CORE_ATTACK_RADIUS;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || !isGroundUnit(ent.archetype[id])) continue;
    const team = ent.team[id];
    if (team !== 0 && team !== 1) continue;
    const foe = team ^ 1;
    if (state.map.bases[foe].coreHp === 0 || state.coreHp[foe] <= 0) continue;
    const core = state.map.bases[foe].core;
    const dx = ent.posX[id] - core.x;
    const dy = ent.posY[id] - core.y;
    if (dx * dx + dy * dy > r2) continue;
    if (ent.cooldownA[id] > 0) continue;
    ent.cooldownA[id] = UNIT_FIRE_COOLDOWN_TICKS[ent.archetype[id]];
    state.coreHp[foe] -= CORE_DAMAGE_PER_SHOT;
    pushEvent(state.events, EV_CORE_HIT, Math.round(core.x * 16), Math.round(core.y * 16), foe);
  }
}

/** Advances the sim by exactly one tick. Synchronous, allocation-free. */
export function step(state: SimState, inputs: TickInputs): void {
  clearEvents(state.events);
  // A breached match freezes: the tick (and thus the hash stream) keeps
  // advancing for replays/netcode, but no gameplay system runs anymore.
  if (state.winner === -1) {
    systemAvatarMovement(state, inputs);
    // The Warden slots in directly after the human avatars: it IS the other
    // avatar (decision layer + superplane movement + weapons + buying), so it
    // observes the same pre-unit-movement world a player does.
    systemWarden(state);
    systemUnitMovement(state);
    systemTargeting(state);
    systemProjectiles(state);
    systemDamageDeath(state);
    systemCapture(state);
    // Precinct Assault systems (rules.md §9), inert on arenas without PA data.
    // Order is behavior and is deliberate: pickups after death so a dying avatar
    // cannot be healed; triggers after pickups so detection reads final
    // positions; core damage before the win check; production just before
    // spawning, so every new entity of a tick appears at the same boundary.
    systemPickups(state);
    systemTriggers(state);
    systemCoreAttack(state);
    systemEconomy(state);
    systemProduction(state);
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
  // Layer state is hashed ONLY on layered maps — single-story maps keep their
  // exact pre-v10 hash sequences (No-op invariant, mirrors the Warden flag).
  if (state.map.layerHeights.length > 0) {
    for (let id = 0; id < ent.high; id++) {
      if (ent.alive[id]) h = fnv1aU32(h, ent.entLayer[id]);
    }
  }
  for (let p = 0; p < MAX_PLAYERS; p++) {
    h = fnv1aU32(h, state.avatarId[p] >>> 0);
    h = fnv1aU32(h, state.respawnTimer[p] >>> 0);
    h = fnv1aU32(h, state.lastButtons[p]);
    h = fnv1aU32(h, state.points[p] >>> 0);
    h = fnv1aU32(h, state.laneCounter[p]);
    h = fnv1aU32(h, state.buyTarget[p] >>> 0);
    h = fnv1aU32(h, state.buyProgress[p] >>> 0);
    h = fnv1aU32(h, state.lockTarget[p] >>> 0);
  }
  for (let k = 0; k < state.dummyEntity.length; k++) {
    h = fnv1aU32(h, state.dummyEntity[k] >>> 0);
    h = fnv1aU32(h, state.dummyRespawn[k] >>> 0);
  }
  for (let k = 0; k < state.baseTurretEntity.length; k++) {
    h = fnv1aU32(h, state.baseTurretEntity[k] >>> 0);
    h = fnv1aU32(h, state.baseTurretRespawn[k] >>> 0);
  }
  for (let k = 0; k < state.neutralTurretEntity.length; k++) {
    h = fnv1aU32(h, state.neutralTurretEntity[k] >>> 0);
    h = fnv1aU32(h, state.neutralTurretRespawn[k] >>> 0);
    h = fnv1aU32(h, state.captureTeam[k] >>> 0);
    h = fnv1aU32(h, state.captureProgress[k] >>> 0);
  }
  for (let k = 0; k < state.outpostOwner.length; k++) {
    h = fnv1aU32(h, state.outpostOwner[k] >>> 0);
    h = fnv1aU32(h, state.outpostConsole[k] >>> 0);
    h = fnv1aU32(h, state.outpostRespawn[k] >>> 0);
  }
  // Precinct Assault state, APPENDED after everything above and each block
  // guarded by its own feature list. On an arena without PA data every loop here
  // runs zero times and every `if` is false, so the byte stream — and therefore
  // the hash — is bit-identical to before v13. That is the whole argument for
  // why the existing goldens keep their hash sequences.
  for (let k = 0; k < state.baseDefenceEntity.length; k++) {
    h = fnv1aU32(h, state.baseDefenceEntity[k] >>> 0);
    h = fnv1aU32(h, state.baseDefenceRespawn[k] >>> 0);
  }
  for (let k = 0; k < state.coreHp.length; k++) {
    h = fnv1aU32(h, state.coreHp[k] >>> 0);
  }
  for (let k = 0; k < state.productionTimer.length; k++) {
    h = fnv1aU32(h, state.productionTimer[k] >>> 0);
  }
  for (let k = 0; k < state.pickupCooldown.length; k++) {
    h = fnv1aU32(h, state.pickupCooldown[k] >>> 0);
  }
  for (let p = 0; p < state.buffInvuln.length; p++) {
    h = fnv1aU32(h, state.buffInvuln[p] >>> 0);
    h = fnv1aU32(h, state.buffInvis[p] >>> 0);
    h = fnv1aU32(h, state.buffPower[p] >>> 0);
  }
  for (let k = 0; k < state.triggerArm.length; k++) {
    h = fnv1aU32(h, state.triggerArm[k] >>> 0);
  }
  // Weapon profiles are a side array like entLayer: hashed only where they exist.
  if (state.map.weapons.length > 0) {
    for (let id = 0; id < ent.high; id++) {
      if (ent.alive[id]) h = fnv1aU32(h, ent.weaponProfile[id] >>> 0);
    }
  }
  // Warden decision state is hashed only when a Warden exists: matches
  // without one keep their exact pre-Phase-4 hash sequences (goldens 1–3
  // stay valid). The flag itself is match config, identical on every peer.
  if (state.wardenPlayer >= 0) {
    h = fnv1aU32(h, state.wardenPlayer >>> 0);
    h = fnv1aU32(h, state.wardenDifficulty >>> 0);
    h = fnv1aU32(h, state.wardenGoal >>> 0);
    h = fnv1aU32(h, state.wardenSlot >>> 0);
    h = fnv1aU32(h, state.wardenThink >>> 0);
    h = fnv1aU32(h, state.wardenIncomeAcc >>> 0);
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
