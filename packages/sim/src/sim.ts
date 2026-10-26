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
  AVATAR_HP_BY_DIFFICULTY,
  AVATAR_LOCK_ACQUIRE_COS,
  AVATAR_LOCK_HOLD_COS,
  AVATAR_LOCK_RANGE,
  AVATAR_WALKER_MAX_SLOPE,
  BASE_TURRET_RESPAWN_TICKS,
  CFUN_DELTA_PER_TICK,
  CLOAK_DISARM_RADIUS,
  COST_FORTRESS,
  COST_GUARDIAN,
  COST_JUGGERNAUT,
  COST_OUTPOST_CLAIM,
  COST_RUNNER,
  DIFFICULTY_HARD,
  DIFFICULTY_NORMAL,
  DIFFICULTY_ROWS,
  DREADNOUGHT_GUNS,
  DROWN_DEPTH,
  DUMMY_RESPAWN_TICKS,
  FLAME_PULSE_TICKS,
  FLOOR_DAMAGE_PER_STEP,
  FORTRESS_ALIVE_LIMIT,
  FRAME_CLOCK_PER_TICK,
  GRENADE_BOUNCE_HORIZONTAL,
  GRENADE_BOUNCE_VERTICAL,
  GRENADE_FUSE_JITTER_DIV,
  GRENADE_FUSE_JITTER_MASK,
  GRENADE_MOVE_SCALE,
  GRENADE_RADIUS,
  GRENADE_REST_SPEED,
  GRENADE_TIME_DIVISOR,
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
  HOVER_PROBE_LIFT,
  HOVER_PUSH_FORE,
  HOVER_PUSH_SLOW_FORE,
  HOVER_PUSH_SLOW_STRAFE,
  HOVER_PUSH_STRAFE,
  HOVER_SLOPE_GAIN,
  HOVER_SLOPE_KNEE,
  HOVER_SPEED_CAP,
  HOVER_STOP_SPEED,
  HOVER_TURN_LIMIT,
  JUGGERNAUT_ALIVE_LIMIT,
  K9_AVOID_BIAS,
  K9_CLEARANCE,
  K9_CLEARANCE_LIFT,
  K9_CLEARANCE_RANGE,
  LIFT_RIM_SLACK,
  LIFT_STEP_UP,
  LOW_AMMO_WARNING,
  MATCH_OUTRO_TICKS,
  MAX_ENTITIES,
  MAX_PLAYERS,
  MINE_GRAVITY,
  MINE_RADIUS,
  MINE_SPRING_GRAVITY,
  MINE_SPRING_UNITS,
  MINE_SPRING_VELOCITY,
  MISSILE_ARRIVAL_WU,
  MISSILE_FUSE_RENEW,
  MISSILE_FUSE_UNITS,
  MISSILE_MIN_SPEED,
  MISSILE_ROUND_HEALTH,
  MISSILE_TURN_RATE,
  MORTAR_FRAGMENT_SPREAD,
  MUZZLE_HEIGHT,
  MUZZLE_OFFSET,
  NEUTRAL_TURRET_RADIUS,
  NEUTRAL_TURRET_RESPAWN_TICKS,
  ORIGINAL_JET_QUEUE_PERIOD,
  ORIGINAL_TANK_QUEUE_PERIOD,
  OUTPOST_COST_MULTIPLIER,
  OUTPOST_TURRET_RESPAWN_TICKS,
  PAIR_CELL,
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
  PICKUP_SPECIAL_AMMO,
  POINTS_AVATAR_DOWN,
  POINTS_CAPTURE_TURRET,
  POINTS_HEAVY_DIES,
  POINTS_TURRET_DIES,
  POINTS_UNIT_DIES,
  RAW_PER_METRE,
  RESPAWN_SUNK_TICKS,
  RESPAWN_TICKS,
  RUNNER_ALIVE_LIMIT,
  retentionPerTick,
  SHIELD_ARC_WAIT_BASE,
  SHIELD_ARC_WAIT_MASK,
  SHIELD_ARCS,
  SHIELD_CENTRE_RAISE,
  SHIELD_FLASH_DRAWS,
  SHIELD_HOLD_UNITS,
  SHIELD_RECOIL_A,
  SHIELD_RECOIL_B,
  SHIELD_ROUND_DAMAGE_A,
  SHIELD_ROUND_DAMAGE_B,
  SHOOTER_RETRY_UNITS,
  SKY_BOMB_BLAST,
  SKY_BOMB_DAMAGE,
  SKY_MISSILE_DAMAGE,
  SKY_MISSILE_FLIGHT,
  SKY_PICKUP_TOUCH_WU,
  STARTING_POINTS,
  SURFACE_REACH,
  skyRespawnTicks,
  TICK_DT,
  TICK_HZ,
  TRANSFORM_LOCK_TICKS,
  TRIGGER_REARM_TICKS,
  TRIGGER_WATCH_ENEMY_AVATAR,
  TRIGGER_WATCH_ENEMY_UNITS,
  TRIGGER_WATCH_OWN_AVATAR,
  TURRET_ALERT_COOLDOWN_TICKS,
  UNIT_QUEUES,
  WALKER_AIR_DRAG,
  WALKER_DRAG,
  WALKER_LEDGE_DROP,
  WALKER_MODE_DRAG,
  WALKER_MODE_OF_CODE,
  WALKER_MODE_PUSH,
  WALKER_MODE_STOP,
  WALKER_PROBE_AHEAD,
  WALKER_PROBE_LIFT,
  WALKER_SINK_PER_TICK,
  WALKER_SLOPE_GAIN,
  WALKER_SLOPE_KNEE,
  WALKER_STEEP_TILT,
  WALKER_STOP_SPEED,
  WARDEN_ALTITUDE,
  WARDEN_HEAVY_SPEED,
  WARDEN_HEAVY_TTL_TICKS,
  WEAPON_UNITS_PER_TICK,
  type WeaponRecord,
  WU_PER_METRE,
  wardenLevel,
  X1_DIAGONAL_SCALE,
  X1_GRAVITY,
  X1_IMPACT_HP,
  X1_IMPACT_SCALE,
  X1_IMPACT_SPEED,
  X1_IMPACT_SPEED_MAX,
  X1_STEP_SPEED,
  X1_STEPS_PER_TICK,
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
  EV_KILL_PUSH,
  EV_LIFT_ARRIVE,
  EV_LIFT_START,
  EV_LOW_AMMO,
  EV_PICKUP,
  EV_PURCHASE,
  EV_PURCHASE_REFUSED,
  EV_RESPAWN,
  EV_ROUND_IMPACT,
  EV_SHIELD_ARC,
  EV_SHIELD_ARC_STEP,
  EV_SHOT,
  EV_SUNK,
  EV_TRANSFORM,
  EV_TRANSFORM_REFUSED,
  EV_TURRET_LOST,
  EV_TURRET_UNDER_FIRE,
  type EventBuffer,
  packArcAngles,
  packDirection,
  pushEvent,
  reachToShotPayload,
  roundSource,
  SHOT_SLOT_HITSCAN,
  SHOT_SLOT_LAUNCH,
  SKY_WEAPON_MISSILE,
  weaponShotPayload,
} from "./events";
import { fnv1aBytes, fnv1aF32, fnv1aInit, fnv1aU32 } from "./hash";
import {
  BTN_ACTION,
  BTN_BACK,
  BTN_CHANGE_TARGET,
  BTN_FORWARD,
  BTN_GUN,
  BTN_HEAVY,
  BTN_JINK_LEFT,
  BTN_JINK_RIGHT,
  BTN_JUMP,
  BTN_SPECIAL,
  BTN_TURN_LEFT,
  BTN_TURN_RIGHT,
  JINKS,
  SIM_BUTTONS,
  type TickInputs,
  TRANSFORM_CHORD,
  TRANSFORM_KEEPS,
} from "./inputs";
import {
  coarseHeightAt,
  insideGate,
  isWater,
  type MapBaseTurret,
  type MapBuyBox,
  type MapData,
  type MapGunMount,
  type MapPoint,
  type MapTriggerVolume,
  type MapWeapon,
  type MapZone,
  resolveHeight,
  sampleHeight,
  waterHeightAt,
  worldExtent,
} from "./map";
import {
  atan2Poly,
  cosLUT,
  cosUnits,
  octagonalLength,
  rand01,
  randU32,
  sinLUT,
  sinUnits,
} from "./simMath";
import {
  bumpStat,
  noteDown,
  outpostsHeld,
  STAT_HALVES,
  STAT_TURRETS_CLAIMED,
  STAT_TURRETS_DESTROYED,
  STAT_WALKER_KILLS,
  statClock,
  systemStats,
  unitStatKey,
} from "./stats";
import {
  aircraftEngaged,
  isAirUnit,
  isGroundUnit,
  isUnit,
  nearestEnemyFrom,
  nearestEnemyInRange,
  resolveWalker,
  snapUnitHeight,
  startAircraft,
  startRoute,
  surfaceBelow,
  systemUnitMovement,
  UNIT_MODE_OUTPOST,
  UNIT_MODE_PATROL,
  unitRange,
} from "./units";
import {
  type AnimPlayer,
  type AnmdTrack,
  animSetTrack,
  createAnimPlayer,
  createWalkerState,
  WALK_ARM,
  type WalkerState,
  walkerArm,
  walkerCommand,
  walkerEighths,
  walkerHover,
  walkerLand,
  walkerLegs,
  walkerProbes,
  walkerRamp,
  walkerReset,
  walkerShortTail,
} from "./walker";
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
  difficultyAmmo,
  EXTRA_WEAPON_RIOT_SHIELD,
  type Loadout,
  normalizeExtraWeapons,
  normalizeLoadout,
  PROJ_BEAM,
  PROJ_HEAVY,
  PROJ_HYPER,
  PROJ_K9,
  PROJ_MINE,
  PROJ_ROUND,
  PROJ_SPLASH,
  PROJ_TORPEDO,
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
// Visual mesh modes: DEFENSE → the arena's type-8 turret (gun + base, Mp Cobj 20/21),
// DUMMY/CAPTURABLE → its NeutralTurret (Mp 31/32) — client render/arenaUnits.ts.
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
  /**
   * Per-player difficulty, the original's HARD / NORMAL / EASY pick (balance.ts
   * DIFFICULTY_*), slot-indexed. A missing, fractional or out-of-range entry
   * degrades to the nearest row (NORMAL when missing or NaN); the Warden's slot
   * ignores it. Part of the replay header (format 4) and the online handshake.
   */
  difficulties?: readonly number[];
  /**
   * The "Spielregeln" switch for the original's five weapons Precinct Assault
   * never offers, a bit each (weapons.ts EXTRA_WEAPON_*: 0 Riot Shield, 1 K-9
   * Drone, 2 Grenade Launcher, 3 Fusion Torpedo, 4 Plasma Flare). 0 by default,
   * the original's PA: a loadout naming a weapon whose bit is clear is refused
   * (weapons.ts clampLoadoutIndex). Online the host sets it, solo the
   * preferences. Part of the replay header (format 5) and the online handshake.
   */
  extraWeapons?: number;
}

/** A difficulty value as the sim takes it: an integer row 0..2, NORMAL when unusable. */
export function normalizeDifficulty(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DIFFICULTY_NORMAL;
  const d = Math.floor(raw);
  if (d < 0) return 0;
  return d >= DIFFICULTY_ROWS ? DIFFICULTY_ROWS - 1 : d;
}

