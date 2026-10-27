// The chase camera's line-of-sight test against the arena (render/camera.ts
// ChaseTrace), standing in for the original's `terrain_trace_segment` with floors
// (RE src/game/frame/view_place.c view_trace).
//
// A render-side query over the map's static heightfield and decks, the same data
// the terrain meshes are built from — it reads no sim state. The original lets
// a plate whose material byte carries bit 7 be seen through (`view_trace`
// 0x00445df0, RE M3-GD): a first hit on one, from the eye, is retraced from the
// anchor to it, and a second such hit is clear. Which of the sim's surfaces are
// such plates is gen:viewterrain's (render/viewTerrain.generated.ts): la-cantina
// has 249 deck cells of them (its catwalks), the other arenas none the trace
// meets (proving-ground's and bug-hunt's four are wall plates, which the sim's
// map does not carry as surfaces).
//
// Allocation-free: the closure is built once per arena, outside the frame loop.

import { type MapData, sampleHeight, sampleLayerHeight } from "@metropolis/sim";
import type { ChaseTrace } from "./camera";
import { VIEW_TERRAIN } from "./viewTerrain.generated";

/** Samples per metre along the segment. A cell is a metre; four catches a kerb. */
const SAMPLES_PER_M = 4;
/** Slack under the surface before a sample counts as inside it, m. */
const SKIN = 0.05;

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
 * The last blocked trace's hit (makeTerrainHit): the first sample inside a
 * surface, three frame (x, height, sim y), and whether that surface is
 * see-through there. Written by every blocked call; read straight after it.
 */
export const terrainHitAt = { x: 0, h: 0, y: 0, seeThrough: false };

/**
 * Per surface (0 the ground, k + 1 deck k), a byte per cell: 1 where the surface
 * is a see-through plate (render/viewTerrain.generated.ts); null without any.
 */
function seeThroughOf(map: MapData): Uint8Array[] | null {
  const t = VIEW_TERRAIN[map.id];
  if (!t || t.seeThrough.every((cells) => cells.length === 0)) return null;
  const cells = map.size - 1;
  return t.seeThrough.map((list) => {
    const b = new Uint8Array(cells * cells);
    for (const i of list) b[i] = 1;
    return b;
  });
}

export function makeTerrainHit(map: MapData): TerrainHit {
  const decks = map.layerHeights.length;
  const see = seeThroughOf(map);
  const cells = map.size - 1;
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
  /** Records a blocked sample at (x, h, y) on surface `k` (0 ground, k + 1 deck k). */
  const blocked = (x: number, h: number, y: number, k: number): void => {
    terrainHitAt.x = x;
    terrainHitAt.h = h;
    terrainHitAt.y = y;
    let seeThrough = false;
    if (see !== null && k < see.length) {
      let i = Math.floor(x / cell);
      let j = Math.floor(y / cell);
      i = i < 0 ? 0 : i >= cells ? cells - 1 : i;
      j = j < 0 ? 0 : j >= cells ? cells - 1 : j;
      seeThrough = see[k][j * cells + i] === 1;
    }
    terrainHitAt.seeThrough = seeThrough;
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
        blocked(x, h, y, 0);
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
          blocked(x, h, y, k + 1);
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
