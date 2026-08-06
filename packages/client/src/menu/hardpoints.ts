// Hardpoint model for the title-console loadout strip — pure, so `bun test`
// can drive the cycling without a DOM.
//
// Three hardpoints (Gun / Heavy / Special); ◀ ▶ on the strip cycles each
// slot's catalog in place.

import {
  GUNS,
  HEAVIES,
  type Loadout,
  normalizeLoadout,
  resolveLoadout,
  SPECIALS,
  type WeaponDef,
} from "@metropolis/sim";
import type { Hardpoint } from "./state";

export interface HardpointSpec {
  readonly key: keyof Loadout;
  /** Slot name as the original prints it. */
  readonly label: string;
  readonly list: typeof GUNS;
}

/** Index order is the original's: Gun, Heavy, Special, top to bottom. */
export const HARDPOINTS: readonly HardpointSpec[] = [
  { key: "gun", label: "Gun", list: GUNS },
  { key: "heavy", label: "Heavy", list: HEAVIES },
  { key: "special", label: "Special", list: SPECIALS },
];

/**
 * Cycles the weapon fitted to one hardpoint by `delta`, wrapping within that
 * slot. Wrapping is right here and clamping is right for menu navigation: this
 * is a value cycler with no visible list to run off the end of, so stopping at
 * the last option would just look broken.
 *
 * Slot lengths differ (4 guns, 3 heavies, 3 specials), so the modulo has to be
 * per slot — a shared length would silently pick the wrong weapon.
 */
export function cycleHardpoint(loadout: Loadout, hardpoint: Hardpoint, delta: number): Loadout {
  const spec = HARDPOINTS[hardpoint];
  const n = spec.list.length;
  const current = loadout[spec.key];
  // JS % keeps the sign of the dividend, so a left-step from index 0 needs the
  // extra + n to land on the last option instead of -1.
  const next = (((current + delta) % n) + n) % n;
  return normalizeLoadout({ ...loadout, [spec.key]: next });
}

/** Moves the hardpoint selection, clamped — up from Gun stays on Gun. */
export function stepHardpoint(hardpoint: Hardpoint, delta: number): Hardpoint {
  const next = hardpoint + delta;
  if (next < 0) return 0;
  if (next > 2) return 2;
  return next as Hardpoint;
}

/** "Powered Mini-Gun · Rocket Launcher · Mortar" for the rail's summary line. */
export function loadoutSummary(loadout: Loadout): string {
  return HARDPOINTS.map((h) => h.list[loadout[h.key]].name).join(" · ");
}

/** Rate (green) and damage (red) bar fractions for the title-menu loadout strip.
 *  Scaled within the weapon's own slot — same relative idea as the original's
 *  front-end panels, using this catalog's numbers rather than 55ths. */
export function weaponBarFractions(
  weapon: WeaponDef,
  list: readonly WeaponDef[],
): { rate: number; damage: number } {
  let maxDamage = 1;
  let minCooldown = Number.POSITIVE_INFINITY;
  for (const w of list) {
    if (w.damage > maxDamage) maxDamage = w.damage;
    const cd = w.cooldownTicks > 0 ? w.cooldownTicks : 1;
    if (cd < minCooldown) minCooldown = cd;
  }
  if (!Number.isFinite(minCooldown)) minCooldown = 1;
  const cd = weapon.cooldownTicks > 0 ? weapon.cooldownTicks : 1;
  // Faster fire → longer green bar. Clamp so a zero/bogus catalog entry still
  // paints a visible trough rather than NaN styles.
  const rate = Math.min(1, Math.max(0, minCooldown / cd));
  const damage = Math.min(1, Math.max(0, weapon.damage / maxDamage));
  return { rate, damage };
}

/** The three fitted weapons, in hardpoint order, for the bottom strip. */
export function fittedWeapons(loadout: Loadout): readonly WeaponDef[] {
  const kit = resolveLoadout(loadout);
  return [kit.gun, kit.heavy, kit.special];
}
