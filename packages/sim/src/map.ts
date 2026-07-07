// Map data: heightfield grid + water mask (architecture.md §2). The same
// heights drive sim ground-snap/slope checks AND the render mesh — single
// source of truth. Real maps ship as JSON in packages/sim/maps/ from Phase 1;
// Phase 0 uses the procedurally generated (but fully deterministic) test map.

import { clamp, cosLUT, lerp, sinLUT } from "./simMath";

export interface MapData {
  readonly id: string;
  /** Vertices per side (the grid is size × size, so (size-1)² cells). */
  readonly size: number;
  /** Meters per cell edge. */
  readonly cellSize: number;
  /** Row-major heights, index = row * size + col. */
  readonly heights: Float32Array;
  /** 1 = water (hover only, Phase 1+). Row-major like heights. */
  readonly waterMask: Uint8Array;
}

/** Playable extent in meters along one axis: [0, extent] on both axes. */
export function worldExtent(map: MapData): number {
  return (map.size - 1) * map.cellSize;
}

/**
 * Bilinear height sample at world position (x, y). Coordinates are clamped
 * to the map, so out-of-bounds queries return edge heights. Uses only
 * + - * /, floor, min, max — bit-exact on every engine.
 */
export function sampleHeight(map: MapData, x: number, y: number): number {
  const max = map.size - 1;
  const gx = clamp(x / map.cellSize, 0, max);
  const gy = clamp(y / map.cellSize, 0, max);
  let i0 = Math.floor(gx);
  let j0 = Math.floor(gy);
  if (i0 > max - 1) i0 = max - 1;
  if (j0 > max - 1) j0 = max - 1;
  const fx = gx - i0;
  const fy = gy - j0;
  const s = map.size;
  const row0 = j0 * s + i0;
  const row1 = row0 + s;
  const h0 = lerp(map.heights[row0], map.heights[row0 + 1], fx);
  const h1 = lerp(map.heights[row1], map.heights[row1 + 1], fx);
  return lerp(h0, h1, fy);
}

/** Map registry: resolves the mapId stored in replays/net handshakes. */
export function getMapById(id: string): MapData {
  if (id === TEST_MAP_ID) return createTestMap();
  throw new Error(`unknown map id: ${id}`);
}

export const TEST_MAP_ID = "test-128";
export const TEST_MAP_SIZE = 128;
export const TEST_MAP_CELL_SIZE = 2;

/**
 * Deterministic rolling-hills test map (Phase 0). Built exclusively from
 * simMath LUT trig, so every peer generates bit-identical heights — pinned
 * by a hash test.
 */
export function createTestMap(): MapData {
  const size = TEST_MAP_SIZE;
  const heights = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const h =
        4 * sinLUT(i * 0.1) * sinLUT(j * 0.13) +
        2 * sinLUT((i + j) * 0.045) +
        1.2 * sinLUT(i * 0.31) * cosLUT(j * 0.22);
      heights[j * size + i] = h;
    }
  }
  return {
    id: TEST_MAP_ID,
    size,
    cellSize: TEST_MAP_CELL_SIZE,
    heights,
    waterMask: new Uint8Array(size * size),
  };
}
