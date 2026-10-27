// The committed effect import (effects/fcopEffects.generated.ts, public/fx/)
// against its source and against itself. The generator reads an RE checkout;
// where there is one (tools/generators/reRepo.ts finds it) the committed files
// must be exactly what it writes. Everything else here holds without it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "../../../tools/generators/fcopEffects";
import { decodePng } from "../../../tools/generators/png";
import { findReRepo } from "../../../tools/generators/reRepo";
import { FCOP_ARENA_AUDIO, FCOP_PLAYER_WEAPONS } from "../src/audio/fcopAudio.generated";
import {
  FX_ARENAS,
  FX_BOLTS,
  FX_PARTICLES,
  FX_RECORDS,
  FX_ROW_MODELS,
  FX_TRAIL_ATLAS,
} from "../src/effects/fcopEffects.generated";
import { FXF_SUCCESSOR_AT_REPEAT_END, paletteLevel, widenWord } from "../src/effects/records";

const PUBLIC_FX = join(import.meta.dir, "..", "public", "fx");
const GENERATED = join(import.meta.dir, "..", "src", "effects", "fcopEffects.generated.ts");

describe("gen:fx", () => {
  const re = findReRepo();

  test.skipIf(re === null)("the committed files are what the generator writes", () => {
    const out = generate(re as string);
    expect(readFileSync(GENERATED, "utf8")).toBe(out.ts);
    for (const f of out.files) {
      const committed = new Uint8Array(readFileSync(f.path));
      expect(committed.length).toBe(f.bytes.length);
      expect(Buffer.compare(Buffer.from(committed), Buffer.from(f.bytes))).toBe(0);
    }
  });

  test("every arena's banks name records that exist, and every successor is there", () => {
    // Bar one pair: the Grenade's launch flashes 180 and 185 name successors
    // 181 and 186, slots no arena fills (the export's chain ends in a null
    // type there). An install of an empty slot draws nothing.
    const empty = new Set<string>();
    for (const [mapId, arena] of Object.entries(FX_ARENAS)) {
      for (const [b, bank] of arena.banks.entries()) {
        for (const [id, index] of Object.entries(bank)) {
          const rec = FX_RECORDS[index];
          expect(rec, `${mapId} ${id}`).toBeDefined();
          if (rec.next > 0 && bank[rec.next] === undefined) empty.add(`${b}:${id}->${rec.next}`);
        }
      }
    }
    expect([...empty].sort()).toEqual(["1:180->181", "1:185->186"]);
  });

  test("the chain agrees with the sound tables the audio already walks", () => {
    // Two exports of one simulation (pa_effects.py runs pa_sound_tables.py's):
    // every record the audio knows a successor for has the same successor and,
    // in sim ticks the way gen:sfx rounds them, the same delay.
    let compared = 0;
    for (const [mapId, arena] of Object.entries(FX_ARENAS)) {
      const audio = FCOP_ARENA_AUDIO[mapId];
      expect(audio, mapId).toBeDefined();
      if (!audio) continue;
      for (const bank of [0, 1] as const) {
        for (const [id, rec] of Object.entries(audio.effects[bank])) {
          const index = arena.banks[bank][Number(id)];
          if (index === undefined) continue;
          const fx = FX_RECORDS[index];
          if (rec.next === 0 && fx.next !== 0) {
            // The audio drops a bit-11 successor that can never fire.
            expect((fx.flags & FXF_SUCCESSOR_AT_REPEAT_END) !== 0).toBe(true);
            continue;
          }
          expect(fx.next, `${mapId} ${bank}:${id}`).toBe(rec.next);
          const delay =
            (fx.flags & FXF_SUCCESSOR_AT_REPEAT_END) !== 0
              ? Math.round((fx.repeats * fx.period) / 10)
              : Math.round(fx.delay / 10);
          expect(Math.max(0, delay), `${mapId} ${bank}:${id} delay`).toBe(rec.delay);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(300);
  });

  test("everything the audio raises has a record to draw", () => {
    for (const [mapId, arena] of Object.entries(FX_ARENAS)) {
      const audio = FCOP_ARENA_AUDIO[mapId];
      if (!audio) continue;
      const has = (bank: number, id: number) =>
        id <= 0 || arena.banks[bank][id] !== undefined || !audio.effects[bank][id];
      for (const row of audio.world) {
        expect(has(0, row.launchFx), `${mapId} launch ${row.launchFx}`).toBe(true);
        expect(has(0, row.impactFx), `${mapId} impact ${row.impactFx}`).toBe(true);
      }
      for (const w of Object.values(FCOP_PLAYER_WEAPONS)) {
        for (const blk of [w.a, w.b]) {
          expect(has(1, blk.launchFx), `${mapId} player launch ${blk.launchFx}`).toBe(true);
          expect(has(1, blk.impactFx), `${mapId} player impact ${blk.impactFx}`).toBe(true);
        }
      }
      for (const rows of Object.values(audio.deaths)) {
        for (const row of rows) {
          for (const id of [...row.groups, row.fallback]) {
            expect(has(row.bank, id), `${mapId} death ${row.bank}:${id}`).toBe(true);
          }
        }
      }
      for (const id of [3, 4, 9]) expect(has(1, id), `${mapId} mech ${id}`).toBe(true);
    }
  });

  test("the six arenas' world rows share their records (the export's own claim)", () => {
    const turret = FX_ARENAS["la-cantina"]?.banks[0][43];
    for (const arena of Object.values(FX_ARENAS)) expect(arena.banks[0][43]).toBe(turret);
  });
});

describe("the Cpyr atlas", () => {
  const image = decodePng(new Uint8Array(readFileSync(join(PUBLIC_FX, "particles.png"))));
  const meta = JSON.parse(readFileSync(join(PUBLIC_FX, "particles.json"), "utf8")) as {
    particles: { id: number; palette_base: number[] }[];
  };

  test("every sprite is drawn through its own palette", () => {
    // The atlas this replaced drew all eight through palette 0, so sprite 6 —
    // a cyan ring in its own palette — came out red. Each opaque texel here
    // must be one of its own particle's 255 colours at level 0x20, widened.
    for (const p of FX_PARTICLES) {
      const pal = meta.particles.find((q) => q.id === p.id)?.palette_base;
      expect(pal, `palette of ${p.id}`).toBeDefined();
      if (!pal) continue;
      const colours = new Set(
        pal.slice(1).map((w) => {
          const [r, g, b] = widenWord(paletteLevel(w, 0x20));
          return (r << 16) | (g << 8) | b;
        }),
      );
      let opaque = 0;
      for (let y = 0; y < p.h; y++) {
        for (let x = 0; x < p.w; x++) {
          const o = ((p.y + y) * image.width + p.x + x) * 4;
          if (image.pixels[o + 3] === 0) continue;
          opaque++;
          const c = (image.pixels[o] << 16) | (image.pixels[o + 1] << 8) | image.pixels[o + 2];
          expect(colours.has(c), `particle ${p.id} texel (${x}, ${y})`).toBe(true);
        }
      }
      expect(opaque, `particle ${p.id} has paint`).toBeGreaterThan(0);
    }
  });

  test("the ids are where the roles were misread", () => {
    // Orange fire 8 / 11 / 1, grey smoke 5 / 3 / 10, cyan 6 / 7: the mean colour
    // of each sprite's opaque texels says which family it is.
    const mean = (id: number): [number, number, number] => {
      const p = FX_PARTICLES.find((q) => q.id === id);
      if (!p) throw new Error(String(id));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = 0; y < p.h; y++) {
        for (let x = 0; x < p.w; x++) {
          const o = ((p.y + y) * image.width + p.x + x) * 4;
          if (image.pixels[o + 3] === 0) continue;
          r += image.pixels[o];
          g += image.pixels[o + 1];
          b += image.pixels[o + 2];
          n++;
        }
      }
      return [r / n, g / n, b / n];
    };
    for (const id of [8, 11, 1]) {
      const [r, , b] = mean(id);
      expect(r, `fire ${id}`).toBeGreaterThan(b * 2);
    }
    for (const id of [5, 3, 10]) {
      const [r, g, b] = mean(id);
      expect(Math.max(r, g, b) - Math.min(r, g, b), `smoke ${id}`).toBeLessThan(24);
    }
    for (const id of [6, 7]) {
      const [r, g, b] = mean(id);
      expect(Math.min(g, b), `cyan ${id}`).toBeGreaterThan(r * 1.5);
    }
  });
});

describe("the palette level rule", () => {
  test("level 0x20 is the word itself, bit 15 is kept, channels cap at 31", () => {
    for (let w = 0; w < 0x10000; w += 97) expect(paletteLevel(w, 0x20)).toBe(w);
    expect(paletteLevel(0xffff, 0)).toBe(0x8000);
    expect(paletteLevel(0x7fff, 63)).toBe(0x7fff);
    // One channel by hand: c = 10 at level 16 is (160 + 16) >> 5 = 5.
    expect(paletteLevel(10 << 10, 16)).toBe(5 << 10);
  });

  test("widening is (c << 3) | (c >> 2)", () => {
    expect(widenWord(0x7fff)).toEqual([255, 255, 255]);
    expect(widenWord(1 << 10)).toEqual([8, 0, 0]);
    expect(widenWord(16)).toEqual([0, 0, 132]);
  });
});

describe("trails.png", () => {
  test("one row per arena, the size FX_TRAIL_ATLAS states", () => {
    const image = decodePng(new Uint8Array(readFileSync(join(PUBLIC_FX, "trails.png"))));
    expect(image.width).toBe(FX_TRAIL_ATLAS.width);
    expect(image.height).toBe(FX_TRAIL_ATLAS.height);
    expect(FX_TRAIL_ATLAS.height / FX_TRAIL_ATLAS.rowHeight).toBe(Object.keys(FX_ARENAS).length);
    for (const arena of Object.values(FX_ARENAS)) {
      // The trail rect is a soft bar: its middle column carries light.
      const x = Math.floor(FX_TRAIL_ATLAS.trail.w / 2);
      const o = ((arena.trailRow * FX_TRAIL_ATLAS.rowHeight + 32) * image.width + x) * 4;
      expect(image.pixels[o] + image.pixels[o + 1] + image.pixels[o + 2]).toBeGreaterThan(0);
    }
  });
});

describe("the bolts", () => {
  test("rows 1, 3 and 6 are line facers; 4, 8 and 9 wear models", () => {
    expect(Object.keys(FX_BOLTS).map(Number)).toEqual([1, 3, 6]);
    expect(Object.keys(FX_ROW_MODELS).map(Number)).toEqual([4, 8, 9]);
    // Cobj 12 and 53: one line, 0x38 model units wide each side, 1.025 m long.
    for (const row of [1, 6]) {
      const [line] = FX_BOLTS[row];
      expect(FX_BOLTS[row].length).toBe(1);
      expect(line.half0).toBe(0x38 / 512);
      expect(line.half1).toBe(0x38 / 512);
      expect(line.z1 - line.z0).toBeCloseTo(1.025, 3);
      expect(line.rgb).toEqual([0x80, 0x80, 0x80]);
    }
    // Cobj 14: a white core and a blue halo (face colour 0, 0, 0x60), tapered.
    const [core, halo] = FX_BOLTS[3];
    expect(core.rgb).toEqual([0x80, 0x80, 0x80]);
    expect(halo.rgb).toEqual([0, 0, 0x60]);
    expect(core.half1).toBeGreaterThan(core.half0);
    expect(halo.half0).toBeGreaterThan(core.half0);
  });

  test("each face's texels sit in the row's bolt crop, and the head is bright", () => {
    const image = decodePng(new Uint8Array(readFileSync(join(PUBLIC_FX, "trails.png"))));
    const texel = (row: number, u: number, v: number) => {
      const o = ((row * FX_TRAIL_ATLAS.rowHeight + v) * image.width + u) * 4;
      return image.pixels[o] + image.pixels[o + 1] + image.pixels[o + 2];
    };
    for (const lines of Object.values(FX_BOLTS)) {
      for (const l of lines) {
        for (let i = 0; i < 8; i += 2) {
          expect(l.uv[i]).toBeGreaterThanOrEqual(64);
          expect(l.uv[i]).toBeLessThan(FX_TRAIL_ATLAS.width);
          expect(l.uv[i + 1]).toBeLessThan(FX_TRAIL_ATLAS.rowHeight);
        }
      }
    }
    // The red bolt (row 1): end 1, the round's nose, is the bright head on every
    // arena's tex10; end 0 its fading tail.
    const [red] = FX_BOLTS[1];
    const midV = (red.uv[1] + red.uv[3]) >> 1;
    for (const arena of Object.values(FX_ARENAS)) {
      const head = texel(arena.trailRow, red.uv[6] + 4, midV);
      const tail = texel(arena.trailRow, red.uv[0] - 4, midV);
      expect(head).toBeGreaterThan(tail);
    }
  });
});
