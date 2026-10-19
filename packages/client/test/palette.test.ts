import { describe, expect, test } from "bun:test";
import { ARENA_PRESENTATION } from "../src/render/fcopPresentation.generated";
import { NEUTRAL_COLOR, TEAM_COLORS } from "../src/render/greybox";
import {
  BLUE_RAMP,
  NEUTRAL_RAMP,
  PALETTE,
  PALETTE_HEX,
  paletteHex,
  paletteIndex,
  RED_RAMP,
  SIDE_RAMPS,
  sideRamp,
  TEAM_RAMPS,
  teamRamp,
} from "../src/render/palette";
import { SIDE_BLUE, SIDE_RED, sideOfTeam, sideTextColour } from "../src/render/sides";

describe("palette data", () => {
  test("is ~32 well-formed sRGB entries", () => {
    expect(PALETTE.length).toBe(32);
    for (const { name, hex } of PALETTE) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(hex).toBeGreaterThanOrEqual(0);
      expect(hex).toBeLessThanOrEqual(0xffffff);
    }
  });

  test("names are unique and index-aligned with PALETTE_HEX", () => {
    const names = new Set(PALETTE.map((e) => e.name));
    expect(names.size).toBe(PALETTE.length);
    expect(PALETTE_HEX.length).toBe(PALETTE.length);
    for (let i = 0; i < PALETTE.length; i++) {
      expect(PALETTE_HEX[i]).toBe(PALETTE[i].hex);
      expect(paletteIndex(PALETTE[i].name)).toBe(i);
    }
  });

  test("paletteIndex rejects unknown names, including inherited Object keys", () => {
    expect(() => paletteIndex("no_such_color")).toThrow();
    // The lookup map is null-prototype, so these must not resolve to functions.
    expect(() => paletteIndex("toString")).toThrow();
    expect(() => paletteIndex("__proto__")).toThrow();
    expect(() => paletteIndex("constructor")).toThrow();
  });
});

describe("team ramps", () => {
  test("the original's sides: 1 red, 2 blue, each a 3-shade ramp keyed to named colors", () => {
    expect(SIDE_RAMPS[SIDE_RED]).toEqual({
      dark: paletteHex("red_dark"),
      base: paletteHex("red"),
      light: paletteHex("red_light"),
    });
    expect(SIDE_RAMPS[SIDE_BLUE]).toEqual({
      dark: paletteHex("blue_dark"),
      base: paletteHex("blue"),
      light: paletteHex("blue_light"),
    });
    expect(sideRamp(0)).toBe(NEUTRAL_RAMP);
    // TEAM_RAMPS is the orientation of the five arenas whose team 0 holds side 1.
    expect(TEAM_RAMPS).toEqual([RED_RAMP, BLUE_RAMP]);
    for (const ramp of [...TEAM_RAMPS, NEUTRAL_RAMP]) {
      expect(new Set([ramp.dark, ramp.base, ramp.light]).size).toBe(3);
    }
  });

  test("teamRamp falls back to neutral for out-of-range ids", () => {
    expect(teamRamp(0)).toBe(TEAM_RAMPS[0]);
    expect(teamRamp(1)).toBe(TEAM_RAMPS[1]);
    expect(teamRamp(2)).toBe(NEUTRAL_RAMP);
    expect(teamRamp(-1)).toBe(NEUTRAL_RAMP);
  });
});

describe("greybox colors derive from the palette", () => {
  test("team + neutral Three colors round-trip to the palette hex", () => {
    expect(TEAM_COLORS.length).toBe(2);
    expect(TEAM_COLORS[0].getHex()).toBe(paletteHex("red"));
    expect(TEAM_COLORS[1].getHex()).toBe(paletteHex("blue"));
    expect(NEUTRAL_COLOR.getHex()).toBe(paletteHex("neutral"));
  });
});

describe("team colour by the original's side (render/sides.ts)", () => {
  test("team 0 holds side 1 (red), team 1 side 2 (blue), on every arena", () => {
    for (const id of [
      "la-cantina",
      "urban-jungle",
      "proving-ground",
      "bug-hunt",
      "hollywood-keys",
      "venice-beach",
    ]) {
      expect(sideOfTeam(id, 0)).toBe(SIDE_RED);
      expect(sideOfTeam(id, 1)).toBe(SIDE_BLUE);
      // What gen:presentation read off the X1Alpha on the map's spawn 0.
      expect(ARENA_PRESENTATION[id].team0Side).toBe(SIDE_RED);
    }
  });

  test("the debug maps take team 0 as side 1; neutral has no side", () => {
    expect(sideOfTeam("test-128", 0)).toBe(SIDE_RED);
    expect(sideOfTeam("layered-test", 1)).toBe(SIDE_BLUE);
    expect(sideOfTeam("urban-jungle", -1)).toBe(0);
  });

  test("HUD text colours: side 1 light red (1), side 2 light blue (3)", () => {
    expect(sideTextColour(SIDE_RED)).toBe(1);
    expect(sideTextColour(SIDE_BLUE)).toBe(3);
  });
});
