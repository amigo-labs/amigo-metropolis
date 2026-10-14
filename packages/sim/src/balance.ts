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
/**
 * The hover asks for the surface under it from 0xccc wu (0.4 m) above itself
 * (`player_hover.c` HOVER_PROBE_LIFT, 0x00442c09): the highest deck at or below
 * that point is the one it rides, so it rides up onto a deck its cushion
 * reaches and passes under one it does not (fcop-fidelity.md P14).
 */
export const HOVER_PROBE_LIFT = 0xccc / 8192;
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

// Turrets. Every turret on every arena is the original's: the imported arenas
// carry their records' profiles, and an arena that imports none (district-01,
// the test maps, the sandbox) gets ORIGINAL_WEAPON_PROFILES below (map.ts
// loadMapFromJson), with ORIGINAL_TURRET_HP. Metropolis' own instant-hit table
// (TURRET_RANGE 28 m, TURRET_DAMAGE 15, TURRET_COOLDOWN_TICKS 20) is gone with
// the last arena that used it (fcop-fidelity.md W3, owner's call 2026-10-12).
//
// THE REACH NOTE THAT USED TO STAND HERE DISSOLVED (fcop-fidelity.md W4). The
// X1's guns reach only their lock, and the lock is 12 m (AVATAR_LOCK_RANGE), the
// same 12 m every turret, tank, jet and Dreadnought gun engages at — player and
// emplacement trade at one reach, on every arena.
/**
 * Metropolis' own target-practice dummy (district-01's lane dummies, the
 * sandbox): neutral, shoots avatars only, back after 15 s. Its gun is the
 * original's neutral turret profile and its health the original turret's 500;
 * the dummy itself and its respawn are Metropolis'.
 */
export const DUMMY_RESPAWN_TICKS = 450; // 15 s
/**
 * A base ring turret comes back 37.5 s after each death: its Csac spawner's tSAC
 * is -2250 = 2250 * 5 engine ticks at 300 Hz, on every PA map
 * (fcop-re/outposts.md Q1, ranges-turrets-capture.md Q3; fcop-fidelity.md R16).
 * The imported arenas carry it as data (MapBase.turretRespawnTicks); this is the
 * value for an arena that imports none (district-01, the test maps), the same
 * 37.5 s. Was Metropolis' 120 s, sized for its own superplane (issue #31).
 */
export const BASE_TURRET_RESPAWN_TICKS = 1125;

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

// Purchases: stand in the console's trigger box and PRESS interact — one unit per
// press, on the frame the key goes down, as the original's purchase triggers
// answer its Action Key (fcop-fidelity.md R17; fcop-re/ai-and-rules.md §2). The
// FIRE2 modifier orders the heavy variant at base consoles and the air unit at
// Metropolis' outpost consoles. Was a 0.5 s hold per unit (CONSOLE_HOLD_TICKS).
/**
 * A base purchase spot's half extents (x, y) where the arena imports none: Mp's
 * type-95 triggers 106-109, 819 x 614 raw at TRIGGER_SCALE 1024 — a 1.6 x 1.2 m
 * box the intruder's radius widens (fcop-re/actors-and-orders.md; fcop-fidelity
 * R17). Was Metropolis' 3 m circle (CONSOLE_RADIUS) until SIM_VERSION 56.
 */
export const ORIGINAL_BUY_HALF_W = 819 / 1024;
export const ORIGINAL_BUY_HALF_L = 614 / 1024;
/**
 * How far below the mech's feet the ground's material still reaches it: a base
 * floor hurts only while the surface is less than this below the feet, so a
 * hover riding its 0.5 m just feels it and a jumping walker above it does not
 * (RE camera-and-movement.md, "the ground is felt within reach only";
 * fcop-fidelity.md P11).
 */
export const SURFACE_REACH = 0.54;
/**
 * A base floor's damage to the enemy mech per movement step, walker and hover
 * alike: codes 14/15 of player_order's table (fcop-fidelity.md P11). At
 * X1_STEPS_PER_TICK that is 37.5 a second.
 */
export const FLOOR_DAMAGE_PER_STEP = 1;
/**
 * How far past a lift's face its top still carries a mech: one movement step of
 * the walker at full speed (4.69 m/s / 37.5 = 0.125 m). The original's walker
 * probes the ground 0.4 m above its feet every step, so a gap narrower than a
 * step between a lift and the deck around it (Slim's: the 1.89 m lift in a
 * 2 m hole) costs it one airborne step and nothing more. Metropolis reads its
 * walls per deck, and a mech that dropped into that gap would read the
 * ground's — the shaft's wall — instead of the deck's. Metropolis' own
 * (fcop-fidelity.md P12).
 */
export const LIFT_RIM_SLACK = 0x400 / 8192;
/**
 * The import's kerb rule (tools/generators/kerbs.ts; fcop-fidelity.md P15): a
 * wall face between two floors that differ by at most this is a step, not a
 * wall. The original's walker probes the ground 0x0ccc above its feet and steps
 * onto a rise of about 0.46 m in one step (RE camera-and-movement.md
 * "Step-up"). Authoring only; the sim never reads it.
 */
