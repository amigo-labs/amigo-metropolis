// Map data: heightfield grid + water mask + authored features (bases, lanes,
// turret/outpost spots) per architecture.md §2. The same heights drive sim
// ground-snap/slope checks AND the render mesh — single source of truth.
// Real maps ship as JSON in packages/sim/maps/ (validated by loadMapFromJson
// and a schema test); the Phase 0 test map stays procedurally generated.

import bugHuntJson from "../maps/bug-hunt.json";
import districtJson from "../maps/district-01.json";
import hollywoodKeysJson from "../maps/hollywood-keys.json";
import laCantinaJson from "../maps/la-cantina.json";
import layeredTestJson from "../maps/layered-test.json";
import provingGroundJson from "../maps/proving-ground.json";
import urbanJungleJson from "../maps/urban-jungle.json";
import veniceBeachJson from "../maps/venice-beach.json";
import { clamp, cosLUT, lerp, sinLUT } from "./simMath";

/**
 * A 2D map point. `layer` is the stacked surface the feature sits on
 * (0 = ground / `heights`, 1+ = `layerHeights[layer-1]`). Absent in JSON → 0,
 * which is every pre-#33 arena and keeps their spawn heights bit-identical.
 */
export interface MapPoint {
  readonly x: number;
  readonly y: number;
  /** 0-based surface index; see resolveHeight. */
  readonly layer: number;
}

export interface MapSpawn {
  readonly x: number;
  readonly y: number;
  readonly yaw: number;
  readonly layer: number;
}

export interface MapPlot {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly layer: number;
}

/**
 * One weapon profile, seeded from an original BaseShooter/BaseTurret block
 * (docs/specs/fcop-logic.md §3.2). Referenced by index from turrets and base
 * defences so identical originals share one entry.
 *
 * A map with no profiles leaves every shooter on the global TURRET_* constants,
 * which is what keeps existing arenas bit-identical (rules.md §9).
 */
export interface MapWeapon {
  /** Engage range in meters. */
  readonly range: number;
  /** Fire cooldown / detection delay in ticks; >= 1. */
  readonly delay: number;
  /** Damage per shot. */
  readonly damage: number;
  /** Gun slew in radians per tick; 0 = instant (the pre-PA behavior). */
  readonly turnSpeed: number;
  /**
   * cos(fov/2), PRECOMPUTED at authoring time so the sim never calls trig
   * (CLAUDE.md determinism rule 1). -1 = omnidirectional, i.e. no restriction —
   * which is what every original Mp shooter carries (fov 4096 = 360°).
   */
  readonly fovCos: number;
}

/** A base's built-in defence weapon (fcop-logic.md §8.1: 4 per TeamBase). */
export interface MapBaseDefence {
  readonly x: number;
  readonly y: number;
  /** Index into MapData.weapons. */
  readonly weapon: number;
  readonly hp: number;
  readonly layer: number;
}

/**
 * One base ring turret. Carries the original Turret actor's own parameters
 * rather than only its position, because it is the same kind of shooter as a
 * capturable pad and the original gives it the same block: `engage_range`,
 * `targeting_delay`, `fov`, `turn_speed`, `gun_rotation` and `health`.
 *
 * `weapon` -1 and `hp` 0 mean "no imported parameters" — the pre-PA arenas
 * (district-01, hollywood-keys, venice-beach) authored bare positions, and those
 * fall back to the global TURRET_* constants and ARCHETYPE_MAX_HP exactly as
 * before.
 */
export interface MapBaseTurret {
  readonly x: number;
  readonly y: number;
  /** Index into MapData.weapons, or -1 for the global defaults. */
  readonly weapon: number;
  /** Max HP, or 0 for ARCHETYPE_MAX_HP[TURRET]. */
  readonly hp: number;
  /** Rest yaw (original gun_rotation). */
  readonly yaw: number;
  readonly layer: number;
}

/** One team's base structures (rules.md §5). Index = team id. */
export interface MapBase {
  /** Win trigger volume: enemy Runner/Juggernaut inside = breach. */
  readonly gate: MapPlot;
  /** Indestructible centerpiece (render + flavor, no gameplay hitbox). */
  readonly core: MapPoint;
  /** Build console for ground units (Runner/Juggernaut). */
  readonly groundConsole: MapPoint;
  /** Build console for air units (Guardian/Fortress). */
  readonly airConsole: MapPoint;
  /** Ammo/repair pad. */
  readonly pad: MapPlot;
  /** Ring turrets; each respawns 60 s after destruction. */
  readonly turrets: readonly MapBaseTurret[];
  /**
   * Built-in defence weapons bolted to the base structure itself
   * (fcop-logic.md §8.1). Kept separate from `turrets` so the ring concept —
   * and its max-8 guard — keeps its meaning. EMPTY on pre-PA arenas.
   */
  readonly defence: readonly MapBaseDefence[];
  /**
   * Destructible core HP (the original TeamBase carries 3000). 0 = the core is
   * indestructible and the gate breach is the only win condition (rules.md §1).
   * Non-zero switches this arena to the original's "destroy the enemy base"
   * objective (rules.md §9).
   */
  readonly coreHp: number;
  /**
   * Free unit production cadence in ticks (the original produces one unit every
   * 5 s onto its lane). 0 = no production, console purchases only.
   */
  readonly productionTicks: number;
  /** Max simultaneously alive produced units; 0 with productionTicks = unused. */
  readonly productionLimit: number;
}

/**
 * The original Cnet lane graph (fcop-logic.md §3.1) — a real graph with
 * junctions, unlike the flat `lanes` polylines.
 *
 * `nextHopA`/`nextHopB` are the reason this does NOT amount to runtime
 * pathfinding (rules.md §6): the routes are searched once at authoring time and
 * committed as a signpost per (team, node), so a unit reads at most one array
 * entry and makes at most one coin flip. It never searches.
 */
