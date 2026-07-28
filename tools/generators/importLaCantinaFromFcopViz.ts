// Import la-cantina sim features from docs/renders/fcop-viz/viz_data_la-cantina.json
// (same grid frame as la-cantina-top.png). Clears walls + softens heights along
// FCOP dual-ring lanes so sim collision matches the road art.
//
// Run: bun tools/generators/importLaCantinaFromFcopViz.ts
// Then: bun tools/generators/renderLaCantinaOverlay.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fnv1aBytes, fnv1aInit } from "../../packages/sim/src/hash";

const ROOT = join(import.meta.dir, "../..");
const VIZ = join(ROOT, "docs/renders/fcop-viz/viz_data_la-cantina.json");
const MAP = join(ROOT, "packages/sim/maps/la-cantina.json");
const HEIGHT_SCALE = 0.03125;

type Viz = {
  spawns: { x: number; z: number }[];
  bases: { x: number; z: number; team: number }[];
  turrets: { x: number; z: number; team: number }[];
  neutrals: { x: number; z: number }[];
  pickups: { x: number; z: number }[];
  lanes: { nodes: { x: number; z: number }[]; edges: [number, number][] }[];
};

const viz = (await Bun.file(VIZ).json()) as Viz;
const map = await Bun.file(MAP).json();
const size: number = map.size;

const half = (v: number) => Math.round(v * 2) / 2;

// --- Spawns (X1Alpha): south = lower z, north = higher z ---
const [sA, sB] = [...viz.spawns].sort((a, b) => a.z - b.z);
map.spawns = [
  { x: half(sA.x), y: half(sA.z), yaw: Math.PI / 2 },
  { x: half(sB.x), y: half(sB.z), yaw: -Math.PI / 2 },
];
// Radius 24 covers the outer FCOP ring turrets (~20 m from spawn after pad snap).
map.basePlots = [
  { x: map.spawns[0].x, y: map.spawns[0].y, radius: 24 },
  { x: map.spawns[1].x, y: map.spawns[1].y, radius: 24 },
];

// --- Bases: TeamBase actors; team 2 = south in data, team 1 = north ---
const baseS = viz.bases.find((b) => b.team === 2) ?? viz.bases[0];
const baseN = viz.bases.find((b) => b.team === 1) ?? viz.bases[1];

