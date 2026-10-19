// The original's two sides, and which one each Metropolis team holds.
//
// In Future Cop: L.A.P.D.'s Precinct Assault, side 1 is RED and side 2 BLUE: the
// X1-Alphas carry radar markers 0x31 (palette 17, red) and 0x32 (18, blue), the
// base turrets 0x01 (red) and 0x02 (blue), and the HUD draws player slot 0's
// readouts in text colour 1 (light red) and slot 1's in 3 (light blue). Player
// slot 0 is X1Alpha 12, side 1, in every mission (RE radar_markers.json,
// hud.json score.colour).
//
// Metropolis numbers its teams by the original's player slot
// (tools/generators/enrichArena.ts, SIM_VERSION 79): team 0 is slot 0, side 1,
// on every arena, and team 1 side 2, so a team's side is team + 1. Until 79 the
// teams ran along each arena's field axis, and La Cantina (Mp)'s team 0 stood on
// side 2's spawn. The generated tables still carry what they read from the
// original -- ARENA_PRESENTATION.team0Side (the X1Alpha on spawn 0) and
// ARENA_UNITS.sides (the Dreadnought records) -- as the check of this, and their
// generators refuse anything else. The debug maps have no original: the same.

export const SIDE_NONE = 0;
export const SIDE_RED = 1;
export const SIDE_BLUE = 2;

/**
 * The original side (1 red, 2 blue) team `team` holds; 0 for neutral. The same
 * on every arena: `_mapId` stays so each caller still names the arena it colours.
 */
export function sideOfTeam(_mapId: string, team: number): number {
  if (team !== 0 && team !== 1) return SIDE_NONE;
  return team === 0 ? SIDE_RED : SIDE_BLUE;
}

/** The text colour of a side's readouts (hud.json score.colour: 1 light red, 3 light blue). */
export function sideTextColour(side: number): number {
  return side === SIDE_BLUE ? 3 : 1;
}

/** The side's colour word, for text a player reads. */
export function sideName(side: number): string {
  return side === SIDE_BLUE ? "BLUE" : side === SIDE_RED ? "RED" : "NEUTRAL";
}