export const KERB_STEP = 0.46;
/** Floors closer than this on either side of a face are one floor: a fence, not a kerb. */
export const KERB_SLIVER = 0.05;
/** A face standing more than this above the higher floor is a wall, whatever the floors. */
export const KERB_CLEARANCE = 0.15;
/** One Dreadnought and one Fortress alive per side (spawner limit 1, ai-and-rules.md §3). */
export const JUGGERNAUT_ALIVE_LIMIT = 1;
export const FORTRESS_ALIVE_LIMIT = 1;

// Neutral turret capture (rules.md §5; fcop-fidelity.md R12). Instant: an avatar
// presses the action key, a Runner or the Warden simply comes close, within the
// turret's capture range plus the capturer's own ARCHETYPE_RADIUS
// (fcop-re/ranges-turrets-capture.md Q2). The imported arenas carry the
// original's range (MapData.captureRange: 4.0 / 5.2 / 5.6 m by mission).
/**
 * Capture range on an arena that imports none (district-01, the test maps): the
 * original's `(range + 1024) / 512` m with Mp's, Conft's and Ovmp's range 1024,
 * i.e. 4.0 m (fcop-re/ranges-turrets-capture.md Q2; la-cantina's). Was
 * Metropolis' 5 m (CAPTURE_RADIUS) until SIM_VERSION 52.
 */
export const ORIGINAL_CAPTURE_RANGE = (1024 + 1024) / 512;
/**
 * A destroyed neutral turret comes back neutral after 25 s: its Csac spawner's
 * tSAC is -1500 = 1500 * 5 engine ticks at 300 Hz (ranges-turrets-capture.md Q3,
 * Q5). Was 45 s.
 */
export const NEUTRAL_TURRET_RESPAWN_TICKS = 750;
/**
 * Outpost claim zone (fcop-fidelity.md R14): pressing the action key inside it
 * with COST_OUTPOST_CLAIM points claims the outpost, no hold — the original's
 * type-14 zone with the op-10 gate bit 0x04 (fcop-re/outposts.md Q3), touched
 * within its radius plus the toucher's ARCHETYPE_RADIUS, in 3D. The imported
 * arenas carry each record's radius (MapOutpost.zone, 614 raw << 4 wu); this is
 * the same record radius for an outpost that imports none (district-01's,
 * centred on its console). Was Metropolis' flat 3 m (OUTPOST_CLAIM_RADIUS).
 */
export const OUTPOST_ZONE_RADIUS = (614 << 4) / 8192;
/**
 * An outpost plate's team turret comes back 25 s after each death, for the rest
 * of the match: its Csac spawner's tSAC is -1500 = 7500 engine ticks at 300 Hz,
 * opened by the claim and never shut again (fcop-re/outposts.md Q1, Q3).
 */
export const OUTPOST_TURRET_RESPAWN_TICKS = 750;

// Units: every unit on every arena is the original's (fcop-fidelity.md W3,
// U1-U4): health and weapon from the imported spawner records, or from
// ORIGINAL_UNIT_PROFILES below where an arena imports none; speeds
// ROUTE_TOP_SPEED and the aircraft speeds; targeting the shooter machine.
// Metropolis' placeholder table (Runner 60 HP / 8 dps / 4 m/s, Guardian 50 / 10
// / 7, Juggernaut 600 / 20 / 2.5, Fortress 500 / 25 / 6, patrol orbits and an
// assault standoff) went with district-01's last use of it, SIM_VERSION 52.
/**
 * The authoring road walker's two probe steps (roads.ts GROUND_STEPS), in m/s:
 * Metropolis' old Runner and Juggernaut speeds. NO UNIT MOVES AT THESE ANY MORE
 * (every one drives at ROUTE_TOP_SPEED); the arena pipeline still steps its
 * road walker by them, and changing them would change the walls it carves, so
 * the committed arenas reproduce only with these.
 */
export const RUNNER_SPEED = 4;
export const JUGGERNAUT_SPEED = 2.5;

// Unit movement shared knobs.
export const AIR_ALTITUDE = 6; // flyers ride this high above ground/water
export const WAYPOINT_RADIUS = 3; // lane waypoint advance distance
/**
 * Waypoint advance distance of the AUTHORING road walker (roads.ts `walkRoad`),
 * which stage 2 of the arena pipeline and paRoads.test.ts use to prove a road's
 * wall bits are open. The sim no longer reads it: since SIM_VERSION 44 a ground
 * unit on the original graph walks each leg to its full length (units.ts
 * moveRouteFollower), with no arrival radius, as the original does.
 *
 * Why 0.5 for the walker: a Cnet edge is a metre-wide street in a wall lattice
 * imported at 1 m resolution, so a walker that advanced 3 m early (the polylines'
 * WAYPOINT_RADIUS) would cut corners through whatever the original built there
 * (issue #30). It has to exceed a tick of travel at the probe steps, or the
 * walker steps over the node.
 */
