// The original's terrain height query, over a shipped container's bytes.
//
// `terrain_height_at` (retail 0x004545d0, RE src/game/world/height.c) answers
// "how high is surface N of the stack of plates over this point": the layout
// grid (Cptc GRDB) picks a Ctil section, the section's per-cell index picks a
// list of plates, every plate that covers the point contributes a height, the
// heights are sorted ascending, and the layer argument picks one — -1 the
// topmost, -2 the lowest, 0..2 counted from the bottom. Every actor construct
// and `cnet_load` stand their actor on it, with a layer remapped from a byte of
// their own record (fcopLogic.ts HEIGHT_SELECTOR).
//
// This file reproduces the query's plate stack so gen:palogic can carry, per
// record, the height the original stands it at. Stage 2 then puts the feature
// on whichever of the sim's surfaces carries that height — the sim's decks are
// stage 1's clustering of the same plates, so the two cannot be compared by
// index, only by height.
//
// Authoring-time only.

import { containerIndex, containerResource } from "./fcopCoarse";

/** GRDB payload words (RE fcop/grid.h), after its 8-byte chunk header and one word. */
const GRID_BASE = 12;
const GRID_WORD_WIDTH = 1;
const GRID_WORD_HEIGHT = 2;
const GRID_WORD_CELLS = 9;
/** fcop/terrain.h: world units a sample (1 m) and a grid cell (16 m), as shifts. */
const SAMPLE_SHIFT = 13;
const CELL_SHIFT = 17;
/** Offsets inside a Ctil `Sect` chunk (from its tag). */
const CELL_INDEX_OFFSET = 0x3cc;
const PLATE_OFFSET = 0x5d0;
/** The highest plate type the height query accepts; above it are wall plates. */
const TYPE_MAX = 0x46;

/** TERRAIN_TYPE_CORNERS rows 0..0x46 (retail 0x0048c608). */
const CORNERS: readonly (readonly number[])[] = [
  [3, 54, 51, 3],
  [0, 3, 51, 0],
  [4, 55, 52, 4],
  [1, 4, 52, 1],
  [5, 56, 53, 5],
  [2, 5, 53, 2],
  [0, 54, 51, 0],
  [0, 3, 54, 0],
  [1, 55, 52, 1],
  [1, 4, 55, 1],
  [2, 56, 53, 2],
  [2, 5, 56, 2],
  [1, 54, 51, 1],
  [1, 4, 54, 1],
  [2, 55, 52, 2],
  [2, 5, 55, 2],
  [4, 54, 51, 4],
  [1, 4, 51, 1],
  [5, 55, 52, 5],
  [2, 5, 52, 2],
  [0, 3, 55, 0],
  [0, 55, 52, 0],
  [1, 4, 56, 1],
  [1, 56, 53, 1],
  [0, 3, 52, 0],
  [3, 55, 52, 3],
  [1, 4, 53, 1],
  [4, 56, 53, 4],
  [0, 55, 51, 0],
  [0, 4, 55, 0],
  [1, 56, 52, 1],
  [1, 5, 56, 1],
  [0, 4, 51, 0],
  [4, 55, 51, 4],
  [1, 5, 52, 1],
  [5, 56, 52, 5],
  [3, 54, 52, 3],
  [1, 3, 52, 1],
  [4, 55, 53, 4],
  [2, 4, 53, 2],
  [1, 3, 54, 1],
  [1, 54, 52, 1],
  [2, 4, 55, 2],
  [2, 55, 53, 2],
  [4, 54, 52, 4],
  [0, 4, 52, 0],
  [5, 55, 53, 5],
  [1, 5, 53, 1],
  [1, 55, 51, 1],
  [1, 3, 55, 1],
  [2, 56, 52, 2],
  [2, 4, 56, 2],
  [1, 3, 51, 1],
  [3, 55, 51, 3],
  [2, 4, 52, 2],
  [4, 56, 52, 4],
  [0, 54, 52, 0],
  [0, 4, 54, 0],
  [1, 55, 53, 1],
  [1, 5, 55, 1],
  [1, 4, 54, 51],
  [2, 5, 55, 52],
  [0, 3, 55, 52],
  [1, 4, 56, 53],
  [0, 4, 55, 51],
  [1, 5, 56, 52],
  [1, 3, 54, 52],
  [2, 4, 55, 53],
  [0, 3, 54, 51],
  [1, 4, 55, 52],
  [2, 5, 56, 53],
];

