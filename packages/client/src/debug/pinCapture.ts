// Pure helpers for verification pins: heightfield ray hit, nearby map features,
// pin.json + prompt.txt builders. No DOM / Three imports — unit-testable.

import type { MapData, MapPoint } from "@metropolis/sim";
import { sampleHeight } from "@metropolis/sim";
import type { PinCamera, PinHit, PinNearby, VerificationPin } from "./pinTypes";

const NEARBY_LIMIT = 8;
const NEARBY_RADIUS = 40;
const RAY_MAX = 400;
const RAY_STEP = 0.5;

export function worldToGrid(
  map: MapData,
  worldX: number,
  worldZ: number,
): { col: number; row: number } {
  const max = map.size - 1;
  const col = Math.min(max, Math.max(0, Math.floor(worldX / map.cellSize)));
  const row = Math.min(max, Math.max(0, Math.floor(worldZ / map.cellSize)));
  return { col, row };
}

/**
 * March a three.js ray (origin + dir, y-up) against the sim heightfield.
 * Sim (x, y) ↔ three (x, z). Returns miss when the ray never meets terrain.
 */
export function rayHitHeightfield(
  map: MapData,
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
): PinHit {
  // Prefer walking downhill along the ray (looking at ground).
  let prevAbove = originY > sampleHeight(map, originX, originZ);
  for (let t = RAY_STEP; t <= RAY_MAX; t += RAY_STEP) {
    const x = originX + dirX * t;
    const y = originY + dirY * t;
    const z = originZ + dirZ * t;
    const h = sampleHeight(map, x, z);
    const above = y > h;
    if (prevAbove && !above) {
      // First crossing: snap y to terrain height at this xz.
      const { col, row } = worldToGrid(map, x, z);
      return { x, y: h, z, col, row, source: "heightfield" };
    }
    prevAbove = above;
  }
  // Fallback: project to ground under camera (useful when looking straight down
  // or the march never crossed).
  const { col, row } = worldToGrid(map, originX, originZ);
  const h = sampleHeight(map, originX, originZ);
  return {
    x: originX,
    y: h,
    z: originZ,
    col,
    row,
    source: prevAbove ? "miss" : "heightfield",
  };
}

function pushNearby(
  out: PinNearby[],
  kind: string,
  px: number,
  pz: number,
  hx: number,
  hz: number,
  id?: number,
): void {
  const dx = px - hx;
  const dz = pz - hz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > NEARBY_RADIUS) return;
  out.push(id === undefined ? { kind, x: px, z: pz, dist } : { kind, id, x: px, z: pz, dist });
}

function nearestOnPolyline(
  points: readonly MapPoint[],
  hx: number,
  hz: number,
): { x: number; z: number; dist: number } | null {
  let best: { x: number; z: number; dist: number } | null = null;
  for (const p of points) {
    const dx = p.x - hx;
    const dz = p.y - hz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (!best || dist < best.dist) best = { x: p.x, z: p.y, dist };
  }
  return best;
}

