// Avatar loadout catalog (Future Cop style): one Gun + one Heavy + one Special.
// Defaults (index 0 in each slot) reproduce the historic balance.ts numbers so
// goldens and empty configs stay bit-identical. Non-default picks change combat
// and therefore hashes — they only apply when the player selects them.

import {
  AVATAR_AMMO_HEAVY,
  AVATAR_AMMO_SPECIAL,
  HEAVY_AOE_RADIUS,
  HEAVY_COOLDOWN_TICKS,
  HEAVY_DAMAGE,
  HEAVY_SPEED,
  HEAVY_TTL_TICKS,
  PRIMARY_COOLDOWN_TICKS,
  PRIMARY_DAMAGE,
  PRIMARY_RANGE,
  SPECIAL_AOE_RADIUS,
  SPECIAL_COOLDOWN_TICKS,
  SPECIAL_DAMAGE,
  SPECIAL_SPEED,
  SPECIAL_TTL_TICKS,
  WARDEN_HEAVY_AOE_RADIUS,
  WARDEN_HEAVY_DAMAGE,
} from "./balance";

/** Projectile payload kinds written into entity.mode (snapshot aux). */
export const PROJ_HEAVY = 1;
export const PROJ_SPECIAL = 2;
export const PROJ_WARDEN = 3;
export const PROJ_CLUSTER = 4;
export const PROJ_RAIL = 5;
export const PROJ_MORTAR = 6;

export const WEAPON_SLOT_GUN = 0;
export const WEAPON_SLOT_HEAVY = 1;
export const WEAPON_SLOT_SPECIAL = 2;

/** Fire delivery. Hitscan is instant; projectile spawns a flying entity. */
export type WeaponDelivery = "hitscan" | "projectile";

/**
 * Client VFX style key. The renderer maps these to tracers / sprites / rings;
 * the sim never reads them.
 */
export type WeaponVfx =
  | "minigun"
  | "laser"
  | "flame"
  | "rocket"
  | "cluster"
  | "rail"
  | "plasma"
  | "mortar"
  | "beam";

export interface WeaponDef {
  /** Stable id, unique across the whole catalog. */
  readonly id: number;
  readonly slot: 0 | 1 | 2;
  /** Index within the slot (0 = default / historic). */
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
  /** Projectile mode written to entity.mode; 0 for pure hitscan. */
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
    blurb: "Coherent energy bolts. Harder hits, cyan tracers.",
    delivery: "hitscan",
    damage: 12,
    cooldownTicks: 6,
    range: 44,
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
    name: "Flame-Thrower",
    blurb: "Short-range napalm stream. Melts close targets.",
    delivery: "hitscan",
    damage: 14,
    cooldownTicks: 3,
    range: 14,
    speed: 0,
    ttlTicks: 0,
    aoeRadius: 0,
    ammo: 0,
    projKind: 0,
    vfx: "flame",
  },
];

export const HEAVIES: readonly WeaponDef[] = [
  {
    id: 3,
    slot: 1,
    index: 0,
    name: "Hellfire Rockets",
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
    id: 4,
    slot: 1,
    index: 1,
    name: "Cluster Bomb",
    blurb: "Slow shell, wide fireball. Clears clusters of units.",
    delivery: "projectile",
    damage: 45,
    cooldownTicks: 30,
    range: 0,
    speed: 18,
    ttlTicks: 90,
    aoeRadius: 9,
    ammo: 14,
    projKind: PROJ_CLUSTER,
    vfx: "cluster",
  },
  {
    id: 5,
    slot: 1,
    index: 2,
    name: "Rail Cannon",
    blurb: "Hyper-velocity slug. Pinpoint, almost no splash.",
    delivery: "projectile",
    damage: 90,
    cooldownTicks: 28,
    range: 0,
    speed: 55,
    ttlTicks: 40,
    aoeRadius: 1.5,
    ammo: 16,
    projKind: PROJ_RAIL,
    vfx: "rail",
  },
];

export const SPECIALS: readonly WeaponDef[] = [
  {
    id: 6,
    slot: 2,
    index: 0,
    name: "Plasma Flare",
    blurb: "Slow plasma orb. Huge single-target punch.",
    delivery: "projectile",
    damage: SPECIAL_DAMAGE,
    cooldownTicks: SPECIAL_COOLDOWN_TICKS,
    range: 0,
    speed: SPECIAL_SPEED,
    ttlTicks: SPECIAL_TTL_TICKS,
    aoeRadius: SPECIAL_AOE_RADIUS,
    ammo: AVATAR_AMMO_SPECIAL,
    projKind: PROJ_SPECIAL,
    vfx: "plasma",
  },
  {
    id: 7,
    slot: 2,
    index: 1,
    name: "Mortar",
    blurb: "Arcing shell with a wide crater. Softens bases.",
    delivery: "projectile",
    damage: 120,
    cooldownTicks: 72,
    range: 0,
    speed: 10,
    ttlTicks: 110,
    aoeRadius: 8,
    ammo: 4,
    projKind: PROJ_MORTAR,
    vfx: "mortar",
  },
  {
    id: 8,
    slot: 2,
    index: 2,
    name: "Concussion Beam",
    blurb: "Instant long-range beam. No projectile travel time.",
    delivery: "hitscan",
    damage: 110,
    cooldownTicks: 48,
    range: 50,
    speed: 0,
    ttlTicks: 0,
    aoeRadius: 0,
    ammo: 6,
    projKind: 0,
    vfx: "beam",
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
      return { damage: SPECIAL_DAMAGE, radius: SPECIAL_AOE_RADIUS };
    case PROJ_WARDEN:
      return { damage: WARDEN_HEAVY_DAMAGE, radius: WARDEN_HEAVY_AOE_RADIUS };
    case PROJ_CLUSTER:
      return { damage: 45, radius: 9 };
    case PROJ_RAIL:
      return { damage: 90, radius: 1.5 };
    case PROJ_MORTAR:
      return { damage: 120, radius: 8 };
    default:
      return { damage: HEAVY_DAMAGE, radius: HEAVY_AOE_RADIUS };
  }
}