/** The X1-Alpha's maximum health for `player`'s difficulty (balance.ts AVATAR_HP_BY_DIFFICULTY). */
export function avatarMaxHp(state: SimState, player: number): number {
  return AVATAR_HP_BY_DIFFICULTY[state.difficulty[player]];
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
  /**
   * Previous tick's button word per player (u16, inputs.ts), as the latches saw
   * it — filtered while a transform runs — for the press and held edges.
   */
  readonly lastButtons: Uint16Array;
  /**
   * What each avatar was told to do this tick, as the original's movement code
   * reads its button word: MOVE_CUE_DRIVE (a fore/aft or strafe command),
   * MOVE_CUE_BRAKE (the hover's brake), MOVE_CUE_TURN (the hull turned). The
   * original picks the X1's movement sound from these, not from the velocity
   * (`player_hover_tick` 0x0044267f). Presentation only: rewritten every tick,
   * read by the match snapshot, and NOT hashed (like the events).
   */
  readonly moveCue: Uint8Array;
  /**
   * What fired each live world round (`roundSource`), by entity id, for its
   * EV_ROUND_IMPACT. Presentation only and NOT hashed: written when the round
   * spawns, read when it strikes.
   */
  readonly roundFrom: Uint8Array;
  /**
   * The killer's push a body's death carries (EV_KILL_PUSH), by entity id:
   * the striking round's packDirection and its damage (0 none). Presentation
   * only and NOT hashed: written at a missile-class round's killing contact,
   * read and cleared when the death is collected.
   */
  readonly killPushDir: Int32Array;
  readonly killPushDamage: Int32Array;
  /** Current Points per player: what a side spends (rules.md §3). */
  readonly points: Uint32Array;
  /**
   * 1 once a poll saw the side hold HEAVY_UNLOCK_POINTS: the Juggernaut/Fortress
   * zones open then and stay open (fcop-fidelity.md R10).
   */
  readonly heavyUnlocked: Uint8Array;
  /**
   * Each side's heavy-zone poll countdown in engine ticks (`cfun_tick`'s, R10):
   * drawn as `game_rand() % pollPeriod`, less CFUN_DELTA_PER_TICK a tick.
   */
  readonly heavyPoll: Int32Array;
  /**
   * 1 while the base's two heavy terminals stand: the run that opened its zones
   * requested them, and the spawner pass of the next tick builds them (the
   * original's `csac_tick` runs before `cfun_tick` in a frame). Presentation
   * only — a function of heavyUnlocked's history, nothing in the tick reads it —
   * read by the match snapshot (MATCH_SLOT_TERMINALS) and NOT hashed.
   */
  readonly heavyTerminals: Uint8Array;
  /**
   * The spawn queues (fcop-fidelity.md R18), UNIT_QUEUES per team at
   * `team * UNIT_QUEUES + q` (QUEUE_BASE_TANKS, QUEUE_BASE_JETS, then
   * QUEUE_OUTPOST + 2k tanks and + 2k + 1 jets): units bought or requested and
   * not yet spawned, and the engine ticks to each queue's next poll
   * (`cfun_tick`'s countdown, CFUN_DELTA_PER_TICK less a tick).
   */
  readonly unitQueue: Int32Array;
  readonly unitQueueTimer: Int32Array;
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
   * 1 for a player whose avatar pressed the Action Key (BTN_ACTION, rising
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
  /**
   * Each player's difficulty, DIFFICULTY_HARD / _NORMAL / _EASY (config, like the
   * loadouts; SimOptions.difficulties). The mech's health, its magazines and what
   * deep water does to the walker follow it. The Warden's slot holds NORMAL and
   * reads none of it.
   */
  readonly difficulty: Uint8Array;
  /**
   * HARD's sinking marker per player, the original's block +0xde: set when a HARD
   * walker's ground is water, held until it goes down and read by that down (the
   * 0.5 s respawn, no wreck, nobody credited), cleared at the respawn. While it
   * is set the mech sinks, its buttons are cut and the drowning check runs
   * (balance.ts WALKER_SINK_PER_TICK, DROWN_DEPTH; fcop-fidelity.md P13). Hashed
   * only in a match with a HARD player.
   */
  readonly avatarSinking: Uint8Array;
  /**
   * Per player: 1 when the last hit on its mech came from the rival's own craft
   * — the Sky Captain's gun, or the blast of a missile or bomb it fired; in a
   * match without one, the other X1-Alpha's weapons and their rounds' blasts —
   * 0 for anyone else's (tanks, jets and turrets included), for a round's
   * contact (its own serial, gone with it: SIM_VERSION 91) or nobody's. The original remembers the
   * actor whose hit took the mech below zero (+0x8c) and, at the down, credits
   * the captain (its tally, its rethink zeroed) or, with two viewports, the
   * other slot's Walker Kills, only when that actor, or the owner a round's id
   * carries, is the captain or the other mech (`player_op4`
   * 0x004477ab..0x00447821). The Sky Captain's slot holds the same for the hits
   * on the captain — 1 when the last was the X1's own craft — which its death
   * reads for the X1's Walker Kills (aircraft.c 0x00420e1c..0x00420e57).
   * Cleared at the respawn.
   */
  readonly rivalHit: Uint8Array;
  /**
   * The results page's twelve halfwords per side (stats.ts STAT_*, keys 0..11)
   * at `team * STAT_HALVES + key`: a player's view block +0x00, the Sky
   * Captain's `sky_ai` +0x28. Hashed (SIM_VERSION 76).
   */
  readonly statHalves: Uint16Array;
  /**
   * Points Scored per side, the original's state word 31 + slot: every point
   * earned, never spent or lost (fcop-re/ai-and-rules.md §2). Hashed.
   */
  readonly pointsScored: Uint32Array;
  /** First Death per side on the frame clock, 0 until the first down (stats.ts). Hashed. */
  readonly firstDeath: Uint32Array;
  /** First Outpost per side on the frame clock, 0 until the side holds one. Hashed. */
  readonly firstOutpost: Uint32Array;
  /**
   * Time as Walker / Time as Hovercraft per player on the frame clock, at
   * `player * 2 + form` (view block +0x28 / +0x2c): a live mech's ticks by its
   * form. The Sky Captain's stay 0. Hashed.
   */
  readonly formTime: Uint32Array;
  /**
   * The Dreadnought's four gun mounts per Juggernaut (fcop-fidelity.md I6;
   * `mount.c` 0x004258d0), at `id * DREADNOUGHT_GUNS + gun`: the gun's yaw
   * relative to its hull in angle units (4096 a turn, the entity yaw's sense, 0 =
   * the hull's forward), its own shooter's rate clock (engine units) and phase,
   * its target (id + 1, 0 none) and its re-search countdown. Outside the entity
   * store like weaponProfile; read and hashed for live Juggernauts only, reset at
   * their spawn.
   */
  readonly gunYaw: Int16Array;
  /**
   * The Dreadnought hull's walk per side (fcop-fidelity.md G8, I6; RE type5.c
   * 469-472): an AnmD block per entity id on the side's `juggernaut.walk` track,
   * null where the hull is static (every arena but bug-hunt). `cact_anim_init`
   * at the spawn, then a step a tick by the speed word times the frame delta;
   * the guns stand on the frame it shows. Read and hashed for live Juggernauts
   * only.
   */
  readonly hullWalk: readonly (AnimPlayer | null)[];
  readonly gunClock: Int32Array;
  readonly gunPhase: Uint8Array;
  readonly gunTarget: Int16Array;
  readonly gunSearch: Int32Array;
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
  /**
   * Hk's spawn guards (fcop-fidelity.md P11), per `map.spawnGuards` entry: the
   * box's latch (1 = it has hurt and waits for the reset) and the engine-tick
   * countdown to the mission's next reset poll. Length 0 on every other arena.
   */
  readonly guardLatch: Uint8Array;
  readonly guardTimer: Int32Array;
  /**
   * The lifts (fcop-fidelity.md P12), per `map.lifts` entry: the height above
   * the lift's ground in world units, the stop it is at or last left, the way
   * it goes next (+1 up, -1 down), its phase (LIFT_*) and the dwell left.
   * Length 0 on an arena without lifts.
   */
  readonly liftWu: Int32Array;
  readonly liftStop: Int8Array;
  readonly liftDir: Int8Array;
  readonly liftPhase: Uint8Array;
  readonly liftTimer: Int32Array;
  /**
   * Per player: the lift whose top the mech stands on this tick, -1 for none —
   * the original's carrier (`player_follow_carrier`). Set by the avatar's
   * movement; read by systemLifts (the rider's press, the carry) and
   * systemFloors (a tagged top).
   */
  readonly avatarLift: Int8Array;

  // --- X1-Alpha movement state, per player (fcop-fidelity.md P4/P5) ---------
  /**
   * The hover's turn-rate word (the original's block +0xc2), in engine angle
   * units: ramps toward +-HOVER_TURN_LIMIT while turning, 0 on a release.
   */
  readonly avatarTurnRate: Float32Array;
  /** The hover's idle timer (block +0xdc), engine units, capped at 0x800. */
  readonly avatarIdle: Int32Array;
  /**
   * The walker's state machine and its legs (walker.ts; fcop-fidelity.md G11,
   * P4): `state_bb`, `flags_b9`, `byte_ba`, the idle count, the lunge
   * countdown, the eighths' carry, the form whose tick runs, and the legs'
   * AnmD block -- hashed; the cockpit's block (presentation, a function of the
   * ramp) and the tick's codes are not.
   */
  readonly walker: WalkerState;
  /**
   * The walker's movement mode for its next tick (balance.ts
   * WALKER_MODE_OF_CODE): written from the ground code under it after it moves,
   * read by the next tick's velocity. Hashed on arenas with mode floors only.
   */
  readonly avatarMode: Uint8Array;

  /**
   * SimOptions.extraWeapons, normalized (config, like the loadouts). Everything
   * the five weapons add is hashed only in a match where it is not 0.
   */
  readonly extraWeapons: number;
  /**
   * Each player's kept round (the Grenade Launcher's, the Plasma Flare's), the
   * original's view `live_round`: the entity id, -1 none. A second Special press
   * while it lives sets off every round of its class the player fired.
   */
  readonly keptRound: Int32Array;
  /** The Riot Shield's sphere per player (systemShields). */
  readonly shield: ShieldState;
  /**
   * A guided round's launch point and range (x, y, height, range at `id * 4`),
   * the original's +0xa0..+0xa6: what its range and the Fusion Torpedo's falloff
   * measure from. Read and hashed for live guided rounds only.
   */
  readonly roundLaunch: Float32Array;

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
  // A spawn on a lift (Slim, Joke) stands on its top within a step.
  if (!warden && state.map.lifts.length > 0) {
    ent.height[id] = avatarSurface(state, s.x, s.y, ground, false).height;
  }
  ent.entLayer[id] = warden ? 0 : s.layer;
  ent.yaw[id] = s.yaw;
  ent.aimX[id] = cosLUT(s.yaw);
  ent.aimY[id] = sinLUT(s.yaw);
  ent.hp[id] = warden ? captainMaxHp(state) : avatarMaxHp(state, player);
  // The Sky Captain's level's model; the mech's radius follows its form
  // (entityRadius).
  if (warden) {
    const level = wardenLevel(state.wardenDifficulty);
    ent.radius[id] = state.map.radii.skyCaptain[level];
    ent.refHeight[id] = state.map.refHeights.skyCaptain[level];
  }
  // Spawn form (fcop-fidelity.md P2): every respawn comes back in the form the
  // spawn record asks for, as `player_respawn` resets the row from the record.
  const hover = !warden && s.hover;
  ent.mode[id] = hover ? MODE_HOVER : MODE_WALKER;
  if (hover) {
    const surface =
      s.layer === 0
        ? rideHeight(state.map, s.x, s.y, true)
        : resolveHeight(state.map, s.x, s.y, s.layer);
    ent.height[id] = surface + HOVER_CLEARANCE;
  }
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
  if (!warden) walkerReset(state.walker, player, hover);
  state.avatarMode[player] = 0;
  state.avatarSinking[player] = 0;
  state.rivalHit[player] = 0;
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
  ent.radius[id] = NEUTRAL_TURRET_RADIUS; // drawn as a neutral; no original of its own
  ent.restYaw[id] = ent.yaw[id];
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
  ent.radius[id] = state.map.radii.neutral[k];
  ent.refHeight[id] = state.map.refHeights.neutral[k];
  // The rest yaw. A turret's aimX/aimY are its shooter state (systemTargeting),
  // so they start at zero.
  if (state.map.turretYaw.length > 0) ent.yaw[id] = state.map.turretYaw[k];
  ent.restYaw[id] = ent.yaw[id];
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
  ent.radius[id] = state.map.radii.baseTurret;
  ent.refHeight[id] = state.map.refHeights.baseTurret;
  if (spot.yaw !== 0) ent.yaw[id] = spot.yaw;
  ent.restYaw[id] = ent.yaw[id];
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
  ent.radius[id] = state.map.radii.baseTurret;
  ent.refHeight[id] = state.map.refHeights.baseTurret;
  // Rest yaw only: aimX/aimY are the shooter's state (systemTargeting).
  if (spot.yaw !== 0) ent.yaw[id] = spot.yaw;
  ent.restYaw[id] = ent.yaw[id];
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
  // The spawn's credit: one more "Created" of its class for the side it joins
  // (`csac_credit_spawn`, spawn.c 0x0044f4b6..0x0044f563).
  const created = unitStatKey(archetype, true);
  if (created >= 0) bumpStat(state, team, created);
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
  const radii = state.map.radii;
  const refs = state.map.refHeights;
  ent.radius[id] =
    archetype === ARCHETYPE.RUNNER
      ? radii.tank
      : archetype === ARCHETYPE.GUARDIAN
        ? radii.jet
        : archetype === ARCHETYPE.JUGGERNAUT
          ? radii.dreadnought
          : radii.fortress;
  ent.refHeight[id] =
    archetype === ARCHETYPE.RUNNER
      ? refs.tank
      : archetype === ARCHETYPE.GUARDIAN
        ? refs.jet
        : archetype === ARCHETYPE.JUGGERNAUT
          ? refs.dreadnought
          : refs.fortress;
  if (archetype === ARCHETYPE.JUGGERNAUT) {
    ent.hp[id] = base.juggernaut.hp;
    ent.weaponProfile[id] = base.juggernaut.weapon;
    // A walking hull starts its track (`cact_anim_init`): track 0 forward at
    // its first frame, the clock and the flags zeroed.
    const walk = state.hullWalk[team];
    if (walk) {
      walk.flags[id] = 0;
      animSetTrack(walk, id, 0, 1, 0);
    }
    // Its guns come up at home (the hull's forward), their shooters fresh.
    for (let g = 0; g < DREADNOUGHT_GUNS; g++) {
      const k = id * DREADNOUGHT_GUNS + g;
      state.gunYaw[k] = 0;
      state.gunClock[k] = 0;
      state.gunPhase[k] = 0;
      state.gunTarget[k] = 0;
      state.gunSearch[k] = 0;
    }
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
  const extraWeapons = normalizeExtraWeapons(options?.extraWeapons);
  const difficulties = options?.difficulties;
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
    lastButtons: new Uint16Array(MAX_PLAYERS),
    moveCue: new Uint8Array(MAX_PLAYERS),
    roundFrom: new Uint8Array(MAX_ENTITIES),
    killPushDir: new Int32Array(MAX_ENTITIES),
    killPushDamage: new Int32Array(MAX_ENTITIES),
    points: new Uint32Array(MAX_PLAYERS).fill(STARTING_POINTS),
    heavyUnlocked: new Uint8Array(MAX_PLAYERS),
    heavyPoll: new Int32Array(MAX_PLAYERS),
    heavyTerminals: new Uint8Array(MAX_PLAYERS),
    unitQueue: new Int32Array(MAX_PLAYERS * UNIT_QUEUES),
    unitQueueTimer: new Int32Array(MAX_PLAYERS * UNIT_QUEUES),
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
    gunAmmo: new Uint16Array(MAX_PLAYERS),
    burstLeft: new Uint8Array(MAX_PLAYERS * 3),
    loadoutGun: new Uint8Array(MAX_PLAYERS),
    loadoutHeavy: new Uint8Array(MAX_PLAYERS),
    loadoutSpecial: new Uint8Array(MAX_PLAYERS),
    difficulty: new Uint8Array(MAX_PLAYERS).fill(DIFFICULTY_NORMAL),
    avatarSinking: new Uint8Array(MAX_PLAYERS),
    rivalHit: new Uint8Array(MAX_PLAYERS),
    statHalves: new Uint16Array(MAX_PLAYERS * STAT_HALVES),
    pointsScored: new Uint32Array(MAX_PLAYERS),
    firstDeath: new Uint32Array(MAX_PLAYERS),
    firstOutpost: new Uint32Array(MAX_PLAYERS),
    formTime: new Uint32Array(MAX_PLAYERS * 2),
    gunYaw: new Int16Array(MAX_ENTITIES * DREADNOUGHT_GUNS),
    gunClock: new Int32Array(MAX_ENTITIES * DREADNOUGHT_GUNS),
    gunPhase: new Uint8Array(MAX_ENTITIES * DREADNOUGHT_GUNS),
    gunTarget: new Int16Array(MAX_ENTITIES * DREADNOUGHT_GUNS),
    gunSearch: new Int32Array(MAX_ENTITIES * DREADNOUGHT_GUNS),
    hullWalk: map.bases.map((b) => {
      const w = b.juggernaut.walk;
      if (w === undefined) return null;
      const track: AnmdTrack = [
        w.from,
        w.to,
        w.mode,
        w.end,
        w.link,
        w.linkB,
        w.linkC,
        w.flags,
        w.period,
        w.event,
      ];
      return createAnimPlayer([track], MAX_ENTITIES);
    }),
    wardenPlayer,
    wardenDifficulty,
    captain: createCaptainState(),
    pickupCooldown: new Int32Array(map.pickups.length),
    buffInvuln: new Int32Array(map.pickups.length > 0 ? MAX_PLAYERS : 0),
    buffInvis: new Int32Array(map.pickups.length > 0 ? MAX_PLAYERS : 0),
    powerAmmo: new Uint16Array(MAX_PLAYERS * 3),
    triggerArm: new Int32Array(map.triggerVolumes.length),
    turretAlert: new Int32Array(ringSlots > 0 ? MAX_PLAYERS : 0),
    guardLatch: new Uint8Array(map.spawnGuards.length),
    guardTimer: new Int32Array(map.spawnGuards.length),
    liftWu: new Int32Array(map.lifts.length),
    liftStop: new Int8Array(map.lifts.length),
    liftDir: new Int8Array(map.lifts.length),
    liftPhase: new Uint8Array(map.lifts.length),
    liftTimer: new Int32Array(map.lifts.length),
    avatarLift: new Int8Array(MAX_PLAYERS).fill(-1),
    avatarTurnRate: new Float32Array(MAX_PLAYERS),
    avatarIdle: new Int32Array(MAX_PLAYERS),
    walker: createWalkerState(MAX_PLAYERS),
    avatarMode: new Uint8Array(MAX_PLAYERS),
    extraWeapons,
    keptRound: new Int32Array(MAX_PLAYERS).fill(-1),
    shield: createShieldState(),
    roundLaunch: new Float32Array(MAX_ENTITIES * 4),
    events: createEventBuffer(),
  };
  // Apply loadouts before avatars spawn so ammo capacities match the kit.
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const raw = loadouts?.[p] ?? (p === 0 ? loadouts?.[0] : undefined);
    const kit = normalizeLoadout(raw ?? DEFAULT_LOADOUT, extraWeapons);
    state.loadoutGun[p] = kit.gun;
    state.loadoutHeavy[p] = kit.heavy;
    state.loadoutSpecial[p] = kit.special;
    // An X1-Alpha's difficulty; the Warden's slot is the Sky Captain's, whose
    // difficulty is its level.
    if (p !== wardenPlayer) state.difficulty[p] = normalizeDifficulty(difficulties?.[p]);
  }
  // A polled mission function's first poll falls at a random moment inside its
  // first period: `cfun_load`'s countdown, `(u32)game_rand() % (u32)period` in
  // engine ticks (cfun/load.c 0x00436b10), here the sim's mulberry32 word.
  for (let k = 0; k < map.spawnGuards.length; k++) {
    state.guardTimer[k] = randU32(state) % map.spawnGuards[k].resetPeriod;
  }
  // fn30 / fn31 in the original's form: an engine-tick countdown from
  // `(u32)game_rand() % (u32)period` (cfun/load.c 0x00436b10).
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const zones = map.bases[p].heavyZones;
    if (zones !== undefined) state.heavyPoll[p] = randU32(state) % zones.pollPeriod;
  }
  for (let p = 0; p < MAX_PLAYERS; p++) {
    for (let q = 0; q < UNIT_QUEUES; q++) {
      state.unitQueueTimer[p * UNIT_QUEUES + q] = randU32(state) % queuePeriod(map, p, q);
    }
  }
  // Each lift at its record's stop, parked or dwelling as that stop says,
  // headed for the next stop up (every shipped lift lists its stops ascending).
  for (let k = 0; k < map.lifts.length; k++) {
    const l = map.lifts[k];
    state.liftStop[k] = l.start;
    state.liftWu[k] = l.stops[l.start];
    state.liftDir[k] = l.start < l.stops.length - 1 ? 1 : -1;
    state.liftTimer[k] = l.dwell[l.start];
    state.liftPhase[k] = l.dwell[l.start] > 0 ? LIFT_DWELL : LIFT_PARKED;
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
 *   0.58-gradient wall (issue #34). The span probe is the second reading. Both
 *   read `hoverSurface`, so a dip below the water surface reads as the surface
 *   the hover floats on rather than as a hole it has to climb out of, and a
 *   deck the hover rides is its ground.
 */
function slopeBlocks(
  state: SimState,
  x: number,
  y: number,
  nx: number,
  ny: number,
  hover: boolean,
  height: number,
): boolean {
  const map = state.map;
  const here = avatarSurface(state, x, y, height, hover).height;
  const ahead = avatarSurface(state, nx, ny, height, hover);
  const rise = ahead.height - here;
  if (rise <= GROUND_EPS) return false;
  // A lift's top within the walker's probe is stepped onto, as the original's
  // probe steps onto it: its rim is a hard edge the gradient test would read as
  // a wall.
  if (ahead.lift >= 0 && rise <= LIFT_STEP_UP) return false;
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
  return avatarSurface(state, px, py, height, hover).height - here > HOVER_CUSHION_SPAN * maxSlope;
}

/** Scratch for `surfaceTilt` (the tick is synchronous and not re-entrant). */
const tilt = { gx: 0, gy: 0, t: 0, lift: 0 };
/** Half-width of the central difference `surfaceTilt` reads the surface with, m. */
const TILT_PROBE = 0.25;
/**
 * The same, for the ground right under the feet: the original's steep flag is
 * the normal of the surface the mech stands on, which TILT_PROBE's 0.5 m span
 * smears across an edge it has not reached (a flat deck's edge reads steep).
 */
const TILT_UNDERFOOT = 1 / 1024;

/**
 * The surface under a mover as the original's surface normal: the height
 * gradient (gx, gy), the normal's horizontal length `t` (its "tilt") and its
 * vertical part `lift`. The hover reads its ride surface (water is flat; a
 * deck it rides), the walker the deck it stands on. The original takes the
 * normal of the plate under the mech, so the difference is read on that
 * surface only: a probe that lands on another surface — over a deck's edge,
 * into a hole, onto a lift — reads as the centre's height (a ledge is not a
 * slope; the gates and gravity handle it). A lift's top is flat: the original's
 * carrier answers its own face's normal. On a map with one surface this is the
 * plain difference.
 */
function surfaceTilt(
  state: SimState,
  x: number,
  y: number,
  hover: boolean,
  h: number,
  e = TILT_PROBE,
): typeof tilt {
  const c = avatarSurface(state, x, y, h, hover);
  if (c.lift >= 0) {
    tilt.gx = 0;
    tilt.gy = 0;
    tilt.lift = 1;
    tilt.t = 0;
    return tilt;
  }
  const layer = c.layer;
  const centre = c.height;
  const at = (px: number, py: number) => {
    const s = avatarSurface(state, px, py, h, hover);
    return s.layer === layer && s.lift < 0 ? s.height : centre;
  };
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
/** Engine angle units (4096 a turn) to radians. */
const ANGLE_UNIT = (2 * Math.PI) / 4096;

/**
 * A velocity's length as the walker's integers have it: 16.16 a movement step,
 * to the nearest unit -- the closed form approaches a steady speed the
 * original's integer steps reach exactly (a full run's 0x40000).
 */
function stepSpeed(vx: number, vy: number, vz: number): number {
  return Math.floor(Math.sqrt(vx * vx + vy * vy + vz * vz) / X1_STEP_SPEED + 0.5);
}

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
    state.avatarLift[p] = -1;
    state.walker.codeCount[p] = 0;
    state.walker.steps[p] = 0;
    if (p === state.wardenPlayer) continue;
    const id = state.avatarId[p];
    state.moveCue[p] = 0;
    // The original's button word (inputs.ts); the client's own keys are cut.
    const word = inputs.players[p].buttons & SIM_BUTTONS;
    if (id < 0) {
      state.lastButtons[p] = word;
      continue;
    }
    const yaw0 = ent.yaw[id];

    // HARD's deep water (balance.ts WALKER_SINK_PER_TICK, DROWN_DEPTH): the
    // original's frame checks a sinking mech before its movement steps, and more
    // than 1.75 m under the surface over it the mech takes its health + 1,
    // credited to nobody (player.c 0x00446e3e).
    const sinking = state.avatarSinking[p] !== 0;
    if (sinking && surfaceOver(map, ent.posX[id], ent.posY[id]) - ent.height[id] > DROWN_DEPTH) {
      applyDamage(state, id, ent.hp[id] + 1, -1);
    }

    const locked = ent.timerA[id] > 0;
    if (locked) ent.timerA[id] -= 1;

    let x = ent.posX[id];
    let y = ent.posY[id];
    let hover = ent.mode[id] === MODE_HOVER;

    // Transform (fcop-fidelity.md P3): the chord Change Target + Action, both
    // HELD — a level, not an edge, so a chord still held when a change ends asks
    // for the other form again (`player_transform_step`). Not while a change
    // runs; on water in either form refused with a sound, on every tick the
    // chord is held (the original's byte_146, set by surface material 1). In the
    // air too: the original does not ask.
    // A sinking mech asks for nothing (the request's gate reads block +0xde).
    if ((word & TRANSFORM_CHORD) === TRANSFORM_CHORD && !locked && !sinking) {
      if (!inWater(state, id, x, y)) {
        hover = !hover;
        startTransform(state, id, hover);
      } else {
        pushEvent(state.events, EV_TRANSFORM_REFUSED, id, p, 0);
      }
    }
    // While the change runs, the original keeps only the three fire buttons —
    // no drive, turn, jump, Action press or lock cycle, on the chord's own tick
    // and on the tick the ramp ends as well, so a chord held through a change
    // registers neither half's press — and runs the HOVER tick for the whole
    // ramp in both directions, so the hull coasts on hover drag while its ride
    // height ramps (fcop-re/player-and-weapons.md §2).
    // A sinking mech keeps only Map and Camera (`PLAYER_FORM_BITS_KEEP`,
    // 0x0044245a), which the sim never reads: nothing at all.
    const nowLocked = ent.timerA[id] > 0;
    let bits = sinking ? 0 : locked || nowLocked ? word & TRANSFORM_KEEPS : word;
    // The latches see the filtered word, as the original's button trackers do.
    const prev = state.lastButtons[p];
    const pressed = bits & ~prev;
    const held = bits & prev;
    state.lastButtons[p] = bits;
    // Both jinks held cancel each other, in either form.
    if ((bits & JINKS) === JINKS) bits &= ~JINKS;
    /** Hover physics this tick: the hover form, or any transformation ramp. */
    let hoverPhys = hover || nowLocked;

    // Where it stands. The walker resolves its deck (base or an upper layer
    // reachable within a step); the hover rides the surface its probe finds
    // (`hoverSurface`: a deck, the ground or water) at its clearance.
    let ride = hoverPhys
      ? avatarSurface(state, x, y, ent.height[id], true).height + clearanceOf(ent, id)
      : avatarSurface(state, x, y, ent.height[id], false).height;
    let vz = ent.timerB[id];
    const airborne = hoverPhys
      ? ent.height[id] > ride + HOVER_HOLD_DOWN || vz > 0
      : ent.height[id] > ride + GROUND_EPS || vz > 0;

    // The lock (fcop-fidelity.md W2): hold, cycle, auto-acquire, against the
    // facing the hull had coming into this tick.
    updateLock(state, p, id, (pressed & BTN_CHANGE_TARGET) !== 0);
    // The Action Key's press is "use", an edge like the original's button latch
    // (fcop-re/ranges-turrets-capture.md Q2): capture, claim, buy, ride a lift.
    // systemCapture clears it.
    if ((pressed & BTN_ACTION) !== 0) state.capturePress[p] = 1;

    // The Action Key held is the slow row (camera-and-movement.md "The walker
    // in numbers"), and both rows' directions as the button word has them; the
    // walker's state machine below decides what of it drives the walker.
    const fore = (bits & BTN_FORWARD) !== 0 ? 1 : (bits & BTN_BACK) !== 0 ? -1 : 0;
    const side = (bits & BTN_JINK_RIGHT) !== 0 ? 1 : (bits & BTN_JINK_LEFT) !== 0 ? -1 : 0;
    const slow = (bits & BTN_ACTION) !== 0;
    const crouch = !hoverPhys && !airborne && slow && fore === 0 && (bits & BTN_JUMP) !== 0;

    // The walker's state machine (walker.ts; fcop-fidelity.md G11, P4): the
    // tick's steps on the clock's eighths, in either form; on the walker the
    // tick's command -- the fast row's jump by the probe of the ground ahead,
    // against the facing the tick starts with, as the original probes with the
    // frame's sine and cosine -- and its first step's arm, which drives the
    // movement below: the push its state asks for (none while a HOLD track
    // keeps a wind-up, a landing or a leap), a take-off's lift and push, the
    // lunge, the stop test and the turn. A jump leaves the ground in its
    // take-off state's arm, after its wind-up; Jump held jumps again.
    const walk = state.walker;
    const steps = walkerEighths(walk, p);
    const walkerTick = !hoverPhys;
    const arm = WALK_ARM;
    let command = 0;
    if (walkerTick) {
      let rise = 0;
      if (walkerProbes(walk, p, bits)) {
        const h = ent.height[id];
        const ax = Math.min(Math.max(x + ent.aimX[id] * WALKER_PROBE_AHEAD, 0), extent);
        const ay = Math.min(Math.max(y + ent.aimY[id] * WALKER_PROBE_AHEAD, 0), extent);
        rise = avatarSurface(state, ax, ay, h + WALKER_PROBE_LIFT, false).height - h;
      }
      command = walkerCommand(walk, p, bits, rise);
      walkerArm(walk, p, command, bits, stepSpeed(ent.velX[id], ent.velY[id], vz) >> 11);
    }
    const liftOff = walkerTick && arm.lift > 0;
    const inAir = airborne || liftOff;

    // Turning, by the turn buttons (camera-and-movement.md "Facing"): Turn
    // Right raises the facing — clockwise seen from above — and wins over Turn
    // Left.
    const turn = (bits & BTN_TURN_RIGHT) !== 0 ? 1 : (bits & BTN_TURN_LEFT) !== 0 ? -1 : 0;
    let dYaw = 0;
    if (hoverPhys) {
      // Hover: the rate word grows by the frame delta a step toward the side
      // turned to, from zero after a reversal, is zero on a release and is
      // clamped at 0x60; the facing turns by half of it a step (158°/s at most).
      let rate = state.avatarTurnRate[p];
      if (turn === 0 || (rate !== 0 && rate > 0 !== turn > 0)) rate = 0;
      if (turn !== 0) {
        rate += turn * X1_UNITS_PER_TICK * X1_STEPS_PER_TICK;
        if (rate > HOVER_TURN_LIMIT) rate = HOVER_TURN_LIMIT;
        else if (rate < -HOVER_TURN_LIMIT) rate = -HOVER_TURN_LIMIT;
      }
      state.avatarTurnRate[p] = rate;
      dYaw = rate * 0.5 * X1_STEPS_PER_TICK * ANGLE_UNIT;
    } else if (arm.turn !== 0) {
      // Walker: the arm's turn, 0x20 a step less speed * 0x20 >> 9 (105°/s at
      // rest, nothing at 18.75 m/s), on the ground only and not on a jump's
      // command. No ramp.
      dYaw = arm.turn * X1_STEPS_PER_TICK * ANGLE_UNIT;
    }
    if (dYaw !== 0) {
      let yaw = ent.yaw[id] + dYaw;
      if (yaw > Math.PI) yaw -= 2 * Math.PI;
      else if (yaw <= -Math.PI) yaw += 2 * Math.PI;
      ent.yaw[id] = yaw;
      ent.aimX[id] = cosLUT(yaw);
      ent.aimY[id] = sinLUT(yaw);
    }
    const fx = ent.aimX[id];
    const fy = ent.aimY[id];

    // The push, in the hull's frame. The hover's from its rows: forward beats
    // back, Jink Right beats Jink Left, a fore/aft state with a jink is the
    // diagonal, 181/256 of the fore push along F ± R, and the brake (Jump)
    // beats every direction; the slow row takes the slow pushes. The walker's
    // from its arm: the state's push along the heading or across it, the
    // diagonal in states 1-4 with a jink and no Jump.
    const brake = hover && (bits & BTN_JUMP) !== 0;
    let pushX = 0;
    let pushY = 0;
    if (hoverPhys) {
      if (!brake && fore !== 0) {
        const pf = slow ? HOVER_PUSH_SLOW_FORE : HOVER_PUSH_FORE;
        if (side !== 0) {
          const k = pf * X1_DIAGONAL_SCALE;
          pushX = k * (fore * fx - side * fy);
          pushY = k * (fore * fy + side * fx);
        } else {
          pushX = pf * fore * fx;
          pushY = pf * fore * fy;
        }
      } else if (!brake && side !== 0) {
        const ps = slow ? HOVER_PUSH_SLOW_STRAFE : HOVER_PUSH_STRAFE;
        pushX = -ps * side * fy;
        pushY = ps * side * fx;
      }
    } else if (!arm.impulse && arm.push !== 0) {
      const pf = arm.push * X1_STEP_SPEED;
      if (arm.sideways) {
        pushX = -pf * fy;
        pushY = pf * fx;
      } else if (arm.diagonal !== 0) {
        const k = Math.abs(pf) * X1_DIAGONAL_SCALE;
        const f = pf > 0 ? 1 : -1;
        pushX = k * (f * fx - arm.diagonal * fy);
        pushY = k * (f * fy + arm.diagonal * fx);
      } else {
        pushX = pf * fx;
        pushY = pf * fy;
      }
    }
    const commanded = !brake && !crouch && (fore !== 0 || side !== 0);
    state.moveCue[p] =
      (commanded ? MOVE_CUE_DRIVE : 0) |
      (brake ? MOVE_CUE_BRAKE : 0) |
      (ent.yaw[id] !== yaw0 ? MOVE_CUE_TURN : 0);

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
        const t = surfaceTilt(state, x, y, true, ent.height[id]);
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
    } else if (airborne || walkerShortTail(walk.state[p])) {
      // Airborne walker, or one its arm left on the short tail (the high jump's
      // and the leap's take-off, their landing's first step): no push, no
      // steering, a light horizontal drag.
      const r = retentionPerTick(WALKER_AIR_DRAG);
      vx *= r;
      vy *= r;
    } else {
      const t = surfaceTilt(state, x, y, false, ent.height[id]);
      // The ground's mode from the last tick (slippery ground, WALKER_MODE_*):
      // the command push scaled first, then the slope push and the drag.
      const mode = state.avatarMode[p];
      if (mode !== 0) {
        pushX *= WALKER_MODE_PUSH * mode;
        pushY *= WALKER_MODE_PUSH * mode;
      }
      let sp = slopePush(WALKER_SLOPE_KNEE, WALKER_SLOPE_GAIN);
      if (mode !== 0) sp *= 1 + (4 - mode) / 4;
      // A sinking walker's normal is the water's, flat (its probe still finds
      // the water over it): no downhill push from what lies under it.
      if (sp > 0 && !sinking) {
        const g = Math.sqrt(t.gx * t.gx + t.gy * t.gy);
        pushX -= (sp * t.gx) / g;
        pushY -= (sp * t.gy) / g;
      }
      const drag = mode !== 0 ? WALKER_MODE_DRAG * (4 - mode) : WALKER_DRAG;
      const stop = mode !== 0 ? WALKER_MODE_STOP * mode : WALKER_STOP_SPEED;
      // The stop test of the tick's first step, as for the hover, in the
      // states whose arm runs it (0, 9, 0x12).
      const k = 1 - drag;
      const settle =
        arm.settle && Math.abs(vx * k + pushX) < stop && Math.abs(vy * k + pushY) < stop;
      const r = retentionPerTick(drag);
      vx = settle ? 0 : (pushX / drag) * (1 - r) + vx * r;
      vy = settle ? 0 : (pushY / drag) * (1 - r) + vy * r;
    }
    if (walkerTick && arm.impulse) {
      // The arm's one step of push: a take-off's, with its lift, or the high
      // jump's lunge 9 steps after it.
      const pi = arm.push * X1_STEP_SPEED;
      vx += pi * fx;
      vy += pi * fy;
      if (arm.lift > 0) vz = arm.lift * X1_STEP_SPEED;
    }
    ent.velX[id] = vx;
    ent.velY[id] = vy;

    // Horizontal movement, axis-separated for wall sliding. Uphill steps
    // beyond the slope limit are blocked (slopeBlocks). Airborne walkers skip
    // the slope check so a jump can carry them onto a ledge.
    // Walls come from the deck the avatar is standing on (entLayer, set by the
    // resolveWalker / hoverSurface snap below on the previous tick), in either
    // form: a hover on a deck is bounded by that deck's walls.
    const wallLayer = ent.entLayer[id];
    const skipSlope = !hoverPhys && inAir;
    const fromX = x;
    const fromY = y;
    const stepX = vx * TICK_DT;
    if (stepX !== 0) {
      const nx = Math.min(Math.max(x + stepX, 0), extent);
      let ok = !crossesWallX(map, x, nx, y, wallLayer);
      if (ok && !skipSlope && slopeBlocks(state, x, y, nx, y, hoverPhys, ent.height[id]))
        ok = false;
      if (ok) x = nx;
      else ent.velX[id] = 0;
    }
    const stepY = vy * TICK_DT;
    if (stepY !== 0) {
      const ny = Math.min(Math.max(y + stepY, 0), extent);
      let ok = !crossesWallY(map, x, y, ny, wallLayer);
      if (ok && !skipSlope && slopeBlocks(state, x, y, x, ny, hoverPhys, ent.height[id]))
        ok = false;
      if (ok) y = ny;
      else ent.velY[id] = 0;
    }
    // The slow row's ledge (balance.ts WALKER_LEDGE_DROP): the walker in state
    // 1, 2 or 5 (slow forward, back or Jink Left) on the ground is put back from
    // a drop of over 0.1 m, and its state is 0 again (walkerLand). The
    // hover's slow row holds only at drops under 0.1 m (0x00442d36), which in
    // Metropolis' hover — no push along the surface, so every downhill tick
    // reads as a small drop — would stop it on any slope: not modelled.
    let ledge = false;
    const ws = walk.state[p];
    if (
      walkerTick &&
      !inAir &&
      !sinking &&
      (ws === 1 || ws === 2 || ws === 5) &&
      (x !== fromX || y !== fromY)
    ) {
      const h = ent.height[id];
      if (h - avatarSurface(state, x, y, h, false).height > WALKER_LEDGE_DROP) {
        if (surfaceTilt(state, fromX, fromY, false, h, TILT_UNDERFOOT).t <= WALKER_STEEP_TILT) {
          x = fromX;
          y = fromY;
          ent.velX[id] = 0;
          ent.velY[id] = 0;
          ledge = true;
        }
      }
    }
    ent.posX[id] = x;
    ent.posY[id] = y;

    // Deep water under a walker (`player_order` code 1, player.c:796-811): on
    // NORMAL and EASY it asks for the hover on its own; on HARD it takes the
    // sinking marker and loses its invulnerability timer, every tick it is in
    // the water, and sinks from the next tick on (balance.ts WALKER_SINK_PER_TICK).
    if (!hoverPhys && inWater(state, id, x, y)) {
      if (state.difficulty[p] === DIFFICULTY_HARD) {
        state.avatarSinking[p] = 1;
        if (state.buffInvuln.length > 0) state.buffInvuln[p] = 0;
      } else {
        hover = true;
        hoverPhys = true;
        startTransform(state, id, true);
      }
    }

    // Vertical: gravity 26.1 m/s² to a 14.06 m/s terminal fall in both forms,
    // and a landing over 10.78 m/s hurts.
    let h = ent.height[id];
    let carrier = -1;
    /** The landing's fall speed, m/s, 0 for none. */
    let fall = 0;
    if (hoverPhys) {
      // Snapped up to its ride height, held down within HOVER_HOLD_DOWN of it,
      // and airborne above that — off a ledge it falls.
      const hs = avatarSurface(state, x, y, h, true);
      ent.entLayer[id] = hs.layer;
      carrier = hs.lift;
      ride = hs.height + clearanceOf(ent, id);
      const air = h > ride + HOVER_HOLD_DOWN || vz > 0;
      if (air) {
        vz -= X1_GRAVITY * TICK_DT;
        if (vz < -X1_TERMINAL_FALL) vz = -X1_TERMINAL_FALL;
        h += vz * TICK_DT;
      }
      if (!air || h <= ride) {
        if (air && vz < 0) {
          landingImpact(state, id, -vz);
          fall = -vz;
        }
        h = ride;
        vz = 0;
      }
    } else if (sinking) {
      // HARD's sinking walker: its ground is its own height less 0xc0 wu a step
      // and its vertical velocity is zeroed, whatever lies under it
      // (`player_walk_tick` 0x0044496c) — through the water, the bed and on.
      const wr = avatarSurface(state, x, y, h, false);
      ent.entLayer[id] = wr.layer;
      ride = wr.height;
      h -= WALKER_SINK_PER_TICK;
      vz = 0;
    } else {
      // The walker snaps to step-sized height changes (STEP_SNAP, Metropolis'
      // deck rule) and falls past them.
      const wr = avatarSurface(state, x, y, h, false);
      ent.entLayer[id] = wr.layer;
      carrier = wr.lift;
      ride = wr.height;
      if (vz !== 0 || h > ride + STEP_SNAP) {
        vz -= X1_GRAVITY * TICK_DT;
        if (vz < -X1_TERMINAL_FALL) vz = -X1_TERMINAL_FALL;
        h += vz * TICK_DT;
        if (h <= ride) {
          if (vz < 0) {
            landingImpact(state, id, -vz);
            fall = -vz;
          }
          h = ride;
          vz = 0;
        }
      } else {
        h = ride;
        vz = 0;
      }
    }
    ent.height[id] = h;
    ent.timerB[id] = vz;
    // The ground's code under the walker sets its next tick's mode, felt within
    // SURFACE_REACH as the original's player_order is; a hover's step reads
    // none, and a lift's top carries no code.
    let mode = 0;
    if (map.modeFloors && !hoverPhys && carrier < 0 && h - ride < SURFACE_REACH) {
      const masks = map.floorMasks;
      const layer = ent.entLayer[id];
      const i = Math.floor(x / map.cellSize);
      const j = Math.floor(y / map.cellSize);
      if (layer < masks.length && i >= 0 && j >= 0 && i < map.size && j < map.size) {
        const code = masks[layer][j * map.size + i];
        if (code < WALKER_MODE_OF_CODE.length) mode = WALKER_MODE_OF_CODE[code];
      }
    }
    state.avatarMode[p] = mode;
    // Standing on a lift's top: that lift is its carrier this tick.
    if (carrier >= 0 && h - ride <= GROUND_EPS) state.avatarLift[p] = carrier;

    // The machine after the movement: the first step's surface and legs, then
    // the tick's second step whole, its lift and push into the velocity the
    // next tick integrates (walker.ts). The hover's tick writes the bytes it
    // shares with the walker's; the ramp steps both blocks.
    if (walkerTick) {
      const up = h > ride + GROUND_EPS;
      const steep = surfaceTilt(state, x, y, false, h).t > WALKER_STEEP_TILT;
      const lean = state.avatarMode[p];
      if (!sinking) walkerLand(walk, p, up, fall / X1_STEP_SPEED, ledge);
      walkerLegs(walk, p, stepSpeed(ent.velX[id], ent.velY[id], ent.timerB[id]), lean, steep);
      for (let e = 1; e < steps; e++) {
        walkerArm(
          walk,
          p,
          command,
          bits,
          stepSpeed(ent.velX[id], ent.velY[id], ent.timerB[id]) >> 11,
        );
        if (arm.impulse) {
          const pi = arm.push * X1_STEP_SPEED;
          ent.velX[id] += pi * ent.aimX[id];
          ent.velY[id] += pi * ent.aimY[id];
          if (arm.lift > 0) ent.timerB[id] = arm.lift * X1_STEP_SPEED;
        }
        if (!sinking) walkerLand(walk, p, up || arm.lift > 0, 0, false);
        walkerLegs(walk, p, stepSpeed(ent.velX[id], ent.velY[id], ent.timerB[id]), lean, steep);
      }
    } else {
      walkerHover(walk, p, bits, h <= ride, h > ride + HOVER_HOLD_DOWN, fall / X1_STEP_SPEED);
    }
    if (ent.timerA[id] > 0) walkerRamp(walk, p, ent.mode[id] === MODE_HOVER, ent.timerA[id]);

    ent.animState[id] =
      (commanded || ent.velX[id] * ent.velX[id] + ent.velY[id] * ent.velY[id] > 1e-6
        ? ANIM_MOVING
        : 0) |
      (hover ? ANIM_HOVER : 0) |
      (h > ride + GROUND_EPS ? ANIM_AIRBORNE : 0) |
      (ent.timerA[id] > 0 ? ANIM_TRANSFORMING : 0);

    // Weapons (sub-step of the avatar system): cooldowns, fire, ammo stub. They
    // fire through a transformation (fcop-fidelity.md P3).
    avatarWeapons(state, p, id, bits, pressed, held);
    // Purchases (rules.md §3): one unit per press of the action key on a spot.
    systemBuy(state, p, id);
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
 * The lock never turns the mech: the hull turns by the turn buttons alone, so
 * turning more than 25° away drops it.
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
  if (cycle) {
    const next = findLockTarget(state, player, selfId, lock);
    if (next >= 0) lock = next;
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
  const reach = zone + entityRadius(state, id);
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
    const zone = map.outposts[k].zone;
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
  // The Sky Captain's First Outpost is its decision's: the claim loop stamps
  // sky_ai +0x4c while its side holds none (dispatch.c 0x00421910, state word
  // 34). A player's is its tick's (stats.ts systemStats).
  if (player === state.wardenPlayer && outpostsHeld(state, player) === 0) {
    state.firstOutpost[player] = statClock(state);
  }
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
 * spot the avatar stands on: the base's tank and jet trigger boxes, its
 * Dreadnought and Fortress zones (R10), an imported outpost's tank and jet pads.
 * A press the spot refuses — the points are short, the side already has 20 of
 * that unit alive, or its one heavy unit of that kind lives — answers with
 * EV_PURCHASE_REFUSED, the original's refuse sound; an accepted one with
 * EV_PURCHASE. A heavy zone the points check has not opened yet is disabled, as
 * the original's is, and stays silent.
 */
export function systemBuy(state: SimState, player: number, id: number): void {
  const ent = state.ent;
  const map = state.map;
  if (state.capturePress[player] !== 1) return;
  if (claimOutpost(state, player, id)) return;
  const x = ent.posX[id];
  const y = ent.posY[id];

  let cost = 0;
  let archetype = -1;
  let spawnX = 0;
  let spawnY = 0;
  let spawnLayer = 0;
  let mode = UNIT_MODE_PATROL;
  let forward = false;
  // A tank is queued, not spawned (QUEUE_BASE_TANKS or an outpost's); -1 = at once.
  let queue = -1;

  const base = map.bases[player];
  const heavy = base.heavyZones;
  const r = entityRadius(state, id);
  if (inBuyBox(x, y, r, base.groundConsole, base.groundBuy)) {
    archetype = ARCHETYPE.RUNNER;
    cost = COST_RUNNER;
    queue = QUEUE_BASE_TANKS;
  } else if (inBuyBox(x, y, r, base.airConsole, base.airBuy)) {
    archetype = ARCHETYPE.GUARDIAN;
    cost = COST_GUARDIAN;
    spawnX = base.jetSpawn.x;
    spawnY = base.jetSpawn.y;
    spawnLayer = base.jetSpawn.layer;
  } else if (heavy !== undefined && touchesHeavyZone(state, id, heavy.juggernaut)) {
    // The original's Dreadnought rolls out of its own spawner at node 0 of its
    // Cnet by the HQ (fcop-re/ranges-turrets-capture.md top), not at the zone.
    if (state.heavyUnlocked[player] === 0) return; // disabled: no answer
    archetype = ARCHETYPE.JUGGERNAUT;
    cost = COST_JUGGERNAUT;
    spawnX = base.juggernaut.x;
    spawnY = base.juggernaut.y;
    spawnLayer = base.juggernaut.layer;
  } else if (heavy !== undefined && touchesHeavyZone(state, id, heavy.fortress)) {
    if (state.heavyUnlocked[player] === 0) return;
    archetype = ARCHETYPE.FORTRESS;
    cost = COST_FORTRESS;
    spawnX = base.fortressSpawn.x;
    spawnY = base.fortressSpawn.y;
    spawnLayer = base.fortressSpawn.layer;
  } else {
    // The original's outpost pads (fcop-re/outposts.md Q3): a tank pad and a jet
    // pad per outpost, its owner's only, 2 points a unit. The tank is queued to
    // the outpost's tank spawner; the jet leaves its jet spawner at once and
    // patrols the outpost it was built at (mode 1 + k).
    for (let k = 0; k < map.outposts.length; k++) {
      if (state.outpostOwner[k] !== player) continue;
      const o = map.outposts[k];
      const jet = touchesZone(state, id, o.jetPad.x, o.jetPad.y, o.jetPad.layer, o.zone);
      if (!jet && !touchesZone(state, id, o.tankPad.x, o.tankPad.y, o.tankPad.layer, o.zone)) {
        continue;
      }
      archetype = jet ? ARCHETYPE.GUARDIAN : ARCHETYPE.RUNNER;
      cost = (jet ? COST_GUARDIAN : COST_RUNNER) * OUTPOST_COST_MULTIPLIER;
      if (jet) {
        const at = o.jetSpawn[player];
        spawnX = at.x;
        spawnY = at.y;
        spawnLayer = at.layer;
        mode = UNIT_MODE_OUTPOST + k;
        forward = true;
      } else {
        queue = QUEUE_OUTPOST + 2 * k;
      }
      break;
    }
  }

  if (archetype < 0) return; // not on a purchase spot: the press is not a purchase

  // The spot's own gates (fcop-fidelity.md R9, R10), refused out loud: the
  // points, the 20-alive cap of tanks and jets — a queued unit counts from its
  // purchase, as the original's count word does (R18) — and a heavy zone whose
  // unit lives (the original's latch, reopened by that unit's death script).
  let alive = countAliveOfArchetype(state, archetype, player);
  if (archetype === ARCHETYPE.RUNNER || archetype === ARCHETYPE.GUARDIAN) {
    alive += queuedUnits(state, player, archetype === ARCHETYPE.GUARDIAN);
  }
  if (state.points[player] < cost || alive >= aliveLimit(archetype)) {
    pushEvent(state.events, EV_PURCHASE_REFUSED, id, player, archetype);
    return;
  }

  state.points[player] -= cost;
  if (queue >= 0) {
    // Accepted at the press; the queue's next poll spawns it.
    state.unitQueue[player * UNIT_QUEUES + queue] += 1;
    pushEvent(state.events, EV_PURCHASE, id, player, archetype);
    return;
  }
  const uid = spawnUnit(state, archetype, player, spawnX, spawnY, mode, forward, spawnLayer);
  if (uid >= 0) {
    pushEvent(state.events, EV_PURCHASE, uid, player, archetype);
  } else {
    state.points[player] += cost; // entity cap hit: refund, nothing spawned
    pushEvent(state.events, EV_PURCHASE_REFUSED, id, player, archetype);
  }
}

/** Spawn queue indices (SimState.unitQueue): per team, then per outpost k at + 2k. */
export const QUEUE_BASE_TANKS = 0;
export const QUEUE_BASE_JETS = 1;
export const QUEUE_OUTPOST = 2;

/** A queue's period in engine ticks: the arena's own, else ORIGINAL_*_QUEUE_PERIOD. */
function queuePeriod(map: MapData, team: number, q: number): number {
  const jet = (q & 1) === 1;
  if (q < QUEUE_OUTPOST) {
    const t = map.bases[team].queuePeriod;
    return jet ? t.jet : t.tank;
  }
  const k = (q - QUEUE_OUTPOST) >> 1;
  if (k >= map.outposts.length) return jet ? ORIGINAL_JET_QUEUE_PERIOD : ORIGINAL_TANK_QUEUE_PERIOD;
  const t = map.outposts[k].queuePeriod[team];
  return jet ? t.jet : t.tank;
}

/** Jets (or tanks) `team` has bought or requested and not yet spawned. */
export function queuedUnits(state: SimState, team: number, jet: boolean): number {
  let n = 0;
  for (let q = jet ? 1 : 0; q < UNIT_QUEUES; q += 2) n += state.unitQueue[team * UNIT_QUEUES + q];
  return n;
}

/**
 * The spawn queues (fcop-fidelity.md R18): each is the original's mission
 * function that, once a period from a phase drawn at load, spawns one unit while
 * its count is positive (fn18/fn19 a base's tanks, fn17 the captain's base jets,
 * fn07..fn16/fn20/fn21 the outposts'). They run on `cfun_tick`'s countdowns
 * (cfun/load.c 0x00436be0): the frame delta, CFUN_DELTA_PER_TICK engine ticks
 * a tick, off each; one gone negative takes its period back and polls. The
 * unit leaves the queue's spawner; one the spawner refuses (20 of its kind
 * alive) is spent all the same. A human's tanks and the Sky Captain's tanks
 * and jets come this way.
 */
function systemQueues(state: SimState): void {
  const map = state.map;
  for (let team = 0; team < MAX_PLAYERS; team++) {
    for (let q = 0; q < UNIT_QUEUES; q++) {
      const k = team * UNIT_QUEUES + q;
      state.unitQueueTimer[k] -= CFUN_DELTA_PER_TICK;
      if (state.unitQueueTimer[k] >= 0) continue;
      state.unitQueueTimer[k] += queuePeriod(map, team, q);
      if (state.unitQueue[k] <= 0) continue;
      const jet = (q & 1) === 1;
      const archetype = jet ? ARCHETYPE.GUARDIAN : ARCHETYPE.RUNNER;
      let at: MapPoint;
      let mode = UNIT_MODE_PATROL;
      let forward = false;
      if (q < QUEUE_OUTPOST) {
        at = jet ? map.bases[team].jetSpawn : map.bases[team].tankSpawn;
      } else {
        const o = (q - QUEUE_OUTPOST) >> 1;
        if (o >= map.outposts.length) {
          state.unitQueue[k] = 0; // no such outpost here
          continue;
        }
        at = jet ? map.outposts[o].jetSpawn[team] : map.outposts[o].tankSpawn[team];
        forward = true;
        if (jet) mode = UNIT_MODE_OUTPOST + o;
      }
      state.unitQueue[k] -= 1;
      if (countAliveOfArchetype(state, archetype, team) >= aliveLimit(archetype)) continue;
      const uid = spawnUnit(state, archetype, team, at.x, at.y, mode, forward, at.layer);
      if (uid < 0) {
        state.unitQueue[k] += 1; // the entity store is full: the next poll tries again
        continue;
      }
      // The captain's purchases announce themselves when they appear; a human's
      // was answered at the press.
      if (team === state.wardenPlayer) pushEvent(state.events, EV_PURCHASE, uid, team, archetype);
    }
  }
}

/**
 * Touching a heavy-unit zone: the type-14 pair test, the zone's radius plus the
 * mech's own, as an outpost pad's (the hit-box stage that may follow it was not
 * read; fcop-fidelity.md R10).
 */
function touchesHeavyZone(state: SimState, id: number, z: MapZone): boolean {
  return touchesZone(state, id, z.x, z.y, z.layer, z.radius);
}

/**
 * Inside a purchase spot's trigger box: the type-95 box about its console, its
 * half extents widened by the intruder's radius (as insideVolume measures a
 * gate; fcop-fidelity.md R17).
 */
function inBuyBox(x: number, y: number, r: number, c: MapPoint, box: MapBuyBox): boolean {
  const dx = x - c.x;
  const dy = y - c.y;
  const hw = box.halfW + r;
  const hl = box.halfL + r;
  return dx <= hw && dx >= -hw && dy <= hl && dy >= -hl;
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
  if (!hover) return g;
  const w = waterHeightAt(map, x, y);
  return g < w ? w : g;
}

/**
 * The surface a hover rides at (x, y) when it is at height `h`: what the
 * original's `terrain_surface_at` answers asked from HOVER_PROBE_LIFT above the
 * hover (`player_hover.c` 0x00442c09; fcop-fidelity.md P14). The highest deck
 * at or below that point, else the ground or the water over it (`rideHeight`)
 * — water lies on the ground surface only, a deck over it is a deck. On a map
 * without decks this is `rideHeight` exactly.
 */
export function hoverSurface(
  map: MapData,
  x: number,
  y: number,
  h: number,
): { layer: number; height: number } {
  const s = surfaceBelow(map, x, y, h + HOVER_PROBE_LIFT);
  if (s.layer === 0) s.height = rideHeight(map, x, y, true);
  return s;
}

/** Lift phases (SimState.liftPhase). */
export const LIFT_PARKED = 0;
export const LIFT_DWELL = 1;
export const LIFT_MOVING = 2;

/** The height of lift `k`'s top face now, m. */
export function liftTopHeight(state: SimState, k: number): number {
  const l = state.map.lifts[k];
  return l.ground + state.liftWu[k] / 8192 + l.top;
}

/** The surface a rider of lift `k` counts as standing on: its nearest stop's. */
function liftLayer(state: SimState, k: number): number {
  const l = state.map.lifts[k];
  const wu = state.liftWu[k];
  let best = 0;
  for (let i = 1; i < l.stops.length; i++) {
    if (Math.abs(l.stops[i] - wu) < Math.abs(l.stops[best] - wu)) best = i;
  }
  return l.layers[best];
}

/** Scratch for `avatarSurface` (the tick is synchronous and not re-entrant). */
const surf = { layer: 0, height: 0, lift: -1 };

/**
 * The surface a mech stands on (walker) or rides over (hover) at (x, y) at
 * height `h`: the map's (`resolveWalker` / `hoverSurface`) or the top of a lift
 * whose face covers (x, y) (within LIFT_RIM_SLACK), within the same reach above
 * the mech, whichever is
 * higher — the original's ground probe answers a lift (a carrier) as ground
 * (fcop-fidelity.md P12). `lift` names that lift, -1 for the map's surface.
 * Avatars only: units and tanks never ride a lift. Returns shared scratch.
 */
function avatarSurface(
  state: SimState,
  x: number,
  y: number,
  h: number,
  hover: boolean,
): typeof surf {
  const map = state.map;
  const s = hover ? hoverSurface(map, x, y, h) : resolveWalker(map, x, y, h);
  surf.layer = s.layer;
  surf.height = s.height;
  surf.lift = -1;
  const lifts = map.lifts;
  if (lifts.length === 0) return surf;
  const reach = h + (hover ? HOVER_PROBE_LIFT : LIFT_STEP_UP);
  for (let k = 0; k < lifts.length; k++) {
    const l = lifts[k];
    const rim = LIFT_RIM_SLACK;
    if (x < l.x0 - rim || x > l.x1 + rim || y < l.y0 - rim || y > l.y1 + rim) continue;
    const top = liftTopHeight(state, k);
    if (top > reach || top <= surf.height) continue;
    surf.layer = liftLayer(state, k);
    surf.height = top;
    surf.lift = k;
  }
  return surf;
}

/**
 * The mech stands in water: the original's surface code 1 reaches its feet
 * (fcop-fidelity.md P13). Over a water cell, with the cell's water surface
 * within SURFACE_REACH below the feet: a hover riding 0.5 m up is on it, a
 * walker on the plate or the bed is in it. Hk and Ovmp import the water plate
 * as deck 1 at the water level, so the deck a mech stands on does not decide
 * it; a deck over the water (a bridge) stands at least 0.59 m above it and is
 * dry by the height alone.
 */
function inWater(state: SimState, id: number, x: number, y: number): boolean {
  const map = state.map;
  if (!isWater(map, x, y)) return false;
  return state.ent.height[id] - waterHeightAt(map, x, y) < SURFACE_REACH;
}

/**
 * The surface over (x, y) as the drowning check asks for it
 * (`terrain_surface_at` from the mech's own position, player.c 0x00446e5d):
 * the cell's water where it is water, else the ground.
 */
function surfaceOver(map: MapData, x: number, y: number): number {
  const g = sampleHeight(map, x, y);
  if (!isWater(map, x, y)) return g;
  const w = waterHeightAt(map, x, y);
  return w > g ? w : g;
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

/**
 * Fill all three A magazines to their ceilings on the player's difficulty
 * (`cact_type99_ammo_add(slot, -1)`, the ceiling `cact_type99_ammo_cap`).
 */
function refillAmmo(state: SimState, player: number, id: number): void {
  const kit = loadoutOf(state, player);
  const d = state.difficulty[player];
  state.gunAmmo[player] = difficultyAmmo(kit.gun.a.ammoCap, d);
  state.ent.ammoA[id] = difficultyAmmo(kit.heavy.a.ammoCap, d);
  state.ent.ammoB[id] = difficultyAmmo(kit.special.a.ammoCap, d);
}

function loadoutOf(state: SimState, player: number) {
  return resolveLoadout(
    {
      gun: state.loadoutGun[player],
      heavy: state.loadoutHeavy[player],
      special: state.loadoutSpecial[player],
    },
    state.extraWeapons,
  );
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
  held: number,
): void {
  const ent = state.ent;
  decayCooldown(ent.cooldownA, id);
  decayCooldown(ent.cooldownB, id);
  decayCooldown(ent.cooldownC, id);

  // No pad refills or repairs a mech, at a base or an outpost: the original
  // has none (fcop-fidelity.md P1, R14). Ammo comes back from the ammo pickups
  // and at a respawn, health from the health pickup and a respawn.

  // `player_fire_buttons`: Gun and Heavy fire on every tick they are down,
  // paced by their cooldowns. Special fires from its latch: in the HELD state —
  // the second tick it is down, never the tick it goes down, so a one-tick tap
  // fires nothing — unless a slot's block A keeps its round (flag 4: the Plasma
  // Flare and the Grenade Launcher, extra weapons), which makes it fire on the
  // press.
  const kit = loadoutOf(state, player);
  if ((buttons & BTN_GUN) !== 0) fireSlot(state, player, id, 0, kit.gun);
  if ((buttons & BTN_HEAVY) !== 0) fireSlot(state, player, id, 1, kit.heavy);
  const keeps =
    ((kit.gun.a.flags | kit.heavy.a.flags | kit.special.a.flags) & WEAPON_FLAG_KEEP) !== 0;
  if (((keeps ? pressed : held) & BTN_SPECIAL) !== 0) {
    fireSlot(state, player, id, 2, kit.special);
  }
}

/** Block A flag 4: the round is kept, and Special becomes press-to-fire. */
const WEAPON_FLAG_KEEP = 4;
/** Flag 2: a guided round's blast falls off with the distance flown (CACT_MISSILE_FALLOFF). */
const WEAPON_FLAG_FALLOFF = 2;

/**
 * One slot's trigger, `player_fire_slot` (retail 0x00458ed0): refused while its
 * cooldown is above zero or its magazine is empty; otherwise the shot goes out,
 * one round is spent, and the burst counter picks the gap the cooldown GAINS —
 * the round gap inside a burst, the burst gap after its last round.
 */
function fireSlot(state: SimState, player: number, id: number, slot: number, w: WeaponDef): void {
  const ent = state.ent;
  // The Special with a kept round alive sets it off instead, before the
  // cooldown is read; a stale one is only forgotten (0x00458f06).
  if (slot === 2 && state.keptRound[player] >= 0) {
    const kept = state.keptRound[player];
    state.keptRound[player] = -1;
    if (keptAlive(state, player, kept)) {
      detonateKept(state, player, kept);
      return;
    }
  }
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
 * weapons.md §6): block B's magazine to its ceiling on the player's difficulty
 * (`cact_type99_fill_b` -> `cact_type99_ammo_cap(.., 1)`). A slot that was not
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
    state.extraWeapons,
  );
  if (state.powerAmmo[k] === 0) state.burstLeft[k] = w.b.rounds;
  state.powerAmmo[k] = difficultyAmmo(w.b.ammoCap, state.difficulty[player]);
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
        BLAST_FLAT | BLAST_RIVAL,
      );
      return true;
    }
    case "mine": {
      if (!spawnMine(state, shooter, player, w.projKind, blk)) return false;
      pushEvent(state.events, EV_SHOT, shooter, slot, weaponShotPayload(w.id, 0, powered));
      return true;
    }
    case "sphere": {
      // The Riot Shield: the toggle's answer is the shot's (0x00459575), but
      // the block's fire sound plays on every call, before the kind's switch
      // (0x004591f1) — the call that puts the sphere down included.
      const up = shieldToggle(state, player, blk, powered);
      pushEvent(state.events, EV_SHOT, shooter, slot, weaponShotPayload(w.id, 0, powered));
      return up;
    }
    case "drone": {
      if (spawnGuided(state, shooter, player, w, blk, lock) < 0) return false;
      pushEvent(state.events, EV_SHOT, shooter, slot, weaponShotPayload(w.id, 0, powered));
      return true;
    }
    case "bounce": {
      const id = spawnBounce(state, shooter, player, w, blk, lock);
      if (id < 0) return false;
      if ((blk.flags & WEAPON_FLAG_KEEP) !== 0) state.keptRound[player] = id;
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
      const flags =
        (blk.kind === KIND_ARCED_CLUSTER ? ROUND_ARC | ROUND_CLUSTER : ROUND_ARC) | ROUND_RIVAL;
      const id = spawnArced(state, x, y, h, tx, ty, th, blk.launchSpeed, blk.gravity);
      if (id < 0) return false;
      armRound(state, id, shooter, player, w.projKind, blk, flags, -1);
      // The Plasma Flare keeps its shell for the second press.
      if ((blk.flags & WEAPON_FLAG_KEEP) !== 0) state.keptRound[player] = id;
      pushEvent(state.events, EV_SHOT, shooter, slot, weaponShotPayload(w.id, 0, powered));
      return true;
    }
    default: {
      // The Fusion Torpedo flies the original's guided round (missile.c), the
      // K-9 Drone's model without the ground hugging.
      if (w.projKind === PROJ_TORPEDO) {
        if (spawnGuided(state, shooter, player, w, blk, lock) < 0) return false;
        pushEvent(state.events, EV_SHOT, shooter, slot, weaponShotPayload(w.id, 0, powered));
        return true;
      }
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
        const flags = (homing ? ROUND_HOMING : 0) | ROUND_RIVAL;
        armRound(state, id, shooter, player, w.projKind, blk, flags, lock);
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
    blastAt(
      state,
      ex,
      ey,
      ent.team[shooter],
      player,
      blk.damage,
      blk.blast,
      PROJ_SPLASH,
      BLAST_RIVAL,
    );
  } else if (lock >= 0) {
    applyDamage(state, lock, blk.damage, player, true);
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
  blastAt(
    state,
    ex,
    ey,
    ent.team[shooter],
    player,
    blk.damage,
    blk.blast,
    PROJ_BEAM,
    BLAST_EMIT | BLAST_RIVAL,
  );
}

/** blastAt options. */
const BLAST_EMIT = 1;
/** Metropolis' flat pulse (radius + the target's own) instead of the original's falloff. */
const BLAST_FLAT = 2 | BLAST_EMIT;
/**
 * The blast is an avatar's own craft's (the Sky Captain's bomb, an X1-Alpha's
 * weapon or round): see applyDamage's `byRival`.
 */
const BLAST_RIVAL = 4;

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
  const byRival = (opts & BLAST_RIVAL) !== 0;
  for (let t = 0; t < ent.high; t++) {
    if (!ent.alive[t]) continue;
    if (ent.team[t] === team) continue;
    if (ent.archetype[t] === ARCHETYPE.PROJECTILE) continue;
    const dx = ent.posX[t] - x;
    const dy = ent.posY[t] - y;
    const d2 = dx * dx + dy * dy;
    if (flat) {
      const r = radius + entityRadius(state, t);
      if (d2 <= r * r) applyDamage(state, t, damage, owner, byRival);
    } else if (d2 < radius * radius) {
      const dmg = Math.floor((damage * (radius - Math.sqrt(d2))) / radius);
      if (dmg > 0) applyDamage(state, t, dmg, owner, byRival);
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
 * Fired by an avatar's own craft — the Sky Captain's missile and bomb, an
 * X1-Alpha's rounds and mines: the original's round carries its owner's id
 * (`round_spawn.c`), which is what the down's credit reads (SimState.rivalHit).
 */
const ROUND_RIVAL = 16;
/** The original's guided ordnance (the K-9 Drone, the Fusion Torpedo): guidedTick. */
const ROUND_GUIDED = 32;
/** The bouncing round (the Grenade Launcher): bounceTick. */
const ROUND_BOUNCE = 64;
/** A kept arced round the second press set off: it goes where it is, this tick. */
const ROUND_DETONATE = 128;
/** A guided round whose blast falls off with the distance flown (the Fusion Torpedo). */
const ROUND_FALLOFF = 256;

/**
 * A projectile's fields (the PROJECTILE archetype reuses the store):
 *   mode       payload kind (renderer + explosion kind)
 *   velX/velY  horizontal velocity, m/s
 *   timerA     ticks left before it expires (a bouncing round or a mine: engine units)
 *   timerB     vertical velocity, m/s (a bouncing round or a mine: world units a second)
 *   cooldownA  current speed, m/s (a mine: 1 once sprung)
 *   cooldownB  flight distance left, m (0 = no limit)
 *   cooldownC  homing target id, -1 none (a mine: its trigger radius, m; 0 once sprung)
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
  return spawnStraightAt(
    state,
    ent.team[shooter],
    ent.posX[shooter] + dx * MUZZLE_OFFSET,
    ent.posY[shooter] + dy * MUZZLE_OFFSET,
    ent.height[shooter] + MUZZLE_HEIGHT,
    dx,
    dy,
    homeOn,
    aimAt,
  );
}

/** spawnStraight from the muzzle point (x, y, h) for `team`. */
function spawnStraightAt(
  state: SimState,
  team: number,
  x: number,
  y: number,
  h: number,
  dx: number,
  dy: number,
  homeOn: number,
  aimAt: number,
): number {
  const ent = state.ent;
  const id = spawn(ent, ARCHETYPE.PROJECTILE, team);
  if (id < 0) return -1;
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
    if (d > 0.5) ent.timerB[id] = (ent.height[aimAt] + entityRefHeight(state, aimAt) - h) / d; // per metre
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
  return leadAimFrom(state, state.ent.posX[shooter], state.ent.posY[shooter], target, speed);
}

/** leadAim from the point (x, y). */
function leadAimFrom(
  state: SimState,
  x: number,
  y: number,
  target: number,
  speed: number,
): boolean {
  const ent = state.ent;
  const px = ent.posX[target] - x;
  const py = ent.posY[target] - y;
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
 * Drop a Pop-Up Mine (`cact_round_spawn_dropped` 0x0044d6a0, RE M3-OP): the
 * bouncing round's class, left at the muzzle with no velocity under the
 * spawner's fixed gravity (MINE_GRAVITY, 0x0044d746), its record's lifetime
 * (+0x18, the engine units `fuseUnits` holds: 1503) and its record's reach as
 * the fuse (+0x10, 2 m). It falls and bounces as the grenade does and goes off
 * where it settles (mineTick); there is no arming delay -- its owner's side
 * never springs it.
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
  ent.posX[id] = ent.posX[shooter] + ent.aimX[shooter] * MUZZLE_OFFSET;
  ent.posY[id] = ent.posY[shooter] + ent.aimY[shooter] * MUZZLE_OFFSET;
  ent.height[id] = ent.height[shooter] + MUZZLE_HEIGHT;
  ent.yaw[id] = ent.yaw[shooter];
  ent.hp[id] = 1;
  ent.mode[id] = kind;
  ent.velX[id] = 0;
  ent.velY[id] = 0;
  ent.timerB[id] = 0; // vertical velocity, world units a second
  ent.aimX[id] = MINE_GRAVITY;
  ent.timerA[id] = blk.fuseUnits; // its lifetime, engine units
  ent.cooldownA[id] = 0; // not sprung
  ent.cooldownC[id] = blk.reach; // the fuse's reach, m
  ent.ammoA[id] = blk.damage;
  ent.aux[id] = blk.blast;
  ent.ammoB[id] = ROUND_RIVAL; // the mech's own, for the down's credit
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
    const r = entityRadius(state, id);
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
    // way to it means the shot hits the wall and nothing else. The Sky
    // Captain's gun too: it fires and draws its tracer anyway, but sends
    // damage only along a clear terrain line (`discharge.c` 0x0044dbed). Its
    // v24 pierce at ground units went in SIM_VERSION 54.
    if (segmentBlocked(state.map, ox, oy, ox + dx * bestT, oy + dy * bestT)) {
      return;
    }
    const arch = ent.archetype[shooter];
    applyDamage(
      state,
      bestId,
      damage,
      player,
      arch === ARCHETYPE.WARDEN || arch === ARCHETYPE.AVATAR,
    );
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
  ent.ammoB[id] = ROUND_RIVAL; // linear falloff, as the original's area damage
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
  state.roundFrom[p] = roundSource(ent.archetype[shooter], ent.team[shooter]);
  ent.ownerId[p] = ent.ownerId[shooter];
  ent.ammoA[p] = SKY_MISSILE_DAMAGE;
  ent.aux[p] = 0;
  ent.ammoB[p] = ROUND_HOMING | ROUND_RIVAL;
  ent.timerA[p] = Math.ceil((SKY_MISSILE_FLIGHT / speed) * TICK_HZ) + 1;
  ent.cooldownA[p] = speed;
  ent.velX[p] = dx * speed;
  ent.velY[p] = dy * speed;
  ent.cooldownB[p] = SKY_MISSILE_FLIGHT;
  ent.aimX[p] = speed;
  ent.aimY[p] = 0;
  pushEvent(state.events, EV_SHOT, shooter, SHOT_SLOT_LAUNCH, SKY_WEAPON_MISSILE);
}

/**
 * Entity `id`'s hit radius, the original's `radius_68` of the model and frame it
 * is on (balance.ts ARCHETYPE_RADIUS, MapData.radii; fcop-fidelity.md G1): the
 * mech by its form (the legs at the walker's pose, folded in hover); a
 * Dreadnought on a hull that walks by the frame its walk shows (I6: the type-28
 * tick re-reads the box each frame, `type5_model_select`); every other body as
 * it was spawned — its arena's own model for its role, a neutral turret by its
 * spot's set, the Sky Captain by its level's model; the archetype's default for
 * anything spawned without one (projectiles, consoles, the sandbox).
 */
export function entityRadius(state: SimState, id: number): number {
  const ent = state.ent;
  const arch = ent.archetype[id];
  if (arch === ARCHETYPE.AVATAR) {
    return ent.mode[id] === MODE_HOVER ? state.map.radii.hover : state.map.radii.walker;
  }
  if (arch === ARCHETYPE.JUGGERNAUT) {
    const byFrame = state.map.radii.dreadnoughtByFrame;
    const team = ent.team[id];
    const walk = team === 0 || team === 1 ? state.hullWalk[team] : null;
    if (walk && byFrame.length > 0) return byFrame[walk.frame[id]];
  }
  const r = ent.radius[id];
  if (r > 0) return r;
  if (arch === ARCHETYPE.TURRET && ent.mode[id] !== TURRET_DEFENSE) return NEUTRAL_TURRET_RADIUS;
  return ARCHETYPE_RADIUS[arch];
}

/**
 * How far `id`'s reference point stands above its height, metres: what the
 * original aims at and measures to (`previous`, box 0 of the model's frame
 * placed through the orientation — player.c 0x0044702f, turret.c, aircraft.c,
 * mount.c). The mech's follows its form and a walking hull's its frame, as
 * their radii do; a body with none imported stands at MUZZLE_HEIGHT.
 */
export function entityRefHeight(state: SimState, id: number): number {
  const ent = state.ent;
  const arch = ent.archetype[id];
  const refs = state.map.refHeights;
  if (arch === ARCHETYPE.AVATAR) return ent.mode[id] === MODE_HOVER ? refs.hover : refs.walker;
  if (arch === ARCHETYPE.JUGGERNAUT) {
    const byFrame = refs.dreadnoughtByFrame;
    const team = ent.team[id];
    const walk = team === 0 || team === 1 ? state.hullWalk[team] : null;
    if (walk && byFrame.length > 0) return byFrame[walk.frame[id]];
  }
  const h = ent.refHeight[id];
  return Number.isNaN(h) ? MUZZLE_HEIGHT : h;
}

/**
 * Damage bookkeeping; deaths are collected by systemDamageDeath afterwards.
 * `byRival` says the hit is an avatar's own craft's — the Sky Captain's gun,
 * missile or bomb, or an X1-Alpha's weapons and their rounds — which a player's
 * mech remembers for its down (SimState.rivalHit).
 */
function applyDamage(
  state: SimState,
  target: number,
  damage: number,
  attacker: number,
  byRival = false,
): void {
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
  // The Sky Captain remembers its killing hit too (+0x8c, `cact_base_op9`
  // 0x0041a707), which its death reads for the X1's Walker Kills.
  if (ent.archetype[target] === ARCHETYPE.AVATAR || ent.archetype[target] === ARCHETYPE.WARDEN) {
    const p = ent.ownerId[target];
    if (p >= 0 && p < MAX_PLAYERS && state.avatarId[p] === target) {
      state.rivalHit[p] = byRival ? 1 : 0;
    }
  }
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
    } else if (archetype === ARCHETYPE.JUGGERNAUT) {
      shooterDreadnought(state, id, w);
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
 * - the gun slews toward its target at the original's turn rate every tick,
 *   and with none — dropped by its due round, or dead (forgetTurretTarget) —
 *   back toward its rest yaw at the same rate (turretRest);
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
    else turretRest(ent, id, w);
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
  if (target < 0) {
    // The round waits, the clock stopped, and the gun turns back to rest.
    turretRest(ent, id, w);
    return;
  }
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
  fireRound(state, id, target, w);
}

/** A turret's gun follows its target at the record's turn rate (instant without one). */
function turretSlew(state: SimState, id: number, target: number, w: MapWeapon): void {
  const ent = state.ent;
  const bearing = atan2Poly(ent.posY[target] - ent.posY[id], ent.posX[target] - ent.posX[id]);
  if (w.turnSpeed > 0) slewTo(ent, id, bearing, w.turnSpeed);
  else ent.yaw[id] = bearing;
}

/**
 * A turret's gun whose target is gone turns back to its rest yaw, the record's
 * angle it was built at (EntityStore.restYaw), at the same rate it aims by
 * (`turret_tick` 0x0041c680, RE turret.c 1157-1175: with its shooter's target
 * null or its serial changed the yaw wanted is `rest_yaw`, no pitch; the turn
 * `turret_turn`, at most `turn_rate * dt` and never past it). Every PA record
 * aims by its shooter's target (record flag 0x01, TURRET_DF_SHOOTER_TARGET) and
 * none sets 0x20, the 3/16-turn hold about the rest yaw (TURRET_DF_ARC), so
 * neither the search's sweep nor the hold is reachable (fcop-fidelity.md G12).
 */
function turretRest(ent: EntityStore, id: number, w: MapWeapon): void {
  const rest = ent.restYaw[id];
  if (w.turnSpeed > 0) slewTo(ent, id, rest, w.turnSpeed);
  else ent.yaw[id] = rest;
}

/**
 * A death as every turret sees it: the original's turret checks its shooter's
 * target against the serial it took every tick (`turret_tick` 0x0041c4bb), and
 * `cact_kill` zeroes the dead actor's serial, so from the next tick no turret
 * aims at it — even where the sim has reused its id by then (the free-list is
 * LIFO, and a round usually takes it). Clears each turret's target naming `id`;
 * its next due round searches, as the original's does on the serial's mismatch.
 */
export function forgetTurretTarget(ent: EntityStore, id: number): void {
  const ref = id + 1;
  for (let t = 0; t < ent.high; t++) {
    if (ent.alive[t] && ent.archetype[t] === ARCHETYPE.TURRET && ent.cooldownC[t] === ref) {
      ent.cooldownC[t] = 0;
    }
  }
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
 * only. The Juggernaut's guns are its mounts' own (shooterDreadnought).
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
  fireRound(state, id, target, w);
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
 * Discharges a round along aimScratch: a projectile entity at the entry's speed
 * (no acceleration), flying its range, homing on `target` when guided, and
 * damaging only what it strikes (no PA world weapon has a blast). Its EV_SHOT is
 * a muzzle flash — the round renders as its own entity. The rate machine goes
 * between bursts once it went out; a full entity store fires nothing and leaves
 * the round due.
 */
function fireRound(state: SimState, id: number, target: number, w: MapWeapon): void {
  const p = spawnStraight(
    state,
    id,
    aimScratch.x,
    aimScratch.y,
    w.guided === 1 ? target : -1,
    target,
  );
  if (p < 0) return;
  armWorldRound(state, id, p, w);
  state.ent.aimY[id] = PHASE_BETWEEN;
}

/** Stamps world round `p`, fired by `id` along aimScratch, with entry `w`. */
function armWorldRound(state: SimState, id: number, p: number, w: MapWeapon): void {
  const ent = state.ent;
  ent.mode[p] = PROJ_ROUND;
  state.roundFrom[p] = roundSource(ent.archetype[id], ent.team[id]);
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
}

/** Scratch: a gun's mount and muzzle in the world (module scope, no allocation per tick). */
const gunScratch = { x: 0, y: 0, h: 0, mx: 0, my: 0, mh: 0 };

/**
 * Places Juggernaut `id`'s mount `m` in the world — a hull-frame point at hull +
 * z * forward + x * (sin yaw, -cos yaw), the frame the client draws the hull's
 * glb in (`cact_model_point`, turret.c 241-335), the point of the hull's
 * `frame` where it walks (the model's 3DRF of +0x70) — and its muzzle, the gun
 * model's point 0, turned by the gun's world yaw `gunYaw`, into gunScratch.
 */
function placeGun(
  ent: EntityStore,
  id: number,
  m: MapGunMount,
  frame: number,
  gunYaw: number,
): void {
  const c = cosLUT(ent.yaw[id]);
  const s = sinLUT(ent.yaw[id]);
  // The hull's point in the frame it shows (a walking hull's), else its one.
  const f = m.frames;
  const p = f !== undefined && frame >= 0 && frame < f.length ? f[frame] : m;
  gunScratch.x = ent.posX[id] + p.z * c + p.x * s;
  gunScratch.y = ent.posY[id] + p.z * s - p.x * c;
  gunScratch.h = ent.height[id] + p.y;
  const gc = cosLUT(gunYaw);
  const gs = sinLUT(gunYaw);
  gunScratch.mx = gunScratch.x + m.mz * gc + m.mx * gs;
  gunScratch.my = gunScratch.y + m.mz * gs - m.mx * gc;
  gunScratch.mh = gunScratch.h + m.my;
}

/** An angle in radians as the original's 12-bit angle units, 0..4095. */
function angleUnits(rad: number): number {
  return Math.floor(rad / ANGLE_UNIT) & 4095;
}

/** A gun's relative yaw in radians, (-PI, PI], the entity yaw's sense. */
export function gunYawRadians(units: number): number {
  return (units > 2048 ? units - 4096 : units) * ANGLE_UNIT;
}

/**
 * `cact_mount_turn_toward` (mount.c 0x00425a85): from `current` toward `desired`
 * by at most `limit` units on the shorter arc, in 12-bit angle units.
 */
function mountTurnToward(current: number, desired: number, limit: number): number {
  if (current === desired) return current;
  let gap = (desired - current) & 4095;
  if (gap > 2048) gap -= 4096;
  const magnitude = gap < 0 ? -gap : gap;
  let step = limit > magnitude ? magnitude : limit;
  if (gap < 0) step = -step;
  return (step + current) & 4095;
}

/** The rate machine (shooterDue) on gun `k`'s own clock and phase. */
function gunDue(state: SimState, k: number, w: MapWeapon): boolean {
  let phase = state.gunPhase[k];
  let clock = state.gunClock[k];
  if (phase === PHASE_INSIDE) {
    clock += WEAPON_UNITS_PER_TICK;
    if (clock >= 0) phase = PHASE_DUE;
  } else if (phase === PHASE_BETWEEN) {
    clock += WEAPON_UNITS_PER_TICK;
    if (clock >= w.refireUnits) {
      clock -= w.refireUnits;
      if (clock > 0) clock = 0;
      phase = PHASE_INSIDE;
    }
  }
  state.gunPhase[k] = phase;
  state.gunClock[k] = clock;
  return phase === PHASE_DUE;
}

/**
 * The Dreadnought's guns (fcop-fidelity.md I6): four mounts, each its own
 * `cact_mount_step` (mount.c 0x004258d0) and its own shooter on the hull's
 * weapon profile, in gun order:
 * - the mount stands on its hull point — the point of the frame the hull's walk
 *   shows, on a hull that walks (Joke's; op 6 runs the hull's type-5 tick first,
 *   mount.c 1019-1030) — and turns toward its target — the bearing
 *   from the mount less the hull's yaw — or home, the hull's forward, with none,
 *   at `gunTurn` angle units per 1/300 s (237.3°/s; mount.c 0x00425ad4, 1136);
 * - then its shooter (`cact_shooter_step`): the rate machine; a due round drops
 *   a dead, no-longer-hostile or out-of-reach target, searching from the mount
 *   on the countdown when it has none; it goes out from the gun's muzzle only
 *   inside the gun's front sector, ±22.5° about its own yaw (`discharge.c`
 *   949-977), along a clear line, else it is put back and tried 0-0.85 s later.
 * The hull itself carries no gun and never turns to a target.
 */
function shooterDreadnought(state: SimState, id: number, w: MapWeapon): void {
  const ent = state.ent;
  const team = ent.team[id];
  if (team !== 0 && team !== 1) return;
  const dread = state.map.bases[team].juggernaut;
  const turn = dread.gunTurn * FRAME_CLOCK_PER_TICK;
  // The frame the hull's walk shows this tick (cact_model_point reads +0x70).
  const walk = state.hullWalk[team];
  const frame = walk ? walk.frame[id] : 0;
  for (let g = 0; g < dread.guns; g++) {
    const k = id * DREADNOUGHT_GUNS + g;
    const m = dread.mounts[g];
    let target = state.gunTarget[k] - 1;
    if (target >= 0 && !ent.alive[target]) target = -1;
    // The mount: on its point, turned toward its target or home.
    placeGun(ent, id, m, frame, ent.yaw[id] + state.gunYaw[k] * ANGLE_UNIT);
    let desired = 0;
    if (target >= 0) {
      const bearing = atan2Poly(ent.posY[target] - gunScratch.y, ent.posX[target] - gunScratch.x);
      desired = angleUnits(bearing - ent.yaw[id]);
    }
    state.gunYaw[k] = mountTurnToward(state.gunYaw[k], desired, turn);
    // Its shooter.
    if (!gunDue(state, k, w)) {
      state.gunTarget[k] = target + 1;
      continue;
    }
    if (target >= 0 && !targetValidFrom(state, team, gunScratch.x, gunScratch.y, target, w.range)) {
      target = -1;
    }
    if (target < 0) {
      let search = state.gunSearch[k] - WEAPON_UNITS_PER_TICK;
      if (search < 0) {
        search = w.searchUnits;
        target = nearestEnemyFrom(state, id, gunScratch.x, gunScratch.y, w.range);
      }
      state.gunSearch[k] = search;
    }
    state.gunTarget[k] = target + 1;
    if (target < 0) continue; // the round waits, the clock stopped
    const yaw = ent.yaw[id] + state.gunYaw[k] * ANGLE_UNIT;
    placeGun(ent, id, m, frame, yaw);
    if (!aimFrom(state, gunScratch.mx, gunScratch.my, target, w)) continue;
    const blocked = segmentBlocked(
      state.map,
      gunScratch.mx,
      gunScratch.my,
      ent.posX[target],
      ent.posY[target],
    );
    if (blocked || aimScratch.x * cosLUT(yaw) + aimScratch.y * sinLUT(yaw) < w.arcCos) {
      state.gunPhase[k] = PHASE_INSIDE;
      state.gunClock[k] -= Math.floor(rand01(state) * SHOOTER_RETRY_UNITS);
      continue;
    }
    const p = spawnStraightAt(
      state,
      team,
      gunScratch.mx,
      gunScratch.my,
      gunScratch.mh,
      aimScratch.x,
      aimScratch.y,
      w.guided === 1 ? target : -1,
      target,
    );
    if (p < 0) continue;
    armWorldRound(state, id, p, w);
    state.gunPhase[k] = PHASE_BETWEEN;
  }
}

/** shooterTargetValid measured from (x, y): alive, still an enemy, inside reach. */
function targetValidFrom(
  state: SimState,
  team: number,
  x: number,
  y: number,
  t: number,
  range: number,
): boolean {
  const ent = state.ent;
  if (!ent.alive[t] || ent.hp[t] <= 0 || ent.archetype[t] === ARCHETYPE.PROJECTILE) return false;
  const tt = ent.team[t];
  if (tt === team || tt === TEAM_NEUTRAL) return false;
  const dx = ent.posX[t] - x;
  const dy = ent.posY[t] - y;
  return dx * dx + dy * dy < range * range;
}

/** aimRound measured from (x, y). */
function aimFrom(state: SimState, x: number, y: number, target: number, w: MapWeapon): boolean {
  if (w.lead === 1 && leadAimFrom(state, x, y, target, w.speed)) {
    aimScratch.x = leadScratch.x;
    aimScratch.y = leadScratch.y;
    return true;
  }
  const ent = state.ent;
  const dx = ent.posX[target] - x;
  const dy = ent.posY[target] - y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return false;
  aimScratch.x = dx / len;
  aimScratch.y = dy / len;
  return true;
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
 * Mines fall, bounce, and blow where they settle unless an enemy springs them.
 */

// --- The five extra weapons (SimOptions.extraWeapons, SIM_VERSION 90) --------
//
// Each runs the original's own code for its kind, read off the RE's
// decompilation: the Riot Shield the sustained sphere (`sustain_sphere.c`), the
// K-9 Drone and the Fusion Torpedo the guided ordnance actor (`missile.c`), the
// Grenade Launcher the bouncing round (`type15.c`), the Plasma Flare the arced
// shell the Mortar already fires, kept for the second press. None of it runs
// in a match without the bits: every guard below reads `state.extraWeapons`
// or a round flag only these weapons set.

/** The frame clock (DAT_00511ee4) the sustained effects compare against. */
function engineClock(state: SimState): number {
  return state.tick * WEAPON_UNITS_PER_TICK;
}

/** A 32-bit value as the original's 16-bit word. */
function i16(v: number): number {
  return (v << 16) >> 16;
}

/**
 * The Riot Shield's sphere per player: `sustain_sphere` (0x1b0 bytes; one of the
 * unit's four slots, a player's own). Hashed in a match with extra weapons.
 */
export interface ShieldState {
  /** SHIELD_ON | SHIELD_B | SHIELD_MADE (`state` +0x52, and whether a record exists). */
  readonly flags: Uint8Array;
  /** Radius, its spring rate and target, the reach box and the hurt: raw words (512 a metre). */
  readonly radius: Int16Array;
  readonly rate: Int16Array;
  readonly target: Int16Array;
  readonly reach: Int16Array;
  readonly amount: Int16Array;
  /** `hold_until`, `spend_period`, `spend_next`: engine units on the frame clock. */
  readonly hold: Int32Array;
  readonly period: Int32Array;
  readonly spendNext: Int32Array;
  /** `byte_1ae`, the flash's draws left. Presentation only, NOT hashed. */
  readonly flash: Uint8Array;
  /** The twelve arcs per player (`sustain_sphere_arc`): direction in the sphere's axes. */
  readonly arcDir: Float32Array;
  /** Their angle pairs (12-bit angles, `phase` picks the one written next). */
  readonly arcYaw: Int16Array;
  readonly arcPitch: Int16Array;
  readonly arcNext: Int32Array;
  readonly arcPhase: Uint8Array;
  readonly arcCharged: Uint8Array;
}

const SHIELD_ON = 1;
const SHIELD_B = 4;
const SHIELD_MADE = 0x80;

function createShieldState(): ShieldState {
  const arcs = MAX_PLAYERS * SHIELD_ARCS;
  return {
    flags: new Uint8Array(MAX_PLAYERS),
    radius: new Int16Array(MAX_PLAYERS),
    rate: new Int16Array(MAX_PLAYERS),
    target: new Int16Array(MAX_PLAYERS),
    reach: new Int16Array(MAX_PLAYERS),
    amount: new Int16Array(MAX_PLAYERS),
    hold: new Int32Array(MAX_PLAYERS),
    period: new Int32Array(MAX_PLAYERS),
    spendNext: new Int32Array(MAX_PLAYERS),
    flash: new Uint8Array(MAX_PLAYERS),
    arcDir: new Float32Array(arcs * 3),
    arcYaw: new Int16Array(arcs * 2),
    arcPitch: new Int16Array(arcs * 2),
    arcNext: new Int32Array(arcs),
    arcPhase: new Uint8Array(arcs),
    arcCharged: new Uint8Array(arcs),
  };
}

/**
 * `sustain_sphere_create` (0x0044bf70) for a player: nothing switched on, every
 * counter zero, the twelve arcs as `sustain_sphere_arc_init` (0x0044c1c0) leaves
 * them — direction (0, 0, 1), the first angle pair zero, phase 1. Its radius
 * target is the toggle's to take.
 */
function shieldCreate(state: SimState, p: number): void {
  const s = state.shield;
  s.flags[p] = SHIELD_MADE;
  s.hold[p] = 0;
  s.radius[p] = 0;
  s.rate[p] = 0;
  s.amount[p] = 0;
  s.spendNext[p] = 0;
  for (let k = 0; k < SHIELD_ARCS; k++) {
    const i = p * SHIELD_ARCS + k;
    s.arcNext[i] = 0;
    s.arcYaw[i * 2] = 0;
    s.arcPitch[i * 2] = 0;
    s.arcPhase[i] = 1;
    s.arcCharged[i] = 0;
    s.arcDir[i * 3] = 0;
    s.arcDir[i * 3 + 1] = 0;
    s.arcDir[i * 3 + 2] = 1;
  }
}

/**
 * The toggle's three numbers (0x0044c248..0x0044c276): the radius target, the
 * reach box (the second word, or 8/5 of the radius when that is larger) and
 * the hurt, all sixteen bits.
 */
function shieldTakeStats(state: SimState, p: number, r: WeaponRecord): void {
  const s = state.shield;
  s.target[p] = r.w0e;
  s.reach[p] = r.w10 < r.w0e ? i16(Math.trunc((r.w0e * 8) / 5)) : r.w10;
  s.amount[p] = r.damage;
}

/**
 * The Riot Shield's trigger, `sustain_sphere_toggle`'s player arm (0x0044c1f0):
 * past the hold the sphere flips; every call renews the hold, so a held trigger
 * flips it once and a fresh press after a release flips it back. On, it takes
 * the block's numbers (B's while the slot is powered: the whole sphere and the
 * arcs) and answers true — the caller spends a round and its gap. Off, false.
 */
function shieldToggle(state: SimState, p: number, blk: WeaponBlock, powered: boolean): boolean {
  const s = state.shield;
  if ((s.flags[p] & SHIELD_MADE) === 0) {
    shieldCreate(state, p);
    shieldTakeStats(state, p, blk.rec);
  }
  const now = engineClock(state);
  if (now > s.hold[p]) s.flags[p] ^= SHIELD_ON;
  s.hold[p] = now + SHIELD_HOLD_UNITS;
  if ((s.flags[p] & SHIELD_ON) === 0) return false;
  s.period[p] = blk.roundGap;
  if (powered) s.flags[p] |= SHIELD_B;
  else s.flags[p] &= ~SHIELD_B;
  shieldTakeStats(state, p, blk.rec);
  return true;
}

/**
 * The fold of an arc's angle (0x0044cbec / 0x0044cc35): past `q` reflected about
 * it, one short of -q about that — one reflection, in sixteen bits.
 */
function arcFold(angle: number, q: number): number {
  const a = angle & 0xffff;
  if (i16(q - a) < 0) return i16(2 * q - a);
  if (i16(a + q) < 0) return i16(-2 * q - a);
  return angle;
}

/**
 * One arc, `sustain_sphere_arc_step` (0x0044caf0): past its time it waits 0x3f
 * plus `rand & 0x7f` more, jitters both angles by `rand >> 22` (up to an eighth
 * of a turn either way), folds the yaw to the front half on a half sphere and
 * the pitch to +-0x200 (the player's patch is built ramped), takes row 2 of the
 * angles' matrix as its direction and, one time in eight, charges.
 */
function shieldArcStep(state: SimState, p: number, k: number, half: boolean, now: number): void {
  const s = state.shield;
  const i = p * SHIELD_ARCS + k;
  if (now <= s.arcNext[i]) return;
  const phase = s.arcPhase[i];
  const next = phase ^ 1;
  s.arcNext[i] = (randU32(state) & SHIELD_ARC_WAIT_MASK) + now + SHIELD_ARC_WAIT_BASE;
  // The old point is the pair the current direction came from (`next`).
  const oldYaw = s.arcYaw[i * 2 + next];
  const oldPitch = s.arcPitch[i * 2 + next];
  let yaw = i16(((randU32(state) | 0) >> 22) + oldYaw);
  let pitch = i16(((randU32(state) | 0) >> 22) + oldPitch);
  if (half) yaw = arcFold(yaw, 0x400);
  pitch = arcFold(pitch, 0x200);
  s.arcYaw[i * 2 + phase] = yaw;
  s.arcPitch[i * 2 + phase] = pitch;
  // The link from the old point to the new (0x0044cd3e).
  pushEvent(
    state.events,
    EV_SHIELD_ARC_STEP,
    state.avatarId[p],
    packArcAngles(oldYaw, oldPitch),
    packArcAngles(yaw, pitch),
  );
  // Row 2 of `math_matrix_from_angles(yaw, pitch, 0)`: (cx sy, -sx, cx cy).
  const cp = cosUnits(pitch);
  s.arcDir[i * 3] = cp * sinUnits(yaw);
  s.arcDir[i * 3 + 1] = -sinUnits(pitch);
  s.arcDir[i * 3 + 2] = cp * cosUnits(yaw);
  s.arcPhase[i] = next;
  if ((randU32(state) & 7) === 7) s.arcCharged[i] = 1;
}

/**
 * `sustain_sphere_take_arc` (0x0044c9f0) on the whole sphere: the first charged
 * arc, refused (and left charged) when the actor at (dx, dy, dh) from the centre
 * lies behind its point; else its charge is spent. The sphere's axes are the
 * mech's: x its right, y up, z its facing. Answers the arc taken, or -1.
 */
function shieldTakeArc(
  state: SimState,
  p: number,
  dx: number,
  dy: number,
  dh: number,
  fx: number,
  fy: number,
): number {
  const s = state.shield;
  for (let k = 0; k < SHIELD_ARCS; k++) {
    const i = p * SHIELD_ARCS + k;
    if (s.arcCharged[i] === 0) continue;
    const ax = s.arcDir[i * 3];
    const ay = s.arcDir[i * 3 + 1];
    const az = s.arcDir[i * 3 + 2];
    const r = s.radius[p];
    const px = (ax * fy + az * fx) * r;
    const py = (-ax * fx + az * fy) * r;
    const ph = ay * r;
    if (px * dx + py * dy + ph * dh < 0) return -1;
    s.arcCharged[i] = 0;
    return k;
  }
  return -1;
}

/**
 * The hurt (0x0044c927..0x0044c98c): a round — the original's types 2, 7 and
 * 0x0f — takes 1000 in block B and in A 300 one draw in eight; anything else
 * the sphere's own amount, credited to the mech.
 */
function shieldHurt(state: SimState, p: number, t: number): void {
  const ent = state.ent;
  const s = state.shield;
  if (ent.archetype[t] === ARCHETYPE.PROJECTILE) {
    const amount =
      (s.flags[p] & SHIELD_B) !== 0
        ? SHIELD_ROUND_DAMAGE_B
        : (randU32(state) & 7) === 7
          ? SHIELD_ROUND_DAMAGE_A
          : 0;
    if (amount <= 0) return;
    ent.hp[t] -= amount;
    if (ent.hp[t] <= 0) roundDestroyed(state, t);
    return;
  }
  applyDamage(state, t, s.amount[p], p, true);
}

/** A round whose health ran out goes off as its class does on expiry. */
function roundDestroyed(state: SimState, id: number): void {
  if ((state.ent.ammoB[id] & ROUND_GUIDED) !== 0) guidedExpire(state, id);
  else explode(state, id);
}

/**
 * A player's spend (0x0044c6ae..0x0044c74e): once the trigger's hold and the
 * spend period have both passed, one round of the gun slot's magazine — block
 * B's while it lasts — and at none the sphere goes off.
 */
function shieldSpend(state: SimState, p: number, now: number): void {
  const s = state.shield;
  if (now <= s.hold[p] || now <= s.spendNext[p]) return;
  const k = p * 3;
  const second = state.powerAmmo[k] > 0;
  let left = second ? state.powerAmmo[k] : state.gunAmmo[p];
  if (left > 0) left -= 1;
  if (left <= 0) s.flags[p] &= ~SHIELD_ON;
  if (second) state.powerAmmo[k] = left;
  else state.gunAmmo[p] = left;
  s.spendNext[p] = s.period[p] + now;
}

/**
 * Every player's sphere, once a tick: `sustain_sphere_tick` (0x0044c5e0). Its
 * owner gone (down), the record goes. Off, its radius and rate are zero. On: the
 * radius springs toward its target, `rate += ((2 (target - r) - 8 rate) delta)
 * >> 8`; the twelve arcs step; the mech spends; and every body of another side
 * inside the reach box — and, on the half sphere of block A, in front of the
 * mech — is hurt while it is inside the sphere grown by its own radius, which
 * also recoils the sphere and flashes it. In block B the first body in the box
 * then takes a hurt more for each charged arc on its side.
 */
function systemShields(state: SimState): void {
  if ((state.extraWeapons & EXTRA_WEAPON_RIOT_SHIELD) === 0) return;
  const ent = state.ent;
  const s = state.shield;
  const now = engineClock(state);
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if ((s.flags[p] & SHIELD_MADE) === 0) continue;
    const a = state.avatarId[p];
    if (a < 0 || !ent.alive[a]) {
      s.flags[p] = 0;
      s.flash[p] = 0;
      continue;
    }
    if (s.flash[p] > 0) s.flash[p] -= 1;
    if ((s.flags[p] & SHIELD_ON) === 0) {
      s.radius[p] = 0;
      s.rate[p] = 0;
      continue;
    }
    const r = s.radius[p];
    const rate = s.rate[p];
    const pull = 2 * (s.target[p] - r) - 8 * rate;
    const newRate = i16(((pull * WEAPON_UNITS_PER_TICK) >> 8) + rate);
    s.rate[p] = newRate;
    s.radius[p] = newRate + r;
    const powered = (s.flags[p] & SHIELD_B) !== 0;
    for (let k = 0; k < SHIELD_ARCS; k++) shieldArcStep(state, p, k, !powered, now);
    shieldSpend(state, p, now);

    const fx = ent.aimX[a];
    const fy = ent.aimY[a];
    const reach = s.reach[p] / RAW_PER_METRE;
    const rm = r / RAW_PER_METRE; // the inside test reads the radius before the step
    const team = ent.team[a];
    let take = true;
    for (let t = 0; t < ent.high; t++) {
      if (!ent.alive[t] || t === a || ent.team[t] === team) continue;
      if (ent.archetype[t] === ARCHETYPE.CONSOLE) continue;
      const dx = ent.posX[t] - ent.posX[a];
      const dy = ent.posY[t] - ent.posY[a];
      // From the centre, the mech's position raised 0x1000 (0x0044c66e), to
      // the body's reference point (0x0044c7c5).
      const dh = ent.height[t] + entityRefHeight(state, t) - (ent.height[a] + SHIELD_CENTRE_RAISE);
      if (Math.abs(dx) >= reach || Math.abs(dy) >= reach || Math.abs(dh) >= reach) continue;
      if (!powered && dx * fx + dy * fy < 0) continue;
      const reachR = rm + entityRadius(state, t);
      if (dx * dx + dy * dy + dh * dh < reachR * reachR) {
        s.flash[p] = SHIELD_FLASH_DRAWS;
        s.rate[p] = powered ? SHIELD_RECOIL_B : SHIELD_RECOIL_A;
        shieldHurt(state, p, t);
      }
      while (ent.alive[t]) {
        const k = powered && take ? shieldTakeArc(state, p, dx, dy, dh, fx, fy) : -1;
        if (k < 0) {
          take = false;
          break;
        }
        // The arc's direction came from the pair it last wrote, `phase ^ 1`.
        const i = p * SHIELD_ARCS + k;
        const last = i * 2 + (s.arcPhase[i] ^ 1);
        pushEvent(
          state.events,
          EV_SHIELD_ARC,
          a,
          t,
          packArcAngles(s.arcYaw[last], s.arcPitch[last]),
        );
        shieldHurt(state, p, t);
      }
    }
    if (take) {
      for (let k = 0; k < SHIELD_ARCS; k++) s.arcCharged[p * SHIELD_ARCS + k] = 0;
    }
  }
}

// The guided ordnance's states (`cact_missile` +0xe0).
const GUIDED_COAST = 0;
const GUIDED_HOME = 1;
const GUIDED_AVOID = 3;
const GUIDED_ACQUIRE = 4;

/**
 * Launches one guided round, `cact_missile_spawn` (0x0044d000) from the player's
 * launch path (0x004590d0): from the muzzle along the unit vector to the aim
 * point — the lock's, or the facing — homing on the lock when there is one.
 * With an acceleration it starts at twice the record's speed word and caps at
 * sixteen times it (an eighth); the K-9 Drone carries twice its damage as
 * health, everything else the round's 40.
 *
 * A guided round's fields: posX/posY/height; velX/velY/timerB its heading (a 3D
 * unit vector); cooldownA its speed and aimX its cap (world units an engine
 * unit), aimY its acceleration word; timerA the homing fuse (engine units);
 * timerC its state; cooldownC its target; hp, ammoA damage, aux blast radius,
 * ammoB ROUND_GUIDED (| ROUND_FALLOFF) | ROUND_RIVAL; and `roundLaunch` its
 * launch point and range.
 */
function spawnGuided(
  state: SimState,
  shooter: number,
  player: number,
  w: WeaponDef,
  blk: WeaponBlock,
  lock: number,
): number {
  const ent = state.ent;
  const fx = ent.aimX[shooter];
  const fy = ent.aimY[shooter];
  const x = ent.posX[shooter] + fx * MUZZLE_OFFSET;
  const y = ent.posY[shooter] + fy * MUZZLE_OFFSET;
  const h = ent.height[shooter] + MUZZLE_HEIGHT;
  let dx = fx;
  let dy = fy;
  let dh = 0;
  if (lock >= 0) {
    const tx = ent.posX[lock] - x;
    const ty = ent.posY[lock] - y;
    const th = ent.height[lock] + entityRefHeight(state, lock) - h;
    const len = Math.sqrt(tx * tx + ty * ty + th * th);
    if (len > 1e-9) {
      dx = tx / len;
      dy = ty / len;
      dh = th / len;
    }
  }
  const id = spawn(ent, ARCHETYPE.PROJECTILE, ent.team[shooter]);
  if (id < 0) return -1;
  const r = blk.rec;
  const top = Math.trunc(r.speed / 300);
  ent.posX[id] = x;
  ent.posY[id] = y;
  ent.height[id] = h;
  ent.velX[id] = dx;
  ent.velY[id] = dy;
  ent.timerB[id] = dh;
  ent.yaw[id] = atan2Poly(dy, dx);
  ent.cooldownA[id] = r.accel !== 0 ? top * 2 : top << 4;
  ent.aimX[id] = top << 4;
  ent.aimY[id] = Math.trunc((r.accel * 256) / 300);
  ent.timerA[id] = MISSILE_FUSE_UNITS;
  ent.timerC[id] = lock >= 0 ? GUIDED_HOME : GUIDED_COAST;
  ent.cooldownC[id] = lock;
  const hug = w.projKind === PROJ_K9;
  ent.hp[id] = hug ? (r.damage * 2) & 0xffff : MISSILE_ROUND_HEALTH;
  ent.ammoA[id] = r.damage;
  ent.aux[id] = blk.blast;
  ent.ammoB[id] =
    ROUND_GUIDED | ROUND_RIVAL | ((r.flags & WEAPON_FLAG_FALLOFF) !== 0 ? ROUND_FALLOFF : 0);
  ent.mode[id] = w.projKind;
  ent.ownerId[id] = player;
  const L = id * 4;
  state.roundLaunch[L] = x;
  state.roundLaunch[L + 1] = y;
  state.roundLaunch[L + 2] = h;
  state.roundLaunch[L + 3] = blk.range;
  return id;
}

/**
 * ACQUIRE (0x004231f0): the nearest body its owner could lock within the
 * round's range of the owner, other than the target it had; found, it homes
 * with a fresh fuse at a sixteenth of its cap, else it coasts.
 */
function guidedAcquire(state: SimState, id: number): void {
  const ent = state.ent;
  const p = ent.ownerId[id];
  const a = p >= 0 && p < MAX_PLAYERS ? state.avatarId[p] : -1;
  let found = -1;
  if (a >= 0 && ent.alive[a]) {
    const range = state.roundLaunch[id * 4 + 3];
    let best = range * range;
    const exclude = ent.cooldownC[id];
    for (let t = 0; t < ent.high; t++) {
      if (t === exclude || !isLockable(state, p, a, t)) continue;
      const dx = ent.posX[t] - ent.posX[a];
      const dy = ent.posY[t] - ent.posY[a];
      const d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
        found = t;
      }
    }
  }
  if (found >= 0) {
    ent.timerA[id] = MISSILE_FUSE_UNITS;
    ent.timerC[id] = GUIDED_HOME;
    ent.cooldownC[id] = found;
    ent.cooldownA[id] = Math.floor(ent.aimX[id] / 16);
  } else {
    ent.timerC[id] = GUIDED_COAST;
  }
}

/**
 * A guided round's end, operation 4 (0x00422e62): its blast, if it has one — the
 * Fusion Torpedo's, its damage first cut by the distance it flew from its launch
 * point over its range, in 256-unit steps and sixteen bits, so a torpedo that
 * outran its range does nothing. The K-9 Drone has none; its effect still
 * plays.
 */
function guidedExpire(state: SimState, id: number): void {
  const ent = state.ent;
  const x = ent.posX[id];
  const y = ent.posY[id];
  const team = ent.team[id];
  const owner = ent.ownerId[id];
  const kind = ent.mode[id];
  const radius = ent.aux[id];
  let damage = ent.ammoA[id];
  if ((ent.ammoB[id] & ROUND_FALLOFF) !== 0) {
    const L = id * 4;
    const dx = x - state.roundLaunch[L];
    const dy = y - state.roundLaunch[L + 1];
    const dh = ent.height[id] - state.roundLaunch[L + 2];
    const flown = Math.floor((Math.sqrt(dx * dx + dy * dy + dh * dh) * WU_PER_METRE) / 256);
    const range = Math.floor((state.roundLaunch[L + 3] * WU_PER_METRE) / 256);
    if (range !== 0) damage = i16(damage - Math.floor((flown * damage) / range));
  }
  despawn(ent, id);
  pushEvent(state.events, EV_EXPLOSION, Math.floor(x * 16), Math.floor(y * 16), kind);
  if (radius > 0 && damage > 0) {
    blastAt(state, x, y, team, owner, damage, radius, kind, BLAST_RIVAL);
  }
}

/**
 * Whether `a` is told of its contact with `b` before `b` is (operation 0x0b,
 * `cact_pair_test` 0x00450190). The pair walk (`objects_pick_targets`
 * 0x0044fe40) goes over the pair grid's cells by the original's x, then z —
 * the sim's x, then y — pairing each cell with itself and its forward
 * neighbours, the earlier cell's body first; in one cell the chain is the
 * gather's in reverse (`paint_grid_insert` puts each at its head), so the
 * later-made body comes first. The bodies stand at their positions, not
 * their reference points.
 */
export function toldFirst(state: SimState, a: number, b: number): boolean {
  const ent = state.ent;
  const ax = Math.floor(ent.posX[a] / PAIR_CELL);
  const bx = Math.floor(ent.posX[b] / PAIR_CELL);
  if (ax !== bx) return ax < bx;
  const ay = Math.floor(ent.posY[a] / PAIR_CELL);
  const by = Math.floor(ent.posY[b] / PAIR_CELL);
  if (ay !== by) return ay < by;
  return ent.born[a] > ent.born[b];
}

/**
 * One guided round's tick, `cact_missile_tick` (0x004231d0) in its order:
 * acquire, the range from the launch point, then (not expiring) the
 * acceleration, the state's steering, the move, the K-9's ground clearance, the
 * wall and floor sweeps — and the collision notice (operation 0x0b), which
 * kills a torpedo outright and costs the drone the larger of the body's health
 * and 2, and sends it hunting again: the health from before the body's own
 * notice or after it, in the pair walk's order (toldFirst).
 *
 * Steering, HOME and AVOID (0x004236ac): the fuse runs down while it homes and
 * at zero halves the speed and the cap and renews by 0x12c, expiring the round
 * under 0x10; the aim is the target's reference point (its height plus the
 * muzzle's, as the sim's other rounds aim); a step that reaches it lands on it,
 * otherwise the heading takes a quarter of the way to it. AVOID adds 0xa000 up
 * to the unit vector and reads the distance off that sum — the original's.
 */
function guidedTick(state: SimState, id: number): void {
  const ent = state.ent;
  const map = state.map;
  const hug = ent.mode[id] === PROJ_K9;
  if (ent.timerC[id] === GUIDED_ACQUIRE) guidedAcquire(state, id);
  const L = id * 4;
  {
    const dx = ent.posX[id] - state.roundLaunch[L];
    const dy = ent.posY[id] - state.roundLaunch[L + 1];
    const dh = ent.height[id] - state.roundLaunch[L + 2];
    if (dx * dx + dy * dy + dh * dh > state.roundLaunch[L + 3] * state.roundLaunch[L + 3]) {
      guidedExpire(state, id);
      return;
    }
  }
  const px = ent.posX[id];
  const py = ent.posY[id];
  const ph = ent.height[id];
  let speed = ent.cooldownA[id];
  const accel = ent.aimY[id];
  if (accel !== 0 && speed < ent.aimX[id]) {
    speed += Math.trunc((WEAPON_UNITS_PER_TICK * accel) / 16);
    if (speed > ent.aimX[id]) speed = ent.aimX[id];
  }
  let step = WEAPON_UNITS_PER_TICK * speed; // world units
  let hx = ent.velX[id];
  let hy = ent.velY[id];
  let hh = ent.timerB[id];
  let expiring = false;
  let target = -1;
  let ax = 0;
  let ay = 0;
  const st = ent.timerC[id];
  if (st === GUIDED_HOME || st === GUIDED_AVOID) {
    let fuse = ent.timerA[id] - WEAPON_UNITS_PER_TICK;
    if (fuse < 0) {
      speed = Math.trunc(speed / 2);
      ent.aimX[id] = (speed >> 4) << 4;
      fuse += MISSILE_FUSE_RENEW;
      if (speed < MISSILE_MIN_SPEED) expiring = true;
    }
    ent.timerA[id] = fuse;
    const t = ent.cooldownC[id];
    if (t < 0 || !homingValid(state, id, t)) {
      ent.timerC[id] = GUIDED_COAST;
      ent.cooldownC[id] = -1;
    } else {
      target = t;
      ax = ent.posX[t];
      ay = ent.posY[t];
      let tx = (ax - px) * WU_PER_METRE;
      let ty = (ay - py) * WU_PER_METRE;
      let th = (ent.height[t] + entityRefHeight(state, t) - ph) * WU_PER_METRE;
      let dist = Math.sqrt(tx * tx + ty * ty + th * th);
      if (dist > 0) {
        tx /= dist;
        ty /= dist;
        th /= dist;
      }
      if (st === GUIDED_AVOID) {
        th += K9_AVOID_BIAS;
        const l = Math.sqrt(tx * tx + ty * ty + th * th);
        dist = l * 65536;
        tx /= l;
        ty /= l;
        th /= l;
      }
      if (step >= dist) {
        if (dist < MISSILE_ARRIVAL_WU) {
          ent.timerC[id] = GUIDED_COAST;
        } else {
          hx = tx;
          hy = ty;
          hh = th;
        }
        step = dist;
      } else {
        hx = (3 * hx + tx) / 4;
        hy = (3 * hy + ty) / 4;
        hh = (3 * hh + th) / 4;
        const l = Math.sqrt(hx * hx + hy * hy + hh * hh);
        if (l > 0) {
          hx /= l;
          hy /= l;
          hh /= l;
        }
      }
    }
  }
  const m = step / WU_PER_METRE;
  let x = px + hx * m;
  let y = py + hy * m;
  let h = ph + hh * m;
  if (hug) {
    if (ent.timerC[id] === GUIDED_AVOID) ent.timerC[id] = GUIDED_HOME;
    if (target >= 0) {
      const cx = x - ax;
      const cy = y - ay;
      if (cx * cx + cy * cy > K9_CLEARANCE_RANGE * K9_CLEARANCE_RANGE) {
        // The original's coarse envelope where the arena has one, the
        // heightfield elsewhere (coarseHeightAt; prepare.c 0x00456180).
        const ground = map.coarse ? coarseHeightAt(map.coarse, x, y) : sampleHeight(map, x, y);
        if (h - ground < K9_CLEARANCE) {
          h += K9_CLEARANCE_LIFT;
          speed = Math.trunc(speed / 2);
          ent.timerC[id] = GUIDED_AVOID;
        }
      }
    }
  }
  const wallT = segmentBlockT(map, px, py, x, y);
  if (wallT >= 0) {
    x = px + (x - px) * wallT;
    y = py + (y - py) * wallT;
    h = ph + (h - ph) * wallT;
    expiring = true;
  } else {
    const extent = worldExtent(map);
    if (x <= 0 || x >= extent || y <= 0 || y >= extent) {
      expiring = true;
    } else if (h < sampleHeight(map, x, y)) {
      // Below the floor: halfway back, the height unclamped (0x0042395f).
      x = (px + x) / 2;
      y = (py + y) / 2;
      h = (ph + h) / 2;
      expiring = true;
    }
  }
  ent.posX[id] = x;
  ent.posY[id] = y;
  ent.height[id] = h;
  ent.velX[id] = hx;
  ent.velY[id] = hy;
  ent.timerB[id] = hh;
  ent.cooldownA[id] = speed;
  ent.yaw[id] = atan2Poly(hy, hx);
  if (!expiring) {
    for (let t = 0; t < ent.high; t++) {
      if (!ent.alive[t] || t === id) continue;
      if (ent.team[t] === ent.team[id]) continue;
      if (ent.archetype[t] === ARCHETYPE.PROJECTILE) continue;
      const r = entityRadius(state, t) + 0.5;
      const dx = ent.posX[t] - x;
      const dy = ent.posY[t] - y;
      if (dx * dx + dy * dy > r * r) continue;
      const before = ent.hp[t];
      const droneFirst = toldFirst(state, id, t);
      // A contact: the round's own serial is the credit, which resolves to
      // nobody (0x0041a811), so it is no rival's hit.
      applyDamage(state, t, ent.ammoA[id], ent.ownerId[id], false);
      notePush(state, t, ent.born[id], missilePushDir(state, id), ent.ammoA[id]);
      if (hug) {
        // The body's health as the drone reads it: before its own notice
        // when the drone is told first, after it otherwise.
        const read = droneFirst ? before : ent.alive[t] ? ent.hp[t] : 0;
        ent.hp[id] -= read > 2 ? read : 2;
        ent.timerC[id] = GUIDED_ACQUIRE;
        if (ent.hp[id] <= 0) expiring = true;
      } else {
        expiring = true;
      }
      break;
    }
  }
  if (expiring) guidedExpire(state, id);
}

/**
 * Launches the Grenade Launcher's round: the ballistic solve (`cact_discharge_arc`,
 * as the Mortar's) from the muzzle to the lock or 8 m ahead, then the streamed
 * spawner with that velocity (`cact_round_spawn_streamed` 0x0044d7c0, flag 1),
 * whose lifetime is the record's fuse plus `fuse * (rand & 0x1f) / 64`: 3.0 to
 * 4.5 s. Its velocity is the original's, world units a second: velX/velY the
 * ground plane, timerB up; aimX its gravity, world units a second².
 */
function spawnBounce(
  state: SimState,
  shooter: number,
  player: number,
  w: WeaponDef,
  blk: WeaponBlock,
  lock: number,
): number {
  const ent = state.ent;
  const fx = ent.aimX[shooter];
  const fy = ent.aimY[shooter];
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
  const id = spawnArced(state, x, y, h, tx, ty, th, blk.launchSpeed, blk.gravity);
  if (id < 0) return -1;
  ent.team[id] = ent.team[shooter];
  ent.velX[id] = Math.trunc(ent.velX[id] * WU_PER_METRE);
  ent.velY[id] = Math.trunc(ent.velY[id] * WU_PER_METRE);
  ent.timerB[id] = Math.trunc(ent.timerB[id] * WU_PER_METRE);
  ent.aimX[id] = blk.rec.range << 4;
  const base = blk.fuseUnits;
  const jitter = randU32(state) & GRENADE_FUSE_JITTER_MASK;
  ent.timerA[id] = base + Math.trunc((base * jitter) / GRENADE_FUSE_JITTER_DIV);
  ent.mode[id] = w.projKind;
  ent.ownerId[id] = player;
  ent.ammoA[id] = blk.damage;
  ent.aux[id] = blk.blast;
  ent.ammoB[id] = ROUND_BOUNCE | ROUND_RIVAL;
  return id;
}

/**
 * The bouncing round's tick, `cact_bounce_advance` (0x00424370): above the ground
 * gravity takes `gravity * delta / 300` off its rise (a rise smaller than the
 * fall stops at zero); at the ground it comes to rest — and goes off — when every
 * axis is under 0x1800 wu/s, or bounces, keeping -5/8 of its vertical speed and
 * 7/8 of the horizontal, each truncated; it moves `v * 218 * delta`, factored as
 * the original's `vec_mac`; a wall on that segment sets it off where it hit
 * (floors are not traced); then its lifetime loses the delta. It also goes off
 * on a collision with a body of another side (operation 0x0b), and on the
 * owner's second press (its lifetime cleared).
 */
function bounceTick(state: SimState, id: number, radius = GRENADE_RADIUS): void {
  const ent = state.ent;
  const map = state.map;
  let vx = ent.velX[id];
  let vy = ent.velY[id];
  let vh = ent.timerB[id];
  // The surface plus the round's model radius (0x00424582).
  const ground = sampleHeight(map, ent.posX[id], ent.posY[id]) + radius;
  if (ent.height[id] > ground) {
    const fall = Math.trunc((ent.aimX[id] * WEAPON_UNITS_PER_TICK) / GRENADE_TIME_DIVISOR);
    if (vh > 0 && fall > vh) vh = 0;
    else vh -= fall;
  } else if (
    Math.abs(vh) < GRENADE_REST_SPEED &&
    Math.abs(vx) < GRENADE_REST_SPEED &&
    Math.abs(vy) < GRENADE_REST_SPEED
  ) {
    ent.height[id] = ground;
    explode(state, id);
    return;
  } else {
    ent.height[id] = ground;
    vh = Math.trunc((-GRENADE_BOUNCE_VERTICAL * vh) / 8);
    vx = Math.trunc((GRENADE_BOUNCE_HORIZONTAL * vx) / 8);
    vy = Math.trunc((GRENADE_BOUNCE_HORIZONTAL * vy) / 8);
  }
  ent.velX[id] = vx;
  ent.velY[id] = vy;
  ent.timerB[id] = vh;
  const scale = (GRENADE_MOVE_SCALE * WEAPON_UNITS_PER_TICK) >> 2;
  const px = ent.posX[id];
  const py = ent.posY[id];
  let x = px + (((vx >> 2) * scale) >> 12) / WU_PER_METRE;
  let y = py + (((vy >> 2) * scale) >> 12) / WU_PER_METRE;
  const h = ent.height[id] + (((vh >> 2) * scale) >> 12) / WU_PER_METRE;
  const wallT = segmentBlockT(map, px, py, x, y);
  if (wallT >= 0) {
    x = px + (x - px) * wallT;
    y = py + (y - py) * wallT;
  }
  ent.posX[id] = x;
  ent.posY[id] = y;
  ent.height[id] = h;
  const extent = worldExtent(map);
  if (wallT >= 0 || x <= 0 || x >= extent || y <= 0 || y >= extent) {
    explode(state, id);
    return;
  }
  if (vx !== 0 || vy !== 0) ent.yaw[id] = atan2Poly(vy, vx);
  ent.timerA[id] -= WEAPON_UNITS_PER_TICK;
  let boom = ent.timerA[id] <= 0;
  if (!boom) {
    for (let t = 0; t < ent.high; t++) {
      if (!ent.alive[t] || t === id) continue;
      if (ent.team[t] === ent.team[id]) continue;
      if (ent.archetype[t] === ARCHETYPE.PROJECTILE) continue;
      const r = entityRadius(state, t) + 0.5;
      const dx = ent.posX[t] - x;
      const dy = ent.posY[t] - y;
      if (dx * dx + dy * dy <= r * r) {
        boom = true;
        break;
      }
    }
  }
  if (boom) explode(state, id);
}

/**
 * The Pop-Up Mine's tick: `cact_bounce_advance` (0x00424370) with its fuse, run
 * before anything else (0x004243a1): while it has a reach, an enemy body within
 * that reach plus its own radius springs it (`bounce_spring` 0x004244b9) -- its
 * lifetime becomes 300 units, its reach 0, its velocity -0x8000 world units a
 * second straight down and its gravity 0x8000 -- and it raises nothing (the
 * spring's effect start refuses a direct round, RE M3-OK). Then the bouncing
 * round's fall, bounce and rest (bounceTick, the mine's own model radius): the
 * tick that brings it to rest blows it (0x00424606), as its lifetime, a wall
 * or a body's contact do. Kept from Metropolis: the fuse measures the ground
 * plane from the body's position, where the original measures in three axes
 * from its reference point with its horizontal half-extent.
 */
function mineTick(state: SimState, id: number): void {
  const ent = state.ent;
  const reach = ent.cooldownC[id];
  if (reach > 0) {
    const mx = ent.posX[id];
    const my = ent.posY[id];
    const team = ent.team[id];
    for (let t = 0; t < ent.high; t++) {
      if (!ent.alive[t] || t === id) continue;
      if (ent.team[t] === team) continue;
      if (ent.archetype[t] === ARCHETYPE.PROJECTILE) continue;
      const r = reach + entityRadius(state, t);
      const dx = ent.posX[t] - mx;
      const dy = ent.posY[t] - my;
      if (dx * dx + dy * dy <= r * r) {
        ent.timerA[id] = MINE_SPRING_UNITS;
        ent.cooldownA[id] = 1;
        ent.cooldownC[id] = 0;
        ent.velX[id] = 0;
        ent.velY[id] = 0;
        ent.timerB[id] = MINE_SPRING_VELOCITY;
        ent.aimX[id] = MINE_SPRING_GRAVITY;
        break;
      }
    }
  }
  bounceTick(state, id, MINE_RADIUS);
}

/** Whether `id` is still `player`'s kept round (the original checks its serial). */
function keptAlive(state: SimState, player: number, id: number): boolean {
  const ent = state.ent;
  return (
    ent.alive[id] === 1 &&
    ent.archetype[id] === ARCHETYPE.PROJECTILE &&
    ent.ownerId[id] === player &&
    (ent.ammoB[id] & (ROUND_BOUNCE | ROUND_ARC)) !== 0
  );
}

/**
 * The second press (0x00459062..0x004590b4): every live round of the kept one's
 * class the player fired goes — a bouncing round by its lifetime cleared (it
 * still moves this tick), an arced one by its health, where it is.
 */
function detonateKept(state: SimState, player: number, kept: number): void {
  const ent = state.ent;
  const cls = ent.ammoB[kept] & (ROUND_BOUNCE | ROUND_ARC);
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || ent.archetype[id] !== ARCHETYPE.PROJECTILE) continue;
    if (ent.ownerId[id] !== player || (ent.ammoB[id] & cls) === 0) continue;
    if (cls === ROUND_BOUNCE) ent.timerA[id] = 0;
    else ent.ammoB[id] |= ROUND_DETONATE;
  }
}

function systemProjectiles(state: SimState): void {
  const ent = state.ent;
  const map = state.map;
  const extent = worldExtent(map);
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || ent.archetype[id] !== ARCHETYPE.PROJECTILE) continue;

    // Pop-Up Mines: the dropped bouncing round (mineTick).
    if (ent.mode[id] === PROJ_MINE) {
      mineTick(state, id);
      continue;
    }

    const flags = ent.ammoB[id];
    // The extra weapons' rounds run the original's own ticks.
    if ((flags & ROUND_GUIDED) !== 0) {
      guidedTick(state, id);
      continue;
    }
    if ((flags & ROUND_BOUNCE) !== 0) {
      bounceTick(state, id);
      continue;
    }
    if ((flags & ROUND_DETONATE) !== 0) {
      explode(state, id);
      continue;
    }
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
            ent.timerB[id] =
              (ent.height[target] + entityRefHeight(state, target) - ent.height[id]) / d;
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
        const r = entityRadius(state, t) + 0.5;
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
    ent.ammoB[f] = ROUND_ARC | (ent.ammoB[id] & ROUND_RIVAL);
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
  const byRival = (ent.ammoB[id] & ROUND_RIVAL) !== 0;
  const x = ent.posX[id];
  const y = ent.posY[id];
  const team = ent.team[id];
  const owner = ent.ownerId[id];
  const pushDir = struck >= 0 ? missilePushDir(state, id) : 0;
  const born = ent.born[id];
  // Despawn first so the blast loop never re-hits the shell itself.
  despawn(ent, id);
  if (radius > 0) {
    const opts = (flat ? BLAST_FLAT : BLAST_EMIT) | (byRival ? BLAST_RIVAL : 0);
    blastAt(state, x, y, team, owner, damage, radius, kind, opts);
  } else {
    pushEvent(state.events, EV_EXPLOSION, Math.floor(x * 16), Math.floor(y * 16), kind);
    if (kind === PROJ_ROUND) {
      pushEvent(
        state.events,
        EV_ROUND_IMPACT,
        Math.floor(x * 16),
        Math.floor(y * 16),
        state.roundFrom[id],
      );
    }
    // A round with no blast hurts by its contact, and a contact leaves the
    // round's own serial as the credit (`cact_base_op9` 0x0041a811), gone once
    // the round has died: it credits nobody (RE aircraft.c 0x00420e1c,
    // player.c 0x004477ab; fcop-fidelity.md V7).
    if (struck >= 0) applyDamage(state, struck, damage, owner, false);
  }
  if (pushDir !== 0) notePush(state, struck, born, pushDir, damage);
}

