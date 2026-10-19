// Avatar loadout catalog — Future Cop Precinct Assault's ten weapons (four
// Guns, three Heavies, three Specials; rules.md §2, SIM_VERSION 26), then the
// original's other five, each behind its own bit of the "Spielregeln" switch
// `SimOptions.extraWeapons` (SIM_VERSION 90, the owner's decision; all off by
// default, which is the original's PA): Riot Shield after the Guns, K-9 Drone
// and Fusion Torpedo after the Heavies, Grenade Launcher and Plasma Flare
// after the Specials. Appended, so every earlier loadout index holds.
// Defaults (index 0 in each slot) are the original kit: Powered Mini-Gun +
// Hell Fire 2000 + Mortar Launcher (`config.c:80`).
//
// Since SIM_VERSION 41 every number is the original's own weapon record — block A
// as issued, block B after the slot's power-up (balance.ts WEAPON_RECORDS;
// fcop-fidelity.md W1, P8; fcop-re/player-and-weapons.md §7). They replace the
// rate/damage scaled off the front-end panel bars and the ranges, speeds and
// magazines Metropolis had invented. The conversions below are the loader's.
// The magazines are the records' own, HARD's: a player's difficulty scales them
// where they are filled (`difficultyAmmo`, SIM_VERSION 72).

import {
  DIFFICULTY_EASY,
  DIFFICULTY_NORMAL,
  FLAME_PULSE_TICKS,
  WEAPON_RECORDS,
  WEAPON_UNITS_PER_TICK,
  type WeaponRecord,
} from "./balance";

/**
 * Projectile payload kinds written into entity.mode (snapshot aux).
 * Numbers are stable; gaps are intentional (never renumber).
 */
export const PROJ_HEAVY = 1;
/** Same blast as PROJ_MORTAR — kept for older event payloads. */
export const PROJ_SPECIAL = 2;
export const PROJ_WARDEN = 3;
export const PROJ_MORTAR = 6;
export const PROJ_HYPER = 7;
export const PROJ_MINE = 10;
export const PROJ_SHOCKWAVE = 11;
/** The Concussion Beam's blast at the beam's end (an explosion kind, not an entity). */
export const PROJ_BEAM = 12;
/** A Mini-Gun / Gatling Laser block-B splash at the shot's end (explosion kind). */
export const PROJ_SPLASH = 13;
/**
 * A world shooter's round (turret, tank, jet, Fortress, Dreadnought gun): the
 * PA catalogue's 7.62 m/s bolt (fcop-fidelity.md W3).
 */
export const PROJ_ROUND = 14;
/** The K-9 Drone's round (kind 0x15, the original's ground-hugging missile). */
export const PROJ_K9 = 15;
/** The Grenade Launcher's bouncing round (kind 9, the original's type-0x0f round). */
export const PROJ_GRENADE = 16;
/** The Fusion Torpedo (kind 3, homing, its blast falling off with the distance flown). */
export const PROJ_TORPEDO = 17;
/** The Plasma Flare's kept shell (kind 4; block B 0x14 bursts into four). */
export const PROJ_PLASMA = 18;

// The "Spielregeln" bits of SimOptions.extraWeapons: each of the original's
// five weapons Precinct Assault never offers, switched on separately (the
// owner's decision; the original's PA has all five off).
export const EXTRA_WEAPON_RIOT_SHIELD = 1 << 0;
export const EXTRA_WEAPON_K9_DRONE = 1 << 1;
export const EXTRA_WEAPON_GRENADE_LAUNCHER = 1 << 2;
export const EXTRA_WEAPON_FUSION_TORPEDO = 1 << 3;
export const EXTRA_WEAPON_PLASMA_FLARE = 1 << 4;
/** All five. */
export const EXTRA_WEAPONS_ALL = 0x1f;

/** A config value as the sim takes it: the five bits of an integer, 0 when unusable. */
export function normalizeExtraWeapons(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 0;
  return Math.floor(raw) & EXTRA_WEAPONS_ALL;
}

export const WEAPON_SLOT_GUN = 0;
export const WEAPON_SLOT_HEAVY = 1;
export const WEAPON_SLOT_SPECIAL = 2;

