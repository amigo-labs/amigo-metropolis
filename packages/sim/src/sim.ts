// The simulation core. API surface per architecture.md §2 — keep this exact
// shape: createSim / step / hash / writeSnapshot.
//
// System order inside step() is FIXED and part of determinism (order is
// behavior — document any change):
//   input → avatar movement+weapons → unit lane-following → targeting →
//   projectiles → damage/death → capture → economy → spawning →
//   win check.
// Phase 1 implements avatar movement/weapons, turret targeting (sandbox
// dummies), projectiles, damage/death and (re)spawning; later phases fill in
// the rest WITHOUT reordering.

import { ARCHETYPE, TEAM_NEUTRAL } from "./archetypes";
import {
  ARC_FREE_AIM_DISTANCE,
  ARCHETYPE_MAX_HP,
  ARCHETYPE_RADIUS,
  AVATAR_HOVER_MAX_SLOPE,
  AVATAR_HP,
  AVATAR_LOCK_ACQUIRE_COS,
  AVATAR_LOCK_HOLD_COS,
  AVATAR_LOCK_RANGE,
  AVATAR_WALKER_MAX_SLOPE,
  BASE_TURRET_RESPAWN_TICKS,
  CLOAK_DISARM_RADIUS,
  CONSOLE_RADIUS,
  COST_FORTRESS,
  COST_GUARDIAN,
  COST_JUGGERNAUT,
  COST_OUTPOST_CLAIM,
  COST_RUNNER,
  DUMMY_RESPAWN_TICKS,
  FLAME_PULSE_TICKS,
  FORTRESS_ALIVE_LIMIT,
  GUARDIAN_ALIVE_LIMIT,
  HEAVY_UNLOCK_POINTS,
  HELLFIRE_SPLIT_FAN,
  HOVER_BRAKE_DRAG,
  HOVER_CLEARANCE,
  HOVER_CUSHION_SPAN,
  HOVER_DRAG,
  HOVER_HOLD_DOWN,
  HOVER_IDLE_CEILING,
  HOVER_IDLE_KNEE,
  HOVER_IDLE_SLOPE,
  HOVER_PUSH_FORE,
  HOVER_PUSH_STRAFE,
  HOVER_SLOPE_GAIN,
  HOVER_SLOPE_KNEE,
  HOVER_SPEED_CAP,
  HOVER_STOP_SPEED,
  HOVER_TURN_LIMIT,
  JUGGERNAUT_ALIVE_LIMIT,
  LOW_AMMO_WARNING,
  MATCH_OUTRO_TICKS,
  MAX_PLAYERS,
  MISSILE_TURN_RATE,
  MORTAR_FRAGMENT_SPREAD,
  MUZZLE_HEIGHT,
  MUZZLE_OFFSET,
  NEUTRAL_TURRET_RESPAWN_TICKS,
  OUTPOST_COST_MULTIPLIER,
  OUTPOST_PAD_RADIUS,
  OUTPOST_TURRET_RESPAWN_TICKS,
  OUTPOST_ZONE_RADIUS,
  PAD_REPAIR_HP_PER_TICK,
  PICKUP_GUN_AMMO,
  PICKUP_HEALTH,
  PICKUP_HEAVY_AMMO,
  PICKUP_INVIS,
  PICKUP_INVIS_TICKS,
  PICKUP_INVULN,
  PICKUP_INVULN_TICKS,
  PICKUP_POWER_GUN,
  PICKUP_POWER_HEAVY,
  PICKUP_POWER_SPECIAL,
  PICKUP_RADIUS,
  PICKUP_SPECIAL_AMMO,
  POINTS_AVATAR_DOWN,
  POINTS_CAPTURE_TURRET,
  POINTS_HEAVY_DIES,
  POINTS_TURRET_DIES,
  POINTS_UNIT_DIES,
  RESPAWN_TICKS,
  RUNNER_ALIVE_LIMIT,
  retentionPerTick,
  SHOOTER_RETRY_UNITS,
  SKY_BOMB_BLAST,
  SKY_BOMB_DAMAGE,
  SKY_MISSILE_DAMAGE,
  SKY_MISSILE_FLIGHT,
  SPECIAL_MINE_ARM_TICKS,
  SPECIAL_MINE_FUSE_TICKS,
  SPECIAL_MINE_TTL_TICKS,
  STARTING_POINTS,
  skyRespawnTicks,
  TICK_DT,
  TICK_HZ,
  TRANSFORM_LOCK_TICKS,
  TRIGGER_REARM_TICKS,
  TRIGGER_WATCH_ENEMY_AVATAR,
  TRIGGER_WATCH_ENEMY_UNITS,
  TRIGGER_WATCH_OWN_AVATAR,
  TURRET_ALERT_COOLDOWN_TICKS,
  WALKER_AIR_DRAG,
  WALKER_DRAG,
  WALKER_HIGH_LIFT,
  WALKER_HIGH_RISE,
  WALKER_HOP_LIFT,
  WALKER_HOP_PUSH,
  WALKER_LEAP_LIFT,
  WALKER_LEAP_PUSH,
  WALKER_LUNGE_MAX_RISE,
  WALKER_LUNGE_PUSH,
  WALKER_LUNGE_TICKS,
  WALKER_PROBE_AHEAD,
  WALKER_PROBE_LIFT,
  WALKER_PUSH_FORE,
  WALKER_PUSH_STRAFE,
  WALKER_SLOPE_GAIN,
  WALKER_SLOPE_KNEE,
  WALKER_STEEP_TILT,
  WALKER_STOP_SPEED,
  WALKER_TURN_STEP,
  WALKER_TURN_ZERO_SPEED,
  WARDEN_ALTITUDE,
  WARDEN_HEAVY_SPEED,
  WARDEN_HEAVY_TTL_TICKS,
  WEAPON_UNITS_PER_TICK,
  wardenLevel,
  X1_DIAGONAL_SCALE,
  X1_GRAVITY,
  X1_IMPACT_HP,
  X1_IMPACT_SCALE,
  X1_IMPACT_SPEED,
  X1_IMPACT_SPEED_MAX,
  X1_STEPS_PER_TICK,
  X1_STICK_SECTOR,
  X1_TERMINAL_FALL,
  X1_UNITS_PER_TICK,
} from "./balance";
import { crossesWallX, crossesWallY, segmentBlocked, segmentBlockT } from "./collision";
import { createEntityStore, despawn, type EntityStore, spawn } from "./entities";
import {
  clearEvents,
  createEventBuffer,
  EV_ALARM,
  EV_BREACH,
  EV_CAPTURE,
  EV_CLAIM,
  EV_DEATH,
  EV_DRY_FIRE,
  EV_EXPLOSION,
  EV_HIT,
  EV_LOW_AMMO,
  EV_PICKUP,
  EV_PURCHASE,
  EV_PURCHASE_REFUSED,
  EV_RESPAWN,
  EV_SHOT,
  EV_TRANSFORM,
  EV_TRANSFORM_REFUSED,
  EV_TURRET_LOST,
  EV_TURRET_UNDER_FIRE,
  type EventBuffer,
  pushEvent,
  reachToShotPayload,
  SHOT_SLOT_HITSCAN,
  SHOT_SLOT_LAUNCH,
  SKY_WEAPON_MISSILE,
  weaponShotPayload,
} from "./events";
import { fnv1aBytes, fnv1aF32, fnv1aInit, fnv1aU32 } from "./hash";
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
  insideGate,
  isWater,
  type MapBaseTurret,
  type MapData,
  type MapTriggerVolume,
  type MapWeapon,
  resolveHeight,
  sampleHeight,
  worldExtent,
} from "./map";
import { atan2Poly, cosLUT, rand01, sinLUT } from "./simMath";
import {
  aircraftEngaged,
  isAirUnit,
  isGroundUnit,
  isUnit,
  nearestEnemyInRange,
  resolveWalker,
  snapUnitHeight,
  startAircraft,
  startRoute,
  systemUnitMovement,
  UNIT_MODE_OUTPOST,
  UNIT_MODE_PATROL,
  unitRange,
} from "./units";
import {
  type CaptainState,
  captainConstruct,
  captainCredit,
  captainMaxHp,
  captainRespawn,
  captainRestore,
  createCaptainState,
  systemWarden,
} from "./warden";
import {
  DEFAULT_LOADOUT,
  type Loadout,
  normalizeLoadout,
  PROJ_BEAM,
  PROJ_MINE,
  PROJ_ROUND,
  PROJ_SPLASH,
  PROJ_WARDEN,
  resolveLoadout,
  type WeaponBlock,
  type WeaponDef,
  weaponInSlot,
} from "./weapons";

// Avatar modes (EntityStore.mode).
export const MODE_WALKER = 0;
export const MODE_HOVER = 1;

// Turret kinds (EntityStore.mode on TURRET entities).
// Visual mesh modes: DEFENSE → turret-defense.glb, DUMMY/CAPTURABLE → turret-standard.glb.
export const TURRET_DEFENSE = 0; //     base ring: full targeting (mesh mode "Defense")
/** @deprecated Use TURRET_DEFENSE — same value (0). */
export const TURRET_BASE = TURRET_DEFENSE;
export const TURRET_DUMMY = 1; //       Phase 1 sandbox: engages avatars only (mesh mode "Standard")
export const TURRET_CAPTURABLE = 2; //  neutral spot: dormant until captured (mesh mode "Standard")
// 3 was TURRET_BUILTIN, the "built-in base guns" — retired with them in
// SIM_VERSION 32: they were the Dreadnought's hull guns (fcop-fidelity.md I6).

// animState bits (renderer-facing; snapshot field 7).
export const ANIM_MOVING = 1 << 0;
export const ANIM_HOVER = 1 << 1;
export const ANIM_AIRBORNE = 1 << 2;
export const ANIM_TRANSFORMING = 1 << 3;

// MATCH_SLOT_MOVE bits (SimState.moveCue).
export const MOVE_CUE_DRIVE = 1 << 0;
export const MOVE_CUE_BRAKE = 1 << 1;
export const MOVE_CUE_TURN = 1 << 2;

/**
 * Match configuration beyond map+seed. Part of the replay header (format 2)
 * and the online handshake — every peer must create the sim identically.
 */
export interface SimOptions {
  /** Player slot driven by the in-sim Warden AI (rules.md §7). */
  wardenPlayer?: number;
  /** Warden difficulty 1–10 (clamped). */
  wardenDifficulty?: number;
  /**
   * Per-player weapon loadout (gun/heavy/special indices). Length 1 or
   * MAX_PLAYERS; missing slots use the default historic kit.
   */
  loadouts?: readonly (Partial<Loadout> | undefined)[];
}

export interface SimState {
  /** The only clock the sim knows. */
  tick: number;
  /** mulberry32 state word. */
  prng: number;
  /** Winning team, -1 while the match runs. Set once; the sim then freezes. */
  winner: number;
  /**
   * Ticks left of the match outro (MATCH_OUTRO_TICKS after a gate breach), 0 when
   * none is running. The match keeps playing through it; `winner` is set when it
   * reaches zero (rules.md §1, fcop-fidelity.md R1).
   */
  outroTimer: number;
  /** Team the running outro will declare the winner, -1 when none is running. */
  outroWinner: number;
  readonly map: MapData;
  readonly ent: EntityStore;
  /** Entity id of each player's avatar, -1 while dead/none. */
  readonly avatarId: Int32Array;
  /** Ticks until the player's avatar respawns (0 = not pending). */
  readonly respawnTimer: Int32Array;
  /** Previous tick's buttons per player, for edge detection. */
  readonly lastButtons: Uint8Array;
  /**
   * What each avatar was told to do this tick, as the original's movement code
   * reads its button word: MOVE_CUE_DRIVE (a fore/aft or strafe command),
   * MOVE_CUE_BRAKE (the hover's brake), MOVE_CUE_TURN (the hull turned). The
   * original picks the X1's movement sound from these, not from the velocity
   * (`player_hover_tick` 0x0044267f). Presentation only: rewritten every tick,
   * read by the match snapshot, and NOT hashed (like the events).
   */
  readonly moveCue: Uint8Array;
  /** Current Points per player: what a side spends (rules.md §3). */
  readonly points: Uint32Array;
  /**
   * 1 once the side has reached HEAVY_UNLOCK_POINTS: the Juggernaut/Fortress
   * purchase opens the first time a side reaches 50 points and stays open
   * (fcop-fidelity.md R10).
   */
  readonly heavyUnlocked: Uint8Array;
  /** Next lane index per player (ground-unit round-robin). */
  readonly laneCounter: Uint8Array;
  /** Sandbox dummy turrets: entity id (-1 dead) + respawn countdown per spot. */
  readonly dummyEntity: Int32Array;
  readonly dummyRespawn: Int32Array;
  /** Base ring turrets, slots flattened base 0 then base 1 (rules.md §5). */
  readonly baseTurretEntity: Int32Array;
  readonly baseTurretRespawn: Int32Array;
  /**
   * Capturable turrets, one slot per map turretSpot (rules.md §5). A respawn of
   * -1 is a shut spawner: an outpost claim killed that plate's neutral for good
   * (fcop-re/outposts.md Q1).
   */
  readonly neutralTurretEntity: Int32Array;
  readonly neutralTurretRespawn: Int32Array;
  /**
   * Outpost plate turrets, one slot per map outpostPlate: the claimer's team
   * turret, entity id (-1 none) and respawn countdown (0 = none pending). Empty
   * until a claim opens them; zero-length on an arena without plates.
   */
  readonly plateTurretEntity: Int32Array;
  readonly plateTurretRespawn: Int32Array;
  /**
   * 1 for a player whose avatar pressed the action key (BUTTON_INTERACT, rising
   * edge) this tick. TRANSIENT and not hashed: set by systemAvatarMovement and
   * cleared by systemCapture in the same tick, so it is all-zero between ticks.
   */
  readonly capturePress: Uint8Array;
  /**
   * Outposts, one slot per map outpostSpot: owner and console entity. A claim
   * is permanent on every arena (R14): the console takes no damage, so nothing
   * respawns (district-01's console-destruction revert went in SIM_VERSION 52).
   */
  readonly outpostOwner: Int8Array;
  readonly outpostConsole: Int32Array;
  /**
   * The X1-Alpha's lock per player (-1 none): the original's view+0x6c, held,
   * cycled and auto-acquired in-sim (`updateLock`). Hitscan guns damage only it.
   */
  readonly lockTarget: Int32Array;
  /**
   * 1 while the lock was taken by the player's own cycle press: then it is the
   * heading the hull turns to (input.spec §4.4 `lock` mode). 0 for none or an
   * auto-acquired lock, which aims the weapons only.
   */
  readonly lockSteer: Uint8Array;
  /**
   * The Gun slot's block-A magazine per player (the Heavy's and the Special's
   * are the avatar entity's ammoA / ammoB). The original's guns have finite
   * ammunition too (the Mini-Gun 7500 rounds on NORMAL; fcop-fidelity.md W1).
   */
  readonly gunAmmo: Uint16Array;
  /** Rounds left in the current burst, per player and slot (player * 3 + slot). */
  readonly burstLeft: Uint8Array;
  /**
   * Avatar loadout indices per player (Future Cop style gun/heavy/special).
   * Config-only — not hashed (peers agree via MatchConfig / createSim options).
   * Default 0/0/0 is the original kit: Mini-Gun + Hell Fire 2000 + Mortar.
   */
  readonly loadoutGun: Uint8Array;
  readonly loadoutHeavy: Uint8Array;
  readonly loadoutSpecial: Uint8Array;
  /** Player slot the Warden AI drives, -1 for a match without one (config). */
  readonly wardenPlayer: number;
  /** Warden difficulty 1–10 (config; 0 when wardenPlayer is -1). */
  readonly wardenDifficulty: number;
  /** The Warden's Sky Captain state (warden.ts); hashed only when a Warden exists. */
  readonly captain: CaptainState;

  // --- Precinct Assault state (rules.md §9) --------------------------------
  // Every array here is sized from the map's own feature lists, so on an arena
  // without PA data they are zero-length and every PA system iterates nothing.
  /** Ticks until each pickup spot re-arms (0 = available). */
  readonly pickupCooldown: Int32Array;
  /** Power-up timers per player; length 0 when the arena has no pickups. */
  readonly buffInvuln: Int32Array;
  readonly buffInvis: Int32Array;
  /**
   * Block-B (powered-up) magazines per player and slot (player * 3 + slot): the
   * original's `ammo_b` (fcop-fidelity.md P8). A slot with B ammunition fires its
   * block B. 0 = not powered; cleared when the avatar goes down.
   */
  readonly powerAmmo: Uint16Array;
  /** Ticks until each intrusion volume can fire again (shared per base). */
  readonly triggerArm: Int32Array;
  /**
   * Ticks until each side's "base turret under fire" alert can fire again
   * (TURRET_ALERT_COOLDOWN_TICKS). Length MAX_PLAYERS on an arena with ring
   * turrets, 0 otherwise — so a map with none hashes exactly as before.
   */
  readonly turretAlert: Int32Array;

  // --- X1-Alpha movement state, per player (fcop-fidelity.md P4/P5) ---------
  /**
   * The hover's turn-rate word (the original's block +0xc2), in engine angle
   * units: ramps toward +-HOVER_TURN_LIMIT while turning, 0 on a release.
   */
  readonly avatarTurnRate: Float32Array;
  /** The hover's idle timer (block +0xdc), engine units, capped at 0x800. */
  readonly avatarIdle: Int32Array;
  /** Ticks until the high jump's lunge (byte +0xc2's countdown), 0 for none. */
  readonly avatarLunge: Int32Array;

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
  // Feature layer (issue #33): spawn height is the surface the spawn sits on,
  // not always the ground under it. layer 0 → sampleHeight (bit-identical).
  const ground = resolveHeight(state.map, s.x, s.y, s.layer);
  ent.height[id] = warden ? Math.max(ground, state.map.waterLevel) + WARDEN_ALTITUDE : ground;
  ent.entLayer[id] = warden ? 0 : s.layer;
  ent.yaw[id] = s.yaw;
  ent.aimX[id] = cosLUT(s.yaw);
  ent.aimY[id] = sinLUT(s.yaw);
  ent.hp[id] = warden ? captainMaxHp(state) : AVATAR_HP;
  // Spawn form (fcop-fidelity.md P2): every respawn comes back in the form the
  // spawn record asks for, as `player_respawn` resets the row from the record.
  const hover = !warden && s.hover;
  ent.mode[id] = hover ? MODE_HOVER : MODE_WALKER;
  if (hover) ent.height[id] = rideHeight(state.map, s.x, s.y, true) + HOVER_CLEARANCE;
  if (warden) {
    ent.ammoA[id] = 0;
    ent.ammoB[id] = 0;
    state.gunAmmo[player] = 0;
  } else {
    // `player_respawn`: all three A magazines to their ceilings, and each burst
    // counter from its block (fcop-re/player-and-weapons.md §1, §7).
    refillAmmo(state, player, id);
    for (let k = 0; k < 3; k++) state.powerAmmo[player * 3 + k] = 0;
    const kit = loadoutOf(state, player);
    state.burstLeft[player * 3] = kit.gun.a.rounds;
    state.burstLeft[player * 3 + 1] = kit.heavy.a.rounds;
    state.burstLeft[player * 3 + 2] = kit.special.a.rounds;
  }
  ent.ownerId[id] = player;
  state.avatarId[player] = id;
  state.avatarTurnRate[player] = 0;
  state.avatarIdle[player] = 0;
  state.avatarLunge[player] = 0;
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
  ent.height[id] = resolveHeight(state.map, spot.x, spot.y, spot.layer);
  ent.entLayer[id] = spot.layer;
  ent.hp[id] = ARCHETYPE_MAX_HP[ARCHETYPE.TURRET];
  ent.ownerId[id] = -1;
  ent.mode[id] = TURRET_DUMMY;
  // Its gun is the original neutral turret's (SIM_VERSION 52); the dummy, its
  // avatar-only targeting and its 15 s respawn are Metropolis'.
  ent.weaponProfile[id] = state.map.dummyWeapon;
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
  ent.height[id] = resolveHeight(state.map, spot.x, spot.y, spot.layer);
  ent.entLayer[id] = spot.layer;
  ent.hp[id] = state.map.turretHp[k];
  ent.ownerId[id] = -1;
  ent.mode[id] = TURRET_CAPTURABLE;
  // Per-spot original parameters (rules.md §9; the defaults where the arena
  // imports none).
  ent.weaponProfile[id] = state.map.turretParams[k];
  // The rest yaw. A turret's aimX/aimY are its shooter state (systemTargeting),
  // so they start at zero.
  if (state.map.turretYaw.length > 0) ent.yaw[id] = state.map.turretYaw[k];
  state.neutralTurretEntity[k] = id;
  return id;
}

