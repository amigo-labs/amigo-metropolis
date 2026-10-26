// The original's coarse ground-height field, per arena: what the K-9 Drone
// measures its clearance against (RE game/actor/prepare.c, the build
// `cact_coarse_height_build` 0x00455e00 and the query `cact_coarse_height_at`
// 0x00456180; missile.c 0x004238f9).
//
//   <RE>/fixtures/missions/<Mission>   its Cptc (GRDB) and Ctil sections
//     -> tools/generators/fcop/<mission>-coarse.json
//
// stage 2 (enrichArena.ts) copies it into packages/sim/maps/<id>.json as
// `coarse`, so the map stays a function of committed inputs.
//
// The build, as retail: one signed byte per two terrain samples, the maximum
// of the twelve height bytes of each 2x2 sample block (all three channels),
// blurred [[1,2,1],[2,4,2],[1,2,1]] / 16 (+8) and maxed against the unblurred
// value again — an upper envelope. It covers the grid cells from (margin - 1,
// margin - 1), cols = width - 2 margin + 1 by rows = height - 2 margin + 1,
// eight bytes a cell each way, and its origin is `margin * 0x20000 - 0x1e000`
// world units on both axes. A field row steps with the original's x — the
// sim's y — and a column with its z — the sim's x.
//
// The file keeps that origin in the original's frame, metres; stage 2 moves it
// into the sim's (map.ts MapCoarse) as it moves every actor: 16 more on the
// sim's x, since the terrain the arenas were converted from (RE til_mesh.py)
// reads the grid's cells one word early and puts every sample 16 columns on
// (enrichArena.ts LOGIC_OFFSET_X).
//
//   bun run gen:coarse [all | <mapId> | <Mission>] [--check] [--re-repo <path>]
//
// `--check` rebuilds from the RE's containers and exits 1 if a committed file
// differs. Authoring-time only.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FcopArena, selectArenas } from "./fcopArenas";
import { argOf } from "./fcopLogic";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** The container's write block: no chunk crosses a 0x6000 boundary. */
const BLOCK = 0x6000;
/** GRDB payload words (RE fcop/grid.h), after its 8-byte chunk header and one word. */
const GRID_BASE = 12;
const GRID_WORD_WIDTH = 1;
const GRID_WORD_HEIGHT = 2;
const GRID_WORD_MARGIN = 6;
const GRID_WORD_CELLS = 9;
/** A Sect's heightmap: 17 x 17 samples of three channels, from the chunk's +12. */
const SAMPLES = 12;
const ROW_BYTES = 17 * 3;
/** World units a metre, a grid cell, a field cell. */
const WU_PER_METRE = 8192;
const GRID_CELL_WU = 0x20000;

