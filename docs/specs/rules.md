# rules.md — Game Rules

Status: v1 (initial balance values are placeholders — tune via playtesting)

**Names.** This spec uses the original's: the **X1-Alpha** (the player's mech),
the **tank**, the **jet**, the **Dreadnought**, the **Flying Fortress** and the
**Sky Captain** (the solo opponent), as Future Cop: L.A.P.D.'s results page and
voice lines name them. The code keeps Metropolis' older identifiers: X1-Alpha
(`AVATAR`), tank (`RUNNER`), jet (`GUARDIAN`), Dreadnought (`JUGGERNAUT`),
Flying Fortress (`FORTRESS`), Sky Captain (`WARDEN`).

Design pillars, in priority order:

1. **The player is escort and disruptor, never the win condition.** You cannot win
   by attacking the enemy base yourself. Only your units can breach.
2. **Presence is currency.** Building happens at physical consoles; capturing
   requires going there and pressing the action key. Every decision costs map
   control.
3. **Units are dumb on purpose.** They follow lanes blindly and die easily.
   Their stupidity creates the escort gameplay.
4. **Readable in 5 minutes, deep over 50 matches.**

## 1. Match structure

- 1v1. Each side: one **Base**, one **Avatar** (player- or AI-controlled).
- Arena contains neutral **Turrets** and neutral **Outposts**.
- **Win condition: a friendly ground unit (tank or Dreadnought) physically enters
  the enemy Base gate.** Nothing else decides the match — not a jet, not an
  avatar. The breach decides it; the match then plays on for a 5.83 s outro
  (`MATCH_OUTRO_TICKS`, the original's 1750-tick countdown) and ends. A second
  breach during the outro changes nothing. This is also the original Precinct
  Assault's rule (§9; `fcop-fidelity.md` R1).
- No match timer in v1 (original had none; revisit if stalemates emerge).

## 2. The Avatar

- Transforming vehicle with two modes (toggle, 1.37 s transformation):
  - **Walker**: slower, can jump, precise handling, better on slopes.
  - **Hover**: fast, drifty (low traction), can cross water, cannot jump (the
    jump button brakes it), steep slopes impassable.
- **Both forms move by the original's models** (SIM_VERSION 39,
  `fcop-fidelity.md` P4/P5; `fcop-re/player-and-weapons.md` §3-§5), run at 30 Hz
  as 1.25 of the original's 37.5 Hz movement steps in closed form (`balance.ts`
  "X1-Alpha movement"): every step `v += push - drag * v`, gravity 26.1 m/s² to a
  14.06 m/s terminal fall in both forms, and a landing over 10.78 m/s costs
  health (the original's absolute 1000 f(x) HP).
- **Difficulty** (SIM_VERSION 72; `fcop-fidelity.md` P1, P2, P13, W1): each
  player picks the original's **HARD, NORMAL or EASY** (`SimOptions.difficulties`,
  NORMAL by default, the original's default pick): the solo menu offers the
  three plates in the original's order (`?difficulty=hard|easy` in a deep
  link); an online match plays NORMAL for both until its lobby offers the
  pick. It sets the mech's
  health, its magazines and what deep water does to the walker (below). The
  Sky Captain's slot has none: its difficulty is its level (§7).
- **Health: 1000 / 1250 / 1500** on HARD / NORMAL / EASY
  (`AVATAR_HP_BY_DIFFICULTY`; 1250 for everyone from SIM_VERSION 41 to 71;
  `fcop-fidelity.md` P1): every PA X1Alpha record stores 1000, and the pick
  scales it by 100, 125 or 150 %. No regeneration in the original, and none
  here: the own base pad's 15 hp/s repair, Metropolis' own, went in SIM_VERSION 53
  (`fcop-fidelity.md` P1; health comes back from the health pickup and a respawn).
  It was 300 HP until v41.
  | | Walker | Hover |
  |---|---|---|
  | fore/aft | **4.69 m/s**, 95 % in 0.17 s | **9.38 m/s**, 95 % in 1.56 s |
  | strafe | 3.13 m/s | 2.93 m/s |
  | released | stops dead under 0.59 m/s (~0.1 s), once its legs' step lets the state go | coasts, half-life 0.36 s, stops under 0.15 m/s; after ~6 s idle the drag ramps up |
  | brake | — | the jump button: drag 0.15 a step (0.05 coasting) |
  | cap | — | 10.7 m/s horizontal |
  | turn | 105°/s at rest, falling linearly to 0 at 18.75 m/s (79°/s running); none in the air | 158°/s after a ~0.26 s ramp; also in the air |
  | ride | on the ground or the deck within a step | 0.5 m over the surface its probe finds 0.4 m above it — ground, water or a deck (SIM_VERSION 63, P14); off a ledge it falls |
  | slope | pushed downhill above 17.5°, climbs to a 1.04 gradient | pushed downhill above 14.5° |
  | slow row (Action held) | 1.95 m/s fore and sideways; no jump (Jump alone crouches); stops at a 0.1 m drop on slow forward, back and Jink Left | 4.69 m/s fore, 1.47 m/s sideways |
  A diagonal (fore/aft + a jink) pushes as hard as straight ahead, at 45°. All
  input is digital, the original's button word (`input.spec.md`; SIM_VERSION 69):
  forward over back, Jink Right over Jink Left, both jinks cancel, the hover's
  brake over every direction. On Ovmp's code-4 patches the walker's movement
  mode makes the ground slippery: the same top speed, reached over seconds, and
  a glide when let go (SIM_VERSION 71, `fcop-fidelity.md` P11).
- The **walker** moves by the original's **state machine** (`walker.ts`,
  SIM_VERSION 83; `fcop-fidelity.md` G11, P4): one step per 8 units of the
  300 Hz clock, the button word decoded into a command each tick, the command
  taken into the walker's state unless the leg track playing holds it, and the
  state's arm — not the buttons — giving the push. So a move finishes the legs'
  step before another is taken (back while walking forward walks on until the
  stride ends), a landing, the crouch's stand-up and a jump's wind-up hold the
  walker where it is, and a mech fresh from its spawn has no control for its
  first step. Released, a moving state stops at once.
- The change (`TRANSFORM_LOCK_TICKS`, **41 ticks = 1.365 s**, the original's
  `player_transform_step`; SIM_VERSION 38, `fcop-fidelity.md` P3) is a
  **commitment**: no driving, no turning, no jumping and no lock cycling for its
  whole length, while the hull **coasts on hover physics** in both directions
  and its ride height ramps. The **weapons stay live** — all three slots fire
  through it, as the original's do (Metropolis locked them until v38). It is
  refused while a change is running and **on water in either form**. It was 15
  ticks while the change was a one-frame mesh swap and 24 while it was sized to
  the morph (`assets.md` §4); the morph now plays over the original's length.
  It is the original's **chord**: Change Target and Action held together, read
  as a level — held through a change it starts the next (SIM_VERSION 69).
- **Drive and strafe relative to the facing**, as the original does: Move
  Forward / Backward along it, Jink Left / Right across it. **Turn with the turn
  buttons** at the form's rate — Turn Right turns clockwise seen from above. The
  guns point where the hull points, or at the lock; the lock never turns the
  hull (SIM_VERSION 69; until then Metropolis steered by an absolute heading from
  the mouse or a stick).