/**
 * Spawns outpost plate `j`'s team turret for the outpost's owner: the plate's
 * type-8 record of that team, a full team turret (TURRET_DEFENSE: it shoots, the
 * Sky Captain counts it), opened by the claim (fcop-re/outposts.md Q1).
 */
function spawnPlateTurret(state: SimState, j: number): number {
  const ent = state.ent;
  const plate = state.map.outpostPlates[j];
  const team = state.outpostOwner[plate.outpost];
  if (team !== 0 && team !== 1) return -1;
  const spot = plate.turrets[team];
  const id = spawn(ent, ARCHETYPE.TURRET, team);
  if (id < 0) return -1;
  ent.posX[id] = spot.x;
  ent.posY[id] = spot.y;
  ent.height[id] = resolveHeight(state.map, spot.x, spot.y, spot.layer);
  ent.entLayer[id] = spot.layer;
  ent.hp[id] = spot.hp;
  ent.ownerId[id] = team;
  ent.mode[id] = TURRET_DEFENSE;
  ent.weaponProfile[id] = spot.weapon;
  if (spot.yaw !== 0) ent.yaw[id] = spot.yaw;
  state.plateTurretEntity[j] = id;
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
  ent.height[id] = resolveHeight(state.map, spot.x, spot.y, spot.layer);
  ent.entLayer[id] = spot.layer;
  ent.hp[id] = ARCHETYPE_MAX_HP[ARCHETYPE.CONSOLE];
  ent.ownerId[id] = team;
  // Face the arena centre so the screen reads toward the midfield approach.
  const mid = worldExtent(state.map) * 0.5;
  ent.yaw[id] = atan2Poly(mid - spot.y, mid - spot.x);
  state.outpostConsole[k] = id;
  return id;
}

/**
 * Ticks a base ring turret of `team` stays down: the imported ring spawner's
 * period (MapBase.turretRespawnTicks, the original's 37.5 s), else
 * BASE_TURRET_RESPAWN_TICKS, the same 37.5 s (fcop-fidelity.md R16).
 */
