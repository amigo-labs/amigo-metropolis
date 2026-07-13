// Map data: heightfield grid + water mask + authored features (bases, lanes,
// turret/outpost spots) per architecture.md §2. The same heights drive sim
// ground-snap/slope checks AND the render mesh — single source of truth.
// Real maps ship as JSON in packages/sim/maps/ (validated by loadMapFromJson
// and a schema test); the Phase 0 test map stays procedurally generated.

import bugHuntJson from "../maps/bug-hunt.json";
import districtJson from "../maps/district-01.json";
import laCantinaJson from "../maps/la-cantina.json";
import layeredTestJson from "../maps/layered-test.json";
import provingGroundJson from "../maps/proving-ground.json";
import urbanJungleJson from "../maps/urban-jungle.json";
import { clamp, cosLUT, lerp, sinLUT } from "./simMath";

export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

export interface MapSpawn {
  readonly x: number;
  readonly y: number;
  readonly yaw: number;
}

export interface MapPlot {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
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
  /** Ring turret positions; each respawns 60 s after destruction. */
  readonly turrets: readonly MapPoint[];
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
const REGISTRY: readonly { readonly info: MapInfo; readonly json: MapJson }[] = [
  { info: { id: DISTRICT_01_ID, displayName: "District 01" }, json: districtJson },
  { info: { id: URBAN_JUNGLE_ID, displayName: "Urban Jungle" }, json: urbanJungleJson },
  { info: { id: PROVING_GROUND_ID, displayName: "Proving Ground" }, json: provingGroundJson },
  { info: { id: LA_CANTINA_ID, displayName: "La Cantina" }, json: laCantinaJson },
  { info: { id: BUG_HUNT_ID, displayName: "Bug Hunt" }, json: bugHuntJson },
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
   * ints (size rows × size), `mask` size rows of size '0'/'1' chars. Absent →
   * single-story (empty layer arrays).
   */
  layers?: { heights: number[][]; mask: string[] }[];
  spawns: { x: number; y: number; yaw: number }[];
  basePlots: { x: number; y: number; radius: number }[];
  bases: MapBaseJson[];
  /** Point lists are [x, y] pairs; length is validated at load time. */
  lanes: number[][][];
  turretSpots: number[][];
  outpostSpots: number[][];
  dummySpots: number[][];
}

/** JSON shape of one base; point lists are [x, y] pairs like everywhere else. */
export interface MapBaseJson {
  gate: { x: number; y: number; radius: number };
  core: number[];
  groundConsole: number[];
  airConsole: number[];
  pad: { x: number; y: number; radius: number };
  turrets: number[][];
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
          if (c !== 0x30 && c !== 0x31) fail(id, `layer ${L} mask row ${j} has non-0/1 char at ${i}`);
          lm[j * size + i] = c - 0x30;
        }
      }
      layerHeights.push(lh);
      layerMask.push(lm);
    }
  }

  const extent = (size - 1) * cellSize;
  const inBounds = (x: number, y: number) => x >= 0 && x <= extent && y >= 0 && y <= extent;
  if (raw.spawns.length !== 2) fail(id, "need exactly 2 spawns");
  if (raw.basePlots.length !== 2) fail(id, "need exactly 2 base plots");
  for (const s of raw.spawns) {
    if (!inBounds(s.x, s.y)) fail(id, `spawn out of bounds (${s.x}, ${s.y})`);
  }
  const point = (p: number[], what: string): MapPoint => {
    if (!Array.isArray(p) || p.length !== 2) fail(id, `${what} is not an [x, y] pair`);
    const [x, y] = p;
    if (typeof x !== "number" || typeof y !== "number") {
      fail(id, `${what} is not an [x, y] pair`);
    }
    if (!inBounds(x, y)) fail(id, `${what} out of bounds (${x}, ${y})`);
    return { x, y };
  };
  for (const lane of raw.lanes) {
    if (lane.length < 2) fail(id, "lane with fewer than 2 waypoints");
  }
  const points = (list: number[][], what: string): MapPoint[] => list.map((p) => point(p, what));

  const plot = (p: { x: number; y: number; radius: number }, what: string): MapPlot => {
    if (!p || typeof p.x !== "number" || typeof p.y !== "number" || !(p.radius > 0)) {
      fail(id, `${what} is not an {x, y, radius} plot`);
    }
    if (!inBounds(p.x, p.y)) fail(id, `${what} out of bounds (${p.x}, ${p.y})`);
    return { x: p.x, y: p.y, radius: p.radius };
  };
  if (!Array.isArray(raw.bases) || raw.bases.length !== 2) fail(id, "need exactly 2 bases");
  const bases: MapBase[] = raw.bases.map((b, team) => {
    if (!b || typeof b !== "object") fail(id, `base ${team} is not an object`);
    if (!Array.isArray(b.turrets)) fail(id, `base ${team} turrets is not a list`);
    if (b.turrets.length > 8) {
      fail(id, `base ${team} has ${b.turrets.length} ring turrets (max 8)`);
    }
    return {
      gate: plot(b.gate, `base ${team} gate`),
      core: point(b.core, `base ${team} core`),
      groundConsole: point(b.groundConsole, `base ${team} ground console`),
      airConsole: point(b.airConsole, `base ${team} air console`),
      pad: plot(b.pad, `base ${team} pad`),
      turrets: points(b.turrets, `base ${team} ring turret`),
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
    spawns: raw.spawns.map((s) => ({ x: s.x, y: s.y, yaw: s.yaw })),
    basePlots: raw.basePlots.map((p) => ({ x: p.x, y: p.y, radius: p.radius })),
    bases,
    lanes: raw.lanes.map((lane) => lane.map((p) => point(p, "lane waypoint"))),
    turretSpots: points(raw.turretSpots, "turret spot"),
    outpostSpots: points(raw.outpostSpots, "outpost spot"),
    dummySpots: points(raw.dummySpots, "dummy spot"),
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
    gate: { x: team === 0 ? 10 : extent - 10, y: team === 0 ? 10 : extent - 10, radius: 6 },
    core: { x: center + (team === 0 ? -6 : 6), y: center },
    groundConsole: { x: center + (team === 0 ? -12 : 12), y: center },
    airConsole: { x: center, y: center + (team === 0 ? -12 : 12) },
    pad: { x: center, y: center, radius: 20 },
    turrets: [],
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
    spawns: [
      { x: center, y: center, yaw: 0 },
      { x: center, y: center, yaw: 0 },
    ],
    basePlots: [
      { x: center, y: center, radius: 20 },
      { x: center, y: center, radius: 20 },
    ],
    bases: [testBase(0), testBase(1)],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
  };
}
