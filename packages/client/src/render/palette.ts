// The one shared game palette (assets.md §3): ~32 sRGB colors authored in-house
// (CC0). It is the SINGLE SOURCE OF TRUTH for every in-game color — the greybox
// renderer, base structures and terrain all pull from here instead of inlining
// hex literals, so a palette change ripples everywhere at once.
//
// Team colors are a swap-able ramp of three shades (dark / base / light) per
// team, exactly as the spec calls for. Pure data — no Three, no DOM — so both
// the palette generator (tools/gen/genPalette.ts) and unit tests import it
// directly. genPalette emits assets/palette/metropolis.pal (JASC-PAL) plus a
// reference swatch PNG from these same entries.

export interface PaletteEntry {
  /** Stable key used by code, the .pal comment column, and tests. */
  readonly name: string;
  /** 24-bit sRGB, the authoring space (Three converts to linear on load). */
  readonly hex: number;
}

// Ordered — a color's position in this array IS its palette index. The .pal
// file and any future palette-swap texture are keyed by position, so append
// new colors at the end; never reorder or insert in the middle.
export const PALETTE: readonly PaletteEntry[] = [
  // Field / ink — dark backdrops and structure shadows.
  { name: "shadow", hex: 0x05070c },
  { name: "field_dark", hex: 0x0b1524 },
  { name: "field_mid", hex: 0x131a2a },
  { name: "ink", hex: 0x1b2333 },
  // Team A ramp (blue): dark / base / light.
  { name: "blue_dark", hex: 0x1e40af },
  { name: "blue", hex: 0x3b82f6 },
  { name: "blue_light", hex: 0x93c5fd },
  // Team B ramp (red): dark / base / light.
  { name: "red_dark", hex: 0x991b1b },
  { name: "red", hex: 0xef4444 },
  { name: "red_light", hex: 0xfca5a5 },
  // Neutral ramp (grey): dark / base / light.
  { name: "neutral_dark", hex: 0x4b5563 },
  { name: "neutral", hex: 0x9ca3af },
  { name: "neutral_light", hex: 0xd1d5db },
  // Terrain / environment.
  { name: "terrain_low", hex: 0x2e4436 },
  { name: "terrain_mid", hex: 0x6b7a4f },
  { name: "terrain_high", hex: 0xc9b98f },
  { name: "rock", hex: 0x8a8073 },
  { name: "riverbed", hex: 0x14303e },
  { name: "water", hex: 0x2f6f8f },
  { name: "water_light", hex: 0x5fa8c4 },
  // FX / projectiles.
  { name: "muzzle", hex: 0xffffff },
  { name: "heavy", hex: 0xffb020 },
  { name: "special", hex: 0x7ef2ff },
  { name: "warden_bomb", hex: 0xff5470 },
  { name: "explosion", hex: 0xffd24a },
  { name: "smoke", hex: 0x6b7280 },
  // HUD / accent.
  { name: "accent_amber", hex: 0xfbbf24 },
  { name: "hud_green", hex: 0x34d399 },
  { name: "hud_red", hex: 0xf87171 },
  { name: "hud_dim", hex: 0x64748b },
  // Shared surfaces — neutral metal and destroyed husks.
  { name: "steel", hex: 0x9aa4b2 },
  { name: "husk", hex: 0x5c5148 },
];

/** Palette entries as raw sRGB hex ints, in index order. */
export const PALETTE_HEX: readonly number[] = PALETTE.map((e) => e.hex);

const INDEX_BY_NAME: Readonly<Record<string, number>> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < PALETTE.length; i++) m[PALETTE[i].name] = i;
  return m;
})();

/** Palette index for a named color; throws on an unknown name (typo guard). */
export function paletteIndex(name: string): number {
  const i = INDEX_BY_NAME[name];
  if (i === undefined) throw new Error(`unknown palette color: ${name}`);
  return i;
}

/** sRGB hex for a named color. */
export function paletteHex(name: string): number {
  return PALETTE[paletteIndex(name)].hex;
}

/** A three-shade team/neutral ramp; values are sRGB hex ints. */
export interface Ramp {
  readonly dark: number;
  readonly base: number;
  readonly light: number;
}

/** Team ramps, indexed by team id (0 = blue, 1 = red). */
export const TEAM_RAMPS: readonly Ramp[] = [
  { dark: paletteHex("blue_dark"), base: paletteHex("blue"), light: paletteHex("blue_light") },
  { dark: paletteHex("red_dark"), base: paletteHex("red"), light: paletteHex("red_light") },
];

/** Ramp for unowned / neutral things. */
export const NEUTRAL_RAMP: Ramp = {
  dark: paletteHex("neutral_dark"),
  base: paletteHex("neutral"),
  light: paletteHex("neutral_light"),
};

/** Ramp for a team id, falling back to the neutral ramp for out-of-range ids. */
export function teamRamp(team: number): Ramp {
  return TEAM_RAMPS[team] ?? NEUTRAL_RAMP;
}

/**
 * Projectile tint by payload kind, matching the sim's aux ordering:
 * 0 = primary hitscan tracer, 1 = heavy, 2 = special, 3 = warden bomb.
 */
export const PROJECTILE_HEX: readonly number[] = [
  paletteHex("muzzle"),
  paletteHex("heavy"),
  paletteHex("special"),
  paletteHex("warden_bomb"),
];

/** Terrain / water colors consumed by the heightfield mesh builder. */
export const TERRAIN_HEX = {
  low: paletteHex("terrain_low"),
  high: paletteHex("terrain_high"),
  riverbed: paletteHex("riverbed"),
  water: paletteHex("water"),
} as const;
