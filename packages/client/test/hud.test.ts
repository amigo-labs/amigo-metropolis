// The HUD's layout scaling and rules (render/hud/hudLayout.ts, hudRules.ts)
// against the original's 640 x 480 layout and draw code (RE hud.json).

import { describe, expect, test } from "bun:test";
import { ARCHETYPE, SNAPSHOT_STRIDE } from "@metropolis/sim";
import { HUD } from "../src/render/fcopPresentation.generated";
import { hudScale, type PlacedRect, pixelMultiple, placeRect } from "../src/render/hud/hudLayout";
import {
  countTanksJets,
  gaugeDimmed,
  gaugeRgb,
  gaugeValue,
  iconLit,
  scoreColour,
  snapshotIndexOf,
  upperCountColour,
} from "../src/render/hud/hudRules";

const out: PlacedRect = { left: 0, top: 0, width: 0, height: 0 };

describe("layout: the 640 x 480 screen on any window", () => {
  test("at 640 x 480 every rect is the original's", () => {
    const [x, y, w, h] = HUD.score.plate;
    placeRect(x, y, w, h, 640, 480, out);
    expect(out).toEqual({ left: 574, top: 4, width: 44, height: 20 });
    placeRect(10, 340, 16, 96, 640, 480, out);
    expect(out).toEqual({ left: 10, top: 340, width: 16, height: 96 });
  });

  test("4:3 at 1280 x 960 doubles everything", () => {
    expect(hudScale(1280, 960)).toBe(2);
    placeRect(4, 4, 112, 112, 1280, 960, out);
    expect(out).toEqual({ left: 8, top: 8, width: 224, height: 224 });
    placeRect(614, 340, 16, 96, 1280, 960, out);
    expect(out).toEqual({ left: 1228, top: 680, width: 32, height: 192 });
  });

  test("16:9 scales by height; the right half anchors to the right edge", () => {
    const s = hudScale(1920, 1080);
    expect(s).toBe(2.25);
    // The radar keeps the top-left corner.
    placeRect(4, 4, 112, 112, 1920, 1080, out);
    expect(out.left).toBeCloseTo(9, 6);
    expect(out.width).toBeCloseTo(252, 6);
    // The score plate keeps its 22-unit gap to the right edge.
    placeRect(574, 4, 44, 20, 1920, 1080, out);
    expect(out.left + out.width).toBeCloseTo(1920 - 22 * s, 6);
    // The weapon icons keep their bottom-left places.
    placeRect(48, 440, 32, 32, 1920, 1080, out);
    expect(out.left).toBeCloseTo(108, 6);
    expect(out.top + out.height).toBeCloseTo(1080 - 8 * s, 6);
  });

  test("a narrow window scales by width; the bottom half anchors to the bottom", () => {
    const s = hudScale(640, 1000);
    expect(s).toBe(1);
    placeRect(48, 440, 32, 32, 640, 1000, out);
    expect(out.top).toBe(1000 - 40);
    placeRect(574, 4, 44, 20, 640, 1000, out);
    expect(out.top).toBe(4);
  });

  test("canvases draw at whole multiples of the original's pixels", () => {
    expect(pixelMultiple(0.6)).toBe(1);
    expect(pixelMultiple(1.5)).toBe(2);
    expect(pixelMultiple(2.25)).toBe(2);
  });
});

describe("the armour gauge (draw.c:803-866)", () => {
  test("96 px for full health, floored at 0", () => {
    expect(gaugeValue(1)).toBe(96);
    expect(gaugeValue(0.5)).toBe(48);
    expect(gaugeValue(-0.2)).toBe(0);
  });

  test("the ramp runs from (254, 62, 0) empty to (128, 254, 128) full", () => {
    const rgb = [0, 0, 0];
    gaugeRgb(0, rgb);
    expect(rgb).toEqual([254, 62, 0]);
    gaugeRgb(1, rgb);
    expect(rgb).toEqual([128, 254, 128]);
  });

  test("below a third it blinks on the clock's low byte", () => {
    expect(gaugeDimmed(0.3, 0x80)).toBe(true);
    expect(gaugeDimmed(0.3, 0x7f)).toBe(false);
    expect(gaugeDimmed(0.4, 0x80)).toBe(false);
  });
});

describe("the readouts", () => {
  test("the score flashes yellow from 30 points while an outpost is left", () => {
    expect(scoreColour(30, 1, 0, 0x80)).toBe(9);
    expect(scoreColour(30, 1, 0, 0x7f)).toBe(1);
    expect(scoreColour(29, 1, 0, 0x80)).toBe(1);
    expect(scoreColour(99, 3, 4, 0x80)).toBe(3);
  });

  test("a power-up count blinks 9 / 12 and its icon lights on bit 6", () => {
    expect(upperCountColour(0x40)).toBe(9);
    expect(upperCountColour(0)).toBe(12);
    expect(iconLit(true, 0x40)).toBe(true);
    expect(iconLit(true, 0)).toBe(false);
    expect(iconLit(false, 0x40)).toBe(false);
  });

  test("tanks and jets are counted per team from the entity snapshot", () => {
    const rows = [
      [3, ARCHETYPE.RUNNER, 0],
      [4, ARCHETYPE.RUNNER, 1],
      [5, ARCHETYPE.GUARDIAN, 0],
      [6, ARCHETYPE.FORTRESS, 0],
      [7, ARCHETYPE.RUNNER, 0],
      [9, ARCHETYPE.JUGGERNAUT, 0],
    ];
    const snap = new Float32Array(rows.length * SNAPSHOT_STRIDE);
    for (let i = 0; i < rows.length; i++) snap.set(rows[i], i * SNAPSHOT_STRIDE);
    const counts = new Int32Array(2);
    countTanksJets(snap, rows.length, 0, counts);
    expect([...counts]).toEqual([2, 1]);
    countTanksJets(snap, rows.length, 1, counts);
    expect([...counts]).toEqual([1, 0]);
    expect(snapshotIndexOf(snap, rows.length, 7)).toBe(4);
    expect(snapshotIndexOf(snap, rows.length, 8)).toBe(-1);
  });
});
