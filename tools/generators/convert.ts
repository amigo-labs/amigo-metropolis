// Converts extracted Future Cop: L.A.P.D. mission terrains into committed
// amigo-metropolis map JSONs (packages/sim/maps/<id>.json) — one ArenaSpec per
// Precinct Assault arena below.
//
// Like genDistrict01.ts, this runs at AUTHORING time only: the committed JSON
// is the deterministic artifact (heights are integers in 1/32 m units, parsed
// back to bit-exact floats), so this converter may use any Math.* it likes.
// The determinism guard never scans tools/ — only packages/sim/src.
//
// Source model (Stage 0 extraction, private input, NOT committed):
//   { size:[W,H], tile_size, cellSize, walk_height:int8[H][W], wallsV/wallsH,
//     multi_level_points, uses_bridges }
//   walk_height is the walkable-floor height per point in int8 (1/32 m) units,
//     row-major walk_height[y][x] — 1:1 onto the sim's heights[j*size + i].
//
// Stage 1 uses ONLY walk_height (no walls / no water). FCOP grids are
// NON-SQUARE (e.g. Conft 225×257); the sim requires a SQUARE grid, so the
// shorter axis is padded by repeating the edge row/column (a flat void edge —
// no artificial cliff), and every feature is authored inside the real region
// so nothing lands in the padding. No requantization: the int8 walk_height
// value IS the 1/32 m integer stored in the JSON.
//
// Feature authoring (spawns/bases/lanes/spots) is hand-placed per arena from a
// terrain analysis pass: base footprints on flat ground (all structure points
// within ±0.2 m of the plot center), lanes BFS-routed on the walkable graph
// and validated against AVATAR_WALKER_MAX_SLOPE with the same bilinear sampler
// the sim uses. The sanity report below re-checks all of it before commit.
//
// Usage: bun tools/generators/convert.ts [arena-id|all] [src-dir]

const DEFAULT_SRC_DIR = "C:/MagiPacks/_fcop_audio_privat/heightmaps";
const HEIGHT_SCALE = 0.03125; // 1/32 m — keep in sync with packages/sim/src/map.ts
const AVATAR_WALKER_MAX_SLOPE = 0.6; // packages/sim/src/balance.ts:37

interface TerrainJson {
  container: string;
  size: [number, number];
  tile_size: [number, number];
  cellSize: number;
  walk_height: number[][];
  /** Tile-edge walls: wallsV[r][c]='1' blocks between tile (r,c) and (r,c+1),
   *  wallsH[r][c]='1' between tile (r,c) and (r+1,c). Tile grid = cell grid. */
  wallsV: string[];
  wallsH: string[];
  /** Extra stacked walkable surfaces (rank 1..N), each SRC_H×SRC_W: heights in
   *  int8 (1/32 m), '0'/'1' present mask. Only consumed for `layered` arenas. */
  layers?: { heights: number[][]; mask: string[] }[];
}

type P = [number, number];

interface Plot {
  x: number;
  y: number;
  radius: number;
}

interface BaseSpec {
  gate: Plot;
  core: P;
  groundConsole: P;
  airConsole: P;
  pad: Plot;
  turrets: P[];
}

interface ArenaSpec {
  /** Map id in the sim registry == JSON filename. */
  id: string;
  /** FCOP mission file prefix (private <mission>_terrain.json input). */
  mission: string;
  spawns: { x: number; y: number; yaw: number }[];
  basePlots: Plot[];
  bases: [BaseSpec, BaseSpec];
  lanes: P[][];
  turretSpots: P[];
  outpostSpots: P[];
  dummySpots: P[];
  /** Emit the extractor's stacked decks into the map JSON (Hk/Ovmp). The four
   *  single-story v1 arenas leave this unset — their minor ledges are not real
   *  decks (Stage-0 decision) and they stay byte-identical / single-layer. */
  layered?: boolean;
}

// --- Arena specs --------------------------------------------------------------

