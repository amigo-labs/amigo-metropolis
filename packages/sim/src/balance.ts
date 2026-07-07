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
 * Hover traction: fraction of the velocity error closed per tick. Low values
 * = drifty. FEEL-TUNING KNOB — needs a human pass on real hardware.
 */
export const HOVER_TRACTION = 0.08;

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

// Sandbox dummy turrets (Phase 1 targets; real turrets rebalance in Phase 2).
export const TURRET_RANGE = 28;
export const TURRET_DAMAGE = 15;
export const TURRET_COOLDOWN_TICKS = 20;
export const DUMMY_RESPAWN_TICKS = 450; // 15 s

// Death & respawn (rules.md §2: 8 s).
export const RESPAWN_TICKS = 240;

// Points (rules.md §3, the Phase 1 stub subset).
export const POINTS_KILL_AVATAR = 10;
export const POINTS_KILL_TURRET = 2;
export const POINTS_KILL_UNIT = 1;

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