export function ringRespawnTicks(map: MapData, team: number): number {
  const t = map.bases[team].turretRespawnTicks;
  return t > 0 ? t : BASE_TURRET_RESPAWN_TICKS;
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
 * (spawnNeutralTurret). It did not,
 * for one release, and the effect was not subtle: with weaponProfile at -1 the
 * ring fell through to the global TURRET_RANGE of 28 m against an imported
 * engage_range of (then) 6 m, so 32 turrets covered the whole midfield and shot every
 * produced unit dead from outside the units' own reach. Since SIM_VERSION 52 an
 * arena without records (district-01) loads its ring on the original team
 * turret's profile too (map.ts), so there are no globals left to fall to.
 */
function spawnBaseTurret(state: SimState, k: number): number {
  const ent = state.ent;
  const { team, spot } = baseTurretSpot(state.map, k);
  const id = spawn(ent, ARCHETYPE.TURRET, team);
  if (id < 0) return -1;
  ent.posX[id] = spot.x;
  ent.posY[id] = spot.y;
  ent.height[id] = resolveHeight(state.map, spot.x, spot.y, spot.layer);
  ent.entLayer[id] = spot.layer;
  ent.hp[id] = spot.hp;
  ent.ownerId[id] = team;
  ent.mode[id] = TURRET_DEFENSE;
  ent.weaponProfile[id] = spot.weapon;
  // Rest yaw only: aimX/aimY are the shooter's state (systemTargeting).
  if (spot.yaw !== 0) ent.yaw[id] = spot.yaw;
  state.baseTurretEntity[k] = id;
  return id;
}

/**
 * Spawns a combat unit for `team` at (x, y). Ground units pick their lane via
 * the per-player round-robin counter — or, when `forward` (outpost spawn),
 * join at the nearest waypoint of the nearest lane. Flyers are the original's
 * aircraft, and `mode` is an aircraft's anchor: UNIT_MODE_PATROL (0) the base,
 * UNIT_MODE_OUTPOST + k outpost k.
 */
export function spawnUnit(
  state: SimState,
  archetype: number,
  team: number,
  x: number,
  y: number,
  mode: number = UNIT_MODE_PATROL,
  forward = false,
  /** Surface the unit starts on (issue #33). Seeds height so resolveWalker stays. */
  layer = 0,
): number {
  const ent = state.ent;
  const id = spawn(ent, archetype as 1 | 2 | 3 | 4, team);
  if (id < 0) return -1;
  ent.posX[id] = x;
  ent.posY[id] = y;
  // Seed height/layer before snapUnitHeight: resolveWalker picks surfaces within
  // STEP_SNAP of the current height, so a unit born under a deck never climbs
  // onto it without this seed (issue #33).
  ent.height[id] = resolveHeight(state.map, x, y, layer);
  ent.entLayer[id] = layer;
  ent.hp[id] = ARCHETYPE_MAX_HP[archetype];
  ent.ownerId[id] = team;
  ent.mode[id] = mode;
  // The Juggernaut IS the original's Dreadnought and takes its HP and hull-gun
  // profile from the record (map.ts MapJuggernaut; the defaults where the arena
  // has none); the tank, jet and Flying Fortress their spawner records' health
  // and weapon (fcop-fidelity.md W3): 150 / 150 / 2000 HP, on every arena.
  const base = state.map.bases[team];
  if (archetype === ARCHETYPE.JUGGERNAUT) {
    ent.hp[id] = base.juggernaut.hp;
    ent.weaponProfile[id] = base.juggernaut.weapon;
  } else {
    const unit =
      archetype === ARCHETYPE.RUNNER
        ? base.runner
        : archetype === ARCHETYPE.GUARDIAN
          ? base.guardian
          : base.fortress;
    ent.hp[id] = unit.hp;
    ent.weaponProfile[id] = unit.weapon;
  }
  const gate = state.map.bases[team ^ 1].gate;
  ent.yaw[id] = atan2Poly(gate.y - y, gate.x - x);
  if (isGroundUnit(archetype)) {
    const graph = state.map.laneGraph;
    const lanes = state.map.lanes;
    if (graph !== undefined) {
      // Original road graph (rules.md §9): a route follower on its own side's
      // net (fcop-logic.md §8.1, each team drives its own Cnet). A base-built
      // unit starts at its team's entry node; a forward (outpost) spawn joins at
      // the nearest node of that net, scanned in index order so ties break
      // identically on every peer. (It used to take the nearest node of either
      // net, which on the enemy's directed net leads back to its own base.)
      let node = graph.entry[team];
      if (forward) {
        let best = Infinity;
        for (let k = 0; k < graph.nodes.length; k++) {
          if (graph.net[k] !== team) continue;
          const dx = graph.nodes[k].x - x;
          const dy = graph.nodes[k].y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < best) {
            best = d2;
            node = k;
          }
        }
      }
      startRoute(state, id, node);
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
    // The original's aircraft (units.ts moveAircraft): patrols its anchor, the
    // spawner it was built at (mode 0 base, 1 + k outpost k).
    startAircraft(state, id);
    snapUnitHeight(state, id, true);
  }
  return id;
}

export function createSim(map: MapData, seed: number, options?: SimOptions): SimState {
  const ringSlots = map.bases[0].turrets.length + map.bases[1].turrets.length;
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
  const loadouts = options?.loadouts;
  const state: SimState = {
    tick: 0,
    prng: seed | 0,
    winner: -1,
    outroTimer: 0,
    outroWinner: -1,
    map,
    ent: createEntityStore(),
    avatarId: new Int32Array(MAX_PLAYERS).fill(-1),
    respawnTimer: new Int32Array(MAX_PLAYERS),
    lastButtons: new Uint8Array(MAX_PLAYERS),
    moveCue: new Uint8Array(MAX_PLAYERS),
    points: new Uint32Array(MAX_PLAYERS).fill(STARTING_POINTS),
    heavyUnlocked: new Uint8Array(MAX_PLAYERS),
    laneCounter: new Uint8Array(MAX_PLAYERS),
    dummyEntity: new Int32Array(map.dummySpots.length).fill(-1),
    dummyRespawn: new Int32Array(map.dummySpots.length),
    baseTurretEntity: new Int32Array(ringSlots).fill(-1),
    baseTurretRespawn: new Int32Array(ringSlots),
    neutralTurretEntity: new Int32Array(map.turretSpots.length).fill(-1),
    neutralTurretRespawn: new Int32Array(map.turretSpots.length),
    plateTurretEntity: new Int32Array(map.outpostPlates.length).fill(-1),
    plateTurretRespawn: new Int32Array(map.outpostPlates.length),
    capturePress: new Uint8Array(MAX_PLAYERS),
    outpostOwner: new Int8Array(map.outpostSpots.length).fill(-1),
    outpostConsole: new Int32Array(map.outpostSpots.length).fill(-1),
    lockTarget: new Int32Array(MAX_PLAYERS).fill(-1),
    lockSteer: new Uint8Array(MAX_PLAYERS),
    gunAmmo: new Uint16Array(MAX_PLAYERS),
    burstLeft: new Uint8Array(MAX_PLAYERS * 3),
    loadoutGun: new Uint8Array(MAX_PLAYERS),
    loadoutHeavy: new Uint8Array(MAX_PLAYERS),
    loadoutSpecial: new Uint8Array(MAX_PLAYERS),
    wardenPlayer,
    wardenDifficulty,
    captain: createCaptainState(),
    pickupCooldown: new Int32Array(map.pickups.length),
    buffInvuln: new Int32Array(map.pickups.length > 0 ? MAX_PLAYERS : 0),
    buffInvis: new Int32Array(map.pickups.length > 0 ? MAX_PLAYERS : 0),
    powerAmmo: new Uint16Array(MAX_PLAYERS * 3),
    triggerArm: new Int32Array(map.triggerVolumes.length),
    turretAlert: new Int32Array(ringSlots > 0 ? MAX_PLAYERS : 0),
    avatarTurnRate: new Float32Array(MAX_PLAYERS),
    avatarIdle: new Int32Array(MAX_PLAYERS),
    avatarLunge: new Int32Array(MAX_PLAYERS),
    events: createEventBuffer(),
  };
  // Apply loadouts before avatars spawn so ammo capacities match the kit.
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const raw = loadouts?.[p] ?? (p === 0 ? loadouts?.[0] : undefined);
    const kit = normalizeLoadout(raw ?? DEFAULT_LOADOUT);
    state.loadoutGun[p] = kit.gun;
    state.loadoutHeavy[p] = kit.heavy;
    state.loadoutSpecial[p] = kit.special;
  }
  for (let p = 0; p < MAX_PLAYERS; p++) {
    spawnAvatar(state, p);
  }
  for (let k = 0; k < ringSlots; k++) {
    spawnBaseTurret(state, k);
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
  captainConstruct(state);
  return state;
}

const AXIS_SCALE = 1 / 127;
const GROUND_EPS = 0.001;
/** Height changes up to this snap to the terrain; larger drops become falls. */
export const STEP_SNAP = 0.35;

/**
 * The horizontal slope gate, shared by both axis moves: is the step from (x,y)
 * to (nx,ny) too steep for this form to take? Compares ride heights — ground to
 * ground, never `ent.height`, which carries the hover's clearance.
 *
 * Only one axis moves per call, so the run is `|dx| + |dy|` with one term zero.
 * A step clamped away at the map edge leaves both heights equal and falls out on
 * the rise test before anything divides by it.
 *
 * The forms differ in WHAT they measure the climb over, not just in how steep a
 * climb they accept:
 *
 * - **Walker**: the step itself, at `resolveWalker` heights (the deck it would
 *   stand on). A drop is not a rise; gravity handles it.
 * - **Hover**: the step AND the ground `HOVER_CUSHION_SPAN` further along it.
 *   Both have to be over the limit to block. A hover rides over a step its hull
 *   spans and is stopped by ground that keeps climbing, and per-tick sampling
 *   cannot tell those apart: 0.3 m into a 0.17 m kerb the reading is a
 *   0.58-gradient wall (issue #34). The span probe is the second reading. It
 *   uses `rideHeight`, so a dip below the water surface reads as the surface
 *   the hover floats on rather than as a hole it has to climb out of.
 */
function slopeBlocks(
  map: MapData,
  x: number,
  y: number,
  nx: number,
  ny: number,
  hover: boolean,
  height: number,
): boolean {
  const here = hover ? rideHeight(map, x, y, hover) : resolveWalker(map, x, y, height).height;
  const there = hover ? rideHeight(map, nx, ny, hover) : resolveWalker(map, nx, ny, height).height;
  const rise = there - here;
  if (rise <= GROUND_EPS) return false;
  const run = Math.abs(nx - x) + Math.abs(ny - y);
  const maxSlope = hover ? AVATAR_HOVER_MAX_SLOPE : AVATAR_WALKER_MAX_SLOPE;
  if (rise <= run * maxSlope) return false;
  if (!hover) return true;
  // Steep under the nose. Blocked only if it is still climbing a span on, in
  // the direction of the step. `(nx - x) / run` is ±1 on the moving axis and 0
  // on the other; the probe clamps to the arena like the move does, which can
  // only shorten the reach out on the apron.
  const extent = worldExtent(map);
  const px = Math.min(Math.max(x + ((nx - x) / run) * HOVER_CUSHION_SPAN, 0), extent);
  const py = Math.min(Math.max(y + ((ny - y) / run) * HOVER_CUSHION_SPAN, 0), extent);
  return rideHeight(map, px, py, hover) - here > HOVER_CUSHION_SPAN * maxSlope;
}

/** Scratch for `surfaceTilt` (the tick is synchronous and not re-entrant). */
const tilt = { gx: 0, gy: 0, t: 0, lift: 0 };
/** Half-width of the central difference `surfaceTilt` reads the surface with, m. */
const TILT_PROBE = 0.25;

/**
 * The surface under a mover as the original's surface normal: the height
 * gradient (gx, gy), the normal's horizontal length `t` (its "tilt") and its
 * vertical part `lift`. The hover reads its ride surface (water is flat), the
 * walker the deck it stands on.
 */
function surfaceTilt(map: MapData, x: number, y: number, hover: boolean, h: number): typeof tilt {
  const e = TILT_PROBE;
  const at = (px: number, py: number) =>
    hover ? rideHeight(map, px, py, true) : resolveWalker(map, px, py, h).height;
  const gx = (at(x + e, y) - at(x - e, y)) / (2 * e);
  const gy = (at(x, y + e) - at(x, y - e)) / (2 * e);
  const g2 = gx * gx + gy * gy;
  const lift = 1 / Math.sqrt(1 + g2);
  tilt.gx = gx;
  tilt.gy = gy;
  tilt.lift = lift;
  tilt.t = Math.sqrt(g2) * lift;
  return tilt;
}

/**
 * The original's downhill push on a tilted surface, as a per-step velocity
 * change (m/s) along the downhill direction: gain * (t - knee)³ * lift' * g_step,
 * with lift' the normal's vertical part raised by 0.15 and saturating at 1
 * (`player_velocity_delta` 0x00445150; the hover's twin at 0x00442947). Zero
 * below the knee: on gentle ground thrust and gravity cancel exactly.
 */
function slopePush(knee: number, gain: number): number {
  if (tilt.t < knee) return 0;
  const over = tilt.t - knee;
  const lift = tilt.lift > 0xd999 / 65536 ? 1 : tilt.lift + 0x2666 / 65536;
  return gain * over * over * over * lift * X1_GRAVITY_PER_STEP;
}

/** Gravity per movement step, m/s (0x9800 per step). */
const X1_GRAVITY_PER_STEP = X1_GRAVITY / (300 / 8);
/** A heading error this small (rad) is on heading: the yaw is stored as float32. */
const TURN_SETTLED = 1e-4;
/** Engine angle units (4096 a turn) to radians. */
const ANGLE_UNIT = (2 * Math.PI) / 4096;

/**
 * Landing damage (`player_impact_damage`, fcop-fidelity.md P4/P5): above a
 * 10.78 m/s landing, the original's absolute 1000 * f(x) HP against the 1250-HP
 * mech (P1). Credited to nobody, as the original credits the mech itself.
 */
function landingImpact(state: SimState, id: number, speed: number): void {
  if (speed <= X1_IMPACT_SPEED) return;
  const v = speed < X1_IMPACT_SPEED_MAX ? speed : X1_IMPACT_SPEED_MAX;
  const x = (v - X1_IMPACT_SPEED) * X1_IMPACT_SCALE;
  let f: number;
  if (x <= 0.5) f = x * (0x9cc4 / 65536);
  else if (x <= 0.75) f = x * Math.sqrt(x) * (0xddb3 / 65536);
  else f = x * x;
  applyDamage(state, id, X1_IMPACT_HP * f, -1);
}

/** The hover's ride height over its surface now: ramps through a change. */
function clearanceOf(ent: EntityStore, id: number): number {
  const left = ent.timerA[id] / TRANSFORM_LOCK_TICKS;
  const hover = ent.mode[id] === MODE_HOVER;
  if (ent.timerA[id] <= 0) return hover ? HOVER_CLEARANCE : 0;
  return HOVER_CLEARANCE * (hover ? 1 - left : left);
}

/** Starts a change of form (fcop-fidelity.md P3), published as EV_TRANSFORM. */
function startTransform(state: SimState, id: number, hover: boolean): void {
  state.ent.mode[id] = hover ? MODE_HOVER : MODE_WALKER;
  state.ent.timerA[id] = TRANSFORM_LOCK_TICKS;
  pushEvent(state.events, EV_TRANSFORM, id, hover ? 1 : 0, TRANSFORM_LOCK_TICKS);
}

/**
 * input + avatar movement: the original's two movement models (rules.md §2,
 * fcop-fidelity.md P3-P5; the per-tick conversion is described in balance.ts
 * "X1-Alpha movement"), transform, jumps, gravity and landings, then weapons and
 * buying. Walls, decks and the two slope gates are Metropolis' collision and
 * are unchanged.
 */
function systemAvatarMovement(state: SimState, inputs: TickInputs): void {
  const ent = state.ent;
  const map = state.map;
  const extent = worldExtent(map);
  for (let p = 0; p < MAX_PLAYERS; p++) {
    // The Warden's slot ignores TickInputs entirely: its superplane is moved
    // by systemWarden, deterministically on every peer.
    if (p === state.wardenPlayer) continue;
    const id = state.avatarId[p];
    state.moveCue[p] = 0;
    if (id < 0) {
      state.lastButtons[p] = inputs.players[p].buttons;
      continue;
    }
    const input = inputs.players[p];
    const yaw0 = ent.yaw[id];
    const pressed = input.buttons & ~state.lastButtons[p];
    state.lastButtons[p] = input.buttons;

    const locked = ent.timerA[id] > 0;
    if (locked) ent.timerA[id] -= 1;

    let x = ent.posX[id];
    let y = ent.posY[id];
    let hover = ent.mode[id] === MODE_HOVER;

    // Transform (edge-triggered; fcop-fidelity.md P3): refused while a change is
    // already running and on water in either form (the original's byte_146,
    // set by surface material 1). In the air too: the original does not ask.
    if ((pressed & BUTTON_TRANSFORM) !== 0) {
      if (!locked && !isWater(map, x, y)) {
        hover = !hover;
        startTransform(state, id, hover);
      } else {
        pushEvent(state.events, EV_TRANSFORM_REFUSED, id, p, 0);
      }
    }
    // While the change runs, the original cuts the movement tick's input to
    // nothing — no drive, no turn, no jump, no lock cycle — and runs the HOVER
    // tick for the whole ramp in both directions, so the hull coasts on hover
    // drag while its ride height ramps (fcop-re/player-and-weapons.md §2). The
    // weapons are NOT locked: all three fire buttons keep working.
    const nowLocked = ent.timerA[id] > 0;
    /** Hover physics this tick: the hover form, or any transformation ramp. */
    let hoverPhys = hover || nowLocked;

    // Where it stands. The walker resolves its deck (base or an upper layer
    // reachable within a step); the hover ignores layers and rides the base or
    // water surface at its clearance.
    let ride = hoverPhys
      ? rideHeight(map, x, y, true) + clearanceOf(ent, id)
      : resolveWalker(map, x, y, ent.height[id]).height;
    let vz = ent.timerB[id];
    const airborne = hoverPhys
      ? ent.height[id] > ride + HOVER_HOLD_DOWN || vz > 0
      : ent.height[id] > ride + GROUND_EPS || vz > 0;

    // The lock (fcop-fidelity.md W2): hold, cycle, auto-acquire, against the
    // facing the hull had coming into this tick. Resolved before facing/drive so
    // a steering lock turns the hull this tick. The cycle press is dropped while
    // transforming, as the original drops the lock-cycle bit.
    updateLock(state, p, id, !nowLocked && (pressed & BUTTON_TARGET_CYCLE) !== 0);
    // The capture press is an edge, like the original's button latch
    // (fcop-re/ranges-turrets-capture.md Q2); systemCapture consumes it.
    if ((pressed & BUTTON_INTERACT) !== 0) state.capturePress[p] = 1;
    const lockId = state.lockSteer[p] === 1 ? state.lockTarget[p] : -1;

    // The stick, unit-clamped; nothing while transforming.
    let mx = nowLocked ? 0 : input.moveX * AXIS_SCALE;
    let my = nowLocked ? 0 : input.moveY * AXIS_SCALE;
    const l2 = mx * mx + my * my;
    if (l2 > 1) {
      const inv = 1 / Math.sqrt(l2);
      mx *= inv;
      my *= inv;
    }

    // The heading it wants: lock > aim > stick > none. Metropolis steers by an
    // absolute heading (input.spec §4.1) where the original has turn buttons, so
    // the hull TURNS toward it at the original's rate rather than snapping.
    let wantX = 0;
    let wantY = 0;
    if (!nowLocked) {
      if (lockId >= 0) {
        wantX = ent.posX[lockId] - x;
        wantY = ent.posY[lockId] - y;
      } else {
        const ax = input.aimX * AXIS_SCALE;
        const ay = input.aimY * AXIS_SCALE;
        if (ax * ax + ay * ay > 0.04) {
          wantX = ax;
          wantY = ay;
        } else if (l2 > 0) {
          wantX = mx;
          wantY = my;
        }
      }
    }
    const want2 = wantX * wantX + wantY * wantY;
    if (want2 > 1e-6) {
      const goal = atan2Poly(wantY, wantX);
      const err = angleDelta(ent.yaw[id], goal);
      let reach: number;
      if (hoverPhys) {
        // Hover: the rate word ramps by the frame delta a step toward the side
        // turned to, from zero on a reversal or a release, clamped at 0x60; the
        // facing turns by half of it a step (158°/s at most).
        // An error within TURN_SETTLED is "on heading": the turn is released and
        // the next turn ramps from zero again, as a released button does.
        const turning = Math.abs(err) > TURN_SETTLED;
        let rate = state.avatarTurnRate[p];
        if (!turning || (rate !== 0 && rate > 0 !== err > 0)) rate = 0;
        if (turning) {
          rate += (err > 0 ? 1 : -1) * X1_UNITS_PER_TICK * X1_STEPS_PER_TICK;
          if (rate > HOVER_TURN_LIMIT) rate = HOVER_TURN_LIMIT;
          else if (rate < -HOVER_TURN_LIMIT) rate = -HOVER_TURN_LIMIT;
        }
        state.avatarTurnRate[p] = rate;
        reach = Math.abs(rate) * 0.5 * X1_STEPS_PER_TICK * ANGLE_UNIT;
      } else if (airborne) {
        reach = 0; // the walker does not turn in the air
      } else {
        // Walker: 0x20 a step, less in proportion to speed (105°/s at rest,
        // nothing at 18.75 m/s). No ramp.
        const v = Math.sqrt(ent.velX[id] * ent.velX[id] + ent.velY[id] * ent.velY[id]);
        const k = 1 - v / WALKER_TURN_ZERO_SPEED;
        reach = k > 0 ? WALKER_TURN_STEP * X1_STEPS_PER_TICK * ANGLE_UNIT * k : 0;
      }
      if (Math.abs(err) <= reach) {
        // On the heading: take the wanted direction exactly, not its table
        // approximation, so a held aim is as precise as the stick that sent it.
        const inv = 1 / Math.sqrt(want2);
        ent.yaw[id] = goal;
        ent.aimX[id] = wantX * inv;
        ent.aimY[id] = wantY * inv;
      } else {
        let yaw = ent.yaw[id] + (err > 0 ? reach : -reach);
        if (yaw > Math.PI) yaw -= 2 * Math.PI;
        else if (yaw <= -Math.PI) yaw += 2 * Math.PI;
        ent.yaw[id] = yaw;
        ent.aimX[id] = cosLUT(yaw);
        ent.aimY[id] = sinLUT(yaw);
      }
    } else {
      state.avatarTurnRate[p] = 0;
    }
    const fx = ent.aimX[id];
    const fy = ent.aimY[id];

    // The stick read as the original's input bits, in the hull's frame: fore/aft
    // along the facing, sideways across it (screen right is (-fy, fx)), each
    // set beyond sin 22.5° of the stick's length — eight d-pad sectors. Its
    // length scales the push, as the original's stick path does.
    const brake = hover && !nowLocked && (input.buttons & BUTTON_JUMP) !== 0;
    let pushX = 0;
    let pushY = 0;
    let fore = 0;
    let side = 0;
    if (l2 > 0 && !brake) {
      const mag = Math.sqrt(l2 < 1 ? l2 : 1);
      const f = mx * fx + my * fy;
      const sd = -mx * fy + my * fx;
      if (Math.abs(f) > X1_STICK_SECTOR * mag) fore = f > 0 ? 1 : -1;
      if (Math.abs(sd) > X1_STICK_SECTOR * mag) side = sd > 0 ? 1 : -1;
      const pf = (hoverPhys ? HOVER_PUSH_FORE : WALKER_PUSH_FORE) * mag;
      if (fore !== 0 && side !== 0) {
        // The diagonal: 181/256 of the fore push along (F ± R), length √2.
        const k = pf * X1_DIAGONAL_SCALE;
        pushX = k * (fore * fx - side * fy);
        pushY = k * (fore * fy + side * fx);
      } else if (fore !== 0) {
        pushX = pf * fore * fx;
        pushY = pf * fore * fy;
      } else if (side !== 0) {
        const ps = (hoverPhys ? HOVER_PUSH_STRAFE : WALKER_PUSH_STRAFE) * mag;
        pushX = -ps * side * fy;
        pushY = ps * side * fx;
      }
    }
    const commanded = fore !== 0 || side !== 0;
    state.moveCue[p] =
      (commanded ? MOVE_CUE_DRIVE : 0) |
      (brake ? MOVE_CUE_BRAKE : 0) |
      (ent.yaw[id] !== yaw0 ? MOVE_CUE_TURN : 0);

    // The walker's jump (edge-triggered; balance.ts WALKER_* jumps): on the
    // ground, not steep, not mid-change. It leaves the ground this tick, so the
    // velocity below takes the airborne path, as the original's launch states do.
    let jumpLift = 0;
    let jumpPush = 0;
    let lunge = state.avatarLunge[p];
    if (!hoverPhys && !airborne && (pressed & BUTTON_JUMP) !== 0) {
      const h = ent.height[id];
      if (surfaceTilt(map, x, y, false, h).t <= WALKER_STEEP_TILT) {
        if (fore > 0) {
          jumpLift = WALKER_LEAP_LIFT; // running forward: the leap
          jumpPush = WALKER_LEAP_PUSH;
          lunge = 0;
        } else {
          const ax = Math.min(Math.max(x + fx * WALKER_PROBE_AHEAD, 0), extent);
          const ay = Math.min(Math.max(y + fy * WALKER_PROBE_AHEAD, 0), extent);
          const rise = resolveWalker(map, ax, ay, h + WALKER_PROBE_LIFT).height - h;
          if (rise > WALKER_HIGH_RISE) {
            jumpLift = WALKER_HIGH_LIFT; // a step ahead: the high jump
            lunge = rise > WALKER_LUNGE_MAX_RISE ? 0 : WALKER_LUNGE_TICKS;
          } else {
            jumpLift = WALKER_HOP_LIFT; // open ground: the hop
            jumpPush = WALKER_HOP_PUSH;
            lunge = 0;
          }
        }
      }
    }
    const inAir = airborne || jumpLift > 0;

    // Velocity: n = 1.25 steps of v += P - d v in closed form (balance.ts).
    let vx = ent.velX[id];
    let vy = ent.velY[id];
    if (hoverPhys) {
      // The idle timer counts the frame delta while nothing drives the hover,
      // and past 0x700 units ramps the drag toward 0.375.
      let idle = state.avatarIdle[p];
      idle = commanded || brake ? 0 : Math.min(idle + X1_UNITS_PER_TICK, HOVER_IDLE_CEILING);
      state.avatarIdle[p] = idle;
      let d = HOVER_DRAG;
      if (idle > HOVER_IDLE_KNEE) d += ((idle - HOVER_IDLE_KNEE) * HOVER_IDLE_SLOPE) / 65536;
      if (brake && !inAir) d = HOVER_BRAKE_DRAG;
      if (!inAir) {
        // With control, the tilted ground pushes it downhill.
        const t = surfaceTilt(map, x, y, true, ent.height[id]);
        const sp = slopePush(HOVER_SLOPE_KNEE, HOVER_SLOPE_GAIN);
        if (sp > 0) {
          const g = Math.sqrt(t.gx * t.gx + t.gy * t.gy);
          pushX -= (sp * t.gx) / g;
          pushY -= (sp * t.gy) / g;
        }
      }
      // Undriven on the ground, a near-standstill stops dead. The original tests
      // after every step, so the test here is the tick's FIRST step: one that
      // ends under the threshold stops it, as it would have in the original.
      const settle =
        !commanded &&
        !brake &&
        !inAir &&
        Math.abs(vx * (1 - d) + pushX) < HOVER_STOP_SPEED &&
        Math.abs(vy * (1 - d) + pushY) < HOVER_STOP_SPEED &&
        Math.abs(vz) < HOVER_STOP_SPEED;
      const r = retentionPerTick(d);
      vx = settle ? 0 : (pushX / d) * (1 - r) + vx * r;
      vy = settle ? 0 : (pushY / d) * (1 - r) + vy * r;
      const v2 = vx * vx + vy * vy;
      if (v2 > HOVER_SPEED_CAP * HOVER_SPEED_CAP) {
        const k = HOVER_SPEED_CAP / Math.sqrt(v2);
        vx *= k;
        vy *= k;
      }
    } else if (inAir) {
      // Airborne walker: no push, no steering, a light horizontal drag.
      const r = retentionPerTick(WALKER_AIR_DRAG);
      vx *= r;
      vy *= r;
    } else {
      const t = surfaceTilt(map, x, y, false, ent.height[id]);
      const sp = slopePush(WALKER_SLOPE_KNEE, WALKER_SLOPE_GAIN);
      if (sp > 0) {
        const g = Math.sqrt(t.gx * t.gx + t.gy * t.gy);
        pushX -= (sp * t.gx) / g;
        pushY -= (sp * t.gy) / g;
      }
      // The stop test of the tick's first step, as for the hover.
      const k = 1 - WALKER_DRAG;
      const settle =
        !commanded &&
        Math.abs(vx * k + pushX) < WALKER_STOP_SPEED &&
        Math.abs(vy * k + pushY) < WALKER_STOP_SPEED;
      const r = retentionPerTick(WALKER_DRAG);
      vx = settle ? 0 : (pushX / WALKER_DRAG) * (1 - r) + vx * r;
      vy = settle ? 0 : (pushY / WALKER_DRAG) * (1 - r) + vy * r;
    }
    if (jumpLift > 0) {
      vz = jumpLift;
      vx += jumpPush * fx;
      vy += jumpPush * fy;
    } else if (!hoverPhys && airborne && lunge > 0) {
      // The high jump's lunge, 9 steps after take-off.
      lunge -= 1;
      if (lunge === 0) {
        vx += WALKER_LUNGE_PUSH * fx;
        vy += WALKER_LUNGE_PUSH * fy;
      }
    }
    ent.velX[id] = vx;
    ent.velY[id] = vy;

    // Horizontal movement, axis-separated for wall sliding. Uphill steps
    // beyond the slope limit are blocked (slopeBlocks). Airborne walkers skip
    // the slope check so a jump can carry them onto a ledge.
    // Walls come from the deck the avatar is standing on (entLayer, set by the
    // resolveWalker snap below on the previous tick). A hovering avatar is not on
    // a deck, so it keeps reading layer 0's lattice.
    const wallLayer = hoverPhys ? 0 : ent.entLayer[id];
    const skipSlope = !hoverPhys && inAir;
    const stepX = vx * TICK_DT;
    if (stepX !== 0) {
      const nx = Math.min(Math.max(x + stepX, 0), extent);
      let ok = !crossesWallX(map, x, nx, y, wallLayer);
      if (ok && !skipSlope && slopeBlocks(map, x, y, nx, y, hoverPhys, ent.height[id])) ok = false;
      if (ok) x = nx;
      else ent.velX[id] = 0;
    }
    const stepY = vy * TICK_DT;
    if (stepY !== 0) {
      const ny = Math.min(Math.max(y + stepY, 0), extent);
      let ok = !crossesWallY(map, x, y, ny, wallLayer);
      if (ok && !skipSlope && slopeBlocks(map, x, y, x, ny, hoverPhys, ent.height[id])) ok = false;
      if (ok) y = ny;
      else ent.velY[id] = 0;
    }
    ent.posX[id] = x;
    ent.posY[id] = y;

    // A walker in water transforms to hover on its own: the NORMAL/EASY rule
    // (`player_order` code 1). HARD's sinking and drowning are not modelled —
    // Metropolis has no difficulty for the player and models NORMAL.
    if (!hoverPhys && isWater(map, x, y)) {
      hover = true;
      hoverPhys = true;
      startTransform(state, id, true);
    }

    // Vertical: gravity 26.1 m/s² to a 14.06 m/s terminal fall in both forms,
    // and a landing over 10.78 m/s hurts.
    let h = ent.height[id];
    if (hoverPhys) {
      // Snapped up to its ride height, held down within HOVER_HOLD_DOWN of it,
      // and airborne above that — off a ledge it falls.
      ride = rideHeight(map, x, y, true) + clearanceOf(ent, id);
      const air = h > ride + HOVER_HOLD_DOWN || vz > 0;
      if (air) {
        vz -= X1_GRAVITY * TICK_DT;
        if (vz < -X1_TERMINAL_FALL) vz = -X1_TERMINAL_FALL;
        h += vz * TICK_DT;
      }
      if (!air || h <= ride) {
        if (air && vz < 0) landingImpact(state, id, -vz);
        h = ride;
        vz = 0;
      }
      lunge = 0;
    } else {
      // The walker snaps to step-sized height changes (STEP_SNAP, Metropolis'
      // deck rule) and falls past them.
      const wr = resolveWalker(map, x, y, h);
      ent.entLayer[id] = wr.layer;
      ride = wr.height;
      if (vz !== 0 || h > ride + STEP_SNAP) {
        vz -= X1_GRAVITY * TICK_DT;
        if (vz < -X1_TERMINAL_FALL) vz = -X1_TERMINAL_FALL;
        h += vz * TICK_DT;
        if (h <= ride) {
          if (vz < 0) landingImpact(state, id, -vz);
          h = ride;
          vz = 0;
          lunge = 0;
        }
      } else {
        h = ride;
        vz = 0;
        lunge = 0;
      }
    }
    ent.height[id] = h;
    ent.timerB[id] = vz;
    state.avatarLunge[p] = lunge;

    ent.animState[id] =
      (commanded || ent.velX[id] * ent.velX[id] + ent.velY[id] * ent.velY[id] > 1e-6
        ? ANIM_MOVING
        : 0) |
      (hover ? ANIM_HOVER : 0) |
      (h > ride + GROUND_EPS ? ANIM_AIRBORNE : 0) |
      (ent.timerA[id] > 0 ? ANIM_TRANSFORMING : 0);

    // Weapons (sub-step of the avatar system): cooldowns, fire, ammo stub. They
    // fire through a transformation (fcop-fidelity.md P3).
    avatarWeapons(state, p, id, input.buttons, pressed);
    // Purchases (rules.md §3): one unit per press of the action key on a spot.
    systemBuy(state, p, id, input.buttons);
  }
}

/**
 * What the X1-Alpha's lock may take (fcop-fidelity.md W2). The original's search
 * (`cact_find_target_near`) takes any live actor whose team byte differs from the
 * mech's, so enemy turrets are locked like units: they have to be, because a
 * hitscan gun damages nothing but its lock. Not lockable:
 * - projectiles;
 * - a neutral turret before it is captured — the original's capture clears that
 *   turret's flag bit 0, the search's skip bit, so an uncaptured one is skipped
 *   (ranges-turrets-capture.md Q2; the reading is the flag's, M). The sandbox's
 *   neutral target dummies are Metropolis' own and stay lockable;
 * - an outpost console: it takes no damage on any arena (R14; district-01's too
 *   since SIM_VERSION 52).
 */
function isLockable(state: SimState, player: number, selfId: number, t: number): boolean {
  const ent = state.ent;
  if (t === selfId || !ent.alive[t] || ent.hp[t] <= 0) return false;
  const team = ent.team[t];
  if (team === player) return false;
  const arch = ent.archetype[t];
  if (arch === ARCHETYPE.PROJECTILE) return false;
  if (team === TEAM_NEUTRAL) return arch === ARCHETYPE.TURRET && ent.mode[t] === TURRET_DUMMY;
  if (arch === ARCHETYPE.CONSOLE) return false;
  return true;
}

/**
 * `cact_target_score` for the lock: the horizontal distance to `t` if it is
 * inside AVATAR_LOCK_RANGE and inside the cone `cos` about the hull's facing
 * (`fx`, `fy`), else -1. Like the original, a target closer than the cone's
 * minimum distance passes the cone.
 */
function lockScore(
  state: SimState,
  t: number,
  x: number,
  y: number,
  fx: number,
  fy: number,
  cos: number,
): number {
  const ent = state.ent;
  const dx = ent.posX[t] - x;
  const dy = ent.posY[t] - y;
  const d2 = dx * dx + dy * dy;
  if (d2 >= AVATAR_LOCK_RANGE * AVATAR_LOCK_RANGE) return -1;
  const d = Math.sqrt(d2);
  if (d > LOCK_CONE_MIN_DISTANCE && dx * fx + dy * fy < cos * d) return -1;
  return d;
}

/** The original's `CACT_TARGET_CONE_MIN_DISTANCE`, 8 wu: no cone test inside it. */
const LOCK_CONE_MIN_DISTANCE = 8 / 8192;

/**
 * `cact_find_target_near` for the lock: the nearest lockable target inside the
 * acquire cone, skipping `exclude`. Dense id order, strictly nearer wins, so a tie
 * keeps the lowest id on every peer. -1 when there is none.
 */
function findLockTarget(state: SimState, player: number, selfId: number, exclude: number): number {
  const ent = state.ent;
  const x = ent.posX[selfId];
  const y = ent.posY[selfId];
  const fx = ent.aimX[selfId];
  const fy = ent.aimY[selfId];
  let best = -1;
  let bestD = AVATAR_LOCK_RANGE;
  for (let t = 0; t < ent.high; t++) {
    if (t === exclude || !isLockable(state, player, selfId, t)) continue;
    const d = lockScore(state, t, x, y, fx, fy, AVATAR_LOCK_ACQUIRE_COS);
    if (d < 0 || d >= bestD) continue;
    best = t;
    bestD = d;
  }
  return best;
}

/**
 * The lock, once a tick, in the original's three steps (fcop-fidelity.md W2;
 * fcop-re/player-and-weapons.md §7):
 * 1. HOLD (`player_target_hold`): a lock drops when its target is gone, no longer
 *    lockable, past 12 m or outside the +-25° hold cone about the facing.
 * 2. CYCLE (`player_target_acquire(0)`, the lock-cycle press, not while
 *    transforming): the nearest OTHER target in the +-12.5° acquire cone replaces
 *    the lock; with none, the lock stays. With two targets in the cone the press
 *    alternates between them, as the original's exclude-the-current search does.
 * 3. AUTO-ACQUIRE (`player_target_acquire(1)`, every tick while there is no lock):
 *    the nearest target in the acquire cone.
 *
 * No line of sight: the original's lock does not test terrain (a wall stops the
 * shot instead, `player_fire_direct`'s trace).
 *
 * Metropolis steers by an absolute heading (input.spec §4.1), and its `lock` aim
 * mode makes the lock the heading the hull turns to. Only a lock the PLAYER took
 * with the cycle press does that (`lockSteer`); an auto-acquired one aims the
 * weapons and leaves the hull to the aim, so turning away 25° drops it, as in the
 * original, where the lock never turns the mech.
 */
function updateLock(state: SimState, player: number, selfId: number, cycle: boolean): void {
  const ent = state.ent;
  let lock = state.lockTarget[player];
  if (lock >= 0) {
    const ok =
      isLockable(state, player, selfId, lock) &&
      lockScore(
        state,
        lock,
        ent.posX[selfId],
        ent.posY[selfId],
        ent.aimX[selfId],
        ent.aimY[selfId],
        AVATAR_LOCK_HOLD_COS,
      ) >= 0;
    if (!ok) lock = -1;
  }
  if (lock < 0) state.lockSteer[player] = 0;
  if (cycle) {
    const next = findLockTarget(state, player, selfId, lock);
    if (next >= 0) lock = next;
    if (lock >= 0) state.lockSteer[player] = 1;
  }
  if (lock < 0) lock = findLockTarget(state, player, selfId, -1);
  state.lockTarget[player] = lock;
}

/**
 * Is avatar `id` touching an outpost zone at (x, y) on `layer`? A type-14 zone's
 * contact (fcop-re/outposts.md Q3): within the record's radius plus the avatar's
 * own, horizontally and vertically (a sphere, as the capture test is). On every
 * arena since SIM_VERSION 52 (district-01's zone was a flat 3 m).
 */
function touchesZone(
  state: SimState,
  id: number,
  x: number,
  y: number,
  layer: number,
  zone: number,
): boolean {
  const ent = state.ent;
  const dx = ent.posX[id] - x;
  const dy = ent.posY[id] - y;
  const dh = ent.height[id] - resolveHeight(state.map, x, y, layer);
  const reach = zone + ARCHETYPE_RADIUS[ARCHETYPE.AVATAR];
  return dx * dx + dy * dy + dh * dh < reach * reach;
}

/**
 * Outpost claim (rules.md §5, fcop-fidelity.md R14): an avatar touching an
 * unowned outpost's claim zone that presses the action key (capturePress, the
 * same rising edge as a capture) holding COST_OUTPOST_CLAIM points claims it on
 * the spot, no hold. The original's zone carries the op-10 gate bit 0x04, which
 * refuses a player whose button latch is not pressed this frame
 * (fcop-re/outposts.md Q3), so entering is not enough. -30, first come first
 * served. Returns true when the press was the zone's: claimed, or refused for want of
 * the points (EV_PURCHASE_REFUSED, the original's refuse sound).
 *
 * The zone watches a player's own avatar. The Warden never touches it: the
 * original's Sky Captain claims by a decision (its dispatch writes the outpost's
 * owner word, ai-and-rules.md §1.8), so warden.ts calls claimOutpostSlot.
 */
export function claimOutpost(state: SimState, player: number, id: number): boolean {
  if (state.capturePress[player] !== 1) return false;
  const map = state.map;
  const spots = map.outpostSpots;
  for (let k = 0; k < spots.length; k++) {
    if (state.outpostOwner[k] !== -1 || state.outpostConsole[k] < 0) continue;
    // The record's radius; the same 1.2 m where the arena has no records.
    const zone = map.outposts.length > 0 ? map.outposts[k].zone : OUTPOST_ZONE_RADIUS;
    if (!touchesZone(state, id, spots[k].x, spots[k].y, spots[k].layer, zone)) continue;
    if (state.points[player] < COST_OUTPOST_CLAIM) {
      // "With fewer, the press is refused" (fcop-re/outposts.md Q3): the refuse
      // sound, c = -1 for a claim.
      pushEvent(state.events, EV_PURCHASE_REFUSED, id, player, -1);
      return true;
    }
    return claimOutpostSlot(state, player, k);
  }
  return false;
}

/**
 * Claims outpost `k` for `player`: -30, the owner, the console's team. The
 * zone's claim (claimOutpost) and the Sky Captain's decision (warden.ts, which
 * writes the original's owner word from wherever it is) both end here. False
 * when it is taken, its console is down, or the points are short.
 *
 * On an outpost with turret plates it is also the original's claim script
 * (fcop-re/outposts.md Q1/Q3), on each of its plates:
 * - the plate's NeutralTurret dies (order 0x3d) and its spawner is shut for the
 *   rest of the match. It dies whoever holds it: a turret the other side had
 *   captured goes too, and its death pays nothing (the DIE order sets the death
 *   flag that `turret.c` checks before scoring), so it is made neutral first;
 * - the claimer's own type-8 spawner opens: its turret spawns at this tick's
 *   spawner pass (systemSpawning), so it stands from the next tick, and returns
 *   OUTPOST_TURRET_RESPAWN_TICKS after every death. The other side's record on
 *   the plate is never used.
 */
export function claimOutpostSlot(state: SimState, player: number, k: number): boolean {
  if (state.points[player] < COST_OUTPOST_CLAIM) return false;
  if (state.outpostOwner[k] !== -1 || state.outpostConsole[k] < 0) return false;
  const ent = state.ent;
  state.points[player] -= COST_OUTPOST_CLAIM;
  state.outpostOwner[k] = player;
  const cid = state.outpostConsole[k];
  ent.team[cid] = player;
  ent.ownerId[cid] = player;
  const plates = state.map.outpostPlates;
  for (let j = 0; j < plates.length; j++) {
    if (plates[j].outpost !== k) continue;
    const spot = plates[j].spot;
    const tid = state.neutralTurretEntity[spot];
    if (tid >= 0 && ent.alive[tid]) {
      // Dies in this tick's systemDamageDeath, neutral and unattributed: no
      // points, no engine credit, and the shut spawner below keeps it gone.
      ent.team[tid] = TEAM_NEUTRAL;
      ent.ownerId[tid] = -1;
      ent.aux[tid] = 0;
      ent.hp[tid] = 0;
    }
    state.neutralTurretRespawn[spot] = -1;
    state.plateTurretRespawn[j] = 1;
  }
  pushEvent(state.events, EV_CLAIM, cid, player, k);
  return true;
}

/**
 * Purchases, the original's way (fcop-fidelity.md R17; fcop-re/ai-and-rules.md
 * §2/§3): there is no menu and no hold — every purchase spot is a trigger that
 * answers the action key on the frame it goes down (capturePress, the same
 * rising edge as a capture or a claim), ONE unit per press. First the outpost
 * claim zones (claimOutpost); a press that claims buys nothing more. Then the
 * spot the avatar stands on: base consoles (FIRE2 held orders the heavy variant,
 * Metropolis' stand-in for the original's separate Dreadnought and Fortress
 * zones), an imported outpost's tank and jet pads, Metropolis' outpost consoles
 * (FIRE2 for the Guardian). A press the spot refuses — the points are short, or
 * the side already has 20 of that unit alive — answers with EV_PURCHASE_REFUSED,
 * the original's refuse sound; an accepted one with EV_PURCHASE. A heavy zone
 * that is still locked (R10) or whose unit is alive is closed, as the original's
 * is, and stays silent.
 */
export function systemBuy(state: SimState, player: number, id: number, buttons: number): void {
  const ent = state.ent;
  const map = state.map;
  if (state.capturePress[player] !== 1) return;
  if (claimOutpost(state, player, id)) return;
  const r2 = CONSOLE_RADIUS * CONSOLE_RADIUS;
  const heavy = (buttons & BUTTON_FIRE2) !== 0 ? 1 : 0;
  const x = ent.posX[id];
  const y = ent.posY[id];

  let cost = 0;
  let archetype = -1;
  let spawnX = 0;
  let spawnY = 0;
  let spawnLayer = 0;
  let mode = UNIT_MODE_PATROL;
  let forward = false;

  const base = map.bases[player];
  const gdx = x - base.groundConsole.x;
  const gdy = y - base.groundConsole.y;
  const adx = x - base.airConsole.x;
  const ady = y - base.airConsole.y;
  if (gdx * gdx + gdy * gdy <= r2) {
    archetype = heavy ? ARCHETYPE.JUGGERNAUT : ARCHETYPE.RUNNER;
    cost = heavy ? COST_JUGGERNAUT : COST_RUNNER;
    spawnX = base.groundConsole.x;
    spawnY = base.groundConsole.y;
    spawnLayer = base.groundConsole.layer;
    // The original's Dreadnought rolls out of its own spawner at node 0 of its
    // Cnet by the HQ, not at the purchase pad (fcop-re/ranges-turrets-capture.md
    // top). The console is where it is bought; this is where it appears.
    const dread = base.juggernaut;
    if (heavy && dread !== undefined) {
      spawnX = dread.x;
      spawnY = dread.y;
      spawnLayer = dread.layer;
    }
  } else if (adx * adx + ady * ady <= r2) {
    archetype = heavy ? ARCHETYPE.FORTRESS : ARCHETYPE.GUARDIAN;
    cost = heavy ? COST_FORTRESS : COST_GUARDIAN;
    spawnX = base.airConsole.x;
    spawnY = base.airConsole.y;
    spawnLayer = base.airConsole.layer;
  } else if (map.outposts.length > 0) {
    // The original's outpost pads (fcop-re/outposts.md Q3): a tank pad and a jet
    // pad per outpost, its owner's only, 2 points a unit. The unit leaves from
    // the pad; a jet patrols the outpost it was built at (mode 1 + k).
    for (let k = 0; k < map.outposts.length; k++) {
      if (state.outpostOwner[k] !== player) continue;
      const o = map.outposts[k];
      const jet = touchesZone(state, id, o.jetPad.x, o.jetPad.y, o.jetPad.layer, o.zone);
      if (!jet && !touchesZone(state, id, o.tankPad.x, o.tankPad.y, o.tankPad.layer, o.zone)) {
        continue;
      }
      const pad = jet ? o.jetPad : o.tankPad;
      archetype = jet ? ARCHETYPE.GUARDIAN : ARCHETYPE.RUNNER;
      cost = (jet ? COST_GUARDIAN : COST_RUNNER) * OUTPOST_COST_MULTIPLIER;
      spawnX = pad.x;
      spawnY = pad.y;
      spawnLayer = pad.layer;
      mode = jet ? UNIT_MODE_OUTPOST + k : UNIT_MODE_PATROL;
      forward = true;
      break;
    }
  } else {
    for (let k = 0; k < map.outpostSpots.length; k++) {
      const s = map.outpostSpots[k];
      const dx = x - s.x;
      const dy = y - s.y;
      if (dx * dx + dy * dy > r2) continue;
      const owner = state.outpostOwner[k];
      if (owner === player) {
        // Forward spawn at 2× cost (rules.md §3). A Guardian is the original's
        // jet and patrols the spawner it was built at: UNIT_MODE_OUTPOST + k
        // names outpost k (units.ts moveAircraft).
        archetype = heavy ? ARCHETYPE.GUARDIAN : ARCHETYPE.RUNNER;
        cost = (heavy ? COST_GUARDIAN : COST_RUNNER) * OUTPOST_COST_MULTIPLIER;
        spawnX = s.x;
        spawnY = s.y;
        spawnLayer = s.layer;
        mode = heavy ? UNIT_MODE_OUTPOST + k : UNIT_MODE_PATROL;
        forward = true;
      }
      break;
    }
  }

  if (archetype < 0) return; // not on a purchase spot: the press is not a purchase

  // The spot's own gates (fcop-fidelity.md R9, R10): a heavy zone opens the first
  // time the side holds 50 and closes while its unit lives (silent); the points
  // and the 20-alive cap of tanks and jets are refused out loud.
  const isHeavy = archetype === ARCHETYPE.JUGGERNAUT || archetype === ARCHETYPE.FORTRESS;
  const alive = countAliveOfArchetype(state, archetype, player);
  if (isHeavy && (state.heavyUnlocked[player] === 0 || alive >= aliveLimit(archetype))) return;
  if (state.points[player] < cost || alive >= aliveLimit(archetype)) {
    pushEvent(state.events, EV_PURCHASE_REFUSED, id, player, archetype);
    return;
  }

  state.points[player] -= cost;
  const uid = spawnUnit(state, archetype, player, spawnX, spawnY, mode, forward, spawnLayer);
  if (uid >= 0) {
    pushEvent(state.events, EV_PURCHASE, uid, player, archetype);
  } else {
    state.points[player] += cost; // entity cap hit: refund, nothing spawned
    pushEvent(state.events, EV_PURCHASE_REFUSED, id, player, archetype);
  }
}

/** Per-side alive cap of a purchasable unit archetype (fcop-fidelity.md R9). */
function aliveLimit(archetype: number): number {
  if (archetype === ARCHETYPE.RUNNER) return RUNNER_ALIVE_LIMIT;
  if (archetype === ARCHETYPE.GUARDIAN) return GUARDIAN_ALIVE_LIMIT;
  if (archetype === ARCHETYPE.JUGGERNAUT) return JUGGERNAUT_ALIVE_LIMIT;
  return FORTRESS_ALIVE_LIMIT;
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
 *
 * Exported for `units.ts`'s `worstHoverRise`, which mirrors the hover half of
 * `slopeBlocks` for map authoring and has to read the same surface.
 */
export function rideHeight(map: MapData, x: number, y: number, hover: boolean): number {
  const g = sampleHeight(map, x, y);
  if (hover && g < map.waterLevel) return map.waterLevel;
  return g;
}

/** The A-block magazine of `slot` (0 gun, 1 heavy, 2 special) for avatar `id`. */
function slotAmmo(state: SimState, player: number, id: number, slot: number): number {
  if (slot === 0) return state.gunAmmo[player];
  return slot === 1 ? state.ent.ammoA[id] : state.ent.ammoB[id];
}

function setSlotAmmo(state: SimState, player: number, id: number, slot: number, v: number): void {
  if (slot === 0) state.gunAmmo[player] = v;
  else if (slot === 1) state.ent.ammoA[id] = v;
  else state.ent.ammoB[id] = v;
}

/** Fill all three A magazines to their ceilings (`cact_type99_ammo_add(slot, -1)`). */
function refillAmmo(state: SimState, player: number, id: number): void {
  const kit = loadoutOf(state, player);
  state.gunAmmo[player] = kit.gun.a.ammoCap;
  state.ent.ammoA[id] = kit.heavy.a.ammoCap;
  state.ent.ammoB[id] = kit.special.a.ammoCap;
}

function loadoutOf(state: SimState, player: number) {
  return resolveLoadout({
    gun: state.loadoutGun[player],
    heavy: state.loadoutHeavy[player],
    special: state.loadoutSpecial[player],
  });
}

/** `player_target_hold`'s cooldown decay: 10 engine units a tick, floored at zero. */
function decayCooldown(cd: Float32Array, id: number): void {
  if (cd[id] > 0) {
    const v = cd[id] - WEAPON_UNITS_PER_TICK;
    cd[id] = v > 0 ? v : 0;
  }
}

function avatarWeapons(
  state: SimState,
  player: number,
  id: number,
  buttons: number,
  pressed: number,
): void {
  const ent = state.ent;
  decayCooldown(ent.cooldownA, id);
  decayCooldown(ent.cooldownB, id);
  decayCooldown(ent.cooldownC, id);

  // Ammo/repair pad (rules.md §5): ammo refills instantly, hp regenerates.
  const pad = state.map.bases[player].pad;
  const pdx = ent.posX[id] - pad.x;
  const pdy = ent.posY[id] - pad.y;
  if (pdx * pdx + pdy * pdy <= pad.radius * pad.radius) {
    refillAmmo(state, player, id);
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
      refillAmmo(state, player, id);
    }
  }

  // `player_fire_buttons`: Gun and Heavy fire on every tick they are held,
  // paced by their cooldowns. Special is held-fire too, unless a slot's block A
  // keeps its round (flag 4: the Plasma Flare and the Grenade, neither in the
  // catalogue), which makes it press-to-fire.
  const kit = loadoutOf(state, player);
  if ((buttons & BUTTON_FIRE1) !== 0) fireSlot(state, player, id, 0, kit.gun);
  if ((buttons & BUTTON_FIRE2) !== 0) fireSlot(state, player, id, 1, kit.heavy);
  const keeps =
    ((kit.gun.a.flags | kit.heavy.a.flags | kit.special.a.flags) & WEAPON_FLAG_KEEP) !== 0;
  if (((keeps ? pressed : buttons) & BUTTON_FIRE3) !== 0) {
    fireSlot(state, player, id, 2, kit.special);
  }
}

/** Block A flag 4: the round is kept, and Special becomes press-to-fire. */
const WEAPON_FLAG_KEEP = 4;

/**
 * One slot's trigger, `player_fire_slot` (retail 0x00458ed0): refused while its
 * cooldown is above zero or its magazine is empty; otherwise the shot goes out,
 * one round is spent, and the burst counter picks the gap the cooldown GAINS —
 * the round gap inside a burst, the burst gap after its last round.
 */
function fireSlot(state: SimState, player: number, id: number, slot: number, w: WeaponDef): void {
  const ent = state.ent;
  const cd = slot === 0 ? ent.cooldownA : slot === 1 ? ent.cooldownB : ent.cooldownC;
  if (cd[id] > 0) return;
  const k = player * 3 + slot;
  // Block B while its magazine lasts (fcop-fidelity.md P8), then block A again.
  const powered = state.powerAmmo[k] > 0;
  const blk = powered ? w.b : w.a;
  const allowance = powered ? state.powerAmmo[k] : slotAmmo(state, player, id, slot);
  if (allowance <= 0) {
    pushEvent(state.events, EV_DRY_FIRE, id, player, slot);
    return;
  }
  // Both sounds are the original's, from the same function and in this order:
  // empty answers script 13 and nothing fires; five left answers script 14 and
  // the round still goes out.
  if (allowance === LOW_AMMO_WARNING) pushEvent(state.events, EV_LOW_AMMO, id, player, slot);
  if (!deliver(state, id, player, w, blk, slot, powered)) return;
  if (powered) state.powerAmmo[k] = allowance - 1;
  else setSlotAmmo(state, player, id, slot, allowance - 1);
  let left = state.burstLeft[k] - 1;
  let gap: number;
  if (left <= 0) {
    left = blk.rounds;
    gap = blk.burstGap;
  } else {
    gap = blk.roundGap;
  }
  state.burstLeft[k] = left;
  // The Flamethrower's time profile is Metropolis' (balance.ts FLAME_PULSE_TICKS).
  if (w.delivery === "flame") gap = FLAME_PULSE_TICKS * WEAPON_UNITS_PER_TICK;
  cd[id] += gap;
  // The last powered round: back to block A, its burst counter from A.
  if (powered && allowance - 1 <= 0) state.burstLeft[k] = w.a.rounds;
}

/**
 * A slot's power-up (`cact_pickup_grant` bits 0x10/0x20/0x40; fcop-re/player-and-
 * weapons.md §6): block B's magazine to its NORMAL ceiling. A slot that was not
 * powered also takes its burst counter from block B.
 */
function powerUp(state: SimState, player: number, slot: number): void {
  const k = player * 3 + slot;
  const w = weaponInSlot(
    slot as 0 | 1 | 2,
    slot === 0
      ? state.loadoutGun[player]
      : slot === 1
        ? state.loadoutHeavy[player]
        : state.loadoutSpecial[player],
  );
  if (state.powerAmmo[k] === 0) state.burstLeft[k] = w.b.rounds;
  state.powerAmmo[k] = w.b.ammoCap;
}

/**
 * Delivers one round of `blk` and emits its EV_SHOT. Returns false only when no
 * round could be spawned (the entity store is full), which spends nothing.
 */
function deliver(
  state: SimState,
  shooter: number,
  player: number,
  w: WeaponDef,
  blk: WeaponBlock,
  slot: number,
  powered: boolean,
): boolean {
  const ent = state.ent;
  const lock = state.lockTarget[player];
  const fx = ent.aimX[shooter];
  const fy = ent.aimY[shooter];
  switch (w.delivery) {
    case "hitscan":
    case "flame":
      directShot(state, shooter, player, w, blk, slot, lock, powered);
      return true;
    case "beam":
      beamShot(state, shooter, player, w, blk, slot, lock, powered);
      return true;
    case "shockwave": {
      pushEvent(state.events, EV_SHOT, shooter, slot, weaponShotPayload(w.id, 0, powered));
      // Self-centred pulse at the shooter's feet — ignores aim and lock.
      blastAt(
        state,
        ent.posX[shooter],
        ent.posY[shooter],
        ent.team[shooter],
        player,
        blk.damage,
        blk.blast,
        w.projKind,
        BLAST_FLAT,
      );
      return true;
    }
    case "mine": {
      if (!spawnMine(state, shooter, player, w.projKind, blk)) return false;
      pushEvent(state.events, EV_SHOT, shooter, slot, weaponShotPayload(w.id, 0, powered));
      return true;
    }
    case "arced": {
      const x = ent.posX[shooter] + fx * MUZZLE_OFFSET;
      const y = ent.posY[shooter] + fy * MUZZLE_OFFSET;
      const h = ent.height[shooter] + MUZZLE_HEIGHT;
      let tx: number;
      let ty: number;
      let th: number;
      if (lock >= 0) {
        tx = ent.posX[lock];
        ty = ent.posY[lock];
        th = ent.height[lock];
      } else {
        tx = x + fx * ARC_FREE_AIM_DISTANCE;
        ty = y + fy * ARC_FREE_AIM_DISTANCE;
        th = h;
      }
      const flags = blk.kind === KIND_ARCED_CLUSTER ? ROUND_ARC | ROUND_CLUSTER : ROUND_ARC;
      const id = spawnArced(state, x, y, h, tx, ty, th, blk.launchSpeed, blk.gravity);
      if (id < 0) return false;
      armRound(state, id, shooter, player, w.projKind, blk, flags, -1);
      pushEvent(state.events, EV_SHOT, shooter, slot, weaponShotPayload(w.id, 0, powered));
      return true;
    }
    default: {
      // "missile": kinds 3 and 0x12 home on the lock; kind 2 is lead-aimed at it
      // (`cact_discharge_lead`) and flies straight, as kind 1 does without one.
      const homing = blk.kind !== KIND_MISSILE_LEAD && lock >= 0;
      let dx = fx;
      let dy = fy;
      if (blk.kind === KIND_MISSILE_LEAD && lock >= 0) {
        if (leadAim(state, shooter, lock, blk.speed)) {
          dx = leadScratch.x;
          dy = leadScratch.y;
        }
      }
      // Block B of the Hell Fire (kind 0x12) splits into three: Metropolis
      // launches the three at once, fanned (balance.ts HELLFIRE_SPLIT_FAN).
      const count = blk.kind === KIND_MISSILE_SPLIT ? 3 : 1;
      let any = false;
      for (let i = 0; i < count; i++) {
        let ux = dx;
        let uy = dy;
        if (count > 1 && i > 0) {
          const a = i === 1 ? HELLFIRE_SPLIT_FAN : -HELLFIRE_SPLIT_FAN;
          const c = cosLUT(a);
          const s = sinLUT(a);
          ux = dx * c - dy * s;
          uy = dx * s + dy * c;
        }
        const id = spawnStraight(state, shooter, ux, uy, homing ? lock : -1, lock);
        if (id < 0) break;
        armRound(state, id, shooter, player, w.projKind, blk, homing ? ROUND_HOMING : 0, lock);
        any = true;
      }
      if (!any) return false;
      pushEvent(state.events, EV_SHOT, shooter, slot, weaponShotPayload(w.id, 0, powered));
      return true;
    }
  }
}

const KIND_MISSILE_LEAD = 2;
const KIND_MISSILE_SPLIT = 0x12;
const KIND_ARCED_CLUSTER = 0x14;

/**
 * The direct path, `player_fire_direct` (retail 0x004595e0; fcop-fidelity.md
 * W2): a line from the muzzle to the LOCK, or `range` ahead along the facing with
 * none. A wall on the line stops it (the original's terrain trace). It damages
 * only the lock: with no lock the line does nothing — except a powered block with
 * a blast, which area-damages where the line ends (at the lock when there is one).
 */
function directShot(
  state: SimState,
  shooter: number,
  player: number,
  w: WeaponDef,
  blk: WeaponBlock,
  slot: number,
  lock: number,
  powered: boolean,
): void {
  const ent = state.ent;
  const ox = ent.posX[shooter];
  const oy = ent.posY[shooter];
  let ex: number;
  let ey: number;
  if (lock >= 0) {
    ex = ent.posX[lock];
    ey = ent.posY[lock];
  } else {
    ex = ox + ent.aimX[shooter] * blk.range;
    ey = oy + ent.aimY[shooter] * blk.range;
  }
  const dx = ex - ox;
  const dy = ey - oy;
  const len = Math.sqrt(dx * dx + dy * dy);
  let reach = len;
  let blocked = false;
  const wallT = segmentBlockT(state.map, ox, oy, ex, ey);
  if (wallT >= 0) {
    blocked = true;
    reach = wallT * len;
  }
  pushEvent(state.events, EV_SHOT, shooter, slot, weaponShotPayload(w.id, reach, powered));
  if (blocked) return;
  if (powered && blk.blast > 0 && w.delivery === "hitscan") {
    blastAt(state, ex, ey, ent.team[shooter], player, blk.damage, blk.blast, PROJ_SPLASH, 0);
  } else if (lock >= 0) {
    applyDamage(state, lock, blk.damage, player);
  }
}

/**
 * The Concussion Beam (kind 0x11, `sustain_aimed_fire_block`): an aimed beam to
 * the lock — or its range ahead, or as far toward the lock as its range goes —
 * that bursts with the record's blast and linear falloff at its end. How the
 * original spreads the beam's damage over time was not established; this is
 * Metropolis' instant beam carrying the original's per-hit damage, radius and
 * reach (fcop-re/player-and-weapons.md §9.1).
 */
function beamShot(
  state: SimState,
  shooter: number,
  player: number,
  w: WeaponDef,
  blk: WeaponBlock,
  slot: number,
  lock: number,
  powered: boolean,
): void {
  const ent = state.ent;
  const ox = ent.posX[shooter];
  const oy = ent.posY[shooter];
  let ux = ent.aimX[shooter];
  let uy = ent.aimY[shooter];
  let len = blk.range;
  if (lock >= 0) {
    const dx = ent.posX[lock] - ox;
    const dy = ent.posY[lock] - oy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1e-6) {
      ux = dx / d;
      uy = dy / d;
      if (d < len) len = d;
    }
  }
  let ex = ox + ux * len;
  let ey = oy + uy * len;
  const wallT = segmentBlockT(state.map, ox, oy, ex, ey);
  if (wallT >= 0) {
    len *= wallT;
    ex = ox + ux * len;
    ey = oy + uy * len;
  }
  pushEvent(state.events, EV_SHOT, shooter, slot, weaponShotPayload(w.id, len, powered));
  blastAt(state, ex, ey, ent.team[shooter], player, blk.damage, blk.blast, PROJ_BEAM, BLAST_EMIT);
}

