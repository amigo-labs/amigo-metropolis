// Avatar loadout catalog — Future Cop Precinct Assault, ten weapons only:
// four Guns, three Heavies, three Specials (rules.md §2, SIM_VERSION 26).
// Defaults (index 0 in each slot) are the original kit: Powered Mini-Gun +
// Hell Fire 2000 + Mortar Launcher. Rate/damage for every shared panel weapon
// come from the original front-end bars; the arithmetic lives in balance.ts.

import {
  AVATAR_AMMO_HEAVY,
  AVATAR_AMMO_SPECIAL,
  GUN_ELECTRIC_COOLDOWN_TICKS,
  GUN_ELECTRIC_DAMAGE,
  GUN_ELECTRIC_RANGE,
  GUN_FLAME_COOLDOWN_TICKS,
  GUN_FLAME_DAMAGE,
  GUN_FLAME_RANGE,
  GUN_LASER_COOLDOWN_TICKS,
  GUN_LASER_DAMAGE,
  GUN_LASER_RANGE,
  HEAVY_AOE_RADIUS,
  HEAVY_BEAM_AMMO,
  HEAVY_BEAM_COOLDOWN_TICKS,
  HEAVY_BEAM_DAMAGE,
  HEAVY_BEAM_RANGE,
  HEAVY_COOLDOWN_TICKS,
  HEAVY_DAMAGE,
  HEAVY_HYPER_AMMO,
  HEAVY_HYPER_AOE_RADIUS,
  HEAVY_HYPER_COOLDOWN_TICKS,
  HEAVY_HYPER_DAMAGE,
  HEAVY_HYPER_SPEED,
  HEAVY_HYPER_TTL_TICKS,
  HEAVY_SPEED,
  HEAVY_TTL_TICKS,
  PRIMARY_COOLDOWN_TICKS,
  PRIMARY_DAMAGE,
  PRIMARY_RANGE,
  SPECIAL_AOE_RADIUS,
  SPECIAL_COOLDOWN_TICKS,
  SPECIAL_DAMAGE,
  SPECIAL_MINE_AMMO,
  SPECIAL_MINE_AOE_RADIUS,
  SPECIAL_MINE_COOLDOWN_TICKS,
  SPECIAL_MINE_DAMAGE,
  SPECIAL_MINE_TTL_TICKS,
  SPECIAL_SHOCK_AMMO,
  SPECIAL_SHOCK_AOE_RADIUS,
  SPECIAL_SHOCK_COOLDOWN_TICKS,
  SPECIAL_SHOCK_DAMAGE,
  SPECIAL_SPEED,
  SPECIAL_TTL_TICKS,
  WARDEN_HEAVY_AOE_RADIUS,
  WARDEN_HEAVY_DAMAGE,
} from "./balance";

/**
 * Projectile payload kinds written into entity.mode (snapshot aux).
 * Numbers are stable; gaps are intentional (never renumber).
 * Live catalog uses: HEAVY, MORTAR, HYPER, MINE, SHOCKWAVE (+ WARDEN).
 */
export const PROJ_HEAVY = 1;
/** Same blast as PROJ_MORTAR — kept for older event payloads. */
export const PROJ_SPECIAL = 2;
export const PROJ_WARDEN = 3;
export const PROJ_MORTAR = 6;
export const PROJ_HYPER = 7;
export const PROJ_MINE = 10;
export const PROJ_SHOCKWAVE = 11;

export const WEAPON_SLOT_GUN = 0;
export const WEAPON_SLOT_HEAVY = 1;
export const WEAPON_SLOT_SPECIAL = 2;

/**
 * Fire delivery.
 * - hitscan: instant ray
 * - projectile: flying shell
 * - mine: places a proximity charge at the shooter's feet (no aim needed)
 * - shockwave: self-centred pulse (no aim needed)
 */
export type WeaponDelivery = "hitscan" | "projectile" | "mine" | "shockwave";

/**
 * Client VFX style key. The renderer maps these to tracers / sprites / rings;
 * the sim never reads them.
 */
export type WeaponVfx =
  | "minigun"
  | "laser"
  | "flame"
  | "electric"
  | "rocket"
  | "hyper"
  | "mortar"
  | "beam"
  | "mine"
  | "shockwave";

export interface WeaponDef {
  /** Stable id, unique across the whole catalog. Never renumbered. */
  readonly id: number;
  readonly slot: 0 | 1 | 2;
  /** Index within the slot (0 = default / original kit). */
  readonly index: number;
  readonly name: string;
  readonly blurb: string;
  readonly delivery: WeaponDelivery;
  readonly damage: number;
  readonly cooldownTicks: number;
  /** Hitscan range, or projectile travel distance proxy (speed * ttl * dt). */
  readonly range: number;
  readonly speed: number;
  readonly ttlTicks: number;
  readonly aoeRadius: number;
  /** Max ammo for heavy/special; guns ignore (infinite). */
  readonly ammo: number;
  /** Projectile mode written to entity.mode; 0 for pure hitscan / pulse. */
  readonly projKind: number;
  readonly vfx: WeaponVfx;
}

