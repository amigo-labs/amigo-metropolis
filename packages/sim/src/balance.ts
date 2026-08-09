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

// Avatar (rules.md §2, §4) — Phase 0 only uses walker speed for the debug cube.
export const AVATAR_HP = 300;
export const AVATAR_WALKER_SPEED = 5;
export const AVATAR_HOVER_SPEED = 9;

// Slope limits as rise/run. Walker handles everything except deliberate
// jump-only ledges (rise ≈ 0.7); hover stays stricter, because it rides
// clearance and trades terrain for speed and water. Map authoring relies on
// these — the district-01 schema test checks lane traversability against the
// walker limit.
//
// The hover limit was 0.35 until issue #34 measured it against the geometry it
// has to drive. Over the span below, the steepest sustained climb anywhere in
// la-cantina's road network — the one arena whose roads the walker finds clean —
// is 0.40. On the other three the sustained climbs run from 0.35 to 1.5 with
// their mass at 0.50 and up, which is the arenas' 1.3-3 m terrain steps rather
// than their roads. So 0.35 sat below the roads themselves, and 0.50 admits the
// roads' own ramps while still rejecting the terrain — with the walker's 0.6
// clear above it.
export const AVATAR_WALKER_MAX_SLOPE = 0.6;
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
export const TRANSFORM_LOCK_TICKS = 15; // ~0.5 s: no move/jump/weapons
export const AVATAR_JUMP_SPEED = 8; // m/s up → 1.6 m apex, clears 1.4 m ledges
export const GRAVITY = 20; // m/s²
export const HOVER_CLEARANCE = 0.3; // ride height above ground/water surface
/**
 * Hover traction: fraction of the velocity error closed per tick, picked by
 * what the stick is doing. Throttle responds, counter-steer bites hard (drift
 * is escapable), a released stick glides for over a second. All three are
 * FEEL-TUNING KNOBS — defaults need a human pass on real hardware.
 */
export const HOVER_TRACTION_ACCEL = 0.1; // stick along velocity (or standstill)
export const HOVER_TRACTION_BRAKE = 0.25; // stick against velocity
export const HOVER_TRACTION_COAST = 0.02; // stick released

// Ammo capacities (rules.md §2: heavy/special finite).
export const AVATAR_AMMO_HEAVY = 20;
export const AVATAR_AMMO_SPECIAL = 5;

// Weapons (rules.md §2: primary hitscan, heavy projectile w/ AoE, special).
//
// OPEN: the player outranges the whole arena, and the original says so.
// Every shooter on Mp — bases, turrets, neutrals, ground units and aircraft
// alike — carries engage_range 6144 raw, which is 6 cells at the extractor's
// 1/1024 scale (tools/generators/fcopLogic.ts) and 6 metres at the arenas'
// one-cell-per-metre import. Acquisition is a separate, much longer number:
// aircraft target_detection_range 28672-32358, i.e. 28-32 cells. See far, shoot
// close. Our emplacements already obey it — the imported per-arena profiles set
// 6 and sim.ts prefers them on all six playable arenas — but PRIMARY_RANGE is
// 40: 6.7x an emplacement and ~3x the escorts it fights alongside.
//
// It is NOT a one-line fix, which is why it is a note and not a change. The §1
// arenas (rules.md §1-§7) are a coherent triangle — units 14-18 < TURRET_RANGE
// 28 < primary 40 — and each inequality carries a rule: the turret must outreach
// a unit or design pillar 3's "a lone runner dies to the enemy ring" fails
// (units.test.ts), and the player must outreach the turret or a base ring cannot
// be cleared at all. Measured, cutting primary to 14 alone inverts the second
// one and no golden script can clear a ring any more. Cutting TURRET_RANGE with
// it inverts the first. The §9 arenas have the opposite ordering by design
// (rules.md §9: emplacements at 6, units at 14 so "a push can answer a turret"),
// so the two families genuinely want different numbers from one shared table.
//
// Resolving that is a balance pass with an owner decision in it — split the
// table per arena family, or move §1 onto the original's ordering and re-author
// what depends on it. Whoever takes it: the anchor is 6 m, and the measurements
// above are the starting point.
export const PRIMARY_COOLDOWN_TICKS = 5;
export const PRIMARY_DAMAGE = 8;
export const PRIMARY_RANGE = 40;
// Soft-lock (input.spec §4.4 "lock"): the max distance at which the Target-Cycle
// button can acquire/hold an enemy — a touch beyond PRIMARY_RANGE so you can
// lock a target just before it enters firing range. A lock that drifts past this
// releases back to free aim.
export const AVATAR_LOCK_RANGE = 44;
export const HEAVY_COOLDOWN_TICKS = 24;
export const HEAVY_DAMAGE = 60;
export const HEAVY_SPEED = 25;
export const HEAVY_TTL_TICKS = 75;
export const HEAVY_AOE_RADIUS = 6;
// SPECIAL_* is the Mortar Launcher — default special (Mini-Gun + Hell Fire +
// Mortar). Magazine size is AVATAR_AMMO_SPECIAL (entity ammoB at spawn).
export const SPECIAL_COOLDOWN_TICKS = 60;
export const SPECIAL_DAMAGE = 119;
export const SPECIAL_SPEED = 10;
export const SPECIAL_TTL_TICKS = 110;
export const SPECIAL_AOE_RADIUS = 8;