export const GRAPH_WAYPOINT_RADIUS = 0.5;

// --- Route followers on the original road graph (fcop-fidelity.md U1/U2) ---
// The PA tank (Runner) and the Dreadnought (Juggernaut) drive their side's Cnet
// as the original's route followers do (units.ts moveRouteFollower;
// fcop-re/ai-and-rules.md §4, route.c / route_tick.c / route_near.c). Imported
// arenas only: district-01 and the test maps keep Metropolis' polyline lanes.

/**
 * Top speed of every PA tank and of the Dreadnought: the route block's 1024 raw
 * -> `((1024 << 8) / 300) >> 4` = 54 world units per 300 Hz tick = 1.98 m/s
 * (fcop-re/ai-and-rules.md §4; the Dreadnought's own route block carries the same
 * 1024, fcop-logic.md §8.1). Acceleration 1228 raw is full speed within one
 * engine tick, so a follower starts and stops at once. Was RUNNER_SPEED 4 and
 * JUGGERNAUT_SPEED 2.5 on these arenas.
 */
export const ROUTE_TOP_SPEED = (54 * 300) / 8192;
/** A tank's wander: 1638 of 4096 steps (40 %) are random (`cnet_route_next`). */
export const ROUTE_WANDER = 1638;
/** A tank's seek search: the nearest enemy-team actor within 8192 << 4 wu = 16 m. */
export const ROUTE_SEEK_RANGE = 16;
/** Node units per metre: a Cnet node coordinate is 1/32 m (8192 wu >> 8). */
export const ROUTE_NODE_UNITS = 32;
/** The step chooser's rejections: no link, the node just left, the one before. */
export const ROUTE_SCORE_NO_LINK = -4;
export const ROUTE_SCORE_PREV = -2;
export const ROUTE_SCORE_PREV2 = -1;
/** Every traffic slowdown holds 300 engine ticks = 1 s (`CNET_ROUTE_HOLD_TICKS`). */
export const ROUTE_HOLD_TICKS = 30;
/** The pair test records a neighbour only inside a 0x4000 wu = 2 m gap. */
export const ROUTE_NEAR_GAP = 2;
/** A non-follower closer than 0x4000 wu = 2 m dead ahead stops the follower. */
export const ROUTE_NEAR_BLOCK = 2;
/** The traffic reaction's vertical band, 0x1400 wu = 0.625 m. */
export const ROUTE_NEAR_RISE = 0.625;
/** Below 16 wu the neighbour counts as dead ahead (`CNET_ROUTE_NEAR_MIN_LEN`). */
export const ROUTE_NEAR_MIN_LEN = 16 / 8192;
/**
 * The cone ahead the reaction needs: cos 0xf600 / 0x10000 = cos 16.05°. The
 * original divides by an approximate length that over-reads by up to 5.35 %, so
 * the cone it enforces narrows to ~7.2° in some directions; this is the exact
 * cosine. The wider 60° cone behind CNET_ROUTE_NEAR_CLOSE is unreachable from
 * the pair test's output and is not modelled.
 */
export const ROUTE_CONE_COS = 0xf600 / 0x10000;

/**
 * Level-flight speeds of the PA jet (2048 raw) and Flying Fortress (2457 raw):
 * `(raw << 12) / 300` moved `speed * dt >> 8` wu per engine tick = 4.0 / 4.8 m/s
 * (fcop-re/ai-and-rules.md §4, camera-and-movement.md "Aircraft"). Every arena
 * since SIM_VERSION 52; was GUARDIAN_SPEED 7 and FORTRESS_SPEED 6.
 */
export const GUARDIAN_AIRCRAFT_SPEED = 2048 / 512; // (raw << 12) / 300 >> 8 per tick at 300 Hz
export const FORTRESS_AIRCRAFT_SPEED = 2457 / 512;
/**
 * The PA aircraft's target search (`aircraft_step` 0x00420752): every 900 + rand
 * 0..511 engine units (3.0-4.7 s), the nearest enemy within the record's
 * target_detection_range raw / 512 m — the jet's 28672 = 56 m, the Flying
 * Fortress' 32358 = 63.2 m (fcop-fidelity.md I2, `rangeToCells`;
 * camera-and-movement.md "Aircraft").
 */
export const AIRCRAFT_SEARCH_TICKS = 90;
export const AIRCRAFT_SEARCH_JITTER = 52; // rand 0..511 engine units, in ticks
export const GUARDIAN_DETECT_RANGE = 28672 / 512;
export const FORTRESS_DETECT_RANGE = 32358 / 512;
/**
 * The patrol leash: orbit_area raw / 1024 m half-extents about the aircraft's
 * anchor (I2, `orbitLeashToCells`): jet 24576 x 20480 = ±24 x ±20 m, Fortress
 * 30720 x 28672 = ±30 x ±28 m; destinations are drawn inside half of it. x is
 * orbit_area_x on the world x axis (the original tests its axes crosswise
 * against two record halfwords; for the jet the difference is 4 m).
 */
