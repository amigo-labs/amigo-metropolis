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
// Usage: bun tools/fcop/convert.ts [arena-id|all] [src-dir]

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
}

// --- Arena specs --------------------------------------------------------------

// Conft "Urban Jungle": all features on the naturally flat perimeter ring at
// int 19 = 0.594 m, routed AROUND the sunken central plaza whose banks exceed
// the walker slope limit. Coords are world meters == point indices (CELL = 1).
const URBAN_JUNGLE: ArenaSpec = {
  id: "urban-jungle",
  mission: "Conft",
  spawns: [
    { x: 38, y: 128, yaw: 0 }, // west, faces +x
    { x: 186, y: 128, yaw: Math.PI }, // east, faces -x
  ],
  basePlots: [
    { x: 38, y: 128, radius: 20 },
    { x: 186, y: 128, radius: 20 },
  ],
  bases: [
    {
      gate: { x: 55, y: 128, radius: 6 },
      core: [31, 128],
      groundConsole: [38, 116],
      airConsole: [38, 140],
      pad: { x: 46, y: 128, radius: 4 },
      turrets: [
        [47, 114],
        [53, 120],
        [53, 136],
        [47, 142],
      ],
    },
    {
      gate: { x: 169, y: 128, radius: 6 },
      core: [193, 128],
      groundConsole: [186, 116],
      airConsole: [186, 140],
      pad: { x: 178, y: 128, radius: 4 },
      turrets: [
        [177, 114],
        [171, 120],
        [171, 136],
        [177, 142],
      ],
    },
  ],
  lanes: [
    // North arc — base0 → base1 around the north rim of the plaza
    [
      [38, 128],
      [46, 66],
      [80, 34],
      [144, 34],
      [178, 66],
      [186, 128],
    ],
    // South arc
    [
      [38, 128],
      [46, 190],
      [80, 222],
      [144, 222],
      [178, 190],
      [186, 128],
    ],
    // Top edge (far north, along the flat perimeter)
    [
      [38, 128],
      [38, 40],
      [112, 20],
      [186, 40],
      [186, 128],
    ],
  ],
  turretSpots: [
    [64, 66],
    [160, 66],
    [64, 190],
    [160, 190],
  ],
  outpostSpots: [
    [112, 40],
    [112, 216],
  ],
  dummySpots: [
    [50, 100],
    [50, 156],
    [174, 100],
    [174, 156],
  ],
};

