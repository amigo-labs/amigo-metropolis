// The map screen's arrows (render/hud/mapOverlay.ts) against
// pause_map_draw_actor (RE game/frame/pause_map.c 0x004516e0): the model's 3DBB
// box 0, its +z face's middle the tip and its -z corners the base, placed by the
// actor's own matrix.

import { describe, expect, test } from "bun:test";
import { ARENA_PRESENTATION } from "../src/render/fcopPresentation.generated";
import { arrowCorners, boxFrame, morphFrame } from "../src/render/hud/mapOverlay";

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
      for (const frames of Object.values(a.boxes)) {
        expect(frames.length, id).toBeGreaterThan(0);
        for (const b of frames) {
          expect(b[2], id).toBeGreaterThan(0);
          expect(b[3], id).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("the box of the current frame (cobj_bbox_frame_box)", () => {
  test("entry f is frame f's; one entry stands for every frame", () => {
    const a = [0, 0, 1, 1] as const;
    const b = [0, 1, 2, 2] as const;
    expect(boxFrame([a, b], 0)).toBe(a);
    expect(boxFrame([a, b], 1)).toBe(b);
    expect(boxFrame([a], 5)).toBe(a);
  });

  test("the cloth steps a frame per period on the 300 Hz clock, from frame 0", () => {
    // Cobj 28, the outpost flag: six frames, 20 ticks each.
    expect(morphFrame(6, 20, 0)).toBe(0);
    expect(morphFrame(6, 20, 19)).toBe(0);
    expect(morphFrame(6, 20, 20)).toBe(1);
    expect(morphFrame(6, 20, 6 * 20)).toBe(0);
    expect(morphFrame(1, 1, 12345)).toBe(0);
  });

  test("every frame of the flag's cloth carries the one box 0", () => {
    // The 3DBB table holds box 0 of frames 0..5, then the pole's box 1: the
    // arrow does not move with the cloth.
    for (const [id, a] of Object.entries(ARENA_PRESENTATION)) {
      const flag = a.boxes[28];
      expect(flag?.length, id).toBe(1);
      expect(flag?.[0], id).toEqual([0, 0.3184, 0.0273, 0.3418]);
    }
  });
});