/** One pick per slot. Indices into GUNS / HEAVIES / SPECIALS. */
export interface Loadout {
  readonly gun: number;
  readonly heavy: number;
  readonly special: number;
}

export const DEFAULT_LOADOUT: Loadout = { gun: 0, heavy: 0, special: 0 };

export const GUNS: readonly WeaponDef[] = [
  {
    id: 0,
    slot: 0,
    index: 0,
    name: "Powered Mini-Gun",
    blurb: "Twin miniguns. High rate of fire, infinite ammo.",
    delivery: "hitscan",
    damage: PRIMARY_DAMAGE,
    cooldownTicks: PRIMARY_COOLDOWN_TICKS,
    range: PRIMARY_RANGE,
    speed: 0,
    ttlTicks: 0,
    aoeRadius: 0,
    ammo: 0,
    projKind: 0,
    vfx: "minigun",
  },
  {
    id: 1,
    slot: 0,
    index: 1,
    name: "Gatling Laser",
    // The original's bars put it level with the Mini-Gun on both axes, so what
    // separates the two here is reach — a declared deviation (balance.ts).
    blurb: "Coherent energy bolts. Same punch as the Mini-Gun, longer reach.",
    delivery: "hitscan",
    damage: GUN_LASER_DAMAGE,
    cooldownTicks: GUN_LASER_COOLDOWN_TICKS,
    range: GUN_LASER_RANGE,
    speed: 0,
    ttlTicks: 0,
    aoeRadius: 0,
    ammo: 0,
    projKind: 0,
    vfx: "laser",
  },
  {
    id: 2,
    slot: 0,
    index: 2,
    name: "Flamethrower", // the original's front-end spelling
    blurb: "Short-range napalm stream. Melts close targets.",
    delivery: "hitscan",
    damage: GUN_FLAME_DAMAGE,
    cooldownTicks: GUN_FLAME_COOLDOWN_TICKS,
    range: GUN_FLAME_RANGE,
    speed: 0,
    ttlTicks: 0,
    aoeRadius: 0,
    ammo: 0,
    projKind: 0,
    vfx: "flame",
  },
  {
    // Original Gun id 0x03. Same damage bar as the Flamethrower, half the rate —
    // a slower, harder hitscan. Chain/arc behaviour is unknown and not faked.
    id: 9,
    slot: 0,
    index: 3,
    name: "Electric Gun",
    blurb: "Slower bolt, harder hit. Same reach as the Mini-Gun.",
    delivery: "hitscan",
    damage: GUN_ELECTRIC_DAMAGE,
    cooldownTicks: GUN_ELECTRIC_COOLDOWN_TICKS,
    range: GUN_ELECTRIC_RANGE,
    speed: 0,
    ttlTicks: 0,
    aoeRadius: 0,
    ammo: 0,
    projKind: 0,
    vfx: "electric",
  },
];

export const HEAVIES: readonly WeaponDef[] = [
  {
    id: 3,
    slot: 1,
    index: 0,
    name: "Hell Fire 2000", // the original's front-end name
    blurb: "Guided-feel rockets with a solid blast radius.",
    delivery: "projectile",
    damage: HEAVY_DAMAGE,
    cooldownTicks: HEAVY_COOLDOWN_TICKS,
    range: 0,
    speed: HEAVY_SPEED,
    ttlTicks: HEAVY_TTL_TICKS,
    aoeRadius: HEAVY_AOE_RADIUS,
    ammo: AVATAR_AMMO_HEAVY,
    projKind: PROJ_HEAVY,
    vfx: "rocket",
  },
  {
    // Original Heavy (`Beam Cannon`, id 0x12). Index 1 so the original kit
    // order Hell Fire → Concussion → Hyper matches the PA weapons screen.
    id: 8,
    slot: 1,
    index: 1,
    name: "Concussion Beam",
    blurb: "Instant long-range beam. No projectile travel time.",
    delivery: "hitscan",
    damage: HEAVY_BEAM_DAMAGE,
    cooldownTicks: HEAVY_BEAM_COOLDOWN_TICKS,
    range: HEAVY_BEAM_RANGE,
    speed: 0,
    ttlTicks: 0,
    aoeRadius: 0,
    ammo: HEAVY_BEAM_AMMO,
    projKind: 0,
    vfx: "beam",
  },
  {
    // Original Heavy id 0x13 (display: Hyper Velocity Rocket).
    id: 10,
    slot: 1,
    index: 2,
    name: "Hyper Velocity Rocket",
    blurb: "Fast light rocket. High cadence, tight blast.",
    delivery: "projectile",
    damage: HEAVY_HYPER_DAMAGE,
    cooldownTicks: HEAVY_HYPER_COOLDOWN_TICKS,
    range: 0,
    speed: HEAVY_HYPER_SPEED,
    ttlTicks: HEAVY_HYPER_TTL_TICKS,
    aoeRadius: HEAVY_HYPER_AOE_RADIUS,
    ammo: HEAVY_HYPER_AMMO,
    projKind: PROJ_HYPER,
    vfx: "hyper",
  },
];

