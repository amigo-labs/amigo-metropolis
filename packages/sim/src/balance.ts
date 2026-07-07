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
