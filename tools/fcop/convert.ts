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

// Slim "Proving Ground": bases north/south on the flat 0 m play field inside
// the 2 m rim plateau; lanes BFS-routed between the -2 m trench cuts.
const PROVING_GROUND: ArenaSpec = {
  id: "proving-ground",
  mission: "Slim",
  spawns: [
    { x: 100, y: 74, yaw: Math.PI / 2 }, // north, faces +y (south)
    { x: 136, y: 168, yaw: -Math.PI / 2 }, // south, faces -y (north)
  ],
  basePlots: [
    { x: 100, y: 74, radius: 20 },
    { x: 136, y: 168, radius: 20 },
  ],
  bases: [
    {
      gate: { x: 100, y: 91, radius: 6 },
      core: [100, 67],
      groundConsole: [112, 74],
      airConsole: [88, 74],
      pad: { x: 100, y: 82, radius: 4 },
      turrets: [
        [114, 83],
        [108, 89],
        [92, 89],
        [86, 83],
      ],
    },
    {
      gate: { x: 136, y: 151, radius: 6 },
      core: [136, 175],
      groundConsole: [124, 168],
      airConsole: [148, 168],
      pad: { x: 136, y: 160, radius: 4 },
      turrets: [
        [122, 159],
        [128, 153],
        [144, 153],
        [150, 159],
      ],
    },
  ],
  lanes: [
    // Center — straight through the trench maze
    [
      [100, 74],
      [117, 81],
      [117, 91],
      [108, 93],
      [108, 97],
      [111, 100],
      [111, 101],
      [110, 105],
      [110, 109],
      [115, 114],
      [124, 116],
      [125, 146],
      [136, 152],
      [136, 168],
    ],
    // West — along the western field edge
    [
      [100, 74],
      [84, 74],
      [84, 119],
      [96, 120],
      [125, 122],
      [125, 146],
      [136, 152],
      [136, 168],
    ],
    // East — through the eastern platform cluster
    [
      [100, 74],
      [119, 82],
      [119, 84],
      [137, 88],
      [137, 97],
      [131, 99],
      [131, 102],
      [144, 110],
      [142, 114],
      [133, 116],
      [133, 119],
      [141, 121],
      [141, 124],
      [134, 137],
      [134, 150],
      [136, 168],
    ],
  ],
  turretSpots: [
    [84, 96],
    [137, 92],
    [125, 130],
    [134, 144],
  ],
  outpostSpots: [
    [110, 105],
    [125, 140],
  ],
  dummySpots: [
    [92, 80],
    [108, 80],
    [120, 158],
    [140, 158],
  ],
};

// Mp "La Cantina": a walled central building on a flat 0.594 m apron; bases
// north/south of the building, lanes flanking it west/east. The interior is
// not traversable without wall data (Stage 2+), so no center lane.
const LA_CANTINA: ArenaSpec = {
  id: "la-cantina",
  mission: "Mp",
  spawns: [
    { x: 114, y: 30, yaw: Math.PI / 2 }, // north, faces +y (south)
    { x: 114, y: 194, yaw: -Math.PI / 2 }, // south, faces -y (north)
  ],
  basePlots: [
    { x: 114, y: 30, radius: 20 },
    { x: 114, y: 194, radius: 20 },
  ],
  bases: [
    {
      gate: { x: 114, y: 47, radius: 6 },
      core: [114, 23],
      groundConsole: [126, 30],
      airConsole: [102, 30],
      pad: { x: 114, y: 38, radius: 4 },
      turrets: [
        [128, 39],
        [122, 45],
        [106, 45],
        [100, 39],
      ],
    },
    {
      gate: { x: 114, y: 177, radius: 6 },
      core: [114, 201],
      groundConsole: [102, 194],
      airConsole: [126, 194],
      pad: { x: 114, y: 186, radius: 4 },
      turrets: [
        [100, 185],
        [106, 179],
        [122, 179],
        [128, 185],
      ],
    },
  ],
  lanes: [
    // West flank
    [
      [114, 30],
      [52, 53],
      [52, 112],
      [64, 176],
      [114, 194],
    ],
    // East flank
    [
      [114, 30],
      [176, 55],
      [176, 112],
      [160, 176],
      [114, 194],
    ],
  ],
  turretSpots: [
    [52, 80],
    [176, 80],
    [58, 144],
    [168, 144],
  ],
  outpostSpots: [
    [56, 112],
    [172, 112],
  ],
  dummySpots: [
    [96, 44],
    [132, 44],
    [96, 180],
    [132, 180],
  ],
};

