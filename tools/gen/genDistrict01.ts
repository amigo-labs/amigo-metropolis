// Generates packages/sim/maps/district-01.json — the Phase 1 arena.
//
// Like the sin table, this runs at AUTHORING time only: the committed JSON is
// the deterministic artifact (heights are integers in 1/32 m units, parsed
// back to bit-exact floats), so this generator may use any Math.* it likes.
//
// Layout (254 m square, 180°-rotationally symmetric for fairness):
//   - two flat base plots west/east, avatar spawns on them
//   - a meandering north-south river (hover-only water) with three dry fords,
//     one per lane — the classic chokepoints
//   - three lanes (north arc, center straight, south arc) carved as roads
//   - two jump-only plateaus (walker shortcut), rims too steep for hover
//   - 6 neutral turret spots, 2 outpost spots, 8 sandbox dummy spots
//
// Usage: bun tools/gen/genDistrict01.ts

const SIZE = 128;
const CELL = 2;
const EXTENT = (SIZE - 1) * CELL; // 254
const HEIGHT_SCALE = 0.03125; // 1/32 m — keep in sync with packages/sim/src/map.ts

const WATER_LEVEL = -0.35;
const PLOT_HEIGHT = 2.0;
const LANE_HEIGHT = 0.5;
const RIVER_BED = -2.2;
const FORD_BED = 0.4;

const BASE_W = { x: 26, y: 127, radius: 20 };
const BASE_E = { x: 228, y: 127, radius: 20 };

type P = [number, number];
const LANES: P[][] = [
  // north arc
  [
    [40, 116],
    [62, 84],
    [92, 62],
    [127, 54],
    [162, 62],
    [192, 84],
    [214, 116],
  ],
  // center straight (through the main ford)
  [
    [42, 127],
    [85, 127],
    [127, 127],
    [169, 127],
    [212, 127],
  ],
  // south arc
  [
    [40, 138],
    [62, 170],
    [92, 192],
    [127, 200],
    [162, 192],
    [192, 170],
    [214, 138],
  ],
];

const TURRET_SPOTS: P[] = [
  [92, 70],
  [162, 70],
  [85, 120],
  [169, 134],
  [92, 184],
  [162, 184],
];
const OUTPOST_SPOTS: P[] = [
  [78, 166],
  [176, 88],
];
const DUMMY_SPOTS: P[] = [
  [60, 110],
  [60, 144],
  [85, 127],
  [110, 100],
  [98, 154],
  [127, 60],
  [127, 194],
  [150, 127],
];
const PLATEAUS = [
  { x: 86, y: 96, radius: 11 },
  { x: 168, y: 158, radius: 11 },
];
const PLATEAU_RISE = 1.4; // < 1.6 m jump apex, one-cell rim → slope 0.7

