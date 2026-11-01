// The original's terrain plates, per arena, for the sim's terrain trace
// (packages/sim/src/trace.ts, `terrain_trace_segment` 0x00454790 and
// `terrain_trace_cell` 0x00455480; fcop-fidelity.md T1).
//
//   <RE>/fixtures/missions/<Mission>   its Cptc (GRDB) and Ctil sections
//     -> tools/generators/fcop/<mission>-trace.json
//   <RE>/src/game/world/height.c       TERRAIN_TYPE_CORNERS, TERRAIN_TYPE_FLAGS
//     -> packages/sim/src/traceTables.generated.ts
//
// stage 2 (enrichArena.ts) copies each arena's file into
// packages/sim/maps/<id>.json as `trace`, with the original's origin moved into
// the sim's frame as every actor goes (16 m on the sim's x, LOGIC_OFFSET_X), so
// the map stays a function of committed inputs.
//
// What the trace reads, and so what is carried:
// - the grid: its width (cells on the original's z, the sim's x), its height
//   (cells on its x, the sim's y) and, per cell `x * width + z`, the Ctil
//   section id of its raw word (`(word >> 2) & 0x3fff`, `cptc_cell_raw` and
//   `ctil_section_of`);
// - of every section a cell names, its `Sect` chunk (the first chunk of the
//   resource, `ctil_relocate` 0x00450fa0) from its tag up to the end of the last
//   plate word its cell index reaches: the 17 x 17 x 3 height bytes at +12, the
//   four material bytes at +0x370, the 256 cell index words at +0x3cc and the
//   plate words at +0x5d0. The load's own rewrites of the chunk (+0, +4, +8,
//   +0x36f) fall outside what the trace reads.
//
//   bun run gen:trace [all | <mapId> | <Mission>] [--check] [--re-repo <path>]
//
// `--check` rebuilds from the RE's containers and sources and exits 1 if a
// committed file differs. Authoring-time only.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FcopArena, selectArenas } from "./fcopArenas";
import { containerIndex, containerResource } from "./fcopCoarse";
import { requireReRepo } from "./reRepo";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const TABLES_PATH = join(REPO_ROOT, "packages", "sim", "src", "traceTables.generated.ts");

/** GRDB payload words (RE fcop/grid.h), after its 8-byte chunk header and one word. */
const GRID_BASE = 12;
const GRID_WORD_WIDTH = 1;
const GRID_WORD_HEIGHT = 2;
const GRID_WORD_CELLS = 9;
/** fcop/terrain.h: the cell index and the plate words inside a `Sect`. */
const CELL_INDEX_OFFSET = 0x3cc;
const PLATE_OFFSET = 0x5d0;
/** The plate tables' rows (fcop/terrain.h TERRAIN_TYPE_COUNT). */
const TYPE_COUNT = 0x70;