- The slope asymmetry is **deliberate**: `AVATAR_HOVER_MAX_SLOPE` (0.5) is
  stricter than `AVATAR_WALKER_MAX_SLOPE` (1.04), because hover rides clearance
  and trades terrain for speed and water. Each form has ground the other cannot
  take, and neither is meant to go everywhere. The walker's gate is where the
  original's slope push stops its walk (the original has no hard gate); it was
  0.6, which the original's walker walks straight up. The hover's is Metropolis'
  issue-#34 rule (the original's push stalls a hover near 0.62).
- What each form measures a climb **over** is part of the asymmetry, not an
  implementation detail (issue #34). The walker judges the step it is taking. The
  hover judges the step AND the ground `HOVER_CUSHION_SPAN` (2.4 m, its own
  footprint) further on, and is stopped only when both are too steep — a cushion
  rides over a step its hull spans and is beaten by ground that keeps climbing.
  Judged per tick instead, the two are one reading: on a bilinear heightfield a
  0.17 m kerb is a 0.58-gradient wall while you are on it, which is how the hover
  used to be locked out of 10-13% of every FCOP arena's road network, la-cantina
  included. The step it clears this way tops out at span × limit = **1.2 m**.
  Since SIM_VERSION 39 that is a little over the walker's one-cell step (1.04 m),
  so the hover owns single steps of 1.04-1.2 m with flat ground beyond (2, 6 and
  7 lane edges on urban-jungle, proving-ground and bug-hunt), while the walker
  owns all sustained climbing — twice the hover's gradient. (Until v39 the
  walker's air-steered 1.4 m jump outreached the cushion.)
- Neither of those makes the originals' terrain uniformly drivable, and it should
  not: their roads also carry 1.3-3 m steps. Those are walls for both forms —
  transform or route around. `fcop-arenas.test.ts` pins per arena what each form
  cannot pass, and how many teams can drive their whole road network in hover
  (7 of 8, and la-cantina is clean in both forms). A climb-free walking path to
  the enemy base exists on every arena.
- The **jumps** are the original's three, chosen by one button the way it
  chooses them (SIM_VERSION 39; their timing the state machine's since
  SIM_VERSION 83): already running (the walker's run state), the **leap** —
  the legs take its track at the press and the next step leaves the ground,
  7.32 m/s up, +1.76 m/s forward on top of the run, apex 0.91 m; otherwise,
  with ground rising over 0.34 m within a metre ahead, the **high jump** — a
  wind-up on the ground, **0.4 s** after the press, then 8.79 m/s straight up,
  apex 1.37 m, and a +2.11 m/s forward lunge 0.24 s later unless that rise is
  over 1.1 m; otherwise the **hop** — a **0.2 s** wind-up, then 6.45 m/s up and
  +4.69 m/s forward. Forward and Jump pressed together from standing hop. The
  wind-up leaves the ground when the legs' wind-up track reaches the one the
  original flags LAUNCH; until then the walker does not move. Jump is a
  **level**: held, the walker jumps again once its landing has run back to the
  stand. No air control, no turning in the air, and no jumping off ground
  steeper than 38.7°.
  The original made the high jump for ledges with vertical faces; on a
  heightfield every step is a one-cell ramp, and the jumps climb nothing the
  walk does not (`units.ts` JUMPABLE_RISE 0, was 1.4 with an air-steered jump),
  so the walker's reach on the imported arenas is its walk: the 1.04-1.4 m steps
  the old jump cleared are walls now, the 0.6-1.04 m ones it had to jump it
  walks.
- **Water** (SIM_VERSION 59, `fcop-fidelity.md` P13): hollywood-keys and
  venice-beach carry the original's water, each cell at its own level (Hk's main
  water at −0.97 m, Ovmp's at −2.5 m); the other four arenas have none. The hover
  rides on it. On NORMAL and EASY a walker that enters it changes to hover on
  its own, and on water a transform is refused in either form. **On HARD the
  walker sinks** (SIM_VERSION 72): from the tick after it reaches the water its
  buttons do nothing, its invulnerability is gone and it sinks 0.88 m/s
  (the original's 0xc0 wu a movement step) through whatever lies under it; more
  than 1.75 m under the surface it drowns, 61 ticks (2.03 s) after it reached
  the water, credited to nobody, with no wreck, and comes back **0.5 s** later.
  Tanks drive through it: only the mech's own movement reads it. (Until v59 no
  imported arena had water.)
- **Lifts** (SIM_VERSION 64, `fcop-fidelity.md` P12): a lift moves only its
  height between its stops. It rests at the bottom until the mech standing on
  it presses the Action Key, rises at its own speed, waits 1.5 s at the top and
  comes back down by itself, faster. Its top is ground: the mech rides it and
  steps off at the top onto the deck it serves. A lift under a base's spawn
  (Slim, Joke) is that base's floor and hurts the enemy mech standing on it.
  On proving-ground and bug-hunt each mech spawns on one (SIM_VERSION 65): it
  rides up onto its base's platform and walks down the ramp to the consoles.
  On urban-jungle four stand in the sunken ring around the central platform
  (SIM_VERSION 67) and carry a mech up onto it.
- **Kerbs are steps** (SIM_VERSION 65, `fcop-fidelity.md` P15): a face between
  two floors at most 0.46 m apart, with nothing standing above it, is walked
  over as the original's walker steps up onto it — on the arenas re-imported
  so far (proving-ground, bug-hunt, urban-jungle). Taller faces stay walls
  both ways.
- Same three weapon slots in both modes: Gun, Heavy, Special.
- **The weapon catalog is the original Precinct Assault set only** (SIM_VERSION
  26): **ten weapons**, four Guns / three Heavies / three Specials. Default kit
  matches the original weapons screen: Powered Mini-Gun · Hell Fire 2000 ·
  Mortar Launcher.
  | Slot | Weapons (original loadout code) |
  |------|---------|
  | Gun | Powered Mini-Gun 0x00, Gatling Laser 0x01, Flamethrower 0x02, Electric Gun 0x03 |
  | Heavy | Hell Fire 2000 0x10, Concussion Beam 0x12, Hyper Velocity Rocket 0x13 |
  | Special | Mortar Launcher 0x20, Pop-Up Mines 0x22, Shockwave Generator 0x23 |
  The original's other five — Riot Shield 0x05, Fusion Torpedo 0x14, K-9 Drone
  0x15, Plasma Flare 0x21, Grenade Launcher 0x24 — Precinct Assault never
  offers; Metropolis offers each behind its own "Spielregeln" switch (below).
- **The extra weapons** (SIM_VERSION 90; the owner's decision,
  `fcop-fidelity.md` W5, F23): `SimOptions.extraWeapons`, a bit each —
  0 Riot Shield, 1 K-9 Drone, 2 Grenade Launcher, 3 Fusion Torpedo, 4 Plasma
  Flare (`weapons.ts` EXTRA_WEAPON_*) — **all off by default, the original's
  PA**. Online the host sets them (`MatchConfig.extraWeapons`), solo the
  preferences (`?extra=<mask>` in a deep link); the replay header carries them
  with every loadout (format 5). They are appended to their slots, so the ten's
  indices hold: Gun 4 Riot Shield; Heavy 3 K-9 Drone, 4 Fusion Torpedo;
  Special 3 Grenade Launcher, 4 Plasma Flare. A loadout naming one whose bit is
  clear is refused onto the slot's last PA weapon. Each is the original's, on
  its record and its kind's code (NORMAL's rounds):
  | Weapon | Block A | Block B (powered) |
  |---|---|---|
  | Riot Shield | the trigger toggles a sphere about the mech, the front half: 20 a tick to what it touches, 1.6 m, a gun round every 0.06 s while up, 750 | the whole sphere, 40, 2.4 m, its arcs strike again, 375 |
  | K-9 Drone | ground-hugging homing drone, 150 on its hit, 300 health (a weak body costs it that body's health and it hunts again), every 3.0 s, 0.59 → 4.69 m/s, 16 m, 31 | three on three ticks, 200, every 4.0 s, 22 |
  | Fusion Torpedo | homing torpedo, 100 on its hit and in a 1 m blast cut by the distance flown over its 16 m, every 1.0 s, 1.46 → 11.7 m/s, 50 | 150, 2 m, 12 |
  | Grenade Launcher | a bouncing grenade on the ballistic solve (7.6 m/s against 8 m/s², 7.25 m): 5/8 vertical and 7/8 horizontal kept per bounce, off at rest, on a body, after 3.0-4.5 s, or on the next press; 400 in 4.2 m, every 1.0 s, 37 | a burst of two, 0.06 s apart (each its own press, as the second press of a live one sets it off), 600, 20 |
  | Plasma Flare | lobbed flare (7.6 m/s against 5.2 m/s², 11.2 m), off where it lands or on the next press; 250 in 6 m, every 2.0 s, 37 | bursts into four at its apex, 200 each, 6 m, every 3.0 s, 18 |
  Rounds inside a Riot Shield take 300 one tick in eight (powered: 1000). The
  Sky Captain never carries them: its weapons are the aircraft's own.
- **Every number is the original's own weapon record** (SIM_VERSION 41;
  `fcop-fidelity.md` W1; `fcop-re/player-and-weapons.md` §7,
  `player-weapons.json`): each weapon's block A (as issued) and block B (powered
  up, §9), converted the way the loader converts them (`balance.ts`
  WEAPON_RECORDS, `weapons.ts`). They replace the rate and damage scaled off the
  front-end panel bars, and the ranges, speeds, TTLs, blast radii and magazines
  Metropolis had invented. Damage is absolute HP against the 1250-HP mech.
  | Weapon | Block A |
  |---|---|
  | Powered Mini-Gun | hitscan on the lock, 1 dmg every tick (30/s), 7500 rounds, 12 m |
  | Gatling Laser | the same, 6250 rounds |
  | Flamethrower | a stream of nodes at the lock, one every 2 ticks, each 6 dmg to every body it reaches (the lock twice), ~6.2 m; a round every tick it is held, 3750 rounds |
  | Electric Gun | 3 dmg on the lock every 2nd tick, 3750 rounds, 9.6 m |
  | Hell Fire 2000 | homing missile, 25 dmg, every 0.5 s, 181 rounds, 1.98 → 15.8 m/s, 16 m |
  | Concussion Beam | a beam growing from the muzzle at 1.25 m a frame, 50 once a shot to every body near it (ten at most), cut at walls; every 1.0 s, 93 rounds |
  | Hyper Velocity Rocket | 4 lead-aimed rockets on 4 ticks every 1.23 s, 30 dmg, 150 rounds, 2.5 → 19.9 m/s, 16 m |
  | Mortar Launcher | lobbed shell, 200 in a 3.2 m blast, every 2.03 s, 31 rounds, 7.6 m/s under 6 m/s² (reach 9.7 m) |
  | Pop-Up Mines | dropped charge: falls from the muzzle, bounces, and blows where it settles (about 1.4 s); an enemy within 2 m + its radius springs it first (it pops up and blows 1 s later); 600 in a 5.6 m blast, every 1.0 s, 37 |
  | Shockwave Generator | an expanding shell on the mech out to ~6.4 m, blasting the band it swept every 4th tick: `300 × (outer − d) / outer` a blast; every 3.03 s, 25 |
  The rounds above are NORMAL's: the records hold HARD's magazines, NORMAL adds
  a quarter and EASY a half (truncated, the loader's shifts; SIM_VERSION 72 —
  NORMAL for everyone before), and every slot has a magazine, the Gun's included
  (it was infinite). Ammo pickups fill a slot to its
  ceiling, and so does a respawn; no pad does (SIM_VERSION 53, below).