function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = Math.min(Math.max((v - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.min(Math.max(((px - ax) * abx + (py - ay) * aby) / len2, 0), 1) : 0;
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return Math.sqrt(dx * dx + dy * dy);
}

function laneDist(x: number, y: number): number {
  let d = Infinity;
  for (const lane of LANES) {
    for (let i = 0; i < lane.length - 1; i++) {
      d = Math.min(d, segDist(x, y, lane[i][0], lane[i][1], lane[i + 1][0], lane[i + 1][1]));
    }
  }
  return d;
}

/** River centerline x as a function of y (gentle meander). */
function riverX(y: number): number {
  return 127 + 14 * Math.sin(y * 0.025);
}

const heights: number[][] = [];
for (let j = 0; j < SIZE; j++) {
  const row: number[] = [];
  const y = j * CELL;
  for (let i = 0; i < SIZE; i++) {
    const x = i * CELL;

    // Rolling base terrain, remapped so open ground never dips below the
    // water level on its own — only the carved river is wet.
    let h =
      1.6 * Math.sin(x * 0.045) * Math.sin(y * 0.05) +
      0.9 * Math.sin((x + y) * 0.023) +
      0.5 * Math.sin(x * 0.11) * Math.cos(y * 0.083);
    h = h * 0.42 + 1.05; // amplitudes sum to 3.0 → range [-0.21, 2.31], all dry

    // Plateaus: flat tops, one-cell rims (jump-only, hover-impassable).
    for (const p of PLATEAUS) {
      const d = Math.sqrt((x - p.x) * (x - p.x) + (y - p.y) * (y - p.y));
      h += PLATEAU_RISE * (1 - smoothstep(p.radius - 1, p.radius + 1, d));
    }

    // Lanes: carve toward road height with a soft shoulder.
    const dl = laneDist(x, y);
    const laneW = 1 - smoothstep(5, 11, dl);
    h = h * (1 - 0.8 * laneW) + LANE_HEIGHT * 0.8 * laneW;

    // River: carve toward the bed; near a lane the bed becomes a dry ford.
    const dr = Math.abs(x - riverX(y));
    const riverW = 1 - smoothstep(7, 15, dr);
    const bed = dl < 9 ? FORD_BED : RIVER_BED;
    h = h * (1 - riverW) + bed * riverW;

    // Base plots dominate everything near the bases.
    for (const b of [BASE_W, BASE_E]) {
      const d = Math.sqrt((x - b.x) * (x - b.x) + (y - b.y) * (y - b.y));
      const w = 1 - smoothstep(b.radius, b.radius + 10, d);
      h = h * (1 - w) + PLOT_HEIGHT * w;
    }

    row.push(Math.round(h / HEIGHT_SCALE));
  }
  heights.push(row);
}

// Flatten small pads under authored spots (turrets/outposts/dummies).
function flattenPad(cx: number, cy: number, radius: number): void {
  const ci = Math.round(cx / CELL);
  const cj = Math.round(cy / CELL);
  const target = heights[cj][ci];
  const r = Math.ceil((radius + 3) / CELL);
  for (let j = Math.max(0, cj - r); j <= Math.min(SIZE - 1, cj + r); j++) {
    for (let i = Math.max(0, ci - r); i <= Math.min(SIZE - 1, ci + r); i++) {
      const d = Math.sqrt((i * CELL - cx) ** 2 + (j * CELL - cy) ** 2);
      const w = 1 - smoothstep(radius, radius + 3, d);
      heights[j][i] = Math.round(heights[j][i] * (1 - w) + target * w);
    }
  }
}
for (const [x, y] of [...TURRET_SPOTS, ...OUTPOST_SPOTS, ...DUMMY_SPOTS]) flattenPad(x, y, 4);

// Water mask from final heights.
const water: string[] = [];
for (let j = 0; j < SIZE; j++) {
  let row = "";
  for (let i = 0; i < SIZE; i++) {
    row += heights[j][i] * HEIGHT_SCALE < WATER_LEVEL ? "1" : "0";
  }
  water.push(row);
}

const mapJson = {
  id: "district-01",
  size: SIZE,
  cellSize: CELL,
  heights,
  water,
  spawns: [
    { x: 30, y: 127, yaw: 0 },
    { x: 224, y: 127, yaw: Math.PI },
  ],
  basePlots: [BASE_W, BASE_E],
  lanes: LANES,
  turretSpots: TURRET_SPOTS,
  outpostSpots: OUTPOST_SPOTS,
  dummySpots: DUMMY_SPOTS,
};

const out = new URL("../../packages/sim/maps/district-01.json", import.meta.url);
await Bun.write(out, `${JSON.stringify(mapJson)}\n`);

// --- sanity report ---
let waterCells = 0;
for (const row of water) for (const c of row) if (c === "1") waterCells++;
console.log(`wrote district-01.json (${SIZE}×${SIZE}, ${EXTENT} m)`);
console.log(`water coverage: ${((waterCells / (SIZE * SIZE)) * 100).toFixed(1)}%`);
const h = (x: number, y: number) =>
  heights[Math.round(y / CELL)][Math.round(x / CELL)] * HEIGHT_SCALE;
for (const [x, y] of [...TURRET_SPOTS, ...OUTPOST_SPOTS, ...DUMMY_SPOTS]) {
  if (h(x, y) < WATER_LEVEL) console.error(`SPOT UNDER WATER at (${x}, ${y})!`);
}
for (const lane of LANES) {
  for (const [x, y] of lane) {
    if (h(x, y) < WATER_LEVEL) console.error(`LANE WAYPOINT UNDER WATER at (${x}, ${y})!`);
  }
}
console.log(`spawn heights: W ${h(30, 127).toFixed(2)} E ${h(224, 127).toFixed(2)}`);
console.log(
  `ford bed heights: N ${h(127, 54).toFixed(2)} C ${h(127, 127).toFixed(2)} S ${h(127, 200).toFixed(2)}`,
);