// Conft "Urban Jungle": spawns from original X1Alpha Cact positions inside the
// walkable interior (NOT the outer perimeter apron). Lanes BFS-routed on the
// wall/slope graph between those spawns. Cell-center coordinates.
const URBAN_JUNGLE: ArenaSpec = {
  id: "urban-jungle",
  mission: "Conft",
  spawns: [
    { x: 90.5, y: 71.5, yaw: 1.302 }, // X1Alpha N
    { x: 117.5, y: 169.5, yaw: -1.84 }, // X1Alpha S
  ],
  basePlots: [
    { x: 90.5, y: 71.5, radius: 8 },
    { x: 117.5, y: 169.5, radius: 6 },
  ],
  bases: [
    {
      gate: { x: 94.5, y: 76.5, radius: 4 },
      core: [86.5, 66.5],
      groundConsole: [83.5, 71.5],
      airConsole: [97.5, 71.5],
      pad: { x: 90.5, y: 73.5, radius: 3 },
      turrets: [
        [87.5, 66.5],
        [96.5, 74.5],
        [86.5, 76.5],
        [94.5, 67.5],
      ],
    },
    {
      gate: { x: 117.5, y: 167.5, radius: 4 },
      core: [118.5, 171.5],
      groundConsole: [119.5, 169.5],
      airConsole: [115.5, 169.5],
      pad: { x: 117.5, y: 168.5, radius: 3 },
      turrets: [
        [119.5, 167.5],
        [115.5, 171.5],
        [119.5, 171.5],
        [115.5, 167.5],
      ],
    },
  ],
  lanes: [
    [
      [90.5, 71.5],
      [94.5, 76.5],
      [118.5, 77.5],
      [118.5, 78.5],
      [97.5, 82.5],
      [97.5, 87.5],
      [89.5, 88.5],
      [89.5, 152.5],
      [97.5, 152.5],
      [98.5, 161.5],
      [118.5, 161.5],
      [119.5, 168.5],
      [117.5, 169.5],
    ],
    [
      [90.5, 71.5],
      [91.5, 73.5],
      [106.5, 75.5],
      [118.5, 76.5],
      [118.5, 84.5],
      [117.5, 84.5],
      [113.5, 92.5],
      [112.5, 95.5],
      [112.5, 96.5],
      [119.5, 96.5],
      [119.5, 101.5],
      [117.5, 107.5],
      [117.5, 113.5],
      [113.5, 113.5],
      [112.5, 122.5],
      [112.5, 123.5],
      [113.5, 126.5],
      [118.5, 131.5],
      [118.5, 135.5],
      [122.5, 135.5],
      [120.5, 141.5],
      [120.5, 143.5],
      [112.5, 144.5],
      [112.5, 147.5],
      [113.5, 149.5],
      [115.5, 152.5],
      [117.5, 155.5],
      [119.5, 155.5],
      [119.5, 168.5],
      [117.5, 169.5],
    ],
    [
      [90.5, 71.5],
      [91.5, 73.5],
      [106.5, 75.5],
      [121.5, 77.5],
      [121.5, 78.5],
      [127.5, 79.5],
      [127.5, 96.5],
      [122.5, 96.5],
      [119.5, 97.5],
      [119.5, 100.5],
      [121.5, 100.5],
      [121.5, 101.5],
      [130.5, 106.5],
      [125.5, 138.5],
      [122.5, 138.5],
      [120.5, 139.5],
      [120.5, 142.5],
      [122.5, 143.5],
      [127.5, 144.5],
      [126.5, 161.5],
      [121.5, 161.5],
      [120.5, 168.5],
      [117.5, 169.5],
    ],
  ],
  turretSpots: [
    [88.5, 93.5],
    [108.5, 108.5],
    [99.5, 132.5],
    [119.5, 147.5],
  ],
  outpostSpots: [
    [85.5, 108.5],
    [123.5, 132.5],
  ],
  dummySpots: [
    [94.5, 86.5],
    [97.5, 96.5],
    [111.5, 145.5],
    [113.5, 155.5],
  ],
};

