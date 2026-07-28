// Measures how each committed terrain .glb sits relative to its sim heightfield
// and emits the offsets the renderer applies at load time
// (packages/client/src/render/mapAlign.generated.ts).
//
// WHY THIS EXISTS
// The .glb terrain meshes are built by the private RE pipeline (til_mesh.py) in
// an origin-centered frame, while the sim/collision/entities live in the map's
// [0, extent] grid frame. Three facts make the offset impossible to guess:
//   1. the FCOP grid is non-square and convert.ts pads the short axis, so the
//      apron is asymmetric — bounding-box centering lands ~8 cells off;
//   2. the .glb covers only the real (unpadded) region, so its min corner is
//      NOT grid cell 0 — for every arena so far it is one Til (16 cells) in X;
//   3. glb Y is already in the sim's height frame, so any Y translation at all
//      (the old `-box.min.y`) floats the art above the collision surface.
// Rather than trust a formula, this measures the truth: for each candidate
// integer shift of the min corner it counts how many mesh vertices land exactly
// on their heightfield sample, and keeps the unambiguous winner.
//
// Like convert.ts and genUnitModels.ts this runs at AUTHORING time only — the
// committed .ts output is the artifact, so any Math.* is fine here. The
// determinism guard never scans tools/.
//
//   bun run gen:mapalign            # from the repo root
//   bun run gen:mapalign --check    # verify the committed file, write nothing
//
// tools/generators/test/mapAlign.test.ts re-derives the same numbers from the
// committed files, so a regenerated .glb or map can never silently drift.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMapById, MAP_REGISTRY, type MapData, worldExtent } from "@metropolis/sim";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const MODELS_DIR = join(REPO_ROOT, "packages", "client", "public", "models");
const OUT_FILE = join(REPO_ROOT, "packages", "client", "src", "render", "mapAlign.generated.ts");

/** Search radius in cells around the min corner, both axes. */
const SEARCH = 32;
/** A vertex "matches" when its Y is within this of the heightfield sample (m). */
const MATCH_EPS = 0.02;
/** Cap on vertices scored per map — the search is O(shifts × samples). */
const MAX_SAMPLES = 12000;
/** Minimum exact-match fraction for the winning offset, over all vertices. */
const MIN_MATCH = 0.9;
/**
 * Minimum lead over the best offset that is NOT part of the winner's own peak,
 * measured on STRUCTURE ONLY.
 *
 * Two refinements make this a real proof rather than a vibe:
 *   1. Scoring every vertex makes any peak look shallow, because most of an
 *      arena is flat outer apron that matches just as well one cell off.
 *      Dropping vertices at the heightfield's modal (apron) height leaves only
 *      walls, ramps, platforms and pads, where a one-cell error hurts.
 *   2. A correlation peak's nearest neighbours are *supposed* to score highly —
 *      penalising that would just be measuring how detailed the arena is. What
 *      actually matters is that no OTHER location competes, so the margin is
 *      taken against the best candidate more than PEAK_RADIUS cells away.
 */
const MIN_MARGIN = 0.05;
/** Offsets within this Chebyshev distance of the winner are its own peak. */
const PEAK_RADIUS = 2;

export interface MapAlignRecord {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  readonly match: number;
}

interface Mesh {
  /** Interleaved xyz, one triple per vertex. */
  readonly pos: Float32Array;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

// ---------------------------------------------------------------------------
// Minimal glTF-binary reader. @gltf-transform/core would also do this, but the
// only thing needed here is POSITION, and reading the container directly keeps
// the test dependency-free and fast (these meshes are up to 725k vertices).
// ---------------------------------------------------------------------------

interface GltfAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  byteOffset?: number;
  min?: number[];
  max?: number[];
}