/** blastAt options. */
const BLAST_EMIT = 1;
/** Metropolis' flat pulse (radius + the target's own) instead of the original's falloff. */
const BLAST_FLAT = 2 | BLAST_EMIT;

/**
 * Area damage at a point. The original's blast (`cact_area_damage`, damage.c
 * 0x0042f170) falls off linearly over HORIZONTAL distance, centre to centre:
 * damage * (r - d) / r inside r, truncated, nothing at 0 (fcop-fidelity.md W1).
 * BLAST_FLAT keeps Metropolis' full-damage pulse to the radius plus the target's
 * own: the Shockwave Generator's (whose time profile was not established) and the
 * Warden's bomb (Metropolis' own weapon). Own team and projectiles are skipped
 * (Metropolis has no friendly fire).
 */
function blastAt(
  state: SimState,
  x: number,
  y: number,
  team: number,
  owner: number,
  damage: number,
  radius: number,
  kind: number,
  opts: number,
): void {
  const ent = state.ent;
  if ((opts & BLAST_EMIT) !== 0) {
    pushEvent(state.events, EV_EXPLOSION, Math.floor(x * 16), Math.floor(y * 16), kind);
  }
  if (!(radius > 0)) return;
  const flat = (opts & BLAST_FLAT) === BLAST_FLAT;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t]) continue;
    if (ent.team[t] === team) continue;
    if (ent.archetype[t] === ARCHETYPE.PROJECTILE) continue;
    const dx = ent.posX[t] - x;
    const dy = ent.posY[t] - y;
    const d2 = dx * dx + dy * dy;
    if (flat) {
      const r = radius + ARCHETYPE_RADIUS[ent.archetype[t]];
      if (d2 <= r * r) applyDamage(state, t, damage, owner);
    } else if (d2 < radius * radius) {
      const dmg = Math.floor((damage * (radius - Math.sqrt(d2))) / radius);
      if (dmg > 0) applyDamage(state, t, dmg, owner);
    }
  }
}

