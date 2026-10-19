// The screen flash (render/hud/screenFlash.ts) against `mission_flash_near`
// 0x00405c40, `mission_draw_hud` 0x004075b0 and `hud_flash_strip` 0x00407650
// (RE docs/formats/effects.md "Screen effects", tables.json rules.screen_flash).
// In Precinct Assault no weapon or death starts the one flashing record, so the
// strip is held here rather than in a match.

import { describe, expect, test } from "bun:test";
import { FX_RECORDS } from "../src/effects/fcopEffects.generated";
import { FXF_SCREEN_FLASH, type FxFlash } from "../src/effects/records";
import {
  armScreenFlash,
  createScreenFlash,
  flashGrey,
  flashLevelAt,
  type ScreenFlash,
  stepScreenFlash,
} from "../src/render/hud/screenFlash";

/** GlblData 0:78's flash, as the export gives it. */
const FLASH: FxFlash = { level: 0x168, fullWithin: 0x6000, zeroAt: 0x1c800 };

/** A stand-in for the strip's element: what the step writes, counted. */
function fakeStrip(): { flash: ScreenFlash; writes: () => number; style: Record<string, string> } {
  let writes = 0;
  const style: Record<string, string> = {};
  const proxy = new Proxy(style, {
    set(t, k, v) {
      writes++;
      t[k as string] = v;
      return true;
    },
  });
  const el = { style: proxy } as unknown as HTMLElement;
  return { flash: { level: 0, clock: Number.NaN, drawn: 0, el }, writes: () => writes, style };
}

describe("mission_flash_near: the level by distance", () => {
  test("0x168 within 0x6000, one less per 0x100 beyond, 0 from 0x1c800", () => {
    expect(flashLevelAt(FLASH, 0)).toBe(0x168);
    expect(flashLevelAt(FLASH, 0x5fff)).toBe(0x168);
    expect(flashLevelAt(FLASH, 0x6000)).toBe(0x168);
    expect(flashLevelAt(FLASH, 0x6100)).toBe(0x167);
    expect(flashLevelAt(FLASH, 0x60ff)).toBe(0x168);
    expect(flashLevelAt(FLASH, 0x1c7ff)).toBe(1);
    expect(flashLevelAt(FLASH, FLASH.zeroAt)).toBe(0);
    expect(flashLevelAt(FLASH, 0x40000)).toBe(0);
  });

  test("sets the level, replacing a running flash, never adding to it", () => {
    const f = createScreenFlash(null);
    armScreenFlash(f, FLASH, 0);
    expect(f.level).toBe(0x168);
    armScreenFlash(f, FLASH, 0x6000 + 0x100 * 100);
    expect(f.level).toBe(0x168 - 100);
    armScreenFlash(f, FLASH, 0x30000);
    expect(f.level).toBe(0);
  });

  test("every record with +0x32 bit 5 carries the export's flash, and only those", () => {
    for (const rec of FX_RECORDS) {
      if ((rec.flags & FXF_SCREEN_FLASH) !== 0) expect(rec.flash).toEqual(FLASH);
      else expect(rec.flash).toBeUndefined();
    }
  });
});

describe("mission_draw_hud: the strip", () => {
  test("adds (min(level, 0xff) >> 1) doubled in r, g and b", () => {
    expect(flashGrey(0)).toBe(0);
    expect(flashGrey(-3)).toBe(0);
    expect(flashGrey(1)).toBe(0);
    expect(flashGrey(2)).toBe(2);
    expect(flashGrey(0xff)).toBe(254);
    expect(flashGrey(0x168)).toBe(254);
  });

  test("a full flash shows 254 for 70 ticks and is gone after 240", () => {
    const f = createScreenFlash(null);
    stepScreenFlash(f, 1000, false);
    armScreenFlash(f, FLASH, 0);
    let full = 0;
    let lit = 0;
    // Frames of the original's delta of 8.
    for (let t = 8; t <= 400; t += 8) {
      stepScreenFlash(f, 1000 + t, false);
      if (f.drawn === 254) full = t;
      if (f.drawn > 0) lit = t;
    }
    // 0x168 - 1.5 t >= 0xff while t <= 70; 0 at t = 240.
    expect(full).toBe(64);
    expect(lit).toBe(232);
    expect(f.level).toBe(0);
  });

  test("is frozen while the slot's down timer runs", () => {
    const f = createScreenFlash(null);
    stepScreenFlash(f, 0, false);
    armScreenFlash(f, FLASH, 0);
    stepScreenFlash(f, 100, true);
    expect(f.level).toBe(0x168);
    stepScreenFlash(f, 110, false);
    expect(f.level).toBe(0x168 - 15);
  });

  test("writes the element only when the grey changes, and hides it at 0", () => {
    const s = fakeStrip();
    stepScreenFlash(s.flash, 0, false);
    expect(s.writes()).toBe(0);
    armScreenFlash(s.flash, FLASH, 0);
    stepScreenFlash(s.flash, 1, false);
    expect(s.style.backgroundColor).toBe("rgb(254,254,254)");
    expect(s.style.display).toBe("block");
    const after = s.writes();
    // Still at 0xff or more: the same grey, nothing written.
    for (let t = 2; t < 60; t++) stepScreenFlash(s.flash, t, false);
    expect(s.writes()).toBe(after);
    for (let t = 60; t <= 300; t++) stepScreenFlash(s.flash, t, false);
    expect(s.style.display).toBe("none");
    expect(s.flash.drawn).toBe(0);
  });
});
