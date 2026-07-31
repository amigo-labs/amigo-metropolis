// Pure helpers for verification pins: heightfield ray hit, nearby map features,
// pin.json + prompt.txt builders. No DOM / Three imports — unit-testable.

import type { MapData, MapPoint } from "@metropolis/sim";
import {
  ANIM_AIRBORNE,
  ANIM_HOVER,
  ANIM_MOVING,
  ANIM_TRANSFORMING,
  ARCHETYPE,
  SNAPSHOT_STRIDE,
  sampleHeight,
} from "@metropolis/sim";
import type {
  PinCamera,
  PinClientInfo,
  PinConsoleEntry,
  PinEntity,
  PinHit,
  PinNearby,
  PinReproduction,
  PinShot,
  VerificationPin,
} from "./pinTypes";

const NEARBY_LIMIT = 8;
const NEARBY_RADIUS = 40;
const RAY_MAX = 400;
const RAY_STEP = 0.5;
// Wider than NEARBY_RADIUS: a unit shooting from 50 units away is part of the
// problem even when the pinned cell holds nothing.
const ENTITY_RADIUS = 60;
const ENTITY_LIMIT = 24;
const CONSOLE_LIMIT = 40;

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

// Reverse ARCHETYPE table, built once. Numbers are the snapshot contract; the
// agent reads names, and "3" means nothing to it without this.
const ARCHETYPE_NAMES: readonly string[] = (() => {
  const out: string[] = [];
  for (const [name, value] of Object.entries(ARCHETYPE)) out[value] = name;
  return out;
})();

const ANIM_FLAGS: readonly (readonly [number, string])[] = [
  [ANIM_MOVING, "moving"],
  [ANIM_HOVER, "hover"],
  [ANIM_AIRBORNE, "airborne"],
  [ANIM_TRANSFORMING, "transforming"],
];

/** Archetypes that can move; a static scene is one a reshoot can reproduce. */
const MOVABLE: readonly number[] = [
  ARCHETYPE.AVATAR,
  ARCHETYPE.RUNNER,
  ARCHETYPE.GUARDIAN,
  ARCHETYPE.JUGGERNAUT,
  ARCHETYPE.FORTRESS,
  ARCHETYPE.PROJECTILE,
  ARCHETYPE.WARDEN,
];

export function archetypeName(archetype: number): string {
  return ARCHETYPE_NAMES[archetype] ?? `ARCHETYPE_${archetype}`;
}

export function animNames(animState: number): string[] {
  const out: string[] = [];
  for (const [bit, name] of ANIM_FLAGS) {
    if ((animState & bit) !== 0) out.push(name);
  }
  return out;
}

/**
 * Live entities near the hit, decoded from a sim snapshot buffer (stride 10,
 * architecture.md §3 — the only interface the renderer is allowed to read).
 * Sim (x, y) ↔ world (x, z); slot 5 is the height.
 *
 * Sorted by distance and capped like findNearby, so pin.json stays readable.
 */
export function findEntities(
  snap: Float32Array,
  count: number,
  hitX: number,
  hitZ: number,
): PinEntity[] {
  const out: PinEntity[] = [];
  for (let c = 0; c < count; c++) {
    const o = c * SNAPSHOT_STRIDE;
    const x = snap[o + 3];
    const z = snap[o + 4];
    const dx = x - hitX;
    const dz = z - hitZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > ENTITY_RADIUS) continue;
    out.push({
      id: snap[o],
      archetype: archetypeName(snap[o + 1]),
      team: snap[o + 2],
      x,
      z,
      height: snap[o + 5],
      yaw: snap[o + 6],
      anim: animNames(snap[o + 7]),
      hpFrac: snap[o + 8],
      aux: snap[o + 9],
      dist,
    });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, ENTITY_LIMIT);
}

/**
 * A frame is reproducible when nothing movable was in it: terrain, mesh
 * placement and turret/base spots are a pure function of map + render mode, so
 * a reshoot at the same camera pose is a true before/after. Live units are not
 * — without a recorded replay a reshoot re-runs a fresh sim (see pinTypes.ts).
 */
export function classifyReproduction(entities: readonly PinEntity[]): PinReproduction {
  const movable = new Set(MOVABLE.map(archetypeName));
  return entities.some((e) => movable.has(e.archetype)) ? "approximate" : "static";
}

export interface ConsoleRing {
  readonly push: (level: PinConsoleEntry["level"], text: string, tick: number | null) => void;
  readonly entries: () => PinConsoleEntry[];
  readonly clear: () => void;
}

/**
 * Bounded console tail. A texture that silently fell back to greybox only ever
 * says so on the console, which no screenshot shows — so the pin carries the
 * last few entries. Pure ring, no console patching (that lives in pinSession).
 */
export function createConsoleRing(limit: number = CONSOLE_LIMIT): ConsoleRing {
  const buf: PinConsoleEntry[] = [];
  let next = 0;
  return {
    push(level, text, tick) {
      const entry: PinConsoleEntry = { level, text, tick };
      if (buf.length < limit) {
        buf.push(entry);
        return;
      }
      buf[next] = entry;
      next = (next + 1) % limit;
    },
    entries() {
      // Oldest first, regardless of where the write head sits.
      if (buf.length < limit) return buf.slice();
      return buf.slice(next).concat(buf.slice(0, next));
    },
    clear() {
      buf.length = 0;
      next = 0;
    },
  };
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
  readonly entities?: readonly PinEntity[];
  readonly shots?: readonly PinShot[];
  readonly console?: readonly PinConsoleEntry[];
  readonly simHash?: number | null;
  readonly client?: PinClientInfo;
  readonly parentId?: string | null;
  readonly origin?: "hotkey" | "agent";
}