/** Closest map features around a hit (turrets, bases, lanes, …). */
export function findNearby(map: MapData, hitX: number, hitZ: number): PinNearby[] {
  const out: PinNearby[] = [];
  for (let i = 0; i < map.turretSpots.length; i++) {
    const p = map.turretSpots[i];
    pushNearby(out, "turretSpot", p.x, p.y, hitX, hitZ, i);
  }
  for (let i = 0; i < map.outpostSpots.length; i++) {
    const p = map.outpostSpots[i];
    pushNearby(out, "outpostSpot", p.x, p.y, hitX, hitZ, i);
  }
  for (let i = 0; i < map.dummySpots.length; i++) {
    const p = map.dummySpots[i];
    pushNearby(out, "dummySpot", p.x, p.y, hitX, hitZ, i);
  }
  for (let i = 0; i < map.spawns.length; i++) {
    const p = map.spawns[i];
    pushNearby(out, "spawn", p.x, p.y, hitX, hitZ, i);
  }
  for (let i = 0; i < map.bases.length; i++) {
    const b = map.bases[i];
    pushNearby(out, "baseCore", b.core.x, b.core.y, hitX, hitZ, i);
    pushNearby(out, "baseGate", b.gate.x, b.gate.y, hitX, hitZ, i);
    pushNearby(out, "groundConsole", b.groundConsole.x, b.groundConsole.y, hitX, hitZ, i);
    pushNearby(out, "airConsole", b.airConsole.x, b.airConsole.y, hitX, hitZ, i);
    pushNearby(out, "pad", b.pad.x, b.pad.y, hitX, hitZ, i);
  }
  for (let li = 0; li < map.lanes.length; li++) {
    const n = nearestOnPolyline(map.lanes[li], hitX, hitZ);
    if (n && n.dist <= NEARBY_RADIUS) {
      out.push({ kind: "lane", id: li, x: n.x, z: n.z, dist: n.dist });
    }
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, NEARBY_LIMIT);
}

export interface BuildPinInput {
  readonly mapId: string;
  readonly url: string;
  readonly render: string;
  readonly seed: number | null;
  readonly tick: number | null;
  readonly camera: PinCamera;
  readonly hit: PinHit;
  readonly nearby: readonly PinNearby[];
  readonly notes: string;
  readonly createdAt?: string;
}

export function buildPin(input: BuildPinInput): VerificationPin {
  return {
    version: 1,
    createdAt: input.createdAt ?? new Date().toISOString(),
    mapId: input.mapId,
    url: input.url,
    render: input.render,
    seed: input.seed,
    tick: input.tick,
    camera: input.camera,
    hit: input.hit,
    nearby: input.nearby,
    notes: input.notes,
  };
}

export function buildPinPrompt(pin: VerificationPin): string {
  const cam = pin.camera;
  const hit = pin.hit;
  const nearby =
    pin.nearby.length === 0
      ? "(none within radius)"
      : pin.nearby
          .map((n) => {
            const id = n.id === undefined ? "" : `#${n.id}`;
            return `- ${n.kind}${id} dist=${n.dist.toFixed(1)} @ (${n.x.toFixed(1)}, ${n.z.toFixed(1)})`;
          })
          .join("\n");
  return [
    "## Verification Pin",
    `- map: ${pin.mapId}`,
    `- cam: fly @ (${cam.x.toFixed(2)}, ${cam.y.toFixed(2)}, ${cam.z.toFixed(2)}) yaw=${cam.yaw.toFixed(3)} pitch=${cam.pitch.toFixed(3)}`,
    `- grid: col=${hit.col} row=${hit.row}  world=(${hit.x.toFixed(2)}, ${hit.z.toFixed(2)}) y=${hit.y.toFixed(2)} source=${hit.source}`,
    `- tick/seed/render: ${pin.tick ?? "n/a"} / ${pin.seed ?? "n/a"} / ${pin.render}`,
    `- url: ${pin.url}`,
    "",
    "## Nearby features",
    nearby,
    "",
    "## User problem (from pin modal)",
    pin.notes.length > 0 ? pin.notes : "(empty — ask what the problem is)",
    "",
    "## Screenshot",
    "(see view.png)",
    "",
    "## Auftrag an Agent",
    "1. pin.json + view.png lesen.",
    "2. User-Problem ernst nehmen; Viewport/Ort aus dem Pin nutzen.",
    "3. Mit FCOP-viz / map JSON / mesh-alignment abgleichen.",
    "4. Konkreten Fix vorschlagen oder umsetzen (Datei + Änderung).",
    "5. Nur nachfragen, wenn notes unklar oder leer sind.",
    "",
  ].join("\n");
}

export function pinIdFromCreatedAt(createdAt: string): string {
  // 2026-07-30T12:34:56.789Z → 20260730-123456
  const d = createdAt
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace(/\.\d+Z$/, "");
  return d.length >= 15 ? d.slice(0, 15) : d || "pin";
}