export interface MapLaneGraph {
  readonly nodes: readonly MapPoint[];
  /** 4 slots per node, -1 = no edge. length = nodes.length * 4. */
  readonly edges: Int16Array;
  /** Committed next hop toward the enemy base, [team * n + node]; -1 = arrived. */
  readonly nextHopA: Int16Array;
  /** Alternate next hop (a parallel road) or -1; picked by the seeded PRNG. */
  readonly nextHopB: Int16Array;
  /** Entry node per team (index = team id). */
  readonly entry: readonly number[];
}

/** A power-up spot (original ItemPickup, act_type 16). */
export interface MapPickup {
  readonly x: number;
  readonly y: number;
  /** PICKUP_* kind (balance.ts). */
  readonly kind: number;
  /** Ticks before the spot re-arms after being taken. */
  readonly respawnTicks: number;
  readonly layer: number;
}

/**
 * An axis-aligned base-intrusion volume (original Trigger, act_type 95;
 * fcop-logic.md §8.6). Detection only — the original's alert sound was bound in
 * the Cfun script and that binding is unrecovered, so the cue is the client's
 * choice.
 */
export interface MapTriggerVolume {
  readonly x: number;
  readonly y: number;
  readonly halfW: number;
  readonly halfL: number;
  /** Team whose base this guards. */
  readonly team: number;
  /** TRIGGER_WATCH_* bitmask (balance.ts). */
  readonly watch: number;
  readonly layer: number;
}

/**
 * A render-only scenery placement (original DynamicProp and friends).
 *
 * The SIM MUST NOT READ THIS. It rides along in the map so the client can place
 * original props without a second data file; packages/sim/test/map.test.ts
 * asserts no sim source file references it.
 */
export interface MapProp {
  readonly x: number;
  readonly y: number;
  readonly height: number;
  readonly yaw: number;
  /** Original Cobj resource id, so the renderer can pick the model. */
  readonly model: number;
  readonly layer: number;
}

export interface MapData {
  readonly id: string;
  /** Vertices per side (the grid is size × size, so (size-1)² cells). */
  readonly size: number;
  /** Meters per cell edge. */
  readonly cellSize: number;
  /** Row-major heights, index = row * size + col. */
  readonly heights: Float32Array;
  /** 1 = water (hover only). Row-major like heights, sampled per vertex. */
  readonly waterMask: Uint8Array;
  /** Water surface height in meters — hover rides on max(terrain, this). */
  readonly waterLevel: number;
  /**
   * Vertical wall segments (edge blockers on grid lines): wallsV[j*size+i]=1
   * blocks ±x crossings of the line x = i*cellSize within cell row j. EMPTY
   * (length 0) when the map has no walls — collision helpers early-out on
   * that, which is what keeps wall-free maps provably hash-identical.
   */
  readonly wallsV: Uint8Array;
  /** Horizontal twin: wallsH[j*size+i]=1 blocks ±y crossings of the line
   *  y = j*cellSize within cell column i. Empty when the map has no walls. */
  readonly wallsH: Uint8Array;
  /**
   * Extra walkable surfaces stacked above layer 0 (= `heights`). Index 0 here
   * is layer 1. Each is a full size×size heightfield (edge-extended so bilinear
   * sampling within a present cell is well-defined). EMPTY (length 0) for
   * single-story maps → resolveHeight early-outs and hashes stay byte-identical.
   */
  readonly layerHeights: readonly Float32Array[];
  /** Presence mask per extra layer, same indexing: 1 = deck present at this vertex. */
  readonly layerMask: readonly Uint8Array[];
  /**
   * Wall lattice PER extra layer, same indexing as layerHeights (index 0 is
   * layer 1). `wallsV`/`wallsH` above are layer 0's. EMPTY (length 0) when no
   * deck carries its own walls — every layer then shares the layer-0 lattice,
   * which is exactly the pre-#29 behaviour and what keeps every other map's
   * hashes byte-identical.
   *
   * A bridge's parapet blocks on the bridge, not on the road underneath, so a
   * lattice per deck is what stops the two from being charged to each other.
   */
  readonly layerWallsV: readonly Uint8Array[];
  /** Horizontal twin, same indexing. */
  readonly layerWallsH: readonly Uint8Array[];
  /** Avatar spawn per team (index = team id). */
  readonly spawns: readonly MapSpawn[];
  /** Base plot per team (index = team id): the flat build area. */
  readonly basePlots: readonly MapPlot[];
  /** Base structures per team (index = team id). */
  readonly bases: readonly MapBase[];
  /** Ground-unit lane polylines, each ≥ 2 waypoints, base 0 → base 1. */
  readonly lanes: readonly (readonly MapPoint[])[];
  /** Neutral turret spots (Phase 2/3). */
  readonly turretSpots: readonly MapPoint[];
  /** Neutral outpost spots (Phase 2/3). */
  readonly outpostSpots: readonly MapPoint[];
  /** Destructible test-dummy turret spots (Phase 1 sandbox targets). */
  readonly dummySpots: readonly MapPoint[];
  /**
   * Weapon profiles referenced by index. EMPTY → every shooter uses the global
   * TURRET_* constants, i.e. exactly the pre-PA numbers.
   */
  readonly weapons: readonly MapWeapon[];
  /**
   * Weapon index per `turretSpots` entry, same length and index space. EMPTY
   * means "all spots use the defaults" — the two lists are kept parallel rather
   * than fused so capture bookkeeping keeps indexing turretSpots directly.
   */
  readonly turretParams: readonly number[];
  /** Rest yaw per `turretSpots` entry (original gun_rotation). EMPTY = 0. */
  readonly turretYaw: readonly number[];
  /**
   * Max HP per `turretSpots` entry (original Turret `health`). EMPTY means
   * ARCHETYPE_MAX_HP[TURRET], the Phase-1 sandbox placeholder.
   */
  readonly turretHp: readonly number[];
  /** The original Cnet graph. `undefined` → follow the `lanes` polylines. */
  readonly laneGraph: MapLaneGraph | undefined;
  /** Power-up spots. EMPTY → no pickups on this arena. */
  readonly pickups: readonly MapPickup[];
  /** Base-intrusion volumes. EMPTY → no intrusion alerts. */
  readonly triggerVolumes: readonly MapTriggerVolume[];
  /** Render-only scenery. The sim must not read this. */
  readonly props: readonly MapProp[];
}

