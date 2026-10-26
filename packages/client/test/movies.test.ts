// The original's movies (menu/frontend/movie.ts, movies.generated.ts; RE
// docs/formats/movies.md): the volume, the rectangles, and that every movie the
// front end plays was imported.

import { describe, expect, test } from "bun:test";
import { FE_PA_MAPS } from "../src/menu/frontend/frontendData.generated";
import {
  MOVIE_BOX_FULL,
  movieBoxHelp,
  movieCentibels,
  movieGain,
  movieSource,
} from "../src/menu/frontend/movie";
import { FE_MOVIE_BASE, FE_MOVIES } from "../src/menu/frontend/movies.generated";

describe("the Movies slider's volume (movie_play 0x00408a09..0x00408a53)", () => {
  test("0 is silence, 127 full, the default 63 -8.40 dB, 1 -16.53 dB", () => {
    expect(movieCentibels(0)).toBe(-10000);
    expect(movieCentibels(127)).toBe(0);
    expect(movieCentibels(63)).toBe(-840);
    expect(movieCentibels(1)).toBe(-1653);
    expect(movieGain(0)).toBe(0);
    expect(movieGain(127)).toBe(1);
    expect(movieGain(63)).toBeCloseTo(10 ** (-840 / 2000), 12);
  });

  test("C's truncating divisions, as the imul magic computes them, for every level", () => {
    const s32 = (x: number): number => x | 0;
    // 0x00408a1e..0x00408a53 with BigInt for the 64-bit products.
    const asm = (level: number): number => {
      if (level === 0) return -10000;
      const ecx = s32(level * 10000);
      let edx = Number((BigInt(ecx) * BigInt(s32(0x81020409))) >> 32n);
      edx = s32(edx + ecx) >> 6;
      edx = s32(edx + (edx >>> 31));
      const att = s32(10000 - edx);
      const q = Number((BigInt(att) * BigInt(s32(0xd5555555))) >> 32n);
      return s32(q + (q >>> 31));
    };
    for (let l = 0; l < 128; l++) expect(movieCentibels(l)).toBe(asm(l));
  });

  test("monotonic in the level", () => {
    for (let l = 1; l < 128; l++) expect(movieGain(l)).toBeGreaterThan(movieGain(l - 1));
  });
});

describe("the rectangles", () => {
  test("HELP / BRIEFING: (0x40, 0x1e) 512 x 288, four pixels left under FullScreen", () => {
    expect(movieBoxHelp(false)).toEqual({ left: 64, top: 30, width: 512, height: 288 });
    expect(movieBoxHelp(true)).toEqual({ left: 60, top: 30, width: 512, height: 288 });
  });

  test("the boot, the film strip and a finished map: (0, 41) 640 x 398", () => {
    expect(MOVIE_BOX_FULL).toEqual({ left: 0, top: 41, width: 640, height: 398 });
  });
});

describe("the import", () => {
  test("all 27 originals, each an AV1 + AAC MP4 under /movies/", () => {
    expect(Object.keys(FE_MOVIES)).toHaveLength(27);
    for (const [name, m] of Object.entries(FE_MOVIES)) {
      expect(m.source.name).toBe(name);
      expect(m.file).toBe(name.replace(/\.mpg$/, ".mp4"));
      expect(m.type).toMatch(/^video\/mp4; codecs="av01\.0\.\d\dM\.08, mp4a\.40\.2"$/);
      expect(m.fps).toBe(30);
      expect(m.bytes).toBeLessThan(m.source.bytes);
    }
  });

  test("every movie a Precinct Assault session plays is there", () => {
    const played = new Set(["ea_logo.mpg", "intro.mpg", "multibrf.mpg"]);
    for (const row of FE_PA_MAPS) {
      played.add(row.briefing);
      played.add(row.postMovie);
    }
    for (const name of played) {
      expect(movieSource(name)).toEqual({
        url: `${FE_MOVIE_BASE}${FE_MOVIES[name].file}`,
        type: FE_MOVIES[name].type,
      });
    }
    expect(movieSource("nope.mpg")).toBeNull();
  });
});
