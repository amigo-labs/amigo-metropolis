// The map screen's arrows (render/hud/mapOverlay.ts) against
// pause_map_draw_actor (RE game/frame/pause_map.c 0x004516e0): the model's 3DBB
// box 0, its +z face's middle the tip and its -z corners the base, placed by the
// actor's own matrix.

import { describe, expect, test } from "bun:test";
import { ARENA_PRESENTATION } from "../src/render/fcopPresentation.generated";
import { arrowCorners } from "../src/render/hud/mapOverlay";

describe("the arrow (pause_map_draw_actor)", () => {
  const out = new Float64Array(6);

  test("yaw 0 points along the map's +x, the box's x across it", () => {
    // A console's box: half 0.5 across, 0.5586 along, centre 0.0527 ahead.
    arrowCorners(100, 50, 0, 0, 0.0527, 0.5, 0.5586, 20, out);
    expect(out[0]).toBeCloseTo(100 + 20 * (0.0527 + 0.5586), 9);
    expect(out[1]).toBeCloseTo(50, 9);
    expect(out[2]).toBeCloseTo(100 + 20 * (0.0527 - 0.5586), 9);
    expect(out[3]).toBeCloseTo(50 + 20 * 0.5, 9);
    expect(out[4]).toBeCloseTo(out[2], 9);
    expect(out[5]).toBeCloseTo(50 - 20 * 0.5, 9);
  });

  test("a record angle of a quarter turn points along the map's +y", () => {
    arrowCorners(0, 0, Math.PI / 2, 0, 0, 0.1, 1, 10, out);
    expect(out[0]).toBeCloseTo(0, 9);
    expect(out[1]).toBeCloseTo(10, 9);
    // The base's two corners straddle the axis by the half width.
    expect(Math.abs(out[2] - out[4])).toBeCloseTo(2, 9);
  });

  test("every placed marker and every pickup has its model's box", () => {
    for (const [id, a] of Object.entries(ARENA_PRESENTATION)) {
      expect(Object.keys(a.boxes).length, id).toBeGreaterThan(2);
      for (const b of Object.values(a.boxes)) {
        expect(b[2], id).toBeGreaterThan(0);
        expect(b[3], id).toBeGreaterThan(0);
      }
    }
  });
});