/**
 * The heading of round `id` as a packDirection value when it is the original's
 * missile class -- actor type 2, the only killer `cact_base_op4` gives a
 * context (0x0041a309): a world round, the Hell Fire 2000's and the Hyper
 * Velocity Rocket's straight rounds, a guided round. 0 for any other (an arced
 * shell, a bouncing round or a mine is type 7 or 0x0f; the Warden's bomb).
 */
function missilePushDir(state: SimState, id: number): number {
  const ent = state.ent;
  const flags = ent.ammoB[id];
  if ((flags & ROUND_GUIDED) !== 0) {
    return packDirection(ent.velX[id], ent.velY[id], ent.timerB[id]);
  }
  if ((flags & (ROUND_ARC | ROUND_BOUNCE | ROUND_FLAT_BLAST)) !== 0) return 0;
  const kind = ent.mode[id];
  if (kind !== PROJ_ROUND && kind !== PROJ_HEAVY && kind !== PROJ_HYPER) return 0;
  const vx = ent.velX[id];
  const vy = ent.velY[id];
  // A straight round climbs timerB metres a metre flown.
  return packDirection(vx, vy, ent.timerB[id] * Math.sqrt(vx * vx + vy * vy));
}

/**
 * A missile-class round's contact left `target` dead (RE M3-OP): the contact's
 * credit is the round's serial (0x0041a811), both die in the next frame's
 * expiry pass in creation order, and only a body made before the round finds
 * it still live there -- one made after it is re-credited by the round's own
 * blast first. So a body older than the round carries the push to its death.
 */
