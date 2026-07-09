// Converts an extracted Future Cop: L.A.P.D. mission terrain into a committed
// amigo-metropolis map JSON (packages/sim/maps/urban-jungle.json — the FCOP
// "Urban Jungle" arena, mission "Conft").
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
// Stage 1 uses ONLY walk_height (no walls / no water). Conft is 225×257
// (NON-SQUARE); the sim requires a SQUARE grid, so we pad the width 225→257 by
// repeating the east edge column (a flat void edge — no artificial cliff), keep
// all 257 real rows verbatim, and author every feature inside the real region
// (point cols 0..224) so nothing lands in the padding. No requantization: the
// int8 walk_height value IS the 1/32 m integer stored in the JSON.
//
// Usage: bun tools/fcop/convert.ts [path-to-terrain.json]

const DEFAULT_SRC = "C:/MagiPacks/_fcop_audio_privat/heightmaps/Conft_terrain.json";
const HEIGHT_SCALE = 0.03125; // 1/32 m — keep in sync with packages/sim/src/map.ts
const AVATAR_WALKER_MAX_SLOPE = 0.6; // packages/sim/src/balance.ts:37

interface TerrainJson {
  container: string;
  size: [number, number];
  tile_size: [number, number];
  cellSize: number;
  walk_height: number[][];
}

const srcPath = process.argv[2] ?? DEFAULT_SRC;
const src = (await Bun.file(srcPath).json()) as TerrainJson;

const [SRC_W, SRC_H] = src.size;
const wh = src.walk_height;
if (wh.length !== SRC_H) throw new Error(`walk_height has ${wh.length} rows, expected ${SRC_H}`);
for (let j = 0; j < SRC_H; j++) {
  if (wh[j].length !== SRC_W) throw new Error(`walk_height row ${j} has ${wh[j].length} cols`);
}

// Square target grid: pad the shorter axis up to the longer one. Conft is
// 225×257, so SIZE = 257, EXTENT = 256 m (close to district-01's 254 m, so the
// balance constants stay valid), cellSize = 1 → world coords == point indices.
const SIZE = Math.max(SRC_W, SRC_H);
const CELL = src.cellSize; // 1
const EXTENT = (SIZE - 1) * CELL; // 256