- **The trigger** (`player_fire_slot`): Gun and Heavy fire on every tick they
  are held; each round ADDS its gap (raw × 4096/218 engine units) to the slot's
  cooldown, which loses 10 units a tick floored at zero, and a round goes out
  whenever it is back at zero. So a gap of 0 fires every tick — **30 rounds a
  second, the original's frame-bound rate pinned at 30 fps** — a gap of g every
  ⌈g / 10⌉ ticks, and a negative round gap carries over (the Hyper Velocity
  Rocket's burst). Special is held-fire too; it becomes press-to-fire, with a
  second press detonating the kept round, only with a kept-round weapon (Plasma
  Flare, Grenade Launcher: extra weapons, above).
- **The lock decides what is hit** (`fcop-fidelity.md` W2; `input.spec.md`
  §4.4): 12 m horizontal, acquired within ±12.5° of the facing (automatically
  whenever there is none), held within ±25°. The hitscan guns damage **only the
  lock** — with no lock the line does nothing, except a powered (block B) gun
  with a blast, which area-damages where the line ends — and a wall on the line
  stops them. Hell Fire 2000 homes on the lock; the Hyper Velocity Rocket is
  lead-aimed at it and flies straight; arced shells solve the original's
  ballistic (the high root: a lob) to the lock, or to 8 m ahead with none.
  Missiles launch at an eighth of their top speed and accelerate to it, and fly
  their record's range.
- **Blasts fall off linearly over horizontal distance**, centre to centre:
  damage × (r − d) / r (`cact_area_damage`). Rounds without a blast damage only
  what they strike.
- **Declared deviations, none hidden** (each waits on the RE,
  `fcop-re/player-and-weapons.md` §9):
  1. ~~How the Flamethrower, the Concussion Beam and the Shockwave spread their
     damage~~ **settled** (RE M3-OR, SIM_VERSION 105, `sim/src/sustain.ts`): the
     original's trails and shells, as `fcop-fidelity.md` W1 tells. Kept: the
     Shockwave's start radius (0.8 m, the client's scale; the original's could
     not be established), a body's hit radius standing in for its horizontal
     half-extent, the wall lattice for the terrain trace.
  2. The homing turn rate (`MISSILE_TURN_RATE`, ours: 180°/s), the Hyper
     Velocity Rocket's exact lead, the powered Hell Fire's split (three missiles
     fanned at launch, ours). ~~The powered Mortar's fragment spread (ours)~~
     **the original's** since SIM_VERSION 109: four fragments, one per quadrant,
     and the shell itself flies on and goes off where it lands.
  3. ~~Mines: whether an untriggered mine goes off after its 5 s lifetime~~
     **settled** (RE M3-OP, SIM_VERSION 101): it never waits. The dropped round
     goes off the tick it comes to rest, so the arming delay, the 30 s silent
     despawn and the placing at the feet are gone. Kept: the fuse measures the
     ground plane from the body's position (the original: three axes from its
     reference point).
  4. ~~The powered Electric Gun's arc to two more targets is not modelled.~~
     **Modelled** (SIM_VERSION 107, `player_arc` 0x00459bd0): block B jumps from
     a lock it reached to at most two more enemy bodies inside a 4 m cube about
     the lock, 6 damage each.
- **Deliveries:** Pop-Up Mines drop a bouncing proximity charge from the muzzle.
  Shockwave Generator is an expanding shell riding the mech — no aim, no projectile travel.