// Round behaviour bits, in a projectile's ammoB.
const ROUND_HOMING = 1;
const ROUND_ARC = 2;
const ROUND_CLUSTER = 4;
/** The Warden's bomb: Metropolis' flat blast. */
const ROUND_FLAT_BLAST = 8;

/**
 * A projectile's fields (the PROJECTILE archetype reuses the store):
 *   mode       payload kind (renderer + explosion kind)
 *   velX/velY  horizontal velocity, m/s
 *   timerA     ticks left before it expires
 *   timerB     vertical velocity, m/s (a mine: its arming delay, ticks)
 *   cooldownA  current speed, m/s (a mine: its sprung fuse, ticks; 0 = not sprung)
 *   cooldownB  flight distance left, m (0 = no limit)
 *   cooldownC  homing target id, -1 none (a mine: its trigger radius)
 *   aimX       top speed, m/s (arced: gravity, m/s²)
 *   aimY       acceleration, m/s²
 *   ammoA      damage; aux: blast radius, m; ammoB: ROUND_* bits
 *   ownerId    the player credited (or -1)
 */
function spawnStraight(
  state: SimState,
  shooter: number,
  dx: number,
  dy: number,
  homeOn: number,
  aimAt: number,
): number {
  const ent = state.ent;
  const id = spawn(ent, ARCHETYPE.PROJECTILE, ent.team[shooter]);
  if (id < 0) return -1;
  const x = ent.posX[shooter] + dx * MUZZLE_OFFSET;
  const y = ent.posY[shooter] + dy * MUZZLE_OFFSET;
  const h = ent.height[shooter] + MUZZLE_HEIGHT;
  ent.posX[id] = x;
  ent.posY[id] = y;
  ent.height[id] = h;
  ent.velX[id] = dx;
  ent.velY[id] = dy;
  ent.yaw[id] = atan2Poly(dy, dx);
  ent.hp[id] = 1;
  ent.cooldownC[id] = homeOn;
  ent.timerB[id] = 0;
  if (aimAt >= 0) {
    // Climb or dive toward the target's muzzle-relative height along the way.
    const tx = ent.posX[aimAt] - x;
    const ty = ent.posY[aimAt] - y;
    const d = Math.sqrt(tx * tx + ty * ty);
    if (d > 0.5) ent.timerB[id] = (ent.height[aimAt] + MUZZLE_HEIGHT - h) / d; // per metre
  }
  return id;
}

/**
 * The original's ballistic solve (`cact_discharge_arc`; combat.md "The ballistic
 * solution"): launch speed v, gravity k, horizontal distance x (clamped above
 * zero), height difference dy, A = x k / (2 v²), tangent of elevation
 * t = (1 + sqrt(1 - 4 (dy/x + A) A)) / (2A) — the HIGH root, a lob. An
 * unreachable aim point is not an error: the root is taken as zero and the shell
 * leaves at the boundary elevation and falls short. The elevation is not
 * quantised to the original's 12-bit angle; cos/sin come from t by sqrt alone.
 */
function spawnArced(
  state: SimState,
  x: number,
  y: number,
  h: number,
  tx: number,
  ty: number,
  th: number,
  v: number,
  k: number,
): number {
  const ent = state.ent;
  // The team is set by armRound's caller: spawn as neutral, then overwrite.
  const id = spawn(ent, ARCHETYPE.PROJECTILE, TEAM_NEUTRAL);
  if (id < 0) return -1;
  let hx = tx - x;
  let hy = ty - y;
  let dist = Math.sqrt(hx * hx + hy * hy);
  if (dist < 1e-9) {
    hx = 1; // straight overhead: any heading, the clamp below takes over
    hy = 0;
  }
  const inv = 1 / Math.sqrt(hx * hx + hy * hy);
  if (dist < ARC_MIN_DISTANCE) dist = ARC_MIN_DISTANCE;
  const a = (dist * k) / (2 * v * v);
  const disc = 1 - 4 * ((th - h) / dist + a) * a;
  const t = (1 + (disc > 0 ? Math.sqrt(disc) : 0)) / (2 * a);
  const c = 1 / Math.sqrt(1 + t * t);
  ent.posX[id] = x;
  ent.posY[id] = y;
  ent.height[id] = h;
  ent.velX[id] = hx * inv * v * c;
  ent.velY[id] = hy * inv * v * c;
  ent.timerB[id] = v * t * c;
  ent.yaw[id] = atan2Poly(hy, hx);
  ent.hp[id] = 1;
  ent.cooldownC[id] = -1;
  ent.aimX[id] = k;
  return id;
}

/** The solve's distance clamp (the original's is 2 wu), metres. */
const ARC_MIN_DISTANCE = 0.05;

/** Stamps a spawned round with its block's damage, blast, speeds and life. */
function armRound(
  state: SimState,
  id: number,
  shooter: number,
  owner: number,
  kind: number,
  blk: WeaponBlock,
  flags: number,
  _lock: number,
): void {
  const ent = state.ent;
  ent.team[id] = ent.team[shooter];
  ent.mode[id] = kind;
  ent.ownerId[id] = owner;
  ent.ammoA[id] = blk.damage;
  ent.aux[id] = blk.blast;
  ent.ammoB[id] = flags;
  ent.timerA[id] = blk.fuseTicks > 0 ? blk.fuseTicks : ROUND_MAX_TICKS;
  if ((flags & ROUND_ARC) === 0) {
    // A missile: launch speed along its direction, accelerating to its top.
    const sp = blk.launchSpeed;
    ent.cooldownA[id] = sp;
    ent.velX[id] *= sp;
    ent.velY[id] *= sp;
    ent.cooldownB[id] = blk.range;
    ent.aimX[id] = blk.speed;
    ent.aimY[id] = blk.accel;
  }
}

/** A safety lifetime for a round whose record carries no fuse, ticks. */
const ROUND_MAX_TICKS = 300;

/** Scratch for leadAim (module scope: no allocation per shot). */
const leadScratch = { x: 0, y: 0 };

/**
 * Intercept lead (`cact_discharge_lead`): the horizontal direction from the
 * shooter at which a round of `speed` meets `target` moving at its current
 * velocity. Writes leadScratch and answers true; false when there is no
 * intercept (the caller then fires straight at the target or along its facing).
 * The original's lead details (it passes the block's speed unshifted) were not
 * established (fcop-re/player-and-weapons.md §9.3); this is the plain solution.
 */
function leadAim(state: SimState, shooter: number, target: number, speed: number): boolean {
  const ent = state.ent;
  const px = ent.posX[target] - ent.posX[shooter];
  const py = ent.posY[target] - ent.posY[shooter];
  const vx = ent.velX[target];
  const vy = ent.velY[target];
  // |P + V t| = s t  ->  (V.V - s²) t² + 2 P.V t + P.P = 0
  const a = vx * vx + vy * vy - speed * speed;
  const b = 2 * (px * vx + py * vy);
  const c = px * px + py * py;
  let t = -1;
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * a);
      const t2 = (-b + sq) / (2 * a);
      t = t1 > 0 && (t2 <= 0 || t1 < t2) ? t1 : t2;
    }
  }
  let ax = px;
  let ay = py;
  if (t > 0) {
    ax = px + vx * t;
    ay = py + vy * t;
  }
  const len = Math.sqrt(ax * ax + ay * ay);
  if (len < 1e-6) return false;
  leadScratch.x = ax / len;
  leadScratch.y = ay / len;
  return true;
}

/**
 * Drop a Pop-Up Mine at the shooter's feet (the original drops it from the
 * muzzle and lets it fall; Metropolis places it). Live lifetime and arming delay
 * are Metropolis' own (balance.ts SPECIAL_MINE_*); the trigger reach, fuse,
 * damage and blast are the record's.
 */
function spawnMine(
  state: SimState,
  shooter: number,
  player: number,
  kind: number,
  blk: WeaponBlock,
): boolean {
  const ent = state.ent;
  const id = spawn(ent, ARCHETYPE.PROJECTILE, ent.team[shooter]);
  if (id < 0) return false;
  ent.posX[id] = ent.posX[shooter];
  ent.posY[id] = ent.posY[shooter];
  ent.height[id] = ent.height[shooter] + 0.25;
  ent.yaw[id] = ent.yaw[shooter];
  ent.hp[id] = 1;
  ent.mode[id] = kind;
  ent.timerA[id] = SPECIAL_MINE_TTL_TICKS; // live lifetime
  ent.timerB[id] = SPECIAL_MINE_ARM_TICKS; // arming delay
  ent.cooldownA[id] = 0; // not sprung
  ent.cooldownC[id] = blk.reach; // trigger radius
  ent.ammoA[id] = blk.damage;
  ent.aux[id] = blk.blast;
  ent.ownerId[id] = player;
  return true;
}

