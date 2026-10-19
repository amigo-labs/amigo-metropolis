// The screen flash (fcop-fidelity.md E19): an effect record whose +0x32 has
// bit 5 calls `mission_flash_near` (0x00405c40) at install, which SETS — not
// raises — each viewport's level by its player's octagonal distance from the
// effect's point: the record's `flash.level` (0x168) within `fullWithin`
// (0x6000 world units), one less per 0x100 beyond, 0 from `zeroAt` (0x1c800)
// on, replacing whatever flash was running. `mission_draw_hud` (0x004075b0)
// takes `delta / 2 + delta` off it each frame — 1.5 a tick — frozen while
// the slot's down timer runs, and while it stays positive draws
// `min(level, 0xff) >> 1` in r, g and b as one strip the viewport wide and the
// full height (`hud_flash_strip` 0x00407650: op 0x3c, the colour doubled by
// the submitter, blend byte 2, additive). A full flash adds a grey of 254 for
// its first 70 ticks and lasts 240.
//
// Drawn as a raw-DOM HUD element rather than a quad in the 3D pass: the strip
// is a HUD record (it is submitted by the HUD's own pass, at sort depth 0, in
// screen space and the viewport's rect), so it lives with the HUD, which is
// already sized to the viewport and is never touched by the bloom composer.
// The grey is added to the frame below through `mix-blend-mode: plus-lighter`.
// Write-on-change: the element's colour is rewritten only when the drawn grey
// changes (at most once per 1.33 ticks), and it is hidden at 0.
//
// In Precinct Assault the one flashing record, GlblData's 0:78, is raised only
// as 0:83's reap effect, which no PA weapon or death starts — so, as in the
// original, the flash practically never shows.

import type { FxFlash } from "../../effects/records";

/** `level -= delta / 2 + delta` a frame: 1.5 levels an engine tick. */
export const FLASH_DECAY_PER_TICK = 1.5;
/** What the strip can show: min(level, 0xff). */
const FLASH_DRAW_CAP = 0xff;

/** `mission_flash_arm`'s level for a player `distWu` (octagonal) from the effect. */
export function flashLevelAt(flash: FxFlash, distWu: number): number {
  if (distWu < flash.fullWithin) return flash.level;
  const level = flash.level - ((distWu - flash.fullWithin) >> 8);
  return level > 0 ? level : 0;
}

/** The grey byte the strip adds, 0..254: `(min(level, 0xff) >> 1)` doubled by the submitter. */
export function flashGrey(level: number): number {
  if (level <= 0) return 0;
  const l = level > FLASH_DRAW_CAP ? FLASH_DRAW_CAP : Math.floor(level);
  return (l >> 1) * 2;
}

export interface ScreenFlash {
  /** The viewport's level (DAT_00511f6c + 2 * slot). */
  level: number;
  /** The 300 Hz clock the level was last stepped at; NaN before the first step. */
  clock: number;
  /** The grey last written to the element (write-on-change). */
  drawn: number;
  readonly el: HTMLElement | null;
}

export function createScreenFlash(parent: HTMLElement | null): ScreenFlash {
  let el: HTMLElement | null = null;
  if (parent) {
    el = document.createElement("div");
    el.className = "mhud-flash";
    el.style.display = "none";
    parent.appendChild(el);
  }
  return { level: 0, clock: Number.NaN, drawn: 0, el };
}

/** `mission_flash_near` for this viewport: the level set, whatever was running. */
export function armScreenFlash(f: ScreenFlash, flash: FxFlash, distWu: number): void {
  f.level = flashLevelAt(flash, distWu);
}

/**
 * The HUD pass at the 300 Hz `clock`: the level spent by the ticks since the
 * last pass (none while `down`, the slot's down timer running), then the strip
 * rewritten if its grey changed.
 */
export function stepScreenFlash(f: ScreenFlash, clock: number, down: boolean): void {
  const ticks = Number.isNaN(f.clock) ? 0 : clock - f.clock;
  f.clock = clock;
  if (!down && ticks > 0 && f.level > 0) {
    f.level -= FLASH_DECAY_PER_TICK * ticks;
    if (f.level < 0) f.level = 0;
  }
  const grey = flashGrey(f.level);
  if (grey === f.drawn) return;
  f.drawn = grey;
  const el = f.el;
  if (!el) return;
  if (grey === 0) {
    el.style.display = "none";
    return;
  }
  el.style.backgroundColor = GREY[grey];
  el.style.display = "block";
}

/** The strip's colours, built once: index = the grey byte. */
const GREY: readonly string[] = Array.from({ length: 256 }, (_, g) => `rgb(${g},${g},${g})`);