export const GUARDIAN_LEASH_X = 24576 / 1024;
export const GUARDIAN_LEASH_Y = 20480 / 1024;
export const FORTRESS_LEASH_X = 30720 / 1024;
export const FORTRESS_LEASH_Y = 28672 / 1024;
/** Off the leash it cruises 0x4b0 + rand 0..0x7ff engine units (4.0-10.8 s). */
export const AIRCRAFT_CRUISE_TICKS = 120;
export const AIRCRAFT_CRUISE_JITTER = 205;
/**
 * Inside the standoff (record 512 << 4 wu = 1 m, the Sky Captain's; the PA
 * jets' is not in the extracted records) it reverses, for 150 + rand 0..127
 * engine units.
 */
export const AIRCRAFT_STANDOFF = 1;
export const AIRCRAFT_REVERSE_TICKS = 15;
export const AIRCRAFT_REVERSE_JITTER = 13;

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
// --- The Warden: the original's Sky Captain (fcop-fidelity.md U3) ----------
// fcop-re/ai-and-rules.md §1 (dispatch.c, aircraft.c in the RE repo). The
// Warden is actor type 37: an aircraft with the commander's decision pass on
// top. Metropolis' difficulty 1-10 is the captain's level 0-9 (state word 19):
// level = difficulty - 1. Distances the decision pass measures are the
// original's octagonal estimate |dx| + |dy| - min(|dx|, |dy|) / 2, in metres
// (8192 wu = 1 m).

/** The level a Warden difficulty plays (word 19, clamped 0..9). */
export function wardenLevel(difficulty: number): number {
  const l = difficulty - 1;
  return l < 0 ? 0 : l > 9 ? 9 : l;
}

/**
 * The record's health, 1000 in all 22 shipped instances; by level (construct):
 * below 6 `max - (max >> 2) * ((7 - L) >> 1)`, above 7 `max + (max >> 3) * (L - 7)`
 * = 250, 250, 500, 500, 750, 750, 1000, 1000, 1125, 1250. Was WARDEN_HP 450.
 */
export const SKY_RECORD_HP = 1000;
export function skyMaxHp(level: number): number {
  if (level < 6) return SKY_RECORD_HP - (SKY_RECORD_HP >> 2) * ((7 - level) >> 1);
  if (level > 7) return SKY_RECORD_HP + (SKY_RECORD_HP >> 3) * (level - 7);
  return SKY_RECORD_HP;
}

/**
 * Level-flight speed: the record's 1843 raw is `(1843 << 12) / 300` = 25163
 * internal, plus `(L - 3) * 0x800` below level 3 and `(L - 3) * 0x420` from 3, and
 * a level aircraft moves `speed * dt >> 8` wu per engine tick: 2.72 m/s at level
 * 0, 3.60 at 3, 4.51 at 9. Was WARDEN_SPEED 10.
 */
export const SKY_RECORD_SPEED = 25163;
export function skySpeed(level: number): number {
  const internal = SKY_RECORD_SPEED + (level < 3 ? (level - 3) * 0x800 : (level - 3) * 0x420);
  return (internal * 300) / 256 / 8192;
}

/** Cruise height above ground/water: Metropolis' (the record's 1.28 m is above a
 * coarse ground envelope the heightfield does not carry). */
export const WARDEN_ALTITUDE = 7;

/**
 * Rethink: the decision pass runs when the countdown goes negative and reloads it
 * with `0x350 - 80 * L` engine units, plus rand 0..255 in modes 0/1 or minus rand
 * 0..31 in mode 2 (0x00421658..0x0042168f): 2.83-3.68 s at level 0, 0.43-1.28 s
 * at level 9. Every credit the engine pays the captain zeroes it.
 */
export const SKY_RETHINK_BASE = 0x350;
export const SKY_RETHINK_PER_LEVEL = 80;
export const SKY_RETHINK_JITTER = 0x100;
export const SKY_RETHINK_JITTER_DEFEND = 0x20;

/**
 * Respawn: the crash landing sets `(14 - L) * 150` engine units (aircraft.c
 * 0x00420d90): 7.0 s at level 0, 2.5 s at level 9. The tumble before it is not
 * modelled, so the countdown starts when it falls. Was WARDEN_RESPAWN_TICKS 240.
 */
export function skyRespawnTicks(level: number): number {
  return ((14 - level) * 150) / 10;
}

/** From itself, every candidate is `(9 - L) * 0x1000` wu = 0.5 m further away. */
export const SKY_LEVEL_PENALTY = 0.5;

/** The scan's reach, octagonal metres (fcop-re/ai-and-rules.md §1.5). */
export const SKY_NEAR_TANK = 0x68000 / 8192; //       own tank, from the player's base: 52 m
export const SKY_NEAR_DREAD = 0x78000 / 8192; //      own Dreadnought, from it: 60 m
export const SKY_FAR_TANK = 0x80000 / 8192; //        enemy tank, from home: 64 m
export const SKY_FAR_DREAD = 0x90000 / 8192; //       enemy Dreadnought, from home: 72 m
export const SKY_TURRET_COUNT = 0x200000 / 8192; //   own turrets counted within 256 m
/**
 * A count of own team turrets below this promotes to defend (0x00421d1c `cmp
 * ecx, 0xa`). Each live team turret counts SKY_TURRET_PARTS times, so the
 * captain defends while fewer than 5 of its team turrets (ring + owned outpost
 * plates) stand: 16 at the start on Mp/Conft/Ovmp, 12 on Slim/Joke/Hk
 * (fcop-re/outposts.md Q2). Was read as "8 base + 2 per owned outpost" counted
 * once, which never reached ten.
 */
