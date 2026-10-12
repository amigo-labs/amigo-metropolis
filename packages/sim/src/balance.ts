// ALL gameplay constants live here (CLAUDE.md workflow rule) — never inline
// numbers in systems. Values are seeded from docs/specs/rules.md and are
// placeholders until playtesting tunes them.

/** Fixed simulation rate. All gameplay time is measured in ticks. */
export const TICK_HZ = 30;
/** Seconds per tick (1/30 is not a power of two, but the division is exact and shared). */
export const TICK_DT = 1 / TICK_HZ;

/** Fixed entity cap — SoA storage is preallocated, never grows (architecture.md §2). */
export const MAX_ENTITIES = 1024;
export const MAX_PLAYERS = 2;

/**
 * Local input delay in ticks (architecture.md §4): even solo play routes
 * inputs through this queue so online (3 ticks) feels near-identical.
 */
export const LOCAL_INPUT_DELAY_TICKS = 2;

/**
 * Online input delay in ticks (architecture.md §5): a client tags its local
 * input for tick T+this and only steps a tick once it holds BOTH players'
 * confirmed inputs for it. 3 ticks ≈ 100 ms of round-trip slack. Kept one
 * above LOCAL_INPUT_DELAY_TICKS so the added lag online is a single tick.
 */
export const ONLINE_INPUT_DELAY_TICKS = 3;

/**
 * P2P input redundancy (hosting.spec.md §3.1, §9): every packet on the
 * unreliable DataChannel carries the last k ticks of local input, so any
 * single lost packet is covered by the next one. k = delay + 2 gives two
 * packets of slack beyond the lockstep window; tune empirically.
 */
export const P2P_INPUT_REDUNDANCY_TICKS = ONLINE_INPUT_DELAY_TICKS + 2;

// Avatar (rules.md §2, §4).
/**
 * The X1-Alpha's health: 1250, the original's NORMAL mech (fcop-fidelity.md P1).
 * Every PA X1Alpha record stores a base of 1000; `player_construct` scales it by
 * the per-player difficulty word, 100/125/150 % (`imul ecx,ecx,0x64` at
 * 0x00446c3c), and NORMAL is the default pick (fcop-re/player-and-weapons.md §5).
 * Metropolis has no difficulty choice and models NORMAL, as it does for the
 * walker's water rule and the ammunition (x1.25). No regeneration: health comes
 * back only from a pickup or the restore at going down. Every damage number in
 * this file is absolute HP against it, as the original's are. Was 300.
 */
export const AVATAR_HP = 1250;

// Slope limits as rise/run: the steepest ground each form's hard gate lets it
// climb (sim.ts `slopeBlocks`). Hover stays stricter, because it rides
// clearance and trades terrain for speed and water. Map authoring relies on
// these — the district-01 schema test checks lane traversability against the
// walker limit.
//
// The WALKER's is the original's, since SIM_VERSION 39 (fcop-fidelity.md P4).
// The original has no hard slope wall at all (fcop-re/player-and-weapons.md §4):
// its walker climbs until the downhill push 40 (t - 0.3)³ lift' 0.59375 per step
// outgrows its 1.5 fore push. Metropolis runs that push now (sim.ts
// `slopePush`), and in its horizontal model the two cross at a gradient of
// 1.043 (46°); the gate sits just under it, at 1.04, where the walker still
// creeps uphill, so the gate and the physics agree on what is climbable and
// `worstUphillRise` stays an exact mirror. It was 0.6 (31°), Metropolis' own,
// which the original's walker walks straight up — and which, with the
// original's jump (no air control, a 2.1 m/s lunge), would have left the walker
// unable to climb a 0.7 m terrain step at all.
//
// The hover limit was 0.35 until issue #34 measured it against the geometry it
// has to drive. Over the span below, the steepest sustained climb anywhere in
// la-cantina's road network — the one arena whose roads the walker finds clean —
// is 0.40. On the other three the sustained climbs run from 0.35 to 1.5 with
// their mass at 0.50 and up, which is the arenas' 1.3-3 m terrain steps rather
// than their roads. So 0.35 sat below the roads themselves, and 0.50 admits the
// roads' own ramps while still rejecting the terrain — with the walker clear
// above it. The original's hover has no hard gate either; its push stalls near
// 0.62 (32°) by the same arithmetic, but the hover's gate is issue #34's measured
// rule with its cushion span and stays Metropolis' (fcop-fidelity.md P5).
export const AVATAR_WALKER_MAX_SLOPE = 1.04;
export const AVATAR_HOVER_MAX_SLOPE = 0.5;

/**
 * Distance, in metres, the hover judges a climb over: the length of its cushion,
 * NOT the size of its hull.
 *
 * A cushion riding HOVER_CLEARANCE off the ground rides over a step its span
 * covers; what stops it is ground that keeps climbing. Sampled per tick those are
 * one reading, and a pessimistic one: 0.3 m into a 0.17 m kerb the gradient is
 * 0.58, and a diagonal crossing of a bilinear cell is quadratic, so it reads
 * worse still. So the gate consults both — a step steeper than the limit blocks
 * only if the ground a span ahead is over the limit too (sim.ts `slopeBlocks`).
 * That is what stopped the hover dead against 17 cm kerbs on the original's
 * streets (issue #34).
 *
 * THIS DOES NOT SCALE WITH THE AVATAR. It used to be documented as
 * "2 x ARCHETYPE_RADIUS[AVATAR], the avatar's own footprint diameter", with
 * avatarMovement.test.ts pinning the relationship — and when the models came
 * down to the size the original authored (assets.md §4) that read as licence to
 * take this to 0.8 with them. Measured, that costs the #34 fix outright: road
 * edges the hover cannot take go 0→10 on la-cantina, which was the one clean
 * arena, 20→49 on urban-jungle, 44→53 and 45→53 on proving-ground and bug-hunt,
 * and the teams that can drive their whole network drop from 2 to 1 on three of
 * the four. The kerbs it has to ride over are TERRAIN, and terrain did not
 * shrink. The number is sized against them and stays where it was measured.
 *
 * It still caps what the hover climbs in one step at span x limit = 1.2 m, below
 * the walker's 1.4 m jump, so the walker keeps more ground on both axes of the
 * asymmetry.
 */
export const HOVER_CUSHION_SPAN = 2.4;

// Transform & jump (rules.md §2).
/**
 * The walker <-> hover change: 41 ticks, 1.365 s (fcop-fidelity.md P3).
 *
 * The original's `player_transform_step` (retail 0x00442120) runs the change's
 * progress from 0 to 0x10000 at 160 per engine unit: 409.6 units at 300 Hz =
 * 40.96 sim ticks, the same both ways (fcop-re/player-and-weapons.md §2,
 * `lea edx,[eax+eax*4]; shl edx,5` at 0x0044233b). Was 24 (0.8 s), which was
 * sized to the morph animation; the morph is timed off this constant, so it
 * now plays over the original's 1.365 s.
 *
 * What the window locks is the original's too: movement, turning, jumping and
 * the lock cycle, NOT the weapons — all three fire buttons keep working, and the
 * hull coasts on hover physics for the whole ramp in both directions while its
 * ride height ramps. (Metropolis used to lock the weapons as well.)
 */
export const TRANSFORM_LOCK_TICKS = 41;

