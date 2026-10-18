// The running radar's rules (render/hud/radar.ts) against hud_radar.c as the RE
// states them (hud.json radar): the octagonal range, the heading-up rotation and
// scale, the markers by unit kind and side.

import { describe, expect, test } from "bun:test";
import { ARCHETYPE, TURRET_CAPTURABLE, TURRET_DEFENSE } from "@metropolis/sim";
import {
  ARENA_PRESENTATION,
  HUD,
  RADAR_PALETTE,
  UNIT_MARKERS,
} from "../src/render/fcopPresentation.generated";
import { markerOf, radarInRange, radarPlace } from "../src/render/hud/radar";
import { SIDE_BLUE, SIDE_RED } from "../src/render/sides";

const R = 0x25555;

describe("range (hud_radar_place_contact 0x0044a950)", () => {
  test("0x25555 world units, about 18.7 m", () => {
    expect(HUD.radar.rangeWu).toBe(R);
    expect(R / 8192).toBeCloseTo(18.67, 2);
  });

  test("along an axis the edge is the range itself", () => {
    expect(radarInRange(R, 0)).toBe(true);
    expect(radarInRange(R + 1, 0)).toBe(false);
    expect(radarInRange(0, -R)).toBe(true);
    expect(radarInRange(0, -R - 1)).toBe(false);
  });

  test("the octagon cuts the square's corners, close to the circle", () => {
    // Inside the square on both axes, outside the octagon.
    expect(radarInRange(R * 0.9, R * 0.9)).toBe(false);
    // On the diagonal the octagon reaches ~0.707 x the range, like a circle.
    const d = Math.trunc(R * 0.69);
    expect(radarInRange(d, d)).toBe(true);
    expect(radarInRange(Math.trunc(R * 0.73), Math.trunc(R * 0.73))).toBe(false);
  });
});

describe("rotation (heading-up, 1.5 / 4096 px a world unit)", () => {
  const out = new Float64Array(2);

  test("3 px a metre: the range sits 55 px out (hud.json range.radius_px640)", () => {
    expect(HUD.radar.pxPerWu * 8192).toBeCloseTo(3, 9);
    radarPlace(R / 8192, 0, 0, out);
    expect(out[1]).toBe(-55); // facing +x: a point 18.7 m ahead is 56 px up
  });

  test("ahead is up and the facing's right is right, whatever the facing", () => {
    for (const facing of [0, 0.7, Math.PI / 2, 2.5, -1.2]) {
      const fx = Math.cos(facing);
      const fy = Math.sin(facing);
      radarPlace(10 * fx, 10 * fy, facing, out);
      expect(out[0]).toBe(0);
      expect(out[1]).toBe(-30);
      // Right of the facing in the sim's (x, y): (-sin, cos), the camera's right.
      radarPlace(-10 * fy, 10 * fx, facing, out);
      expect(out[0]).toBe(30);
      expect(Math.abs(out[1])).toBe(0);
    }
  });
});

describe("markers (radar_markers.json)", () => {
  test("the X1-Alphas: red triangle on side 1, blue on side 2", () => {
    const red = markerOf(ARCHETYPE.AVATAR, SIDE_RED, 0);
    const blue = markerOf(ARCHETYPE.AVATAR, SIDE_BLUE, 0);
    expect(red).toBe(0x31);
    expect(blue).toBe(0x32);
    expect(red >> 5).toBe(1); // triangle
    expect(RADAR_PALETTE[red & 0x1f]).toEqual([255, 0, 0]);
    expect(RADAR_PALETTE[blue & 0x1f]).toEqual([0, 0, 255]);
    expect(markerOf(ARCHETYPE.WARDEN, SIDE_BLUE, 0)).toBe(UNIT_MARKERS.captain);
  });

  test("units: tanks and jets sprites, the Dreadnought and Flying Fortress diamonds", () => {
    expect(markerOf(ARCHETYPE.RUNNER, SIDE_RED, 0)).toBe(0x08);
    expect(markerOf(ARCHETYPE.RUNNER, SIDE_BLUE, 0)).toBe(0x04);
    expect(markerOf(ARCHETYPE.GUARDIAN, SIDE_RED, 0) >> 5).toBe(0);
    expect(markerOf(ARCHETYPE.JUGGERNAUT, SIDE_RED, 0)).toBe(0x48);
    expect(markerOf(ARCHETYPE.FORTRESS, SIDE_BLUE, 0)).toBe(0x44);
  });

  test("turrets: red / blue by side, green while neutral, the captor's once captured", () => {
    expect(markerOf(ARCHETYPE.TURRET, SIDE_RED, TURRET_DEFENSE)).toBe(0x01);
    expect(markerOf(ARCHETYPE.TURRET, SIDE_BLUE, TURRET_DEFENSE)).toBe(0x02);
    expect(markerOf(ARCHETYPE.TURRET, 0, TURRET_CAPTURABLE)).toBe(0x03);
    expect(markerOf(ARCHETYPE.TURRET, SIDE_BLUE, TURRET_CAPTURABLE)).toBe(0x02);
    expect(markerOf(ARCHETYPE.PROJECTILE, SIDE_RED, 0)).toBe(0);
  });

  test("every PA arena carries its outposts' diamonds and two base arrows", () => {
    for (const [id, a] of Object.entries(ARENA_PRESENTATION)) {
      expect(a.staticMarkers.filter((m) => m.marker === 0x53).length).toBe(4);
      const arrows = a.contacts.filter((c) => (c.shown & 1) !== 0);
      expect(arrows.map((c) => c.colour).sort()).toEqual([1, 2]);
      expect(a.contacts.filter((c) => (c.shown & 2) !== 0).length).toBe(4);
      expect(a.claimMarkers.length, id).toBe(16);
    }
  });

  test("palette entries from 23 blink (and 0 has no colour)", () => {
    expect(RADAR_PALETTE[0]).toBeNull();
    expect(RADAR_PALETTE.length).toBe(32);
  });
});