export const SKY_TURRETS_SAFE = 10;
/**
 * Every type-8 turret is two type-8 actors in the original's live list: the
 * turret and its base part, built by `turret_construct` from the same tACT
 * record (0x0041c08e -> `cact_create`; the part's construct writes type 8 and
 * the record's team, 0x0041a5b0 / 0x0041a59d). The scan counts both
 * (fcop-re/outposts.md Q2, [A]).
 */
export const SKY_TURRET_PARTS = 2;
/** A Dreadnought near the player's base is worth 10, a tank 1; 2 means attack. */
export const SKY_SCORE_ATTACK = 2;
/** Mode 1's detour to a neutral turret while escorting: within 0x10000 wu = 8 m. */
export const SKY_ESCORT_CAPTURE = 0x10000 / 8192;
/** Mode 0's ladder, from itself with the level penalty (octagonal metres). */
export const SKY_HURT_PLAYER = 0x50000 / 8192; //  the player below 1/4 health: 40 m
export const SKY_ROAM_DREAD = 0x50000 / 8192; //   40 m
export const SKY_ROAM_TANK = 0x40000 / 8192; //    32 m
export const SKY_ROAM_NEUTRAL = 0x60000 / 8192; // 48 m
export const SKY_ROAM_JET = 0x30000 / 8192; //     24 m
export const SKY_ROAM_TAKEN = 0x50000 / 8192; //   a turret the player captured: 40 m
export const SKY_ROAM_FORTRESS = 0x30000 / 8192; // 24 m
/** The neutral-turret slot's per-candidate jitter: rand & 0x3fff wu. */
export const SKY_NEUTRAL_JITTER = 0x4000;

/** It aims only inside its shooters' engage_range 6144 << 4 wu = 12 m, true distance. */
export const SKY_AIM_RANGE = 12;
/** It reverses inside the record's standoff, 512 << 4 wu = 1 m. */
export const SKY_STANDOFF = 1;

/**
 * Retreat: below `maxHP / 2 - rand 0..63` (halved in modes 1 and 2), within
 * 0x4000 wu = 2 m of home it is restored on the spot; engaging, it breaks for
 * home with `speed += speed >> (4 - L / 4)`; cruising, a health pickup within
 * 0x1000 wu = 0.5 m restores it, a nearer one than home diverts it.
 */
export const SKY_RETREAT_JITTER = 0x40;
export const SKY_HOME_RADIUS = 0x4000 / 8192;
export const SKY_PICKUP_RADIUS = 0x1000 / 8192;
/**
 * A pickup's own touch on the Sky Captain (`cact_pickup_sky_touch` 0x0041eb10):
 * within 0x3000 world units (1.5 m) flat by the octagonal estimate, no height
 * and no box, a health pickup restores it — and any pickup it touches is spent,
 * every PA pickup being a consumed one (fcop-fidelity.md P9). In world units.
 */
export const SKY_PICKUP_TOUCH_WU = 0x3000;

/**
 * Its three weapons, ids 7 / 8 / 9 of every PA arena's type-98 catalogue
 * (fcop-re/ai-and-rules.md §1.4), unlimited, sharing one target:
 * - 7, the gun: hitscan, 2 damage, a round every 18 engine units (0.06 s), 24 m;
 * - 8, the missile: guided, needs a line of sight, 25 damage, every 150 units
 *   (0.5 s), flies 24 m;
 * - 9, the bomb: 200 damage in a 3.2 m blast (linear falloff), every 601 units
 *   (2.0 s).
 * The projectile speed of 8 and 9 could not be established (catalogue
 * +0x12/+0x14 left raw), so both fly at Metropolis' WARDEN_HEAVY_SPEED, and the
 * bomb keeps Metropolis' flat flight and lifetime instead of the original's arc.
 * Was: a 10-damage cannon every 5 ticks at 42 m and a 60-damage 6 m bomb.
 */