// Slim "Proving Ground" / Joke "Bug Hunt": share features. Spawns from original
// X1Alpha Cact (~88,65 / ~120,175) on the 1 m interior shelves — not the outer
// rim apron. Three BFS corridors (west / mid / east) on the wall graph.
const RIM_SPAWNS = [
  { x: 87.5, y: 64.5, yaw: 1.282 },
  { x: 120.5, y: 175.5, yaw: -1.86 },
];
const RIM_BASE_PLOTS: Plot[] = [
  { x: 87.5, y: 64.5, radius: 9 },
  { x: 120.5, y: 175.5, radius: 9 },
];
const RIM_BASES: [BaseSpec, BaseSpec] = [
  {
    gate: { x: 89.5, y: 70.5, radius: 4 },
    core: [81.5, 66.5],
    groundConsole: [94.5, 64.5],
    airConsole: [82.5, 66.5],
    pad: { x: 89.5, y: 64.5, radius: 3 },
    turrets: [
      [90.5, 64.5],
      [86.5, 69.5],
      [87.5, 70.5],
      [92.5, 64.5],
    ],
  },
  {
    gate: { x: 120.5, y: 172.5, radius: 4 },
    core: [126.5, 175.5],
    groundConsole: [113.5, 175.5],
    airConsole: [127.5, 175.5],
    pad: { x: 118.5, y: 175.5, radius: 3 },
    turrets: [
      [118.5, 169.5],
      [121.5, 169.5],
      [114.5, 174.5],
      [122.5, 175.5],
    ],
  },
];
const RIM_LANES: P[][] = [
  // West corridor
  [
    [87.5, 64.5],
    [74.5, 64.5],
    [80.5, 175.5],
    [120.5, 175.5],
  ],
  // Mid / east field route
  [
    [87.5, 64.5],
    [85.5, 64.5],
    [85.5, 63.5],
    [101.5, 56.5],
    [144.5, 56.5],
    [152.5, 64.5],
    [152.5, 68.5],
    [159.5, 68.5],
    [159.5, 175.5],
    [156.5, 175.5],
    [155.5, 176.5],
    [138.5, 183.5],
    [132.5, 183.5],
    [127.5, 177.5],
    [125.5, 177.5],
    [117.5, 176.5],
    [117.5, 175.5],
    [120.5, 175.5],
  ],
  // Far-east ring
  [
    [87.5, 64.5],
    [85.5, 64.5],
    [85.5, 63.5],
    [101.5, 56.5],
    [160.5, 56.5],
    [160.5, 183.5],
    [132.5, 183.5],
    [127.5, 177.5],
    [125.5, 177.5],
    [117.5, 176.5],
    [117.5, 175.5],
    [120.5, 175.5],
  ],
];
const RIM_TURRET_SPOTS: P[] = [
  [87.5, 88.5],
  [107.5, 106.5],
  [100.5, 133.5],
  [120.5, 151.5],
];
const RIM_OUTPOST_SPOTS: P[] = [
  [84.5, 106.5],
  [124.5, 134.5],
];
const RIM_DUMMY_SPOTS: P[] = [
  [92.5, 81.5],
  [96.5, 92.5],
  [112.5, 148.5],
  [115.5, 159.5],
];

const PROVING_GROUND: ArenaSpec = {
  id: "proving-ground",
  mission: "Slim",
  spawns: RIM_SPAWNS,
  basePlots: RIM_BASE_PLOTS,
  bases: RIM_BASES,
  lanes: RIM_LANES,
  turretSpots: RIM_TURRET_SPOTS,
  outpostSpots: RIM_OUTPOST_SPOTS,
  dummySpots: RIM_DUMMY_SPOTS,
};

