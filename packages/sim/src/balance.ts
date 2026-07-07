// ALL gameplay constants live here (CLAUDE.md workflow rule) — never inline
// numbers in systems. Values are seeded from docs/specs/rules.md and are
// placeholders until playtesting tunes them.

/** Fixed simulation rate. All gameplay time is measured in ticks. */
export const TICK_HZ = 30;
/** Seconds per tick (1/30 is not a power of two, but the division is exact and shared). */
export const TICK_DT = 1 / TICK_HZ;

/** Fixed entity cap — SoA storage is preallocated, never grows (architecture.md §2). */
export const MAX_ENTITIES = 1024;
export const MAX_PLAYERS = 2;

/**
 * Local input delay in ticks (architecture.md §4): even solo play routes
 * inputs through this queue so online (3 ticks) feels near-identical.
 */
export const LOCAL_INPUT_DELAY_TICKS = 2;

// Avatar (rules.md §2, §4) — Phase 0 only uses walker speed for the debug cube.
export const AVATAR_HP = 300;
export const AVATAR_WALKER_SPEED = 5;
export const AVATAR_HOVER_SPEED = 9;

// Slope limits as rise/run. Walker handles everything except deliberate
// jump-only ledges (rise ≈ 0.7); hover is blocked by anything steeper than a
// river bank. Map authoring relies on these — the district-01 schema test
// checks lane traversability against the walker limit.
export const AVATAR_WALKER_MAX_SLOPE = 0.6;
export const AVATAR_HOVER_MAX_SLOPE = 0.35;

// Transform & jump (rules.md §2).
export const TRANSFORM_LOCK_TICKS = 15; // ~0.5 s: no move/jump/weapons
export const AVATAR_JUMP_SPEED = 8; // m/s up → 1.6 m apex, clears 1.4 m ledges
export const GRAVITY = 20; // m/s²
export const HOVER_CLEARANCE = 0.8; // ride height above ground/water surface
/**
 * Hover traction: fraction of the velocity error closed per tick, picked by
 * what the stick is doing. Throttle responds, counter-steer bites hard (drift
 * is escapable), a released stick glides for over a second. All three are
 * FEEL-TUNING KNOBS — defaults need a human pass on real hardware.
 */
export const HOVER_TRACTION_ACCEL = 0.1; // stick along velocity (or standstill)
export const HOVER_TRACTION_BRAKE = 0.25; // stick against velocity
export const HOVER_TRACTION_COAST = 0.02; // stick released

// Ammo capacities (rules.md §2: heavy/special finite).
export const AVATAR_AMMO_HEAVY = 20;
export const AVATAR_AMMO_SPECIAL = 5;

// Weapons (rules.md §2: primary hitscan, heavy projectile w/ AoE, special).
export const PRIMARY_COOLDOWN_TICKS = 5;
export const PRIMARY_DAMAGE = 8;
export const PRIMARY_RANGE = 40;
export const HEAVY_COOLDOWN_TICKS = 24;
export const HEAVY_DAMAGE = 60;
export const HEAVY_SPEED = 25;
export const HEAVY_TTL_TICKS = 75;
export const HEAVY_AOE_RADIUS = 6;
export const SPECIAL_COOLDOWN_TICKS = 60;
export const SPECIAL_DAMAGE = 150;
export const SPECIAL_SPEED = 12;
export const SPECIAL_TTL_TICKS = 90;
export const SPECIAL_AOE_RADIUS = 4;

// Turrets (sandbox dummies AND base ring turrets share combat stats for now).
export const TURRET_RANGE = 28;
export const TURRET_DAMAGE = 15;
export const TURRET_COOLDOWN_TICKS = 20;
export const DUMMY_RESPAWN_TICKS = 450; // 15 s
export const BASE_TURRET_RESPAWN_TICKS = 1800; // 60 s (rules.md §5)

// Ammo/repair pad (rules.md §5): ammo refills instantly, hp regenerates.
export const PAD_REPAIR_HP_PER_TICK = 0.5; // 15 hp/s

