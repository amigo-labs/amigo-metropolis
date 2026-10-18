// The HUD's rules, as the original's draw code states them (RE hud.json; the
// cited lines are src/game/frame/draw.c and hud_weapons.c). Pure functions over
// numbers, so they are tested without a DOM. The clock is the 300 Hz frame clock
// (DAT_00511ee4): bit 6 flips every 64 ticks, bit 7 every 128.

import { ARCHETYPE, SNAPSHOT_STRIDE } from "@metropolis/sim";

/** The armour gauge's full height, px at 640 x 480. */
export const GAUGE_PX = 96;
/** Points an outpost costs: the score flashes from here while one is left (draw.c:1430). */
export const OUTPOST_PRICE = 30;
/** Outposts per arena: the flash stops once all four are claimed. */
export const OUTPOSTS = 4;

/** hud_gauge_value: 96 x hp / max, rounded, floored at 0. */
export function gaugeValue(frac: number): number {
  const v = Math.round(GAUGE_PX * frac);
  return v < 0 ? 0 : v > GAUGE_PX ? GAUGE_PX : v;
}

/**
 * The gauge's colour ramp (draw.c:803-866): f = hp/max in 16.16;
 * r = 0x7f - (63 f >> 16), g = 0x1f + (96 f >> 16), b = 64 f >> 16, and the
 * submit doubles each byte (saturating). Writes the screen colour into `out`.
 */
export function gaugeRgb(frac: number, out: Int32Array | number[]): void {
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  // r's product is negated before the shift, so it rounds toward -infinity.
  out[0] = Math.min(255, 2 * (0x7f + Math.floor(-63 * f)));
  out[1] = Math.min(255, 2 * (0x1f + Math.floor(96 * f)));
  out[2] = Math.min(255, 2 * Math.floor(64 * f));
}

/** Below a third the gauge blinks: halved while the clock's low byte is past 0x7f. */
export function gaugeDimmed(frac: number, clock: number): boolean {
  return 3 * frac < 1 && (clock & 0xff) > 0x7f;
}

/**
 * The score's colour: the slot's own, or 9 (yellow) while it can afford an
 * outpost — 30 or more points, outposts left to claim — on the half of the clock
 * where bit 7 is set (hud.json score.alarm_rule).
 */
export function scoreColour(score: number, own: number, claimed: number, clock: number): number {
  return score >= OUTPOST_PRICE && claimed < OUTPOSTS && (clock & 0x80) !== 0 ? 9 : own;
}

/** The power-up magazine's count blinks 9 / 12 on clock bit 6 (hud_weapons.c). */
export function upperCountColour(clock: number): number {
  return (clock & 0x40) !== 0 ? 9 : 12;
}

/** A powered slot's icon is lit on the half of the clock where bit 6 is set. */
export function iconLit(powered: boolean, clock: number): boolean {
  return powered && (clock & 0x40) !== 0;
}

/**
 * State words 27/28 (slot 0) and 29/30 (slot 1): the slot's live tanks and live
 * jets. The match snapshot carries only a combined unit count, so they are
 * counted from the entity snapshot: tanks are RUNNER, jets GUARDIAN.
 * Writes [tanks, jets] into `out`.
 */
export function countTanksJets(
  snapshot: Float32Array,
  count: number,
  team: number,
  out: Int32Array,
): void {
  let tanks = 0;
  let jets = 0;
  for (let i = 0; i < count; i++) {
    const o = i * SNAPSHOT_STRIDE;
    if (snapshot[o + 2] !== team) continue;
    const a = snapshot[o + 1];
    if (a === ARCHETYPE.RUNNER) tanks++;
    else if (a === ARCHETYPE.GUARDIAN) jets++;
  }
  out[0] = tanks;
  out[1] = jets;
}

/** The snapshot record of entity `id` (dense id order: a binary search), or -1. */
export function snapshotIndexOf(snapshot: Float32Array, count: number, id: number): number {
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = snapshot[mid * SNAPSHOT_STRIDE];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