/**
 * Fire delivery, by the original's launcher (`player_fire_slot` 0x00458ed0 sends
 * kinds 0x0a-0x0c and 0x0e to `player_fire_direct`, everything else to
 * `player_fire_launch`):
 * - hitscan: the direct path — damages only the LOCK (Mini-Gun 0x0a, Electric
 *   0x0b, Laser 0x0c; fcop-fidelity.md W2). With no lock the line does nothing,
 *   except a block B with a blast, which area-damages at the line's end.
 * - flame: the Flamethrower (0x0e): the lock-only line, with Metropolis' pulse
 *   cadence (balance.ts FLAME_PULSE_TICKS).
 * - missile: kinds 2/3/0x12 — a round that launches at an eighth of its top
 *   speed and accelerates, flies its record's range, and homes on the lock
 *   (3, 0x12) or is lead-aimed at it (2; straight ahead without a lock).
 * - arced: kinds 4/0x14 — a ballistic solve to the lock or 8 m ahead, under the
 *   record's own gravity; 0x14 bursts into four fragments at its apex.
 * - beam: the Concussion Beam (0x11), an aimed sustained effect, here an
 *   instant line to the lock (or its range ahead) with the record's blast at the
 *   end — Metropolis' time profile, the original's damage, radius and reach.
 * - mine: the Pop-Up Mine (5), dropped at the shooter's feet.
 * - shockwave: the Shockwave Generator (0x0f), a self-centred pulse —
 *   Metropolis' instant pulse, the original's damage and radius.
 * - sphere: the Riot Shield (0x0d, `sustain_sphere_toggle` 0x0044c1f0), a
 *   sphere about the mech toggled by the trigger, hurting what it touches
 *   every tick and spending its magazine while it is up (sim.ts systemShields).
 * - drone: the K-9 Drone (0x15), the original's ground-hugging homing missile
 *   with twice its damage as health (`missile.c`, CACT_MISSILE_KIND_HUG).
 * - bounce: the Grenade Launcher (9, `cact_round_spawn_streamed` with the
 *   ballistic solve): the type-0x0f round that falls, bounces and settles
 *   (`type15.c`), on a random fuse.
 */
export type WeaponDelivery =
  | "hitscan"
  | "flame"
  | "missile"
  | "arced"
  | "beam"
  | "mine"
  | "shockwave"
  | "sphere"
  | "drone"
  | "bounce";

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
  | "shockwave"
  | "shield"
  | "drone"
  | "grenade"
  | "torpedo"
  | "plasma";

/** One stat block in SI and sim units, converted from a WeaponRecord. */
export interface WeaponBlock {
  /** The original's kind byte (the launcher). */
  readonly kind: number;
  readonly flags: number;
  /**
   * Starting ammunition as the record holds it, HARD's (0 for a block B); a
   * player's is `difficultyAmmo(ammo, difficulty)`.
   */
  readonly ammo: number;
  /** The ammunition ceiling as the record holds it, HARD's: see `difficultyAmmo`. */
  readonly ammoCap: number;
  readonly rounds: number;
  /** Gaps in engine units (1/300 s). */
  readonly burstGap: number;
  readonly roundGap: number;
  readonly damage: number;
  /** Blast radius, m (0 = none). For a hitscan block A it is the lock scatter. */
  readonly blast: number;
  /** The record's +0x10 reach, m: the mine's trigger radius. */
  readonly reach: number;
  /** Top speed and launch speed, m/s; acceleration, m/s². */
  readonly speed: number;
  readonly launchSpeed: number;
  readonly accel: number;
  /** Hitscan reach or flight distance, m. 0 for arced/dropped rounds. */
  readonly range: number;
  /** Gravity, m/s², for arced and dropped rounds (their `range` field); else 0. */
  readonly gravity: number;
  /** Fuse / lifetime, sim ticks. */
  readonly fuseTicks: number;
  /** The same fuse in engine units (the bouncing round's lifetime base). */
  readonly fuseUnits: number;
  /** The raw record this block converts (the sphere reads its words as stored). */
  readonly rec: WeaponRecord;
}

export interface WeaponDef {
  /** Stable id, unique across the whole catalog. Never renumbered. */
  readonly id: number;
  readonly slot: 0 | 1 | 2;
  /** Index within the slot (0 = default / original kit). */
  readonly index: number;
  readonly name: string;
  readonly blurb: string;
  /** The original's loadout code (0x00..0x24): which WEAPON_RECORDS entry. */
  readonly code: number;
  readonly delivery: WeaponDelivery;
  /** Block A, as issued. */
  readonly a: WeaponBlock;
  /** Block B, after the slot's power-up (fcop-fidelity.md P8). */
  readonly b: WeaponBlock;
  /** Projectile mode written to entity.mode / the explosion kind; 0 for none. */
  readonly projKind: number;
  readonly vfx: WeaponVfx;
  // Block A at a glance, for the menu's bars and the debug panel.
  readonly damage: number;
  /** Average sim ticks per round over a full burst cycle. */
  readonly cooldownTicks: number;
  /** Hitscan reach, flight distance, or (arced) the flat reach of the lob, m. */
  readonly range: number;
  /** Starting magazine as the record holds it (HARD's; `difficultyAmmo`). */
  readonly ammo: number;
  /**
   * The SimOptions.extraWeapons bit that offers it (EXTRA_WEAPON_*), 0 for the
   * ten Precinct Assault always offers.
   */
  readonly extraBit: number;
}