/** TERRAIN_TYPE_FLAGS rows 0..0x46 (retail 0x0048c7c8); bits 3-4 pick a triangle's half. */
const FLAGS: readonly number[] = [
  8, 0, 8, 0, 8, 0, 16, 24, 16, 24, 16, 24, 16, 24, 16, 24, 8, 0, 8, 0, 24, 16, 24, 16, 0, 8, 0, 8,
  16, 24, 16, 24, 0, 8, 0, 8, 8, 0, 8, 0, 24, 16, 24, 16, 8, 0, 8, 0, 16, 24, 16, 24, 0, 8, 0, 8,
  16, 24, 16, 24, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32,
];

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

const i8 = (v: number): number => (v << 24) >> 24;

/**
 * `terrain_plate_height` (0x00454460): one plate's height at a point inside its
 * cell, or null when the point lies in the other half of a triangle's cell.
 */
function plateHeight(
  sect: Uint8Array,
  base: number,
  type: number,
  fz: number,
  fx: number,
): number | null {
  if (type > TYPE_MAX) return null;
  const k = CORNERS[type];
  const a = i8(sect[base + k[0]]);
  const b = i8(sect[base + k[1]]);
  const c = i8(sect[base + k[2]]);
  let near: number;
  let far: number;
  if (type > 0x3b) {
    const d = i8(sect[base + k[3]]);
    near = (((b - a) * fz) >> 9) + a * 0x80;
    far = (((c - d) * fz) >> 9) + d * 0x80;
  } else {
    switch (FLAGS[type] >> 3) {
      case 0:
        if (fx + fz > 0x10000) return null;
        near = (((b - a) * fz) >> 9) + a * 0x80;
        far = (((b - c) * fz) >> 9) + c * 0x80;
        break;
      case 1:
        if (fx + fz < 0x10000) return null;
        near = (((a - c) * fz) >> 9) + c * 0x80;
        far = (((b - c) * fz) >> 9) + c * 0x80;
        break;
      case 2:
        if (fx < fz) return null;
        near = (((b - a) * fz) >> 9) + a * 0x80;
        far = (((b - c) * fz) >> 9) + c * 0x80;
        break;
      case 3:
        if (fz < fx) return null;
        near = (((b - a) * fz) >> 9) + a * 0x80;
        far = (((c - a) * fz) >> 9) + a * 0x80;
        break;
      default:
        return null;
    }
  }
  return (((far - near) * fx) >> 15) + near * 2;
}

/** The plate stack under a point, world units (raw position words), ascending. */
export type PlateStack = (xWu: number, zWu: number) => number[];

/** One plate under a point: its height (world units) and its material byte. */
export interface Plate {
  readonly h: number;
  /**
   * The plate's action-type byte, the surface's material: the Sect's four at
   * +0x370 picked by the plate word's bits 13-14 (RE fcop/trace.h; til_mesh.py
   * `polygon_action_types`). Bit 7 is the view trace's see-through
   * (`view_trace` 0x00445e80).
   */
  readonly material: number;
}

/** The plates under a point with their materials, ascending by height. */
export type PlateQuery = (xWu: number, zWu: number) => Plate[];

/** A Ctil `Sect`'s four material bytes, from its tag. */
const MATERIAL_OFFSET = 0x370;

/** The container's height query, as a function of a raw actor position. */
export function plateStackOf(container: Uint8Array): PlateStack {
  const plates = platesOf(container);
  return (x, z) => plates(x, z).map((p) => p.h);
}

