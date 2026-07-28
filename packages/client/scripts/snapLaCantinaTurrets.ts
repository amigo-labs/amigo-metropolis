// Snap la-cantina turrets to mesh pad centres + stamp heightfield.
// Prefer the HIGHEST compact plate within maxMove of the FCOP actor so
// multi-level "Vorsprung" pads win over the lower walkway the actor sits on.
//
//   bun tools/generators/importLaCantinaFromFcopViz.ts
//   bun scripts/snapLaCantinaTurrets.ts   (from packages/client)

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { fnv1aBytes, fnv1aInit } from "../../sim/src/hash";

if (typeof ProgressEvent === "undefined") {
  // @ts-expect-error polyfill
  globalThis.ProgressEvent = class extends Event {
    lengthComputable = false;
    loaded = 0;
    total = 0;
    constructor(type: string, init: ProgressEventInit = {}) {
      super(type);
      this.lengthComputable = !!init.lengthComputable;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  };
}

const MAP_PATH = join(import.meta.dir, "../../sim/maps/la-cantina.json");
const GLB = join(import.meta.dir, "../public/models/la-cantina/la-cantina.glb");
const HS = 0.03125;
const LOGIC = { x: 96.5, z: 112 };
const STEP = 0.2;

const map = await Bun.file(MAP_PATH).json();
const size: number = map.size;

const loader = new GLTFLoader();
const gltf = await loader.loadAsync(`file:///${GLB.replace(/\\/g, "/")}`);
gltf.scene.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(gltf.scene);
const glbC = box.getCenter(new THREE.Vector3());
gltf.scene.position.set(LOGIC.x - glbC.x, 0, LOGIC.z - glbC.z);
gltf.scene.updateMatrixWorld(true);
const meshes: THREE.Object3D[] = [];
gltf.scene.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) meshes.push(o);
});

const yCache = new Map<string, number | null>();
function meshTop(x: number, z: number): number | null {
  const kx = Math.round(x * 20) / 20;
  const kz = Math.round(z * 20) / 20;
  const k = `${kx},${kz}`;
  if (yCache.has(k)) return yCache.get(k)!;
  const ray = new THREE.Raycaster(new THREE.Vector3(kx, 80, kz), new THREE.Vector3(0, -1, 0));
  ray.far = 120;
  const y = ray.intersectObjects(meshes, true)[0]?.point.y ?? null;
  yCache.set(k, y);
  return y;
}

function cellKey(x: number, z: number): string {
  return `${Math.round(x / STEP)},${Math.round(z / STEP)}`;
}

/**
 * Prefer highest elevated plate within maxMove of the actor.
 * FCOP actors can sit on a lower walkway while the real turret pad is the
 * "Vorsprung" 1–3 m above / slightly aside.
 */