/** Playable extent in meters along one axis: [0, extent] on both axes. */
export function worldExtent(map: MapData): number {
  return (map.size - 1) * map.cellSize;
}

/**
 * Bilinear height sample at world position (x, y). Coordinates are clamped
 * to the map, so out-of-bounds queries return edge heights. Uses only
 * + - * /, floor, min, max — bit-exact on every engine.
 */
export function sampleHeight(map: MapData, x: number, y: number): number {
  const max = map.size - 1;
  const gx = clamp(x / map.cellSize, 0, max);
  const gy = clamp(y / map.cellSize, 0, max);
  let i0 = Math.floor(gx);
  let j0 = Math.floor(gy);
  if (i0 > max - 1) i0 = max - 1;
  if (j0 > max - 1) j0 = max - 1;
  const fx = gx - i0;
  const fy = gy - j0;
  const s = map.size;
  const row0 = j0 * s + i0;
  const row1 = row0 + s;
  const h0 = lerp(map.heights[row0], map.heights[row0 + 1], fx);
  const h1 = lerp(map.heights[row1], map.heights[row1 + 1], fx);
  return lerp(h0, h1, fy);
}

/**
 * Bilinear height sample on an EXTRA layer (layerIdx 0-based into layerHeights,
 * i.e. layerIdx 0 == layer 1). Same math as sampleHeight — bit-exact on every
 * engine. Out-of-range layerIdx degrades to the base surface.
 */
export function sampleLayerHeight(map: MapData, layerIdx: number, x: number, y: number): number {
  if (layerIdx < 0 || layerIdx >= map.layerHeights.length) return sampleHeight(map, x, y);
  const heights = map.layerHeights[layerIdx];
  const max = map.size - 1;
  const gx = clamp(x / map.cellSize, 0, max);
  const gy = clamp(y / map.cellSize, 0, max);
  let i0 = Math.floor(gx);
  let j0 = Math.floor(gy);
  if (i0 > max - 1) i0 = max - 1;
  if (j0 > max - 1) j0 = max - 1;
  const fx = gx - i0;
  const fy = gy - j0;
  const s = map.size;
  const row0 = j0 * s + i0;
  const row1 = row0 + s;
  const h0 = lerp(heights[row0], heights[row0 + 1], fx);
  const h1 = lerp(heights[row1], heights[row1 + 1], fx);
  return lerp(h0, h1, fy);
}

/**
 * Height of the walkable surface at (x, y) on `layer` (0 = base heights). The
 * layer===0 / no-extra-layers early-out makes single-story maps bit-identical
 * to a plain sampleHeight (No-op invariant).
 */
export function resolveHeight(map: MapData, x: number, y: number, layer: number): number {
  if (layer === 0 || map.layerHeights.length === 0) return sampleHeight(map, x, y);
  return sampleLayerHeight(map, layer - 1, x, y);
}

/** Water test at world position (x, y): nearest-vertex sample, clamped. */
export function isWater(map: MapData, x: number, y: number): boolean {
  const max = map.size - 1;
  const i = clamp(Math.floor(x / map.cellSize + 0.5), 0, max);
  const j = clamp(Math.floor(y / map.cellSize + 0.5), 0, max);
  return map.waterMask[j * map.size + i] === 1;
}

/** Map registry: resolves the mapId stored in replays/net handshakes. */
export function getMapById(id: string): MapData {
  if (id === TEST_MAP_ID) return createTestMap();
  if (id === LAYERED_TEST_ID) return loadMapFromJson(layeredTestJson as MapJson);
  // District 01 is retired from the picker but still resolvable by id: goldens,
  // tools and the historic replay harnesses load it directly (like the debug
  // maps above), so it stays available without cluttering the menu.
  if (id === DISTRICT_01_ID) return loadMapFromJson(districtJson as MapJson);
  for (const entry of REGISTRY) {
    if (entry.info.id === id) return loadMapFromJson(entry.json);
  }
  throw new Error(`unknown map id: ${id}`);
}

export const DISTRICT_01_ID = "district-01";

/** FCOP "Urban Jungle" arena (mission Conft), heightfield extracted 1:1. */
export const URBAN_JUNGLE_ID = "urban-jungle";

/** FCOP "Proving Ground" arena (mission Slim), heightfield extracted 1:1. */
export const PROVING_GROUND_ID = "proving-ground";

/** FCOP "La Cantina" arena (mission Mp), heightfield extracted 1:1. */
export const LA_CANTINA_ID = "la-cantina";

/** FCOP "Bug Hunt" arena (mission Joke), heightfield extracted 1:1. */
export const BUG_HUNT_ID = "bug-hunt";

/** FCOP "Hollywood Keys" arena (mission Hk) — layered (multi-deck, Stage 5). */
export const HOLLYWOOD_KEYS_ID = "hollywood-keys";

/** FCOP "Venice Beach" PA arena (mission Ovmp) — layered (multi-deck, Stage 5). */
export const VENICE_BEACH_ID = "venice-beach";

/** Synthetic multi-deck sandbox for layered-movement tests (debug-only, NOT in MAP_REGISTRY). */
export const LAYERED_TEST_ID = "layered-test";

/** Metadata for one selectable arena — what a map picker needs to offer it. */
export interface MapInfo {
  /** Registry id — the exact string stored in replays and the net handshake. */
  readonly id: string;
  /** Human-readable arena name. */
  readonly displayName: string;
}

// Adding an arena = one entry here + its JSON in packages/sim/maps/.
// (District 01 is intentionally absent — retired from the picker but kept
// resolvable by id in getMapById above for goldens/tools.)
const REGISTRY: readonly { readonly info: MapInfo; readonly json: MapJson }[] = [
  { info: { id: URBAN_JUNGLE_ID, displayName: "Urban Jungle" }, json: urbanJungleJson },
  { info: { id: PROVING_GROUND_ID, displayName: "Proving Ground" }, json: provingGroundJson },
  { info: { id: LA_CANTINA_ID, displayName: "La Cantina" }, json: laCantinaJson },
  { info: { id: BUG_HUNT_ID, displayName: "Bug Hunt" }, json: bugHuntJson },
  { info: { id: HOLLYWOOD_KEYS_ID, displayName: "Hollywood Keys" }, json: hollywoodKeysJson },
  { info: { id: VENICE_BEACH_ID, displayName: "Venice Beach" }, json: veniceBeachJson },
];

