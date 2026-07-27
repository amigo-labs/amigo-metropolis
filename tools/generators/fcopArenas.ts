// The six FCOP arenas, in one place: which original mission each one is, and how
// much wall editing stage 2 is allowed to do on it.
//
// WHY THIS EXISTS
// The mapId -> mission mapping used to live only in convert.ts's ArenaSpec, which
// cannot be imported (its CLI runs at module top level and reads a private
// heightmap dump) and is not in this project's tsconfig. So stage 2 guessed:
// `mission = mapId === "la-cantina" ? "mp" : mapId`, which meant
// `gen:arena urban-jungle` looked for a nonexistent urban-jungle-logic.json.
// convert.ts keeps its own `mission:` literals as the historical copy; this table
// is the one the in-tree pipeline reads.

/** One arena's identity across the pipeline's three artifact families. */
export interface FcopArena {
  /** Map id == packages/sim/maps/<id>.json == the MAP_REGISTRY / replay id. */
  readonly mapId: string;
  /** Original mission container prefix. The fcop/ artifacts use its lowercase form. */
  readonly mission: string;
  /** Stage 1 emitted stacked decks for this arena (convert.ts `layered`). */
  readonly layered: boolean;
  /**
   * Wall bits stage 2 may clear to open the original roads, and to reconnect
   * anything the flattening sealed off. Per arena because the cost of flattening
   * a bridged mission to one storey is per arena; a number here is a measurement
   * with a reason, not a knob. Raising one without re-running `--probe` first is
   * the mistake the throw messages in enrichArena.ts warn about.
   */
  readonly carveLimit: number;
  readonly repairLimit: number;
}

/** Ordered as convert.ts's ARENAS, so reports read the same across both stages. */
export const FCOP_ARENAS: readonly FcopArena[] = [
  { mapId: "urban-jungle", mission: "Conft", layered: false, carveLimit: 400, repairLimit: 400 },
  { mapId: "proving-ground", mission: "Slim", layered: false, carveLimit: 400, repairLimit: 400 },
  { mapId: "la-cantina", mission: "Mp", layered: false, carveLimit: 400, repairLimit: 400 },
  { mapId: "bug-hunt", mission: "Joke", layered: false, carveLimit: 400, repairLimit: 400 },
  { mapId: "hollywood-keys", mission: "Hk", layered: true, carveLimit: 400, repairLimit: 400 },
  { mapId: "venice-beach", mission: "Ovmp", layered: true, carveLimit: 400, repairLimit: 400 },
];

const known = (): string => FCOP_ARENAS.map((a) => `${a.mapId} (${a.mission})`).join(", ");

/** Arena by map id. */
export function arenaOf(mapId: string): FcopArena {
  const a = FCOP_ARENAS.find((x) => x.mapId === mapId);
  if (!a) throw new Error(`unknown arena "${mapId}" — known: ${known()}`);
  return a;
}

/** Arena by mission name, case-insensitively (`Mp`, `mp` and `MP` all resolve). */
export function arenaOfMission(mission: string): FcopArena {
  const want = mission.toLowerCase();
  const a = FCOP_ARENAS.find((x) => x.mission.toLowerCase() === want);
  if (!a) throw new Error(`unknown mission "${mission}" — known: ${known()}`);
  return a;
}

/**
 * CLI selector: `all`, a map id, or a mission name. One spelling per arena would
 * be enough, but the three stages were written with different habits and both
 * spellings are in the docs, so accept either rather than making the caller care.
 */
export function selectArenas(which: string): readonly FcopArena[] {
  if (which === "all") return FCOP_ARENAS;
  const byId = FCOP_ARENAS.find((x) => x.mapId === which);
  if (byId) return [byId];
  const byMission = FCOP_ARENAS.find((x) => x.mission.toLowerCase() === which.toLowerCase());
  if (byMission) return [byMission];
  throw new Error(`unknown arena "${which}" — expected "all" or one of: ${known()}`);
}

/** Committed actor/Cnet extraction for this arena (tools/generators/fcop/). */
export function logicFile(a: FcopArena): string {
  return `${a.mission.toLowerCase()}-logic.json`;
}

/** Committed pristine stage-1 wall lattice for this arena. */
export function wallsFile(a: FcopArena): string {
  return `${a.mission.toLowerCase()}-walls.json`;
}