/** One pick per slot. Indices into GUNS / HEAVIES / SPECIALS. */
export interface Loadout {
  readonly gun: number;
  readonly heavy: number;
  readonly special: number;
}

export const DEFAULT_LOADOUT: Loadout = { gun: 0, heavy: 0, special: 0 };

// --- The loader's conversions (fcop-re/player-and-weapons.md §7) -------------

/** A gap: raw * 4096 / 218, C-truncated, in engine units (1/300 s). */
export function gapUnits(raw: number): number {
  return ((raw * 4096) / 218) | 0;
}

/**
 * A magazine on difficulty `difficulty` (balance.ts DIFFICULTY_*): the record's
 * own on HARD, `raw + (raw >> 2)` on NORMAL (x1.25) and `raw + (raw >> 1)` on
 * EASY (x1.5) — the same table, with signed shifts, in the stock at construct
 * (`cact_type99_stock_player` 0x00458de6/0x00458df6, the starting ammunition +2)
 * and in every ceiling (`cact_type99_ammo_cap` 0x00459ea1/0x00459ea9, cap +4),
 * which the respawn's, a pickup's and the power-up's fills read. Integer, and
 * it allocates nothing.
 */
export function difficultyAmmo(raw: number, difficulty: number): number {
  if (difficulty === DIFFICULTY_NORMAL) return raw + (raw >> 2);
  if (difficulty === DIFFICULTY_EASY) return raw + (raw >> 1);
  return raw;
}

/** A length: raw << 4 world units, 8192 wu = 1 m. */
function metres(raw: number): number {
  return (raw * 16) / 8192;
}

/** Top speed: trunc(raw / 300) << 4 wu per engine unit, in m/s. */
function topSpeed(raw: number): number {
  return (((raw / 300) | 0) * 16 * 300) / 8192;
}

/**
 * A catalogue round's speed in m/s, the same conversion (the world's catalogue
 * shares the loader's rescale): 4096 -> 13 << 4 = 208 wu per engine unit =
 * 7.62 m/s, not 7.5 — the truncation matters (ranges-turrets-capture.md Q3).
 */
export function roundSpeed(raw: number): number {
  return topSpeed(raw);
}

/** Acceleration: trunc(raw * 256 / 300) / 16 wu per unit per unit, in m/s². */
function acceleration(raw: number): number {
  return ((((raw * 256) / 300) | 0) / 16) * ((300 * 300) / 8192);
}

const KIND_ARCED = 4;
const KIND_DROPPED = 5;
/** The streamed round with the ballistic solve (the Grenade Launcher). */
const KIND_STREAMED_ARC = 9;
const KIND_ARCED_CLUSTER = 0x14;

function block(r: WeaponRecord): WeaponBlock {
  const ballistic =
    r.kind === KIND_ARCED ||
    r.kind === KIND_ARCED_CLUSTER ||
    r.kind === KIND_DROPPED ||
    r.kind === KIND_STREAMED_ARC;
  const speed = topSpeed(r.speed);
  return {
    kind: r.kind,
    flags: r.flags,
    ammo: r.ammo,
    ammoCap: r.cap,
    rounds: r.rounds,
    burstGap: gapUnits(r.burstGap),
    roundGap: gapUnits(r.roundGap),
    damage: r.damage,
    blast: metres(r.w0e),
    reach: metres(r.w10),
    speed,
    // A ballistic round leaves at its speed (the arc's `speed << 4`); a missile
    // with an acceleration at an eighth of it.
    launchSpeed: !ballistic && r.accel > 0 ? speed / 8 : speed,
    accel: acceleration(r.accel),
    range: ballistic ? 0 : metres(r.range),
    gravity: ballistic ? metres(r.range) : 0,
    fuseTicks: Math.ceil(gapUnits(r.fuse) / WEAPON_UNITS_PER_TICK),
    fuseUnits: gapUnits(r.fuse),
    rec: r,
  };
}

/**
 * Sim ticks a burst cycle takes under the X1's cooldown rule (balance.ts
 * WEAPON_UNITS_PER_TICK): each round adds its gap, the cooldown decays 10 a
 * tick floored at zero, and a round goes out whenever it is back at zero.
 */