// --- X1-Alpha movement (rules.md §2; fcop-fidelity.md P4, P5) ----------------
//
// The original's two movement models, `player_hover_tick` (retail 0x00442510)
// and `player_walk_tick` (0x00444100), read in fcop-re/player-and-weapons.md
// §3-§5. Their numbers are 16.16 fixed point per MOVEMENT STEP: the player tick
// runs one step per 8 engine units of its 300 Hz clock, 37.5 steps/s, and a
// velocity of 1.0 moves 256 world units a step (8192 wu = 1 m).
//
// HOW THEY RUN AT 30 Hz. A sim tick is X1_STEPS_PER_TICK = 1.25 steps. Each step
// does `v += push - d * v` (drag d, push P, both per step), whose steady speed is
// P / d and whose solution after n steps is exactly
//
//     v_n = P/d + (v_0 - P/d) * (1 - d)^n.
//
// So the sim applies one tick as n = 1.25 steps of that closed form: the
// retention per tick is (1 - d)^1.25 = (1 - d) * sqrt(sqrt(1 - d)), which needs
// only Math.sqrt (IEEE-exact, CLAUDE.md rule 1). Steady speeds, time constants
// and coast half-lives are the original's exactly; only the within-tick path is
// sampled at 30 Hz. Per-step accelerations that are not drag-coupled (gravity,
// the jump lifts) are multiplied by the steps per tick, and the position
// integrates semi-implicitly (velocity first, then position), as the original's
// steps do. The original's own frame rate varies (8-60 engine units a frame);
// lockstep pins it at the 30 fps it ran at most, delta = 10 units a frame, which
// is what the turn ramp and the idle timer below count in.

/** Movement steps per sim tick: (300 Hz / 8) / TICK_HZ. */
export const X1_STEPS_PER_TICK = 300 / 8 / TICK_HZ;
/** Engine units of the 300 Hz clock per sim tick (the original's frame delta at 30 fps). */
export const X1_UNITS_PER_TICK = 300 / TICK_HZ;
/** A 16.16 velocity of 1.0 per step, in m/s: 256 wu/step * 37.5 steps/s / 8192 wu/m. */
export const X1_SPEED_UNIT = 1.171875;
/** One 16.16 value as a fraction. */
const FX = 1 / 65536;
/** Retention of one sim tick under a per-step drag `d`: (1 - d)^1.25, sqrt-only. */
export function retentionPerTick(d: number): number {
  const k = 1 - d;
  return k * Math.sqrt(Math.sqrt(k));
}

/**
 * Gravity, both forms: 0x9800 = 0.59375 per step per step, 26.09 m/s²
 * (`change[1] -= 0x9800`, 0x00442aa2). Was GRAVITY 20 for the walker.
 */
export const X1_GRAVITY = 0x9800 * FX * X1_SPEED_UNIT * (300 / 8);
/** Terminal fall: -12.0 per step (`0xfff40000`, 0x00442ad5) = 14.06 m/s. */
export const X1_TERMINAL_FALL = 12 * X1_SPEED_UNIT;
/**
 * The diagonal: a fore/aft push with a sideways bit is scaled by 181/256 along
 * the heading turned an eighth of a turn (unnormalised, length sqrt 2), so a
 * diagonal pushes as hard as straight ahead (`player_heading_push`).
 */
export const X1_DIAGONAL_SCALE = 181 / 256;
/**
 * sin(22.5°): Metropolis' stick is analogue, the original's input digital
 * (its stick path is dead in retail). The stick, in the hull's frame, is read
 * as the original's bits: a fore/aft bit when its component along the facing
 * is over sin 22.5° of its length, a sideways bit likewise across it — the
 * eight 45° sectors of a d-pad. A keyboard's unit diagonals land on the
 * diagonals. The stick's length scales the push (the original's own stick
 * path, `push = mag * push >> 7`, at 0x004428be).
 */
export const X1_STICK_SECTOR = 0.3826834323650898;
/**
 * Impact (landing) damage, `player_impact_damage` (0x004438e0): none at or
 * below 0x93333 per step = 10.78 m/s of fall; above it x = (v - 10.78) * 0.3048
 * (v clamped to 56.25 m/s), f(x) = 0.6124x up to 0.5, 0.866x^1.5 up to 0.75, x²
 * above, and the damage is 1000 * f(x) ABSOLUTE HP on every difficulty
 * (fcop-re/player-and-weapons.md §5). ~40 HP at 11 m/s, ~1000 at the 14.06 m/s
 * terminal fall.
 */
export const X1_IMPACT_SPEED = 0x93333 * FX * X1_SPEED_UNIT;
export const X1_IMPACT_SPEED_MAX = 0x300000 * FX * X1_SPEED_UNIT;
export const X1_IMPACT_SCALE = 0x16db6c15 / 0x40000000 / X1_SPEED_UNIT;
export const X1_IMPACT_HP = 1000;

// Hover (`player_hover_tick`; fcop-re/player-and-weapons.md §3).
/** Fore/aft push 0x6666 per step (0x00442850). */
export const HOVER_PUSH_FORE = 0x6666 * FX * X1_SPEED_UNIT;
/** Strafe push 0x2000 per step (0x00442884). */
export const HOVER_PUSH_STRAFE = 0x2000 * FX * X1_SPEED_UNIT;
/** Drag 0x0ccc = 0.05 of the velocity per step, horizontal always (0x004427b9). */
export const HOVER_DRAG = 0xccc * FX;
/** Brake drag 0x2666 = 0.15 (0x004428a5): the jump button, in hover, grounded. */
export const HOVER_BRAKE_DRAG = 0x2666 * FX;
/**
 * Idle ramp: the idle timer counts engine units while nothing drives the
 * hover, capped at 0x800; past 0x700 (5.97 s) the drag climbs
 * (idle - 0x700) * 21300 / 256 per 65536, to 0x6000 = 0.375 at 0x800 (6.83 s).
 */
export const HOVER_IDLE_KNEE = 0x700;
export const HOVER_IDLE_CEILING = 0x800;
export const HOVER_IDLE_SLOPE = 21300 / 256;
/** Top speed fore/aft: push / drag = 9.38 m/s. Was AVATAR_HOVER_SPEED 9. */
export const AVATAR_HOVER_SPEED = HOVER_PUSH_FORE / HOVER_DRAG;
/** Hard cap on horizontal speed: 0x92147 per step = 10.70 m/s (0x00442b1c). */
export const HOVER_SPEED_CAP = 0x92147 * FX * X1_SPEED_UNIT;
/** Undriven and grounded, every component under 0x2000 = 0.146 m/s stops dead. */
export const HOVER_STOP_SPEED = 0x2000 * FX * X1_SPEED_UNIT;
/**
 * The turn: a rate word steps by the frame delta each step toward the side
 * turned to (from zero on a reversal or release), clamped at 0x60, and the
 * facing turns by half of it a step: 48 units = 158.2°/s at most, reached in
 * ~0.26 s at 30 fps. 4096 units = one turn.
 */
export const HOVER_TURN_LIMIT = 0x60;
/** Ride height 0x1000 wu = 0.5 m above ground or water (`word_f2`). Was 0.3. */
export const HOVER_CLEARANCE = 0x1000 / 8192;
/**
 * Held down within 0xcc wu (2.5 cm) of its ride height a step, else airborne
 * (0x00442cea). Per tick it covers 1.25 steps of ground, so the band is scaled
 * to keep the same slope at which a fast hover leaves the ground.
 */
export const HOVER_HOLD_DOWN = (0xcc / 8192) * X1_STEPS_PER_TICK;
/** The surface tilt (normal's horizontal length) where its downhill push starts: 0.25 (14.5°). */
export const HOVER_SLOPE_KNEE = 0x4000 * FX;
/** Downhill push = gain * (tilt - knee)³ * lift * 0.59375 per step (`shl eax, 5`). */
export const HOVER_SLOPE_GAIN = 32;