function notePush(
  state: SimState,
  target: number,
  roundBorn: number,
  dir: number,
  damage: number,
): void {
  const ent = state.ent;
  if (target < 0 || ent.hp[target] > 0 || ent.born[target] >= roundBorn) return;
  state.killPushDir[target] = dir;
  state.killPushDamage[target] = damage;
}

/** Collects deaths: points, events, avatar/dummy respawn scheduling. */
function systemDamageDeath(state: SimState): void {
  const ent = state.ent;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || ent.hp[id] > 0) continue;
    if (ent.archetype[id] === ARCHETYPE.PROJECTILE) continue;
    const killer = ent.aux[id] - 1; // -1 = environment/dummy
    const archetype = ent.archetype[id];
    // A mech down with HARD's sinking marker (`player_op4` reads block +0xde
    // first): no wreck and no death effects, and the short respawn below.
    const owner = ent.ownerId[id];
    const sunk =
      archetype === ARCHETYPE.AVATAR &&
      owner >= 0 &&
      owner < MAX_PLAYERS &&
      state.avatarId[owner] === id &&
      state.avatarSinking[owner] !== 0;
    if (sunk) pushEvent(state.events, EV_SUNK, id, owner, 0);
    if (state.killPushDamage[id] !== 0) {
      pushEvent(state.events, EV_KILL_PUSH, id, state.killPushDir[id], state.killPushDamage[id]);
      state.killPushDamage[id] = 0;
      state.killPushDir[id] = 0;
    }
    pushEvent(state.events, EV_DEATH, id, killer, archetype);
    // Earn table (rules.md §3, fcop-fidelity.md R4-R7): a death pays the OTHER
    // side whoever caused it, because the original pays from the dying actor's
    // own death script, not from the kill credit. Neutral turrets (dummies,
    // uncaptured pads) and consoles pay nothing. A player's avatar pays at its
    // respawn (systemSpawning); the Warden, like the Sky Captain, when it falls.
    const team = ent.team[id];
    if (team === 0 || team === 1) {
      const other = team ^ 1;
      if (archetype === ARCHETYPE.WARDEN) {
        avatarDown(state, team);
        // The commander's death: First Death stamped once and its deaths, sky_ai
        // +0x48 and +0x3e (aircraft.c 0x00420df9; at the crash's end there,
        // which Metropolis does not model).
        noteDown(state, team);
        // ...and one more Walker Kill for the player's side when the hit that
        // brought it down was that X1's own (its weapons, or a round or mine it
        // fired): the remembered serial resolves to team slot 0's mech, whose
        // block's +0x14 rises (aircraft.c 0x00420e1c..0x00420e57; slot 0 is
        // always the human against the captain).
        if (state.rivalHit[team] !== 0) bumpStat(state, other, STAT_WALKER_KILLS);
      } else if (archetype === ARCHETYPE.TURRET) {
        earn(state, other, POINTS_TURRET_DIES);
        if (ent.mode[id] === TURRET_CAPTURABLE) {
          // A captured neutral turret destroyed is an engine credit (turret.c),
          // and one more "Turrets Destroyed" for the side that held it, never
          // for the side that scores (`turret_score_death` 0x0041be31,
          // 0x0041befa, 0x0041bf21). One a claim kills is neutral by then.
          captainCredit(state, other);
          bumpStat(state, team, STAT_TURRETS_DESTROYED);
        }
      } else if (archetype === ARCHETYPE.RUNNER || archetype === ARCHETYPE.GUARDIAN)
        earn(state, other, POINTS_UNIT_DIES);
      else if (archetype === ARCHETYPE.JUGGERNAUT || archetype === ARCHETYPE.FORTRESS)
        earn(state, other, POINTS_HEAVY_DIES);
      // A unit's death: one more "Destroyed" of its class for the side that
      // lost it, whoever killed it (`csac_on_spawned_death` 0x0044f16d).
      const lost = unitStatKey(archetype, false);
      if (lost >= 0) bumpStat(state, team, lost);
    }
    if (archetype === ARCHETYPE.AVATAR || archetype === ARCHETYPE.WARDEN) {
      const player = ent.ownerId[id];
      state.avatarId[player] = -1;
      state.respawnTimer[player] =
        archetype === ARCHETYPE.WARDEN
          ? skyRespawnTicks(wardenLevel(state.wardenDifficulty))
          : sunk
            ? RESPAWN_SUNK_TICKS
            : RESPAWN_TICKS;
      // The marker is consumed by the down (`player_op4` reads and clears it,
      // 0x0044761e).
      state.avatarSinking[player] = 0;
      if (archetype === ARCHETYPE.AVATAR) {
        // The mech's down, any cause: First Death stamped once, its deaths
        // (`player_op4` 0x00447764, 0x00447780).
        noteDown(state, player);
        // The credit is taken at the down, and only when the hit that put the
        // mech down was the rival's own craft (`player_op4`
        // 0x004477ab..0x00447821; fcop-fidelity.md U3, V7). With the Sky
        // Captain: its tally of mechs put down and its rethink zeroed, so its
        // next tick decides. Without one: the other slot's Walker Kills. A tank,
        // jet or turret, a fall or the water credits nobody.
        if (state.rivalHit[player] !== 0) {
          if (state.wardenPlayer >= 0) {
            captainCredit(state, state.wardenPlayer);
            bumpStat(state, state.wardenPlayer, STAT_WALKER_KILLS);
          } else {
            bumpStat(state, player ^ 1, STAT_WALKER_KILLS);
          }
        }
      }
      // Power-ups are lost when the avatar goes down (`player_respawn` clears the
      // block-B ammunition; fcop-fidelity.md P2, P8). The cloak and invulnerability
      // timers are NOT cleared: the original keeps counting them down while the
      // mech is down (fcop-re/player-and-weapons.md §1).
      for (let k = 0; k < 3; k++) state.powerAmmo[player * 3 + k] = 0;
      state.lockTarget[player] = -1; // death drops any lock
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
    forgetTurretTarget(ent, id);
    despawn(ent, id);
  }
}