function cycleTicks(b: WeaponBlock): number {
  let ticks = 0;
  let cd = 0;
  for (let r = 1; r <= b.rounds; r++) {
    cd += r === b.rounds ? b.burstGap : b.roundGap;
    if (r === b.rounds || cd > 0) {
      // Wait until it is back at zero: whole ticks of 10 units.
      const wait = cd > 0 ? Math.ceil(cd / WEAPON_UNITS_PER_TICK) : 1;
      ticks += wait;
      cd = 0;
    } else {
      ticks += 1;
    }
  }
  return ticks;
}

function def(
  id: number,
  slot: 0 | 1 | 2,
  index: number,
  name: string,
  blurb: string,
  code: number,
  delivery: WeaponDelivery,
  projKind: number,
  vfx: WeaponVfx,
  extraBit = 0,
): WeaponDef {
  const rec = WEAPON_RECORDS[code];
  const a = block(rec.a);
  const b = block(rec.b);
  const cycle = delivery === "flame" ? FLAME_PULSE_TICKS : cycleTicks(a);
  const range =
    a.gravity > 0 && (delivery === "arced" || delivery === "bounce")
      ? (a.launchSpeed * a.launchSpeed) / a.gravity
      : a.range;
  return {
    id,
    slot,
    index,
    name,
    blurb,
    code,
    delivery,
    a,
    b,
    projKind,
    vfx,
    damage: a.damage,
    cooldownTicks: cycle / a.rounds,
    range,
    ammo: a.ammo,
    extraBit,
  };
}

export const GUNS: readonly WeaponDef[] = [
  def(
    0,
    0,
    0,
    "Powered Mini-Gun",
    "Twin miniguns: 1 damage a round, every tick, at the lock.",
    0x00,
    "hitscan",
    0,
    "minigun",
  ),
  def(
    1,
    0,
    1,
    "Gatling Laser",
    "The Mini-Gun's twin in the record: 1 damage a tick, a smaller magazine.",
    0x01,
    "hitscan",
    0,
    "laser",
  ),
  def(
    2,
    0,
    2,
    "Flamethrower", // the original's front-end spelling
    "A stream of fire on the lock: 6 damage a hit.",
    0x02,
    "flame",
    0,
    "flame",
  ),
  // Original Gun id 0x03. Block B arcs to two more targets in the original;
  // the arc is not modelled (its reach was not read), so B is a harder link only.
  def(
    9,
    0,
    3,
    "Electric Gun",
    "A 3-damage link every other tick, 9.6 m.",
    0x03,
    "hitscan",
    0,
    "electric",
  ),
  // The original's Gun 0x05, a campaign weapon (EXTRA_WEAPON_RIOT_SHIELD).
  def(
    15,
    0,
    4,
    "Riot Shield",
    "A sphere toggled on: 20 a tick to what it touches, 1.6 m.",
    0x05,
    "sphere",
    0,
    "shield",
    EXTRA_WEAPON_RIOT_SHIELD,
  ),
];

export const HEAVIES: readonly WeaponDef[] = [
  def(
    3,
    1,
    0,
    "Hell Fire 2000", // the original's front-end name
    "Homing missile on the lock, 25 damage, two a second.",
    0x10,
    "missile",
    PROJ_HEAVY,
    "rocket",
  ),
  // Original Heavy (`Beam Cannon`, id 0x12). Index 1 so the original kit order
  // Hell Fire → Concussion → Hyper matches the PA weapons screen.
  def(
    8,
    1,
    1,
    "Concussion Beam",
    "A beam to the lock that bursts for 50 in a 1 m radius.",
    0x12,
    "beam",
    PROJ_BEAM,
    "beam",
  ),
  // Original Heavy id 0x13 (display: Hyper Velocity Rocket).
  def(
    10,
    1,
    2,
    "Hyper Velocity Rocket",
    "Four lead-aimed rockets on four ticks, 30 damage each.",
    0x13,
    "missile",
    PROJ_HYPER,
    "hyper",
  ),
  // The original's Heavy 0x15 (the executable's "Robo Dog"; EXTRA_WEAPON_K9_DRONE).
  def(
    16,
    1,
    3,
    "K-9 Drone",
    "A ground-hugging homing drone, 150 damage, 300 health, every 3 s.",
    0x15,
    "drone",
    PROJ_K9,
    "drone",
    EXTRA_WEAPON_K9_DRONE,
  ),
  // The original's Heavy 0x14 (EXTRA_WEAPON_FUSION_TORPEDO).
  def(
    17,
    1,
    4,
    "Fusion Torpedo",
    "Homing torpedo, 100 in a 1 m blast that weakens with the distance flown.",
    0x14,
    "missile",
    PROJ_TORPEDO,
    "torpedo",
    EXTRA_WEAPON_FUSION_TORPEDO,
  ),
];

