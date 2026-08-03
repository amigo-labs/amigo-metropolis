// Edge-blocker wall collision (architecture.md §2, FCOP arenas stage 2).
// Walls live ON grid lines, not in cells: wallsV[j*size+i] blocks ±x moves
// across the vertical line x = i*cellSize within cell row j; wallsH is the
// symmetric ±y twin. Both helpers slot into the existing axis-separated
// block-and-slide steppers (sim.ts avatar movement, units.ts).
//
// Determinism contract (CLAUDE.md hard rules): only + - * /, floor, integer
// compares and array reads — bit-exact on every engine. Every mover in the
// sim travels well under one cell per tick (max ~0.6 m vs cellSize ≥ 1), so
// an axis move crosses AT MOST one grid line; each helper checks exactly
// that line.
//
// The `length === 0` early-out is THE no-op invariant: wall-free maps
// (test-128, district-01) keep byte-identical hash sequences, proven by the
// golden replays regenerated with the SIM_VERSION 8 bump.
//
// LAYERS (issue #29). Every helper takes an optional trailing `layer`, and
// `layer === 0` (the default) runs the pre-existing code against map.wallsV/H
// with no extra work — a second no-op invariant, on the same shape resolveHeight
// already uses for heights. Only a map that ships per-deck lattices can reach the
// other branch, which today is la-cantina alone.

import type { MapData } from "./map";

/** The lattice a given layer collides against: layer 0 is the map's own pair. */
function latticeV(map: MapData, layer: number): Uint8Array {
  if (layer === 0 || map.layerWallsV.length === 0) return map.wallsV;
  const idx = layer - 1;
  return idx < map.layerWallsV.length ? map.layerWallsV[idx] : map.wallsV;
}

function latticeH(map: MapData, layer: number): Uint8Array {
  if (layer === 0 || map.layerWallsH.length === 0) return map.wallsH;
  const idx = layer - 1;
  return idx < map.layerWallsH.length ? map.layerWallsH[idx] : map.wallsH;
}

/** Does the axis move x→nx (y held) cross a blocking vertical wall segment? */
export function crossesWallX(map: MapData, x: number, nx: number, y: number, layer = 0): boolean {
  const walls = latticeV(map, layer);
  if (walls.length === 0) return false;
  const inv = 1 / map.cellSize;
  const gi0 = Math.floor(x * inv);
  const gi1 = Math.floor(nx * inv);
  if (gi0 === gi1) return false; // stayed within one cell column
  const line = gi0 < gi1 ? gi1 : gi0; // the single line between the two cells
  let row = Math.floor(y * inv);
  if (row < 0) row = 0;
  if (row > map.size - 2) row = map.size - 2;
  return walls[row * map.size + line] !== 0;
}

/** Does the axis move y→ny (x held) cross a blocking horizontal wall segment? */
export function crossesWallY(map: MapData, x: number, y: number, ny: number, layer = 0): boolean {
  const walls = latticeH(map, layer);
  if (walls.length === 0) return false;
  const inv = 1 / map.cellSize;
  const gj0 = Math.floor(y * inv);
  const gj1 = Math.floor(ny * inv);
  if (gj0 === gj1) return false;
  const line = gj0 < gj1 ? gj1 : gj0;
  let col = Math.floor(x * inv);
  if (col < 0) col = 0;
  if (col > map.size - 2) col = map.size - 2;
  return walls[line * map.size + col] !== 0;
}

/**
 * Line-of-sight test: does the segment (x0,y0)→(x1,y1) cross any wall?
 * Amanatides–Woo grid traversal over the wall lattice — every vertical line
 * crossing is checked against wallsV in the row it happens in, every
 * horizontal one against wallsH in its column. Only + - * /, floor, min/max
 * and compares (IEEE-exact); the step count is bounded by the cell distance,
 * so it terminates regardless of float edge cases.
 */
export function segmentBlocked(
  map: MapData,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  layer = 0,
): boolean {
  const wallsV = latticeV(map, layer);
  const wallsH = latticeH(map, layer);
  if (wallsV.length === 0 && wallsH.length === 0) return false;
  const s = map.size;
  const inv = 1 / map.cellSize;
  const maxCell = s - 2;
  const clampCell = (v: number): number => (v < 0 ? 0 : v > maxCell ? maxCell : v);
  let gx = clampCell(Math.floor(x0 * inv));
  let gy = clampCell(Math.floor(y0 * inv));
  const tx = clampCell(Math.floor(x1 * inv));
  const ty = clampCell(Math.floor(y1 * inv));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  // Parametric t of the next vertical/horizontal line crossing (Infinity when
  // the segment never advances on that axis — 1/0 is deterministic IEEE).
  const invDx = dx !== 0 ? 1 / dx : 0;
  const invDy = dy !== 0 ? 1 / dy : 0;
  let tMaxX = dx !== 0 ? ((gx + (stepX > 0 ? 1 : 0)) * map.cellSize - x0) * invDx : 2;
  let tMaxY = dy !== 0 ? ((gy + (stepY > 0 ? 1 : 0)) * map.cellSize - y0) * invDy : 2;
  const tDeltaX = dx !== 0 ? map.cellSize * invDx * stepX : 0;
  const tDeltaY = dy !== 0 ? map.cellSize * invDy * stepY : 0;
  let steps = Math.abs(tx - gx) + Math.abs(ty - gy);
  while (steps > 0) {
    steps -= 1;
    if (tMaxX <= tMaxY) {
      // Crossing the vertical line between gx and gx+stepX, in row gy.
      const line = gx + (stepX > 0 ? 1 : 0);
      if (wallsV[clampCell(gy) * s + line] !== 0) return true;
      gx += stepX;
      tMaxX += tDeltaX;
    } else {
      const line = gy + (stepY > 0 ? 1 : 0);
      if (wallsH[line * s + clampCell(gx)] !== 0) return true;
      gy += stepY;
      tMaxY += tDeltaY;
    }
  }
  return false;
}