// --- Non-default catalog weapons (weapons.ts) --------------------------------
//
// The three constants blocks above are the DEFAULT kit, index 0 in each slot.
// Alternatives scale from those anchors. Catalog = ten Precinct Assault weapons
// only (rules.md §2): four Guns, three Heavies, three Specials.
//
// Rate/damage from the original front-end panels (`febmp.bin`, 55 px trough):
//
//   damage   = anchorDamage   * bar_dmg  / anchorBar_dmg
//   cooldown = anchorCooldown * anchorBar_rate / bar_rate      (rate is 1/cooldown)
//
// Anchoring across slots does not work — a global Mini-Gun anchor puts Hell
// Fire's cooldown at 7 ticks instead of 24.
//
//   Gatling Laser          55/55 rate,  3/55 dmg → 8 dmg, 5 tick
//   Flamethrower           55/55 rate,  9/55 dmg → 24 dmg, 5 tick
//   Electric Gun           28/55 rate,  9/55 dmg → 24 dmg, 10 tick
//   Concussion Beam        21/55 rate, 19/55 dmg → 127 dmg, 48 tick
//   Hyper Velocity Rocket  55/55 rate, 11/55 dmg → 73 dmg, 18 tick
//   Pop-Up Mines           55/55 rate, 55/55 dmg → 344 dmg, 31 tick
//   Shockwave Generator    19/55 rate, 28/55 dmg → 175 dmg, 88 tick
//
// Declared deviation: the bars do NOT distinguish Mini-Gun from Laser (both
// 55/55 rate, 3/55 damage). Reach separates them (40 vs 44). Ranges, speeds,
// TTLs, AoE, magazine sizes and mine arming are ours — panels carry rate/damage
// only. See rules.md §2.
export const GUN_LASER_DAMAGE = 8;
export const GUN_LASER_COOLDOWN_TICKS = 5;
export const GUN_LASER_RANGE = 44; // ours — the bars cannot tell it from the Mini-Gun
export const GUN_FLAME_DAMAGE = 24;
export const GUN_FLAME_COOLDOWN_TICKS = 5;
export const GUN_FLAME_RANGE = 14; // ours — no range on either bar
export const GUN_ELECTRIC_DAMAGE = 24;
export const GUN_ELECTRIC_COOLDOWN_TICKS = 10;
export const GUN_ELECTRIC_RANGE = 40; // ours — bars carry rate/damage only
export const HEAVY_BEAM_DAMAGE = 127;
export const HEAVY_BEAM_COOLDOWN_TICKS = 48;
export const HEAVY_BEAM_RANGE = 50; // ours
export const HEAVY_BEAM_AMMO = 6;
export const HEAVY_HYPER_DAMAGE = 73;
export const HEAVY_HYPER_COOLDOWN_TICKS = 18;
export const HEAVY_HYPER_SPEED = 50; // ours — fast light rocket
export const HEAVY_HYPER_TTL_TICKS = 45;
export const HEAVY_HYPER_AOE_RADIUS = 2;
export const HEAVY_HYPER_AMMO = 14;
// Pop-Up Mines / Shockwave: rate+damage from original bars (Mortar-anchored);
// placement, arming, trigger and pulse radii are ours.
export const SPECIAL_MINE_DAMAGE = 344;
export const SPECIAL_MINE_COOLDOWN_TICKS = 31;
export const SPECIAL_MINE_AMMO = 4;
/** Live lifetime once placed; despawns without boom if nobody trips it. */
export const SPECIAL_MINE_TTL_TICKS = 900; // 30 s
/** Ticks after place before an enemy can arm the fuze (owner walk-off). */
export const SPECIAL_MINE_ARM_TICKS = 15; // 0.5 s
/** Proximity trigger radius (world units). */
export const SPECIAL_MINE_TRIGGER_RADIUS = 3;
/** Blast radius when a mine goes off. */
export const SPECIAL_MINE_AOE_RADIUS = 6;
export const SPECIAL_SHOCK_DAMAGE = 175;
export const SPECIAL_SHOCK_COOLDOWN_TICKS = 88;
export const SPECIAL_SHOCK_AMMO = 3;
/** Self-centred pulse radius (world units). */
export const SPECIAL_SHOCK_AOE_RADIUS = 12;

