// Authoring helper: rebuild la-cantina lanes as wall/slope-safe A* paths that
// hug FCOP Mp Cnet west/east rings (so they sit on the dual-road channels,
// not the old hand-BFS detours). Run: bun tools/generators/patchLaCantinaLanes.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AVATAR_WALKER_MAX_SLOPE } from "../../packages/sim/src/balance";
import { crossesWallX, crossesWallY } from "../../packages/sim/src/collision";
import { getMapById, sampleHeight } from "../../packages/sim/src/map";

const MAP_JSON = join(import.meta.dir, "../../packages/sim/maps/la-cantina.json");
const NETS_JSON = "D:/github/amigo-labs/fcop-reverse-engineering/extracted/logic/Mp/nets.json";

const AV = AVATAR_WALKER_MAX_SLOPE;
const SPAWN_S = { x: 96.5, y: 69.5 };
const SPAWN_N = { x: 96.5, y: 155.5 };

type Pt = { x: number; z: number };
type Cell = [number, number];

const map = getMapById("la-cantina");
const size = map.size;
const key = (i: number, j: number) => j * size + i;

function floodWalkable(sx: number, sy: number): Uint8Array {
  const seen = new Uint8Array(size * size);
  const si = Math.floor(sx);
  const sj = Math.floor(sy);
  const q: [number, number][] = [[si, sj]];
  seen[key(si, sj)] = 1;
  let qi = 0;
  while (qi < q.length) {
    const [i, j] = q[qi++];
    const x = i + 0.5;
    const y = j + 0.5;
    for (const [ni, nj] of [
      [i + 1, j],
      [i - 1, j],
      [i, j + 1],
      [i, j - 1],
    ] as const) {
      if (ni < 0 || nj < 0 || ni >= size || nj >= size || seen[key(ni, nj)]) continue;
      const nx = ni + 0.5;
      const ny = nj + 0.5;
      // Full sub-cell probe (same as fcop-arenas lane test) — endpoint-only
      // height delta misses bilinear saddles that spike slope mid-edge.
      if (!segmentOk(x, y, nx, ny)) continue;
      seen[key(ni, nj)] = 1;
      q.push([ni, nj]);
    }
  }
  return seen;
}

function segmentOk(ax: number, ay: number, bx: number, by: number): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 4));
  let px = ax;
  let py = ay;
  let prevH = sampleHeight(map, ax, ay);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const cx = ax + (bx - ax) * t;
    const cy = ay + (by - ay) * t;
    if (crossesWallX(map, px, cx, py) || crossesWallY(map, cx, py, cy)) return false;
    const h = sampleHeight(map, cx, cy);
    const stepLen = Math.hypot(bx - ax, by - ay) / steps;
    if (Math.abs(h - prevH) / stepLen >= AV) return false;
    px = cx;
    py = cy;
    prevH = h;
  }
  return true;
}

function undirectedAdj(nodes: { i: number; neighbours?: number[] }[]): Map<number, Set<number>> {
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

function makeCnet(
  net: {
    nodes: { i: number; x: number; z: number; neighbours?: number[] }[];
  },
  side: "west" | "east",
): Pt[] {
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
  const bfs = (s: number, g: number): Pt[] | null => {
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
    return null;
  };
  const s = nearest(SPAWN_S.x, SPAWN_S.y);
  const g = nearest(SPAWN_N.x, SPAWN_N.y);
  const mid = net.nodes.filter((n) => n.z >= 95 && n.z <= 130);
  const via =
    side === "west"
      ? mid.reduce((a, b) => (a.x < b.x ? a : b))
      : mid.reduce((a, b) => (a.x > b.x ? a : b));
  const p1 = bfs(s, via.i);
  const p2 = bfs(via.i, g);
  if (!p1 || !p2) throw new Error(`no cnet path ${side}`);
  return p1.concat(p2.slice(1));
}

function buildGuide(walk: Uint8Array, path: Pt[]): Float32Array {
  const guide = new Float32Array(size * size);
  guide.fill(1e9);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      if (!walk[key(i, j)]) continue;
      const x = i + 0.5;
      const y = j + 0.5;
      let best = 1e9;
      for (let k = 0; k < path.length - 1; k++) {
        const ax = path[k].x;
        const ay = path[k].z;
        const bx = path[k + 1].x;
        const by = path[k + 1].z;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy || 1;
        let t = ((x - ax) * dx + (y - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
        if (d < best) best = d;
      }
      guide[key(i, j)] = best;
    }
  }
  return guide;
}

function astar(
  walk: Uint8Array,
  guide: Float32Array,
  wGuide: number,
  from: Cell,
  to: Cell,
): Cell[] {
  const si = Math.floor(from[0]);
  const sj = Math.floor(from[1]);
  const gi = Math.floor(to[0]);
  const gj = Math.floor(to[1]);
  if (!walk[key(si, sj)] || !walk[key(gi, gj)]) {
    throw new Error(`A* ends not walkable ${from} -> ${to}`);
  }
  const open: [number, number, number][] = [[0, si, sj]];
  const gScore = new Float32Array(size * size);
  gScore.fill(1e9);
  const came = new Int32Array(size * size);
  came.fill(-1);
  gScore[key(si, sj)] = 0;
  let guard = 0;
  while (open.length && guard++ < 400_000) {
    open.sort((a, b) => a[0] - b[0]);
    const [, i, j] = open.shift()!;
    if (i === gi && j === gj) {
      const pts: Cell[] = [];
      let c = key(i, j);
      while (c !== -1) {
        pts.push([(c % size) + 0.5, ((c / size) | 0) + 0.5]);
        c = came[c];
      }
      pts.reverse();
      return pts;
    }
    const x = i + 0.5;
    const y = j + 0.5;
    for (const [ni, nj] of [
      [i + 1, j],
      [i - 1, j],
      [i, j + 1],
      [i, j - 1],
    ] as const) {
      if (ni < 0 || nj < 0 || ni >= size || nj >= size || !walk[key(ni, nj)]) continue;
      const nx = ni + 0.5;
      const ny = nj + 0.5;
      if (!segmentOk(x, y, nx, ny)) continue;
      const nk = key(ni, nj);
      const tg = gScore[key(i, j)] + 1 + wGuide * guide[nk];
      if (tg < gScore[nk]) {
        gScore[nk] = tg;
        came[nk] = key(i, j);
        open.push([tg + Math.hypot(ni - gi, nj - gj), ni, nj]);
      }
    }
  }
  throw new Error(`A* failed ${from} -> ${to}`);
}

/** Nearest walkable cell to (x,y), preferring smaller x when side=west. */
function nearestWalkable(
  walk: Uint8Array,
  x: number,
  y: number,
  prefer: "west" | "east" | "any",
): Cell {
  let best: Cell | null = null;
  let bestScore = 1e9;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      if (!walk[key(i, j)]) continue;
      const cx = i + 0.5;
      const cy = j + 0.5;
      const d = Math.hypot(cx - x, cy - y);
      const bias = prefer === "west" ? cx * 0.15 : prefer === "east" ? -cx * 0.15 : 0;
      const score = d + bias;
      if (score < bestScore) {
        bestScore = score;
        best = [cx, cy];
      }
    }
  }
  if (!best) throw new Error("no walkable cell");
  return best;
}