export interface CoarseField {
  mission: string;
  mapId: string;
  note: string;
  /** Field rows (the sim's y) and bytes a row (the sim's x). */
  rows: number;
  stride: number;
  /**
   * Where field row 0 and column 0 begin, metres in the original's frame:
   * `margin * 0x20000 - 0x1e000` world units, the same on both axes.
   */
  origin: number;
  /** One hex string per row, two digits a signed byte (1/32 m). */
  field: string[];
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function tagAt(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function lettersAt(b: Uint8Array, o: number): boolean {
  for (let i = 0; i < 4; i++) {
    const c = b[o + i];
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
  }
  return true;
}

interface ResAt {
  pos: number;
  size: number;
  total: number;
}

/** RE fcop.py `parse`: every resource's header chunk, by its on-disk type tag and id. */
function index(b: Uint8Array): Map<string, ResAt> {
  const out = new Map<string, ResAt>();
  let pos = 0;
  while (pos < b.length) {
    const rem = BLOCK - (pos % BLOCK);
    if (rem < 8 || pos + 8 > b.length) {
      pos += rem;
      continue;
    }
    const size = u32(b, pos + 4);
    if (size < 8 || size > rem || !lettersAt(b, pos)) {
      pos += rem;
      continue;
    }
    if (tagAt(b, pos) === "COHS" && tagAt(b, pos + 16) === "RDHS") {
      out.set(`${tagAt(b, pos + 24)}:${u32(b, pos + 28)}`, {
        pos,
        size,
        total: u32(b, pos + 32),
      });
    }
    pos += size;
  }
  return out;
}

/** RE fcop.py `extract`: the resource's TADS fragments, concatenated. */
function extract(b: Uint8Array, at: ResAt): Uint8Array {
  const out = new Uint8Array(at.total);
  let len = 0;
  let pos = at.pos + at.size;
  while (pos < b.length && len < at.total) {
    const rem = BLOCK - (pos % BLOCK);
    if (rem < 8 || pos + 8 > b.length) {
      pos += rem;
      continue;
    }
    const size = u32(b, pos + 4);
    if (size < 8 || size > rem || !lettersAt(b, pos)) {
      pos += rem;
      continue;
    }
    if (tagAt(b, pos) === "COHS") {
      const sub = tagAt(b, pos + 16);
      if (sub === "RDHS") break;
      if (sub === "TADS") {
        const piece = b.subarray(pos + 20, Math.min(pos + size, pos + 20 + at.total - len));
        out.set(piece, len);
        len += piece.length;
      }
    }
    pos += size;
  }
  return out.subarray(0, len);
}

const i8 = (v: number): number => (v << 24) >> 24;

/** `cact_coarse_height_build` (0x00455e00) over a container's bytes. */
export function buildCoarse(container: Uint8Array): {
  rows: number;
  stride: number;
  margin: number;
  field: Int8Array;
} {
  const res = index(container);
  const gridAt = res.get("ctpC:1") ?? [...res.entries()].find(([k]) => k.startsWith("ctpC:"))?.[1];
  if (!gridAt) throw new Error("no Cptc in the container");
  const grid = extract(container, gridAt);
  if (tagAt(grid, 0) !== "BDRG") throw new Error("the Cptc is not a GRDB");
  const word = (w: number): number => u32(grid, GRID_BASE + 4 * w);
  const width = word(GRID_WORD_WIDTH);
  const height = word(GRID_WORD_HEIGHT);
  const margin = word(GRID_WORD_MARGIN);
  const cols = width - margin * 2 + 1;
  const rows = height - margin * 2 + 1;
  const stride = cols * 8;
  const fieldRows = rows * 8;
  const scratch = new Int8Array(fieldRows * stride);
  const sects = new Map<number, { blob: Uint8Array; at: number }>();
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const cell = width * (i + margin - 1) + j + (margin - 1);
      const id = (word(GRID_WORD_CELLS + cell) >> 2) & 0x3fff;
      let s = sects.get(id);
      if (!s) {
        const at = res.get(`litC:${id}`);
        if (!at) throw new Error(`grid cell (${i}, ${j}) names Ctil ${id}, which is not there`);
        const blob = extract(container, at);
        const sect = (() => {
          for (let p = 0; p + 4 <= blob.length; p++) if (tagAt(blob, p) === "tceS") return p;
          return -1;
        })();
        if (sect < 0) throw new Error(`Ctil ${id} has no Sect`);
        s = { blob, at: sect };
        sects.set(id, s);
      }
      // coarse_fill_cell (0x00455e00's first phase): each output byte the
      // maximum of two sample rows by two samples by three channels.
      for (let r = 0; r < 8; r++) {
        const src = s.at + SAMPLES + ROW_BYTES + r * 2 * ROW_BYTES;
        for (let c = 0; c < 8; c++) {
          let best = -0x80;
          for (let k = 0; k < 6; k++) {
            const above = i8(s.blob[src + c * 6 + k - ROW_BYTES]);
            if (above > best) best = above;
            const here = i8(s.blob[src + c * 6 + k]);
            if (here > best) best = here;
          }
          scratch[(i * 8 + r) * stride + j * 8 + c] = best;
        }
      }
    }
  }
  // The blur, the edge row and column folded into the centre, and the
  // maximum of the blurred and the unblurred value.
  const field = new Int8Array(fieldRows * stride);
  for (let r = 0; r < fieldRows; r++) {
    const prev = stride * (r > 0 ? r - 1 : 0);
    const cur = stride * r;
    const next = stride * (r + 1 < fieldRows ? r + 1 : fieldRows - 1);
    for (let c = 0; c < stride; c++) {
      const P = (k: number) => scratch[prev + k];
      const C = (k: number) => scratch[cur + k];
      const N = (k: number) => scratch[next + k];
      let v: number;
      if (c === 0) {
        v = ((P(0) + 2 * C(0) + N(0)) * 3 + 2 * C(1) + N(1) + P(1) + 8) >> 4;
      } else if (c === stride - 1) {
        v = ((P(c) + 2 * C(c) + N(c)) * 3 + 2 * C(c - 1) + P(c - 1) + N(c - 1) + 8) >> 4;
      } else {
        v =
          ((C(c - 1) + 2 * C(c) + P(c) + N(c) + C(c + 1) + 4) * 2 +
            P(c - 1) +
            N(c - 1) +
            N(c + 1) +
            P(c + 1)) >>
          4;
      }
      if (v < -0x80) v = -0x80;
      else if (v > 0x7f) v = 0x7f;
      if (v < C(c)) v = C(c);
      field[cur + c] = v;
    }
  }
  return { rows: fieldRows, stride, margin, field };
}

