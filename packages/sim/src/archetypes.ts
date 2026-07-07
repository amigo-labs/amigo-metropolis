// Entity archetypes. The numeric value is part of the snapshot contract
// (docs/specs/architecture.md §3) and of the state hash — append only,
// never renumber.
export const ARCHETYPE = {
  AVATAR: 0,
  RUNNER: 1,
  GUARDIAN: 2,
  JUGGERNAUT: 3,
  FORTRESS: 4,
  TURRET: 5,
  PROJECTILE: 6,
} as const;

export type Archetype = (typeof ARCHETYPE)[keyof typeof ARCHETYPE];

/** Team -1 = neutral, 0 and 1 = the two players. */
export const TEAM_NEUTRAL = -1;
