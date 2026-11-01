// The chase camera's line-of-sight test against the arena (render/camera.ts
// ChaseTrace) and the lock beam's end: the original's `terrain_trace_segment`
// with floors (RE src/game/frame/view_place.c view_trace, draw.c
// hud_draw_lock_beam), the sim's own transcription of it over the map's plates
// (@metropolis/sim traceLine; fcop-fidelity.md T1).
//
// A render-side query over the map's static plates -- it reads no sim state, and
// it carries its own trace scratch, never the sim's. The original lets a plate
// whose material byte carries bit 7 be seen through (`view_trace` 0x00445df0,
// RE M3-GD): the trace's result word carries that byte in bits 8..15, so bit 15
// is the flag. A first hit on such a plate, from the eye, is retraced from the
// anchor to it, and a second such hit is clear.
//
// A map with no plates (the test maps, the sandbox) samples its heightfield and
// decks instead, with nothing see-through.
//
// Allocation-free: the closure is built once per arena, outside the frame loop.

import {
  type MapData,
  newTraceScratch,
  sampleHeight,
  sampleLayerHeight,
  TRACE_PASSTHROUGH,
  traceHit,
  traceLine,
} from "@metropolis/sim";
import type { ChaseTrace } from "./camera";

/** Samples per metre along the segment. A cell is a metre; four catches a kerb. */
const SAMPLES_PER_M = 4;
/** Slack under the surface before a sample counts as inside it, m. */
const SKIN = 0.05;
/** The largest fraction a stopped line answers (1 is clear). */
const BLOCKED_MAX = 1 - 1e-6;

/**
 * The first blocked point on a segment over `map`'s ground and decks, as the
 * fraction of the segment (1 = clear). Three frame (x, height, sim y), metres.
 */
export type TerrainHit = (
  ax: number,
  ah: number,
  ay: number,
  ex: number,
  eh: number,
  ey: number,
) => number;

/**
 * The last blocked trace's hit (makeTerrainHit): where the line stopped,
 * three frame (x, height, sim y), and whether the plate it met is see-through.
 * Written by every blocked call; read straight after it.
 */
export const terrainHitAt = { x: 0, h: 0, y: 0, seeThrough: false };

export function makeTerrainHit(map: MapData): TerrainHit {
  if (map.trace !== null) return platesHit(map);
  return sampledHit(map);
}

/** makeTerrainHit over the original's plates: the trace with floors, its own scratch. */
function platesHit(map: MapData): TerrainHit {
  const scratch = newTraceScratch();
  return (ax, ah, ay, ex, eh, ey) => {
    const r = traceLine(map, scratch, ax, ay, ah, ex, ey, eh, 1);
    if (r === 0) return 1;
    terrainHitAt.x = traceHit.x;
    terrainHitAt.h = traceHit.h;
    terrainHitAt.y = traceHit.y;
    terrainHitAt.seeThrough = (r & TRACE_PASSTHROUGH) !== 0;
    const dx = ex - ax;
    const dh = eh - ah;
    const dy = ey - ay;
    const len2 = dx * dx + dh * dh + dy * dy;
    if (!(len2 > 0)) return 0;
    // Where it stopped along the segment. A floor reports its piece's upper end
    // (trace.c), which can be the segment's own end: a stopped line still
    // answers less than 1.
    const t = ((traceHit.x - ax) * dx + (traceHit.h - ah) * dh + (traceHit.y - ay) * dy) / len2;
    return t < 0 ? 0 : t < BLOCKED_MAX ? t : BLOCKED_MAX;
  };
}

/** makeTerrainHit by samples of a map with no plates: its heightfield and decks. */
function sampledHit(map: MapData): TerrainHit {
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
  /** Records a blocked sample at (x, h, y). */
  const blocked = (x: number, h: number, y: number): void => {
    terrainHitAt.x = x;
    terrainHitAt.h = h;
    terrainHitAt.y = y;
    terrainHitAt.seeThrough = false;
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
      if (h < sampleHeight(map, x, y) - SKIN) {
        blocked(x, h, y);
        return (s - 1) / n;
      }
      // A deck blocks a segment that passes through it between two samples.
      for (let k = 0; k < decks; k++) {
        if (!deckAt(k, x, y) || !deckAt(k, prevX, prevY)) continue;
        const d0 = prevH - sampleLayerHeight(map, k, prevX, prevY);
        const d1 = h - sampleLayerHeight(map, k, x, y);
        // A sample landing exactly on the deck counts as the crossing (else
        // that sample and the next both read 0 and the deck is missed).
        if ((d0 < 0 && d1 >= 0) || (d0 > 0 && d1 <= 0)) {
          blocked(x, h, y);
          return (s - 1) / n;
        }
      }
      prevX = x;
      prevY = y;
      prevH = h;
    }
    return 1;
  };
}

/**
 * The chase camera's trace, `view_trace`'s two passes (0x00445e78..0x00445ea2):
 * from the eye toward the anchor; a hit on a see-through surface retraces from
 * the anchor to that hit, and is clear when that one meets nothing or another
 * see-through surface. Blocked otherwise.
 */
export function makeTerrainTrace(map: MapData): ChaseTrace {
  const hit = makeTerrainHit(map);
  return (ax, ah, ay, ex, eh, ey) => {
    if (hit(ex, eh, ey, ax, ah, ay) >= 1) return false;
    if (!terrainHitAt.seeThrough) return true;
    if (hit(ax, ah, ay, terrainHitAt.x, terrainHitAt.h, terrainHitAt.y) >= 1) return false;
    return !terrainHitAt.seeThrough;
  };
}
