// Normalize: fit a bounding box on the ground plane, remap to the unit square
// [0,1]², then snap to a coarse grid. This is the guardrail boundary (PLAN.md
// §2, §6.2): once a point passes through here, absolute world geometry is gone
// and only relative, quantized position survives.
//
// Non-uniform fit is deliberate: x and y are each scaled to fill [0,1]. The
// output preserves relations and topology, NOT the map's true aspect ratio —
// exactly the point, since an aspect-preserving fit leaks a real proportion.
//
// The fit is computed once from the NET nodes and REUSED for ACT actors, so
// nodes and actors land in the same frame and snapping is meaningful.
//
// Pure and deterministic: same input → byte-identical output.

import type { RawPoint, Vec2 } from "./types";

/** The affine fit from raw ground coords to the unit square. */
export interface Fit {
  readonly minX: number;
  readonly spanX: number;
  readonly minY: number;
  readonly spanY: number;
}

export interface Normalized {
  /** Quantized positions in [0,1]², parallel to the input array. */
  readonly positions: readonly Vec2[];
  /** Ids parallel to `positions`, preserved from the input. */
  readonly ids: readonly string[];
  /** The fit used, so other point sets can be mapped into the same frame. */
  readonly fit: Fit;
}

/** Snap a unit-interval value to the grid, clamped to [0,1]. */
export function quantize(value: number, grid: number): number {
  const snapped = Math.round(value * grid) / grid;
  if (snapped < 0) return 0;
  if (snapped > 1) return 1;
  return snapped;
}

/** Compute the bounding-box fit for a set of points. */
export function computeFit(points: readonly RawPoint[]): Fit {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.gx < minX) minX = p.gx;
    if (p.gx > maxX) maxX = p.gx;
    if (p.gy < minY) minY = p.gy;
    if (p.gy > maxY) maxY = p.gy;
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, spanX: 0, minY: 0, spanY: 0 };
  }
  return { minX, spanX: maxX - minX, minY, spanY: maxY - minY };
}

/** Map one raw ground point into the quantized unit square via a fit. */
export function applyFit(fit: Fit, gx: number, gy: number, grid: number): Vec2 {
  const nx = fit.spanX > 0 ? (gx - fit.minX) / fit.spanX : 0;
  const ny = fit.spanY > 0 ? (gy - fit.minY) / fit.spanY : 0;
  return [quantize(nx, grid), quantize(ny, grid)];
}

/** Fit `points` to the unit square and quantize. */
export function normalize(points: readonly RawPoint[], grid: number, fit?: Fit): Normalized {
  const usedFit = fit ?? computeFit(points);
  const positions: Vec2[] = [];
  const ids: string[] = [];
  for (const p of points) {
    positions.push(applyFit(usedFit, p.gx, p.gy, grid));
    ids.push(p.id);
  }
  return { positions, ids, fit: usedFit };
}

/** Euclidean distance between two normalized positions. */
export function dist(a: Vec2, b: Vec2): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}
