// Hardpoint model for the weapons screen — pure, so `bun test` can drive the
// cycling without a DOM.
//
// The original arms three hardpoints (Gun / Heavy / Special), shows only the
// weapon currently fitted to each, and cycles through a slot's options in
// place. Its own footer reads "Select Hardpoint: up/down", so the vertical axis
// picks the hardpoint and the horizontal one changes what is in it.

import { GUNS, HEAVIES, type Loadout, normalizeLoadout, SPECIALS } from "@metropolis/sim";
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
 * Slot lengths differ (4 guns, 6 heavies, 3 specials), so the modulo has to be
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