// Walker (`player_walk_tick` + `player_velocity_delta`; player-and-weapons.md §4).
/** Fore/aft push 0x18000 per step (0x004445ec). */
export const WALKER_PUSH_FORE = 0x18000 * FX * X1_SPEED_UNIT;
/** Strafe push 0x10000 per step (0x0044465d). */
export const WALKER_PUSH_STRAFE = 0x10000 * FX * X1_SPEED_UNIT;
/** Ground drag 0x6000 = 0.375 per step on every axis: "effectively instant". */
export const WALKER_DRAG = 0x6000 * FX;
/** Airborne horizontal drag 0x666 = 0.025 per step, and no push at all. */
export const WALKER_AIR_DRAG = 0x666 * FX;
/** Top speed fore/aft: push / drag = 4.69 m/s. Was 5. */
export const AVATAR_WALKER_SPEED = WALKER_PUSH_FORE / WALKER_DRAG;
/** Undriven on the ground, a largest component under 0x8000 = 0.586 m/s stops dead. */
export const WALKER_STOP_SPEED = 0x8000 * FX * X1_SPEED_UNIT;
/**
 * Turn: 0x20 units a step on the ground, less (|v| >> 11) * 0x20 >> 9, i.e.
 * 105.5°/s at rest falling linearly to 0 at 18.75 m/s (79°/s at a full run).
 * No ramp, no turning in the air.
 */
export const WALKER_TURN_STEP = 0x20;
export const WALKER_TURN_ZERO_SPEED = ((512 * 2048) / 65536) * X1_SPEED_UNIT;
/** The surface tilt where the walker's downhill push starts: 0x4ccc (17.5°). */
export const WALKER_SLOPE_KNEE = 0x4ccc * FX;
export const WALKER_SLOPE_GAIN = 40;
/** Steep (no jump, no leap): the surface normal's horizontal part over 0.625 (38.7°). */
export const WALKER_STEEP_TILT = 0xa000 * FX;
/**
 * The jumps (`player_walk_tick` 0x004444e9 jump table). One button, three jumps,
 * chosen the way the original chooses them:
 * - running forward: the LEAP, lift 0x64000 = 7.32 m/s plus a forward push of
 *   1.5 (+1.76 m/s) on top of the run;
 * - otherwise, if the ground 1 m ahead rises more than 0xae1 (0.34 m): the HIGH
 *   jump, lift 0x78000 = 8.79 m/s straight up, and 9 steps (0.24 s) later a
 *   one-off forward LUNGE of 0x1cccc = +2.11 m/s — unless the rise ahead is over
 *   0x2333 (1.1 m), when there is no lunge;
 * - otherwise the HOP: lift 0x58000 = 6.45 m/s plus a forward push of 4.0
 *   (+4.69 m/s).
 * The crouch before the high jump and the hop is animation data the RE has not
 * read (player-and-weapons.md §9.6), so they launch at once. No air control.
 */
export const WALKER_LEAP_LIFT = 0x64000 * FX * X1_SPEED_UNIT;
export const WALKER_LEAP_PUSH = 0x18000 * FX * X1_SPEED_UNIT;
export const WALKER_HIGH_LIFT = 0x78000 * FX * X1_SPEED_UNIT;
export const WALKER_HOP_LIFT = 0x58000 * FX * X1_SPEED_UNIT;
export const WALKER_HOP_PUSH = 0x40000 * FX * X1_SPEED_UNIT;
export const WALKER_LUNGE_PUSH = 0x1cccc * FX * X1_SPEED_UNIT;
/** 9 steps after take-off = 0.24 s = 7.2 ticks. */
export const WALKER_LUNGE_TICKS = 7;
/** Where the high-jump probe looks: 1 m ahead (sine >> 3), from 8 m up. */
export const WALKER_PROBE_AHEAD = 1;
export const WALKER_PROBE_LIFT = 8;
/** Rise ahead that makes it a high jump instead of a hop: 0xae1 wu = 0.34 m. */
export const WALKER_HIGH_RISE = 0xae1 / 8192;
/** Rise ahead past which the high jump gets no lunge: 0x2333 wu = 1.1 m. */
export const WALKER_LUNGE_MAX_RISE = 0x2333 / 8192;
/** Jump take-off speed of the high jump (kept under its old name for its readers). */
export const AVATAR_JUMP_SPEED = WALKER_HIGH_LIFT;

// --- The X1-Alpha's weapons (rules.md §2; fcop-fidelity.md W1, W2, W4) -------
//
// The original's own records, not the front-end bars. Every mission carries the
// player's 15 weapons as type-99 Cact records, byte-identical in all 15 missions
// including the six PA maps: `{key, key >> 4, 0, 0, block A[0x20], block B[0x20]}`,
// A the weapon as issued and B the weapon after that slot's power-up
// (fcop-re/player-and-weapons.md §7, player-weapons.json; loader 0x00458c60, the
// rescale helpers 0x00458d30 / 0x0044eb10). These are the raw halfwords of the ten
// Metropolis offers (weapons.ts maps them to its catalogue); weapons.ts converts
// them the way the loader does:
//   - gaps (`burstGap`, `roundGap`, `fuse`): raw * 4096 / 218, C-truncated, in
//     engine units of 1/300 s (~raw * 0.0626 s); the X1 spends 10 a sim tick;
//   - ammunition (`ammo`, `cap`): x1.25 on NORMAL, truncated (the per-player
//     difficulty pick; Metropolis models NORMAL, as AVATAR_HP does);
//   - lengths (`w0e` blast, `w10` reach, `range`): raw << 4 wu = raw / 512 m;
//     for arced and dropped rounds `range` is their GRAVITY in wu/s², raw / 512
//     m/s² (type7.h:50);
//   - `speed`: trunc(raw / 300) << 4 wu per engine unit; `accel`: trunc(raw * 256
//     / 300) / 16 wu per unit per unit. A missile launches at an eighth of its
//     top speed and accelerates to it (player-weapons.json `missile`).
// `kind` picks the launcher, `flags` bit 4 is a kept round (Special becomes a
// press-edge trigger), bit 2 damage falloff with distance flown, bit 8 spin.
export interface WeaponRecord {
  readonly kind: number;
  readonly flags: number;
  readonly ammo: number;
  readonly cap: number;
  readonly rounds: number;
  readonly burstGap: number;
  readonly roundGap: number;
  readonly damage: number;
  readonly w0e: number;
  readonly w10: number;
  readonly speed: number;
  readonly accel: number;
  readonly range: number;
  readonly fuse: number;
}