export const SKY_GUN_DAMAGE = 2;
export const SKY_GUN_REFIRE_UNITS = 18;
export const SKY_GUN_REACH = 24;
export const SKY_MISSILE_DAMAGE = 25;
export const SKY_MISSILE_REFIRE_UNITS = 150;
export const SKY_MISSILE_FLIGHT = 24;
export const SKY_BOMB_DAMAGE = 200;
export const SKY_BOMB_REFIRE_UNITS = 601;
export const SKY_BOMB_BLAST = 3.2;
export const WARDEN_HEAVY_SPEED = 25;
export const WARDEN_HEAVY_TTL_TICKS = 75;
/** With no target the shooters search by team on their targeting delay, 16 = 1.0 s. */
export const SKY_SEARCH_UNITS = 300;
/**
 * The firing arcs the construct writes by level (shooter bitfield bits 1/2,
 * ARC_BLOCK_REAR / ARC_BLOCK_SIDE): the gun front only (±22.5°) at level 0, front
 * and sides (±157.5°) from level 1; the missile front only below 3, front and
 * sides 3-6, all round from 7. The bomb keeps its record's bits, which were not
 * read: all round here. [B] in the evidence (the reading of bits 0..2).
 */
export const SKY_ARC_SIDE_COS = -0.9238795325112867; // cos 157.5°

/** Its units' cap (SKY_UNIT_CAP 0x14), the same 20 the human pads check. */
export const SKY_UNIT_CAP = 20;
/** What the spend blocks pay (the scripts' prices; ai-and-rules.md §1.8). */
export const SKY_OUTPOST_UNIT_COST = 2;
/** Mode 2, level 9: one base tank for an enemy Dreadnought < 18 m or tank < 16 m of home. */
export const SKY_L9_DREAD = 0x24000 / 8192;
export const SKY_L9_TANK = 0x20000 / 8192;
/** Mode 2 orders from near home: within 0x80000 wu (64 m) less 8 m a level. */
export const SKY_SPEND_HOME = 0x80000 / 8192;
export const SKY_SPEND_HOME_PER_LEVEL = 0x10000 / 8192;
/** A Fortress when the budget exceeds 0x41 + rand 0..7; outpost jets keep 5 back. */
export const SKY_FORTRESS_BUDGET = 0x41;
export const SKY_SPARE_BUDGET = 5;
/**
 * A spawn queue's period where the arena imports none (fcop-fidelity.md R18):
 * Mp's slot-0 base tank queue, fn18's 202 units (3.37 s), and its captain's base
 * jet queue, fn17's 58 (0.97 s). Each arena's own come from the rules artifact
 * (MapBase.queueTicks, MapOutpost.queueTicks).
 */
export const ORIGINAL_TANK_QUEUE_TICKS = 101;
export const ORIGINAL_JET_QUEUE_TICKS = 29;
/** Spawn queues per team: base tanks, base jets, then a tank and a jet queue per outpost (4). */
export const UNIT_QUEUES = 10;
/** Free opening order (construct 0x00421476): from level 1, 10 units. */
export const SKY_OPENING_ORDER = 10;

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
  1.0, // WARDEN      2.04 — the Sky Captain's craft
];