export const SPECIALS: readonly WeaponDef[] = [
  def(
    7,
    2,
    0,
    "Mortar Launcher", // the original's front-end name + default special
    "Lobbed shell: 200 in a 3.2 m blast, about 10 m reach.",
    0x20,
    "arced",
    PROJ_MORTAR,
    "mortar",
  ),
  def(
    13,
    2,
    1,
    "Pop-Up Mines",
    "Drop a charge: 600 in a 5.6 m blast, 1 s after it is sprung.",
    0x22,
    "mine",
    PROJ_MINE,
    "mine",
  ),
  def(
    14,
    2,
    2,
    "Shockwave Generator",
    "Self-centred pulse: 300 within 6 m.",
    0x23,
    "shockwave",
    PROJ_SHOCKWAVE,
    "shockwave",
  ),
  // The original's Special 0x24 (the executable's "Grenade"; EXTRA_WEAPON_GRENADE_LAUNCHER).
  def(
    18,
    2,
    3,
    "Grenade Launcher",
    "A bouncing grenade, 400 in a 4.2 m blast after 3-4.5 s, or on the next press.",
    0x24,
    "bounce",
    PROJ_GRENADE,
    "grenade",
    EXTRA_WEAPON_GRENADE_LAUNCHER,
  ),
  // The original's Special 0x21 (EXTRA_WEAPON_PLASMA_FLARE).
  def(
    19,
    2,
    4,
    "Plasma Flare",
    "Lobbed flare, 250 in a 6 m blast where it lands, or on the next press.",
    0x21,
    "arced",
    PROJ_PLASMA,
    "plasma",
    EXTRA_WEAPON_PLASMA_FLARE,
  ),
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

/** How many of each slot's weapons Precinct Assault always offers (the ten). */
const BASE_COUNT: readonly number[] = [4, 3, 3];

/**
 * Clamp a loadout index into the slot's catalog, refusing an extra weapon whose
 * bit `extraWeapons` (SimOptions.extraWeapons, EXTRA_WEAPON_*) does not carry: a
 * refused index lands on the slot's last Precinct Assault weapon, where every
 * out-of-range index landed before the five were appended — so with no bits set
 * the clamp is exactly the ten-weapon catalogue's, and no peer, replay or deep
 * link can smuggle one in.
 */
export function clampLoadoutIndex(slot: 0 | 1 | 2, index: number, extraWeapons = 0): number {
  const list = BY_SLOT[slot];
  if (!Number.isFinite(index)) return 0;
  let i = Math.floor(index);
  if (i < 0) return 0;
  if (i >= list.length) i = list.length - 1;
  if ((list[i].extraBit & ~extraWeapons) !== 0) return BASE_COUNT[slot] - 1;
  return i;
}

/** Whether `extraWeapons` offers `w` (always, for the ten). */
export function weaponOffered(w: WeaponDef, extraWeapons: number): boolean {
  return (w.extraBit & ~extraWeapons) === 0;
}

export function normalizeLoadout(raw?: Partial<Loadout> | null, extraWeapons = 0): Loadout {
  return {
    gun: clampLoadoutIndex(0, raw?.gun ?? 0, extraWeapons),
    heavy: clampLoadoutIndex(1, raw?.heavy ?? 0, extraWeapons),
    special: clampLoadoutIndex(2, raw?.special ?? 0, extraWeapons),
  };
}

export function weaponInSlot(slot: 0 | 1 | 2, index: number, extraWeapons = 0): WeaponDef {
  const list = BY_SLOT[slot];
  return list[clampLoadoutIndex(slot, index, extraWeapons)];
}

/** Resolve the three weapons a player is carrying. */
export function resolveLoadout(
  loadout: Loadout,
  extraWeapons = 0,
): {
  gun: WeaponDef;
  heavy: WeaponDef;
  special: WeaponDef;
} {
  const l = normalizeLoadout(loadout, extraWeapons);
  return {
    gun: GUNS[l.gun],
    heavy: HEAVIES[l.heavy],
    special: SPECIALS[l.special],
  };
}

/**
 * The original's weapons the catalogue does not carry: none since SIM_VERSION
 * 90. The five Precinct Assault never offers (Riot Shield 0x05, Fusion Torpedo
 * 0x14, K-9 Drone 0x15, Plasma Flare 0x21, Grenade Launcher 0x24) are appended
 * above, each behind its SimOptions.extraWeapons bit (fcop-fidelity.md W1, W5).
 */
export const NOT_ADOPTED_CODES: readonly number[] = [];