/** Block A (as issued) and block B (powered up) of one weapon, keyed by its loadout code. */
export const WEAPON_RECORDS: Readonly<Record<number, { a: WeaponRecord; b: WeaponRecord }>> = {
  // Powered Mini-Gun (the executable's "Mini Gun")
  0: {
    a: {
      kind: 10,
      flags: 0,
      ammo: 6000,
      cap: 6000,
      rounds: 1,
      burstGap: 0,
      roundGap: 0,
      damage: 1,
      w0e: 0,
      w10: 0,
      speed: 8192,
      accel: 0,
      range: 6144,
      fuse: 80,
    },
    b: {
      kind: 10,
      flags: 0,
      ammo: 0,
      cap: 600,
      rounds: 1,
      burstGap: 0,
      roundGap: 0,
      damage: 2,
      w0e: 512,
      w10: 0,
      speed: 8192,
      accel: 0,
      range: 6144,
      fuse: 80,
    },
  },
  // Gatling Laser (the executable's "Laser")
  1: {
    a: {
      kind: 12,
      flags: 0,
      ammo: 5000,
      cap: 5000,
      rounds: 1,
      burstGap: 0,
      roundGap: 0,
      damage: 1,
      w0e: 0,
      w10: 0,
      speed: 8192,
      accel: 0,
      range: 6144,
      fuse: 80,
    },
    b: {
      kind: 12,
      flags: 0,
      ammo: 0,
      cap: 600,
      rounds: 1,
      burstGap: 0,
      roundGap: 0,
      damage: 2,
      w0e: 512,
      w10: 0,
      speed: 8192,
      accel: 0,
      range: 6144,
      fuse: 80,
    },
  },
  // Flamethrower (the executable's "Flame Thrower")
  2: {
    a: {
      kind: 14,
      flags: 0,
      ammo: 3000,
      cap: 3000,
      rounds: 1,
      burstGap: 0,
      roundGap: 0,
      damage: 6,
      w0e: 409,
      w10: 0,
      speed: 8192,
      accel: 0,
      range: 6144,
      fuse: 80,
    },
    b: {
      kind: 14,
      flags: 0,
      ammo: 0,
      cap: 600,
      rounds: 1,
      burstGap: 0,
      roundGap: 1,
      damage: 10,
      w0e: 819,
      w10: 0,
      speed: 8192,
      accel: 0,
      range: 6144,
      fuse: 80,
    },
  },
  // Electric Gun (the executable's "Electric Gun")
  3: {
    a: {
      kind: 11,
      flags: 0,
      ammo: 3000,
      cap: 3000,
      rounds: 1,
      burstGap: 1,
      roundGap: 0,
      damage: 3,
      w0e: 0,
      w10: 0,
      speed: 8192,
      accel: 0,
      range: 4915,
      fuse: 80,
    },
    b: {
      kind: 11,
      flags: 0,
      ammo: 0,
      cap: 500,
      rounds: 1,
      burstGap: 1,
      roundGap: 0,
      damage: 6,
      w0e: 0,
      w10: 0,
      speed: 8192,
      accel: 0,
      range: 4915,
      fuse: 80,
    },
  },
  // Hell Fire 2000 (the executable's "Helfire")
  16: {
    a: {
      kind: 3,
      flags: 1,
      ammo: 145,
      cap: 145,
      rounds: 1,
      burstGap: 8,
      roundGap: 0,
      damage: 25,
      w0e: 0,
      w10: 0,
      speed: 8192,
      accel: 122,
      range: 8192,
      fuse: 48,
    },
    b: {
      kind: 18,
      flags: 1,
      ammo: 0,
      cap: 15,
      rounds: 1,
      burstGap: 12,
      roundGap: 0,
      damage: 25,
      w0e: 0,
      w10: 0,
      speed: 8192,
      accel: 204,
      range: 8192,
      fuse: 48,
    },
  },
  // Concussion Beam (the executable's "Beam Cannon")
  18: {
    a: {
      kind: 17,
      flags: 1,
      ammo: 75,
      cap: 75,
      rounds: 1,
      burstGap: 16,
      roundGap: 16,
      damage: 50,
      w0e: 512,
      w10: 0,
      speed: 8192,
      accel: 4096,
      range: 4096,
      fuse: 80,
    },
    b: {
      kind: 17,
      flags: 1,
      ammo: 0,
      cap: 15,
      rounds: 1,
      burstGap: 16,
      roundGap: 16,
      damage: 100,
      w0e: 1024,
      w10: 0,
      speed: 8192,
      accel: 4096,
      range: 8192,
      fuse: 80,
    },
  },
  // Hyper Velocity Rocket (the executable's "Ant Missle?")
  19: {
    a: {
      kind: 2,
      flags: 0,
      ammo: 120,
      cap: 120,
      rounds: 4,
      burstGap: 24,
      roundGap: -2,
      damage: 30,
      w0e: 0,
      w10: 0,
      speed: 10240,
      accel: 40,
      range: 8192,
      fuse: 48,
    },
    b: {
      kind: 2,
      flags: 8,
      ammo: 0,
      cap: 80,
      rounds: 8,
      burstGap: 24,
      roundGap: -1,
      damage: 30,
      w0e: 0,
      w10: 0,
      speed: 10240,
      accel: 40,
      range: 8192,
      fuse: 48,
    },
  },
  // Mortar Launcher (the executable's "Mortar")
  32: {
    a: {
      kind: 4,
      flags: 1,
      ammo: 25,
      cap: 25,
      rounds: 1,
      burstGap: 32,
      roundGap: 32,
      damage: 200,
      w0e: 1638,
      w10: 0,
      speed: 4096,
      accel: 0,
      range: 3072,
      fuse: 48,
    },
    b: {
      kind: 20,
      flags: 1,
      ammo: 0,
      cap: 10,
      rounds: 1,
      burstGap: 16,
      roundGap: 16,
      damage: 100,
      w0e: 2048,
      w10: 0,
      speed: 4096,
      accel: 0,
      range: 3072,
      fuse: 48,
    },
  },
  // Pop-Up Mines (the executable's "Mine")
  34: {
    a: {
      kind: 5,
      flags: 1,
      ammo: 30,
      cap: 30,
      rounds: 1,
      burstGap: 16,
      roundGap: 16,
      damage: 600,
      w0e: 2867,
      w10: 1024,
      speed: 4096,
      accel: 0,
      range: 3072,
      fuse: 80,
    },
    b: {
      kind: 5,
      flags: 1,
      ammo: 0,
      cap: 15,
      rounds: 1,
      burstGap: 16,
      roundGap: 0,
      damage: 1000,
      w0e: 4096,
      w10: 1024,
      speed: 4096,
      accel: 0,
      range: 4096,
      fuse: 80,
    },
  },
  // Shockwave Generator (the executable's "Shockwave")
  35: {
    a: {
      kind: 15,
      flags: 1,
      ammo: 20,
      cap: 20,
      rounds: 1,
      burstGap: 48,
      roundGap: 48,
      damage: 300,
      w0e: 3072,
      w10: 0,
      speed: 4096,
      accel: 0,
      range: 3072,
      fuse: 48,
    },
    b: {
      kind: 15,
      flags: 1,
      ammo: 0,
      cap: 10,
      rounds: 1,
      burstGap: 16,
      roundGap: 16,
      damage: 300,
      w0e: 4096,
      w10: 0,
      speed: 4096,
      accel: 0,
      range: 4096,
      fuse: 48,
    },
  },
};

/**
 * Engine units of the 300 Hz clock a sim tick spends off a weapon's cooldown.
 * The original's slot cooldowns decay by the frame delta, floored at zero, and a
 * shot ADDS its gap (`player_target_hold` 0x0045a2a0, `player_fire_slot`
 * 0x00458ed0). Lockstep pins the frame at 30 fps, delta 10, the same binding as
 * X1_UNITS_PER_TICK. So a gap of 0 fires on every tick the button is held, 30
 * rounds a second (the original is frame-bound: 30-37.5 at its 30-37.5 fps), a
 * gap of g fires every ceil(g / 10) ticks, and a negative round gap carries over:
 * the Hyper Velocity Rocket's -37 fires its four rounds on four consecutive ticks.
 */
export const WEAPON_UNITS_PER_TICK = 300 / TICK_HZ;

/**
 * The X1-Alpha's lock (fcop-fidelity.md W2; fcop-re/player-and-weapons.md §7,
 * `player_target_acquire` 0x0045a240 / `player_target_hold` 0x0045a2a0): 0x18000
 * wu = 12 m, HORIZONTAL and centre to centre (`cact_target_score`). Was 44, sized
 * to a 40 m hitscan the original does not have.
 */