// Console purchases. Phase 2 stub: edge-triggered interact on the pad spawns
// the unit for free; Phase 3 replaces this with hold-to-buy and point costs.
export const CONSOLE_RADIUS = 3;
export const JUGGERNAUT_ALIVE_LIMIT = 1; // rules.md §3
export const FORTRESS_ALIVE_LIMIT = 1;

// Units (rules.md §4 placeholder stat table; dps = damage / cooldown).
export const RUNNER_SPEED = 4;
export const RUNNER_DAMAGE = 4;
export const RUNNER_COOLDOWN_TICKS = 15; // 8 dps
export const RUNNER_RANGE = 14;
export const GUARDIAN_SPEED = 7;
export const GUARDIAN_DAMAGE = 5;
export const GUARDIAN_COOLDOWN_TICKS = 15; // 10 dps
export const GUARDIAN_RANGE = 18;
export const GUARDIAN_PATROL_RADIUS = 30;
export const GUARDIAN_ASSAULT_STANDOFF = 14; // hold-off distance from the enemy core
export const JUGGERNAUT_SPEED = 2.5;
export const JUGGERNAUT_DAMAGE = 10;
export const JUGGERNAUT_COOLDOWN_TICKS = 15; // 20 dps
export const JUGGERNAUT_RANGE = 16;
export const FORTRESS_SPEED = 6;
export const FORTRESS_DAMAGE = 25;
export const FORTRESS_COOLDOWN_TICKS = 30; // 25 dps
export const FORTRESS_RANGE = 30;
export const FORTRESS_PATROL_RADIUS = 45;

// Unit movement shared knobs.
export const AIR_ALTITUDE = 6; // flyers ride this high above ground/water
export const WAYPOINT_RADIUS = 3; // lane waypoint advance distance
export const ORBIT_ANGULAR_SPEED = 0.6; // rad/s patrol orbit
export const UNIT_SEPARATION_RADIUS = 2.4; // friendly ground units push apart
export const UNIT_SEPARATION_PUSH = 0.5; // fraction of overlap resolved per tick

// Death & respawn (rules.md §2: 8 s).
export const RESPAWN_TICKS = 240;

// Points (rules.md §3, the Phase 1 stub subset).
export const POINTS_KILL_AVATAR = 10;
export const POINTS_KILL_TURRET = 2;
export const POINTS_KILL_UNIT = 1;

// Unit combat stats indexed by ARCHETYPE value (avatar/turret/projectile
// slots unused — those fight through their own constants above).
export const UNIT_RANGE: readonly number[] = [
  0, // AVATAR
  RUNNER_RANGE,
  GUARDIAN_RANGE,
  JUGGERNAUT_RANGE,
  FORTRESS_RANGE,
  0, // TURRET
  0, // PROJECTILE
];
export const UNIT_DAMAGE: readonly number[] = [
  0,
  RUNNER_DAMAGE,
  GUARDIAN_DAMAGE,
  JUGGERNAUT_DAMAGE,
  FORTRESS_DAMAGE,
  0,
  0,
];
export const UNIT_FIRE_COOLDOWN_TICKS: readonly number[] = [
  0,
  RUNNER_COOLDOWN_TICKS,
  GUARDIAN_COOLDOWN_TICKS,
  JUGGERNAUT_COOLDOWN_TICKS,
  FORTRESS_COOLDOWN_TICKS,
  0,
  0,
];

/** 2D hit radius per archetype, indexed like ARCHETYPE_MAX_HP. */
export const ARCHETYPE_RADIUS: readonly number[] = [
  1.2, // AVATAR
  1.0, // RUNNER
  1.2, // GUARDIAN
  2.2, // JUGGERNAUT
  2.6, // FORTRESS
  1.5, // TURRET
  0.4, // PROJECTILE
];

// Max HP per archetype, indexed by ARCHETYPE value (rules.md §4 placeholders;
// turret/projectile values are stand-ins until their phases land).
export const ARCHETYPE_MAX_HP: readonly number[] = [
  AVATAR_HP, // AVATAR
  60, // RUNNER
  50, // GUARDIAN
  600, // JUGGERNAUT
  500, // FORTRESS
  100, // TURRET (Phase 1 dummy value; Phase 2 rebalances)
  1, // PROJECTILE
];
