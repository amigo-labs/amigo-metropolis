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
//     rank0_wallsV/H, layers[{heights, mask, wallsV, wallsH}],
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
// Mirrors AVATAR_WALKER_MAX_SLOPE in packages/sim/src/balance.ts. Redeclared, not
// imported, because this file has NO imports on purpose: stage 1 runs against the
// private heightmap dump without the workspace built. For the same reason it
// cannot use the sim's shared `worstUphillRise` — there is no MapData yet at this
// point, only the raw walk_height grid and the local `sample()` closure. What it
// CAN do is apply the same rule, which the uphill-only check below now does.
const AVATAR_WALKER_MAX_SLOPE = 0.6;

interface TerrainJson {
  container: string;
  size: [number, number];
  tile_size: [number, number];
  cellSize: number;
  walk_height: number[][];
  /** Tile-edge walls: wallsV[r][c]='1' blocks between tile (r,c) and (r,c+1),
   *  wallsH[r][c]='1' between tile (r,c) and (r+1,c). Tile grid = cell grid.
   *  This pair is the UNION over every deck — see `rank0_walls*` below. */
  wallsV: string[];
  wallsH: string[];
  /** The subset of the above that stands on the GROUND deck. Same layout. Newer
   *  extractor field; absent on an older dump, in which case a layered arena
   *  falls back to the union and the carve stays as large as it was. */
  rank0_wallsV?: string[];
  rank0_wallsH?: string[];
  /** Extra stacked walkable surfaces (rank 1..N), each SRC_H×SRC_W: heights in
   *  int8 (1/32 m), '0'/'1' present mask, plus that deck's own wall lattice.
   *  Only consumed for `layered` arenas. */
  layers?: { heights: number[][]; mask: string[]; wallsV?: string[]; wallsH?: string[] }[];
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
  /** Emit the extractor's stacked decks into the map JSON, and take the GROUND
   *  deck's wall lattice instead of the union over all decks (Hk/Ovmp/Mp). The
   *  three remaining single-story arenas leave this unset — their minor ledges
   *  are not real decks (Stage-0 decision) and they stay byte-identical. */
  layered?: boolean;
  /**
   * Optional height stamps `[x, y, meters]`. Walk_height is the collision floor;
   * many FCOP turret pads are raised mesh plates above a channel, and stamping
   * the 2×2 bilinear neighborhood would make `sampleHeight` match the textured
   * pad top so entities sit on the art.
   *
   * NOT APPLIED unless `stampPadHeights` is set, and nothing sets it. The
   * committed la-cantina.json — the artifact `heightsPin` pins — is the raw
   * padded `walk_height` with these stamps ABSENT: I diffed all 241×241 cells,
   * and the only differences a stamping run produces are the 63 cells these 18
   * entries cover. So the list was authored but never landed, and the dangling
   * `patchLaCantinaPadHeights` reference below is the other half of that story.
   *
   * Left switched off deliberately. Turning it on lowers four pads onto the
   * channel floor and raises others (e.g. (108,70) 70 → 32 quanta), which is a
   * terrain change owing its own measurement and pin bump — not something to
   * smuggle in behind a change about decks. The data stays so that work has a
   * starting point.
   */
  padHeights?: [number, number, number][];
  /** Opt in to stamping `padHeights`. See the warning above before setting it. */
  stampPadHeights?: boolean;
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
  // Base structures snapped onto the spawn wall-component (not behind walls).
  bases: [
    {
      gate: { x: 94.5, y: 76.5, radius: 4 },
      core: [86.5, 67.5],
      groundConsole: [83.5, 71.5],
      airConsole: [97.5, 71.5],
      pad: { x: 90.5, y: 73.5, radius: 3 },
      turrets: [
        [87.5, 67.5],
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
        [115.5, 170.5],
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
  // Neutrals on the shared walkable component (was: pocket/outpost size-1 cells).
  turretSpots: [
    [88.5, 93.5],
    [108.5, 108.5],
    [99.5, 132.5],
    [119.5, 144.5],
  ],
  outpostSpots: [
    [85.5, 108.5],
    [122.5, 132.5],
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
// Base structures + consoles are wall-reachable from their X1Alpha spawn.
// Previous authoring packed points onto height shelves that sat behind FCOP
// wall cells, isolating unit buy consoles (ground/air) from the walk graph.
const RIM_BASES: [BaseSpec, BaseSpec] = [
  {
    gate: { x: 89.5, y: 64.5, radius: 4 },
    core: [81.5, 66.5],
    groundConsole: [95.5, 64.5],
    airConsole: [82.5, 66.5],
    pad: { x: 88.5, y: 64.5, radius: 3 },
    turrets: [
      [90.5, 64.5],
      [84.5, 66.5],
      [85.5, 65.5],
      [92.5, 64.5],
    ],
  },
  {
    gate: { x: 121.5, y: 175.5, radius: 4 },
    core: [125.5, 175.5],
    groundConsole: [113.5, 175.5],
    airConsole: [124.5, 175.5],
    pad: { x: 118.5, y: 175.5, radius: 3 },
    turrets: [
      [117.5, 174.5],
      [122.5, 175.5],
      [114.5, 174.5],
      [123.5, 175.5],
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
  [108.5, 106.5],
  [100.5, 133.5],
  [120.5, 151.5],
];
const RIM_OUTPOST_SPOTS: P[] = [
  [84.5, 106.5],
  [126.5, 134.5],
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
// 0.594 m apron). Features from original mission Cact (Mp/actors.json):
//   - Spawns = X1Alpha (ACT 1) at ~(96.1, 69.1) / ~(96.0, 155.0)
//   - Base ring turrets = ACT 8 Turret pads nearest each spawn (4 per base)
//   - Capturable = ACT 36 NeutralTurret on the four mid-compound octagon pads
//   - Dummies = ACT 8/36 pads on the next ring out (target practice)
//   - Outposts = outer NeutralTurret midpoints (east/west)
// Cell-center coordinates; SRC 209×241 pads +X to 241 (no feature offset).
// The terrain is the raw walk_height: the `padHeights` stamps below are NOT
// applied (see ArenaSpec.padHeights), and `patchLaCantinaPadHeights` never
// existed.
// LAYERED (issue #29): Mp is bridged — uses_bridges, 1566 multi-level points, a
// 2398-cell deck over the road and a 108-cell deck above that. Converting it as
// single-storey charged the bridges' walls to the road running underneath, which
// is what stage 2 then had to carve back open. With the decks emitted and walls
// attributed per deck, the roads are the original's again.
const LA_CANTINA: ArenaSpec = {
  id: "la-cantina",
  mission: "Mp",
  layered: true,
  spawns: [
    { x: 96.5, y: 69.5, yaw: Math.PI / 2 }, // X1Alpha S base, faces +y
    { x: 96.5, y: 155.5, yaw: -Math.PI / 2 }, // X1Alpha N base, faces -y
  ],
  basePlots: [
    // Ring turrets sit ~12–17 m from the spawn — plot covers the full ring.
    { x: 96.5, y: 69.5, radius: 18 },
    { x: 96.5, y: 155.5, radius: 18 },
  ],
  bases: [
    {
      gate: { x: 98.5, y: 71.5, radius: 4 },
      core: [95.5, 67.5],
      groundConsole: [98.5, 67.5],
      airConsole: [94.5, 67.5],
      pad: { x: 99.5, y: 71.5, radius: 3 },
      // ACT 8 Turret pads (mesh top ≈ 1.0 m). 107.5/69.5 is wall-blocked;
      // nudged to 107.5/70 so flood connectivity from the spawn still holds.
      turrets: [
        [84.5, 69.5],
        [107.5, 70.0],
        [88.0, 83.0],
        [104.0, 83.0],
      ],
    },
    {
      gate: { x: 98.5, y: 153.5, radius: 4 },
      core: [95.5, 157.5],
      groundConsole: [99.5, 156.5],
      airConsole: [93.5, 156.5],
      pad: { x: 96.5, y: 153.5, radius: 3 },
      turrets: [
        [84.5, 154.5],
        [107.5, 154.5],
        [88.0, 141.0],
        [104.0, 141.0],
      ],
    },
  ],
  // FCOP Mp Cnet[0] dual-ring polylines (same grid frame as fcop-viz / prep_viz).
  // West meanX≈89, east≈104 — symmetric about spawn X 96.5. Regenerating the
  // map JSON also clears wall bits + softens heights along these corridors so
  // sim collision matches the road art (see patchLaCantinaLanes / committed JSON).
  lanes: [
    [
      [96.5, 69.5],
      [97, 75.5],
      [96, 76],
      [96, 82.5],
      [96.5, 84],
      [96.5, 91],
      [92.5, 91],
      [90.5, 89],
      [86.5, 89],
      [82, 84.5],
      [82, 80.5],
      [84, 76.5],
      [84, 74],
      [80.5, 70.5],
      [73.5, 70.5],
      [69.5, 74.5],
      [69.5, 111.5],
      [72, 111.5],
      [80, 111.5],
      [82, 112.5],
      [88, 118],
      [94, 120],
      [96.5, 120],
      [96.5, 120.5],
      [96.5, 125],
      [97, 129],
      [96.5, 132],
      [97, 133],
      [97, 139.5],
      [96, 140.5],
      [96.5, 155.5],
    ],
    [
      [96.5, 69.5],
      [97, 75.5],
      [96, 76],
      [96, 82.5],
      [96.5, 84],
      [96.5, 91],
      [99.5, 91],
      [101.5, 89],
      [105.5, 89],
      [110, 84.5],
      [110, 79.5],
      [107, 76.5],
      [107, 73.5],
      [111, 69.5],
      [118.5, 69.5],
      [123.5, 74.5],
      [123.5, 111],
      [122.5, 112.5],
      [120, 112.5],
      [112, 112.5],
      [111, 112.5],
      [104, 118],
      [100, 120],
      [96.5, 120],
      [96.5, 120.5],
      [96.5, 125],
      [97, 129],
      [96.5, 132],
      [97, 133],
      [97, 139.5],
      [96, 140.5],
      [96.5, 155.5],
    ],
  ],
  // Walkable ACT 36 / ACT 8 pads off the lane graph (west apron pads are
  // wall-disconnected from the X1Alpha spawns).
  turretSpots: [
    [86.5, 103.5],
    [113.5, 100.5],
    [86.5, 120.5],
    [113.5, 123.5],
  ],
  outpostSpots: [
    [91.5, 112.0],
    [125.5, 112.0],
  ],
  dummySpots: [
    [105.5, 103.5],
    [105.5, 120.5],
    [100.5, 94.5],
    [91.5, 94.5],
  ],
  // Mesh-raycast pad tops + small base shelves (see packages/sim/maps/la-cantina.json).
  // Full shelf/ramp baking lives in the committed JSON; convert re-stamps pads only.
  padHeights: [
    [84.5, 69.5, 1.0],
    [107.5, 70.0, 1.0],
    [88.0, 83.0, 1.0],
    [104.0, 83.0, 1.0],
    [84.5, 154.5, 1.0],
    [107.5, 154.5, 1.0],
    [88.0, 141.0, 1.0],
    [104.0, 141.0, 1.0],
    [96.5, 69.5, 1.0],
    [96.5, 155.5, 1.0],
    [86.5, 103.5, 0.0],
    [113.5, 100.5, -1.5],
    [86.5, 120.5, 0.0],
    [113.5, 123.5, -1.5],
    [105.5, 103.5, 0.0],
    [105.5, 120.5, 0.0],
    [100.5, 94.5, -1.5],
    [91.5, 94.5, -1.5],
    [91.5, 112.0, -2.5],
    [125.5, 112.0, 0.0],
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
    [170.5, 124.5],
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
  // West-corridor neutrals snapped onto the main spawn-reachable shelf.
  turretSpots: [
    [100.5, 80.5],
    [92.5, 140.5],
    [92.5, 180.5],
    [100.5, 210.5],
  ],
  outpostSpots: [
    [90.5, 100.5],
    [110.5, 198.5],
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

  // Raise walk_height under authored pads so sampleHeight matches mesh tops.
  // Off by default — see the ArenaSpec.padHeights warning.
  if (spec.padHeights && spec.stampPadHeights === true) {
    for (const [x, y, meters] of spec.padHeights) {
      const q = Math.round(meters / HEIGHT_SCALE);
      const i0 = Math.floor(x);
      const j0 = Math.floor(y);
      for (let dj = 0; dj <= 1; dj++) {
        for (let di = 0; di <= 1; di++) {
          const i = i0 + di;
          const j = j0 + dj;
          if (j < 0 || j >= SIZE || i < 0 || i >= SIZE) continue;
          heights[j][i] = q;
        }
      }
    }
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
  const remapWalls = (
    srcV: string[],
    srcH: string[],
    what: string,
  ): {
    wallsV: string[];
    wallsH: string[];
    vBits: Uint8Array;
    hBits: Uint8Array;
    vCount: number;
    hCount: number;
  } => {
    if (srcV.length !== TILE_H || srcH.length !== TILE_H) {
      throw new Error(`${what} have ${srcV.length}/${srcH.length} rows, expected ${TILE_H}`);
    }
    const vBits = new Uint8Array(SIZE * SIZE);
    const hBits = new Uint8Array(SIZE * SIZE);
    let vCount = 0;
    let hCount = 0;
    for (let r = 0; r < TILE_H; r++) {
      if (srcV[r].length !== TILE_W || srcH[r].length !== TILE_W) {
        throw new Error(`${what} row ${r} has bad length`);
      }
      for (let c = 0; c < TILE_W; c++) {
        if (srcV[r][c] === "1") {
          vBits[r * SIZE + (c + 1)] = 1;
          vCount++;
        }
        if (srcH[r][c] === "1") {
          hBits[(r + 1) * SIZE + c] = 1;
          hCount++;
        }
      }
    }
    const outV: string[] = [];
    const outH: string[] = [];
    for (let j = 0; j < SIZE; j++) {
      let vRow = "";
      let hRow = "";
      for (let i = 0; i < SIZE; i++) {
        vRow += vBits[j * SIZE + i] === 1 ? "1" : "0";
        hRow += hBits[j * SIZE + i] === 1 ? "1" : "0";
      }
      outV.push(vRow);
      outH.push(hRow);
    }
    return { wallsV: outV, wallsH: outH, vBits, hBits, vCount, hCount };
  };

  // WHICH LATTICE BECOMES THE GROUND LATTICE
  // The extractor's top-level wallsV/H is the UNION over every deck, which is
  // what a single-storey arena wants: it has no decks to attribute walls to, and
  // emitting anything else would move four committed arenas' wall pins.
  //
  // A `layered` arena takes `rank0_walls*` instead — the walls that stand on the
  // ground deck — and carries each deck's own lattice alongside its heights. That
  // is the whole point of #29: on la-cantina 632 of the union's bits belong to an
  // upper deck, and charging them to the road underneath is what turned the
  // original's bridges into walls across the road.
  //
  // Union(ranks) == top-level holds exactly on all 15 missions, so nothing is
  // lost in the split — a wall that separates two decks belongs to both, and the
  // extractor's 16 orphan edges are attributed to rank 0 (see the RE repo's
  // docs/findings/README.md).
  const useRank0 = spec.layered === true && src.rank0_wallsV !== undefined;
  const ground = useRank0
    ? remapWalls(src.rank0_wallsV as string[], src.rank0_wallsH as string[], "rank0 walls")
    : remapWalls(src.wallsV, src.wallsH, "walls");
  const {
    wallsV,
    wallsH,
    vBits: wallsVBits,
    hBits: wallsHBits,
    vCount: wallVCount,
    hCount: wallHCount,
  } = ground;

  // Stage 1 has no water: all-'0' mask, waterLevel below the terrain floor so
  // isWater() is false everywhere regardless.
  const WATER_LEVEL = -10; // int8 floor is -128 * 1/32 = -4 m
  const water: string[] = [];
  for (let j = 0; j < SIZE; j++) water.push("0".repeat(SIZE));

  // Extra decks (layered arenas only): pad each layer to the square grid like
  // the base heights — extrude the edge for heights, but the presence mask is
  // '0' in the padding (no deck) so no phantom decks appear off the real region.
  // Each deck also carries its OWN wall lattice, so collision on a bridge uses
  // the bridge's parapets and collision on the road beneath does not.
  const layers: {
    heights: number[][];
    mask: string[];
    wallsV?: string[];
    wallsH?: string[];
  }[] = [];
  if (spec.layered && src.layers) {
    for (let L = 0; L < src.layers.length; L++) {
      const src_L = src.layers[L];
      const lh: number[][] = [];
      const lm: string[] = [];
      for (let j = 0; j < SIZE; j++) {
        const realRow = j < SRC_H;
        const hSrc = realRow ? src_L.heights[j] : src_L.heights[SRC_H - 1];
        const mSrc = realRow ? src_L.mask[j] : null;
        const hRow: number[] = [];
        let mRow = "";
        for (let i = 0; i < SIZE; i++) {
          hRow.push(i < SRC_W ? hSrc[i] : hSrc[SRC_W - 1]);
          mRow += mSrc && i < SRC_W ? mSrc[i] : "0";
        }
        lh.push(hRow);
        lm.push(mRow);
      }
      const lw =
        src_L.wallsV !== undefined && src_L.wallsH !== undefined
          ? remapWalls(src_L.wallsV, src_L.wallsH, `layer ${L + 1} walls`)
          : undefined;
      layers.push({
        heights: lh,
        mask: lm,
        ...(lw ? { wallsV: lw.wallsV, wallsH: lw.wallsH } : {}),
      });
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
      // UPHILL only, like the avatar stepper and like the sim's worstUphillRise:
      // a descent is a fall the walker survives, not a wall. This used to take
      // Math.abs and so flagged every drop as "too steep", disagreeing with the
      // stage-2 report and the arena tests about what the word means.
      const steps = Math.ceil(segLen);
      let prevH = sample(ax, ay);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const cx = ax + (bx - ax) * t;
        const cy = ay + (by - ay) * t;
        const hh = sample(cx, cy);
        const slope = (hh - prevH) / (segLen / steps);
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