function coarsePath(a: FcopArena): string {
  return join(REPO_ROOT, "tools", "generators", "fcop", `${a.mission.toLowerCase()}-coarse.json`);
}

export function readCoarse(a: FcopArena): CoarseField | null {
  const path = coarsePath(a);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as CoarseField) : null;
}

function serialize(f: CoarseField): string {
  return `${JSON.stringify(f, null, 2)}\n`;
}

function build(a: FcopArena, reRepo: string): CoarseField {
  const container = new Uint8Array(readFileSync(join(reRepo, "fixtures", "missions", a.mission)));
  const { rows, stride, margin, field } = buildCoarse(container);
  // The origin, margin * 0x20000 - 0x1e000 world units, in sim metres.
  const origin = (margin * GRID_CELL_WU - 0x1e000) / WU_PER_METRE;
  const hex: string[] = [];
  for (let r = 0; r < rows; r++) {
    let s = "";
    for (let c = 0; c < stride; c++)
      s += (field[r * stride + c] & 0xff).toString(16).padStart(2, "0");
    hex.push(s);
  }
  return {
    mission: a.mission,
    mapId: a.mapId,
    note:
      `The original's coarse ground-height field (cact_coarse_height_build 0x00455e00) ` +
      `of the ${a.mission} container, the K-9 Drone's clearance surface. Built by gen:coarse.`,
    rows,
    stride,
    origin,
    field: hex,
  };
}

function main(): void {
  const reRepo = argOf(
    "re-repo",
    process.env.FCOP_RE_REPO ?? "/workspace/fcop-reverse-engineering",
  );
  const which = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "all";
  const check = process.argv.includes("--check");
  let bad = 0;
  for (const a of selectArenas(which)) {
    const text = serialize(build(a, reRepo));
    const path = coarsePath(a);
    if (check) {
      const same = existsSync(path) && readFileSync(path, "utf8") === text;
      console.log(`${a.mapId}: ${same ? "reproduces the committed field" : "PROBLEM differs"}`);
      if (!same) bad++;
      continue;
    }
    writeFileSync(path, text);
    const f = JSON.parse(text) as CoarseField;
    console.log(`${a.mapId}: ${f.rows} x ${f.stride}, origin ${f.origin} m`);
  }
  if (bad > 0) process.exit(1);
}

if (import.meta.main) main();
