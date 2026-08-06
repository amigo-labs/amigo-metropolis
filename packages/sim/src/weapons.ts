// Avatar loadout catalog (Future Cop style): one Gun + one Heavy + one Special.
// Defaults (index 0 in each slot) reproduce the historic balance.ts numbers so
// goldens and empty configs stay bit-identical. Non-default picks change combat
// and therefore hashes — they only apply when the player selects them.
//
// The eleven weapons this catalog shares with the original carry the original's
// damage, cadence and display names, derived per slot from the front-end bars —
// the arithmetic and the two declared deviations are documented at the
// "Non-default catalog weapons" block in balance.ts, and every number here is a
// named constant from there (no inline gameplay values).
//
// The original has 15 (five per slot) and this has 13. Four of the eight that
// were missing are table rows and land here (Electric Gun, Hyper Velocity
// Rocket, Fusion Torpedo, Grenade Launcher — issue #48). The other four are
// new mechanics — a deployable shield, a drone, mines, a shockwave — and stay
// tracked as issues rather than guessed at here.

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
  HEAVY_CLUSTER_AMMO,
  HEAVY_CLUSTER_AOE_RADIUS,
  HEAVY_CLUSTER_COOLDOWN_TICKS,
  HEAVY_CLUSTER_DAMAGE,
  HEAVY_CLUSTER_SPEED,
  HEAVY_CLUSTER_TTL_TICKS,
  HEAVY_COOLDOWN_TICKS,
  HEAVY_DAMAGE,
  HEAVY_FUSION_AMMO,
  HEAVY_FUSION_AOE_RADIUS,
  HEAVY_FUSION_COOLDOWN_TICKS,
  HEAVY_FUSION_DAMAGE,
  HEAVY_FUSION_SPEED,
  HEAVY_FUSION_TTL_TICKS,
  HEAVY_HYPER_AMMO,
  HEAVY_HYPER_AOE_RADIUS,
  HEAVY_HYPER_COOLDOWN_TICKS,
  HEAVY_HYPER_DAMAGE,
  HEAVY_HYPER_SPEED,
  HEAVY_HYPER_TTL_TICKS,
  HEAVY_RAIL_AMMO,
  HEAVY_RAIL_AOE_RADIUS,
  HEAVY_RAIL_COOLDOWN_TICKS,
  HEAVY_RAIL_DAMAGE,
  HEAVY_RAIL_SPEED,
  HEAVY_RAIL_TTL_TICKS,
  HEAVY_SPEED,
  HEAVY_TTL_TICKS,
  PRIMARY_COOLDOWN_TICKS,
  PRIMARY_DAMAGE,
  PRIMARY_RANGE,
  SPECIAL_AOE_RADIUS,
  SPECIAL_COOLDOWN_TICKS,
  SPECIAL_DAMAGE,
  SPECIAL_GRENADE_AMMO,
  SPECIAL_GRENADE_AOE_RADIUS,
  SPECIAL_GRENADE_COOLDOWN_TICKS,
  SPECIAL_GRENADE_DAMAGE,
  SPECIAL_GRENADE_SPEED,
  SPECIAL_GRENADE_TTL_TICKS,
  SPECIAL_MORTAR_AMMO,
  SPECIAL_MORTAR_AOE_RADIUS,
  SPECIAL_MORTAR_COOLDOWN_TICKS,
  SPECIAL_MORTAR_DAMAGE,
  SPECIAL_MORTAR_SPEED,
  SPECIAL_MORTAR_TTL_TICKS,
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
export const PROJ_HYPER = 7;
export const PROJ_FUSION = 8;
export const PROJ_GRENADE = 9;

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
  | "electric"
  | "rocket"
  | "cluster"
  | "rail"
  | "hyper"
  | "fusion"
  | "plasma"
  | "mortar"
  | "grenade"
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
    id: 4,
    slot: 1,
    index: 1,
    name: "Cluster Bomb",
    blurb: "Slow shell, wide fireball. Clears clusters of units. (Metropolis)",
    delivery: "projectile",
    damage: HEAVY_CLUSTER_DAMAGE,
    cooldownTicks: HEAVY_CLUSTER_COOLDOWN_TICKS,
    range: 0,
    speed: HEAVY_CLUSTER_SPEED,
    ttlTicks: HEAVY_CLUSTER_TTL_TICKS,
    aoeRadius: HEAVY_CLUSTER_AOE_RADIUS,
    ammo: HEAVY_CLUSTER_AMMO,
    projKind: PROJ_CLUSTER,
    vfx: "cluster",
  },
  {
    id: 5,
    slot: 1,
    index: 2,
    name: "Rail Cannon",
    blurb: "Hyper-velocity slug. Pinpoint, almost no splash. (Metropolis)",
    delivery: "projectile",
    damage: HEAVY_RAIL_DAMAGE,
    cooldownTicks: HEAVY_RAIL_COOLDOWN_TICKS,
    range: 0,
    speed: HEAVY_RAIL_SPEED,
    ttlTicks: HEAVY_RAIL_TTL_TICKS,
    aoeRadius: HEAVY_RAIL_AOE_RADIUS,
    ammo: HEAVY_RAIL_AMMO,
    projKind: PROJ_RAIL,
    vfx: "rail",
  },
  {
    // Moved here from the Special slot for fidelity: the original files it as a
    // Heavy (`Beam Cannon`, id 0x12 — high nibble = slot). The id-to-name pairing
    // inside the Heavy group was made by elimination, so WHICH heavy id it is is
    // not certain; that it IS a heavy does not depend on the elimination, because
    // both leftover ids were heavies. Appended rather than inserted so existing
    // heavy loadout indices keep meaning.
    //
    // `id` stays 8 — catalog ids are stable and never renumbered, only the slot
    // and index move.
    id: 8,
    slot: 1,
    index: 3,
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
    // Original Heavy id 0x13 (display: Hyper Velocity Rocket). Fast, light
    // projectile — overlaps Rail Cannon in role; both stay (rules.md §2).
    id: 10,
    slot: 1,
    index: 4,
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
  {
    // Original Heavy id 0x14. Slow heavy shell with a wide crater.
    id: 11,
    slot: 1,
    index: 5,
    name: "Fusion Torpedo",
    blurb: "Slow heavy torpedo. Huge single-shot punch.",
    delivery: "projectile",
    damage: HEAVY_FUSION_DAMAGE,
    cooldownTicks: HEAVY_FUSION_COOLDOWN_TICKS,
    range: 0,
    speed: HEAVY_FUSION_SPEED,
    ttlTicks: HEAVY_FUSION_TTL_TICKS,
    aoeRadius: HEAVY_FUSION_AOE_RADIUS,
    ammo: HEAVY_FUSION_AMMO,
    projKind: PROJ_FUSION,
    vfx: "fusion",
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
    name: "Mortar Launcher", // the original's front-end name
    blurb: "Arcing shell with a wide crater. Softens bases.",
    delivery: "projectile",
    damage: SPECIAL_MORTAR_DAMAGE,
    cooldownTicks: SPECIAL_MORTAR_COOLDOWN_TICKS,
    range: 0,
    speed: SPECIAL_MORTAR_SPEED,
    ttlTicks: SPECIAL_MORTAR_TTL_TICKS,
    aoeRadius: SPECIAL_MORTAR_AOE_RADIUS,
    ammo: SPECIAL_MORTAR_AMMO,
    projKind: PROJ_MORTAR,
    vfx: "mortar",
  },
  {
    // Original Special id 0x24. Mortar-shaped flight at the Plasma Flare's
    // cadence with a heavier damage bar. True ballistic arc is not in the sim
    // (same as the Mortar — "arcing" is flavor over 2D flight).
    id: 12,
    slot: 2,
    index: 2,
    name: "Grenade Launcher",
    blurb: "Arcing shell, hard crater. Faster cadence feel than the Mortar's punch.",
    delivery: "projectile",
    damage: SPECIAL_GRENADE_DAMAGE,
    cooldownTicks: SPECIAL_GRENADE_COOLDOWN_TICKS,
    range: 0,
    speed: SPECIAL_GRENADE_SPEED,
    ttlTicks: SPECIAL_GRENADE_TTL_TICKS,
    aoeRadius: SPECIAL_GRENADE_AOE_RADIUS,
    ammo: SPECIAL_GRENADE_AMMO,
    projKind: PROJ_GRENADE,
    vfx: "grenade",
  },
  // Three entries: Plasma, Mortar, Grenade. The original's Special slot also
  // has Pop-Up Mines and Shockwave Generator — both new mechanics, still open
  // under issue #48. Riot Shield (Gun) and K-9 Drone (Heavy) likewise.
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
      return { damage: HEAVY_CLUSTER_DAMAGE, radius: HEAVY_CLUSTER_AOE_RADIUS };
    case PROJ_RAIL:
      return { damage: HEAVY_RAIL_DAMAGE, radius: HEAVY_RAIL_AOE_RADIUS };
    case PROJ_MORTAR:
      return { damage: SPECIAL_MORTAR_DAMAGE, radius: SPECIAL_MORTAR_AOE_RADIUS };
    case PROJ_HYPER:
      return { damage: HEAVY_HYPER_DAMAGE, radius: HEAVY_HYPER_AOE_RADIUS };
    case PROJ_FUSION:
      return { damage: HEAVY_FUSION_DAMAGE, radius: HEAVY_FUSION_AOE_RADIUS };
    case PROJ_GRENADE:
      return { damage: SPECIAL_GRENADE_DAMAGE, radius: SPECIAL_GRENADE_AOE_RADIUS };
    default:
      return { damage: HEAVY_DAMAGE, radius: HEAVY_AOE_RADIUS };
  }
}