/**
 * First enemy hit along the 2D ray within `range`, if any (shared w/ Warden).
 *
 * Also emits this shot's EV_SHOT, because only here is the shot's REACH known —
 * the distance to the body it hits, to the wall that stops it, or the full
 * range. The renderer draws the tracer to that (fx.ts); pushed from the caller
 * it could only ever be the weapon's nominal range. It is emitted BEFORE
 * applyDamage so the event buffer keeps pairing each EV_SHOT with the EV_HITs
 * it caused, which is how attribution reads it (paAttribution.test.ts).
 *
 * `shotSlot < 0` skips the event entirely — for callers that have no tracer to
 * draw, and for tests exercising the damage path alone.
 */
export function hitscan(
  state: SimState,
  shooter: number,
  player: number,
  dx: number,
  dy: number,
  range: number,
  damage: number,
  shotSlot = -1,
  shotWeaponId = 0,
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
  if (shotSlot >= 0) {
    // How far this shot actually travels. Render-only: it is computed from the
    // map and the ray, writes nothing, and the damage decision below still runs
    // through the untouched `segmentBlocked` call on its own short segment —
    // so no arithmetic that feeds the hash changed.
    let reach = bestId >= 0 ? bestT : range;
    const wallT = segmentBlockT(state.map, ox, oy, ox + dx * range, oy + dy * range);
    if (wallT >= 0) {
      const wallDist = wallT * range;
      if (wallDist < reach) reach = wallDist;
    }
    pushEvent(
      state.events,
      EV_SHOT,
      shooter,
      shotSlot,
      shotSlot === SHOT_SLOT_HITSCAN
        ? reachToShotPayload(reach)
        : weaponShotPayload(shotWeaponId, reach),
    );
  }
  if (bestId >= 0) {
    // Walls stop the ray: bestId is the CLOSEST body hit, so a wall on the
    // way to it means the shot hits the wall and nothing else.
    // Exception: the Warden superplane may hit enemy ground units through the
    // lattice (it flies above it). Emplacements still need line of sight — that
    // is the arenas' cover model for anything that can answer a standoff shot
    // (issue #31 urban-jungle mid-map stream).
    const flyerSoft =
      ent.archetype[shooter] === ARCHETYPE.WARDEN &&
      ent.archetype[bestId] >= ARCHETYPE.RUNNER &&
      ent.archetype[bestId] <= ARCHETYPE.FORTRESS;
    if (!flyerSoft && segmentBlocked(state.map, ox, oy, ox + dx * bestT, oy + dy * bestT)) {
      return;
    }
    applyDamage(state, bestId, damage, player);
  }
}

/**
 * The Warden's bomb (warden.ts): the Sky Captain's weapon 9, 200 damage in a
 * 3.2 m blast with the original's linear falloff (fcop-re/ai-and-rules.md §1.4).
 * Its speed and arc could not be established, so it keeps Metropolis' flight: a
 * flat round at WARDEN_HEAVY_SPEED for WARDEN_HEAVY_TTL_TICKS.
 */
export function spawnWardenBomb(
  state: SimState,
  shooter: number,
  player: number,
  dx: number,
  dy: number,
): void {
  const ent = state.ent;
  const id = spawnStraight(state, shooter, dx, dy, -1, -1);
  if (id < 0) return;
  ent.mode[id] = PROJ_WARDEN;
  ent.ownerId[id] = player;
  ent.ammoA[id] = SKY_BOMB_DAMAGE;
  ent.aux[id] = SKY_BOMB_BLAST;
  ent.ammoB[id] = 0; // linear falloff, as the original's area damage
  ent.timerA[id] = WARDEN_HEAVY_TTL_TICKS;
  ent.cooldownA[id] = WARDEN_HEAVY_SPEED;
  ent.velX[id] = dx * WARDEN_HEAVY_SPEED;
  ent.velY[id] = dy * WARDEN_HEAVY_SPEED;
  ent.cooldownB[id] = 0;
  ent.aimX[id] = WARDEN_HEAVY_SPEED;
  ent.aimY[id] = 0;
}

/**
 * The Warden's missile (warden.ts): the Sky Captain's weapon 8, guided, 25
 * damage, flying 24 m (fcop-re/ai-and-rules.md §1.4), homing on `target`. Its
 * speed could not be established, so it flies at Metropolis' WARDEN_HEAVY_SPEED.
 */
export function fireWardenMissile(
  state: SimState,
  shooter: number,
  target: number,
  dx: number,
  dy: number,
): void {
  const ent = state.ent;
  const p = spawnStraight(state, shooter, dx, dy, target, target);
  if (p < 0) return;
  const speed = WARDEN_HEAVY_SPEED;
  ent.mode[p] = PROJ_ROUND;
  ent.ownerId[p] = ent.ownerId[shooter];
  ent.ammoA[p] = SKY_MISSILE_DAMAGE;
  ent.aux[p] = 0;
  ent.ammoB[p] = ROUND_HOMING;
  ent.timerA[p] = Math.ceil((SKY_MISSILE_FLIGHT / speed) * TICK_HZ) + 1;
  ent.cooldownA[p] = speed;
  ent.velX[p] = dx * speed;
  ent.velY[p] = dy * speed;
  ent.cooldownB[p] = SKY_MISSILE_FLIGHT;
  ent.aimX[p] = speed;
  ent.aimY[p] = 0;
  pushEvent(state.events, EV_SHOT, shooter, SHOT_SLOT_LAUNCH, SKY_WEAPON_MISSILE);
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
  }
  // An outpost claim is permanent, as the original's is (fcop-fidelity.md R14),
  // on every arena: the console is the claim zone's marker, not a target.
  if (ent.archetype[target] === ARCHETYPE.CONSOLE) return;
  ent.hp[target] -= damage;
  // aux stores 1 + last attacking player for kill attribution (0 = none).
  ent.aux[target] = attacker + 1;
  pushEvent(state.events, EV_HIT, target, attacker, damage);
  // "Base turret under fire" (fcop-fidelity.md R15): a ring turret was hit, at
  // most once per side per TURRET_ALERT_COOLDOWN_TICKS. The cooldown is sim
  // state so every peer and every replay agrees on when the line plays.
  if (
    state.turretAlert.length > 0 &&
    ent.archetype[target] === ARCHETYPE.TURRET &&
    ent.mode[target] === TURRET_DEFENSE
  ) {
    const team = ent.team[target];
    if ((team === 0 || team === 1) && state.turretAlert[team] === 0) {
      state.turretAlert[team] = TURRET_ALERT_COOLDOWN_TICKS;
      pushEvent(state.events, EV_TURRET_UNDER_FIRE, target, team, 0);
    }
  }
}

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

/**
 * Turrets and units acquire a hostile and fire. Owned turrets defend against
 * avatars AND units; neutral dummies keep their Phase 1 role and only ever
 * engage avatars. Turrets never target turrets.
 *
 * Every shooter runs the original's model on its weapon profile (the arena's
 * records, or balance.ts ORIGINAL_WEAPON_PROFILES where it has none;
 * fcop-fidelity.md W3): the original's rate machine fires a ROUND — a projectile
 * entity at the catalogue entry's speed, lead-aimed or guided, flying its range —
 * and a turret also runs the original's re-search period, hold-target, priority
 * and firing arc (`shooterTurret`), a unit the same machine on its own record
 * (`shooterUnit`). Metropolis' instant hit on a tick cooldown (TURRET_*, UNIT_*),
 * which district-01 and the sandbox kept until SIM_VERSION 52, is gone. A
 * sandbox entity placed with no profile does not shoot.
 */
function systemTargeting(state: SimState): void {
  const ent = state.ent;
  const weapons = state.map.weapons;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id]) continue;
    const archetype = ent.archetype[id];
    const profile = ent.weaponProfile[id];
    if (profile < 0) continue;
    const w = weapons[profile];
    if (archetype === ARCHETYPE.TURRET) {
      // Capturable neutral turrets are dormant: no owner, nobody to fire at
      // (rules.md §5 "fires at enemies of its owner").
      if (ent.mode[id] === TURRET_CAPTURABLE && ent.ownerId[id] < 0) continue;
      shooterTurret(state, id, w);
    } else if (isUnit(archetype)) {
      shooterUnit(state, id, w);
    }
  }
}

/** Turns `id`'s yaw toward `bearing` by at most `rate`; true once on it. */
function slewTo(ent: EntityStore, id: number, bearing: number, rate: number): boolean {
  const d = angleDelta(ent.yaw[id], bearing);
  if (d > rate) {
    ent.yaw[id] += rate;
    return false;
  }
  if (d < -rate) {
    ent.yaw[id] -= rate;
    return false;
  }
  ent.yaw[id] = bearing;
  return true;
}

// The original's shooter rate machine (`cact_shooter_step` 0x0044e5e0;
// combat.md "The rate machine"), for the PA catalogue's one-round entries. State
// on the shooter entity: cooldownA = the clock in engine units, aimY = the phase.
// Inside a burst the clock runs up to the round gap (0) and the round falls due;
// fired, the burst is over and the clock runs up to the burst gap; the reload
// clamps the leftover to the round gap, so the next round is due the tick after.
// With the 10-unit tick, weapon 3's 601-unit gap is a round every 61 ticks
// (2.03 s). A due round waits for a target with the clock stopped.
const PHASE_INSIDE = 0;
const PHASE_DUE = 1;
const PHASE_BETWEEN = 2;

/** Advances the rate machine one tick; true when a round is due. */
function shooterDue(ent: EntityStore, id: number, w: MapWeapon): boolean {
  let phase = ent.aimY[id];
  let clock = ent.cooldownA[id];
  if (phase === PHASE_INSIDE) {
    clock += WEAPON_UNITS_PER_TICK;
    if (clock >= 0) phase = PHASE_DUE;
  } else if (phase === PHASE_BETWEEN) {
    clock += WEAPON_UNITS_PER_TICK;
    if (clock >= w.refireUnits) {
      clock -= w.refireUnits;
      if (clock > 0) clock = 0; // clamped to the round gap: due next tick
      phase = PHASE_INSIDE;
    }
  }
  ent.aimY[id] = phase;
  ent.cooldownA[id] = clock;
  return phase === PHASE_DUE;
}

/**
 * The PA turret (`turret_tick` + its shooter, fcop-re/ranges-turrets-capture.md
 * Q3; fcop-fidelity.md W3). Its target lives in cooldownC (id + 1, 0 = none) and
 * its re-search countdown in cooldownB (engine units):
 * - a due round first drops a dead or out-of-reach target (12 m, horizontal);
 * - with no target — or always, for a HOLD_TARGET team turret — it searches,
 *   but only when the countdown has run out, which reloads it with the
 *   targeting delay (2.0 s): the nearest enemy in reach with a line of sight,
 *   a team turret preferring the higher priority (Dreadnought > tank > X1);
 * - the gun slews toward its target at the original's turn rate every tick;
 * - the round goes out only if its (lead-)aim lies within 22.5° of the barrel
 *   and the line is clear; otherwise it is put back and the clock pushed back
 *   0-0.85 s at random (the sim PRNG).
 */
function shooterTurret(state: SimState, id: number, w: MapWeapon): void {
  const ent = state.ent;
  let target = ent.cooldownC[id] - 1;
  const due = shooterDue(ent, id, w);
  let search = ent.cooldownB[id];
  if (!due) {
    // The countdown also runs between rounds for a holding turret, clamped at 0.
    if (w.hold === 1) {
      search -= WEAPON_UNITS_PER_TICK;
      if (search < 0) search = 0;
      ent.cooldownB[id] = search;
    }
    if (target >= 0 && ent.alive[target]) turretSlew(state, id, target, w);
    return;
  }
  if (target >= 0 && !shooterTargetValid(state, id, target, w.range)) target = -1;
  if (target < 0 || w.hold === 1) {
    search -= WEAPON_UNITS_PER_TICK;
    let found = -1;
    if (search < 0) {
      search = w.searchUnits;
      // A neutral dummy (Metropolis' target practice) engages avatars only.
      found =
        ent.ownerId[id] < 0
          ? nearestEnemyAvatar(state, id, w.range)
          : nearestEnemyInRange(state, id, w.range, true, w.priority === 1);
    }
    if (found >= 0) target = found;
  }
  ent.cooldownB[id] = search;
  ent.cooldownC[id] = target + 1;
  if (target < 0) return; // the round waits, the clock stopped
  turretSlew(state, id, target, w);
  if (!aimRound(state, id, target, w)) return;
  const fx = cosLUT(ent.yaw[id]);
  const fy = sinLUT(ent.yaw[id]);
  const blocked = segmentBlocked(
    state.map,
    ent.posX[id],
    ent.posY[id],
    ent.posX[target],
    ent.posY[target],
  );
  if (blocked || (w.arcCos > -1 && aimScratch.x * fx + aimScratch.y * fy < w.arcCos)) {
    // Put back: due again once the clock has run the retry delay back up.
    ent.aimY[id] = PHASE_INSIDE;
    ent.cooldownA[id] -= Math.floor(rand01(state) * SHOOTER_RETRY_UNITS);
    return;
  }
  fireRound(state, id, target, w, 1);
}

/** A turret's gun follows its target at the record's turn rate (instant without one). */
function turretSlew(state: SimState, id: number, target: number, w: MapWeapon): void {
  const ent = state.ent;
  const bearing = atan2Poly(ent.posY[target] - ent.posY[id], ent.posX[target] - ent.posX[id]);
  if (w.turnSpeed > 0) slewTo(ent, id, bearing, w.turnSpeed);
  else ent.yaw[id] = bearing;
}

/** The shooter's own keep-target test: alive, still an enemy, inside reach. */
function shooterTargetValid(state: SimState, id: number, t: number, range: number): boolean {
  const ent = state.ent;
  if (!ent.alive[t] || ent.hp[t] <= 0 || ent.archetype[t] === ARCHETYPE.PROJECTILE) return false;
  const team = ent.team[t];
  if (team === ent.team[id] || team === TEAM_NEUTRAL) return false;
  const dx = ent.posX[t] - ent.posX[id];
  const dy = ent.posY[t] - ent.posY[id];
  return dx * dx + dy * dy < range * range;
}

/**
 * A PA unit's shooter (`cact_shooter_step`; fcop-fidelity.md W3 and U1-U2's
 * targeting row; fcop-re/ranges-turrets-capture.md Q3): the original's rate
 * machine and rounds, and its targeting — the same one a turret runs, on the
 * unit's own record:
 * - the target lives in cooldownC (id + 1, 0 = none) and the re-search countdown
 *   in ammoA (engine units);
 * - a due round first drops a dead, no-longer-hostile or out-of-reach (12 m)
 *   target;
 * - with no target it searches, but only when the countdown has run out, which
 *   reloads it with the shooter's targeting delay: 32/16 s = 2.0 s for the tank
 *   and the jet, 16/16 = 1.0 s for the Dreadnought's guns and the Fortress. The
 *   search is the nearest enemy in reach with a line of sight; none of the units'
 *   records holds its target or prefers by priority (only the team turrets do);
 * - a round goes out at the target with a clear line, else it is put back and
 *   tried 0-0.85 s later (the sim PRNG); units have no firing arc.
 * An aircraft fires only while it is engaging (a move target held, units.ts
 * `moveAircraft`): the original steps an aircraft's shooter in STATE_ENGAGE
 * only. A Juggernaut's due round is a volley, one round from each of its hull
 * guns.
 * Until SIM_VERSION 45 a unit re-picked the nearest enemy in reach every tick.
 */
function shooterUnit(state: SimState, id: number, w: MapWeapon): void {
  const ent = state.ent;
  let target = ent.cooldownC[id] - 1;
  const due = shooterDue(ent, id, w);
  if (target >= 0 && !ent.alive[target]) target = -1;
  if (!due) {
    ent.cooldownC[id] = target + 1;
    if (target >= 0) faceTarget(ent, id, target);
    return;
  }
  const range = unitRange(state, id);
  if (target >= 0 && !shooterTargetValid(state, id, target, range)) target = -1;
  if (target < 0) {
    let search = ent.ammoA[id] - WEAPON_UNITS_PER_TICK;
    if (search < 0) {
      search = w.searchUnits;
      target = nearestEnemyInRange(state, id, range);
    }
    ent.ammoA[id] = search;
  }
  ent.cooldownC[id] = target + 1;
  if (target < 0) return; // the round waits, the clock stopped
  if (isAirUnit(ent.archetype[id]) && !aircraftEngaged(state, id)) {
    // An aircraft fires only while engaging: the round stays due.
    return;
  }
  faceTarget(ent, id, target);
  if (!aimRound(state, id, target, w)) return;
  if (segmentBlocked(state.map, ent.posX[id], ent.posY[id], ent.posX[target], ent.posY[target])) {
    ent.aimY[id] = PHASE_INSIDE;
    ent.cooldownA[id] -= Math.floor(rand01(state) * SHOOTER_RETRY_UNITS);
    return;
  }
  let rounds = 1;
  if (ent.archetype[id] === ARCHETYPE.JUGGERNAUT) {
    const dread = state.map.bases[ent.team[id]].juggernaut;
    if (dread !== undefined) rounds = dread.guns;
  }
  fireRound(state, id, target, w, rounds);
}

/** A unit's hull (or gun) turns to its target at once. */
function faceTarget(ent: EntityStore, id: number, target: number): void {
  ent.yaw[id] = atan2Poly(ent.posY[target] - ent.posY[id], ent.posX[target] - ent.posX[id]);
}

/** Scratch: the aim aimRound computed (module scope, no allocation per shot). */
const aimScratch = { x: 0, y: 0 };

/**
 * The round's horizontal aim at `target`: with an intercept lead for a lead-aimed
 * entry (`cact_discharge_lead`), else straight at it. False only when the target
 * stands on the shooter.
 */
function aimRound(state: SimState, id: number, target: number, w: MapWeapon): boolean {
  if (w.lead === 1 && leadAim(state, id, target, w.speed)) {
    aimScratch.x = leadScratch.x;
    aimScratch.y = leadScratch.y;
    return true;
  }
  const ent = state.ent;
  const dx = ent.posX[target] - ent.posX[id];
  const dy = ent.posY[target] - ent.posY[id];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return false;
  aimScratch.x = dx / len;
  aimScratch.y = dy / len;
  return true;
}

/**
 * Discharges `rounds` rounds along aimScratch: projectile entities at the entry's
 * speed (no acceleration), flying its range, homing on `target` when guided, and
 * damaging only what they strike (no PA world weapon has a blast). Each round's
 * EV_SHOT is a muzzle flash — the round renders as its own entity. The rate machine goes
 * between bursts once anything went out; a full entity store fires nothing and
 * leaves the round due.
 */