interface GltfJson {
  meshes?: { primitives: { attributes: Record<string, number> }[] }[];
  nodes?: {
    mesh?: number;
    matrix?: number[];
    translation?: number[];
    scale?: number[];
    rotation?: number[];
  }[];
  accessors?: GltfAccessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"
const COMPONENT_FLOAT = 5126;

/** Reads every POSITION accessor of a .glb into one packed Float32Array. */
export function readGlbPositions(path: string): Mesh {
  const file = readFileSync(path);
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error(`${path}: not a .glb`);
  const total = view.getUint32(8, true);

  let json: GltfJson | undefined;
  let bin: Uint8Array | undefined;
  let cursor = 12;
  while (cursor + 8 <= total) {
    const length = view.getUint32(cursor, true);
    const kind = view.getUint32(cursor + 4, true);
    const body = file.subarray(cursor + 8, cursor + 8 + length);
    if (kind === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body)) as GltfJson;
    else if (kind === CHUNK_BIN) bin = body;
    cursor += 8 + length;
  }
  if (!json || !bin) throw new Error(`${path}: missing JSON or BIN chunk`);

  // The arena meshes are a single untransformed node; a transform would silently
  // invalidate every offset measured here, so refuse rather than guess.
  for (const node of json.nodes ?? []) {
    if (node.mesh === undefined) continue;
    if (node.matrix || node.translation || node.rotation || node.scale) {
      throw new Error(`${path}: mesh node carries a transform — genMapAlign assumes identity`);
    }
  }

  const accessors = json.accessors ?? [];
  const bufferViews = json.bufferViews ?? [];
  const chunks: Float32Array[] = [];
  let count = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const index = prim.attributes.POSITION;
      if (index === undefined) continue;
      const accessor = accessors[index];
      if (accessor.componentType !== COMPONENT_FLOAT || accessor.type !== "VEC3") {
        throw new Error(`${path}: POSITION is not float VEC3 (quantized meshes unsupported)`);
      }
      const bv = bufferViews[accessor.bufferView];
      const base = (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const stride = bv.byteStride ?? 12;
      const out = new Float32Array(accessor.count * 3);
      const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
      for (let v = 0; v < accessor.count; v++) {
        const at = base + v * stride;
        for (let c = 0; c < 3; c++) {
          const value = dv.getFloat32(at + c * 4, true);
          out[v * 3 + c] = value;
          if (value < min[c]) min[c] = value;
          if (value > max[c]) max[c] = value;
        }
      }
      chunks.push(out);
      count += accessor.count;
    }
  }
  if (count === 0) throw new Error(`${path}: no POSITION data`);

  const pos = new Float32Array(count * 3);
  let at = 0;
  for (const chunk of chunks) {
    pos.set(chunk, at);
    at += chunk.length;
  }
  // Accessor min/max are advisory; the scan uses what was actually read.
  return { pos, min, max };
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

/** True when (col, row) has any surface — base terrain or a deck — at `y`. */
function heightMatches(map: MapData, col: number, row: number, y: number): boolean {
  const at = row * map.size + col;
  if (Math.abs(map.heights[at] - y) < MATCH_EPS) return true;
  for (let layer = 0; layer < map.layerHeights.length; layer++) {
    if (map.layerMask[layer][at] === 0) continue;
    if (Math.abs(map.layerHeights[layer][at] - y) < MATCH_EPS) return true;
  }
  return false;
}

export interface AlignScan {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Exact-match fraction over every in-bounds sampled vertex. */
  readonly match: number;
  /** Exact-match fraction over structure only (apron-height vertices dropped). */
  readonly structure: number;
  /** Structure-score lead over the best offset outside the winner's own peak. */
  readonly margin: number;
  /** Cell shift of the winner relative to the mesh's min corner. */
  readonly shiftX: number;
  readonly shiftZ: number;
  readonly samples: number;
  readonly structureSamples: number;
}

