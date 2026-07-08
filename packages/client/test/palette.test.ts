import { describe, expect, test } from "bun:test";
import { NEUTRAL_COLOR, TEAM_COLORS } from "../src/render/greybox";
import {
  NEUTRAL_RAMP,
  PALETTE,
  PALETTE_HEX,
  PROJECTILE_HEX,
  paletteHex,
  paletteIndex,
  TEAM_RAMPS,
  teamRamp,
} from "../src/render/palette";

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

  test("paletteIndex rejects unknown names", () => {
    expect(() => paletteIndex("no_such_color")).toThrow();
  });
});

describe("team ramps", () => {
  test("two teams, each a 3-shade ramp keyed to named colors", () => {
    expect(TEAM_RAMPS.length).toBe(2);
    expect(TEAM_RAMPS[0]).toEqual({
      dark: paletteHex("blue_dark"),
      base: paletteHex("blue"),
      light: paletteHex("blue_light"),
    });
    expect(TEAM_RAMPS[1]).toEqual({
      dark: paletteHex("red_dark"),
      base: paletteHex("red"),
      light: paletteHex("red_light"),
    });
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

describe("projectile tints", () => {
  test("four kinds, primary tracer is white", () => {
    expect(PROJECTILE_HEX.length).toBe(4);
    expect(PROJECTILE_HEX[0]).toBe(paletteHex("muzzle"));
    expect(PROJECTILE_HEX[0]).toBe(0xffffff);
    expect(PROJECTILE_HEX[3]).toBe(paletteHex("warden_bomb"));
  });
});

describe("greybox colors derive from the palette", () => {
  test("team + neutral Three colors round-trip to the palette hex", () => {
    expect(TEAM_COLORS.length).toBe(2);
    expect(TEAM_COLORS[0].getHex()).toBe(paletteHex("blue"));
    expect(TEAM_COLORS[1].getHex()).toBe(paletteHex("red"));
    expect(NEUTRAL_COLOR.getHex()).toBe(paletteHex("neutral"));
  });
});

describe("committed .pal artifact stays in sync", () => {
  test("assets/palette/metropolis.pal matches the palette data", async () => {
    const url = new URL("../../../assets/palette/metropolis.pal", import.meta.url);
    const text = await Bun.file(url).text();
    const lines = text.split("\n");
    expect(lines[0]).toBe("JASC-PAL");
    expect(lines[1]).toBe("0100");
    expect(lines[2]).toBe(String(PALETTE.length));
    for (let i = 0; i < PALETTE.length; i++) {
      const hex = PALETTE[i].hex;
      const expected = `${(hex >> 16) & 0xff} ${(hex >> 8) & 0xff} ${hex & 0xff}`;
      expect(lines[3 + i]).toBe(expected);
    }
  });
});