/** Selectable arenas in display order. test-128 stays a debug-only deep link. */
export const MAP_REGISTRY: readonly MapInfo[] = REGISTRY.map((e) => e.info);

/**
 * Fixed-point scale for JSON heights: 1/32 m steps are exact binary
 * fractions, so `int * HEIGHT_SCALE` reconstructs bit-identical floats on
 * every engine.
 */
export const HEIGHT_SCALE = 0.03125;

/** Shape of a map JSON file (packages/sim/maps/*.json). */
export interface MapJson {
  id: string;
  size: number;
  cellSize: number;
  /** Rows of heights in 1/32 m integer units. */
  heights: number[][];
  /** Rows of '0'/'1' characters, 1 = water. */
  water: string[];
  /** Water surface height in meters. */
  waterLevel: number;
  /**
   * OPTIONAL wall data (both present or both absent): size rows of size
   * '0'/'1' chars each. wallsV[j][i] blocks ±x over line x = i*cellSize in
   * cell row j; wallsH[j][i] blocks ±y over line y = j*cellSize in cell
   * column i. Absent → the loaded map has EMPTY wall arrays (no-op movement).
   */
  wallsV?: string[];
  wallsH?: string[];
  /**
   * OPTIONAL extra walkable decks above layer 0. Each: `heights` in 1/32 m
   * ints (size rows × size), `mask` size rows of size '0'/'1' chars, plus that
   * deck's OWN optional wall lattice (both present or both absent, same shape as
   * the top-level pair). Absent → single-story (empty layer arrays); layer walls
   * absent → every deck shares the layer-0 lattice.
   */
  layers?: { heights: number[][]; mask: string[]; wallsV?: string[]; wallsH?: string[] }[];
  /** Optional `layer` (default 0) — surface the spawn sits on (issue #33). */
  spawns: { x: number; y: number; yaw: number; layer?: number }[];
  basePlots: { x: number; y: number; radius: number; layer?: number }[];
  bases: MapBaseJson[];
  /**
   * Point lists are `[x, y]` pairs (layer 0) or `{x, y, layer?}` objects.
   * Length is validated at load time.
   */
  lanes: (number[] | { x: number; y: number; layer?: number })[][];
  turretSpots: (number[] | { x: number; y: number; layer?: number })[];
  outpostSpots: (number[] | { x: number; y: number; layer?: number })[];
  dummySpots: (number[] | { x: number; y: number; layer?: number })[];
  /**
   * OPTIONAL Precinct Assault data (rules.md §9). Every field here is absent on
   * the pre-PA arenas and on the inline MapJson literals the tests build, which
   * is what makes the load produce empty arrays and the sim behave exactly as
   * before — the property the golden replays depend on.
   */
  weapons?: { range: number; delay: number; damage: number; turnSpeed: number; fovCos: number }[];
  /** Weapon index per turretSpots entry; length must equal turretSpots.length. */
  turretParams?: number[];
  /** Rest yaw per turretSpots entry; length must equal turretSpots.length. */
  turretYaw?: number[];
  /** Max HP per turretSpots entry; length must equal turretSpots.length. */
  turretHp?: number[];
  /** Original Cnet graph. `edges` is one 4-tuple per node, -1 = no edge. */
  laneGraph?: {
    nodes: (number[] | { x: number; y: number; layer?: number })[];
    edges: number[][];
    nextHopA: number[][];
    nextHopB: number[][];
    entry: number[];
  };
  pickups?: { x: number; y: number; kind: number; respawnTicks: number; layer?: number }[];
  triggerVolumes?: {
    x: number;
    y: number;
    halfW: number;
    halfL: number;
    team: number;
    watch: number;
    layer?: number;
  }[];
  /** Render-only scenery; never read by the sim. */
  props?: { x: number; y: number; height: number; yaw: number; model: number; layer?: number }[];
}

/** JSON shape of one base; point lists are [x, y] pairs or {x,y,layer?} objects. */
export interface MapBaseJson {
  gate: { x: number; y: number; radius: number; layer?: number };
  core: number[] | { x: number; y: number; layer?: number };
  groundConsole: number[] | { x: number; y: number; layer?: number };
  airConsole: number[] | { x: number; y: number; layer?: number };
  pad: { x: number; y: number; radius: number; layer?: number };
  /**
   * Ring turrets. Either a bare `[x, y]` pair (pre-PA arenas: global weapon
   * defaults) or an object carrying the original Turret actor's parameters. Both
   * forms are accepted so the arenas that never had the data stay byte-identical.
   */
  turrets: (
    | number[]
    | { x: number; y: number; weapon: number; hp: number; yaw: number; layer?: number }
  )[];
  /** OPTIONAL PA extras; absent → empty / 0, i.e. pre-PA behavior. */
  defence?: { x: number; y: number; weapon: number; hp: number; layer?: number }[];
  coreHp?: number;
  productionTicks?: number;
  productionLimit?: number;
}

function fail(id: string, reason: string): never {
  throw new Error(`invalid map "${id}": ${reason}`);
}