/** The dominant height of a heightfield — the flat outer apron on FCOP arenas. */
function modalHeight(map: MapData): number {
  const tally = new Map<number, number>();
  for (let i = 0; i < map.heights.length; i++) {
    const h = map.heights[i];
    tally.set(h, (tally.get(h) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [h, n] of tally) {
    if (n > bestCount) {
      bestCount = n;
      best = h;
    }
  }
  return best;
}

/**
 * Finds the translation that best places `mesh` on `map`'s heightfield.
 *
 * Offsets are searched as integer cell shifts of the mesh's min corner, because
 * the mesh's vertices sit on cell corners (half-integer coordinates), so
 * `-min` already carries the fractional part exactly.
 */
export function scanAlignment(map: MapData, mesh: Mesh): AlignScan {
  const cell = map.cellSize;
  const vertices = mesh.pos.length / 3;
  const step = Math.max(1, Math.floor(vertices / MAX_SAMPLES));
  const samples = Math.floor((vertices - 1) / step) + 1;
  const extent = worldExtent(map);
  const apron = modalHeight(map);

  // Vertices off the apron height are the ones that carry positional
  // information; count them once so the structure score has a stable divisor.
  let structureSamples = 0;
  for (let v = 0; v < vertices; v += step) {
    if (Math.abs(mesh.pos[v * 3 + 1] - apron) >= MATCH_EPS) structureSamples++;
  }

  // Y is not searched: the .glb is authored in the sim's height frame, so a
  // non-zero Y offset can only ever be wrong. Scoring it as a candidate would
  // invite a false peak on a map whose apron happens to be flat at -min.y.
  const span = 2 * SEARCH + 1;
  const grid = new Float64Array(span * span);
  const matchGrid = new Float64Array(span * span);
  let best = { shiftX: 0, shiftZ: 0, structure: -1 };

  for (let kx = -SEARCH; kx <= SEARCH; kx++) {
    const offX = -mesh.min[0] + kx * cell;
    for (let kz = -SEARCH; kz <= SEARCH; kz++) {
      const offZ = -mesh.min[2] + kz * cell;
      let hits = 0;
      let structureHits = 0;
      for (let v = 0; v < vertices; v += step) {
        const x = mesh.pos[v * 3] + offX;
        const z = mesh.pos[v * 3 + 2] + offZ;
        if (x < 0 || x > extent || z < 0 || z > extent) continue;
        const y = mesh.pos[v * 3 + 1];
        if (!heightMatches(map, Math.round(x / cell), Math.round(z / cell), y)) continue;
        hits++;
        if (Math.abs(y - apron) >= MATCH_EPS) structureHits++;
      }
      const structure = structureSamples > 0 ? structureHits / structureSamples : 0;
      const at = (kx + SEARCH) * span + (kz + SEARCH);
      grid[at] = structure;
      matchGrid[at] = hits / samples;
      if (structure > best.structure) best = { shiftX: kx, shiftZ: kz, structure };
    }
  }

  // The margin is measured against the best candidate OUTSIDE the winner's own
  // correlation peak — a rival location, not the winner's own shoulders.
  let rival = 0;
  for (let kx = -SEARCH; kx <= SEARCH; kx++) {
    for (let kz = -SEARCH; kz <= SEARCH; kz++) {
      const far = Math.max(Math.abs(kx - best.shiftX), Math.abs(kz - best.shiftZ)) > PEAK_RADIUS;
      if (!far) continue;
      const score = grid[(kx + SEARCH) * span + (kz + SEARCH)];
      if (score > rival) rival = score;
    }
  }

  return {
    x: -mesh.min[0] + best.shiftX * cell,
    y: 0,
    z: -mesh.min[2] + best.shiftZ * cell,
    match: matchGrid[(best.shiftX + SEARCH) * span + (best.shiftZ + SEARCH)],
    structure: best.structure,
    margin: best.structure - rival,
    shiftX: best.shiftX,
    shiftZ: best.shiftZ,
    samples,
    structureSamples,
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export function measureArena(id: string): { record: MapAlignRecord; scan: AlignScan } {
  const map = getMapById(id);
  const mesh = readGlbPositions(join(MODELS_DIR, id, `${id}.glb`));
  const scan = scanAlignment(map, mesh);
  return {
    scan,
    record: {
      x: scan.x,
      y: scan.y,
      z: scan.z,
      minX: mesh.min[0],
      minY: mesh.min[1],
      minZ: mesh.min[2],
      maxX: mesh.max[0],
      maxY: mesh.max[1],
      maxZ: mesh.max[2],
      match: Math.round(scan.match * 1000) / 1000,
    },
  };
}

function emit(records: Map<string, MapAlignRecord>): string {
  const lines: string[] = [
    "// GENERATED by tools/generators/genMapAlign.ts — do not edit by hand.",
    "//",
    "// Translation applied to each terrain .glb so it lands on the sim's grid",
    "// frame, measured by correlating the mesh's vertices against MapData.heights",
    "// (`match` = fraction that landed exactly on their heightfield sample). The",
    "// recorded bounds are the ones the offsets were measured against;",
    "// render/meshMap.ts compares them at load time and shouts if a regenerated",
    "// asset has drifted, so a silently misplaced arena is not possible.",
    "//",
    "// Re-run `bun run gen:mapalign` after replacing any arena .glb or heightfield.",
    "",
    "export interface MapAlign {",
    "  /** Offset added to the loaded gltf.scene position, in sim world units. */",
    "  readonly x: number;",
    "  readonly y: number;",
    "  readonly z: number;",
    "  /** Mesh bounds the offsets were measured against — the drift guard. */",
    "  readonly minX: number;",
    "  readonly minY: number;",
    "  readonly minZ: number;",
    "  readonly maxX: number;",
    "  readonly maxY: number;",
    "  readonly maxZ: number;",
    "  /** Fraction of sampled vertices that matched the heightfield exactly. */",
    "  readonly match: number;",
    "}",
    "",
    "export const MAP_ALIGN: Readonly<Record<string, MapAlign>> = {",
  ];
  for (const [id, r] of records) {
    lines.push(`  "${id}": {`);
    lines.push(`    x: ${r.x},`);
    lines.push(`    y: ${r.y},`);
    lines.push(`    z: ${r.z},`);
    lines.push(`    minX: ${r.minX},`);
    lines.push(`    minY: ${r.minY},`);
    lines.push(`    minZ: ${r.minZ},`);
    lines.push(`    maxX: ${r.maxX},`);
    lines.push(`    maxY: ${r.maxY},`);
    lines.push(`    maxZ: ${r.maxZ},`);
    lines.push(`    match: ${r.match},`);
    lines.push("  },");
  }
  lines.push("};", "");
  return lines.join("\n");
}

function main(): void {
  const check = process.argv.includes("--check");
  const records = new Map<string, MapAlignRecord>();
  let failed = false;

  for (const info of MAP_REGISTRY) {
    const { record, scan } = measureArena(info.id);
    const ok = scan.match >= MIN_MATCH && scan.margin >= MIN_MARGIN;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${info.id.padEnd(16)} offset (${record.x}, ${record.y}, ${record.z})` +
        `  shift [${scan.shiftX},${scan.shiftZ}]  match ${scan.match.toFixed(3)}` +
        `  structure ${scan.structure.toFixed(3)}  margin ${scan.margin.toFixed(3)}` +
        `  samples ${scan.samples}/${scan.structureSamples}`,
    );
    if (!ok) {
      failed = true;
      console.error(
        `     ${info.id}: ambiguous or poor fit (need match >= ${MIN_MATCH}, margin >= ${MIN_MARGIN}) — ` +
          "the .glb and the heightfield may no longer be the same extraction",
      );
    }
    records.set(info.id, record);
  }
  if (failed) process.exit(1);

  const out = emit(records);
  if (check) {
    const current = readFileSync(OUT_FILE, "utf8");
    if (current !== out) {
      console.error("mapAlign.generated.ts is stale — run `bun run gen:mapalign`");
      process.exit(1);
    }
    console.log("mapAlign.generated.ts is up to date");
    return;
  }
  writeFileSync(OUT_FILE, out);
  console.log(`wrote ${OUT_FILE}`);
}

if (import.meta.main) main();