export interface TraceFile {
  mission: string;
  mapId: string;
  note: string;
  /** Grid cells on the original's z (the sim's x). */
  width: number;
  /** Grid cells on the original's x (the sim's y). */
  height: number;
  /** Per grid row x (`height` of them), per cell z (`width`): the Ctil section id its word names. */
  cells: number[][];
  /** Each named section's `Sect` bytes the trace reads, base64. */
  sections: { id: number; data: string }[];
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function tagAt(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/** The grid and the plates the trace reads, from a container's bytes. */
export function buildTrace(container: Uint8Array): {
  width: number;
  height: number;
  cells: number[];
  sections: { id: number; data: Uint8Array }[];
} {
  const res = containerIndex(container);
  const gridAt = res.get("ctpC:1") ?? [...res.entries()].find(([k]) => k.startsWith("ctpC:"))?.[1];
  if (!gridAt) throw new Error("no Cptc in the container");
  const grid = containerResource(container, gridAt);
  if (tagAt(grid, 0) !== "BDRG") throw new Error("the Cptc is not a GRDB");
  const word = (w: number): number => u32(grid, GRID_BASE + 4 * w);
  const width = word(GRID_WORD_WIDTH);
  const height = word(GRID_WORD_HEIGHT);
  const cells: number[] = [];
  const ids = new Set<number>();
  for (let i = 0; i < width * height; i++) {
    const id = (word(GRID_WORD_CELLS + i) >> 2) & 0x3fff;
    cells.push(id);
    ids.add(id);
  }
  const sections: { id: number; data: Uint8Array }[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const at = res.get(`litC:${id}`);
    // `ctil_section_of` answers NULL for an id no Ctil registered; the trace
    // then answers clear over that cell.
    if (!at) continue;
    const blob = containerResource(container, at);
    if (tagAt(blob, 0) !== "tceS") throw new Error(`Ctil ${id}: the first chunk is not a Sect`);
    const chunk = u32(blob, 4);
    let end = PLATE_OFFSET;
    for (let c = 0; c < 256; c++) {
      const index = blob[CELL_INDEX_OFFSET + c * 2] | (blob[CELL_INDEX_OFFSET + c * 2 + 1] << 8);
      const last = PLATE_OFFSET + (index >> 4) + 4 * (index & 0xf);
      if (last > end) end = last;
    }
    if (end > chunk) throw new Error(`Ctil ${id}: plates run past the Sect chunk`);
    sections.push({ id, data: blob.slice(0, end) });
  }
  return { width, height, cells, sections };
}

function tracePath(a: FcopArena): string {
  return join(REPO_ROOT, "tools", "generators", "fcop", `${a.mission.toLowerCase()}-trace.json`);
}

export function readTrace(a: FcopArena): TraceFile | null {
  const path = tracePath(a);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as TraceFile) : null;
}

/** JSON in the layout the map files keep: two-space indent, each grid row of ids on one line. */
function serialize(f: TraceFile): string {
  const rows = f.cells.map((r) => `    [${r.join(", ")}]`).join(",\n");
  const text = JSON.stringify({ ...f, cells: "@CELLS@" }, null, 2);
  return `${text.replace('"@CELLS@"', `[\n${rows}\n  ]`)}\n`;
}

function build(a: FcopArena, reRepo: string): TraceFile {
  const container = new Uint8Array(readFileSync(join(reRepo, "fixtures", "missions", a.mission)));
  const t = buildTrace(container);
  return {
    mission: a.mission,
    mapId: a.mapId,
    note:
      `The original's terrain plates of the ${a.mission} container: the grid's section ids ` +
      `and each section's Sect bytes the terrain trace reads (0x00454790). Built by gen:trace.`,
    width: t.width,
    height: t.height,
    cells: Array.from({ length: t.height }, (_, x) =>
      t.cells.slice(x * t.width, (x + 1) * t.width),
    ),
    sections: t.sections.map((s) => ({ id: s.id, data: Buffer.from(s.data).toString("base64") })),
  };
}

/**
 * The two plate tables out of the RE's height.c, where `fcop/terrain.h`'s
 * TERRAIN_TYPE_CORNERS[0x70][4] (retail 0x0048c608) and TERRAIN_TYPE_FLAGS[0x70]
 * (retail 0x0048c7c8) are defined.
 */
function tablesSource(reRepo: string): string {
  const src = readFileSync(join(reRepo, "src", "game", "world", "height.c"), "utf8");
  const body = (name: string): number[] => {
    const m = new RegExp(`const u8 ${name}\\[[^\\]]*\\](?:\\[4\\])? = \\{([\\s\\S]*?)\\n\\};`).exec(
      src,
    );
    if (!m) throw new Error(`height.c: no ${name}`);
    const text = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    return [...text.matchAll(/0x[0-9a-fA-F]+|\d+/g)].map((t) => Number(t[0]));
  };
  const corners = body("TERRAIN_TYPE_CORNERS");
  const flags = body("TERRAIN_TYPE_FLAGS");
  if (corners.length !== TYPE_COUNT * 4) throw new Error(`corners: ${corners.length} values`);
  if (flags.length !== TYPE_COUNT) throw new Error(`flags: ${flags.length} values`);
  const rows = (vals: number[], per: number): string => {
    const out: string[] = [];
    for (let i = 0; i < vals.length; i += per) out.push(`  ${vals.slice(i, i + per).join(", ")},`);
    return out.join("\n");
  };
  return [
    "// GENERATED by tools/generators/fcopTrace.ts (bun run gen:trace) from the RE's",
    "// src/game/world/height.c. Do not edit.",
    "",
    "/**",
    " * TERRAIN_TYPE_CORNERS (retail 0x0048c608), row-major [type][4]: for each plate",
    " * type, the byte offsets into the cell's corner triple of the corners its",
    " * polygon reads. Rows 0x00..0x46 are the floor plates, 0x47..0x6f the walls.",
    " */",
    "export const TERRAIN_TYPE_CORNERS: Uint8Array = new Uint8Array([",
    rows(corners, 8),
    "]);",
    "",
    "/**",
    " * TERRAIN_TYPE_FLAGS (retail 0x0048c7c8): the low three bits a wall's kind (the",
    " * cell line it stands on), the high five its shape.",
    " */",
    "export const TERRAIN_TYPE_FLAGS: Uint8Array = new Uint8Array([",
    rows(flags, 12),
    "]);",
    "",
  ].join("\n");
}

/** The output as the formatter writes it, so a re-run and `--check` agree with lint. */
function repoFormat(text: string, path: string): string {
  const fmt = Bun.spawnSync(["bunx", "oxfmt", `--stdin-filepath=${path}`], {
    cwd: REPO_ROOT,
    stdin: new TextEncoder().encode(text),
  });
  if (fmt.exitCode !== 0) throw new Error(`oxfmt failed: ${fmt.stderr.toString()}`);
  return fmt.stdout.toString();
}

function main(): void {
  const reRepo = requireReRepo();
  const which = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "all";
  const check = process.argv.includes("--check");
  let bad = 0;
  const tables = repoFormat(tablesSource(reRepo), TABLES_PATH);
  if (check) {
    const same = existsSync(TABLES_PATH) && readFileSync(TABLES_PATH, "utf8") === tables;
    console.log(`plate tables: ${same ? "reproduce the committed file" : "PROBLEM differ"}`);
    if (!same) bad++;
  } else {
    writeFileSync(TABLES_PATH, tables);
    console.log(`plate tables -> ${TABLES_PATH}`);
  }
  for (const a of selectArenas(which)) {
    const text = serialize(build(a, reRepo));
    const path = tracePath(a);
    if (check) {
      const same = existsSync(path) && readFileSync(path, "utf8") === text;
      console.log(`${a.mapId}: ${same ? "reproduces the committed plates" : "PROBLEM differs"}`);
      if (!same) bad++;
      continue;
    }
    writeFileSync(path, text);
    const f = JSON.parse(text) as TraceFile;
    const bytes = f.sections.reduce((n, s) => n + Buffer.from(s.data, "base64").length, 0);
    console.log(
      `${a.mapId}: grid ${f.width} x ${f.height}, ${f.sections.length} sections, ${bytes} bytes`,
    );
  }
  if (bad > 0) process.exit(1);
}

if (import.meta.main) main();