/** Parses + validates a map JSON. Throws with a precise reason if malformed. */
export function loadMapFromJson(raw: MapJson): MapData {
  const { id, size, cellSize } = raw;
  if (!id || typeof id !== "string") fail("?", "missing id");
  if (!Number.isInteger(size) || size < 2 || size > 1024) fail(id, `bad size ${size}`);
  if (!(cellSize > 0)) fail(id, `bad cellSize ${cellSize}`);
  if (typeof raw.waterLevel !== "number") fail(id, "missing waterLevel");
  if (raw.heights.length !== size) fail(id, `expected ${size} height rows`);
  if (raw.water.length !== size) fail(id, `expected ${size} water rows`);

  const heights = new Float32Array(size * size);
  const waterMask = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    const hRow = raw.heights[j];
    const wRow = raw.water[j];
    if (hRow.length !== size) fail(id, `height row ${j} has ${hRow.length} entries`);
    if (wRow.length !== size) fail(id, `water row ${j} has ${wRow.length} chars`);
    for (let i = 0; i < size; i++) {
      const q = hRow[i];
      if (!Number.isInteger(q)) fail(id, `non-integer height at (${i}, ${j})`);
      heights[j * size + i] = q * HEIGHT_SCALE;
      const w = wRow.charCodeAt(i);
      if (w !== 0x30 && w !== 0x31) fail(id, `water row ${j} has non-0/1 char at ${i}`);
      waterMask[j * size + i] = w - 0x30;
    }
  }

  // Walls are optional but must come as a pair; a lone array is authoring rot.
  if ((raw.wallsV === undefined) !== (raw.wallsH === undefined)) {
    fail(id, "wallsV and wallsH must both be present or both be absent");
  }
  const parseWalls = (rows: string[], what: string): Uint8Array => {
    if (rows.length !== size) fail(id, `expected ${size} ${what} rows`);
    const bits = new Uint8Array(size * size);
    for (let j = 0; j < size; j++) {
      const row = rows[j];
      if (row.length !== size) fail(id, `${what} row ${j} has ${row.length} chars`);
      for (let i = 0; i < size; i++) {
        const c = row.charCodeAt(i);
        if (c !== 0x30 && c !== 0x31) fail(id, `${what} row ${j} has non-0/1 char at ${i}`);
        bits[j * size + i] = c - 0x30;
      }
    }
    return bits;
  };
  const wallsV = raw.wallsV ? parseWalls(raw.wallsV, "wallsV") : new Uint8Array(0);
  const wallsH = raw.wallsH ? parseWalls(raw.wallsH, "wallsH") : new Uint8Array(0);

  // Optional extra decks: each a full size×size heightfield (1/32 m ints) +
  // a present mask. Absent → single-story (empty arrays → resolveHeight no-op).
  const layerHeights: Float32Array[] = [];
  const layerMask: Uint8Array[] = [];
  const layerWallsV: Uint8Array[] = [];
  const layerWallsH: Uint8Array[] = [];
  let anyLayerWalls = false;
  if (raw.layers) {
    for (let L = 0; L < raw.layers.length; L++) {
      const layer = raw.layers[L];
      if (!layer || !Array.isArray(layer.heights) || !Array.isArray(layer.mask)) {
        fail(id, `layer ${L} needs heights[] and mask[]`);
      }
      if (layer.heights.length !== size) fail(id, `layer ${L} expected ${size} height rows`);
      if (layer.mask.length !== size) fail(id, `layer ${L} expected ${size} mask rows`);
      const lh = new Float32Array(size * size);
      const lm = new Uint8Array(size * size);
      for (let j = 0; j < size; j++) {
        const hRow = layer.heights[j];
        const mRow = layer.mask[j];
        if (hRow.length !== size) fail(id, `layer ${L} height row ${j} has ${hRow.length} entries`);
        if (mRow.length !== size) fail(id, `layer ${L} mask row ${j} has ${mRow.length} chars`);
        for (let i = 0; i < size; i++) {
          const q = hRow[i];
          if (!Number.isInteger(q)) fail(id, `layer ${L} non-integer height at (${i}, ${j})`);
          lh[j * size + i] = q * HEIGHT_SCALE;
          const c = mRow.charCodeAt(i);
          if (c !== 0x30 && c !== 0x31)
            fail(id, `layer ${L} mask row ${j} has non-0/1 char at ${i}`);
          lm[j * size + i] = c - 0x30;
        }
      }
      layerHeights.push(lh);
      layerMask.push(lm);

      // Per-deck walls, on the same both-or-neither rule as the top-level pair.
      // A deck without its own lattice inherits layer 0's, so a partially
      // annotated map degrades to the old shared-lattice behaviour instead of
      // silently losing a deck's collision.
      if ((layer.wallsV === undefined) !== (layer.wallsH === undefined)) {
        fail(id, `layer ${L} wallsV and wallsH must both be present or both be absent`);
      }
      if (layer.wallsV && layer.wallsH) {
        layerWallsV.push(parseWalls(layer.wallsV, `layer ${L} wallsV`));
        layerWallsH.push(parseWalls(layer.wallsH, `layer ${L} wallsH`));
        anyLayerWalls = true;
      } else {
        layerWallsV.push(wallsV);
        layerWallsH.push(wallsH);
      }
    }
  }
  // No deck brought its own walls → drop the arrays entirely so the collision
  // helpers take their length-0 fast path and stay bit-identical.
  if (!anyLayerWalls) {
    layerWallsV.length = 0;
    layerWallsH.length = 0;
  }

  const extent = (size - 1) * cellSize;
  const inBounds = (x: number, y: number) => x >= 0 && x <= extent && y >= 0 && y <= extent;
  /** Highest legal layer index: 0 = ground, layerHeights.length = top deck. */
  const maxLayer = layerHeights.length;
  const layerOf = (v: unknown, what: string): number => {
    if (v === undefined || v === null) return 0;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > maxLayer) {
      fail(id, `${what} layer ${String(v)} out of range (0..${maxLayer})`);
    }
    return v as number;
  };
  if (raw.spawns.length !== 2) fail(id, "need exactly 2 spawns");
  if (raw.basePlots.length !== 2) fail(id, "need exactly 2 base plots");
  for (const s of raw.spawns) {
    if (!inBounds(s.x, s.y)) fail(id, `spawn out of bounds (${s.x}, ${s.y})`);
  }
  /**
   * A map point: either the historic `[x, y]` pair (layer 0) or an object
   * `{x, y, layer?}`. Object form is what issue #33 needs for deck features.
   */
  const point = (p: unknown, what: string): MapPoint => {
    if (Array.isArray(p)) {
      if (p.length !== 2) fail(id, `${what} is not an [x, y] pair`);
      const [x, y] = p;
      if (typeof x !== "number" || typeof y !== "number") {
        fail(id, `${what} is not an [x, y] pair`);
      }
      if (!inBounds(x, y)) fail(id, `${what} out of bounds (${x}, ${y})`);
      return { x, y, layer: 0 };
    }
    if (!p || typeof p !== "object") fail(id, `${what} is not a point`);
    const o = p as { x?: unknown; y?: unknown; layer?: unknown };
    if (typeof o.x !== "number" || typeof o.y !== "number") {
      fail(id, `${what} is not an {x, y} point`);
    }
    if (!inBounds(o.x, o.y)) fail(id, `${what} out of bounds (${o.x}, ${o.y})`);
    return { x: o.x, y: o.y, layer: layerOf(o.layer, what) };
  };
  for (const lane of raw.lanes) {
    if (lane.length < 2) fail(id, "lane with fewer than 2 waypoints");
  }
  const points = (list: unknown[], what: string): MapPoint[] =>
    list.map((p, i) => point(p, `${what} ${i}`));

  const plot = (
    p: { x: number; y: number; radius: number; layer?: number },
    what: string,
  ): MapPlot => {
    if (!p || typeof p.x !== "number" || typeof p.y !== "number" || !(p.radius > 0)) {
      fail(id, `${what} is not an {x, y, radius} plot`);
    }
    if (!inBounds(p.x, p.y)) fail(id, `${what} out of bounds (${p.x}, ${p.y})`);
    return { x: p.x, y: p.y, radius: p.radius, layer: layerOf(p.layer, what) };
  };
  /**
   * Asserts a field really is a finite number before it reaches MapData.
   *
   * `point` and `plot` have always checked `typeof === "number"`, but the §9
   * parsers below grew up comparing raw fields directly — `inBounds(v.x, v.y)`,
   * `d.hp > 0`, `w.range > 0` — and JS coercion lets `{ x: "10", hp: "500" }`
   * through every one of those, storing strings in a struct the sim then does
   * arithmetic on. Routing the loose fields through here makes the whole loader
   * uniformly strict, which is the job it advertises in its own doc comment.
   */
  const num = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      fail(id, `${what} is not a finite number (got ${typeof v} ${String(v)})`);
    }
    return v;
  };
  // --- Precinct Assault features (rules.md §9) ----------------------------
  // All optional. Absent → empty arrays / undefined / 0, which every consumer
  // treats as "feature not present on this arena".
  const weapons: MapWeapon[] = (raw.weapons ?? []).map((w, k) => {
    if (!w || typeof w !== "object") fail(id, `weapon ${k} is not an object`);
    const range = num(w.range, `weapon ${k} range`);
    const damage = num(w.damage, `weapon ${k} damage`);
    const turnSpeed = num(w.turnSpeed, `weapon ${k} turnSpeed`);
    const fovCos = num(w.fovCos, `weapon ${k} fovCos`);
    if (!(range > 0)) fail(id, `weapon ${k} bad range ${range}`);
    if (!Number.isInteger(w.delay) || w.delay < 1) fail(id, `weapon ${k} bad delay ${w.delay}`);
    if (!(damage >= 0)) fail(id, `weapon ${k} bad damage ${damage}`);
    if (!(turnSpeed >= 0)) fail(id, `weapon ${k} bad turnSpeed ${turnSpeed}`);
    if (!(fovCos >= -1 && fovCos <= 1)) fail(id, `weapon ${k} bad fovCos ${fovCos}`);
    return { range, delay: w.delay, damage, turnSpeed, fovCos };
  });
  const weaponIndex = (v: number, what: string): number => {
    if (!Number.isInteger(v) || v < 0 || v >= weapons.length) {
      fail(id, `${what} weapon index ${v} out of range (${weapons.length} profiles)`);
    }
    return v;
  };

  if (!Array.isArray(raw.bases) || raw.bases.length !== 2) fail(id, "need exactly 2 bases");
  const bases: MapBase[] = raw.bases.map((b, team) => {
    if (!b || typeof b !== "object") fail(id, `base ${team} is not an object`);
    if (!Array.isArray(b.turrets)) fail(id, `base ${team} turrets is not a list`);
    // 16, not 8: the original Mp places 16 base-defence Turret actors per base
    // (fcop-logic.md §8.2). The cap still exists to catch authoring runaway.
    if (b.turrets.length > 16) {
      fail(id, `base ${team} has ${b.turrets.length} ring turrets (max 16)`);
    }
    const coreHp = b.coreHp ?? 0;
    const productionTicks = b.productionTicks ?? 0;
    const productionLimit = b.productionLimit ?? 0;
    if (!Number.isInteger(coreHp) || coreHp < 0) fail(id, `base ${team} bad coreHp ${coreHp}`);
    if (!Number.isInteger(productionTicks) || productionTicks < 0) {
      fail(id, `base ${team} bad productionTicks ${productionTicks}`);
    }
    if (!Number.isInteger(productionLimit) || productionLimit < 0) {
      fail(id, `base ${team} bad productionLimit ${productionLimit}`);
    }
    // Production with no ceiling would fill the entity store; the sim also
    // clamps, but authoring should not rely on that.
    if (productionTicks > 0 && productionLimit < 1) {
      fail(id, `base ${team} produces every ${productionTicks} ticks with no productionLimit`);
    }
    return {
      gate: plot(b.gate, `base ${team} gate`),
      core: point(b.core, `base ${team} core`),
      groundConsole: point(b.groundConsole, `base ${team} ground console`),
      airConsole: point(b.airConsole, `base ${team} air console`),
      pad: plot(b.pad, `base ${team} pad`),
      turrets: b.turrets.map((t, k) => {
        const what = `base ${team} ring turret ${k}`;
        // Bare pair: the pre-PA authoring form. Sentinels say "use the globals",
        // which is what those arenas did before this field existed.
        if (Array.isArray(t)) {
          const p = point(t, what);
          return { x: p.x, y: p.y, weapon: -1, hp: 0, yaw: 0, layer: p.layer };
        }
        if (!t || typeof t !== "object") fail(id, `${what} is neither a pair nor an object`);
        const x = num(t.x, `${what} x`);
        const y = num(t.y, `${what} y`);
        const hp = num(t.hp, `${what} hp`);
        const yaw = num(t.yaw, `${what} yaw`);
        if (!inBounds(x, y)) fail(id, `${what} out of bounds (${x}, ${y})`);
        if (!(hp > 0)) fail(id, `${what} bad hp ${hp}`);
        return {
          x,
          y,
          weapon: weaponIndex(t.weapon, what),
          hp,
          yaw,
          layer: layerOf(t.layer, what),
        };
      }),
      defence: (b.defence ?? []).map((d, k) => {
        if (!d || typeof d !== "object") fail(id, `base ${team} defence ${k} is not an object`);
        const dx = num(d.x, `base ${team} defence ${k} x`);
        const dy = num(d.y, `base ${team} defence ${k} y`);
        const dhp = num(d.hp, `base ${team} defence ${k} hp`);
        if (!inBounds(dx, dy)) {
          fail(id, `base ${team} defence ${k} out of bounds (${dx}, ${dy})`);
        }
        if (!(dhp > 0)) fail(id, `base ${team} defence ${k} bad hp ${dhp}`);
        return {
          x: dx,
          y: dy,
          weapon: weaponIndex(d.weapon, `base ${team} defence ${k}`),
          hp: dhp,
          layer: layerOf(d.layer, `base ${team} defence ${k}`),
        };
      }),
      coreHp,
      productionTicks,
      productionLimit,
    };
  });

  const turretSpots = points(raw.turretSpots, "turret spot");
  const perSpot = (list: number[] | undefined, what: string): number[] => {
    if (list === undefined) return [];
    if (list.length !== turretSpots.length) {
      fail(id, `${what} has ${list.length} entries for ${turretSpots.length} turret spots`);
    }
    return list;
  };
  const turretParams = perSpot(raw.turretParams, "turretParams").map((v, k) =>
    weaponIndex(v, `turret spot ${k}`),
  );
  const turretYaw = perSpot(raw.turretYaw, "turretYaw").map((v, k) => {
    if (typeof v !== "number" || !Number.isFinite(v)) fail(id, `turret spot ${k} bad yaw ${v}`);
    return v;
  });
  const turretHp = perSpot(raw.turretHp, "turretHp").map((v, k) => {
    if (!Number.isInteger(v) || v < 1) fail(id, `turret spot ${k} bad hp ${v}`);
    return v;
  });

  let laneGraph: MapLaneGraph | undefined;
  if (raw.laneGraph) {
    const g = raw.laneGraph;
    if (!Array.isArray(g.nodes) || g.nodes.length < 2) fail(id, "laneGraph needs >= 2 nodes");
    const n = g.nodes.length;
    if (n > 0x7fff) fail(id, `laneGraph has ${n} nodes (max 32767)`);
    const nodes = g.nodes.map((p) => point(p, "laneGraph node"));
    if (!Array.isArray(g.edges) || g.edges.length !== n) {
      fail(id, `laneGraph edges has ${g.edges?.length} rows for ${n} nodes`);
    }
    const edges = new Int16Array(n * 4);
    for (let k = 0; k < n; k++) {
      const row = g.edges[k];
      if (!Array.isArray(row) || row.length !== 4) {
        fail(id, `laneGraph edges row ${k} is not a 4-tuple`);
      }
      for (let s = 0; s < 4; s++) {
        const v = row[s];
        if (!Number.isInteger(v) || v < -1 || v >= n) {
          fail(id, `laneGraph edge ${k}.${s} target ${v} out of range`);
        }
        if (v === k) fail(id, `laneGraph node ${k} links to itself`);
        edges[k * 4 + s] = v;
      }
    }
    if (!Array.isArray(g.entry) || g.entry.length !== 2) fail(id, "laneGraph needs 2 entry nodes");
    for (const e of g.entry) {
      if (!Number.isInteger(e) || e < 0 || e >= n) fail(id, `laneGraph entry ${e} out of range`);
    }
    const hops = (rows: number[][], what: string): Int16Array => {
      if (!Array.isArray(rows) || rows.length !== 2) fail(id, `laneGraph ${what} needs 2 rows`);
      const out = new Int16Array(2 * n);
      for (let team = 0; team < 2; team++) {
        const row = rows[team];
        if (!Array.isArray(row) || row.length !== n) {
          fail(id, `laneGraph ${what} row ${team} has ${row?.length} entries for ${n} nodes`);
        }
        for (let k = 0; k < n; k++) {
          const v = row[k];
          if (!Number.isInteger(v) || v < -1 || v >= n) {
            fail(id, `laneGraph ${what}[${team}][${k}] target ${v} out of range`);
          }
          // The invariant that makes runtime traversal safe: a signpost may only
          // ever point along an edge that actually exists.
          if (v >= 0) {
            let linked = false;
            for (let s = 0; s < 4; s++) if (edges[k * 4 + s] === v) linked = true;
            if (!linked) fail(id, `laneGraph ${what}[${team}][${k}] -> ${v} is not a neighbour`);
          }
          out[team * n + k] = v;
        }
      }
      return out;
    };
    const nextHopA = hops(g.nextHopA, "nextHopA");
    const nextHopB = hops(g.nextHopB, "nextHopB");
    // Following the primary signposts must terminate, or a unit would circle
    // forever. Checked at load so the sim can walk them without a step budget.
    for (let team = 0; team < 2; team++) {
      let at = g.entry[team];
      let steps = 0;
      while (at >= 0) {
        if (steps++ > n) fail(id, `laneGraph nextHopA loops for team ${team}`);
        at = nextHopA[team * n + at];
      }
    }
    laneGraph = { nodes, edges, nextHopA, nextHopB, entry: [g.entry[0], g.entry[1]] };
  }

  const pickups: MapPickup[] = (raw.pickups ?? []).map((p, k) => {
    if (!p || typeof p !== "object") fail(id, `pickup ${k} is not an object`);
    const x = num(p.x, `pickup ${k} x`);
    const y = num(p.y, `pickup ${k} y`);
    if (!inBounds(x, y)) fail(id, `pickup ${k} out of bounds (${x}, ${y})`);
    if (!Number.isInteger(p.kind) || p.kind < 0) fail(id, `pickup ${k} bad kind ${p.kind}`);
    if (!Number.isInteger(p.respawnTicks) || p.respawnTicks < 0) {
      fail(id, `pickup ${k} bad respawnTicks ${p.respawnTicks}`);
    }
    return {
      x,
      y,
      kind: p.kind,
      respawnTicks: p.respawnTicks,
      layer: layerOf(p.layer, `pickup ${k}`),
    };
  });

  const triggerVolumes: MapTriggerVolume[] = (raw.triggerVolumes ?? []).map((v, k) => {
    if (!v || typeof v !== "object") fail(id, `trigger ${k} is not an object`);
    const x = num(v.x, `trigger ${k} x`);
    const y = num(v.y, `trigger ${k} y`);
    const halfW = num(v.halfW, `trigger ${k} halfW`);
    const halfL = num(v.halfL, `trigger ${k} halfL`);
    if (!inBounds(x, y)) fail(id, `trigger ${k} out of bounds (${x}, ${y})`);
    if (!(halfW > 0) || !(halfL > 0)) fail(id, `trigger ${k} needs positive half extents`);
    if (v.team !== 0 && v.team !== 1) fail(id, `trigger ${k} bad team ${v.team}`);
    if (!Number.isInteger(v.watch) || v.watch < 0) fail(id, `trigger ${k} bad watch ${v.watch}`);
    return {
      x,
      y,
      halfW,
      halfL,
      team: v.team,
      watch: v.watch,
      layer: layerOf(v.layer, `trigger ${k}`),
    };
  });

  return {
    id,
    size,
    cellSize,
    heights,
    waterMask,
    waterLevel: raw.waterLevel,
    wallsV,
    wallsH,
    layerHeights,
    layerMask,
    layerWallsV,
    layerWallsH,
    spawns: raw.spawns.map((s, i) => ({
      x: s.x,
      y: s.y,
      yaw: s.yaw,
      layer: layerOf(s.layer, `spawn ${i}`),
    })),
    basePlots: raw.basePlots.map((p, i) => plot(p, `base plot ${i}`)),
    bases,
    lanes: raw.lanes.map((lane) => lane.map((p) => point(p, "lane waypoint"))),
    turretSpots,
    outpostSpots: points(raw.outpostSpots, "outpost spot"),
    dummySpots: points(raw.dummySpots, "dummy spot"),
    weapons,
    turretParams,
    turretYaw,
    turretHp,
    laneGraph,
    pickups,
    triggerVolumes,
    // Render-only, and deliberately not validated against bounds: props are
    // scenery, so an out-of-play prop is a cosmetic question, not a load error.
    props: (raw.props ?? []).map((p) => ({
      x: p.x,
      y: p.y,
      height: p.height,
      yaw: p.yaw,
      model: p.model,
      layer: typeof p.layer === "number" && Number.isInteger(p.layer) && p.layer >= 0 ? p.layer : 0,
    })),
  };
}