/** Dedupe half-rounded points preserving first occurrence order. */
function dedupePts(pts: [number, number][]): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const p of pts) {
    const k = `${p[0]},${p[1]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/**
 * Team-unique type-8 turrets (not the mid pads that list both teams).
 * FCOP Mp has 8 unique defense spots per team — all fit max ring 8.
 */
function teamOnlyTurrets(team: number, other: number): [number, number][] {
  const otherKeys = new Set(
    viz.turrets.filter((t) => t.team === other).map((t) => `${half(t.x)},${half(t.z)}`),
  );
  return dedupePts(
    viz.turrets
      .filter((t) => t.team === team)
      .map((t) => [half(t.x), half(t.z)] as [number, number])
      .filter(([x, y]) => !otherKeys.has(`${x},${y}`)),
  );
}

// South = team 2, north = team 1 (viz TeamBase)
const defS = teamOnlyTurrets(2, 1);
const defN = teamOnlyTurrets(1, 2);
if (defS.length > 8 || defN.length > 8) {
  throw new Error(`ring turret cap 8 exceeded: south=${defS.length} north=${defN.length}`);
}

// (107.5,69.5) sits in a wall pocket after half-round; open apron is z+0.5.
const defSReachable = defS.map(([x, y]) =>
  x === 107.5 && y === 69.5 ? ([107.5, 70] as [number, number]) : ([x, y] as [number, number]),
);

map.bases = [
  {
    gate: { x: half(baseS.x + 4), y: half(baseS.z - 2), radius: 4 },
    core: [half(baseS.x), half(baseS.z)],
    // +3 on x alone lands inside a wall pocket at (93,75); shift south onto
    // the open apron shared with gate/pad so flood connectivity holds.
    groundConsole: [half(baseS.x + 3), half(baseS.z - 2)],
    airConsole: [half(baseS.x - 2), half(baseS.z)],
    pad: { x: half(baseS.x + 5), y: half(baseS.z - 2), radius: 3 },
    turrets: defSReachable,
  },
  {
    gate: { x: half(baseN.x + 4), y: half(baseN.z + 2), radius: 4 },
    core: [half(baseN.x), half(baseN.z)],
    groundConsole: [half(baseN.x + 4), half(baseN.z)],
    airConsole: [half(baseN.x - 2), half(baseN.z)],
    pad: { x: half(baseN.x + 2), y: half(baseN.z + 2), radius: 3 },
    turrets: defN,
  },
];

// --- Capturable: ALL NeutralTurret (36) pads — FCOP Mp has 32 ---
// Mid dual-team type-8 pads overlap some neutrals; capturable owns those pads.
const defKeys = new Set([...defS, ...defN].map(([x, y]) => `${x},${y}`));
map.turretSpots = dedupePts(
  viz.neutrals.map((n) => [half(n.x), half(n.z)] as [number, number]),
).filter(([x, y]) => !defKeys.has(`${x},${y}`));

// No sandbox dummies — every pad is either defense ring or capturable.
map.dummySpots = [];

// Outposts: two side pickups (not invent a mid-map console)
const pickSorted = [...viz.pickups].sort((a, b) => a.x - b.x);
map.outpostSpots = [
  [half(pickSorted[0].x), half(pickSorted[0].z)],
  [half(pickSorted[pickSorted.length - 1].x), half(pickSorted[pickSorted.length - 1].z)],
];

// --- Lanes: FCOP Cnet dual-ring (west / east via mid extremes) — same as top.png tubes ---
function undirectedAdj(nodes: { i: number; neighbours?: number[] }[]) {
  const adj = new Map<number, Set<number>>();
  for (const n of nodes) {
    if (!adj.has(n.i)) adj.set(n.i, new Set());
    for (const nb of n.neighbours ?? []) {
      adj.get(n.i)!.add(nb);
      if (!adj.has(nb)) adj.set(nb, new Set());
      adj.get(nb)!.add(n.i);
    }
  }
  return adj;
}

// nets.json for full neighbour lists (viz_data edges are undirected pairs)
const nets = (await Bun.file(
  "D:/github/amigo-labs/fcop-reverse-engineering/extracted/logic/Mp/nets.json",
).json()) as {
  nodes: { i: number; x: number; z: number; neighbours?: number[] }[];
}[];

function dualRing(side: "west" | "east"): [number, number][] {
  const net = nets[0];
  const nodesByI = new Map(net.nodes.map((n) => [n.i, n]));
  const adj = undirectedAdj(net.nodes);
  const nearest = (x: number, z: number) => {
    let best = 0;
    let bd = 1e9;
    for (const n of net.nodes) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd) {
        bd = d;
        best = n.i;
      }
    }
    return best;
  };
  const bfs = (s: number, g: number) => {
    const q = [s];
    const prev = new Map<number, number>([[s, -1]]);
    while (q.length) {
      const i = q.shift()!;
      if (i === g) {
        const p: number[] = [];
        let c = i;
        while (c !== -1) {
          p.push(c);
          c = prev.get(c)!;
        }
        p.reverse();
        return p.map((id) => {
          const n = nodesByI.get(id)!;
          return { x: n.x, z: n.z };
        });
      }
      for (const nb of adj.get(i) ?? []) {
        if (!prev.has(nb)) {
          prev.set(nb, i);
          q.push(nb);
        }
      }
    }
    throw new Error("no path");
  };
  const s = nearest(map.spawns[0].x, map.spawns[0].y);
  const g = nearest(map.spawns[1].x, map.spawns[1].y);
  const mid = net.nodes.filter((n) => n.z >= 95 && n.z <= 130);
  const via =
    side === "west"
      ? mid.reduce((a, b) => (a.x < b.x ? a : b))
      : mid.reduce((a, b) => (a.x > b.x ? a : b));
  const raw = bfs(s, via.i).concat(bfs(via.i, g).slice(1));
  const pts = raw.map((p) => [half(p.x), half(p.z)] as [number, number]);
  pts[0] = [map.spawns[0].x, map.spawns[0].y];
  pts[pts.length - 1] = [map.spawns[1].x, map.spawns[1].y];
  const out: [number, number][] = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1][0] === p[0] && out[out.length - 1][1] === p[1]) continue;
    out.push(p);
  }
  return out;
}

map.lanes = [dualRing("west"), dualRing("east")];

// --- Walls: open along FCOP roads (must match art) ---
const wallsV = map.wallsV.map((row: string) => row.split(""));
const wallsH = map.wallsH.map((row: string) => row.split(""));
function clearWallsAlong(ax: number, ay: number, bx: number, by: number) {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 8));
  let px = ax;
  let py = ay;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const cx = ax + (bx - ax) * t;
    const cy = ay + (by - ay) * t;
    if (Math.floor(px) !== Math.floor(cx)) {
      const lineX = Math.max(Math.floor(px), Math.floor(cx));
      const jj = Math.floor(py);
      if (jj >= 0 && jj < size && lineX >= 0 && lineX < size) wallsV[jj][lineX] = "0";
    }
    if (Math.floor(py) !== Math.floor(cy)) {
      const lineY = Math.max(Math.floor(py), Math.floor(cy));
      const ii = Math.floor(cx);
      if (ii >= 0 && ii < size && lineY >= 0 && lineY < size) wallsH[lineY][ii] = "0";
    }
    px = cx;
    py = cy;
  }
}
for (const lane of map.lanes) {
  for (let i = 0; i < lane.length - 1; i++) {
    clearWallsAlong(lane[i][0], lane[i][1], lane[i + 1][0], lane[i + 1][1]);
  }
}
map.wallsV = wallsV.map((r: string[]) => r.join(""));
map.wallsH = wallsH.map((r: string[]) => r.join(""));

// --- Heights: flat roads + spawn ramps + pad tops ---
function stamp(x: number, y: number, m: number, r = 1) {
  const q = Math.round(m / HEIGHT_SCALE);
  const i0 = Math.floor(x);
  const j0 = Math.floor(y);
  for (let dj = -r; dj <= r + 1; dj++) {
    for (let di = -r; di <= r + 1; di++) {
      const i = i0 + di;
      const jj = j0 + dj;
      if (jj >= 0 && jj < size && i >= 0 && i < size) map.heights[jj][i] = q;
    }
  }
}
for (const lane of map.lanes) {
  for (let i = 0; i < lane.length - 1; i++) {
    const ax = lane[i][0];
    const ay = lane[i][1];
    const bx = lane[i + 1][0];
    const by = lane[i + 1][1];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 4));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      stamp(ax + (bx - ax) * t, ay + (by - ay) * t, 0, 1);
    }
  }
}
function ramp(cx: number, cy: number) {
  for (let y = cy - 14; y <= cy + 14; y += 0.5) {
    for (let x = cx - 14; x <= cx + 14; x += 0.5) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > 14) continue;
      const h = d <= 4 ? 1 : Math.max(0, 1 - (d - 4) / 8);
      stamp(x, y, h, 0);
    }
  }
}
ramp(map.spawns[0].x, map.spawns[0].y);
ramp(map.spawns[1].x, map.spawns[1].y);
// road mid-band back to 0 outside ramps
for (const lane of map.lanes) {
  for (let i = 0; i < lane.length - 1; i++) {
    const ax = lane[i][0];
    const ay = lane[i][1];
    const bx = lane[i + 1][0];
    const by = lane[i + 1][1];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 4));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const d0 = Math.hypot(x - map.spawns[0].x, y - map.spawns[0].y);
      const d1 = Math.hypot(x - map.spawns[1].x, y - map.spawns[1].y);
      if (d0 > 12 && d1 > 12) stamp(x, y, 0, 1);
    }
  }
}
// base structures + turrets at 1
for (const b of map.bases) {
  stamp(b.core[0], b.core[1], 1, 0);
  stamp(b.gate.x, b.gate.y, 1, 0);
  stamp(b.groundConsole[0], b.groundConsole[1], 1, 0);
  stamp(b.airConsole[0], b.airConsole[1], 1, 0);
  stamp(b.pad.x, b.pad.y, 1, 0);
  for (const t of b.turrets) stamp(t[0], t[1], 1, 0);
}
stamp(map.spawns[0].x, map.spawns[0].y, 1, 0);
stamp(map.spawns[1].x, map.spawns[1].y, 1, 0);

writeFileSync(MAP, `${JSON.stringify(map)}\n`);

// pins
const heights = new Float32Array(size * size);
for (let j = 0; j < size; j++) {
  for (let i = 0; i < size; i++) heights[j * size + i] = map.heights[j][i] * HEIGHT_SCALE;
}
const wV = new Uint8Array(size * size);
const wH = new Uint8Array(size * size);
for (let j = 0; j < size; j++) {
  for (let i = 0; i < size; i++) {
    wV[j * size + i] = map.wallsV[j][i] === "1" ? 1 : 0;
    wH[j * size + i] = map.wallsH[j][i] === "1" ? 1 : 0;
  }
}
const hPin = fnv1aBytes(fnv1aInit(), new Uint8Array(heights.buffer), 0, heights.byteLength) >>> 0;
const vPin = fnv1aBytes(fnv1aInit(), wV, 0, wV.length) >>> 0;
const hWPin = fnv1aBytes(fnv1aInit(), wH, 0, wH.length) >>> 0;
console.log("wrote", MAP);
console.log("spawns", map.spawns);
console.log(
  "cores",
  map.bases.map((b: { core: number[] }) => b.core),
);
console.log(
  "lanes meanX",
  map.lanes.map((l: number[][]) =>
    (l.reduce((s: number, p: number[]) => s + p[0], 0) / l.length).toFixed(1),
  ),
);
console.log("pins", { hPin, vPin, hWPin });
console.log("UPDATE fcop-arenas.test.ts heightsPin/walls pins to these values.");