const EMPTY_CLIENT: PinClientInfo = {
  viewport: [0, 0],
  dpr: 1,
  gpu: null,
  texVariant: null,
  greyboxStructures: false,
  commit: null,
};

export function buildPin(input: BuildPinInput): VerificationPin {
  const entities = input.entities ?? [];
  return {
    version: 2,
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
    entities,
    shots: input.shots ?? [],
    console: input.console ?? [],
    simHash: input.simHash ?? null,
    client: input.client ?? EMPTY_CLIENT,
    reproduction: classifyReproduction(entities),
    parentId: input.parentId ?? null,
    origin: input.origin ?? "hotkey",
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
  const entities =
    pin.entities.length === 0
      ? "(none within radius — static scene)"
      : pin.entities
          .map(
            (e) =>
              `- #${e.id} ${e.archetype} team=${e.team} dist=${e.dist.toFixed(1)} ` +
              `@ (${e.x.toFixed(1)}, ${e.z.toFixed(1)}) h=${e.height.toFixed(1)} ` +
              // Ratio, not a percentage: map HP overrides push this above 1
              // (see PinEntity.hpFrac), and "500%" reads like a bug that isn't.
              `yaw=${e.yaw.toFixed(3)} hp=${e.hpFrac.toFixed(2)}xmax` +
              `${e.anim.length > 0 ? ` [${e.anim.join(",")}]` : ""}`,
          )
          .join("\n");
  const shots =
    pin.shots.length === 0
      ? "- view.png (fly camera)"
      : pin.shots
          .map((s) => {
            const w = s.world;
            const area = w
              ? ` covers x ${w[0].toFixed(1)}..${w[2].toFixed(1)}, z ${w[1].toFixed(1)}..${w[3].toFixed(1)}`
              : "";
            return `- ${s.file} (${s.kind}, ${s.projection}, ${s.width}x${s.height})${area}`;
          })
          .join("\n");
  const problems = pin.console.filter((c) => c.level === "warn" || c.level === "error");
  const consoleBlock =
    problems.length === 0
      ? "(no warnings or errors)"
      : problems.map((c) => `- [${c.level}] ${c.text}`).join("\n");
  return [
    "## Verification Pin",
    `- map: ${pin.mapId}`,
    `- cam: fly @ (${cam.x.toFixed(2)}, ${cam.y.toFixed(2)}, ${cam.z.toFixed(2)}) yaw=${cam.yaw.toFixed(3)} pitch=${cam.pitch.toFixed(3)}`,
    `- grid: col=${hit.col} row=${hit.row}  world=(${hit.x.toFixed(2)}, ${hit.z.toFixed(2)}) y=${hit.y.toFixed(2)} source=${hit.source}`,
    `- tick/seed/render: ${pin.tick ?? "n/a"} / ${pin.seed ?? "n/a"} / ${pin.render}`,
    `- simHash: ${pin.simHash === null ? "n/a" : `0x${(pin.simHash >>> 0).toString(16)}`}`,
    `- gpu: ${pin.client.gpu ?? "n/a"}  tex: ${pin.client.texVariant ?? "n/a"}`,
    `- reproduction: ${pin.reproduction}`,
    `- origin: ${pin.origin}${pin.parentId ? `  (reshoot of ${pin.parentId})` : ""}`,
    `- url: ${pin.url}`,
    "",
    "## Nearby features (map JSON — gameplay truth)",
    nearby,
    "",
    "## Live entities (sim snapshot)",
    entities,
    "",
    "## Console (warnings + errors only)",
    consoleBlock,
    "",
    "## User problem (from pin modal)",
    pin.notes.length > 0 ? pin.notes : "(empty — ask what the problem is)",
    "",
    "## Shots",
    shots,
    "",
    "## Auftrag an Agent",
    "1. pin.json + view.png + top.png lesen (Bilder wirklich ansehen).",
    "2. User-Problem ernst nehmen; Viewport/Ort aus dem Pin nutzen.",
    "3. Mit FCOP-viz / map JSON / mesh-alignment abgleichen.",
    "   Layout-Fragen entscheidet top.png gegen docs/renders/fcop-viz/<map>/<map>-top.png,",
    "   nicht die Fly-Perspektive.",
    "4. Konkreten Fix vorschlagen oder umsetzen (Datei + Änderung).",
    "5. Nur nachfragen, wenn notes unklar oder leer sind.",
    "6. Danach `bun run pin:drive reshoot <id>` für einen Vorher/Nachher-Vergleich.",
    pin.reproduction === "approximate"
      ? "   ACHTUNG: reproduction=approximate — bewegliche Entities im Bild. Ein Reshoot\n" +
        "   stellt Terrain und Placement exakt her, die Units aber NICHT (kein Replay\n" +
        "   aufgezeichnet). Als Beleg nur für statische Geometrie verwenden."
      : "   reproduction=static — ein Reshoot ist ein echter Vorher/Nachher-Vergleich.",
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