function fireRound(
  state: SimState,
  id: number,
  target: number,
  w: MapWeapon,
  rounds: number,
): void {
  const ent = state.ent;
  let fired = false;
  for (let r = 0; r < rounds; r++) {
    const p = spawnStraight(
      state,
      id,
      aimScratch.x,
      aimScratch.y,
      w.guided === 1 ? target : -1,
      target,
    );
    if (p < 0) break;
    ent.mode[p] = PROJ_ROUND;
    ent.ownerId[p] = ent.ownerId[id];
    ent.ammoA[p] = w.damage;
    ent.aux[p] = 0;
    ent.ammoB[p] = w.guided === 1 ? ROUND_HOMING : 0;
    ent.timerA[p] = Math.ceil((w.flight / w.speed) * TICK_HZ) + 1;
    ent.cooldownA[p] = w.speed;
    ent.velX[p] = aimScratch.x * w.speed;
    ent.velY[p] = aimScratch.y * w.speed;
    ent.cooldownB[p] = w.flight;
    ent.aimX[p] = w.speed;
    ent.aimY[p] = 0;
    pushEvent(state.events, EV_SHOT, id, SHOT_SLOT_LAUNCH, 0);
    fired = true;
  }
  if (fired) ent.aimY[id] = PHASE_BETWEEN;
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

/**
 * Projectiles: fly, home, expire, burst at the apex, explode on contact or terrain.
 * Mines arm, wait, spring and blow.
 */
function systemProjectiles(state: SimState): void {
  const ent = state.ent;
  const map = state.map;
  const extent = worldExtent(map);
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || ent.archetype[id] !== ARCHETYPE.PROJECTILE) continue;

    // Pop-Up Mines: stationary proximity charges. Ground/wall contact must NOT
    // detonate them (they sit on the floor by design). The arming delay in timerB
    // lets the placer walk clear; a silent despawn on TTL keeps a forgotten mine
    // from lingering forever (both Metropolis' own). An enemy within the record's
    // trigger reach plus its own radius springs it, and it goes off a second
    // later wherever that enemy has gone (fcop-re/player-and-weapons.md §7).
    if (ent.mode[id] === PROJ_MINE) {
      if (ent.cooldownA[id] > 0) {
        ent.cooldownA[id] -= 1;
        if (ent.cooldownA[id] <= 0) explode(state, id);
        continue;
      }
      ent.timerA[id] -= 1;
      if (ent.timerA[id] <= 0) {
        despawn(ent, id);
        continue;
      }
      if (ent.timerB[id] > 0) {
        ent.timerB[id] -= 1;
        continue;
      }
      const mx = ent.posX[id];
      const my = ent.posY[id];
      const team = ent.team[id];
      const reach = ent.cooldownC[id];
      for (let t = 0; t < ent.high; t++) {
        if (!ent.alive[t] || t === id) continue;
        if (ent.team[t] === team) continue;
        if (ent.archetype[t] === ARCHETYPE.PROJECTILE) continue;
        const r = reach + ARCHETYPE_RADIUS[ent.archetype[t]];
        const dx = ent.posX[t] - mx;
        const dy = ent.posY[t] - my;
        if (dx * dx + dy * dy <= r * r) {
          ent.cooldownA[id] = SPECIAL_MINE_FUSE_TICKS;
          break;
        }
      }
      continue;
    }

    const flags = ent.ammoB[id];
    ent.timerA[id] -= 1;
    let vx = ent.velX[id];
    let vy = ent.velY[id];
    const arc = (flags & ROUND_ARC) !== 0;
    let speed = arc ? 0 : ent.cooldownA[id];
    if (!arc) {
      // A missile accelerates from its launch speed to its top speed.
      const top = ent.aimX[id];
      if (speed < top) {
        speed += ent.aimY[id] * TICK_DT;
        if (speed > top) speed = top;
      }
      const vl = Math.sqrt(vx * vx + vy * vy);
      let ux = vl > 1e-9 ? vx / vl : cosLUT(ent.yaw[id]);
      let uy = vl > 1e-9 ? vy / vl : sinLUT(ent.yaw[id]);
      const target = ent.cooldownC[id];
      if ((flags & ROUND_HOMING) !== 0 && target >= 0) {
        if (!homingValid(state, id, target)) {
          ent.cooldownC[id] = -1;
        } else {
          // Steer toward the target at MISSILE_TURN_RATE (ours, §9.3 of the RE),
          // and climb or dive to arrive at its muzzle-relative height.
          const tx = ent.posX[target] - ent.posX[id];
          const ty = ent.posY[target] - ent.posY[id];
          const d = Math.sqrt(tx * tx + ty * ty);
          if (d > 1e-6) {
            const want = atan2Poly(ty, tx);
            const have = atan2Poly(uy, ux);
            const err = angleDelta(have, want);
            const lim = MISSILE_TURN_RATE * TICK_DT;
            const turn = err > lim ? lim : err < -lim ? -lim : err;
            if (turn === err) {
              ux = tx / d;
              uy = ty / d;
            } else {
              const c = cosLUT(turn);
              const s = sinLUT(turn);
              const nx = ux * c - uy * s;
              uy = ux * s + uy * c;
              ux = nx;
            }
            ent.timerB[id] = (ent.height[target] + MUZZLE_HEIGHT - ent.height[id]) / d;
          }
        }
      }
      vx = ux * speed;
      vy = uy * speed;
      ent.velX[id] = vx;
      ent.velY[id] = vy;
      ent.cooldownA[id] = speed;
      ent.yaw[id] = atan2Poly(uy, ux);
    }

    const px = ent.posX[id];
    const py = ent.posY[id];
    const x = px + vx * TICK_DT;
    const y = py + vy * TICK_DT;
    // A wall stops the shell on the near side: don't advance into it, so the
    // explosion (and its blast centre) stays on the shooter's side.
    const walled = segmentBlocked(map, px, py, x, y);
    if (!walled) {
      ent.posX[id] = x;
      ent.posY[id] = y;
    }
    let expired = ent.timerA[id] <= 0;
    if (arc) {
      // Semi-implicit Euler under the round's own gravity (its record's range
      // field): velocity first, then the position.
      const before = ent.timerB[id];
      ent.timerB[id] -= ent.aimX[id] * TICK_DT;
      ent.height[id] += ent.timerB[id] * TICK_DT;
      if ((flags & ROUND_CLUSTER) !== 0 && before > 0 && ent.timerB[id] <= 0) {
        burstCluster(state, id);
        continue;
      }
    } else {
      const step = speed * TICK_DT;
      ent.height[id] += ent.timerB[id] * step;
      const left = ent.cooldownB[id];
      if (left > 0) {
        if (left <= step) expired = true;
        else ent.cooldownB[id] = left - step;
      }
    }
    let boom = walled || expired;
    if (x <= 0 || x >= extent || y <= 0 || y >= extent) boom = true;
    // Only a lobbed shell meets the ground. A straight round flies the line it was
    // aimed along and is stopped by the wall lattice (Metropolis' cover model) or
    // its range: units and turrets stand on decks and road casts the base
    // heightfield does not describe, and a round born under that surface used to
    // die on its first step.
    if (!boom && arc && sampleHeight(map, ent.posX[id], ent.posY[id]) >= ent.height[id]) {
      boom = true;
    }
    let struck = -1;
    if (!boom) {
      // Contact fuze: any enemy non-projectile within its hit radius + 0.5.
      for (let t = 0; t < ent.high; t++) {
        if (!ent.alive[t] || t === id) continue;
        if (ent.team[t] === ent.team[id]) continue;
        if (ent.archetype[t] === ARCHETYPE.PROJECTILE) continue;
        const r = ARCHETYPE_RADIUS[ent.archetype[t]] + 0.5;
        const dx = ent.posX[t] - ent.posX[id];
        const dy = ent.posY[t] - ent.posY[id];
        if (dx * dx + dy * dy <= r * r) {
          boom = true;
          struck = t;
          break;
        }
      }
    }
    if (boom) {
      if (expired && ent.aux[id] <= 0 && struck < 0) {
        despawn(ent, id); // a round with no blast that runs out of range just ends
      } else {
        explode(state, id, struck);
      }
    }
  }
}

/**
 * A homing round keeps its target while it lives — and, as the original's
 * missile does, drops it when the target is a cloaked X1-Alpha within 4 m
 * (0x8000 wu, retail 0x0042379f; fcop-re/player-and-weapons.md §6, P7).
 */
function homingValid(state: SimState, id: number, target: number): boolean {
  const ent = state.ent;
  if (!ent.alive[target] || ent.hp[target] <= 0) return false;
  if (state.buffInvis.length > 0) {
    for (let p = 0; p < MAX_PLAYERS; p++) {
      if (state.avatarId[p] !== target || state.buffInvis[p] <= 0) continue;
      const dx = ent.posX[target] - ent.posX[id];
      const dy = ent.posY[target] - ent.posY[id];
      if (dx * dx + dy * dy < CLOAK_DISARM_RADIUS * CLOAK_DISARM_RADIUS) return false;
    }
  }
  return true;
}

/**
 * The powered Mortar's shell bursts at its apex into four fragments of its own
 * block (kind 4, the B record's damage and blast). The spread is Metropolis' own
 * (balance.ts MORTAR_FRAGMENT_SPREAD): a cross about the shell's heading.
 */
function burstCluster(state: SimState, id: number): void {
  const ent = state.ent;
  const vx = ent.velX[id];
  const vy = ent.velY[id];
  const sp = Math.sqrt(vx * vx + vy * vy);
  const fx = sp > 1e-6 ? vx / sp : 1;
  const fy = sp > 1e-6 ? vy / sp : 0;
  for (let i = 0; i < 4; i++) {
    const f = spawn(ent, ARCHETYPE.PROJECTILE, ent.team[id]);
    if (f < 0) break;
    // Forward, back, left, right of the heading.
    const ax = i === 0 ? fx : i === 1 ? -fx : i === 2 ? -fy : fy;
    const ay = i === 0 ? fy : i === 1 ? -fy : i === 2 ? fx : -fx;
    ent.posX[f] = ent.posX[id];
    ent.posY[f] = ent.posY[id];
    ent.height[f] = ent.height[id];
    ent.velX[f] = vx + ax * MORTAR_FRAGMENT_SPREAD;
    ent.velY[f] = vy + ay * MORTAR_FRAGMENT_SPREAD;
    ent.timerB[f] = 0;
    ent.yaw[f] = ent.yaw[id];
    ent.hp[f] = 1;
    ent.mode[f] = ent.mode[id];
    ent.ownerId[f] = ent.ownerId[id];
    ent.ammoA[f] = ent.ammoA[id];
    ent.aux[f] = ent.aux[id];
    ent.ammoB[f] = ROUND_ARC;
    ent.timerA[f] = ent.timerA[id];
    ent.cooldownC[f] = -1;
    ent.aimX[f] = ent.aimX[id];
  }
  despawn(ent, id);
}

/**
 * A round goes off. With a blast it area-damages where it is (the original's
 * linear falloff; the Warden's bomb keeps Metropolis' flat one); without one it
 * damages only the body it struck.
 */
function explode(state: SimState, id: number, struck = -1): void {
  const ent = state.ent;
  const kind = ent.mode[id];
  const damage = ent.ammoA[id];
  const radius = ent.aux[id];
  const flat = (ent.ammoB[id] & ROUND_FLAT_BLAST) !== 0;
  const x = ent.posX[id];
  const y = ent.posY[id];
  const team = ent.team[id];
  const owner = ent.ownerId[id];
  // Despawn first so the blast loop never re-hits the shell itself.
  despawn(ent, id);
  if (radius > 0) {
    blastAt(state, x, y, team, owner, damage, radius, kind, flat ? BLAST_FLAT : BLAST_EMIT);
  } else {
    pushEvent(state.events, EV_EXPLOSION, Math.floor(x * 16), Math.floor(y * 16), kind);
    if (struck >= 0) applyDamage(state, struck, damage, owner);
  }
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
    // Earn table (rules.md §3, fcop-fidelity.md R4-R7): a death pays the OTHER
    // side whoever caused it, because the original pays from the dying actor's
    // own death script, not from the kill credit. Neutral turrets (dummies,
    // uncaptured pads) and consoles pay nothing. A player's avatar pays at its
    // respawn (systemSpawning); the Warden, like the Sky Captain, when it falls.
    const team = ent.team[id];
    if (team === 0 || team === 1) {
      const other = team ^ 1;
      if (archetype === ARCHETYPE.WARDEN) avatarDown(state, team);
      else if (archetype === ARCHETYPE.TURRET) {
        state.points[other] += POINTS_TURRET_DIES;
        // A captured neutral turret destroyed is an engine credit (turret.c).
        if (ent.mode[id] === TURRET_CAPTURABLE) captainCredit(state, other);
      } else if (archetype === ARCHETYPE.RUNNER || archetype === ARCHETYPE.GUARDIAN)
        state.points[other] += POINTS_UNIT_DIES;
      else if (archetype === ARCHETYPE.JUGGERNAUT || archetype === ARCHETYPE.FORTRESS)
        state.points[other] += POINTS_HEAVY_DIES;
    }
    if (archetype === ARCHETYPE.AVATAR || archetype === ARCHETYPE.WARDEN) {
      const player = ent.ownerId[id];
      state.avatarId[player] = -1;
      state.respawnTimer[player] =
        archetype === ARCHETYPE.WARDEN
          ? skyRespawnTicks(wardenLevel(state.wardenDifficulty))
          : RESPAWN_TICKS;
      // Power-ups are lost when the avatar goes down (`player_respawn` clears the
      // block-B ammunition; fcop-fidelity.md P2, P8). The cloak and invulnerability
      // timers are NOT cleared: the original keeps counting them down while the
      // mech is down (fcop-re/player-and-weapons.md §1).
      for (let k = 0; k < 3; k++) state.powerAmmo[player * 3 + k] = 0;
      state.lockTarget[player] = -1; // death drops any lock
      state.lockSteer[player] = 0;
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
            state.baseTurretRespawn[k] = ringRespawnTicks(
              state.map,
              baseTurretSpot(state.map, k).team,
            );
            // "Base turret lost" (fcop-fidelity.md R15, voice ids 0/1).
            pushEvent(state.events, EV_TURRET_LOST, id, ent.team[id], k);
            slotted = true;
            break;
          }
        }
      }
      if (!slotted) {
        // An outpost plate's team turret: back for its owner in 25 s, every time.
        for (let j = 0; j < state.plateTurretEntity.length; j++) {
          if (state.plateTurretEntity[j] === id) {
            state.plateTurretEntity[j] = -1;
            state.plateTurretRespawn[j] = OUTPOST_TURRET_RESPAWN_TICKS;
            slotted = true;
            break;
          }
        }
      }
      if (!slotted) {
        // Capturable turret: husk now, back as NEUTRAL in 25 s (rules.md §5)
        // regardless of who owned it when it died — unless an outpost claim shut
        // its spawner (-1), which keeps it gone.
        for (let k = 0; k < state.neutralTurretEntity.length; k++) {
          if (state.neutralTurretEntity[k] === id) {
            state.neutralTurretEntity[k] = -1;
            if (state.neutralTurretRespawn[k] >= 0) {
              state.neutralTurretRespawn[k] = NEUTRAL_TURRET_RESPAWN_TICKS;
            }
            break;
          }
        }
      }
    }
    despawn(ent, id);
  }
}

/**
 * An avatar went down (fcop-fidelity.md R4): the other side gains
 * POINTS_AVATAR_DOWN and `team` loses as many, never below 0.
 */
function avatarDown(state: SimState, team: number): void {
  state.points[team ^ 1] += POINTS_AVATAR_DOWN;
  // The player's kill credit zeroes the captain's rethink (0x004477ea).
  captainCredit(state, team ^ 1);
  const left = state.points[team];
  state.points[team] = left > POINTS_AVATAR_DOWN ? left - POINTS_AVATAR_DOWN : 0;
}

/**
 * Respawns avatars, sandbox dummies, ring, neutral and outpost plate turrets
 * when their timers elapse.
 */