// Heights: keep every real row, extrude the east edge column across the pad
// (point cols SRC_W..SIZE-1). Values stay integer (no /HEIGHT_SCALE, no round).
const heights: number[][] = [];
for (let j = 0; j < SIZE; j++) {
  const srcRow = j < SRC_H ? wh[j] : wh[SRC_H - 1]; // (rows already fill SIZE here)
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
const WATER_LEVEL = -10; // min height is minQ*HEIGHT_SCALE ≈ -3.9 m
const water: string[] = [];
for (let j = 0; j < SIZE; j++) water.push("0".repeat(SIZE));

// --- Hand-authored features (all inside the real region, on the naturally
// flat perimeter ring at int 19 = 0.594 m, routed AROUND the sunken central
// plaza whose banks exceed the walker slope limit). Coords are world meters
// == point indices (CELL = 1). ---
type P = [number, number];

const SPAWNS = [
  { x: 38, y: 128, yaw: 0 }, // west, faces +x
  { x: 186, y: 128, yaw: Math.PI }, // east, faces -x
];
const BASE_PLOTS = [
  { x: 38, y: 128, radius: 20 },
  { x: 186, y: 128, radius: 20 },
];
const BASE_W = {
  gate: { x: 55, y: 128, radius: 6 },
  core: [31, 128] as P,
  groundConsole: [38, 116] as P,
  airConsole: [38, 140] as P,
  pad: { x: 46, y: 128, radius: 4 },
  turrets: [
    [47, 114],
    [53, 120],
    [53, 136],
    [47, 142],
  ] as P[],
};
const BASE_E = {
  gate: { x: 169, y: 128, radius: 6 },
  core: [193, 128] as P,
  groundConsole: [186, 116] as P,
  airConsole: [186, 140] as P,
  pad: { x: 178, y: 128, radius: 4 },
  turrets: [
    [177, 114],
    [171, 120],
    [171, 136],
    [177, 142],
  ] as P[],
};
const LANES: P[][] = [
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
];
const TURRET_SPOTS: P[] = [
  [64, 66],
  [160, 66],
  [64, 190],
  [160, 190],
];
const OUTPOST_SPOTS: P[] = [
  [112, 40],
  [112, 216],
];
const DUMMY_SPOTS: P[] = [
  [50, 100],
  [50, 156],
  [174, 100],
  [174, 156],
];

const mapJson = {
  id: "urban-jungle",
  size: SIZE,
  cellSize: CELL,
  heights,
  water,
  waterLevel: WATER_LEVEL,
  spawns: SPAWNS,
  basePlots: BASE_PLOTS,
  bases: [BASE_W, BASE_E],
  lanes: LANES,
  turretSpots: TURRET_SPOTS,
  outpostSpots: OUTPOST_SPOTS,
  dummySpots: DUMMY_SPOTS,
};

const out = new URL("../../packages/sim/maps/urban-jungle.json", import.meta.url);
await Bun.write(out, `${JSON.stringify(mapJson)}\n`);

// --- sanity report (mirrors genDistrict01.ts; catches bad authoring before
// commit). Uses a bilinear sampler matching sampleHeight() so lane checks agree
// with the playability test exactly. ---
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
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

for (const s of SPAWNS) if (!inBounds(s.x, s.y)) flag(`spawn out of bounds (${s.x}, ${s.y})`);
for (const [name, list] of [
  ["turret", TURRET_SPOTS],
  ["outpost", OUTPOST_SPOTS],
  ["dummy", DUMMY_SPOTS],
] as const) {
  for (const [x, y] of list) {
    if (!inBounds(x, y)) flag(`${name} spot out of bounds (${x}, ${y})`);
    if (sample(x, y) < WATER_LEVEL) flag(`${name} spot under water (${x}, ${y})`);
  }
}
for (const [n, base] of [
  ["W", BASE_W],
  ["E", BASE_E],
] as const) {
  const plotC = n === "W" ? BASE_PLOTS[0] : BASE_PLOTS[1];
  const pts: P[] = [
    [base.gate.x, base.gate.y],
    base.core,
    base.groundConsole,
    base.airConsole,
    [base.pad.x, base.pad.y],
    ...base.turrets,
  ];
  for (const [x, y] of pts) {
    if (!inBounds(x, y)) flag(`base ${n} structure out of bounds (${x}, ${y})`);
    if (Math.hypot(x - plotC.x, y - plotC.y) > plotC.radius) {
      flag(`base ${n} structure off plot (${x}, ${y})`);
    }
    if (Math.abs(sample(x, y) - sample(plotC.x, plotC.y)) > 0.2) {
      flag(`base ${n} structure not flat (${x}, ${y}) h=${sample(x, y).toFixed(3)}`);
    }
  }
}
for (const lane of LANES) {
  if (lane.length < 2) flag("lane with fewer than 2 waypoints");
  for (const [x, y] of lane) if (!inBounds(x, y)) flag(`lane waypoint out of bounds (${x}, ${y})`);
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

console.log(`source: ${src.container} ${SRC_W}×${SRC_H} → square ${SIZE}×${SIZE} (${EXTENT} m)`);
console.log(
  `height range: int [${minQ}, ${maxQ}] = [${(minQ * HEIGHT_SCALE).toFixed(3)}, ${(maxQ * HEIGHT_SCALE).toFixed(3)}] m`,
);
console.log(`spawn heights: W ${sample(38, 128).toFixed(3)} E ${sample(186, 128).toFixed(3)}`);
console.log(
  problems === 0
    ? `wrote urban-jungle.json — all sanity checks passed`
    : `wrote urban-jungle.json with ${problems} PROBLEM(S) — fix before commit`,
);
if (problems > 0) process.exit(1);