// Mp "La Cantina": playable area is the walled central building (NOT the outer
// 0.594 m apron). Features derived from original mission Cact/Csac:
//   - Spawns = X1Alpha (ACT type 1) at ~(96, 69) / ~(96, 155)
//   - Base structures packed onto height-0 shelves around those spawns
//   - Lanes = wall/slope-safe BFS through the interior maze (east corridors;
//     the west maze is fragmented by walls/slopes at walker limits)
//   - Spots from NeutralTurret / ItemPickup clusters inside the building
// Cell-center coordinates; SRC 209×241 pads +X to 241 (no feature offset).
const LA_CANTINA: ArenaSpec = {
  id: "la-cantina",
  mission: "Mp",
  spawns: [
    { x: 96.5, y: 69.5, yaw: Math.PI / 2 }, // north X1Alpha, faces +y (south)
    { x: 96.5, y: 155.5, yaw: -Math.PI / 2 }, // south X1Alpha, faces -y (north)
  ],
  basePlots: [
    { x: 96.5, y: 69.5, radius: 6.5 },
    { x: 96.5, y: 155.5, radius: 6.5 },
  ],
  bases: [
    {
      gate: { x: 98.5, y: 71.5, radius: 4 },
      core: [95.5, 67.5],
      groundConsole: [98.5, 67.5],
      airConsole: [94.5, 67.5],
      pad: { x: 99.5, y: 71.5, radius: 3 },
      turrets: [
        [93.5, 66.5],
        [101.5, 73.5],
        [100.5, 66.5],
        [98.5, 70.5],
      ],
    },
    {
      gate: { x: 98.5, y: 153.5, radius: 4 },
      core: [95.5, 157.5],
      groundConsole: [99.5, 156.5],
      airConsole: [93.5, 156.5],
      pad: { x: 96.5, y: 153.5, radius: 3 },
      turrets: [
        [98.5, 151.5],
        [90.5, 157.5],
        [102.5, 157.5],
        [96.5, 157.5],
      ],
    },
  ],
  lanes: [
    // Interior west-biased corridor (BFS on sim walls/slope, thinned)
    [
      [96.5, 69.5],
      [97.5, 70.5],
      [99.5, 73.5],
      [99.5, 77.5],
      [97.5, 80.5],
      [91.5, 80.5],
      [91.5, 109.5],
      [96.5, 109.5],
      [96.5, 115.5],
      [91.5, 122.5],
      [91.5, 144.5],
      [98.5, 144.5],
      [99.5, 149.5],
      [99.5, 151.5],
      [98.5, 152.5],
      [96.5, 155.5],
    ],
    // Interior east-biased corridor
    [
      [96.5, 69.5],
      [102.5, 69.5],
      [102.5, 78.5],
      [104.5, 79.5],
      [108.5, 79.5],
      [108.5, 81.5],
      [112.5, 82.5],
      [113.5, 102.5],
      [120.5, 107.5],
      [120.5, 118.5],
      [119.5, 118.5],
      [113.5, 121.5],
      [111.5, 142.5],
      [108.5, 142.5],
      [108.5, 145.5],
      [102.5, 145.5],
      [101.5, 155.5],
      [96.5, 155.5],
    ],
  ],
  // NeutralTurret (ACT 36) / ItemPickup clusters inside the building
  turretSpots: [
    [78.5, 100.5],
    [113.5, 100.5],
    [78.5, 123.5],
    [113.5, 123.5],
  ],
  outpostSpots: [
    [66.5, 112.5],
    [125.5, 112.5],
  ],
  dummySpots: [
    [78.5, 106.5],
    [114.5, 106.5],
    [78.5, 118.5],
    [114.5, 118.5],
  ],
};

const BUG_HUNT: ArenaSpec = {
  id: "bug-hunt",
  mission: "Joke",
  spawns: RIM_SPAWNS,
  basePlots: RIM_BASE_PLOTS,
  bases: RIM_BASES,
  lanes: RIM_LANES,
  turretSpots: RIM_TURRET_SPOTS,
  outpostSpots: RIM_OUTPOST_SPOTS,
  dummySpots: RIM_DUMMY_SPOTS,
};