function snapToPad(
  cx: number,
  cz: number,
  maxMove = 2.25,
): { x: number; z: number; y: number; n: number; note: string } {
  const radius = Math.max(maxMove + 0.6, 2.8);
  const h0 = meshTop(cx, cz);
  if (h0 == null) return { x: cx, z: cz, y: 0, n: 0, note: "nohit" };

  const samples: { x: number; z: number; y: number }[] = [];
  for (let dz = -radius; dz <= radius + 1e-9; dz += STEP) {
    for (let dx = -radius; dx <= radius + 1e-9; dx += STEP) {
      if (dx * dx + dz * dz > radius * radius) continue;
      const y = meshTop(cx + dx, cz + dz);
      if (y == null) continue;
      samples.push({ x: cx + dx, z: cz + dz, y });
    }
  }
  if (samples.length < 8) return { x: cx, z: cz, y: h0, n: 0, note: "sparse" };

  const ys = samples.map((s) => s.y).sort((a, b) => a - b);
  const floorY = ys[Math.floor(ys.length * 0.12)];

  // Height bins 1/4 m
  const bins = new Map<number, { x: number; z: number; y: number }[]>();
  for (const s of samples) {
    const b = Math.round(s.y * 4) / 4;
    if (!bins.has(b)) bins.set(b, []);
    bins.get(b)!.push(s);
  }

  type Cand = {
    h: number;
    conn: { x: number; z: number; y: number }[];
    mx: number;
    mz: number;
    d: number;
    elev: number;
    score: number;
  };
  const cands: Cand[] = [];

  for (const [h, group] of bins) {
    if (group.length < 10) continue;
    // Flood from sample nearest actor
    const set = new Map(group.map((s) => [cellKey(s.x, s.z), s]));
    let seed = group[0];
    let seedD = Infinity;
    for (const s of group) {
      const d = Math.hypot(s.x - cx, s.z - cz);
      if (d < seedD) {
        seedD = d;
        seed = s;
      }
    }
    const stack = [seed];
    const seen = new Set([cellKey(seed.x, seed.z)]);
    const conn = [seed];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ] as const) {
        const nx = cur.x + di * STEP;
        const nz = cur.z + dj * STEP;
        const k = cellKey(nx, nz);
        if (seen.has(k)) continue;
        const n = set.get(k);
        if (!n) continue;
        seen.add(k);
        stack.push(n);
        conn.push(n);
      }
    }
    if (conn.length < 10) continue;
    const mx = conn.reduce((a, s) => a + s.x, 0) / conn.length;
    const mz = conn.reduce((a, s) => a + s.z, 0) / conn.length;
    const d = Math.hypot(mx - cx, mz - cz);
    if (d > maxMove + 0.35) continue; // plate centre too far
    const elev = h - floorY;
    // Density is a weak tie-breaker only — ground plates have n~500 and must
    // NEVER beat a real elevated pad (Vorsprung / shelf / roof pad).
    let score = elev * 220 + Math.min(conn.length, 100) * 0.4 - d * 8 + (h >= h0 - 0.05 ? 3 : 0);
    if (elev >= 0.4) score += 80;
    if (elev >= 1.2) score += 60;
    if (elev >= 2.0) score += 40;
    cands.push({ h, conn, mx, mz, d, elev, score });
  }

  // If any elevated plate exists, drop pure-floor candidates
  const hasElev = cands.some((c) => c.elev >= 0.4);
  const pool = hasElev ? cands.filter((c) => c.elev >= 0.35) : cands;

  if (!pool.length) {
    // Fallback: centroid of band around h0
    const band = samples.filter((s) => Math.abs(s.y - h0) <= 0.15);
    if (band.length < 4) return { x: cx, z: cz, y: h0, n: 0, note: "fallback-h0" };
    const mx = band.reduce((a, s) => a + s.x, 0) / band.length;
    const mz = band.reduce((a, s) => a + s.z, 0) / band.length;
    let x = mx;
    let z = mz;
    const d = Math.hypot(x - cx, z - cz);
    if (d > maxMove) {
      const t = maxMove / d;
      x = cx + (x - cx) * t;
      z = cz + (z - cz) * t;
    }
    return {
      x: Math.round(x * 4) / 4,
      z: Math.round(z * 4) / 4,
      y: meshTop(x, z) ?? h0,
      n: band.length,
      note: "h0-band",
    };
  }

  pool.sort((a, b) => b.score - a.score);
  const best = pool[0];

  // Cap move
  let mx = best.mx;
  let mz = best.mz;
  if (best.d > maxMove) {
    const t = maxMove / best.d;
    mx = cx + (mx - cx) * t;
    mz = cz + (mz - cz) * t;
  }
  let my = meshTop(mx, mz);
  if (my == null || Math.abs(my - best.h) > 0.4) {
    // snap to nearest sample on winning plate
    let nearest = best.conn[0];
    let nd = Infinity;
    for (const s of best.conn) {
      const d = Math.hypot(s.x - mx, s.z - mz);
      if (d < nd) {
        nd = d;
        nearest = s;
      }
    }
    mx = nearest.x;
    mz = nearest.z;
    my = nearest.y;
  }

  return {
    x: Math.round(mx * 4) / 4,
    z: Math.round(mz * 4) / 4,
    y: my ?? best.h,
    n: best.conn.length,
    note: `h=${best.h.toFixed(2)} elev=${best.elev.toFixed(2)} d0=${best.d.toFixed(2)}`,
  };
}