export const AVATAR_LOCK_RANGE = 0x18000 / 8192;
/**
 * The acquire cone, cos 0xf9ee (+-12.5°) about the hull's facing: the lock is
 * taken only by something nearly straight ahead, by the cycle press or by the
 * auto-acquire that runs every tick while there is no lock.
 */
export const AVATAR_LOCK_ACQUIRE_COS = 0xf9ee / 65536;
/** The hold cone, cos 0xe804 (+-25°): a lock outside it (or past 12 m) drops. */
export const AVATAR_LOCK_HOLD_COS = 0xe804 / 65536;

/**
 * The Flamethrower's damage cadence: Metropolis' own. The original's fire is a
 * sustained effect whose nodes each carry the record's 6 (B: 10) damage, and how
 * often a node hits was not established (fcop-re/player-and-weapons.md §9.1). So
 * the time profile stays Metropolis' (one hit every 5 ticks, as the old flame
 * did) and the per-hit damage, reach and ammunition are the record's.
 */
export const FLAME_PULSE_TICKS = 5;

/**
 * A homing missile's turn rate, rad/s: Metropolis' own. The original's
 * `missile_home` steering rate was not established (player-and-weapons.md §9.3);
 * the speeds, accelerations and ranges it steers are the records'.
 */
export const MISSILE_TURN_RATE = Math.PI;

/**
 * Arced and bouncing rounds aim at the lock, or with none at a point 0x10000 wu =
 * 8 m ahead at muzzle height (player-weapons.json `_no_lock_aim`).
 */
export const ARC_FREE_AIM_DISTANCE = 0x10000 / 8192;

/**
 * Where the Hell Fire 2000's powered missile splits, and how: Metropolis' own.
 * Block B is kind 0x12, a homing missile "that splits into three"; when and how
 * the split happens was not read. Metropolis launches the three at once, fanned
 * +-SPLIT_FAN rad, each homing on the lock.
 */
export const HELLFIRE_SPLIT_FAN = 0.35;

/**
 * The powered Mortar's shell (kind 0x14) bursts into four kind-4 fragments at its
 * apex (player-weapons.json); how they spread was not read. Metropolis throws
 * them as a cross at this horizontal speed relative to the shell, m/s: ours.
 */
export const MORTAR_FRAGMENT_SPREAD = 1.5;

// Pop-Up Mines: the record gives the trigger reach (w10 1024 = 2 m, plus the
// intruder's own radius), the 1.0 s fuse once sprung, and the blast. The record's
// 5.0 s lifetime field is not used: whether an untriggered mine goes off after
// 5 s or waits was not established (player-and-weapons.md §9.2). So a mine keeps
// Metropolis' 30 s silent despawn and its arming delay, both ours.
/** Live lifetime once placed; despawns without a blast if nobody trips it. Ours. */
export const SPECIAL_MINE_TTL_TICKS = 900; // 30 s
/** Ticks after placing before an enemy can spring the fuse (owner walk-off). Ours. */
export const SPECIAL_MINE_ARM_TICKS = 15; // 0.5 s
/** Sprung -> blast: 1.0 s (player-weapons.json `mine.sprung_fuse_s`). */
export const SPECIAL_MINE_FUSE_TICKS = 30;

// Muzzle geometry, shared by the sim and by the renderer's muzzle flash. They
// lived in sim.ts, where render/fx.ts could only keep a hand-copied duplicate
// and a comment asking the next reader to keep the two in lockstep.
/** How far in front of the shooter a shell appears. */
export const MUZZLE_OFFSET = 0.6;
/** Shell spawn height above the shooter's feet — the X1's gun, not its roof. */
export const MUZZLE_HEIGHT = 0.6;

// Turrets (sandbox dummies AND base ring turrets share combat stats for now).
//
// This global is dead on all six PLAYABLE arenas — each carries the original's
// imported weapon profiles at 12 m and sim.ts prefers them — so it reaches only
// district-01 (not in MAP_REGISTRY) and the sandbox, which keep Metropolis' own
// balance (fcop-fidelity.md W3).
//
// THE REACH NOTE THAT USED TO STAND HERE DISSOLVED (fcop-fidelity.md W4). It
// asked how the player's 40 m hitscan should relate to an emplacement's 12 m on
// the PA arenas and its 28 m on district-01. The original answers it: the X1's
// guns reach only their lock, and the lock is 12 m (AVATAR_LOCK_RANGE), the same
// 12 m every PA turret, tank, jet and Dreadnought gun engages at — player and
// emplacement trade at one reach. On district-01 the turret's 28 m now outreaches
// the player, and the player's answer is the original's 1250 HP: it walks in
// under fire (golden03 clears that ring from inside its reach).
export const TURRET_RANGE = 28;
export const TURRET_DAMAGE = 15;
export const TURRET_COOLDOWN_TICKS = 20;
export const DUMMY_RESPAWN_TICKS = 450; // 15 s
/**
 * Base ring + built-in defence respawn. Was 60 s (rules.md §5 placeholder).
 * At authentic density a d8 Warden strips an emplacement in ~8 s then breaks
 * contact to repair, and the ring replaced itself as fast as one superplane
 * could clear it — la-cantina stalled at ~900 core HP after fifteen minutes on
 * 5/5 seeds post multi-deck. 120 s restores finishes on la-cantina and
 * proving-ground (issue #31); urban-jungle needed the escort/capture ladder
 * fix in warden.ts as well.
 */
export const BASE_TURRET_RESPAWN_TICKS = 3600; // 120 s (rules.md §5, #31)

// Ammo/repair pad (rules.md §5): ammo refills instantly, hp regenerates.
/**
 * Metropolis' own, kept as it was: the original's PA has no repair pad (health
 * comes back only from the health pickup and the restore at going down,
 * fcop-re/player-and-weapons.md §5). 15 hp/s fills the 1250-HP mech in 83 s (it
 * filled the old 300 in 20 s); scaling it with AVATAR_HP would have made an X1
 * parked on its pad outheal a turret and the Warden's cannon together.
 */
export const PAD_REPAIR_HP_PER_TICK = 0.5; // 15 hp/s

// Economy (rules.md §3). One resource: points, open information. The numbers are
// the original's (fcop-re/ai-and-rules.md §2, §8; fcop-fidelity.md R2-R10): all
// six PA arenas run identical economy scripts, and none of the rules below reads
// PA-only map data, so they apply on every arena, district-01 included.
/** Both sides start with 10 (the mission script's `W25 = 10`, ai-and-rules.md §2). */
export const STARTING_POINTS = 10;
// No trickle: no script or engine path adds points over time (ai-and-rules.md §2,
// "no trickle"). Points come only from the events below.
/**
 * An enemy Runner (tank) or Guardian (jet) dies: +1 to the OTHER side, whoever
 * killed it — the points come from the dying unit's own death script, not from
 * the kill credit (ai-and-rules.md §2, §1.8).
 */
export const POINTS_UNIT_DIES = 1;
/** The enemy's Juggernaut (Dreadnought) or Fortress dies: +5 to the other side. */
export const POINTS_HEAVY_DIES = 5;
/**
 * An enemy base turret, or a neutral turret the enemy captured, dies: +1 to the
 * other side (death scripts pool@1537/1561; turret.c 0x0041bdca for captured ones).
 */
export const POINTS_TURRET_DIES = 1;
/** Capturing a neutral turret: +1 to the capturer (turret.c 0x0041cb7b). */
export const POINTS_CAPTURE_TURRET = 1;
/**
 * An avatar goes down: the other side gains 10 and the downed side loses 10,
 * never below 0. A player's script pays at its respawn (`player_respawn`
 * 0x004475e9, pool@136); the Sky Captain's death script pays when it is shot down.
 */
