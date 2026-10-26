// The original's coarse ground-height field per arena (gen:coarse,
// tools/generators/fcopCoarse.ts; RE prepare.c 0x00455e00), as stage 2 put it
// into each map: an upper envelope of that arena's own terrain, in the frame
// the sim reads it in.

import { describe, expect, it } from "bun:test";
import { getMapById } from "@metropolis/sim";
import { FCOP_ARENAS } from "../fcopArenas";

/** The highest surface at sim point (x, y): the ground or a deck over it. */
function top(map: ReturnType<typeof getMapById>, x: number, y: number): number {
  const s = map.size;
  if (x < 0 || y < 0 || x >= s || y >= s) return Number.NaN;
  let h = map.heights[y * s + x];
  for (let L = 0; L < map.layerHeights.length; L++) {
    if (map.layerMask[L][y * s + x]) h = Math.max(h, map.layerHeights[L][y * s + x]);
  }
  return h;
}

describe("the coarse field", () => {
  for (const arena of FCOP_ARENAS) {
    it(`${arena.mapId}: lies over its 2x2 sample blocks, ground and decks, in the sim's frame`, () => {
      const map = getMapById(arena.mapId);
      const f = map.coarse;
      expect(f).not.toBeNull();
      if (!f) return;
      // Field cell (R, C) is the 2x2 block of samples one before its origin:
      // the half-sample skew the original's query has (prepare.c).
      let over = 0;
      let n = 0;
      let off = 0;
      for (let R = 0; R < f.rows; R++) {
        for (let C = 0; C < f.stride; C++) {
          let hi = Number.NEGATIVE_INFINITY;
          for (const a of [0, 1]) {
            for (const b of [0, 1]) {
              const h = top(map, f.originX - 1 + 2 * C + b, f.originY - 1 + 2 * R + a);
              if (!Number.isNaN(h)) hi = Math.max(hi, h);
            }
          }
          if (hi === Number.NEGATIVE_INFINITY) continue;
          const v = f.data[R * f.stride + C] / 32;
          n++;
          if (v >= hi - 1 / 64) over++;
          off += Math.abs(v - hi);
        }
      }
      // Measured: 99.6-100 % at a mean 0.10-0.16 m; one row or column off,
      // or the axes swapped, falls to 67-95 % at 0.2-1.8 m.
      expect(over / n).toBeGreaterThan(0.99);
      expect(off / n).toBeLessThan(0.2);
    });
  }
});
