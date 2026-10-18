// The original's two sides, and which one each Metropolis team holds.
//
// In Future Cop: L.A.P.D.'s Precinct Assault, side 1 is RED and side 2 BLUE: the
// X1-Alphas carry radar markers 0x31 (palette 17, red) and 0x32 (18, blue), the
// base turrets 0x01 (red) and 0x02 (blue), and the HUD draws player slot 0's
// readouts in text colour 1 (light red) and slot 1's in 3 (light blue). Player
// slot 0 is X1Alpha 12, side 1, in every mission (RE radar_markers.json,
// hud.json score.colour).
//
// Metropolis numbers its teams along each arena's field axis
// (tools/generators/enrichArena.ts: team 0 is the low end), not by the original's
// player slot. On five arenas team 0 stands on side 1's spawn; on La Cantina (Mp)
// it stands on side 2's. So a team's colour is a property of the arena, read
// from the X1Alpha record on the map's spawn 0 (ARENA_PRESENTATION.team0Side,
// `bun run gen:presentation`). The debug maps have no original: team 0 is side 1.

import { ARENA_PRESENTATION } from "./fcopPresentation.generated";

export const SIDE_NONE = 0;
export const SIDE_RED = 1;
export const SIDE_BLUE = 2;

/** The original side (1 red, 2 blue) team `team` holds on `mapId`; 0 for neutral. */
export function sideOfTeam(mapId: string, team: number): number {
  if (team !== 0 && team !== 1) return SIDE_NONE;
  const side0 = ARENA_PRESENTATION[mapId]?.team0Side ?? SIDE_RED;
  return team === 0 ? side0 : 3 - side0;
}

/** The text colour of a side's readouts (hud.json score.colour: 1 light red, 3 light blue). */
export function sideTextColour(side: number): number {
  return side === SIDE_BLUE ? 3 : 1;
}

/** The side's colour word, for text a player reads. */
export function sideName(side: number): string {
  return side === SIDE_BLUE ? "BLUE" : side === SIDE_RED ? "RED" : "NEUTRAL";
}