export const POINTS_AVATAR_DOWN = 10;
export const COST_RUNNER = 1;
export const COST_GUARDIAN = 1;
export const COST_JUGGERNAUT = 50;
export const COST_FORTRESS = 50;
export const COST_OUTPOST_CLAIM = 30;
/**
 * Alive caps per side: 20 tanks and 20 jets (the pad scripts' check and
 * `SKY_UNIT_CAP 0x14`; ai-and-rules.md §1.8, §3). Base and outpost purchases
 * count against the same cap.
 */
export const RUNNER_ALIVE_LIMIT = 20;
export const GUARDIAN_ALIVE_LIMIT = 20;
/**
 * The Dreadnought and Fortress zones open the first time a side reaches 50 points
 * (fn30, ai-and-rules.md §2), and stay open. Sticky per side.
 */
export const HEAVY_UNLOCK_POINTS = 50;
/** Units bought at an owned outpost (forward spawn) cost this multiple. */
export const OUTPOST_COST_MULTIPLIER = 2;

// Console purchases: stand on the console pad and HOLD interact — one unit
// per completed hold (rules.md §3: 0.5 s per unit). FIRE2 modifier orders the
// heavy variant at base consoles and the air unit at outpost consoles.
export const CONSOLE_RADIUS = 3;
export const CONSOLE_HOLD_TICKS = 15; // 0.5 s
/** One Dreadnought and one Fortress alive per side (spawner limit 1, ai-and-rules.md §3). */
export const JUGGERNAUT_ALIVE_LIMIT = 1;
export const FORTRESS_ALIVE_LIMIT = 1;

// Neutral turret capture (rules.md §5; fcop-fidelity.md R12). Instant: an avatar
// presses the action key, a Runner or the Warden simply comes close, within the
// turret's capture range plus the capturer's own ARCHETYPE_RADIUS
// (fcop-re/ranges-turrets-capture.md Q2). The imported arenas carry the
// original's range (MapData.captureRange: 4.0 / 5.2 / 5.6 m by mission).
/** Capture range on an arena that imports none (district-01): ours. */
export const CAPTURE_RADIUS = 5;
/**
 * A destroyed neutral turret comes back neutral after 25 s: its Csac spawner's
 * tSAC is -1500 = 1500 * 5 engine ticks at 300 Hz (ranges-turrets-capture.md Q3,
 * Q5). Was 45 s.
 */
export const NEUTRAL_TURRET_RESPAWN_TICKS = 750;
/**
 * Outpost claim zone (fcop-fidelity.md R14): driving into it with
 * COST_OUTPOST_CLAIM points claims the outpost, no button and no hold — the
 * original's type-14 touch zone (fcop-re/ai-and-rules.md §2). The zone's size is
 * not in the extracted record, so it is ours: the console pad's radius, with the
 * console as the zone's visual anchor.
 */
export const OUTPOST_CLAIM_RADIUS = CONSOLE_RADIUS;
/**
 * Destroyed outpost consoles return (neutral) after this many ticks. district-01
 * only: on the imported arenas a claim is permanent, as the original's is (R14),
 * and the console cannot be destroyed.
 */
export const OUTPOST_CONSOLE_RESPAWN_TICKS = 300; // 10 s
/** Owned outposts refill ammo (no repair) within this radius of the console. */
export const OUTPOST_PAD_RADIUS = 4;

// Units (rules.md §4 placeholder stat table; dps = damage / cooldown).
export const RUNNER_SPEED = 4;
export const RUNNER_DAMAGE = 4;
export const RUNNER_COOLDOWN_TICKS = 15; // 8 dps
export const RUNNER_RANGE = 14;
export const GUARDIAN_SPEED = 7;
export const GUARDIAN_DAMAGE = 5;
export const GUARDIAN_COOLDOWN_TICKS = 15; // 10 dps
export const GUARDIAN_RANGE = 18;
export const GUARDIAN_PATROL_RADIUS = 30;
export const GUARDIAN_ASSAULT_STANDOFF = 14; // hold-off distance from the enemy core
export const JUGGERNAUT_SPEED = 2.5;
export const JUGGERNAUT_DAMAGE = 10;
export const JUGGERNAUT_COOLDOWN_TICKS = 15; // 20 dps
export const JUGGERNAUT_RANGE = 16;
export const FORTRESS_SPEED = 6;
export const FORTRESS_DAMAGE = 25;
export const FORTRESS_COOLDOWN_TICKS = 30; // 25 dps
export const FORTRESS_RANGE = 30;
export const FORTRESS_PATROL_RADIUS = 45;

// Unit movement shared knobs.
export const AIR_ALTITUDE = 6; // flyers ride this high above ground/water
export const WAYPOINT_RADIUS = 3; // lane waypoint advance distance
/**
 * Waypoint advance distance on the original Cnet graph (rules.md §9), separate
 * from the hand-authored polylines' 3 m because the two roads are not the same
 * kind of thing. A polyline lane is a wide hand-placed suggestion; a Cnet edge is
 * a metre-wide street in a wall lattice imported at 1 m resolution, and the only
 * path stage 2 validates as walkable is the edge itself. Advancing 3 m early
 * makes a unit leave that edge and cut the corner across whatever is there —
 * measured as 32% and 35% of all ground-unit ticks jammed against a wall on
 * proving-ground and bug-hunt, and produced units that cannot leave their own
 * base at all (issue #30).
 *
 * Bounded from both sides, which is what picks the number:
 *  - it has to exceed a tick's travel, or a unit steps over the node without
 *    ever sampling inside the radius and orbits it. The fastest ground unit
 *    covers 0.1333 m per tick, so 0.5 leaves 3.75x headroom — enough that a
 *    separation nudge cannot make a unit miss its waypoint either;
 *  - it has to stay small enough that the path travelled IS the path validated.
 * Measured over 3-minute Warden matches on all four PA arenas, 0.5 traverses
 * every road end to end at both ground step lengths and jams 0.0-3.1% of
 * unit-ticks, against 6.7-34.6% at 3.
 */
export const GRAPH_WAYPOINT_RADIUS = 0.5;

/**
 * Graph jam relief (issue #31's last open item, SIM_VERSION 30). The 0.5 m
 * advance radius above is load-bearing for route fidelity, but it demands that
 * every unit physically enters a half-metre disc — and under free production
 * that disc is CONTESTED: 8+ units converge on one node, UNIT_SEPARATION
 * shoves the pack off the validated centre line, and a wall bit then stands
 * between a unit and a disc it can see. Measured on urban-jungle (d8 vs idle,
 * seeds 2/4): 8-9 units at full HP displacing < 0.5 m per 10 s from minute 2
 * on, production frozen at the alive limit, match frozen. Same signature on
 * bug-hunt's escorted push (peak 10 around one mid-route node).
 *
 * The relief is NOT pathfinding (rules.md pillar 3 / §6 amendment): a unit
 * that has spent GRAPH_JAM_TICKS inside GRAPH_JAM_RADIUS of its target node
 * without arriving reads the SAME next-hop signpost that arrival would have
 * read — one array entry, no search. A healthy unit crosses that ring in
 * 2-3 s, so the 8 s clock only ever fires inside a standing crowd; the radius
 * gate keeps a long, slow first leg (console → graph entry) from ever
 * counting as a jam.
 *
 * The relief fires only in the two measured deadlock shapes (units.ts
 * advanceOnGraph): walled off the disc anywhere, or milling inside the unit's
 * OWN base pocket (GRAPH_JAM_HOME_RADIUS around its gate — Conft's pocket
 * spans ~10 m). A crowd queuing in the open behind a combat front is NOT
 * relieved: that a free unescorted trickle piles up on one defending ring
 * turret and fails there is a pinned design property (rules.md pillar 1 via
 * paAttribution.test.ts), and a relief that spread those queues broke the pin
 * on two arenas when it was measured without the gates.
 */