// Hk "Hollywood Keys": LAYERED. Original X1Alpha sits on disconnected decks;
// spawns project to the main walkable ground component nearest those actors
// (W ~63.5,127.5 / E ~240.5,112.5) at -2.97 m. One ground lane along the
// north shelf then east. Upper decks remain traversable-only for v1.
const HOLLYWOOD_KEYS: ArenaSpec = {
  id: "hollywood-keys",
  mission: "Hk",
  layered: true,
  spawns: [
    { x: 63.5, y: 127.5, yaw: -0.085 },
    { x: 240.5, y: 112.5, yaw: 3.057 },
  ],
  basePlots: [
    { x: 63.5, y: 127.5, radius: 8 },
    { x: 240.5, y: 112.5, radius: 8 },
  ],
  bases: [
    {
      gate: { x: 63.5, y: 120.5, radius: 4 },
      core: [56.5, 127.5],
      groundConsole: [63.5, 134.5],
      airConsole: [57.5, 127.5],
      pad: { x: 63.5, y: 121.5, radius: 3 },
      turrets: [
        [60.5, 121.5],
        [63.5, 133.5],
        [57.5, 128.5],
        [63.5, 125.5],
      ],
    },
    {
      gate: { x: 240.5, y: 119.5, radius: 4 },
      core: [247.5, 112.5],
      groundConsole: [240.5, 105.5],
      airConsole: [246.5, 112.5],
      pad: { x: 240.5, y: 118.5, radius: 3 },
      turrets: [
        [240.5, 106.5],
        [243.5, 118.5],
        [246.5, 111.5],
        [240.5, 114.5],
      ],
    },
  ],
  lanes: [
    [
      [63.5, 127.5],
      [62.5, 106.5],
      [62.5, 47.5],
      [240.5, 47.5],
      [240.5, 112.5],
    ],
  ],
  turretSpots: [
    [99.5, 132.5],
    [134.5, 114.5],
    [170.5, 126.5],
    [205.5, 108.5],
  ],
  outpostSpots: [
    [124.5, 137.5],
    [180.5, 102.5],
  ],
  dummySpots: [
    [90.5, 125.5],
    [108.5, 124.5],
    [196.5, 116.5],
    [214.5, 115.5],
  ],
};

// Ovmp "Venice Beach": LAYERED. X1Alpha sits on raised decks; spawns sit on
// the main -2 m ground shelves under those decks (N/S at x≈128). One ground
// lane runs the west edge of the shelf corridor.
const VENICE_BEACH: ArenaSpec = {
  id: "venice-beach",
  mission: "Ovmp",
  layered: true,
  spawns: [
    { x: 128.5, y: 42.5, yaw: Math.PI / 2 },
    { x: 128.5, y: 245.5, yaw: -Math.PI / 2 },
  ],
  basePlots: [
    { x: 128.5, y: 42.5, radius: 5 },
    { x: 128.5, y: 245.5, radius: 5 },
  ],
  bases: [
    {
      gate: { x: 128.5, y: 44.5, radius: 3 },
      core: [128.5, 40.5],
      groundConsole: [130.5, 42.5],
      airConsole: [126.5, 42.5],
      pad: { x: 128.5, y: 43.5, radius: 2 },
      turrets: [
        [130.5, 41.5],
        [126.5, 41.5],
        [130.5, 43.5],
        [126.5, 43.5],
      ],
    },
    {
      gate: { x: 128.5, y: 243.5, radius: 3 },
      core: [128.5, 247.5],
      groundConsole: [130.5, 245.5],
      airConsole: [126.5, 245.5],
      pad: { x: 128.5, y: 244.5, radius: 2 },
      turrets: [
        [130.5, 246.5],
        [126.5, 246.5],
        [130.5, 244.5],
        [126.5, 244.5],
      ],
    },
  ],
  lanes: [
    [
      [128.5, 42.5],
      [79.5, 47.5],
      [79.5, 240.5],
      [128.5, 245.5],
    ],
  ],
  turretSpots: [
    [100.5, 80.5],
    [100.5, 140.5],
    [100.5, 180.5],
    [100.5, 210.5],
  ],
  outpostSpots: [
    [90.5, 100.5],
    [110.5, 190.5],
  ],
  dummySpots: [
    [120.5, 60.5],
    [110.5, 90.5],
    [110.5, 200.5],
    [120.5, 230.5],
  ],
};

const ARENAS: ArenaSpec[] = [
  URBAN_JUNGLE,
  PROVING_GROUND,
  LA_CANTINA,
  BUG_HUNT,
  HOLLYWOOD_KEYS,
  VENICE_BEACH,
];

// --- Conversion ----------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