export const TEST_MAP_ID = "test-128";
export const TEST_MAP_SIZE = 128;
export const TEST_MAP_CELL_SIZE = 2;

/**
 * Deterministic rolling-hills test map (Phase 0). Built exclusively from
 * simMath LUT trig, so every peer generates bit-identical heights — pinned
 * by a hash test. Feature lists are minimal: spawns/base plots sit at the
 * map center, no lanes or spots.
 */
export function createTestMap(): MapData {
  const size = TEST_MAP_SIZE;
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const h =
        4 * sinLUT(i * 0.1) * sinLUT(j * 0.13) +
        2 * sinLUT((i + j) * 0.045) +
        1.2 * sinLUT(i * 0.31) * cosLUT(j * 0.22);
      heights[j * size + i] = h;
    }
  }
  const center = ((size - 1) * TEST_MAP_CELL_SIZE) / 2;
  const extent = (size - 1) * TEST_MAP_CELL_SIZE;
  // Minimal sandbox bases: pads cover the shared center plot (Phase-1-style
  // ammo behavior), gates sit in opposite corners far from the action, no
  // ring turrets — the test map stays a combat-free driving range.
  const testBase = (team: number): MapBase => ({
    gate: {
      x: team === 0 ? 10 : extent - 10,
      y: team === 0 ? 10 : extent - 10,
      radius: 6,
      layer: 0,
    },
    core: { x: center + (team === 0 ? -6 : 6), y: center, layer: 0 },
    groundConsole: { x: center + (team === 0 ? -12 : 12), y: center, layer: 0 },
    airConsole: { x: center, y: center + (team === 0 ? -12 : 12), layer: 0 },
    pad: { x: center, y: center, radius: 20, layer: 0 },
    turrets: [],
    // No Precinct Assault features on the sandbox map: an indestructible core
    // and no production keep it on the gate-breach rules, and the empty lists
    // are what make every PA system a provable no-op here.
    defence: [],
    coreHp: 0,
    productionTicks: 0,
    productionLimit: 0,
  });
  return {
    id: TEST_MAP_ID,
    size,
    cellSize: TEST_MAP_CELL_SIZE,
    heights,
    waterMask: new Uint8Array(size * size),
    waterLevel: -10, // below every valley: the test map has no water at all
    wallsV: new Uint8Array(0),
    wallsH: new Uint8Array(0),
    layerHeights: [],
    layerMask: [],
    layerWallsV: [],
    layerWallsH: [],
    spawns: [
      { x: center, y: center, yaw: 0, layer: 0 },
      { x: center, y: center, yaw: 0, layer: 0 },
    ],
    basePlots: [
      { x: center, y: center, radius: 20, layer: 0 },
      { x: center, y: center, radius: 20, layer: 0 },
    ],
    bases: [testBase(0), testBase(1)],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
    weapons: [],
    turretParams: [],
    turretYaw: [],
    turretHp: [],
    laneGraph: undefined,
    pickups: [],
    triggerVolumes: [],
    props: [],
  };
}