/** plateStackOf, with each plate's material byte. */
export function platesOf(container: Uint8Array): PlateQuery {
  const res = containerIndex(container);
  const gridAt = res.get("ctpC:1") ?? [...res.entries()].find(([k]) => k.startsWith("ctpC:"))?.[1];
  if (!gridAt) throw new Error("no Cptc in the container");
  const grid = containerResource(container, gridAt);
  const word = (w: number): number => u32(grid, GRID_BASE + 4 * w);
  const width = word(GRID_WORD_WIDTH);
  const height = word(GRID_WORD_HEIGHT);
  const sects = new Map<number, { blob: Uint8Array; at: number } | null>();
  const sectionOf = (id: number): { blob: Uint8Array; at: number } | null => {
    if (sects.has(id)) return sects.get(id) ?? null;
    const at = res.get(`litC:${id}`);
    let s: { blob: Uint8Array; at: number } | null = null;
    if (at) {
      const blob = containerResource(container, at);
      for (let p = 0; p + 4 <= blob.length; p++) {
        if (
          blob[p] === 0x74 &&
          blob[p + 1] === 0x63 &&
          blob[p + 2] === 0x65 &&
          blob[p + 3] === 0x53
        ) {
          s = { blob, at: p };
          break;
        }
      }
    }
    sects.set(id, s);
    return s;
  };
  return (x, z) => {
    // 0x004545d0, but answering every covering plate, sorted, instead of one.
    if (z < 0 || x < 0) return [];
    const gx = x >> CELL_SHIFT;
    const gz = z >> CELL_SHIFT;
    if (gz >= width - 1 || gx >= height - 1) return [];
    const cellWord = word(GRID_WORD_CELLS + gx * width + gz);
    const s = sectionOf((cellWord >> 2) & 0x3fff);
    if (!s) return [];
    const sect = s.blob;
    const o = s.at;
    const u = (x >> SAMPLE_SHIFT) & 0xf;
    const v = (z >> SAMPLE_SHIFT) & 0xf;
    const cell = u * 16 + v;
    const index =
      sect[o + CELL_INDEX_OFFSET + cell * 2] | (sect[o + CELL_INDEX_OFFSET + cell * 2 + 1] << 8);
    let remaining = index & 0xf;
    let plate = o + PLATE_OFFSET + (index >> 4);
    const out: Plate[] = [];
    const fz = (z & 0x1fff) << 3;
    const fx = (x & 0x1fff) << 3;
    while (remaining > 0 && out.length < 16) {
      const w = u32(sect, plate);
      plate += 4;
      const type = (w >>> 15) & 0x7f;
      if (type > TYPE_MAX) break;
      const h = plateHeight(sect, o + (cell + 4 + u) * 3, type, fz, fx);
      if (h !== null) out.push({ h, material: sect[o + MATERIAL_OFFSET + ((w >>> 13) & 3)] });
      remaining--;
    }
    return out.sort((a, b) => a.h - b.h);
  };
}

/**
 * The height `terrain_height_at` answers for a record's selector (the remap
 * 0 -> topmost, 1 -> lowest, n -> (n-2)-th from the bottom), in metres; null
 * where the original answers 0 for want of a plate.
 */
export function selectedHeight(stack: readonly number[], selector: number): number | null {
  if (stack.length === 0) return null;
  let wu: number | undefined;
  if (selector === 0) wu = stack[stack.length - 1];
  else if (selector === 1) wu = stack[0];
  else wu = stack[selector - 2];
  return wu === undefined ? null : wu / 8192;
}

/**
 * The height `terrain_surface_at` (0x00453ef0) answers for a point at height
 * `y` metres, from the same plate stack: the highest plate strictly below
 * `y + 0x200` wu, else the lowest of the stack; null where there is none. It
 * drops a plate whose material byte carries bit 0x40 as well, which this stack
 * does not read — the one way the two can differ.
 */
export function surfaceHeight(stack: readonly number[], y: number): number | null {
  if (stack.length === 0) return null;
  const line = Math.round(y * 8192) + 0x200;
  let best: number | undefined;
  for (const h of stack) if (h < line && (best === undefined || h > best)) best = h;
  return (best ?? stack[0]) / 8192;
}
