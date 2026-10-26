// The Map Key's map screen (render/mapScreen.ts) against draw.c's pan as the RE
// states it (hud.json pause_map): which bits pan which way, the rate's ramp and
// reversal, Action re-centring, the window kept inside the world.

import { describe, expect, test } from "bun:test";
import {
  BTN_ACTION,
  BTN_BACK,
  BTN_FORWARD,
  BTN_GUN,
  BTN_TURN_LEFT,
  BTN_TURN_RIGHT,
  getMapById,
} from "@metropolis/sim";
import {
  createMapScreen,
  MAP_SAMPLES_X,
  MAP_SAMPLES_Y,
  mapBounds,
  mapCell,
  mapWindow,
  panMapScreen,
  toggleMapScreen,
} from "../src/render/mapScreen";

const WORLD = Float64Array.of(0, 1000, 0, 1000);

function opened(x = 500, y = 500) {
  const m = createMapScreen();
  toggleMapScreen(m, x, y);
  return m;
}

describe("the toggle", () => {
  test("opens on the X1 with the rates zeroed; again closes", () => {
    const m = createMapScreen();
    m.rateX = 99;
    toggleMapScreen(m, 12, 34);
    expect(m.open).toBe(true);
    expect([m.cx, m.cy, m.rateX, m.rateY]).toEqual([12, 34, 0, 0]);
    toggleMapScreen(m, 0, 0);
    expect(m.open).toBe(false);
  });
});

describe("the pan bits (draw.c:1577-1650)", () => {
  test("Turn Right / Left scroll toward +x / -x, Back / Forward toward +y / -y", () => {
    for (const [bit, axis, sign] of [
      [BTN_TURN_RIGHT, "cx", 1],
      [BTN_TURN_LEFT, "cx", -1],
      [BTN_BACK, "cy", 1],
      [BTN_FORWARD, "cy", -1],
    ] as const) {
      const m = opened();
      panMapScreen(m, bit, 10, 0, 0, WORLD, 16, 12);
      expect(Math.sign(m[axis] - 500)).toBe(sign);
      const other = axis === "cx" ? m.cy : m.cx;
      expect(other).toBe(500);
    }
  });

  test("other bits pan nothing; Action re-centres on the X1", () => {
    const m = opened();
    panMapScreen(m, BTN_GUN, 10, 0, 0, WORLD, 16, 12);
    expect([m.cx, m.cy]).toEqual([500, 500]);
    panMapScreen(m, BTN_TURN_RIGHT, 100, 0, 0, WORLD, 16, 12);
    expect(m.cx).toBeGreaterThan(500);
    panMapScreen(m, BTN_ACTION, 0, 321, 456, WORLD, 16, 12);
    expect([m.cx, m.cy]).toEqual([321, 456]);
  });

  test("a unit a tick to 0x200, then (dt x rate) << 2 world units a frame", () => {
    const m = opened();
    panMapScreen(m, BTN_TURN_RIGHT, 10, 0, 0, WORLD, 16, 12);
    expect(m.rateX).toBe(10);
    expect(m.cx - 500).toBeCloseTo((10 * 10 * 4) / 8192, 9);
    panMapScreen(m, BTN_TURN_RIGHT, 1000, 0, 0, WORLD, 16, 12);
    expect(m.rateX).toBe(512);
    // Saturated: 2048 wu a tick, 75 m/s.
    const before = m.cx;
    panMapScreen(m, BTN_TURN_RIGHT, 1, 0, 0, WORLD, 16, 12);
    expect(m.cx - before).toBeCloseTo(2048 / 8192, 9);
  });

  test("a reversal snaps to 0 first; a release stops at once", () => {
    const m = opened();
    panMapScreen(m, BTN_BACK, 50, 0, 0, WORLD, 16, 12);
    expect(m.rateY).toBe(50);
    panMapScreen(m, BTN_FORWARD, 5, 0, 0, WORLD, 16, 12);
    expect(m.rateY).toBe(-5);
    panMapScreen(m, 0, 5, 0, 0, WORLD, 16, 12);
    expect(m.rateY).toBe(0);
    // Both at once cancel.
    panMapScreen(m, BTN_TURN_LEFT | BTN_TURN_RIGHT, 5, 0, 0, WORLD, 16, 12);
    expect(m.rateX).toBe(0);
  });

  test("the window overhangs the world by at most 2 m (world_clamp_map_centre)", () => {
    const m = opened(5, 995);
    panMapScreen(m, 0, 1, 0, 0, WORLD, 16, 12);
    // Margins: the half less 0x4000 wu, 14 m across and 10 m down.
    expect([m.cx, m.cy]).toEqual([14, 990]);
    panMapScreen(m, BTN_TURN_LEFT | BTN_BACK, 1000, 0, 0, WORLD, 16, 12);
    expect([m.cx, m.cy]).toEqual([14, 990]);
  });

  test("a world narrower than the margins: the low bound wins below it, the high above", () => {
    const narrow = Float64Array.of(100, 120, 0, 1000);
    const m = opened(90, 500);
    panMapScreen(m, 0, 1, 0, 0, narrow, 16, 12);
    expect(m.cx).toBe(114);
    m.cx = 130;
    panMapScreen(m, 0, 1, 0, 0, narrow, 16, 12);
    expect(m.cx).toBe(106);
  });

  test("closed, nothing pans", () => {
    const m = createMapScreen();
    panMapScreen(m, BTN_TURN_RIGHT, 100, 0, 0, WORLD, 16, 12);
    expect(m.cx).toBe(0);
  });
});

describe("the window (pause_map terrain_window)", () => {
  test("32 x 24 samples at 20 px each on 640 x 480", () => {
    expect([MAP_SAMPLES_X, MAP_SAMPLES_Y]).toEqual([32, 24]);
    const w = new Float64Array(3);
    mapWindow(640, 480, w);
    expect([...w]).toEqual([16, 12, 20]);
  });

  test("a wide view shows more samples across at the same scale", () => {
    const w = new Float64Array(3);
    mapWindow(1920, 1080, w);
    expect(w[1]).toBe(12);
    expect(w[0]).toBeCloseTo(12 * (16 / 9), 9);
    expect(w[2]).toBe(45);
  });

  test("the overview maps the world onto 54 cells", () => {
    expect(mapCell(0, 200)).toBe(0);
    expect(mapCell(199.9, 200)).toBe(53);
    expect(mapCell(100, 200)).toBe(27);
    expect(mapCell(-5, 200)).toBe(0);
  });
});

describe("mapBounds", () => {
  test("an arena's world is the original's grid less its margin, in the sim's frame", () => {
    const out = new Float64Array(4);
    // Mp: GRDB width 13, height 15, margin 4; 16 m a cell, +16 m on x.
    mapBounds(getMapById("la-cantina"), out);
    expect([...out]).toEqual([80, 144, 64, 160]);
  });
});
