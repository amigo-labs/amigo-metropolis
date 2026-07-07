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

// Max HP per archetype, indexed by ARCHETYPE value (rules.md §4 placeholders;
// turret/projectile values are stand-ins until their phases land).
export const ARCHETYPE_MAX_HP: readonly number[] = [
  AVATAR_HP, // AVATAR
  60, // RUNNER
  50, // GUARDIAN
  600, // JUGGERNAUT
  500, // FORTRESS
  200, // TURRET
  1, // PROJECTILE
];