// Max HP per archetype, indexed by ARCHETYPE value: the original's records
// (ORIGINAL_UNIT_PROFILES, ORIGINAL_TURRET_HP; the imported arenas carry the same
// numbers per record). Was Metropolis' 60 / 50 / 600 / 500 / 100 placeholders.
export const ARCHETYPE_MAX_HP: readonly number[] = [
  AVATAR_HP, // AVATAR
  150, // RUNNER      the PA tank
  150, // GUARDIAN    the PA jet
  3000, // JUGGERNAUT the Dreadnought
  2000, // FORTRESS   the Flying Fortress
  500, // TURRET      type 8 / type 36
  1, // PROJECTILE
  150, // CONSOLE (Metropolis' outpost marker; it takes no damage)
  SKY_RECORD_HP, // WARDEN (its level scales it: skyMaxHp)
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

// --- The world's weapons (fcop-fidelity.md W3) --------------------------------
//
// Every shooting actor on a PA map — turret, neutral turret, tank, jet, Flying
// Fortress, Dreadnought gun — names its weapon by id, and the id indexes the
// mission's own type-98 catalogue (`cact_shooter_init`, linear search on the
// entry's id byte, 0x0044e900; fcop-re/ranges-turrets-capture.md Q3). The entries
// the PA actors use are byte-identical on all six PA maps in every gameplay
// field (decoded from fixtures/missions/{Mp,Conft,Slim,Joke,Hk,Ovmp}; only an fx
// byte differs on one map). Raw halfwords, converted like the player's
// (gaps raw * 4096 / 218 engine units, speed trunc(raw / 300) << 4 wu a unit,
// range raw << 4 wu):
//   id 3  turrets, neutral turrets, Dreadnought guns: kind 2 (aimed with an
//         intercept lead, unguided), 100 dmg, burst gap 32 (601 units, 2.0 s), 1
//         round, speed 4096 (7.62 m/s), range 6144 (12 m), no blast;
//   id 1  tanks and jets of one side / id 6 the other side's: kind 2, 50 dmg,
//         burst gap 16 (300 units, 1.0 s), speed 4096, range 6144;
//   id 4  Flying Fortress: kind 3 (guided), 100 dmg, burst gap 8 (150 units,
//         0.5 s), speed 4096, range 12288 (24 m).
// The magazines (20000, or -1 = unlimited) never run out in a match.
export interface WorldWeaponRecord {
  readonly kind: number;
  readonly damage: number;
  readonly rounds: number;
  readonly burstGap: number;
  readonly roundGap: number;
  readonly w0e: number;
  readonly speed: number;
  readonly accel: number;
  readonly range: number;
}

export const WORLD_WEAPONS: Readonly<Record<number, WorldWeaponRecord>> = {
  1: {
    kind: 2,
    damage: 50,
    rounds: 1,
    burstGap: 16,
    roundGap: 0,
    w0e: 0,
    speed: 4096,
    accel: 0,
    range: 6144,
  },
  3: {
    kind: 2,
    damage: 100,
    rounds: 1,
    burstGap: 32,
    roundGap: 0,
    w0e: 0,
    speed: 4096,
    accel: 0,
    range: 6144,
  },
  4: {
    kind: 3,
    damage: 100,
    rounds: 1,
    burstGap: 8,
    roundGap: 0,
    w0e: 0,
    speed: 4096,
    accel: 0,
    range: 12288,
  },
  6: {
    kind: 2,
    damage: 50,
    rounds: 1,
    burstGap: 16,
    roundGap: 0,
    w0e: 0,
    speed: 4096,
    accel: 0,
    range: 6144,
  },
};

/** Catalogue kinds: 2 = aimed with an intercept lead, unguided; 3 = guided. */
export const WORLD_KIND_LEAD = 2;
export const WORLD_KIND_GUIDED = 3;

/**
 * The firing arc of every PA turret and Dreadnought gun: bitfield 0x02|0x04
 * blocks the side and rear sectors, so a round goes out only when its aim lies
 * within 22.5° of the gun's forward axis (`discharge.h:172-189`). cos 22.5°,
 * precomputed (no trig in the sim).
 */
export const SHOOTER_FRONT_ARC_COS = 0.9238795325112867;
/**
 * A round refused by the arc or by the terrain line of sight is put back and the
 * fire clock is pushed back by `(rand - 0x38) & 0xff` engine units, 0-0.85 s.
 */
export const SHOOTER_RETRY_UNITS = 256;
/**
 * Target priority, which the team turrets (bitfield 0x40) prefer: a Dreadnought
 * 15 > a tank 10 > the X1-Alpha 5 > everything else 0 (Q3).
 */
export const TARGET_PRIORITY_JUGGERNAUT = 15;
export const TARGET_PRIORITY_RUNNER = 10;
export const TARGET_PRIORITY_AVATAR = 5;

/**
 * The original's shooter profiles, in the order every imported arena's
 * `weapons` table lists them (they are identical on all six PA maps, except the
 * Dreadnought gun's fov on Slim and Joke, which no refire shooter reads;
 * fcop-arenas.test.ts asserts the rest). An arena that imports no profiles
 * (district-01, the test maps, the sandbox) is given exactly these by
 * map.ts loadMapFromJson, so its turrets and units are the original's too
 * (fcop-fidelity.md W3, owner's call 2026-10-12). Fields as map.ts MapWeapon:
 *   0 team turret (type 8): weapon 3 — 100 dmg every 601 units (61 ticks), 12 m,
 *     7.62 m/s lead round flying 12 m; slews 290°/s (0.1687 rad a tick);
 *     ±22.5° firing arc; re-searches every 2.0 s; holds its target and prefers
 *     priority (bitfield 0x4246);
 *   1 Dreadnought hull gun: weapon 3, re-search 1.0 s, no arc (mounts not
 *     modelled), no hold;
 *   2 tank and jet: weapon 1/6 — 50 dmg every 300 units (1.0 s), 12 m, re-search
 *     2.0 s;
 *   3 Flying Fortress: weapon 4 — guided 100 dmg every 150 units (0.5 s), flies
 *     24 m, re-search 1.0 s;
 *   4 neutral turret (type 36): the team turret's gun without hold or priority.
 */
export const ORIGINAL_WEAPON_PROFILES = [
  {
    range: 12,
    delay: 60,
    damage: 100,
    turnSpeed: 0.1687,
    fovCos: -1,
    refireUnits: 601,
    searchUnits: 601,
    speed: 7.6171875,
    flight: 12,
    guided: 0,
    lead: 1,
    arcCos: SHOOTER_FRONT_ARC_COS,
    hold: 1,
    priority: 1,
  },
  {
    range: 12,
    delay: 60,
    damage: 100,
    turnSpeed: 0,
    fovCos: -1,
    refireUnits: 601,
    searchUnits: 300,
    speed: 7.6171875,
    flight: 12,
    guided: 0,
    lead: 1,
    arcCos: -1,
    hold: 0,
    priority: 0,
  },
  {
    range: 12,
    delay: 30,
    damage: 50,
    turnSpeed: 0,
    fovCos: -1,
    refireUnits: 300,
    searchUnits: 601,
    speed: 7.6171875,
    flight: 12,
    guided: 0,
    lead: 1,
    arcCos: -1,
    hold: 0,
    priority: 0,
  },
  {
    range: 12,
    delay: 15,
    damage: 100,
    turnSpeed: 0,
    fovCos: -1,
    refireUnits: 150,
    searchUnits: 300,
    speed: 7.6171875,
    flight: 24,
    guided: 1,
    lead: 0,
    arcCos: -1,
    hold: 0,
    priority: 0,
  },
  {
    range: 12,
    delay: 60,
    damage: 100,
    turnSpeed: 0.1687,
    fovCos: -1,
    refireUnits: 601,
    searchUnits: 601,
    speed: 7.6171875,
    flight: 12,
    guided: 0,
    lead: 1,
    arcCos: SHOOTER_FRONT_ARC_COS,
    hold: 0,
    priority: 0,
  },
] as const;
/** Indices into ORIGINAL_WEAPON_PROFILES (and every imported arena's table). */
export const PROFILE_TEAM_TURRET = 0;
export const PROFILE_DREAD_GUN = 1;
export const PROFILE_TANK_JET = 2;
export const PROFILE_FORTRESS = 3;
export const PROFILE_NEUTRAL_TURRET = 4;
/** Every turret record's health, type 8 and type 36 alike (Q3). */
export const ORIGINAL_TURRET_HP = 500;
/**
 * The original's purchasable units as an arena without records gets them (the
 * imported arenas carry the same per side): tank and jet 150 HP on the tank/jet
 * gun, Flying Fortress 2000 HP on weapon 4, the Dreadnought 3000 HP with four
 * hull guns (fcop-fidelity.md W3, I6).
 */
export const ORIGINAL_UNIT_PROFILES = {
  runner: { hp: 150, weapon: PROFILE_TANK_JET },
  guardian: { hp: 150, weapon: PROFILE_TANK_JET },
  fortress: { hp: 2000, weapon: PROFILE_FORTRESS },
  juggernaut: { hp: 3000, guns: 4, weapon: PROFILE_DREAD_GUN },
} as const;

/**
 * The Dreadnought's hull guns: weapon 3 (above). Kept as names for the readers
 * that pin them; the arena generator builds every profile from WORLD_WEAPONS.
 */
export const DREADNOUGHT_GUN_DAMAGE = WORLD_WEAPONS[3].damage;

/** Power-up kinds; must match the mapping in tools/generators/enrichArena.ts. */
export const PICKUP_HEAVY_AMMO = 0;
export const PICKUP_SPECIAL_AMMO = 1;
export const PICKUP_HEALTH = 2;
export const PICKUP_INVULN = 3;
export const PICKUP_INVIS = 4;
/**
 * The power-ups, one per slot (grant bits 0x10 / 0x20 / 0x40; fcop-fidelity.md
 * P8): the Gun's keeps the old kind number, the Heavy's and the Special's are new
 * (SIM_VERSION 43; they all imported as one x2-damage kind before).
 */
export const PICKUP_POWER = 5;
export const PICKUP_POWER_GUN = PICKUP_POWER;
/**
 * The Gun's ammunition (grant bit 0x01, `reload_gun`): the guns have finite
 * magazines since SIM_VERSION 41, so it refills the Gun slot's A magazine to its
 * ceiling as the original's does. Until then it was imported as a heavy refill.
 */
export const PICKUP_GUN_AMMO = 6;
export const PICKUP_POWER_HEAVY = 7;
export const PICKUP_POWER_SPECIAL = 8;
export const PICKUP_KIND_COUNT = 9;
/**
 * The round count at which a slot warns it is running dry: `player_fire_slot`
 * (retail 0x00458ed0) compares the allowance it is about to spend against 5
 * (`PLAYER_FIRE_LOW_AMMO`) and plays sound script 14 (sim.ts fireSlot,
 * EV_LOW_AMMO).
 */
export const LOW_AMMO_WARNING = 5;
/**
 * A pickup's collection box where the arena imports none: every PA pickup's
 * record halfwords 819 / 819 / 2048 << 4 world units, i.e. 4.0 m along x, 1.6 m
 * along y and 1.6 m in height about the pickup, which stands 81 << 4 wu (0.16 m)
 * above the ground (`cact_pickup_box_touch` 0x0041e8a0; fcop-fidelity.md P9).
 * Was Metropolis' 2.5 m circle (PICKUP_RADIUS).
 */
export const ORIGINAL_PICKUP_HALF_W = (2048 * 16) / 8192;
export const ORIGINAL_PICKUP_HALF_L = (819 * 16) / 8192;
export const ORIGINAL_PICKUP_HALF_H = (819 * 16) / 8192;
export const ORIGINAL_PICKUP_LIFT = (81 * 16) / 8192;
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
// The power-up is the original's, since SIM_VERSION 43 (fcop-fidelity.md P8;
// fcop-re/player-and-weapons.md §6): a slot's power pickup fills that slot's
// block-B magazine to its NORMAL ceiling, and the slot fires block B — the
// record's "powered" weapon — until that magazine is empty, then block A again.
// It is lost at a down. It replaced Metropolis' x2 damage for 15 s
// (PICKUP_POWER_TICKS 450, PICKUP_POWER_MULTIPLIER 2); there is no timer and no
// multiplier.

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