export const SPECIALS: readonly WeaponDef[] = [
  {
    id: 7,
    slot: 2,
    index: 0,
    name: "Mortar Launcher", // the original's front-end name + default special
    blurb: "Arcing shell with a wide crater. Softens bases.",
    delivery: "projectile",
    damage: SPECIAL_DAMAGE,
    cooldownTicks: SPECIAL_COOLDOWN_TICKS,
    range: 0,
    speed: SPECIAL_SPEED,
    ttlTicks: SPECIAL_TTL_TICKS,
    aoeRadius: SPECIAL_AOE_RADIUS,
    ammo: AVATAR_AMMO_SPECIAL,
    projKind: PROJ_MORTAR,
    vfx: "mortar",
  },
  {
    // Proximity charge. Placed at the avatar's feet; arms after a short delay,
    // then detonates when an enemy walks into the trigger radius.
    id: 13,
    slot: 2,
    index: 1,
    name: "Pop-Up Mines",
    blurb: "Drop a proximity charge. Arms after a short delay.",
    delivery: "mine",
    damage: SPECIAL_MINE_DAMAGE,
    cooldownTicks: SPECIAL_MINE_COOLDOWN_TICKS,
    range: 0,
    speed: 0,
    ttlTicks: SPECIAL_MINE_TTL_TICKS,
    aoeRadius: SPECIAL_MINE_AOE_RADIUS,
    ammo: SPECIAL_MINE_AMMO,
    projKind: PROJ_MINE,
    vfx: "mine",
  },
  {
    // Self-centred expanding pulse — no aim, no projectile travel.
    id: 14,
    slot: 2,
    index: 2,
    name: "Shockwave Generator",
    blurb: "Self-centred pulse. Clears everything in a wide ring.",
    delivery: "shockwave",
    damage: SPECIAL_SHOCK_DAMAGE,
    cooldownTicks: SPECIAL_SHOCK_COOLDOWN_TICKS,
    range: 0,
    speed: 0,
    ttlTicks: 0,
    aoeRadius: SPECIAL_SHOCK_AOE_RADIUS,
    ammo: SPECIAL_SHOCK_AMMO,
    projKind: PROJ_SHOCKWAVE,
    vfx: "shockwave",
  },
];

const BY_SLOT: readonly (readonly WeaponDef[])[] = [GUNS, HEAVIES, SPECIALS];

const BY_ID: ReadonlyMap<number, WeaponDef> = (() => {
  const m = new Map<number, WeaponDef>();
  for (const list of BY_SLOT) for (const w of list) m.set(w.id, w);
  return m;
})();

/** Look up a catalog weapon by stable id; undefined if unknown. */
export function weaponById(id: number): WeaponDef | undefined {
  return BY_ID.get(id);
}

/** Clamp a loadout index into the slot's catalog. */
export function clampLoadoutIndex(slot: 0 | 1 | 2, index: number): number {
  const list = BY_SLOT[slot];
  if (!Number.isFinite(index)) return 0;
  const i = Math.floor(index);
  if (i < 0) return 0;
  if (i >= list.length) return list.length - 1;
  return i;
}

export function normalizeLoadout(raw?: Partial<Loadout> | null): Loadout {
  return {
    gun: clampLoadoutIndex(0, raw?.gun ?? 0),
    heavy: clampLoadoutIndex(1, raw?.heavy ?? 0),
    special: clampLoadoutIndex(2, raw?.special ?? 0),
  };
}

export function weaponInSlot(slot: 0 | 1 | 2, index: number): WeaponDef {
  const list = BY_SLOT[slot];
  return list[clampLoadoutIndex(slot, index)];
}

/** Resolve the three weapons a player is carrying. */
export function resolveLoadout(loadout: Loadout): {
  gun: WeaponDef;
  heavy: WeaponDef;
  special: WeaponDef;
} {
  const l = normalizeLoadout(loadout);
  return {
    gun: GUNS[l.gun],
    heavy: HEAVIES[l.heavy],
    special: SPECIALS[l.special],
  };
}

/** AoE + damage for a projectile mode (explode path). */
export function projectileBlast(kind: number): { damage: number; radius: number } {
  switch (kind) {
    case PROJ_SPECIAL:
    case PROJ_MORTAR:
      return { damage: SPECIAL_DAMAGE, radius: SPECIAL_AOE_RADIUS };
    case PROJ_WARDEN:
      return { damage: WARDEN_HEAVY_DAMAGE, radius: WARDEN_HEAVY_AOE_RADIUS };
    case PROJ_HYPER:
      return { damage: HEAVY_HYPER_DAMAGE, radius: HEAVY_HYPER_AOE_RADIUS };
    case PROJ_MINE:
      return { damage: SPECIAL_MINE_DAMAGE, radius: SPECIAL_MINE_AOE_RADIUS };
    case PROJ_SHOCKWAVE:
      return { damage: SPECIAL_SHOCK_DAMAGE, radius: SPECIAL_SHOCK_AOE_RADIUS };
    default:
      return { damage: HEAVY_DAMAGE, radius: HEAVY_AOE_RADIUS };
  }
}