function stampDisk(x: number, y: number, meters: number, radius = 1.4) {
  const q = Math.round(meters / HS);
  for (let j = Math.floor(y - radius); j <= Math.ceil(y + radius); j++) {
    for (let i = Math.floor(x - radius); i <= Math.ceil(x + radius); i++) {
      if (j < 0 || j >= size || i < 0 || i >= size) continue;
      const dx = i + 0.5 - x;
      const dy = j + 0.5 - y;
      if (dx * dx + dy * dy > (radius + 0.4) ** 2) continue;
      map.heights[j][i] = q;
    }
  }
}

function snapList(list: number[][], label: string): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < list.length; i++) {
    const [ox, oy] = list[i];
    const pad = snapToPad(ox, oy);
    const d = Math.hypot(pad.x - ox, pad.z - oy);
    console.log(
      `${label}${i} (${ox},${oy}) → (${pad.x},${pad.z}) d=${d.toFixed(2)} y=${pad.y.toFixed(3)} n=${pad.n} ${pad.note}`,
    );
    stampDisk(pad.x, pad.z, pad.y);
    out.push([pad.x, pad.z]);
  }
  return out;
}

// Fresh-ish: snap whatever is currently in the map (run import first for clean FCOP XY)
for (const b of map.bases) b.turrets = snapList(b.turrets, "def");
map.turretSpots = snapList(map.turretSpots, "cap");
if (map.dummySpots?.length) map.dummySpots = snapList(map.dummySpots, "dum");
map.outpostSpots = snapList(map.outpostSpots, "out");

// Wall-pocket micro-nudges after snap
const pockets: [number, number, number, number][] = [
  [108, 69.5, 107.75, 70],
  [108, 70, 107.75, 70],
  [108, 154.5, 107.75, 154.5],
  [71, 66.25, 71, 65.75],
  [87, 103.5, 86.75, 103.5],
  [71, 157.75, 71, 158],
];
function pocketFix(list: number[][], forceY: number | null) {
  for (let i = 0; i < list.length; i++) {
    for (const [x0, z0, x1, z1] of pockets) {
      if (Math.abs(list[i][0] - x0) < 0.35 && Math.abs(list[i][1] - z0) < 0.35) {
        list[i] = [x1, z1];
        const y = forceY ?? meshTop(x1, z1) ?? 1;
        stampDisk(x1, z1, y);
        console.log("pocket", [x0, z0], "→", [x1, z1]);
      }
    }
  }
}
for (const b of map.bases) pocketFix(b.turrets, null);
pocketFix(map.turretSpots, null);

// Base structure shelf at 1 m (consoles/gate) — keep walkable base apron
for (const b of map.bases) {
  stampDisk(b.core[0] ?? b.core.x, b.core[1] ?? b.core.y, 1);
  stampDisk(b.gate.x, b.gate.y, 1);
  const gc = b.groundConsole;
  stampDisk(gc[0] ?? gc.x, gc[1] ?? gc.y, 1);
  const ac = b.airConsole;
  stampDisk(ac[0] ?? ac.x, ac[1] ?? ac.y, 1);
  stampDisk(b.pad.x, b.pad.y, 1);
}
for (const s of map.spawns) stampDisk(s.x, s.y, 1);

// Final re-stamp turrets from mesh tops at locked XY
for (const b of map.bases) {
  for (const t of b.turrets) {
    const y = meshTop(t[0], t[1]);
    if (y != null) stampDisk(t[0], t[1], y, 1.5);
  }
}
for (const t of map.turretSpots) {
  const y = meshTop(t[0], t[1]);
  if (y != null) stampDisk(t[0], t[1], y, 1.5);
}

writeFileSync(MAP_PATH, `${JSON.stringify(map)}\n`);
const heights = new Float32Array(size * size);
for (let j = 0; j < size; j++) {
  for (let i = 0; i < size; i++) heights[j * size + i] = map.heights[j][i] * HS;
}
console.log(
  "heightsPin",
  fnv1aBytes(fnv1aInit(), new Uint8Array(heights.buffer), 0, heights.byteLength) >>> 0,
);
console.log(
  "def heights",
  map.bases.map((b: { turrets: number[][] }) =>
    b.turrets.map((t: number[]) => [t[0], t[1], meshTop(t[0], t[1])?.toFixed(2)]),
  ),
);
console.log("done");