- Slot membership: the **Concussion Beam is a Heavy**, not a Special.
- **No pad refills or repairs a mech** (SIM_VERSION 53; `fcop-fidelity.md` P1,
  R14): the original has no base pad and no outpost refill. Ammo comes back from
  the ammo pickups and a respawn, health from the health pickup and a respawn
  (§9). Metropolis' pads (the own base pad's 15 hp/s repair, the 4 m outpost ammo
  refill) are gone.
- Death: the avatar respawns **4 s** after going down (`RESPAWN_TICKS` 120, the
  original's `player_op4` countdown; SIM_VERSION 37, `fcop-fidelity.md` P2) — 0.5 s
  after HARD's water drowned it (`RESPAWN_SUNK_TICKS`, SIM_VERSION 72) — at its
  team's fixed spawn, **facing as its X1Alpha record says** (SIM_VERSION 57, P10;
  it was the field axis toward the enemy base, which the record agrees with on
  four arenas — only urban-jungle and hollywood-keys moved), in the spawn's form
  (walker, or hover where the record asks for it — both of hollywood-keys').
  It comes back with full health and full ammunition and **loses its power-up**;
  a running cloak or invulnerability keeps counting down. While down it is not
  drawn and cannot be hit, because it is not there. There are no lives. Going
  down pays the **other side 10 pts and costs the downed side 10** (never below 0),
  whoever did it, settled when the avatar respawns (the original's rule, §3).
  The Sky Captain comes back after (14 − level) × 0.5 s (§7).
- The Base core is indestructible on every arena (pillar 1, and the original has
  no destructible core — §9). Base *turrets* are attackable by anyone.

## 3. Economy

One resource: **Points**. Both players start with `STARTING_POINTS` = **10**
(the Sky Captain on 0 and a free opening order, §7).
These are the original Precinct Assault's numbers (SIM_VERSION 33;
`fcop-fidelity.md` R2-R10, `fcop-re/ai-and-rules.md` §2). None of them reads
arena-specific data, so they apply on every arena.

**There is no income over time.** Points come only from these events, and a
death pays the **other** side whoever caused it — the original pays from the
dying actor's own script, not from a kill credit, so a unit lost to friendly
fire or the terrain still pays the enemy:

| Event                                              | Points |
|----------------------------------------------------|--------|
| An enemy tank or jet dies                   | +1     |
| An enemy Dreadnought or Flying Fortress dies               | +5     |
| An enemy base turret dies                          | +1     |
| A turret the enemy captured dies                   | +1     |
| You capture a neutral turret                       | +1     |
| The enemy avatar goes down (paid at its respawn; the Sky Captain's when it falls) | +10 |
| Your own avatar goes down (same timing)            | −10, never below 0 |

This replaced an invented table (start 20, 1 point every 10 s, capture 3, a
turret 2 and a unit 1 to the killer, 10 to an avatar's killer).

Spending (at the Base's shop spots / Outpost pads / the heavy zones, below):

| Purchase        | At Base | At Outpost | Limit (alive, per side) |
|-----------------|---------|------------|--------------|
| tank            | 1       | 2          | 20           |
| jet             | 1       | 2          | 20           |
| Claim Outpost   | 30 (action key in its claim zone) | —  | per outpost  |
| Dreadnought     | 50      | not available | 1          |
| Flying Fortress | 50      | not available | 1          |

The tank and jet caps count base and outpost purchases together, and a
tank counts from the purchase, queued or not (below). The Dreadnought and Flying Fortress
are one alive of each per side.

Buying = drive the Avatar onto the unit's spot and **press interact: one unit per
press**. That is the original's: there is no menu, every purchase spot is a
trigger that answers the Action Key on the frame it goes down, and holding it buys
nothing more (SIM_VERSION 51, `fcop-fidelity.md` R17; it was a 0.5 s hold per
unit). The spots are the original's:
- **Base**: a **tank spot** and a **jet spot**, each the original's trigger box
  about its console, imported per console (on Mp 1.2 × 1.2 m for the tanks,
  1.6 × 1.2 m and 1.6 × 1.6 m for the two sides' jets), widened by the buyer's
  radius (SIM_VERSION 56; it was a 3 m circle).
- **Outpost** (the owner only, 2 points each): a **tank pad** and a **jet pad**
  (§5, §9).
- **Dreadnought and Flying Fortress**: their own type-14 zones beside each base's
  shop, 50 points, one alive of each per side (SIM_VERSION 60, R10). FIRE2 no
  longer orders a heavy variant at the console. A zone is the record's radius
  (0.8 m, Conft's Dreadnought zones 1.0 m) plus the mech's. The zones open **for
  good** at the first points poll that sees 50 points: the original's fn30 /
  fn31 poll every 5 s (2.5 s on Joke and Slim) from a random phase drawn at load,
  so points held only between two polls open nothing. Since SIM_VERSION 80 the
  poll counts as the original's scheduler does, in engine ticks (1500 / 1525 on
  Mp, 750 / 765 on Joke and Slim) from `rand % period`, 10 a tick, so an odd
  period's polls fall 152 and 153 ticks apart. Closed, a zone is silent; open, it
  refuses short points or a living unit of its kind out loud. The run that opens
  the zones also requests the base's **two terminals** (the Dreadnought's and the
  Flying Fortress's kiosks by the zones, Cobj 34 / 35 on Mp), which stand from
  the next tick on (`MATCH_SLOT_TERMINALS`): until a side has held 50 points at a
  poll its base shows neither the terminals nor an answering zone.

A **tank is queued** (SIM_VERSION 61, R18): the press is accepted at once, with
the purchase sound, and the tank joins its side's spawn queue, which spawns one
unit a period — base tanks about 3.3–3.4 s (980–1020 engine ticks), outpost
tanks 975–1025 — from a random phase drawn at load. The queues run on the
original's scheduler (SIM_VERSION 84): each countdown in engine ticks, the
function's time units × 5, drawn as `rand % period` and taken down 10 a tick, so
a period of 1015 polls 101 and 102 ticks apart (until v84 they counted sim
ticks, rounded). So a purchase waits 0 to one period
for its first tank, then a period each, and queued tanks count against the
20-alive cap from the purchase. A **jet comes at once**. Every unit leaves its
spawner's position (the original's Csac template), not the console or the pad:
the base's tank or jet spawner, an outpost's own for each side. The Dreadnought
appears at its record (§9), the Flying Fortress at its own spawner (the Sky Captain's
too). Before v61 a tank appeared at once, at the console or the pad.

A press the spot refuses — the points are short, or 20 of that unit are alive —
is answered with a refuse sound, an accepted one with the purchase sound, as the
original's scripts answer every press. A press that claims an outpost buys
nothing on the same press.
Claiming an outpost is a press of the action key inside its claim zone with 30
points (§5), like a capture.
Points are visible to both players (open information, like the original).

## 4. Units

All units are unarmored-by-cleverness: no retreating, no plan.

- **Tank** — ground drone. Spawns at the tank spawner of the structure that
  built it (§3), follows the roads toward the enemy Base. Fragile. **Reaching the
  enemy gate = victory.**
- **Jet** — air drone. Built at Base: patrols a radius around own Base and
  engages enemy air/ground that enters. Built at Outpost: flies toward the enemy
  Base and attacks it and its defenders (offensive mode). Same stats, spawn
  location decides behavior — this asymmetry is a core strategic choice.
- **Dreadnought** — heavy tank. Slow, high HP, same dumb pathing. Also wins by
  entering the gate. The classic play: save 50, escort it personally.
- **Flying Fortress** — heavy jet, defensive only, large patrol radius, homing
  shots, long lifetime. The anti-rush insurance.

**On the imported arenas the ground units are the original's route followers**
(SIM_VERSION 44; `fcop-fidelity.md` U1/U2, `fcop-re/ai-and-rules.md` §4). Each
side's tanks and Dreadnought drive that side's own original road net, a directed
graph, and choose their way at every node:
- a **tank** seeks: on 60 % of its steps it looks for the nearest
  enemy (any enemy actor — avatar, unit, turret, the Sky Captain; not a cloaked
  avatar) within **16 m** and takes the link whose step points most toward it,
  judged by octaves of the dot product, so two links within a factor of two are a
  tie; with nobody that close, and on the other 40 % of steps, it steps at random;
- a **Dreadnought** always steps at random;
- a link already taken by a friendly follower counts an octave less per follower
  (the original's traffic avoidance); a follower **never steps straight back**,
  and takes the node before last only from a dead end; ties are a coin flip;
- they drive at **1.98 m/s** (both; the original's route block), on the road
  itself, and **never stop to fight**: their guns fire on the move. Traffic only
  slows them, for 1 s at a time: behind a friendly follower heading for the same
  node they take half its speed, a non-follower within 2 m dead ahead stops
  them, a slightly further one slows them; the Dreadnought ignores traffic.
The original's nets are built so that this walk always reaches the enemy gate —
measured over 400 random walks per side on all six arenas, every one gets there,
along 150–220 m of road on average (about 75–110 s unopposed). This replaced
Metropolis' committed next-hop signposts with a seeded coin at forks, 4 m/s
tanks and 2.5 m/s Dreadnoughts that halted for anything in reach.

**Targeting on the imported arenas is the original's too** (SIM_VERSION 45,
`fcop-fidelity.md` U4): a unit keeps its target while it lives, stays hostile
and stays within its 12 m reach, and looks for another only on its targeting
delay — 2.0 s for a tank or jet, 1.0 s for the Dreadnought's guns and the
Flying Fortress — so it does not switch to whatever comes nearer. A **jet or
Flying Fortress** is the original's aircraft: every 3.0–4.7 s it looks for the nearest
enemy within **56 m** (Flying Fortress **63.2 m**), flies at it while it stays inside a
patrol leash around the spawner it was built at (±24 × ±20 m, Flying Fortress ±30 ×
±28 m: the base, or the outpost it was bought at) and fires only then; pulled off
the leash it cruises back for 4–11 s with its gun silent. It never stops: inside
1 m of its target it reverses, so it circles and jitters about it.

On a map with no road graph (the test maps, which are debug fixtures only;
district-01, the other one, is gone — `fcop-fidelity.md` D2) the ground units
follow authored lane polylines toward the enemy gate — but as the original's
units (SIM_VERSION 52, owner's call): at 1.98 m/s, **never stopping to fight**
(their guns fire on the move; they used to halt for anything in reach), with the
original's targeting; jets and Flying Fortresses are the original's aircraft there
too, leashed to the spawner they were bought at.

Unit stats are the original's on every arena (§9; `balance.ts`
ORIGINAL_UNIT_PROFILES where an arena imports none): tank and jet 150 HP with
50-damage rounds every second, Flying Fortress 2000 HP with guided 100-damage
rounds every 0.5 s, Dreadnought 3000 HP with four 100-damage guns every 2 s, all at
12 m; the ground units drive at 1.98 m/s, the jet and Flying Fortress
fly at 4.0 and 4.8 m/s. Avatar 1250 HP (§2); walker 4.69 m/s, hover 9.38 m/s.
(Metropolis' placeholder table — tank 60 HP / 8 dps / 4 m/s, jet 50 / 10
/ 7, Dreadnought 600 / 20 / 2.5, Flying Fortress 500 / 25 / 6 — is gone.)

## 5. Structures

- **Base**: gate (win trigger volume), its shop — 2 build consoles (ground/air),
  a tank spot and a jet spot, with the Dreadnought and Flying Fortress zones beside them
  (§3) — a floor that hurts the enemy mech (§9), and a ring of **Base turrets**
  (the original's 6 or 8, §9). There is no ammo/repair pad (SIM_VERSION 53; the
  original has none). Base turrets respawn
  **37.5 s** after destruction, the original's ring spawner period (tSAC −2250;
  SIM_VERSION 50, `fcop-fidelity.md` R16) on every arena — the imported ones read
  it from the ring records. Attack timing matters: a cleared ring is back before a
  wave bought afterwards at an outpost could reach the gate, so the wave goes in
  with it. (Metropolis had 120 s, sized for its own superplane; issue #31.) Base
  core is indestructible: a centrepiece and anchor, never a target
  (§9: the original's "core" was its Dreadnought's spawn point).
- **Neutral turret**: dormant until captured (it shoots nobody). Captured
  **instantly** — no timer, no contest — by the original's rule (SIM_VERSION 34;
  `fcop-fidelity.md` R12, `fcop-re/ranges-turrets-capture.md` Q2):
  - an avatar **pressing the action key** (Interact, rising edge) within the
    turret's capture range plus its own radius (measured as below);
  - a **tank** simply coming that close, measured the same way;
  - the **Sky Captain** flying over it (flat distance, no button), as the original's
    Sky Captain does.
  jets, Dreadnoughts and Flying Fortresses never capture. The distance is the
  original's own estimate (SIM_VERSION 55, R12; `turret_op10`): an octagonal
  length in world units, taken flat first and then once more with the height
  difference folded in — flat only for the Sky Captain. (It was the Euclidean
  distance.) The range is the original's `(range + 1024) / 512` m on the imported
  arenas — 4.0 m on la-cantina, urban-jungle and venice-beach, 5.2 m on
  proving-ground and bug-hunt, 5.6 m on hollywood-keys — and Mp's 4.0 m
  (`ORIGINAL_CAPTURE_RANGE`) on a map that imports none (the test maps; it was
  Metropolis' 5 m until SIM_VERSION 52).
  Capturing pays +1 (§3). A captured turret fires at enemies of its owner and stays
  captured until it is destroyed; it then respawns **neutral after 25 s** (the
  original's spawner period; was 45 s). This used to be "stand in a 5 m radius for
  3 s uncontested, avatars only".
- **Outpost**: claimed by **pressing the action key** (Interact, rising edge, as
  a capture) inside its claim zone with 30 pts — no hold; −30, first come first
  served (SIM_VERSION 48, `fcop-fidelity.md` R14). The original's claim zone is a
  type-14 zone whose op-10 gate bit 0x04 refuses a player that has not pressed
  the button this frame (`fcop-re/outposts.md` Q3), so entering it is not
  enough; SIM_VERSION 35-47 claimed on entry, a misreading. A player's avatar
  claims; the Sky Captain claims only when it has decided to (the original's Sky
  Captain claims by a script decision, from wherever it is). Grants: forward spawn
  for tanks/jets (at 2× cost). There is no outpost ammo pad: it was
  Metropolis', not the original's, and went in SIM_VERSION 53.
  - Every arena has the original's four outposts, each with its claim zone (1.2 m
    + the avatar's radius, in 3D), a tank pad and a jet pad (the owner's only, 2
    points each; §3), and two **turret plates** (§9). A claim is **permanent**: the
    console marker takes no damage and nothing targets it. (SIM_VERSION 52: the
    claim zone was a flat 3 m on district-01, whose outposts were consoles with no
    pads or plates, and an enemy could destroy a console and revert the claim.
    district-01 is gone, D2.)

## 6. Arena anatomy

- Logical playfield: 2D plane + heightfield (see architecture.md). Water areas
  (hollywood-keys, venice-beach; §2): the hover rides them, a walker that enters
  turns hover (sinks and drowns on HARD), tanks drive through. Jump-only ledges: walker shortcuts.
- 2–3 ground lanes between the bases; lane graph is authored per map
  (waypoint polylines, no runtime pathfinding in v1). **Amended (§9, §4):** an
  arena may instead carry the original's waypoint *graph*, one directed net per
  side. That is still not runtime pathfinding: since SIM_VERSION 44 a unit makes
  the original's local step choice at each node — it scores at most four
  neighbours against the nearest enemy, or at random — and never searches a
  route. (Until then the routes were searched once at authoring time and
  committed as next-hop signposts; the arena pipeline still computes them, and
  uses them with its road walker to prove every road's wall bits open — the
  production console to the entry node, the net, and the far end to the enemy
  gate (issue #30) — but the sim no longer reads them.) A unit on the graph walks
  each leg to its full length, on the road, so the pipeline's open walls are the
  only ones it meets.
- The game has **six arenas**, all imported from the original (§9):
  urban-jungle (Conft), proving-ground (Slim), la-cantina (Mp), bug-hunt (Joke),
  hollywood-keys (Hk) and venice-beach (Ovmp). The test maps (test-128,
  layered-test) are debug fixtures only. District-01, Metropolis' own arena, left
  the game on the owner's call of 2026-10-14 (`fcop-fidelity.md` D2: only the
  original counts).

## 7. Solo opponent (the Sky Captain)

**The solo opponent is the original's Sky Captain** (SIM_VERSION 46;
`fcop-fidelity.md` U3, `fcop-re/ai-and-rules.md` §1): an aircraft with a
commander's decision pass, playing the second side by the human economy's rules.
It replaced Metropolis' own superplane (450 HP, 10 m/s, a 42 m cannon and a goal
ladder of defend / buy / push / suppress / capture / escort / harass).

- **Level.** Difficulty 1–10 is the captain's level 0–9 (`wardenLevel`; the
  original's state word 19). It scales everything below. After a one-viewport
  win the original raises it by one — a campaign feature, not built.
  | Level | Health | Speed | Rethink | Respawn | Gun arc | Missile arc |
  |---|---|---|---|---|---|---|
  | 0 | 250 | 2.72 m/s | 2.8–3.7 s | 7.0 s | front | front |
  | 1–2 | 250 / 500 | 3.01 / 3.31 | 2.6–3.4 / 2.3–3.1 s | 6.5 / 6.0 s | front + sides | front |
  | 3–6 | 500–1000 | 3.60–4.05 | 2.0–2.9 … 1.2–2.1 s | 5.5–4.0 s | front + sides | front + sides |
  | 7–9 | 1000 / 1125 / 1250 | 4.20 / 4.35 / 4.51 | 1.0–1.8 … 0.4–1.3 s | 3.5 / 3.0 / 2.5 s | front + sides | all round |
  (front = within 22.5° of its heading, sides to 157.5°; defending, it rethinks a
  little sooner, by up to 0.1 s, instead of up to 0.85 s later.)
- **Weapons**, all sharing one target, which it takes only inside **12 m** and by
  distance alone, without a line of sight (SIM_VERSION 54; `fcop-fidelity.md` U3):
  a gun (2 damage every 0.06 s — a round every other tick), a guided missile (25
  every 0.5 s, flies 24 m) and a bomb (200 in a 3.2 m blast with falloff, every
  2.0 s). The gun fires anyway but damages only along a clear terrain line; the
  missile is put back on a blocked line; the bomb has no checks at all. Without a
  target of its own choosing its guns pick the nearest enemy in 12 m every 1.0 s.
  The missile's and bomb's speed is not established: they fly at Metropolis'
  25 m/s, the bomb flat.
- **Deciding.** On every rethink it scans the field from three places — its home
  (its spawn), the player's base, itself — and picks a mode:
  - **defend** (it is built in this mode) whenever an enemy tank or Dreadnought is
    near home (64 / 72 m), or while it owns fewer than **five team turrets**: its
    scan counts each live team turret within 256 m of home (the whole arena)
    **twice** — the original's turret is two type-8 actors, the turret and its
    base part (`fcop-re/outposts.md` Q2) — against a threshold of ten. Its ring
    and its outposts' plate turrets count; neutral turrets it captured never do.
    It engages that unit, or with none it flies at the player;
  - **attack** with its own Dreadnought (or tank) near the player's base: it escorts it;
  - **roam** otherwise: a badly hurt player within 40 m, then an enemy Dreadnought
    (40 m), tank (32 m), a neutral turret to capture (48 m), a jet (24 m), a turret
    the player captured (40 m), a Flying Fortress (24 m), then the nearest neutral or
    player-held turret anywhere, else the midpoint between the bases.
  Whatever the mode it shoots the player's mech when it comes within 12 m and it
  is not busy with the Dreadnought or tank it chose. It never patrols; inside 1 m
  of what it flies at it reverses, so it circles and jitters about it.
- **Retreat.** Below half its health less a random 0–63 (a quarter while
  defending or attacking) it breaks off for home, faster, and is restored to full
  within 2 m of it; cruising home it diverts to a nearer health pickup.
- **Economy.** Its budget **is** its side's Current Points (§3), but it starts on
  **0**, not 10 (a one-viewport game's), and from level 1 gets a **free opening
  order** of ten base units, 9 − level + 0–3 of them tanks and the rest
  jets. It earns exactly as a player does, and each credit makes it rethink
  at once; its fall costs it 10. It buys by request at the player's prices: base
  tanks/jets 1, outpost ones 2, an outpost claim 30 (from wherever it is,
  in a fixed order picked at the start), a Dreadnought or Flying Fortress 50 (a second
  Dreadnought while one lives spends the 50 and is refused — the original's quirk).
  Its requests go to the same shared spawn queues as a human's (§3; SIM_VERSION
  61, R18), each from its random phase and at its arena's own periods: base
  tanks about 3.3–3.4 s, base jets 0.8–0.97 s, on the original's engine-tick
  countdowns (SIM_VERSION 84). (It had queues of its own, a fresh countdown at
  each request.)
  What it buys depends on the mode: defending, jets and a Flying Fortress near home
  (and at level 9 a base tank against a threat at home); roaming or attacking,
  outpost claims; attacking, outpost tanks and jets; roaming, a Dreadnought
  and tanks at its outposts and its base.

**What this means on Metropolis' arenas (measured, SIM_VERSION 49).** On the
imported arenas its ring of 8 (6) counts 16 (12), so it leaves defend at its first
decision and roams: it captures pads, claims outposts (their plate turrets then
add 4 each), buys a Dreadnought with 50 and stocks tanks at its outposts and base,
and attacks behind them once they near the player's base. It falls back to defend
when an enemy tank comes near home or its turrets fall below five. Against an idle
player (4 arenas × 5 seeds, 15 min) every match resolves at difficulties 1 and 5,
17 of 20 at 8 (urban-jungle 2 of 5) and 7 of 20 at 10 (level 9 stocks no
tanks): an idle player is never downed, so once the pads in reach are taken and
an outpost is claimed its income stops (`tools/balance/src/paResolve.ts`; the
numbers are in the ledger's U3 row). SIM_VERSION 46-48 counted each turret once
(the earlier "8 base + 2 per outpost" reading), which kept it in defend on every
arena. (district-01, whose ring of 4 counted 8 and kept it defending all match,
is gone, D2.)

The Sky Captain flies over terrain and walls. Its gun damages only along a clear
terrain line and its missile is put back on a blocked one; its bomb has no
checks (SIM_VERSION 54, U3). Metropolis' old "superplane pierce" — a gun and
missile that reached ground units through walls — is gone.

## 8. Out of scope for v1

More arenas, 2v2, ranked/matchmaking, mobile touch controls, cosmetics,
replays-as-feature (replays exist as a test artifact from day one).

## 9. Precinct Assault mode (FCOP arenas)

Status: adopted for the six FCOP arenas; balance is measured on four of them —
`la-cantina` (mission Mp), `urban-jungle` (Conft), `proving-ground` (Slim) and
`bug-hunt` (Joke). `la-cantina` is
**multi-deck** since issue #29: it carries the two bridge decks its source terrain
describes, and its walls are attributed to the deck they stand on rather than
flattened into one lattice.

`hollywood-keys` and `venice-beach` are imported by the same pipeline and carry
the same §9 data, but have no balance pins yet. This paragraph used to say they
"stay on §1–§7". That is not for want of data —
their logic is extracted and committed. It is also NOT because their decks are
unreachable: that argument was retired as circular, because the extractor only
separates surfaces more than 0.5 m apart and keeps ramps inside the ground rank, so
"every deck is above the step height" is a restatement of its clustering constant.
Decks are entered sideways at their edges, and both arenas have thousands of such
entry cells. What is genuinely missing is per-FEATURE layer information: Hk puts 8
`Turret`, 3 `NeutralTurret` and 2 type-28 Dreadnought records on cells with a deck overhead and
nothing in `MapJson` can say which storey they belong to. See
`packages/sim/test/layeredArenas.test.ts` for the measurements and issue #33.

A deliberate deviation from §1–§6, taken on the owner's call: where the original
*Precinct Assault* mission data says how the arena works, the data wins. Every
rule below is per-arena map data where the original has a record for it. Since
SIM_VERSION 52 (owner's call) a map that carries none of it — the test maps, the
debug fixtures; district-01, which was another, is gone (D2) — is NOT left on
Metropolis' own numbers: it loads the original's turret and unit profiles,
capture range and claim zone with its own geometry (no road graph, pickups,
trigger volumes or outpost plates).

The original's decoded model is `docs/specs/fcop-logic.md` §8; this section is
only what Metropolis adopts from it.

- **Win condition — §1's gate, the original's box.** There is **no destructible
  core** (SIM_VERSION 32). This section used to adopt a "destroy the enemy base"
  objective with a 3000 HP core; the decompiled executable says otherwise
  (`fcop-re/ranges-turrets-capture.md` top + Q4, `ai-and-rules.md` §0/§5): actor
  type 28, extracted as "TeamBase?", is the **Dreadnought**, and the 3000 HP was
  its own. The original wins when an enemy **tank or Dreadnought** enters the
  base's gate trigger, then counts 1750 ticks (5.83 s)
  down to the results page, which is §1's rule and outro. Each base's gate is the
  imported gate trigger box (Mp 2457 × 1843 raw = 4.8 × 3.6 m; half-extent
  raw/1024 m, grown by the intruder's own radius). Jets and avatars never breach,
  so pillar 1 survives exactly as in §1.
- **No free production.** The original's tank, jet and Dreadnought spawners are
  shut in PA; units appear only when bought (§3), and then leave their spawner's
  position, as the original's do (the queue is §3's). The "1 tank per 5 s" this
  section used to adopt was the Dreadnought spawner's period.
- **The Dreadnought (JUGGERNAUT) is the original type 28.** It is bought at its own zone
  beside the base's shop (§3, SIM_VERSION 60) and rolls out at the type-28
  record (node 0 of its Cnet, beside the HQ) rather than at the console or the
  zone, with 3000 HP and four hull guns of weapon 3. Each gun is the original's
  mount (SIM_VERSION 77, `fcop-fidelity.md` I6): it stands on its attach point
  of the hull's model, turns 237°/s relative to the hull toward its own target,
  and fires its own round from its muzzle only inside ±22.5° of its own yaw. On
  bug-hunt the hull walks (Joke's model, 20 frames, one per 775 world units
  travelled) and each gun stands on, and fires from, its point in the frame the
  hull shows (SIM_VERSION 85). The "four built-in base guns" the core used to
  carry were these guns. On a map without the record (the test maps) it
  has the same 3000 HP and four guns and rolls out at the ground console; those
  maps have no heavy zones, so they sell none (SIM_VERSION 60).
- **Every shooter fires the original's catalogue weapon** (SIM_VERSION 42;
  `fcop-fidelity.md` W3; `fcop-re/ranges-turrets-capture.md` Q3). A shooter's
  `weapon_id` indexes the mission's own type-98 catalogue, whose entries are
  identical on the six PA maps (`balance.ts` WORLD_WEAPONS):
  | Shooter | HP | Weapon | Damage | Refire | Round |
  |---|---|---|---|---|---|
  | team turret, neutral turret | 500 | 3 | 100 | 2.03 s | 7.62 m/s, lead-aimed, flies 12 m |
  | Dreadnought gun (×4) | 3000 (hull) | 3 | 100 | 2.03 s | the same |
  | tank, jet | 150 | 1 / 6 | 50 | 1.0 s | 7.62 m/s, lead-aimed, flies 12 m |
  | Flying Fortress | 2000 | 4 | 100 | 0.5 s | 7.62 m/s, guided, flies 24 m |
  All engage at 12 m, horizontal and centre to centre. The rounds are entities
  that fly — they used to be instant hits — and damage only what they strike
  (none has a blast); the wall lattice stops them, the heightfield does not (a
  lobbed shell is the only round that meets the ground). The rate machine is the
  original's (`cact_shooter_step`): the reload clamps the leftover clock, so a
  2.0 s entry fires every 61 ticks. The tanks', jets' and Flying Fortress' HP and
  weapons come from their spawner records (`MapBase.runner/guardian/fortress`);
  their routing, speeds and targeting are the original's (§4, SIM_VERSION
  44-45).
- **Turrets carry their own parameters.** Range, fire cadence, gun slew, field of
  view, rest rotation, health and weapon come from the arena's imported data,
  for both kinds: capturable pads and base ring turrets. The original's reach is
  short: `engage_range` 6144 is 12 m (`raw << 4` world units —
  `fcop-re/ranges-turrets-capture.md` Q1), against the pre-PA global 28 m, and
  turrets are placed within a few metres of the road they guard. Units engage at
  the same 12 m, so a turret never outreaches the push it shoots at
  (`paAttribution.test.ts`); since SIM_VERSION 42 it no longer falls short of it
  either (Metropolis' units reached 14 m). Like the original's turret, it
  - searches for a target only on its targeting delay (2.0 s), and only while a
    round is waiting for one — so a turret that loses its target takes up to
    2 s to find the next;
  - picks the nearest enemy in reach with a line of sight; a **team turret holds
    its target**, re-scanning every 2.0 s, and **prefers the higher priority** —
    a Dreadnought over a tank over an X1-Alpha (neutral turrets do neither);
  - fires only when its aim lies within **±22.5° of the barrel**, which slews at
    290°/s, and with a clear line; a refused round is put back and tried again
    0-0.85 s later (the sim's PRNG).
  The test maps and the sandbox load exactly these profiles
  (`balance.ts` ORIGINAL_WEAPON_PROFILES, the imported arenas' own table) since
  SIM_VERSION 52, on the owner's call: Metropolis' instant-hit turret and unit
  table (`TURRET_*` 28 m / 15 damage, `UNIT_*`) is gone. Metropolis' own target
  dummies (the sandbox's map dummies; district-01's lane dummies went with it,
  D2) shoot avatars only, on the neutral turret's gun, with 500 HP and their 15 s
  respawn.
- **Outposts are the original's four** (SIM_VERSION 48; `fcop-fidelity.md` R14,
  `fcop-re/outposts.md`), in the original's owner-word order, imported from
  `fcop-re/outposts.json` through the arena frame (x + 16). Each has:
  - a **claim zone** (the type-14 record's 1.2 m, plus the claimer's radius) with
    the console marker at its centre — §5's press with 30 points claims it;
  - a **tank pad** and a **jet pad**, the owner's only: a press of interact on one
    buys a tank or a jet at 2 points (one per press, §3). The tank is
    queued to the outpost's tank spawner (SIM_VERSION 61); the jet comes at once
    from the outpost's jet spawner. The unit leaves that spawner's position, not
    the pad; a jet patrols that outpost;
  - two **turret plates**. Each holds a capturable neutral turret, live from the
    start (one of the arena's capture spots), and a team turret record per side,
    shut. A claim **kills both plates' neutral turrets for good** — whoever held
    them: one the other side had captured goes too, and its death pays nobody —
    and **opens the claimer's team turret** on each plate. It stands from the next
    tick (500 HP, weapon 3, a team turret's targeting) and comes back **25 s**
    after every death for the rest of the match; its death pays the other side 1
    like a base turret's. The other side's record on the plate is never used.
  The base rings are what is left of the original's type-8 records: **8 per side**
  on la-cantina, urban-jungle and venice-beach, **6** on proving-ground, bug-hunt
  and hollywood-keys (SIM_VERSION 47; the other 8 per side are the plates').
- **Capture points are the original pads.** Every original `NeutralTurret`
  becomes a capture spot — 32 on Mp and Conft, 29 on Slim and Joke, against the
  4–6 of §5. They capture by §5's rule, which is the original's own since
  SIM_VERSION 34, with each arena's imported capture range; the density is a
  balance question, tuned in `balance.ts`, never by dropping content.
- **A base's floor hurts the enemy mech** (SIM_VERSION 58; `fcop-fidelity.md`
  P11). Each base's floor carries the original's surface codes 14 / 15, imported
  per surface (`MapData.floorMasks`): it deals **1 damage per movement step —
  37.5 a second —** to the *enemy* mech standing on it (within 0.54 m of its
  feet), walker or hover, crediting no one. The own mech is safe; units and the
  Sky Captain are untouched. Mp, Conft, Slim, Joke and Ovmp have it. Hollywood-keys
  has no such floor: each spawn has a guard box (12 × 14.4 × 4 m) that deals **25**
  to the enemy mech, then waits for a latch reset polled once a second (fn45 /
  fn46, 300 engine ticks on the original's scheduler since SIM_VERSION 84, from
  a random first poll); those boxes no longer sound as intrusion alerts. Nothing
  else in a base hurts an intruder, and no pad heals the own mech there (§2).
- **Power-ups.** `ItemPickup` spots grant ammo, health, a cloak or a
  slot's power-up. **All stand from the start of the match** and re-arm on the
  original's timer: **50 s** after an ammo or health pickup is taken, **100 s**
  after a power-up or cloak, one alive per spot (the Csac spawners' tSAC,
  `fcop-fidelity.md` P9). They are drawn with the original's models, each
  arena's own. The mapping of the original's grant kinds is recorded in
  `tools/generators/enrichArena.ts`.
  **Collection** is the original's (SIM_VERSION 62, P9; `pickup.c`): a mech
  collects strictly inside a box about the pickup — **4.0 m along x, 1.6 m along
  y and 1.6 m in height** — and the pickup stands 0.16 m above the ground (it was
  a 2.5 m circle at any height). The Sky Captain collects by a flat **1.5 m**
  touch, octagonal, no height: a health pickup heals it, any other pickup is
  spent for nothing.
  The original's rules, SIM_VERSION 37:
  - **ammo** fills that slot's magazine to its ceiling — Gun, Heavy or Special
    (the Gun's has its own pickup since SIM_VERSION 41, when its magazine became
    finite; it was imported as a heavy refill);
  - **health** refills to the maximum (P6);
  - **cloak** lasts **45 s**: turrets, units and the Sky Captain skip the cloaked
    avatar (P7), and a homing missile within 4 m of it drops its lock
    (SIM_VERSION 41, the original's missile);
  - **invulnerability** lasts 20 s; no PA pickup carries it (I8);
  - a **power-up** is the original's, per slot (SIM_VERSION 43, P8): the Gun's,
    Heavy's or Special's pickup fills that slot's block-B magazine to its
    ceiling on the collector's difficulty, and the slot fires its **block B** — the record's powered weapon
    (§2) — until that magazine is empty, then block A again. Block B is, for
    example, the Mini-Gun's 2 damage with a 1 m splash (750 rounds), Hell Fire's
    three homing missiles a shot (18), the Hyper Velocity Rocket's 8-round burst,
    the Mortar's shell bursting into four 100-damage fragments at its apex, the
    Mines' 1000 in 8 m, the Shockwave's faster, thinner shell every 1.0 s, the
    Concussion Beam's 100 with a 50-point shell at each body it hits. It is lost when the
    avatar goes down. It replaced Metropolis' x2 damage for 15 s.
- **Alerts are the original's voice lines** (SIM_VERSION 36, `fcop-fidelity.md`
  R15). The original's mission scripts speak them through ops 0x0c/0x0d
  (`fcop-re/ai-and-rules.md` §6); the sim emits the events with the original's
  cooldowns and the client plays the extracted speech for the side concerned:
  - **base intrusion** (`EV_ALARM`): each base is wrapped in trigger volumes
    that fire when an enemy avatar or an enemy **ground** unit (tank or
    Dreadnought — not a jet) enters; then that base stays quiet for **8.3 s**
    (`TRIGGER_REARM_TICKS`, all its volumes together). Speech 2 / 3.
  - **base turret under fire** (`EV_TURRET_UNDER_FIRE`): a ring turret is hit;
    at most once per side per **10 s**. Speech 4 / 5.
  - **base turret lost** (`EV_TURRET_LOST`). Speech 0 / 1.
  - **gate reached** (`EV_BREACH`): speech 6 (slot 1's gate) / 19 (slot 0's).
    Nothing else plays: the breach fanfare was Metropolis' own, and the invented
    alarm and breach sounds went in the audio wave (`fcop-fidelity.md` A11) —
    only the original's voice lines and sounds are heard.
  The turret and gate alerts work on every arena; intrusion needs the imported
  trigger volumes. What the lines say is not transcribed — the meaning is the
  event that plays them — so they are played by side, not "your base".
- **Lanes** may be the original waypoint graph — see the §6 amendment.

Not adopted: the `Cfun` mission VM and the `act_type` 14/89 marker classes. The
original's `Aircraft` parameters are read since SIM_VERSION 45 (§4).