// Joke "Bug Hunt": a Proving Ground terrain variant (same 225×257 grid, same
// base zones re-verified on its own heightfield); lanes BFS-routed on Joke's
// heights, so waypoints differ slightly from proving-ground.
const BUG_HUNT: ArenaSpec = {
  id: "bug-hunt",
  mission: "Joke",
  spawns: [
    { x: 100, y: 74, yaw: Math.PI / 2 }, // north, faces +y (south)
    { x: 136, y: 168, yaw: -Math.PI / 2 }, // south, faces -y (north)
  ],
  basePlots: [
    { x: 100, y: 74, radius: 20 },
    { x: 136, y: 168, radius: 20 },
  ],
  bases: [
    {
      gate: { x: 100, y: 91, radius: 6 },
      core: [100, 67],
      groundConsole: [112, 74],
      airConsole: [88, 74],
      pad: { x: 100, y: 82, radius: 4 },
      turrets: [
        [114, 83],
        [108, 89],
        [92, 89],
        [86, 83],
      ],
    },
    {
      gate: { x: 136, y: 151, radius: 6 },
      core: [136, 175],
      groundConsole: [124, 168],
      airConsole: [148, 168],
      pad: { x: 136, y: 160, radius: 4 },
      turrets: [
        [122, 159],
        [128, 153],
        [144, 153],
        [150, 159],
      ],
    },
  ],
  lanes: [
    // Center
    [
      [100, 74],
      [117, 81],
      [117, 91],
      [108, 93],
      [108, 97],
      [110, 109],
      [115, 114],
      [124, 116],
      [125, 146],
      [136, 152],
      [136, 168],
    ],
    // West
    [
      [100, 74],
      [84, 74],
      [84, 119],
      [96, 120],
      [125, 122],
      [125, 146],
      [136, 152],
      [136, 168],
    ],
    // East
    [
      [100, 74],
      [119, 82],
      [119, 84],
      [137, 88],
      [137, 97],
      [131, 99],
      [131, 102],
      [144, 110],
      [142, 114],
      [133, 116],
      [133, 119],
      [141, 121],
      [141, 124],
      [134, 137],
      [134, 150],
      [136, 168],
    ],
  ],
  turretSpots: [
    [84, 96],
    [137, 92],
    [125, 130],
    [134, 144],
  ],
  outpostSpots: [
    [110, 109],
    [125, 140],
  ],
  dummySpots: [
    [92, 80],
    [108, 80],
    [120, 158],
    [140, 158],
  ],
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
  for (const lane of spec.lanes) {
    if (lane.length < 2) flag("lane with fewer than 2 waypoints");
    for (const [x, y] of lane)
      if (!inBounds(x, y)) flag(`lane waypoint out of bounds (${x}, ${y})`);
    for (let k = 0; k < lane.length - 1; k++) {
      const [ax, ay] = lane[k];
      const [bx, by] = lane[k + 1];
      const segLen = Math.hypot(bx - ax, by - ay);
      const steps = Math.ceil(segLen);
      let prevH = sample(ax, ay);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const hh = sample(ax + (bx - ax) * t, ay + (by - ay) * t);
        const slope = Math.abs(hh - prevH) / (segLen / steps);
        if (slope >= AVATAR_WALKER_MAX_SLOPE) {
          flag(
            `lane too steep near (${(ax + (bx - ax) * t).toFixed(0)}, ${(ay + (by - ay) * t).toFixed(0)}) slope=${slope.toFixed(3)}`,
          );
        }
        prevH = hh;
      }
    }
  }

  console.log(
    `${spec.id}: ${src.container} ${SRC_W}×${SRC_H} → square ${SIZE}×${SIZE} (${EXTENT} m)`,
  );
  console.log(
    `  height range: int [${minQ}, ${maxQ}] = [${(minQ * HEIGHT_SCALE).toFixed(3)}, ${(maxQ * HEIGHT_SCALE).toFixed(3)}] m`,
  );
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