export const GRAPH_JAM_TICKS = 240; // 8 s without arriving = jammed
export const GRAPH_JAM_RADIUS = 8; // only ticks this close to the node count
export const GRAPH_JAM_HOME_RADIUS = 25; // own-base pocket where mills relieve

export const ORBIT_ANGULAR_SPEED = 0.6; // rad/s patrol orbit
export const UNIT_SEPARATION_RADIUS = 2.4; // friendly ground units push apart
export const UNIT_SEPARATION_PUSH = 0.5; // fraction of overlap resolved per tick

// Death & respawn (rules.md §2; fcop-fidelity.md P2).
/**
 * A player's avatar comes back 4.0 s after it goes down: `player_op4` sets the
 * countdown to 0x4b0 = 1200 engine units at 300 Hz (fcop-re/player-and-weapons.md
 * §1, retail 0x004476e3). Was 240 (8 s).
 *
 * The original's other countdown, 0x96 = 150 units (0.5 s) after a drowned or
 * sunk walker, has no path here: drowning is the HARD difficulty's (§4), and the
 * NORMAL walker Metropolis models transforms to hover in deep water instead.
 */
export const RESPAWN_TICKS = 120;
/**
 * The Warden's respawn: Metropolis' own 8 s, unchanged by P2. The Sky Captain's
 * is (14 - level) * 150 engine units (fcop-fidelity.md U3), which is the units
 * package's to adopt with the rest of the captain.
 */
export const WARDEN_RESPAWN_TICKS = 240;

// --- Warden (rules.md §7, PLAN Phase 4) -------------------------------------
// The solo-opponent superplane: flies over everything, stronger than the
// player Avatar, plays by the same economy. All decision inputs that scale
// with difficulty live in the arrays below, indexed by (difficulty - 1).

/**
 * Metropolis' own, from when the avatar had 300. The avatar has the original's
 * 1250 since SIM_VERSION 40 (fcop-fidelity.md P1), so this superplane is now the
 * weaker of the two; the Sky Captain's 250-1250 by level is U3's (the units/AI
 * package), which replaces it.
 */
export const WARDEN_HP = 450;
export const WARDEN_SPEED = 10; // a hair above hover (9): it can disengage
export const WARDEN_ALTITUDE = 7; // cruise height above ground/water surface

// Own weapon set (rules.md §7): hitscan cannon + AoE bomb, both cooldown-only
// (a superplane carries no ammo counter; returning to base is never forced).
export const WARDEN_PRIMARY_DAMAGE = 10;
export const WARDEN_PRIMARY_COOLDOWN_TICKS = 5;
export const WARDEN_PRIMARY_RANGE = 42;
export const WARDEN_HEAVY_DAMAGE = 60;
export const WARDEN_HEAVY_COOLDOWN_TICKS = 36;
export const WARDEN_HEAVY_SPEED = 25;
export const WARDEN_HEAVY_TTL_TICKS = 75;
export const WARDEN_HEAVY_AOE_RADIUS = 6;
export const WARDEN_HEAVY_RANGE = 30; // only bombs targets closer than this

// Decision-layer geometry (difficulty-independent).
//
// Ours, not the original's — though the original has a number for this shape:
// aircraft target_detection_range is 28672 raw = 56 m (raw/512), and this radius is
// the same KIND of thing, the distance at which the Warden notices a threat to
// its gate rather than the distance it shoots from. Moving 55 onto it is part
// of the reach question above and waits on the same decision.
export const WARDEN_DEFEND_RADIUS = 55;
export const WARDEN_STANDOFF = 24; // approach distance for attack goals
export const WARDEN_ESCORT_DISTANCE = 6; // hover distance from the escorted unit
export const WARDEN_RETREAT_DONE_HP_PERCENT = 80; // leave the pad at this hp

/**
 * Difficulty 1–10 knobs (PLAN Phase 4), indexed by (difficulty - 1): reaction
 * delay between decision re-plans, and the aggression percent that gates
 * harassing, Juggernaut savings and how low its hp may drop before it runs home
 * to repair. There is no income knob: the original's Sky Captain earns exactly
 * like a human side — its budget IS its Current Points (fcop-re/ai-and-rules.md
 * §1.8) — and Metropolis has no trickle left for a multiplier to scale.
 */
export const WARDEN_REACTION_TICKS: readonly number[] = [48, 42, 36, 30, 24, 18, 12, 8, 5, 3];
export const WARDEN_AGGRESSION_PERCENT: readonly number[] = [
  10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
];
export const WARDEN_RETREAT_HP_PERCENT: readonly number[] = [
  40, 38, 35, 32, 30, 28, 25, 22, 20, 15,
];
/** Runners bought per console trip. */
export const WARDEN_WAVE_SIZE: readonly number[] = [1, 1, 2, 2, 3, 3, 4, 4, 5, 6];
/**
 * Distance from the enemy core at which the Warden treats its own push as
 * committed and escorts it in instead of capturing another pad. Precinct Assault
 * arenas only (rules.md §9) — see the goal ladder in warden.ts. 0 means "never
 * commits", which is how the bottom difficulties keep giving their advantages
 * away, like WARDEN_WAVE_SIZE and WARDEN_GUARDIAN_TARGET.
 *
 * The floor that makes it useful is measured, not picked: everything defending a
 * base — its ring turrets (the "4 built-in guns" this used to count were the
 * Dreadnought's hull guns, SIM_VERSION 32) — sits within 16 m of its core, and
 * a ground unit halts at its own 14-16 m reach from the first thing it can see.
 * So below ~30 m the Warden only arrives after its push has already stalled; the
 * upper difficulties commit early enough to arrive with it.
 */
export const WARDEN_PUSH_COMMIT_RANGE: readonly number[] = [0, 0, 30, 30, 36, 36, 42, 45, 45, 50];
/**
 * How far from the tip of its own push the Warden looks for the emplacement that
 * is stopping it. Precinct Assault arenas only (rules.md §9).
 *
 * A ground unit halts at its own 14-16 m reach from the first hostile it can see,
 * so whatever is holding the tip is within roughly that distance of it; 24 m
 * covers the halt plus the spread of a base's ring without reaching across the
 * arena for a target that is not in the way.
 */
export const WARDEN_SUPPRESS_RADIUS = 24;
/**
 * How close the Warden gets to an emplacement it is suppressing.
 *
 * This is not a standoff, and that is the point. Measured over ten-minute
 * difficulty-8 matches on the four §9 arenas, a base emplacement is inside the
 * Warden's 42 m cannon range for 60-89% of the match and VISIBLE to it for 0-7%:
 * the arenas' wall lattice is dense city geometry, and a defending turret is
 * shootable from 8-17% of the directions around it at 8 m and from essentially
 * none at 20 m and beyond. Sniping one from cannon range is not a thing the map
 * allows anybody to do — a player kills these by coming down the street they
 * guard. So the Warden does the same: it closes until the wall lattice stops
 * mattering, inside the 12 m the emplacement itself reaches, and trades.
 */
export const WARDEN_SUPPRESS_DISTANCE = 3;
/** Guardians kept alive for base defense. */
export const WARDEN_GUARDIAN_TARGET: readonly number[] = [0, 0, 1, 1, 1, 2, 2, 2, 3, 3];
/** Aggression at or above this saves 50 points for a Juggernaut push. */
export const WARDEN_JUGGERNAUT_AGGRO = 60;