// Slim "Proving Ground" / Joke "Bug Hunt": Bug Hunt is a Proving Ground
// terrain variant — the wall-aware analysis produced IDENTICAL base fits and
// lane routes on both heightfields, so they share the authored features.
// Bases sit north/south on the flat 2 m rim plateau (the 0 m inner field is
// fragmented into walled chambers); three lane corridors ring the field at
// x≈60 (west), x≈159 (mid) and x≈196 (east). All coordinates are CELL
// CENTERS (i+0.5) so segments never run exactly on a grid line and the edge
// blocker's floor() is unambiguous.
const RIM_SPAWNS = [
  { x: 126.5, y: 40.5, yaw: Math.PI / 2 }, // north, faces +y (south)
  { x: 126.5, y: 200.5, yaw: -Math.PI / 2 }, // south, faces -y (north)
];
const RIM_BASE_PLOTS: Plot[] = [
  { x: 126.5, y: 40.5, radius: 20 },
  { x: 126.5, y: 200.5, radius: 20 },
];
const RIM_BASES: [BaseSpec, BaseSpec] = [
  {
    gate: { x: 126.5, y: 57.5, radius: 6 },
    core: [126.5, 33.5],
    groundConsole: [138.5, 40.5],
    airConsole: [114.5, 40.5],
    pad: { x: 126.5, y: 48.5, radius: 4 },
    turrets: [
      [140.5, 49.5],
      [134.5, 55.5],
      [118.5, 55.5],
      [112.5, 49.5],
    ],
  },
  {
    gate: { x: 126.5, y: 183.5, radius: 6 },
    core: [126.5, 207.5],
    groundConsole: [114.5, 200.5],
    airConsole: [138.5, 200.5],
    pad: { x: 126.5, y: 192.5, radius: 4 },
    turrets: [
      [112.5, 191.5],
      [118.5, 185.5],
      [134.5, 185.5],
      [140.5, 191.5],
    ],
  },
];
const RIM_LANES: P[][] = [
  // Mid corridor (x≈159), east of the inner field
  [
    [126.5, 40.5],
    [159.5, 64.5],
    [159.5, 175.5],
    [156.5, 175.5],
    [155.5, 176.5],
    [138.5, 183.5],
    [126.5, 184.5],
    [126.5, 200.5],
  ],
  // West corridor (x≈60)
  [
    [126.5, 40.5],
    [60.5, 76.5],
    [60.5, 120.5],
    [80.5, 167.5],
    [80.5, 171.5],
    [81.5, 172.5],
    [81.5, 175.5],
    [117.5, 175.5],
    [117.5, 176.5],
    [126.5, 200.5],
  ],
  // East corridor (x≈196)
  [
    [126.5, 40.5],
    [196.5, 92.5],
    [196.5, 120.5],
    [159.5, 142.5],
    [159.5, 175.5],
    [156.5, 175.5],
    [155.5, 176.5],
    [138.5, 183.5],
    [126.5, 184.5],
    [126.5, 200.5],
  ],
];
const RIM_TURRET_SPOTS: P[] = [
  [60.5, 90.5],
  [196.5, 100.5],
  [159.5, 100.5],
  [159.5, 150.5],
];
const RIM_OUTPOST_SPOTS: P[] = [
  [60.5, 120.5],
  [196.5, 120.5],
];
const RIM_DUMMY_SPOTS: P[] = [
  [100.5, 40.5],
  [152.5, 40.5],
  [100.5, 200.5],
  [152.5, 200.5],
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

// Mp "La Cantina": a walled central building on a flat 0.594 m apron; bases
// north/south of the building, lanes flanking it west/east (wall-verified).
// The interior is a wall maze — no center lane. Cell-center coordinates.
const LA_CANTINA: ArenaSpec = {
  id: "la-cantina",
  mission: "Mp",
  spawns: [
    { x: 114.5, y: 30.5, yaw: Math.PI / 2 }, // north, faces +y (south)
    { x: 114.5, y: 194.5, yaw: -Math.PI / 2 }, // south, faces -y (north)
  ],
  basePlots: [
    { x: 114.5, y: 30.5, radius: 20 },
    { x: 114.5, y: 194.5, radius: 20 },
  ],
  bases: [
    {
      gate: { x: 114.5, y: 47.5, radius: 6 },
      core: [114.5, 23.5],
      groundConsole: [126.5, 30.5],
      airConsole: [102.5, 30.5],
      pad: { x: 114.5, y: 38.5, radius: 4 },
      turrets: [
        [128.5, 39.5],
        [122.5, 45.5],
        [106.5, 45.5],
        [100.5, 39.5],
      ],
    },
    {
      gate: { x: 114.5, y: 177.5, radius: 6 },
      core: [114.5, 201.5],
      groundConsole: [102.5, 194.5],
      airConsole: [126.5, 194.5],
      pad: { x: 114.5, y: 186.5, radius: 4 },
      turrets: [
        [100.5, 185.5],
        [106.5, 179.5],
        [122.5, 179.5],
        [128.5, 185.5],
      ],
    },
  ],
  lanes: [
    // West flank
    [
      [114.5, 30.5],
      [52.5, 52.5],
      [52.5, 112.5],
      [64.5, 176.5],
      [114.5, 194.5],
    ],
    // East flank
    [
      [114.5, 30.5],
      [176.5, 55.5],
      [176.5, 112.5],
      [159.5, 176.5],
      [114.5, 194.5],
    ],
  ],
  turretSpots: [
    [52.5, 80.5],
    [176.5, 80.5],
    [58.5, 144.5],
    [170.5, 142.5],
  ],
  outpostSpots: [
    [56.5, 112.5],
    [172.5, 112.5],
  ],
  dummySpots: [
    [96.5, 44.5],
    [132.5, 44.5],
    [96.5, 180.5],
    [132.5, 180.5],
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

const ARENAS: ArenaSpec[] = [URBAN_JUNGLE, PROVING_GROUND, LA_CANTINA, BUG_HUNT];

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

  const mapJson = {
    id: spec.id,
    size: SIZE,
    cellSize: CELL,
    heights,
    water,
    waterLevel: WATER_LEVEL,
    wallsV,
    wallsH,
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