/** Collapse wall/slope-safe runs. Does NOT rewrite endpoints (callers pin those). */
function thinLos(pts: Cell[]): Cell[] {
  if (pts.length <= 2) return pts.slice();
  const out: Cell[] = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !segmentOk(pts[i][0], pts[i][1], pts[j][0], pts[j][1])) j--;
    if (j === i) j = i + 1;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

function validate(lane: Cell[], name: string): void {
  let fails = 0;
  for (let i = 0; i < lane.length - 1; i++) {
    if (!segmentOk(lane[i][0], lane[i][1], lane[i + 1][0], lane[i + 1][1])) {
      fails++;
      console.error(name, "bad seg", i, lane[i], "->", lane[i + 1]);
    }
  }
  const meanX = lane.reduce((s, p) => s + p[0], 0) / lane.length;
  console.log(name, "n=", lane.length, "meanX=", meanX.toFixed(1), "fails=", fails);
  if (fails) throw new Error(`${name} has ${fails} invalid segments`);
}

const walk = floodWalkable(SPAWN_S.x, SPAWN_S.y);
const nets = (await Bun.file(NETS_JSON).json()) as {
  nodes: { i: number; x: number; z: number; neighbours?: number[] }[];
}[];

const westCnet = makeCnet(nets[0], "west");
const eastCnet = makeCnet(nets[0], "east");
const westGuide = buildGuide(walk, westCnet);
const eastGuide = buildGuide(walk, eastCnet);

// Force each lane through a mid-band via so both don't collapse onto the east
// corridor (the only wide wall/slope-safe spine).
// Hard vias on the walkable west/east shelves (not pure cnet extremes —
// those sit behind walls).
const westVia: Cell = [91.5, 112.5];
const eastVia: Cell = [111.5, 112.5];
if (!walk[key(Math.floor(westVia[0]), Math.floor(westVia[1]))]) {
  throw new Error(`westVia not walkable ${westVia}`);
}
if (!walk[key(Math.floor(eastVia[0]), Math.floor(eastVia[1]))]) {
  throw new Error(`eastVia not walkable ${eastVia}`);
}
const start: Cell = [SPAWN_S.x, SPAWN_S.y];
const goal: Cell = [SPAWN_N.x, SPAWN_N.y];
console.log("vias", { westVia, eastVia });

// Thin each leg separately so LOS shortcuts cannot drop the via (that was
// collapsing both lanes onto the east spine).
function twoLeg(guide: Float32Array, via: Cell): Cell[] {
  const a = thinLos(astar(walk, guide, 10, start, via));
  const b = thinLos(astar(walk, guide, 10, via, goal));
  a[0] = start;
  a[a.length - 1] = via;
  b[0] = via;
  b[b.length - 1] = goal;
  return [...a.slice(0, -1), ...b];
}
const lane0 = twoLeg(westGuide, westVia);
const lane1 = twoLeg(eastGuide, eastVia);
console.log(
  "via check L0 has west",
  lane0.some((p) => Math.hypot(p[0] - westVia[0], p[1] - westVia[1]) < 1.5),
  "L1 has east",
  lane1.some((p) => Math.hypot(p[0] - eastVia[0], p[1] - eastVia[1]) < 1.5),
  "meanX",
  (lane0.reduce((s, p) => s + p[0], 0) / lane0.length).toFixed(1),
  (lane1.reduce((s, p) => s + p[0], 0) / lane1.length).toFixed(1),
);
validate(lane0, "west");
validate(lane1, "east");

const mapJson = await Bun.file(MAP_JSON).json();
mapJson.lanes = [lane0, lane1];
writeFileSync(MAP_JSON, `${JSON.stringify(mapJson)}\n`);
console.log("updated", MAP_JSON);
console.log("L0", JSON.stringify(lane0));
console.log("L1", JSON.stringify(lane1));