function systemSpawning(state: SimState): void {
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if (state.respawnTimer[p] > 0) {
      state.respawnTimer[p] -= 1;
      if (state.respawnTimer[p] === 0) {
        // A player's going-down is paid by its own script when it respawns
        // (`player_respawn` runs pool@136, fcop-re/ai-and-rules.md §1.8). The
        // Warden paid when it fell.
        if (p !== state.wardenPlayer) avatarDown(state, p);
        const id = spawnAvatar(state, p);
        if (p === state.wardenPlayer) captainRespawn(state);
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
  for (let k = 0; k < state.neutralTurretRespawn.length; k++) {
    if (state.neutralTurretRespawn[k] > 0) {
      state.neutralTurretRespawn[k] -= 1;
      if (state.neutralTurretRespawn[k] === 0) {
        const id = spawnNeutralTurret(state, k);
        if (id >= 0) pushEvent(state.events, EV_RESPAWN, id, -1, 0);
      }
    }
  }
  for (let j = 0; j < state.plateTurretRespawn.length; j++) {
    if (state.plateTurretRespawn[j] > 0) {
      state.plateTurretRespawn[j] -= 1;
      if (state.plateTurretRespawn[j] === 0) {
        const id = spawnPlateTurret(state, j);
        if (id >= 0) pushEvent(state.events, EV_RESPAWN, id, -1, 0);
      }
    }
  }
}

/**
 * Capture range of the arena's turret spots, in metres, before the capturer's own
 * radius: the imported original value, or the original's 4.0 m
 * (ORIGINAL_CAPTURE_RANGE, map.ts) where none is imported.
 */
export function captureRange(map: MapData): number {
  return map.captureRange;
}

/** Is entity `id` inside `reach` of turret `tid`? `flat` skips the height term. */
function withinCapture(ent: EntityStore, id: number, tid: number, reach: number, flat: boolean) {
  const dx = ent.posX[id] - ent.posX[tid];
  const dy = ent.posY[id] - ent.posY[tid];
  const dh = flat ? 0 : ent.height[id] - ent.height[tid];
  return dx * dx + dy * dy + dh * dh < reach * reach;
}

/**
 * Neutral turret capture (rules.md §5, fcop-fidelity.md R12), the original's
 * `turret_op10` (fcop-re/ranges-turrets-capture.md Q2). INSTANT: no timer and no
 * contest. A neutral turret flips to the first candidate inside the arena's
 * capture range plus the candidate's own ARCHETYPE_RADIUS:
 *  - an avatar, only on the tick its action key goes down (capturePress), in 3D;
 *  - the Warden (the Sky Captain's type 0x25), by flat proximity, no button;
 *  - a Runner (tank), by proximity in 3D, no button.
 * Guardians, Juggernauts and Fortresses never capture. A captured turret stays
 * captured until it is destroyed; it then comes back neutral after
 * NEUTRAL_TURRET_RESPAWN_TICKS (systemDamageDeath / systemSpawning).
 *
 * Candidates are tried in a fixed order — avatars by player slot, then the
 * Warden, then Runners by entity id — so every peer picks the same capturer.
 */
function systemCapture(state: SimState): void {
  const ent = state.ent;
  const spots = state.map.turretSpots;
  const range = captureRange(state.map);
  for (let k = 0; k < spots.length; k++) {
    const tid = state.neutralTurretEntity[k];
    if (tid < 0 || ent.ownerId[tid] >= 0) continue;
    let team = -1;
    for (let p = 0; p < MAX_PLAYERS && team < 0; p++) {
      const a = state.avatarId[p];
      if (a < 0) continue;
      if (p === state.wardenPlayer) {
        if (withinCapture(ent, a, tid, range + ARCHETYPE_RADIUS[ARCHETYPE.WARDEN], true)) team = p;
      } else if (state.capturePress[p] === 1) {
        if (withinCapture(ent, a, tid, range + ARCHETYPE_RADIUS[ARCHETYPE.AVATAR], false)) team = p;
      }
    }
    if (team < 0) {
      const reach = range + ARCHETYPE_RADIUS[ARCHETYPE.RUNNER];
      for (let id = 0; id < ent.high; id++) {
        if (!ent.alive[id] || ent.archetype[id] !== ARCHETYPE.RUNNER) continue;
        const t = ent.team[id];
        if ((t === 0 || t === 1) && withinCapture(ent, id, tid, reach, false)) {
          team = t;
          break;
        }
      }
    }
    if (team < 0) continue;
    ent.team[tid] = team;
    ent.ownerId[tid] = team;
    state.points[team] += POINTS_CAPTURE_TURRET;
    captainCredit(state, team); // an engine credit: the captain rethinks at once
    pushEvent(state.events, EV_CAPTURE, tid, team, k);
  }
  for (let p = 0; p < MAX_PLAYERS; p++) state.capturePress[p] = 0;
}

/**
 * Economy bookkeeping (rules.md §3). There is no trickle: the original adds no
 * points over time (fcop-fidelity.md R3), so income is entirely the event table
 * in systemDamageDeath / systemCapture. What runs here is the heavy-unit unlock
 * (R10): the first time a side holds HEAVY_UNLOCK_POINTS, its Juggernaut and
 * Fortress purchases open for the rest of the match. Checked at the end of the
 * tick, after every credit, so a side that reaches 50 can buy from the next tick.
 */
function systemEconomy(state: SimState): void {
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if (state.points[p] >= HEAVY_UNLOCK_POINTS) state.heavyUnlocked[p] = 1;
  }
}

/**
 * Win check (rules.md §1, and the original's Precinct Assault rule): an enemy
 * GROUND unit — Runner (tank) or Juggernaut (Dreadnought) — physically inside a
 * gate volume decides the match. Jets and avatars never do. Lowest entity id
 * wins a same-tick tie deterministically.
 *
 * The breach does not end the match on the spot. Like the original's 1750-tick
 * phase countdown (fcop-re/ai-and-rules.md §5) it starts a MATCH_OUTRO_TICKS
 * outro: EV_BREACH fires now, play continues, and `winner` is set — freezing the
 * sim — when the outro runs out. The first breach decides; later ones during the
 * outro change nothing.
 */
function systemWinCheck(state: SimState): void {
  if (state.outroTimer > 0) {
    state.outroTimer -= 1;
    if (state.outroTimer === 0) state.winner = state.outroWinner;
    return;
  }
  const ent = state.ent;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || !isGroundUnit(ent.archetype[id])) continue;
    const team = ent.team[id];
    if (team !== 0 && team !== 1) continue;
    const gate = state.map.bases[team ^ 1].gate;
    if (insideGate(gate, ent.posX[id], ent.posY[id], ARCHETYPE_RADIUS[ent.archetype[id]])) {
      state.outroWinner = team;
      state.outroTimer = MATCH_OUTRO_TICKS;
      pushEvent(state.events, EV_BREACH, id, team, 0);
      return;
    }
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
      // An ammo pickup fills that slot's A magazine to its ceiling
      // (`cact_type99_ammo_add(slot, -1)`; fcop-re/player-and-weapons.md §6).
      if (kind === PICKUP_GUN_AMMO) {
        state.gunAmmo[p] = weaponInSlot(0, state.loadoutGun[p]).a.ammoCap;
      } else if (kind === PICKUP_HEAVY_AMMO) {
        ent.ammoA[a] = weaponInSlot(1, state.loadoutHeavy[p]).a.ammoCap;
      } else if (kind === PICKUP_SPECIAL_AMMO) {
        ent.ammoB[a] = weaponInSlot(2, state.loadoutSpecial[p]).a.ammoCap;
      } else if (kind === PICKUP_HEALTH) {
        // Full heal: the grant passes amount -1, "fill" (fcop-fidelity.md P6) —
        // to the taker's own maximum (it set the Warden to the X1-Alpha's).
        if (p === state.wardenPlayer) captainRestore(state, a);
        else ent.hp[a] = AVATAR_HP;
      } else if (kind === PICKUP_INVULN) state.buffInvuln[p] = PICKUP_INVULN_TICKS;
      else if (kind === PICKUP_INVIS) state.buffInvis[p] = PICKUP_INVIS_TICKS;
      else if (kind === PICKUP_POWER_GUN) powerUp(state, p, 0);
      else if (kind === PICKUP_POWER_HEAVY) powerUp(state, p, 1);
      else if (kind === PICKUP_POWER_SPECIAL) powerUp(state, p, 2);
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
 * Base alerts (rules.md §9, fcop-fidelity.md R15). Counts the "turret under
 * fire" cooldowns down, then runs base-intrusion detection (fcop-logic.md §8.6):
 * an alarm fires when an enemy avatar or an enemy ground unit (tank or
 * Dreadnought — the original's zone triggers watch those, not its jets) enters
 * a base's volume, and then that BASE stays quiet for TRIGGER_REARM_TICKS, the
 * original's 8.3 s voice cooldown (fcop-re/ai-and-rules.md §6). The client
 * speaks it (voice ids 2/3). Cooldowns live here rather than in the client so
 * every peer and every replay agrees on when the alarm sounded.
 */
function systemTriggers(state: SimState): void {
  for (let p = 0; p < state.turretAlert.length; p++) {
    if (state.turretAlert[p] > 0) state.turretAlert[p] -= 1;
  }
  const volumes = state.map.triggerVolumes;
  if (volumes.length === 0) return;
  const ent = state.ent;
  for (let v = 0; v < volumes.length; v++) {
    if (state.triggerArm[v] > 0) state.triggerArm[v] -= 1;
  }
  for (let v = 0; v < volumes.length; v++) {
    if (state.triggerArm[v] > 0) continue;
    const vol = volumes[v];
    const foe = vol.team ^ 1;
    let intruder = -1;
    if ((vol.watch & TRIGGER_WATCH_ENEMY_AVATAR) !== 0) {
      const a = state.avatarId[foe];
      if (a >= 0 && insideVolume(ent, a, vol)) intruder = a;
    }
    if (intruder < 0 && (vol.watch & TRIGGER_WATCH_ENEMY_UNITS) !== 0) {
      for (let id = 0; id < ent.high; id++) {
        if (!ent.alive[id] || ent.team[id] !== foe || !isGroundUnit(ent.archetype[id])) continue;
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
    // One alert per base per cooldown: every volume guarding this base re-arms.
    for (let u = 0; u < volumes.length; u++) {
      if (volumes[u].team === vol.team) state.triggerArm[u] = TRIGGER_REARM_TICKS;
    }
    pushEvent(state.events, EV_ALARM, Math.round(vol.x * 16), Math.round(vol.y * 16), vol.team);
  }
}

/**
 * Axis-aligned containment test for an intrusion volume, grown by the intruder's
 * own hit radius — the original's test is `|centre - pos| - halfExtent - radius < 0`
 * (fcop-re/ranges-turrets-capture.md Q1, retail 0x00420150..0x0042017f).
 */
function insideVolume(ent: EntityStore, id: number, vol: MapTriggerVolume): boolean {
  const dx = ent.posX[id] - vol.x;
  const dy = ent.posY[id] - vol.y;
  const r = ARCHETYPE_RADIUS[ent.archetype[id]];
  const hw = vol.halfW + r;
  const hl = vol.halfL + r;
  return dx <= hw && dx >= -hw && dy <= hl && dy >= -hl;
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
    // positions.
    systemPickups(state);
    systemTriggers(state);
    systemEconomy(state);
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
  // The outro is hashed only while it runs: a match that never breaches — and
  // every tick before a breach — hashes exactly as it did before it existed.
  if (state.outroTimer > 0) {
    h = fnv1aU32(h, state.outroTimer >>> 0);
    h = fnv1aU32(h, state.outroWinner >>> 0);
  }
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
    h = fnv1aU32(h, state.heavyUnlocked[p]);
    h = fnv1aU32(h, state.laneCounter[p]);
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
  }
  for (let k = 0; k < state.outpostOwner.length; k++) {
    h = fnv1aU32(h, state.outpostOwner[k] >>> 0);
    h = fnv1aU32(h, state.outpostConsole[k] >>> 0);
  }
  // Outpost plates: zero-length (nothing hashed) on an arena without them.
  for (let j = 0; j < state.plateTurretEntity.length; j++) {
    h = fnv1aU32(h, state.plateTurretEntity[j] >>> 0);
    h = fnv1aU32(h, state.plateTurretRespawn[j] >>> 0);
  }
  // Precinct Assault state, APPENDED after everything above and each block
  // guarded by its own feature list. On an arena without PA data every loop here
  // runs zero times and every `if` is false, so the byte stream — and therefore
  // the hash — is bit-identical to before v13. That is the whole argument for
  // why the existing goldens keep their hash sequences.
  for (let k = 0; k < state.pickupCooldown.length; k++) {
    h = fnv1aU32(h, state.pickupCooldown[k] >>> 0);
  }
  for (let p = 0; p < state.buffInvuln.length; p++) {
    h = fnv1aU32(h, state.buffInvuln[p] >>> 0);
    h = fnv1aU32(h, state.buffInvis[p] >>> 0);
  }
  for (let k = 0; k < state.triggerArm.length; k++) {
    h = fnv1aU32(h, state.triggerArm[k] >>> 0);
  }
  // Appended at SIM_VERSION 36; empty (and so absent) on a map without ring
  // turrets.
  for (let p = 0; p < state.turretAlert.length; p++) {
    h = fnv1aU32(h, state.turretAlert[p] >>> 0);
  }
  // Appended at SIM_VERSION 39: the X1-Alpha's movement state, every map.
  for (let p = 0; p < MAX_PLAYERS; p++) {
    // The rate moves in steps of 12.5 units, so twice it is an exact integer.
    h = fnv1aU32(h, (state.avatarTurnRate[p] * 2) >>> 0);
    h = fnv1aU32(h, state.avatarIdle[p] >>> 0);
    h = fnv1aU32(h, state.avatarLunge[p] >>> 0);
  }
  // Appended at SIM_VERSION 40: which locks steer the hull (fcop-fidelity.md W2).
  for (let p = 0; p < MAX_PLAYERS; p++) h = fnv1aU32(h, state.lockSteer[p]);
  // Appended at SIM_VERSION 43: the block-B magazines (replacing the x2 timer).
  for (let k = 0; k < state.powerAmmo.length; k++) h = fnv1aU32(h, state.powerAmmo[k]);
  // Appended at SIM_VERSION 41: the Gun magazine and the burst counters.
  for (let p = 0; p < MAX_PLAYERS; p++) h = fnv1aU32(h, state.gunAmmo[p]);
  for (let k = 0; k < state.burstLeft.length; k++) h = fnv1aU32(h, state.burstLeft[k]);
  // Weapon profiles: every map carries them since SIM_VERSION 52 (the original's
  // where it imports none).
  for (let id = 0; id < ent.high; id++) {
    if (ent.alive[id]) h = fnv1aU32(h, ent.weaponProfile[id] >>> 0);
  }
  // Warden decision state is hashed only when a Warden exists: matches
  // without one keep their exact pre-Phase-4 hash sequences (goldens 1–3
  // stay valid). The flag itself is match config, identical on every peer.
  if (state.wardenPlayer >= 0) {
    h = fnv1aU32(h, state.wardenPlayer >>> 0);
    h = fnv1aU32(h, state.wardenDifficulty >>> 0);
    const c = state.captain;
    h = fnv1aU32(h, c.mode >>> 0);
    h = fnv1aU32(h, c.think >>> 0);
    h = fnv1aU32(h, c.aim >>> 0);
    h = fnv1aU32(h, c.move >>> 0);
    h = fnv1aU32(h, c.fly >>> 0);
    h = fnv1aF32(h, c.destX);
    h = fnv1aF32(h, c.destY);
    h = fnv1aU32(h, c.threshold >>> 0);
    h = fnv1aF32(h, c.speed);
    h = fnv1aU32(h, c.order >>> 0);
    h = fnv1aU32(h, c.search >>> 0);
    for (let k = 0; k < 3; k++) {
      h = fnv1aF32(h, c.gunClock[k]);
      h = fnv1aU32(h, c.gunPhase[k]);
    }
    for (let k = 0; k < c.queue.length; k++) {
      h = fnv1aU32(h, c.queue[k] >>> 0);
      h = fnv1aU32(h, c.queueTimer[k] >>> 0);
    }
  }
  return h;
}

/**
 * Match-state snapshot (architecture.md §3).
 *
 * The entity snapshot below is per-entity, so the scalars a player-facing HUD
 * needs — score, who owns what, how long until I respawn — have no home in it.
 * This is that home, and it exists so the HUD can obey renderer rule 4 instead
 * of reaching into sim internals the way the old debug HUD did.
 *
 * Like writeSnapshot it is a pure read into a caller-owned buffer: it never
 * mutates state and is invisible to hashState, so adding a field here cannot
 * move a golden hash. Adding a field to SimState still can.
 */
export const MATCH_SNAPSHOT_HEADER = 6;
/** Per-slot block length; MAX_PLAYERS blocks follow the header. */
export const MATCH_SNAPSHOT_SLOT_STRIDE = 12;
export const MATCH_SNAPSHOT_LEN = MATCH_SNAPSHOT_HEADER + MAX_PLAYERS * MATCH_SNAPSHOT_SLOT_STRIDE;

/** Header fields. */
export const MATCH_TICK = 0;
export const MATCH_WINNER = 1;
export const MATCH_ENTITY_COUNT = 2;
export const MATCH_WARDEN_DIFFICULTY = 3;
/** Ticks left of the post-breach outro, 0 when none is running (systemWinCheck). */
export const MATCH_OUTRO_LEFT = 4;
/** Team whose breach started the running outro, -1 when none is running. */
export const MATCH_OUTRO_WINNER = 5;

/** Offsets within a slot block. */
export const MATCH_SLOT_POINTS = 0;
export const MATCH_SLOT_AVATAR_ID = 1;
export const MATCH_SLOT_HP_FRAC = 2;
export const MATCH_SLOT_AMMO_HEAVY = 3;
export const MATCH_SLOT_AMMO_SPECIAL = 4;
export const MATCH_SLOT_RESPAWN_TICKS = 5;
export const MATCH_SLOT_OUTPOSTS = 6;
/** Units alive for this slot (RUNNER..FORTRESS), for the readout column. */
export const MATCH_SLOT_UNITS = 7;
/** The Gun slot's magazine (finite since SIM_VERSION 41: the original's records). */
export const MATCH_SLOT_AMMO_GUN = 8;
/** The X1-Alpha's lock: the locked entity id, -1 for none (fcop-fidelity.md W2). */
export const MATCH_SLOT_LOCK = 9;
/**
 * Powered slots, a bit each (1 gun, 2 heavy, 4 special): the slot fires its block
 * B, and its ammo field above counts the block-B magazine (fcop-fidelity.md P8).
 */
export const MATCH_SLOT_POWER = 10;
/** The avatar's movement command this tick: MOVE_CUE_* bits (SimState.moveCue). */
export const MATCH_SLOT_MOVE = 11;
// Slot field 9 was MATCH_SLOT_CAPTURE_FRAC, retired with the 3 s capture timer
// (SIM_VERSION 34): the original captures instantly on a key press. Slot field 10
// was MATCH_SLOT_CORE_FRAC, retired with the destructible core (SIM_VERSION 32).
// Slot field 8 was MATCH_SLOT_BUY_FRAC, the hold-to-buy progress, retired with the
// hold (SIM_VERSION 51): the original sells one unit per key press, so there is
// nothing to fill; the fields after it moved down one.

/** Byte offset of slot `s`'s block. */
export function matchSlotOffset(slot: number): number {
  return MATCH_SNAPSHOT_HEADER + slot * MATCH_SNAPSHOT_SLOT_STRIDE;
}

/**
 * Writes per-match scalars into `out` (length MATCH_SNAPSHOT_LEN).
 * Pure read; the renderer consumes ONLY this and writeSnapshot.
 */
export function writeMatchSnapshot(state: SimState, out: Float32Array): void {
  const ent = state.ent;
  out[MATCH_TICK] = state.tick;
  out[MATCH_WINNER] = state.winner;
  out[MATCH_WARDEN_DIFFICULTY] = state.wardenDifficulty;
  out[MATCH_OUTRO_LEFT] = state.outroTimer;
  out[MATCH_OUTRO_WINNER] = state.outroTimer > 0 ? state.outroWinner : -1;

  let live = 0;
  for (let slot = 0; slot < MAX_PLAYERS; slot++) {
    const o = matchSlotOffset(slot);
    const a = state.avatarId[slot];
    out[o + MATCH_SLOT_POINTS] = state.points[slot];
    out[o + MATCH_SLOT_AVATAR_ID] = a;
    const maxHp = slot === state.wardenPlayer ? captainMaxHp(state) : AVATAR_HP;
    out[o + MATCH_SLOT_HP_FRAC] = a >= 0 ? ent.hp[a] / maxHp : 0;
    // The magazine each slot fires from: block B while powered, else block A.
    const pk = slot * 3;
    out[o + MATCH_SLOT_AMMO_HEAVY] =
      a >= 0 ? (state.powerAmmo[pk + 1] > 0 ? state.powerAmmo[pk + 1] : ent.ammoA[a]) : 0;
    out[o + MATCH_SLOT_AMMO_SPECIAL] =
      a >= 0 ? (state.powerAmmo[pk + 2] > 0 ? state.powerAmmo[pk + 2] : ent.ammoB[a]) : 0;
    out[o + MATCH_SLOT_RESPAWN_TICKS] = a >= 0 ? 0 : state.respawnTimer[slot];
    out[o + MATCH_SLOT_OUTPOSTS] = 0;
    out[o + MATCH_SLOT_UNITS] = 0;
    out[o + MATCH_SLOT_AMMO_GUN] =
      a >= 0 ? (state.powerAmmo[pk] > 0 ? state.powerAmmo[pk] : state.gunAmmo[slot]) : 0;
    out[o + MATCH_SLOT_POWER] =
      a >= 0
        ? (state.powerAmmo[pk] > 0 ? 1 : 0) |
          (state.powerAmmo[pk + 1] > 0 ? 2 : 0) |
          (state.powerAmmo[pk + 2] > 0 ? 4 : 0)
        : 0;
    out[o + MATCH_SLOT_LOCK] = a >= 0 ? state.lockTarget[slot] : -1;
    out[o + MATCH_SLOT_MOVE] = a >= 0 ? state.moveCue[slot] : 0;
  }
  for (let k = 0; k < state.outpostOwner.length; k++) {
    const owner = state.outpostOwner[k];
    if (owner >= 0 && owner < MAX_PLAYERS) {
      out[matchSlotOffset(owner) + MATCH_SLOT_OUTPOSTS] += 1;
    }
  }
  // Dense id order, like every other sim iteration (CLAUDE.md hard rule 5).
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id]) continue;
    live += 1;
    const arch = ent.archetype[id];
    const team = ent.team[id];
    if (arch >= ARCHETYPE.RUNNER && arch <= ARCHETYPE.FORTRESS && team >= 0 && team < MAX_PLAYERS) {
      out[matchSlotOffset(team) + MATCH_SLOT_UNITS] += 1;
    }
  }
  out[MATCH_ENTITY_COUNT] = live;
}

/**
 * The health an entity spawned with: a PA arena's units take their record's
 * (spawnUnit), everything else its archetype's. Renderer-facing only.
 */
function maxHpOf(state: SimState, id: number): number {
  const ent = state.ent;
  const arch = ent.archetype[id];
  const team = ent.team[id];
  if (team === 0 || team === 1) {
    const base = state.map.bases[team];
    const p =
      arch === ARCHETYPE.RUNNER
        ? base.runner
        : arch === ARCHETYPE.GUARDIAN
          ? base.guardian
          : arch === ARCHETYPE.FORTRESS
            ? base.fortress
            : arch === ARCHETYPE.JUGGERNAUT
              ? base.juggernaut
              : undefined;
    if (p !== undefined) return p.hp;
  }
  return ARCHETYPE_MAX_HP[arch];
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
    out[o + 8] = ent.hp[id] / maxHpOf(state, id);
    // PROJECTILE: payload kind. TURRET: DEFENSE / DUMMY / CAPTURABLE so the
    // renderer can pick Defense vs Standard meshes. Everything else: aux.
    out[o + 9] =
      ent.archetype[id] === ARCHETYPE.PROJECTILE || ent.archetype[id] === ARCHETYPE.TURRET
        ? ent.mode[id]
        : ent.aux[id];
    n += 1;
  }
  return n;
}