async function convertArena(spec: ArenaSpec, srcDir: string): Promise<number> {
  const srcPath = `${srcDir}/${spec.mission}_terrain.json`;
  const src = (await Bun.file(srcPath).json()) as TerrainJson;

  const [SRC_W, SRC_H] = src.size;
  const wh = src.walk_height;
  if (wh.length !== SRC_H) throw new Error(`walk_height has ${wh.length} rows, expected ${SRC_H}`);
  for (let j = 0; j < SRC_H; j++) {
    if (wh[j].length !== SRC_W) throw new Error(`walk_height row ${j} has ${wh[j].length} cols`);
  }

  // Square target grid: pad the shorter axis up to the longer one (flat void
  // edge extruded — no artificial cliff). cellSize = 1 → world == indices.
  const SIZE = Math.max(SRC_W, SRC_H);
  const CELL = src.cellSize; // 1
  const EXTENT = (SIZE - 1) * CELL;

  // Heights: keep every real row/col, extrude the edge across the padding.
  // Values stay integer (no /HEIGHT_SCALE, no round).
  const heights: number[][] = [];
  for (let j = 0; j < SIZE; j++) {
    const srcRow = j < SRC_H ? wh[j] : wh[SRC_H - 1];
    const row: number[] = [];
    for (let i = 0; i < SIZE; i++) {
      row.push(i < SRC_W ? srcRow[i] : srcRow[SRC_W - 1]);
    }
    heights.push(row);
  }

  let minQ = Number.POSITIVE_INFINITY;
  let maxQ = Number.NEGATIVE_INFINITY;
  for (const row of heights)
    for (const q of row) {
      if (q < minQ) minQ = q;
      if (q > maxQ) maxQ = q;
    }

  // Walls: remap the private per-tile-edge bits onto the sim's per-grid-line
  // layout (map.ts). Private wallsV[r][c] sits between tile (r,c) and (r,c+1)
  // → sim line x=c+1 in cell row r; private wallsH[r][c] between (r,c) and
  // (r+1,c) → sim line y=r+1 in cell column c. Padding stays wall-free.
  const [TILE_W, TILE_H] = [SRC_W - 1, SRC_H - 1];
  if (src.wallsV.length !== TILE_H || src.wallsH.length !== TILE_H) {
    throw new Error(
      `walls have ${src.wallsV.length}/${src.wallsH.length} rows, expected ${TILE_H}`,
    );
  }
  const wallsVBits = new Uint8Array(SIZE * SIZE);
  const wallsHBits = new Uint8Array(SIZE * SIZE);
  let wallVCount = 0;
  let wallHCount = 0;
  for (let r = 0; r < TILE_H; r++) {
    if (src.wallsV[r].length !== TILE_W || src.wallsH[r].length !== TILE_W) {
      throw new Error(`walls row ${r} has bad length`);
    }
    for (let c = 0; c < TILE_W; c++) {
      if (src.wallsV[r][c] === "1") {
        wallsVBits[r * SIZE + (c + 1)] = 1;
        wallVCount++;
      }
      if (src.wallsH[r][c] === "1") {
        wallsHBits[(r + 1) * SIZE + c] = 1;
        wallHCount++;
      }
    }
  }
  const wallsV: string[] = [];
  const wallsH: string[] = [];
  for (let j = 0; j < SIZE; j++) {
    let vRow = "";
    let hRow = "";
    for (let i = 0; i < SIZE; i++) {
      vRow += wallsVBits[j * SIZE + i] === 1 ? "1" : "0";
      hRow += wallsHBits[j * SIZE + i] === 1 ? "1" : "0";
    }
    wallsV.push(vRow);
    wallsH.push(hRow);
  }

  // Stage 1 has no water: all-'0' mask, waterLevel below the terrain floor so
  // isWater() is false everywhere regardless.
  const WATER_LEVEL = -10; // int8 floor is -128 * 1/32 = -4 m
  const water: string[] = [];
  for (let j = 0; j < SIZE; j++) water.push("0".repeat(SIZE));

  // Extra decks (layered arenas only): pad each layer to the square grid like
  // the base heights — extrude the edge for heights, but the presence mask is
  // '0' in the padding (no deck) so no phantom decks appear off the real region.
  const layers: { heights: number[][]; mask: string[] }[] = [];
  if (spec.layered && src.layers) {
    for (const L of src.layers) {
      const lh: number[][] = [];
      const lm: string[] = [];
      for (let j = 0; j < SIZE; j++) {
        const realRow = j < SRC_H;
        const hSrc = realRow ? L.heights[j] : L.heights[SRC_H - 1];
        const mSrc = realRow ? L.mask[j] : null;
        const hRow: number[] = [];
        let mRow = "";
        for (let i = 0; i < SIZE; i++) {
          hRow.push(i < SRC_W ? hSrc[i] : hSrc[SRC_W - 1]);
          mRow += mSrc && i < SRC_W ? mSrc[i] : "0";
        }
        lh.push(hRow);
        lm.push(mRow);
      }
      layers.push({ heights: lh, mask: lm });
    }
  }

  const mapJson = {
    id: spec.id,
    size: SIZE,
    cellSize: CELL,
    heights,
    water,
    waterLevel: WATER_LEVEL,
    wallsV,
    wallsH,
    ...(layers.length > 0 ? { layers } : {}),
    spawns: spec.spawns,
    basePlots: spec.basePlots,
    bases: spec.bases,
    lanes: spec.lanes,
    turretSpots: spec.turretSpots,
    outpostSpots: spec.outpostSpots,
    dummySpots: spec.dummySpots,
  };

  const out = new URL(`../../packages/sim/maps/${spec.id}.json`, import.meta.url);
  await Bun.write(out, `${JSON.stringify(mapJson)}\n`);

  // --- sanity report (mirrors genDistrict01.ts; catches bad authoring before
  // commit). Uses a bilinear sampler matching sampleHeight() so lane checks
  // agree with the playability test exactly. ---
  function sample(x: number, y: number): number {
    const max = SIZE - 1;
    const gx = clamp(x / CELL, 0, max);
    const gy = clamp(y / CELL, 0, max);
    let i0 = Math.floor(gx);
    let j0 = Math.floor(gy);
    if (i0 > max - 1) i0 = max - 1;
    if (j0 > max - 1) j0 = max - 1;
    const fx = gx - i0;
    const fy = gy - j0;
    const h00 = heights[j0][i0];
    const h10 = heights[j0][i0 + 1];
    const h01 = heights[j0 + 1][i0];
    const h11 = heights[j0 + 1][i0 + 1];
    const h0 = h00 + (h10 - h00) * fx;
    const h1 = h01 + (h11 - h01) * fx;
    return (h0 + (h1 - h0) * fy) * HEIGHT_SCALE;
  }

  let problems = 0;
  const inBounds = (x: number, y: number) => x >= 0 && x <= EXTENT && y >= 0 && y <= EXTENT;
  const flag = (msg: string) => {
    console.error(`  ✗ ${msg}`);
    problems++;
  };

  for (const s of spec.spawns)
    if (!inBounds(s.x, s.y)) flag(`spawn out of bounds (${s.x}, ${s.y})`);
  for (const [name, list] of [
    ["turret", spec.turretSpots],
    ["outpost", spec.outpostSpots],
    ["dummy", spec.dummySpots],
  ] as const) {
    for (const [x, y] of list) {
      if (!inBounds(x, y)) flag(`${name} spot out of bounds (${x}, ${y})`);
      if (sample(x, y) < WATER_LEVEL) flag(`${name} spot under water (${x}, ${y})`);
    }
  }
  for (let team = 0; team < 2; team++) {
    const base = spec.bases[team];
    const plotC = spec.basePlots[team];
    const pts: P[] = [
      [base.gate.x, base.gate.y],
      base.core,
      base.groundConsole,
      base.airConsole,
      [base.pad.x, base.pad.y],
      ...base.turrets,
    ];
    for (const [x, y] of pts) {
      if (!inBounds(x, y)) flag(`base ${team} structure out of bounds (${x}, ${y})`);
      if (Math.hypot(x - plotC.x, y - plotC.y) > plotC.radius) {
        flag(`base ${team} structure off plot (${x}, ${y})`);
      }
      if (Math.abs(sample(x, y) - sample(plotC.x, plotC.y)) > 0.2) {
        flag(`base ${team} structure not flat (${x}, ${y}) h=${sample(x, y).toFixed(3)}`);
      }
    }
  }
  // Mirrors collision.ts crossesWallX/Y so lane checks agree with the sim.
  const crossesV = (x0: number, x1: number, y: number): boolean => {
    const g0 = Math.floor(x0 / CELL);
    const g1 = Math.floor(x1 / CELL);
    if (g0 === g1) return false;
    const line = Math.max(g0, g1);
    const row = clamp(Math.floor(y / CELL), 0, SIZE - 2);
    return wallsVBits[row * SIZE + line] === 1;
  };
  const crossesH = (x: number, y0: number, y1: number): boolean => {
    const g0 = Math.floor(y0 / CELL);
    const g1 = Math.floor(y1 / CELL);
    if (g0 === g1) return false;
    const line = Math.max(g0, g1);
    const col = clamp(Math.floor(x / CELL), 0, SIZE - 2);
    return wallsHBits[line * SIZE + col] === 1;
  };

  for (const lane of spec.lanes) {
    if (lane.length < 2) flag("lane with fewer than 2 waypoints");
    for (const [x, y] of lane)
      if (!inBounds(x, y)) flag(`lane waypoint out of bounds (${x}, ${y})`);
    for (let k = 0; k < lane.length - 1; k++) {
      const [ax, ay] = lane[k];
      const [bx, by] = lane[k + 1];
      const segLen = Math.hypot(bx - ax, by - ay);
      // Slope check: 1 m sampling — must match the playability tests exactly.
      const steps = Math.ceil(segLen);
      let prevH = sample(ax, ay);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const cx = ax + (bx - ax) * t;
        const cy = ay + (by - ay) * t;
        const hh = sample(cx, cy);
        const slope = Math.abs(hh - prevH) / (segLen / steps);
        if (slope >= AVATAR_WALKER_MAX_SLOPE) {
          flag(
            `lane too steep near (${cx.toFixed(0)}, ${cy.toFixed(0)}) slope=${slope.toFixed(3)}`,
          );
        }
        prevH = hh;
      }
      // Wall check: sub-cell sampling (0.25 m ≪ cellSize) so every grid-line
      // crossing along the segment is seen exactly once per axis.
      const wallSteps = Math.ceil(segLen * 4);
      let px = ax;
      let py = ay;
      for (let s = 1; s <= wallSteps; s++) {
        const t = s / wallSteps;
        const cx = ax + (bx - ax) * t;
        const cy = ay + (by - ay) * t;
        if (crossesV(px, cx, py) || crossesH(cx, py, cy)) {
          flag(`lane crosses a wall near (${cx.toFixed(1)}, ${cy.toFixed(1)})`);
        }
        px = cx;
        py = cy;
      }
    }
  }

  console.log(
    `${spec.id}: ${src.container} ${SRC_W}×${SRC_H} → square ${SIZE}×${SIZE} (${EXTENT} m)`,
  );
  console.log(
    `  height range: int [${minQ}, ${maxQ}] = [${(minQ * HEIGHT_SCALE).toFixed(3)}, ${(maxQ * HEIGHT_SCALE).toFixed(3)}] m`,
  );
  console.log(`  walls: ${wallVCount} vertical + ${wallHCount} horizontal segments`);
  const s0 = spec.spawns[0];
  const s1 = spec.spawns[1];
  console.log(
    `  spawn heights: ${sample(s0.x, s0.y).toFixed(3)} @(${s0.x},${s0.y})  ${sample(s1.x, s1.y).toFixed(3)} @(${s1.x},${s1.y})`,
  );
  console.log(
    problems === 0
      ? `  wrote ${spec.id}.json — all sanity checks passed`
      : `  wrote ${spec.id}.json with ${problems} PROBLEM(S) — fix before commit`,
  );
  return problems;
}

const which = process.argv[2] ?? "all";
const srcDir = process.argv[3] ?? DEFAULT_SRC_DIR;
const selected = which === "all" ? ARENAS : ARENAS.filter((a) => a.id === which);
if (selected.length === 0) {
  console.error(`unknown arena "${which}" — known: ${ARENAS.map((a) => a.id).join(", ")}, all`);
  process.exit(1);
}
let totalProblems = 0;
for (const spec of selected) totalProblems += await convertArena(spec, srcDir);
if (totalProblems > 0) process.exit(1);