/**
 * Income for side `team`: its Current Points (state word 25 + slot) and its
 * Points Scored (31 + slot), which a purchase or a down never takes back
 * (fcop-re/ai-and-rules.md §2).
 */
function earn(state: SimState, team: number, n: number): void {
  state.points[team] += n;
  state.pointsScored[team] += n;
}

/**
 * An avatar went down (fcop-fidelity.md R4): the other side gains
 * POINTS_AVATAR_DOWN and `team` loses as many, never below 0. Points only: the
 * Sky Captain's credit for a player's down is taken at the down itself
 * (systemDamageDeath), not here at the respawn.
 */
function avatarDown(state: SimState, team: number): void {
  earn(state, team ^ 1, POINTS_AVATAR_DOWN);
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
        // A sunk mech's down still pays the points (its script runs at the
        // respawn whoever caused it).
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

/**
 * Is entity `id` inside `reach` metres of turret `tid`? The original measures in
 * world units with its octagonal estimate: flat first, then (except for the Sky
 * Captain, `flat`) once more with the height difference folded in
 * (`turret_op10`, fcop-re/ranges-turrets-capture.md Q2; fcop-fidelity.md R12).
 */
function withinCapture(ent: EntityStore, id: number, tid: number, reach: number, flat: boolean) {
  const r = Math.trunc(reach * CAPTURE_WU_PER_METRE);
  let d = octagonalLength(
    Math.trunc((ent.posX[id] - ent.posX[tid]) * CAPTURE_WU_PER_METRE),
    Math.trunc((ent.posY[id] - ent.posY[tid]) * CAPTURE_WU_PER_METRE),
  );
  if (d - r >= 0) return false;
  if (flat) return true;
  d = octagonalLength(d, Math.trunc((ent.height[id] - ent.height[tid]) * CAPTURE_WU_PER_METRE));
  return d - r < 0;
}

/** The original's world units per metre (0x20000 wu = 16 m). */
const CAPTURE_WU_PER_METRE = 8192;

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
        if (withinCapture(ent, a, tid, range + entityRadius(state, a), true)) team = p;
      } else if (state.capturePress[p] === 1) {
        if (withinCapture(ent, a, tid, range + entityRadius(state, a), false)) team = p;
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
    earn(state, team, POINTS_CAPTURE_TURRET);
    captainCredit(state, team); // an engine credit: the captain rethinks at once
    // "Turrets Claimed" of the capturing side, its mech's, its tank's or the
    // captain's (`turret_score_capture` 0x0041cba5, 0x0041cc41).
    bumpStat(state, team, STAT_TURRETS_CLAIMED);
    pushEvent(state.events, EV_CAPTURE, tid, team, k);
  }
  for (let p = 0; p < MAX_PLAYERS; p++) state.capturePress[p] = 0;
}

