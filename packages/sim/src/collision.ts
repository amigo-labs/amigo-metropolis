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

import type { MapData } from "./map";

/** Does the axis move x→nx (y held) cross a blocking vertical wall segment? */
export function crossesWallX(map: MapData, x: number, nx: number, y: number): boolean {
  if (map.wallsV.length === 0) return false;
  const inv = 1 / map.cellSize;
  const gi0 = Math.floor(x * inv);
  const gi1 = Math.floor(nx * inv);
  if (gi0 === gi1) return false; // stayed within one cell column
  const line = gi0 < gi1 ? gi1 : gi0; // the single line between the two cells
  let row = Math.floor(y * inv);
  if (row < 0) row = 0;
  if (row > map.size - 2) row = map.size - 2;
  return map.wallsV[row * map.size + line] !== 0;
}

/** Does the axis move y→ny (x held) cross a blocking horizontal wall segment? */
export function crossesWallY(map: MapData, x: number, y: number, ny: number): boolean {
  if (map.wallsH.length === 0) return false;
  const inv = 1 / map.cellSize;
  const gj0 = Math.floor(y * inv);
  const gj1 = Math.floor(ny * inv);
  if (gj0 === gj1) return false;
  const line = gj0 < gj1 ? gj1 : gj0;
  let col = Math.floor(x * inv);
  if (col < 0) col = 0;
  if (col > map.size - 2) col = map.size - 2;
  return map.wallsH[line * map.size + col] !== 0;
}
