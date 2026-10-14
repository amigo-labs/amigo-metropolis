// The chase camera's line-of-sight test against the arena (render/camera.ts
// ChaseTrace), standing in for the original's `terrain_trace_segment` with floors
// (RE src/game/frame/view_place.c view_trace).
//
// A render-side query over the map's static heightfield and decks, the same data
// the terrain meshes are built from — it reads no sim state. The original also
// lets surfaces with material bit 7 see through; Metropolis' maps carry no
// material codes, so every surface blocks.
//
// Allocation-free: the closure is built once per arena, outside the frame loop.

import { type MapData, sampleHeight, sampleLayerHeight } from "@metropolis/sim";
import type { ChaseTrace } from "./camera";

/** Samples per metre along the segment. A cell is a metre; four catches a kerb. */
const SAMPLES_PER_M = 4;
/** Slack under the surface before a sample counts as inside it, m. */
const SKIN = 0.05;

/** A trace over `map`'s ground and decks, three frame (x, height, sim y), metres. */
export function makeTerrainTrace(map: MapData): ChaseTrace {
  const decks = map.layerHeights.length;
  const size = map.size;
  const cell = map.cellSize;
  const max = size - 1;
  /** Whether deck `k` is present at the vertex nearest (x, y). */
  const deckAt = (k: number, x: number, y: number): boolean => {
    let i = Math.round(x / cell);
    let j = Math.round(y / cell);
    i = i < 0 ? 0 : i > max ? max : i;
    j = j < 0 ? 0 : j > max ? max : j;
    return map.layerMask[k][j * size + i] === 1;
  };
  return (ax, ah, ay, ex, eh, ey) => {
    const dx = ex - ax;
    const dh = eh - ah;
    const dy = ey - ay;
    const len = Math.sqrt(dx * dx + dh * dh + dy * dy);
    const n = Math.max(2, Math.ceil(len * SAMPLES_PER_M));
    let prevX = ax;
    let prevY = ay;
    let prevH = ah;
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      const x = ax + dx * t;
      const h = ah + dh * t;
      const y = ay + dy * t;
      if (h < sampleHeight(map, x, y) - SKIN) return true;
      // A deck blocks a segment that passes through it between two samples.
      for (let k = 0; k < decks; k++) {
        if (!deckAt(k, x, y) || !deckAt(k, prevX, prevY)) continue;
        const d0 = prevH - sampleLayerHeight(map, k, prevX, prevY);
        const d1 = h - sampleLayerHeight(map, k, x, y);
        if ((d0 < 0 && d1 > 0) || (d0 > 0 && d1 < 0)) return true;
      }
      prevX = x;
      prevY = y;
      prevH = h;
    }
    return false;
  };
}