/**
 * Economy bookkeeping (rules.md §3). There is no trickle: the original adds no
 * points over time (fcop-fidelity.md R3), so income is entirely the event table
 * in systemDamageDeath / systemCapture. What runs here is the heavy-unit unlock
 * (R10): the original's fn30/fn31, a mission function `cfun_tick` polls every
 * `heavyZones.pollPeriod` engine ticks from the phase `cfun_load` drew, the
 * frame delta off its countdown each tick. The first poll that sees the side
 * hold HEAVY_UNLOCK_POINTS opens its Dreadnought and Fortress zones for good
 * (order 0x7a) and requests the base's two terminals, then retires (repeat 1).
 * Points held only between two polls open nothing. The terminals stand from the
 * next tick: the original's spawner pass (`csac_tick`) precedes `cfun_tick` in
 * a frame, so it serves the request one frame on. A base without heavy zones
 * (the test maps) polls nothing.
 */
function systemEconomy(state: SimState): void {
  const bases = state.map.bases;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const zones = bases[p].heavyZones;
    if (zones === undefined) continue;
    if (state.heavyUnlocked[p] !== 0) {
      state.heavyTerminals[p] = 1; // the spawner pass serves the last run's request
      continue;
    }
    state.heavyPoll[p] -= CFUN_DELTA_PER_TICK;
    if (state.heavyPoll[p] >= 0) continue;
    state.heavyPoll[p] += zones.pollPeriod;
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
    if (insideGate(gate, ent.posX[id], ent.posY[id], entityRadius(state, id))) {
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
  for (let k = 0; k < spots.length; k++) {
    if (state.pickupCooldown[k] > 0) {
      state.pickupCooldown[k] -= 1;
      continue;
    }
    const spot = spots[k];
    // The pickup stands `lift` above the ground under it (water included).
    const ground =
      spot.layer === 0
        ? rideHeight(state.map, spot.x, spot.y, true)
        : resolveHeight(state.map, spot.x, spot.y, spot.layer);
    const z = ground + spot.lift;
    // Player slot order is the tie-break when both stand in a box: arbitrary,
    // but identical on every peer, which is what matters. A mech collects inside
    // the box (`cact_pickup_box_touch`); the Sky Captain by the pickup's own
    // flat 1.5 m touch (`cact_pickup_sky_touch`), which heals it at a health
    // pickup and spends any other for nothing.
    for (let p = 0; p < MAX_PLAYERS; p++) {
      const a = state.avatarId[p];
      if (a < 0) continue;
      const dx = ent.posX[a] - spot.x;
      const dy = ent.posY[a] - spot.y;
      if (ent.archetype[a] === ARCHETYPE.WARDEN) {
        const flat = octagonalLength(
          Math.trunc(dx * CAPTURE_WU_PER_METRE),
          Math.trunc(dy * CAPTURE_WU_PER_METRE),
        );
        if (flat >= SKY_PICKUP_TOUCH_WU) continue;
        if (spot.kind === PICKUP_HEALTH) captainRestore(state, a);
        state.pickupCooldown[k] = spot.respawnTicks;
        pushEvent(
          state.events,
          EV_PICKUP,
          Math.round(spot.x * 16),
          Math.round(spot.y * 16),
          spot.kind,
        );
        break;
      }
      if (ent.archetype[a] !== ARCHETYPE.AVATAR) continue;
      const dz = ent.height[a] - z;
      if (dx >= spot.halfW || dx <= -spot.halfW) continue;
      if (dy >= spot.halfL || dy <= -spot.halfL) continue;
      if (dz >= spot.halfH || dz <= -spot.halfH) continue;
      const kind = spot.kind;
      // An ammo pickup fills that slot's A magazine to its ceiling on the
      // collector's difficulty (`cact_type99_ammo_add(slot, -1)`;
      // fcop-re/player-and-weapons.md §6).
      const d = state.difficulty[p];
      if (kind === PICKUP_GUN_AMMO) {
        state.gunAmmo[p] = difficultyAmmo(
          weaponInSlot(0, state.loadoutGun[p], state.extraWeapons).a.ammoCap,
          d,
        );
      } else if (kind === PICKUP_HEAVY_AMMO) {
        ent.ammoA[a] = difficultyAmmo(
          weaponInSlot(1, state.loadoutHeavy[p], state.extraWeapons).a.ammoCap,
          d,
        );
      } else if (kind === PICKUP_SPECIAL_AMMO) {
        ent.ammoB[a] = difficultyAmmo(
          weaponInSlot(2, state.loadoutSpecial[p], state.extraWeapons).a.ammoCap,
          d,
        );
      } else if (kind === PICKUP_HEALTH) {
        // Full heal: the grant passes amount -1, "fill" (fcop-fidelity.md P6).
        ent.hp[a] = avatarMaxHp(state, p);
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
      if (a >= 0 && insideVolume(state, a, vol)) intruder = a;
    }
    if (intruder < 0 && (vol.watch & TRIGGER_WATCH_ENEMY_UNITS) !== 0) {
      for (let id = 0; id < ent.high; id++) {
        if (!ent.alive[id] || ent.team[id] !== foe || !isGroundUnit(ent.archetype[id])) continue;
        if (insideVolume(state, id, vol)) {
          intruder = id;
          break;
        }
      }
    }
    if (intruder < 0 && (vol.watch & TRIGGER_WATCH_OWN_AVATAR) !== 0) {
      const a = state.avatarId[vol.team];
      if (a >= 0 && insideVolume(state, a, vol)) intruder = a;
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
 * The ground under a mech hurts it where the original's does (fcop-fidelity.md
 * P11): each base's floor (codes 14/15) deals FLOOR_DAMAGE_PER_STEP every
 * movement step to the ENEMY mech standing on it, walker or hover, within
 * SURFACE_REACH of its feet; and on Hk, where no floor carries the code, each
 * spawn's guard box deals its damage once, then waits for the mission to clear
 * its latch. No one is credited (the down is paid at the respawn as any other),
 * an invulnerable mech takes nothing, and only a player's own mech reads the
 * ground: tanks, jets and the Sky Captain are untouched.
 */
function systemFloors(state: SimState): void {
  const map = state.map;
  const ent = state.ent;
  const masks = map.floorMasks;
  if (masks.length > 0 || map.lifts.length > 0) {
    for (let p = 0; p < MAX_PLAYERS; p++) {
      const id = state.avatarId[p];
      if (id < 0 || ent.archetype[id] !== ARCHETYPE.AVATAR) continue;
      // The movement steps this mech took this tick, by its own carry of the
      // clock's eighths (walker.ts walkerEighths: 1, 1, 1, 2 from wherever its
      // carry stands), as the original's floor check runs in each of its steps.
      const steps = state.walker.steps[p];
      // On a lift its top is the surface, in place of the floor under it: a
      // tagged lift hurts like its base's floor (fcop-fidelity.md P12).
      const carrier = state.avatarLift[p];
      if (carrier >= 0) {
        if (map.lifts[carrier].hurtsTeam === ent.team[id]) {
          applyDamage(state, id, steps * FLOOR_DAMAGE_PER_STEP, -1);
        }
        continue;
      }
      const layer = ent.entLayer[id];
      if (layer >= masks.length) continue;
      const x = ent.posX[id];
      const y = ent.posY[id];
      const i = Math.floor(x / map.cellSize);
      const j = Math.floor(y / map.cellSize);
      if (i < 0 || j < 0 || i >= map.size || j >= map.size) continue;
      if (masks[layer][j * map.size + i] !== 1 + ent.team[id]) continue;
      if (ent.height[id] - resolveHeight(map, x, y, layer) >= SURFACE_REACH) continue;
      applyDamage(state, id, steps * FLOOR_DAMAGE_PER_STEP, -1);
    }
  }
  const guards = map.spawnGuards;
  for (let k = 0; k < guards.length; k++) {
    const g = guards[k];
    // The reset function's poll (`cfun_tick`, its engine-tick countdown less
    // the frame delta): it clears a set latch.
    state.guardTimer[k] -= CFUN_DELTA_PER_TICK;
    if (state.guardTimer[k] < 0) {
      state.guardTimer[k] += g.resetPeriod;
      state.guardLatch[k] = 0;
    }
    if (state.guardLatch[k] !== 0) continue;
    const id = state.avatarId[g.hurtsTeam];
    if (id < 0 || ent.archetype[id] !== ARCHETYPE.AVATAR) continue;
    const r = entityRadius(state, id);
    const dx = ent.posX[id] - g.x;
    const dy = ent.posY[id] - g.y;
    // The box's centre stands on the surface under it at load, water included
    // (Hk's spawns stand on the water).
    const floor =
      g.layer === 0 ? rideHeight(map, g.x, g.y, true) : resolveHeight(map, g.x, g.y, g.layer);
    const dz = ent.height[id] - floor;
    if (dx >= g.halfW + r || dx <= -(g.halfW + r)) continue;
    if (dy >= g.halfL + r || dy <= -(g.halfL + r)) continue;
    if (dz >= g.halfH + r || dz <= -(g.halfH + r)) continue;
    applyDamage(state, id, g.damage, -1);
    state.guardLatch[k] = 1;
  }
}

/**
 * Axis-aligned containment test for an intrusion volume, grown by the intruder's
 * own hit radius — the original's test is `|centre - pos| - halfExtent - radius < 0`
 * (fcop-re/ranges-turrets-capture.md Q1, retail 0x00420150..0x0042017f).
 */
function insideVolume(state: SimState, id: number, vol: MapTriggerVolume): boolean {
  const ent = state.ent;
  const dx = ent.posX[id] - vol.x;
  const dy = ent.posY[id] - vol.y;
  const r = entityRadius(state, id);
  const hw = vol.halfW + r;
  const hl = vol.halfL + r;
  return dx <= hw && dx >= -hw && dy <= hl && dy >= -hl;
}

/** Advances the sim by exactly one tick. Synchronous, allocation-free. */
/** A lift leaves the stop it is at for the next one its way. */
function startLift(state: SimState, k: number): void {
  state.liftPhase[k] = LIFT_MOVING;
  state.liftTimer[k] = 0;
  pushEvent(state.events, EV_LIFT_START, k, state.liftStop[k] + state.liftDir[k], 0);
}

/**
 * The lifts (`elevator.c`; fcop-fidelity.md P12; RE `camera-and-movement.md`
 * "Lifts"), right after the mechs move, so a press this tick and the carriers
 * the movement found are current. A parked lift leaves when a mech standing on
 * its top presses the Action Key (the down edge, capturePress — the same edge
 * a capture or a purchase reads); a dwelling one when its dwell runs out. A
 * moving one goes its stop's way at its own speed up or down, stops exactly at
 * the stop, turns round at either end of its table, and then dwells or parks
 * as that stop says. Its riders move with it (the carrier's translation,
 * `player_follow_carrier`), so a rider never reads as airborne on it.
 */
function systemLifts(state: SimState): void {
  const lifts = state.map.lifts;
  const ent = state.ent;
  for (let k = 0; k < lifts.length; k++) {
    const l = lifts[k];
    if (state.liftPhase[k] === LIFT_PARKED) {
      for (let p = 0; p < MAX_PLAYERS; p++) {
        if (state.avatarLift[p] === k && state.capturePress[p] === 1) {
          startLift(state, k);
          break;
        }
      }
    } else if (state.liftPhase[k] === LIFT_DWELL) {
      state.liftTimer[k] -= 1;
      if (state.liftTimer[k] <= 0) startLift(state, k);
    }
    if (state.liftPhase[k] !== LIFT_MOVING) continue;
    const before = state.liftWu[k];
    const dir = state.liftDir[k];
    const next = state.liftStop[k] + dir;
    const target = l.stops[next];
    let wu = before + (dir > 0 ? l.up : -l.down);
    if (dir > 0 ? wu >= target : wu <= target) {
      wu = target;
      state.liftStop[k] = next;
      if (next === 0 || next === l.stops.length - 1) state.liftDir[k] = -dir;
      const d = l.dwell[next];
      state.liftTimer[k] = d;
      state.liftPhase[k] = d > 0 ? LIFT_DWELL : LIFT_PARKED;
      pushEvent(state.events, EV_LIFT_ARRIVE, k, next, 0);
    }
    state.liftWu[k] = wu;
    const dz = (wu - before) / 8192;
    for (let p = 0; p < MAX_PLAYERS; p++) {
      if (state.avatarLift[p] !== k) continue;
      const id = state.avatarId[p];
      if (id >= 0) ent.height[id] += dz;
    }
  }
}

export function step(state: SimState, inputs: TickInputs): void {
  clearEvents(state.events);
  // A breached match freezes: the tick (and thus the hash stream) keeps
  // advancing for replays/netcode, but no gameplay system runs anymore.
  if (state.winner === -1) {
    systemAvatarMovement(state, inputs);
    // The lifts right after the mechs: a rider's press and its carrier are
    // this tick's, and a carried rider is where its lift is before anything
    // else reads its height.
    systemLifts(state);
    systemQueues(state);
    // The Warden slots in directly after the human avatars: it IS the other
    // avatar (decision layer + superplane movement + weapons + buying), so it
    // observes the same pre-unit-movement world a player does.
    systemWarden(state);
    systemFloors(state);
    systemUnitMovement(state);
    systemTargeting(state);
    systemProjectiles(state);
    // The Riot Shield's spheres, after the rounds have moved (inert unless the
    // match offers it).
    systemShields(state);
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
    // The results page's form timers and First Outpost, on the tick's final
    // state (stats.ts).
    systemStats(state);
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
  // Appended at SIM_VERSION 61: the spawn queues, every map.
  for (let k = 0; k < state.unitQueue.length; k++) {
    h = fnv1aU32(h, state.unitQueue[k] >>> 0);
    h = fnv1aU32(h, state.unitQueueTimer[k] >>> 0);
  }
  // Appended at SIM_VERSION 60, on arenas with heavy zones only.
  for (let p = 0; p < MAX_PLAYERS; p++) {
    if (state.map.bases[p].heavyZones !== undefined) h = fnv1aU32(h, state.heavyPoll[p] >>> 0);
  }
  // Appended at SIM_VERSION 58; empty (and so absent) off Hk.
  for (let k = 0; k < state.guardLatch.length; k++) {
    h = fnv1aU32(h, state.guardLatch[k]);
    h = fnv1aU32(h, state.guardTimer[k] >>> 0);
  }
  // Appended at SIM_VERSION 64; empty (and so absent) on an arena without lifts.
  for (let k = 0; k < state.liftWu.length; k++) {
    h = fnv1aU32(h, state.liftWu[k] >>> 0);
    h = fnv1aU32(h, state.liftStop[k] >>> 0);
    h = fnv1aU32(h, state.liftDir[k] >>> 0);
    h = fnv1aU32(h, state.liftPhase[k]);
    h = fnv1aU32(h, state.liftTimer[k] >>> 0);
  }
  if (state.liftWu.length > 0) {
    for (let p = 0; p < MAX_PLAYERS; p++) h = fnv1aU32(h, state.avatarLift[p] >>> 0);
  }
  // Appended at SIM_VERSION 71; only on an arena with mode floors (Ovmp).
  if (state.map.modeFloors) {
    for (let p = 0; p < MAX_PLAYERS; p++) h = fnv1aU32(h, state.avatarMode[p]);
  }
  // Appended at SIM_VERSION 39: the X1-Alpha's movement state, every map.
  for (let p = 0; p < MAX_PLAYERS; p++) {
    // The rate moves in steps of 12.5 units, so twice it is an exact integer.
    h = fnv1aU32(h, (state.avatarTurnRate[p] * 2) >>> 0);
    h = fnv1aU32(h, state.avatarIdle[p] >>> 0);
  }
  // Appended at SIM_VERSION 40: which locks steer the hull (gone at 69, W2).
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
  // Appended at SIM_VERSION 72, only in a match with a player off NORMAL: the
  // difficulties and HARD's sinking markers. A NORMAL match hashes as before.
  let offNormal = false;
  for (let p = 0; p < MAX_PLAYERS; p++)
    if (state.difficulty[p] !== DIFFICULTY_NORMAL) offNormal = true;
  if (offNormal) {
    for (let p = 0; p < MAX_PLAYERS; p++) {
      h = fnv1aU32(h, state.difficulty[p]);
      h = fnv1aU32(h, state.avatarSinking[p]);
    }
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
  }
  // Appended at SIM_VERSION 76, every map: the rival-hit flags (hashed in a
  // Warden match only from 75) and the results page's figures (stats.ts).
  for (let p = 0; p < MAX_PLAYERS; p++) {
    h = fnv1aU32(h, state.rivalHit[p]);
    h = fnv1aU32(h, state.pointsScored[p]);
    h = fnv1aU32(h, state.firstDeath[p]);
    h = fnv1aU32(h, state.firstOutpost[p]);
  }
  for (let k = 0; k < state.statHalves.length; k++) h = fnv1aU32(h, state.statHalves[k]);
  for (let k = 0; k < state.formTime.length; k++) h = fnv1aU32(h, state.formTime[k]);
  // Appended at SIM_VERSION 77: the Dreadnought's gun mounts, live Juggernauts
  // only, in id order.
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || ent.archetype[id] !== ARCHETYPE.JUGGERNAUT) continue;
    for (let g = 0; g < DREADNOUGHT_GUNS; g++) {
      const k = id * DREADNOUGHT_GUNS + g;
      h = fnv1aU32(h, state.gunYaw[k]);
      h = fnv1aU32(h, state.gunClock[k] >>> 0);
      h = fnv1aU32(h, state.gunPhase[k]);
      h = fnv1aU32(h, state.gunTarget[k]);
      h = fnv1aU32(h, state.gunSearch[k] >>> 0);
    }
  }
  // Appended at SIM_VERSION 85: the Dreadnought hull's walk, live Juggernauts on
  // a hull that walks only (bug-hunt's).
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || ent.archetype[id] !== ARCHETYPE.JUGGERNAUT) continue;
    const hw = state.hullWalk[ent.team[id]];
    if (!hw) continue;
    h = fnv1aU32(h, hw.index[id] | ((hw.direction[id] & 0xff) << 8) | (hw.flags[id] << 16));
    h = fnv1aU32(h, (hw.frame[id] & 0xffff) | (hw.target[id] << 16));
    h = fnv1aU32(h, hw.clock[id] >>> 0);
  }
  // Appended at SIM_VERSION 83, every map: the walker's state machine and its
  // legs (walker.ts), which replace v39's lunge countdown.
  const w = state.walker;
  const legs = w.legs;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    h = fnv1aU32(h, w.state[p] | (w.flags[p] << 8) | (w.asked[p] << 16) | (w.idle[p] << 24));
    h = fnv1aU32(h, w.lunge[p] | (w.carry[p] << 8) | (w.form[p] << 16) | (legs.index[p] << 24));
    h = fnv1aU32(h, (legs.frame[p] & 0xffff) | (legs.target[p] << 16));
    h = fnv1aU32(h, legs.clock[p] >>> 0);
    h = fnv1aU32(h, (legs.direction[p] & 0xff) | (legs.flags[p] << 8));
  }
  // Appended at SIM_VERSION 90, only in a match that offers an extra weapon: the
  // kept rounds, the Riot Shield's spheres and the guided rounds' launch points.
  if (state.extraWeapons !== 0) {
    h = fnv1aU32(h, state.extraWeapons);
    const sh = state.shield;
    for (let p = 0; p < MAX_PLAYERS; p++) {
      h = fnv1aU32(h, state.keptRound[p] >>> 0);
      h = fnv1aU32(h, sh.flags[p]);
      h = fnv1aU32(h, (sh.radius[p] & 0xffff) | (sh.rate[p] << 16));
      h = fnv1aU32(h, (sh.target[p] & 0xffff) | (sh.reach[p] << 16));
      h = fnv1aU32(h, sh.amount[p] & 0xffff);
      h = fnv1aU32(h, sh.hold[p] >>> 0);
      h = fnv1aU32(h, sh.period[p] >>> 0);
      h = fnv1aU32(h, sh.spendNext[p] >>> 0);
      for (let k = 0; k < SHIELD_ARCS; k++) {
        const i = p * SHIELD_ARCS + k;
        h = fnv1aU32(h, sh.arcNext[i] >>> 0);
        h = fnv1aU32(h, (sh.arcYaw[i * 2] & 0xffff) | (sh.arcYaw[i * 2 + 1] << 16));
        h = fnv1aU32(h, (sh.arcPitch[i * 2] & 0xffff) | (sh.arcPitch[i * 2 + 1] << 16));
        h = fnv1aU32(h, sh.arcPhase[i] | (sh.arcCharged[i] << 8));
        h = fnv1aF32(h, sh.arcDir[i * 3]);
        h = fnv1aF32(h, sh.arcDir[i * 3 + 1]);
        h = fnv1aF32(h, sh.arcDir[i * 3 + 2]);
      }
    }
    for (let id = 0; id < ent.high; id++) {
      if (!ent.alive[id] || (ent.ammoB[id] & ROUND_GUIDED) === 0) continue;
      if (ent.archetype[id] !== ARCHETYPE.PROJECTILE) continue;
      for (let k = 0; k < 4; k++) h = fnv1aF32(h, state.roundLaunch[id * 4 + k]);
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
export const MATCH_SNAPSHOT_HEADER = 7;
/** Per-slot block length; MAX_PLAYERS blocks follow the header. */
export const MATCH_SNAPSHOT_SLOT_STRIDE = 18;
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
/**
 * The pickups standing now: bit k set while `map.pickups[k]` is up (its
 * re-arm countdown at 0). Every PA arena has 8-12, well inside a float's 24
 * exact bits; a map with more than 24 reports the first 24.
 */
export const MATCH_PICKUPS = 6;

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
/**
 * 1 while this slot's base's two heavy terminals stand (SimState.heavyTerminals),
 * else 0: the Csac templates `map.bases[slot].heavyZones.terminals`, spawned the
 * tick after the poll that opened the base's Dreadnought and Fortress zones
 * (fcop-fidelity.md R10, G2). Always 0 on a base without heavy zones.
 */
export const MATCH_SLOT_TERMINALS = 12;
/**
 * The issued magazines, block A of each slot (gun, heavy, special), whether or
 * not the slot is powered: the HUD's lower count is block A always, the upper
 * one block B while it holds rounds (RE hud_weapons.c, hud.json weapons). The
 * ammo fields above count the magazine the slot fires from. 0 while down.
 */
export const MATCH_SLOT_ISSUED_GUN = 13;
export const MATCH_SLOT_ISSUED_HEAVY = 14;
export const MATCH_SLOT_ISSUED_SPECIAL = 15;
/**
 * The health MATCH_SLOT_HP_FRAC is a fraction of: the slot's difficulty row for
 * an X1-Alpha, the level's for the Sky Captain. The camera's damage share is
 * the hit's amount against it (RE `player_take_amount` 0x00446720).
 */
export const MATCH_SLOT_HP_MAX = 16;
/**
 * Sim ticks of invulnerability left (SimState.buffInvuln, the original's block
 * +0x326; PICKUP_INVULN), 0 for none: the armour gauge's blue blink (RE draw.c
 * `hud_draw_player`). No Precinct Assault pickup grants it (fcop-fidelity.md I8).
 */
export const MATCH_SLOT_INVULN = 17;
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
 * The lifts' snapshot (renderer rule 4): per `map.lifts` entry, LIFT_SNAP_STRIDE
 * floats — the top face's height now and whether it moves. A pure read like
 * writeMatchSnapshot, never hashed; the client keeps two for interpolation.
 */
export const LIFT_SNAP_STRIDE = 2;
/** The lift's top face, m. */
export const LIFT_SNAP_TOP = 0;
/** 1 while the lift moves (its travel sound runs), else 0. */
export const LIFT_SNAP_MOVING = 1;

/** Writes the lifts into `out` (length map.lifts.length * LIFT_SNAP_STRIDE). */
export function writeLiftSnapshot(state: SimState, out: Float32Array): void {
  for (let k = 0; k < state.liftWu.length; k++) {
    const o = k * LIFT_SNAP_STRIDE;
    out[o + LIFT_SNAP_TOP] = liftTopHeight(state, k);
    out[o + LIFT_SNAP_MOVING] = state.liftPhase[k] === LIFT_MOVING ? 1 : 0;
  }
}

/**
 * The Dreadnought guns' snapshot (renderer rule 4; fcop-fidelity.md I6, G8): per
 * entity id, GUN_SNAP_STRIDE floats at `id * GUN_SNAP_STRIDE` — gun i's yaw
 * relative to its hull at `+ i`, radians in (-PI, PI] and in the entity
 * snapshot's yaw sense, so the gun's world yaw is the hull's plus it (0 = the
 * hull's forward), and at `+ GUN_SNAP_HULL_FRAME` the frame the hull's walk
 * shows (sim hullWalk; 0 for a static hull). Gun i stands on the hull model's
 * attach point i of that frame. Written for live Juggernauts only; a pure read,
 * never hashed.
 */
export const GUN_SNAP_STRIDE = DREADNOUGHT_GUNS + 1;
export const GUN_SNAP_HULL_FRAME = DREADNOUGHT_GUNS;
export const GUN_SNAPSHOT_LEN = MAX_ENTITIES * GUN_SNAP_STRIDE;

/** Writes each live Juggernaut's gun yaws and hull frame into `out` (length GUN_SNAPSHOT_LEN). */
export function writeGunSnapshot(state: SimState, out: Float32Array): void {
  const ent = state.ent;
  for (let id = 0; id < ent.high; id++) {
    if (!ent.alive[id] || ent.archetype[id] !== ARCHETYPE.JUGGERNAUT) continue;
    const o = id * GUN_SNAP_STRIDE;
    for (let g = 0; g < DREADNOUGHT_GUNS; g++) {
      out[o + g] = gunYawRadians(state.gunYaw[id * DREADNOUGHT_GUNS + g]);
    }
    const walk = state.hullWalk[ent.team[id]];
    out[o + GUN_SNAP_HULL_FRAME] = walk ? walk.frame[id] : 0;
  }
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
  let up = 0;
  const nPickups = state.pickupCooldown.length < 24 ? state.pickupCooldown.length : 24;
  for (let k = 0; k < nPickups; k++) if (state.pickupCooldown[k] === 0) up |= 1 << k;
  out[MATCH_PICKUPS] = up;

  let live = 0;
  for (let slot = 0; slot < MAX_PLAYERS; slot++) {
    const o = matchSlotOffset(slot);
    const a = state.avatarId[slot];
    out[o + MATCH_SLOT_POINTS] = state.points[slot];
    out[o + MATCH_SLOT_AVATAR_ID] = a;
    const maxHp = slot === state.wardenPlayer ? captainMaxHp(state) : avatarMaxHp(state, slot);
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
    out[o + MATCH_SLOT_TERMINALS] = state.heavyTerminals[slot];
    out[o + MATCH_SLOT_ISSUED_GUN] = a >= 0 ? state.gunAmmo[slot] : 0;
    out[o + MATCH_SLOT_ISSUED_HEAVY] = a >= 0 ? ent.ammoA[a] : 0;
    out[o + MATCH_SLOT_ISSUED_SPECIAL] = a >= 0 ? ent.ammoB[a] : 0;
    out[o + MATCH_SLOT_HP_MAX] = maxHp;
    out[o + MATCH_SLOT_INVULN] = state.buffInvuln.length > slot ? state.buffInvuln[slot] : 0;
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
  if (arch === ARCHETYPE.AVATAR) {
    const owner = ent.ownerId[id];
    if (owner >= 0 && owner < MAX_PLAYERS) return avatarMaxHp(state, owner);
  }
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