// Turrets (sandbox dummies AND base ring turrets share combat stats for now).
//
// This global is dead on all six PLAYABLE arenas — each carries the original's
// imported weapon profiles at 6 m and sim.ts prefers them — so it reaches only
// district-01 (not in MAP_REGISTRY) and the sandbox. See the reach note above
// for why it is not simply pulled to 6 with them.
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
export const PAD_REPAIR_HP_PER_TICK = 0.5; // 15 hp/s

// Economy (rules.md §3). One resource: points, open information.
export const STARTING_POINTS = 20; // enough for an opening wave, not a Juggernaut
export const TRICKLE_INTERVAL_TICKS = 300; // 1 pt per 10 s
export const TRICKLE_POINTS = 1;
export const POINTS_CAPTURE_TURRET = 3;
export const COST_RUNNER = 1;
export const COST_GUARDIAN = 1;
export const COST_JUGGERNAUT = 50;
export const COST_FORTRESS = 50;
export const COST_OUTPOST_CLAIM = 30;
/** Units bought at an owned outpost (forward spawn) cost this multiple. */
export const OUTPOST_COST_MULTIPLIER = 2;

// Console purchases: stand on the console pad and HOLD interact — one unit
// per completed hold (rules.md §3: 0.5 s per unit). FIRE2 modifier orders the
// heavy variant at base consoles and the air unit at outpost consoles.
export const CONSOLE_RADIUS = 3;
export const CONSOLE_HOLD_TICKS = 15; // 0.5 s
export const JUGGERNAUT_ALIVE_LIMIT = 1; // rules.md §3
export const FORTRESS_ALIVE_LIMIT = 1;

// Neutral turret capture (rules.md §5).
export const CAPTURE_RADIUS = 5;
export const CAPTURE_TICKS = 90; // 3 s uncontested
export const NEUTRAL_TURRET_RESPAWN_TICKS = 1350; // 45 s, respawns neutral
/** Destroyed outpost consoles return (neutral) after this many ticks. */
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
export const ORBIT_ANGULAR_SPEED = 0.6; // rad/s patrol orbit
export const UNIT_SEPARATION_RADIUS = 2.4; // friendly ground units push apart
export const UNIT_SEPARATION_PUSH = 0.5; // fraction of overlap resolved per tick

// Death & respawn (rules.md §2: 8 s).
export const RESPAWN_TICKS = 240;

// --- Warden (rules.md §7, PLAN Phase 4) -------------------------------------
// The solo-opponent superplane: flies over everything, stronger than the
// player Avatar, plays by the same economy. All decision inputs that scale
// with difficulty live in the arrays below, indexed by (difficulty - 1).

export const WARDEN_HP = 450; // "stronger than the player Avatar" (300)
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
// 28 m is the original's aircraft target_detection_range (28672 raw), which is
// what this radius is: the distance at which the Warden NOTICES a threat to its
// gate, not the distance it shoots from. It was 55.
export const WARDEN_DEFEND_RADIUS = 55;
/**
 * The same radius on a Precinct Assault arena (rules.md §9), where it has to mean
 * something different because the loss condition does.
 *
 * Under §1 a ground unit that reaches the gate wins the match on the spot, so an
 * enemy unit anywhere near it is the loss condition itself and outranks every
 * other goal — which is what the 55 m above is for. Under §9 the same unit has to
 * chip a 3000 HP core at CORE_DAMAGE_PER_SHOT, and both bases produce a free
 * Runner every 5 s, so "an enemy ground unit within 55 m of the gate" is not an
 * emergency, it is the steady state. Measured over ten-minute difficulty-8
 * matches: the Warden spent 63%, 89% and 91% of its ticks on WGOAL_DEFEND on
 * la-cantina, urban-jungle and bug-hunt, never pushed, and resolved nothing.
 *
 * At 16 m the goal keeps its meaning — a ground unit's own reach is 14-16 m, so
 * inside it something is already shooting the base's own guns and is one step
 * from CORE_ATTACK_RADIUS — and everything further out is left to the 16 ring
 * turrets and 4 built-in guns that exist for exactly that.
 */
