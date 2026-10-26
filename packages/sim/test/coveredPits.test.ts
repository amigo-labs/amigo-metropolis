// urban-jungle's covered pits (fcop-fidelity.md P16, SIM_VERSION 99): a pit
// roofed by a grate level with the floor around it. The original's walker
// stands on the highest plate below it (RE terrain_surface_at 0x00453ef0) and
// never leaves the grate; until 99 the sim's ground was the pit floor at the
// pit's rim points, so the cells beside a pit sloped into it and a mech walking
// on slid under the grate and fell in. Stage 1 (convert.ts coverPits) lifts the
// ground onto the grate.

import { describe, expect, it } from "bun:test";
import { getMapById, sampleHeight, URBAN_JUNGLE_ID } from "../src/map";
import { resolveWalker } from "../src/units";

/**
 * The fourteen covered runs of points stage 1 finds on Conft, [x0, y0, x1, y1]
 * inclusive: twelve grates on the ring, and the two sunken outpost pads.
 */
const PITS: readonly (readonly [number, number, number, number])[] = [
  [151, 117, 156, 123],
  [84, 117, 89, 123],
  [131, 122, 135, 126],
  [105, 114, 109, 118],
  [131, 117, 135, 120],
  [105, 120, 109, 123],
  [131, 113, 135, 115],
  [105, 125, 109, 127],
  [123, 105, 126, 107],
  [119, 132, 121, 135],
  [119, 105, 121, 108],
  [114, 133, 117, 135],
  [123, 131, 126, 133],
  [114, 107, 117, 109],
];

/** The walker's lowest height on a straight walk, its height carried as the stepper carries it. */
function lowestOnWalk(ax: number, ay: number, bx: number, by: number): number {
  const map = getMapById(URBAN_JUNGLE_ID);
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 8);
  let h = resolveWalker(map, ax, ay, sampleHeight(map, ax, ay)).height;
  let lowest = h;
  for (let s = 1; s <= steps; s++) {
    const f = s / steps;
    h = resolveWalker(map, ax + (bx - ax) * f, ay + (by - ay) * f, h).height;
    if (h < lowest) lowest = h;
  }
  return lowest;
}

describe("urban-jungle's covered pits", () => {
  for (const [x0, y0, x1, y1] of PITS) {
    it(`a walker crosses the grate at (${x0}..${x1}, ${y0}..${y1}) and stays on it`, () => {
      const map = getMapById(URBAN_JUNGLE_ID);
      // The floor around the pit: the lowest point on the ring just outside it.
      let floor = Number.POSITIVE_INFINITY;
      for (let y = y0 - 1; y <= y1 + 1; y++) {
        for (let x = x0 - 1; x <= x1 + 1; x++) {
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
          floor = Math.min(floor, map.heights[y * map.size + x]);
        }
      }
      const mx = Math.floor((x0 + x1) / 2) + 0.5;
      const my = Math.floor((y0 + y1) / 2) + 0.5;
      for (const [ax, ay, bx, by] of [
        [x0 - 1, my, x1 + 1, my],
        [mx, y0 - 1, mx, y1 + 1],
      ]) {
        // The pits were 1.2 m deep on the ring and 0.37 m under the pads.
        expect(lowestOnWalk(ax, ay, bx, by)).toBeGreaterThan(floor - 0.1);
      }
    });
  }
});
