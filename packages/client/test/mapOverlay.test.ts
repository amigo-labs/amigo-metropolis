// The map screen's arrows (render/hud/mapOverlay.ts) against
// pause_map_draw_actor (RE game/frame/pause_map.c 0x004516e0): the model's 3DBB
// box 0 of the actor's current frame, its +z face's middle the tip and its -z
// corners the base, placed by the actor's own matrix.

import { describe, expect, test } from "bun:test";
import { ARENA_PRESENTATION } from "../src/render/fcopPresentation.generated";
import { arrowCorners, boxFrame, clothFrame, labelPen } from "../src/render/hud/mapOverlay";

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

  test("the cloth steps a frame per period of engine ticks, from frame 0", () => {
    // Cobj 28, the outpost flag: six frames, 20 ticks each.
    expect(clothFrame(6, 20, 0)).toBe(0);
    expect(clothFrame(6, 20, 19)).toBe(0);
    expect(clothFrame(6, 20, 20)).toBe(1);
    expect(clothFrame(6, 20, 6 * 20)).toBe(0);
    expect(clothFrame(1, 1, 12345)).toBe(0);
  });

  test("every frame of the flag's cloth carries the one box 0", () => {
    // RE bboxes.json: Cobj 28's table is two boxes of six frames, box 0 alike in
    // all six, so the arrow does not move with the cloth (nor in the original).
    for (const [id, a] of Object.entries(ARENA_PRESENTATION)) {
      const flag = a.boxes[28];
      expect(flag?.length, id).toBe(1);
      expect(flag?.[0], id).toEqual([0, 0.3184, 0.0273, 0.3418]);
    }
  });
});

describe('the player\'s "P" (0x00451995..0x00451a0a)', () => {
  test("four times the arrow's centroid less 8 px, at 640 x 480", () => {
    const out = new Float64Array(2);
    // The original: cfnt_text_draw(sum / 6 - 4) in 320 x 240, doubled; the
    // sum of three vertices in quarter pixels is 12 x the centroid in pixels.
    const cx = 100;
    const cy = 60;
    const sumQ = 3 * 4 * cx;
    const sumQy = 3 * 4 * cy;
    labelPen(cx, cy, 1, out);
    expect(out[0]).toBe(2 * (sumQ / 6 - 4));
    expect(out[1]).toBe(2 * (sumQy / 6 - 4));
  });

  test("scaled with the view", () => {
    const out = new Float64Array(2);
    labelPen(200, 120, 2, out);
    expect(out[0]).toBe(784);
    expect(out[1]).toBe(464);
  });
});