export const WARDEN_CORE_DEFEND_RADIUS = 16;
export const WARDEN_STANDOFF = 24; // approach distance for attack goals
export const WARDEN_ESCORT_DISTANCE = 6; // hover distance from the escorted unit
export const WARDEN_RETREAT_DONE_HP_PERCENT = 80; // leave the pad at this hp

/**
 * Difficulty 1–10 knobs (PLAN Phase 4), indexed by (difficulty - 1):
 * reaction delay between decision re-plans, trickle-income multiplier in
 * percent (100 = the player's rate — the Warden never cheats other earnings),
 * and the aggression percent that gates harassing, Juggernaut savings and how
 * low its hp may drop before it runs home to repair.
 */
export const WARDEN_REACTION_TICKS: readonly number[] = [48, 42, 36, 30, 24, 18, 12, 8, 5, 3];
export const WARDEN_INCOME_PERCENT: readonly number[] = [
  50, 65, 80, 90, 100, 110, 125, 140, 170, 200,
];
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
 * base — 16 ring turrets and 4 built-in guns — sits within 16 m of its core, and
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
 * mattering, inside the 6 m the emplacement itself reaches, and trades.
 */
export const WARDEN_SUPPRESS_DISTANCE = 3;
/** Guardians kept alive for base defense. */
export const WARDEN_GUARDIAN_TARGET: readonly number[] = [0, 0, 1, 1, 1, 2, 2, 2, 3, 3];
/** Aggression at or above this saves 50 points for a Juggernaut push. */
export const WARDEN_JUGGERNAUT_AGGRO = 60;

// Points (rules.md §3, the Phase 1 stub subset).
export const POINTS_KILL_AVATAR = 10;
export const POINTS_KILL_TURRET = 2;
export const POINTS_KILL_UNIT = 1;

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

// --- Precinct Assault mode (rules.md §9) ------------------------------------
// Everything here is inert on arenas whose map data carries no PA features.

/**
 * Hard ceiling on units a base may have alive from free production, whatever the
 * map asks for. This is a CORRECTNESS guard, not balance: two bases producing
 * every 5 s would add ~24 units/minute and fill the entity store in minutes.
 */
export const PA_PRODUCTION_ALIVE_LIMIT = 8;

/** Power-up kinds; must match the mapping in tools/generators/enrichArena.ts. */
export const PICKUP_HEAVY_AMMO = 0;
export const PICKUP_SPECIAL_AMMO = 1;
export const PICKUP_HEALTH = 2;
export const PICKUP_INVULN = 3;
export const PICKUP_INVIS = 4;
export const PICKUP_POWER = 5;
export const PICKUP_KIND_COUNT = 6;
/** Avatar must be within this of a pickup spot to take it. */
export const PICKUP_RADIUS = 2.5;
export const PICKUP_HEALTH_AMOUNT = 100;
export const PICKUP_INVULN_TICKS = 300; // 10 s
export const PICKUP_INVIS_TICKS = 300;
export const PICKUP_POWER_TICKS = 450; // 15 s
/** Damage multiplier while a POWER pickup is active. Integer: exact in binary. */
export const PICKUP_POWER_MULTIPLIER = 2;

/** Base-intrusion trigger watch bits (fcop-logic.md §8.6). */
export const TRIGGER_WATCH_ENEMY_AVATAR = 1 << 0;
export const TRIGGER_WATCH_ENEMY_UNITS = 1 << 1;
export const TRIGGER_WATCH_OWN_AVATAR = 1 << 2;
/** Re-arm delay, so one intruder loitering does not fire the alarm every tick. */
export const TRIGGER_REARM_TICKS = 90; // 3 s

/** Damage a ground unit deals to an enemy base core, per its own cooldown. */
export const CORE_DAMAGE_PER_SHOT = 10;
/** How close a ground unit must be to the enemy core to damage it. */
export const CORE_ATTACK_RADIUS = 6;