// Unit combat stats indexed by ARCHETYPE value (avatar/turret/projectile
// slots unused — those fight through their own constants above).
export const UNIT_RANGE: readonly number[] = [
  0, // AVATAR
  RUNNER_RANGE,
  GUARDIAN_RANGE,
  JUGGERNAUT_RANGE,
  FORTRESS_RANGE,
  0, // TURRET
  0, // PROJECTILE
  0, // CONSOLE
  0, // WARDEN
];
export const UNIT_DAMAGE: readonly number[] = [
  0,
  RUNNER_DAMAGE,
  GUARDIAN_DAMAGE,
  JUGGERNAUT_DAMAGE,
  FORTRESS_DAMAGE,
  0,
  0,
  0,
  0, // WARDEN
];
export const UNIT_FIRE_COOLDOWN_TICKS: readonly number[] = [
  0,
  RUNNER_COOLDOWN_TICKS,
  GUARDIAN_COOLDOWN_TICKS,
  JUGGERNAUT_COOLDOWN_TICKS,
  FORTRESS_COOLDOWN_TICKS,
  0,
  0,
  0,
  0, // WARDEN
];

/**
 * 2D hit radius per archetype, indexed like ARCHETYPE_MAX_HP.
 *
 * HALF THE MODEL'S FOOTPRINT, which is the convention these already followed —
 * against models that were stretched 1.02x-2.87x off the FCOP originals. The
 * models now carry the size the original authored (assets.md §4), so these
 * follow: the avatar's disc was 2.4 m across against a 0.80 m mech, wider than
 * the catwalks it walks and wider than its own base mouth.
 *
 * Only hit detection reads these — AoE, projectile contact, mine triggers.
 * Wall collision treats every mover as a point (collision.ts), so shrinking
 * them opens no geometry that was closed.
 */
export const ARCHETYPE_RADIUS: readonly number[] = [
  0.4, // AVATAR      0.80 m footprint
  0.76, // RUNNER     1.52
  1.1, // GUARDIAN    3.15 wingspan; half of it, like the rest
  1.1, // JUGGERNAUT  2.22
  1.33, // FORTRESS   2.67
  0.7, // TURRET      1.41
  0.15, // PROJECTILE
  0.56, // CONSOLE    1.12
  1.0, // WARDEN      2.04 — a superplane is still a bigger target than the X1
];

// Max HP per archetype, indexed by ARCHETYPE value (rules.md §4 placeholders;
// turret/projectile values are stand-ins until their phases land).
export const ARCHETYPE_MAX_HP: readonly number[] = [
  AVATAR_HP, // AVATAR
  60, // RUNNER
  50, // GUARDIAN
  600, // JUGGERNAUT
  500, // FORTRESS
  100, // TURRET (Phase 1 dummy value; Phase 2 rebalances)
  1, // PROJECTILE
  150, // CONSOLE
  WARDEN_HP, // WARDEN
];

/**
 * Match outro: ticks between a gate breach and the end of the match. The
 * original sets a phase countdown of 1750 engine ticks (5.83 s at 300 Hz) when a
 * gate trigger fires, keeps the game running, and goes to the results page when
 * it reaches zero (fcop-re/ai-and-rules.md §5, `mission_frame_net` 0x00407fe0).
 * 1750 / 10 = 175 sim ticks. The winner is decided at the breach; a second breach
 * during the outro changes nothing.
 */
export const MATCH_OUTRO_TICKS = 175;

// --- Precinct Assault mode (rules.md §9) ------------------------------------
// Everything here is inert on arenas whose map data carries no PA features.

/**
 * The Dreadnought's hull guns (Precinct Assault arenas): each is weapon 3, 100
 * damage with a 601-engine-tick refire (2.003 s -> 60 sim ticks), the same weapon
 * every PA turret carries (fcop-re/ranges-turrets-capture.md Q3 table, Q4). Its
 * 12 m reach and the gun count come from the arena's imported record; these two
 * are weapon-table values the record only names by id, so the arena generator
 * writes them into the Juggernaut's weapon profile from here.
 */
export const DREADNOUGHT_GUN_DAMAGE = 100;
export const DREADNOUGHT_GUN_REFIRE_TICKS = 60;

/** Power-up kinds; must match the mapping in tools/generators/enrichArena.ts. */
export const PICKUP_HEAVY_AMMO = 0;
export const PICKUP_SPECIAL_AMMO = 1;
export const PICKUP_HEALTH = 2;
export const PICKUP_INVULN = 3;
export const PICKUP_INVIS = 4;
export const PICKUP_POWER = 5;
/**
 * The Gun's ammunition (grant bit 0x01, `reload_gun`): the guns have finite
 * magazines since SIM_VERSION 41, so it refills the Gun slot's A magazine to its
 * ceiling as the original's does. Until then it was imported as a heavy refill.
 */
export const PICKUP_GUN_AMMO = 6;
export const PICKUP_KIND_COUNT = 7;
/** Avatar must be within this of a pickup spot to take it. */
export const PICKUP_RADIUS = 2.5;
// A health pickup refills to the maximum (grant bit 0x20000 passes amount -1,
// "fill": fcop-re/player-and-weapons.md §6). Was +100. No constant: it is AVATAR_HP.
/**
 * Invulnerability: block+0x326 = 0x1770 = 6000 engine units = 20 s
 * (player-and-weapons.md §6). Was 300 (10 s). No PA pickup carries the grant
 * (fcop-fidelity.md I8); the kind stays for maps that place one.
 */
export const PICKUP_INVULN_TICKS = 600;
/**
 * Cloak: block+0x324 = 0x34bc = 13500 engine units = 45 s (player-and-weapons.md
 * §6). Turrets, units and the Warden skip a cloaked avatar. Was 300 (10 s).
 */
export const PICKUP_INVIS_TICKS = 1350;
/**
 * A homing missile within 0x8000 wu = 4 m of a cloaked X1-Alpha drops its target
 * (retail 0x0042379f; player-and-weapons.md §6).
 */
export const CLOAK_DISARM_RADIUS = 0x8000 / 8192;
/**
 * Metropolis' power-up: x2 damage for 15 s. The original's is a per-slot block-B
 * weapon with its own magazine (fcop-fidelity.md P8), which the weapons package
 * adopts with the B blocks; until then this stays, and it is lost when the avatar
 * goes down, as the original's block-B ammunition is (`player_respawn` clears it).
 */
export const PICKUP_POWER_TICKS = 450; // 15 s
/** Damage multiplier while a POWER pickup is active. Integer: exact in binary. */
export const PICKUP_POWER_MULTIPLIER = 2;

/**
 * Base-intrusion trigger watch bits (fcop-logic.md §8.6). ENEMY_UNITS means the
 * enemy's ground units — tanks and the Dreadnought, the actors the original's
 * zone triggers watch (fcop-re/ai-and-rules.md §6), not its jets.
 */
export const TRIGGER_WATCH_ENEMY_AVATAR = 1 << 0;
export const TRIGGER_WATCH_ENEMY_UNITS = 1 << 1;
export const TRIGGER_WATCH_OWN_AVATAR = 1 << 2;
/**
 * The intrusion alert's cooldown, per base: after one fires, no volume of that
 * base fires again for 8.3 s — the original's 2500 engine ticks at 300 Hz
 * (fcop-re/ai-and-rules.md §6, voice ids 2/3). Was 90 ticks per volume.
 */
export const TRIGGER_REARM_TICKS = 250;
/**
 * "Base turret under fire" alert cooldown, per side: 10 s (fcop-re/ai-and-rules.md
 * §6, voice ids 4/5).
 */
export const TURRET_ALERT_COOLDOWN_TICKS = 300;
