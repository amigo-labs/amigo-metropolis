# rules.md — Game Rules

Status: v1 (initial balance values are placeholders — tune via playtesting)

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
- **Win condition: a friendly ground unit (Runner or Juggernaut) physically enters
  the enemy Base gate.** Nothing else decides the match — not a Guardian, not an
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
- **Health: 1250** (`AVATAR_HP`, SIM_VERSION 41; `fcop-fidelity.md` P1), the
  original's NORMAL mech: every PA X1Alpha record stores 1000 and the default
  NORMAL pick scales it by 125 % (HARD 1000, EASY 1500; Metropolis has no
  difficulty pick and models NORMAL). No regeneration in the original; the own
  base pad's 15 hp/s repair is Metropolis' own (it was 300 HP until v41).
  | | Walker | Hover |
  |---|---|---|
  | fore/aft | **4.69 m/s**, 95 % in 0.17 s | **9.38 m/s**, 95 % in 1.56 s |
  | strafe | 3.13 m/s | 2.93 m/s |
  | released | stops dead under 0.59 m/s (~0.1 s) | coasts, half-life 0.36 s, stops under 0.15 m/s; after ~6 s idle the drag ramps up |
  | brake | — | the jump button: drag 0.15 a step (0.05 coasting) |
  | cap | — | 10.7 m/s horizontal |
  | turn | 105°/s at rest, falling linearly to 0 at 18.75 m/s (79°/s running); none in the air | 158°/s after a ~0.26 s ramp; also in the air |
  | ride | on the ground | 0.5 m over ground or water; off a ledge it falls |
  | slope | pushed downhill above 17.5°, climbs to a 1.04 gradient | pushed downhill above 14.5° |
  A diagonal (fore/aft + strafe) pushes as hard as straight ahead, at 45°. The
  stick is read as the original's digital input — eight 45° sectors around the
  hull's facing — and its length scales the push, as the original's stick path
  does; there is no slow modifier (the original's halves the speeds and holds a
  hover at ledges), so a half-pushed stick is the slow row.
- The change (`TRANSFORM_LOCK_TICKS`, **41 ticks = 1.365 s**, the original's
  `player_transform_step`; SIM_VERSION 38, `fcop-fidelity.md` P3) is a
  **commitment**: no driving, no turning, no jumping and no lock cycling for its
  whole length, while the hull **coasts on hover physics** in both directions
  and its ride height ramps. The **weapons stay live** — all three slots fire
  through it, as the original's do (Metropolis locked them until v38). It is
  refused while a change is running and **on water in either form**. It was 15
  ticks while the change was a one-frame mesh swap and 24 while it was sized to
  the morph (`assets.md` §4); the morph now plays over the original's length.
  The original triggers it with a two-button chord; the toggle key is our
  control choice.
- **Drive and strafe relative to the facing**, as the original does: the stick's
  component along the facing drives fore/aft, its component across strafes
  (since SIM_VERSION 39; it was a throttle along the facing only, and sideways
  stick did nothing). **Turn by aiming**: the aim (or the soft-lock, or the
  stick when nothing aims) is the heading the hull TURNS to, at its form's rate
  — the original turns with buttons, Metropolis steers by an absolute heading
  (`input.spec.md` §4.1), so the rate is applied toward it.
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
  chooses them (SIM_VERSION 39): at a run, the **leap** (7.32 m/s up, +1.76 m/s
  forward on top of the run, apex 0.91 m); otherwise, with ground rising over
  0.34 m within a metre ahead, the **high jump** (8.79 m/s straight up, apex
  1.37 m, and a +2.11 m/s forward lunge at 0.24 s unless that rise is over
  1.1 m); otherwise the **hop** (6.45 m/s up and +4.69 m/s forward). No air
  control, no turning in the air, and no jumping off ground steeper than 38.7°.
  The original made the high jump for ledges with vertical faces; on a
  heightfield every step is a one-cell ramp, and the jumps climb nothing the
  walk does not (`units.ts` JUMPABLE_RISE 0, was 1.4 with an air-steered jump),
  so the walker's reach on the imported arenas is its walk: the 1.04-1.4 m steps
  the old jump cleared are walls now, the 0.6-1.04 m ones it had to jump it
  walks.
- **Water**: the hover rides it. A walker that steps into water transforms to
  hover on its own (the original's NORMAL rule; HARD's sinking and drowning are
  not modelled — Metropolis has no player difficulty and models NORMAL).
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
  0x15, Plasma Flare 0x21, Grenade Launcher 0x24 — are not offered by the menu
  and not adopted (`weapons.ts` NOT_ADOPTED_CODES).
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
  | Flamethrower | 6 dmg on the lock, 3750 rounds, 12 m (cadence ours, below) |
  | Electric Gun | 3 dmg on the lock every 2nd tick, 3750 rounds, 9.6 m |
  | Hell Fire 2000 | homing missile, 25 dmg, every 0.5 s, 181 rounds, 1.98 → 15.8 m/s, 16 m |
  | Concussion Beam | beam to the lock bursting for 50 in 1 m, every 1.0 s, 93 rounds, 8 m |
  | Hyper Velocity Rocket | 4 lead-aimed rockets on 4 ticks every 1.23 s, 30 dmg, 150 rounds, 2.5 → 19.9 m/s, 16 m |
  | Mortar Launcher | lobbed shell, 200 in a 3.2 m blast, every 2.03 s, 31 rounds, 7.6 m/s under 6 m/s² (reach 9.7 m) |
  | Pop-Up Mines | dropped charge, sprung by an enemy within 2 m + its radius, 600 in a 5.6 m blast 1 s later, every 1.0 s, 37 |
  | Shockwave Generator | self-centred pulse, 300 within 6 m, every 3.03 s, 25 |
  Ammunition is the record's NORMAL value (×1.25) and every slot has a
  magazine, the Gun's included (it was infinite). Pads and ammo pickups fill a
  slot to its ceiling.
- **The trigger** (`player_fire_slot`): Gun and Heavy fire on every tick they
  are held; each round ADDS its gap (raw × 4096/218 engine units) to the slot's
  cooldown, which loses 10 units a tick floored at zero, and a round goes out
  whenever it is back at zero. So a gap of 0 fires every tick — **30 rounds a
  second, the original's frame-bound rate pinned at 30 fps** — a gap of g every
  ⌈g / 10⌉ ticks, and a negative round gap carries over (the Hyper Velocity
  Rocket's burst). Special is held-fire too; it becomes press-to-fire, with a
  second press detonating the kept round, only with a kept-round weapon (Plasma
  Flare, Grenade), neither of which is offered.
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
  1. How the Flamethrower, the Concussion Beam and the Shockwave spread their
     damage over time was not established. They keep Metropolis' time profile
     (a flame hit every 5 ticks, an instant beam, an instant flat pulse) with the
     original's per-hit damage, radius and reach.
  2. The homing turn rate (`MISSILE_TURN_RATE`, ours: 180°/s), the Hyper
     Velocity Rocket's exact lead, the powered Hell Fire's split (three missiles
     fanned at launch, ours) and the powered Mortar's fragment spread (ours).
  3. Mines: whether an untriggered mine goes off after its 5 s lifetime; it
     keeps Metropolis' 30 s silent despawn and 0.5 s arming delay, and is
     placed at the feet rather than dropped.
  4. The powered Electric Gun's arc to two more targets is not modelled.
- **Deliveries:** Pop-Up Mines place a proximity charge at the avatar's feet.
  Shockwave Generator is a self-centred pulse — no aim, no projectile travel.
- Slot membership: the **Concussion Beam is a Heavy**, not a Special.
- Ammo refills at own Base/Outpost pads.
- Death: the avatar respawns **4 s** after going down (`RESPAWN_TICKS` 120, the
  original's `player_op4` countdown; SIM_VERSION 37, `fcop-fidelity.md` P2) at its
  team's fixed spawn, facing the spawn facing, in the spawn's form (walker, or
  hover where the record asks for it — both of hollywood-keys'). It comes back
  with full health and full ammunition and **loses its power-up**; a running
  cloak or invulnerability keeps counting down. While down it is not drawn and
  cannot be hit, because it is not there. There are no lives. Going down pays
  the **other side 10 pts and costs the downed side 10** (never below 0),
  whoever did it, settled when the avatar respawns (the original's rule, §3).
  The Warden keeps its own 8 s (`WARDEN_RESPAWN_TICKS`).
- The Base core is indestructible on every arena (pillar 1, and the original has
  no destructible core — §9). Base *turrets* are attackable by anyone.

## 3. Economy

One resource: **Points**. Both players start with `STARTING_POINTS` = **10**.
These are the original Precinct Assault's numbers (SIM_VERSION 33;
`fcop-fidelity.md` R2-R10, `fcop-re/ai-and-rules.md` §2). None of them reads
arena-specific data, so they apply on every arena, district-01 included.

**There is no income over time.** Points come only from these events, and a
death pays the **other** side whoever caused it — the original pays from the
dying actor's own script, not from a kill credit, so a unit lost to friendly
fire or the terrain still pays the enemy:

| Event                                              | Points |
|----------------------------------------------------|--------|
| An enemy Runner or Guardian dies                   | +1     |
| An enemy Juggernaut or Fortress dies               | +5     |
| An enemy base turret dies                          | +1     |
| A turret the enemy captured dies                   | +1     |
| You capture a neutral turret                       | +1     |
| The enemy avatar goes down (paid at its respawn; the Warden's when it falls) | +10 |
| Your own avatar goes down (same timing)            | −10, never below 0 |

This replaced an invented table (start 20, 1 point every 10 s, capture 3, a
turret 2 and a unit 1 to the killer, 10 to an avatar's killer).

Spending (at Base consoles / Outpost consoles):

| Purchase        | At Base | At Outpost | Limit (alive, per side) |
|-----------------|---------|------------|--------------|
| Runner (tank)   | 1       | 2          | 20           |
| Guardian (plane)| 1       | 2          | 20           |
| Claim Outpost   | 30 (drive into its claim zone) | —  | per outpost  |
| Juggernaut      | 50      | not available | 1          |
| Fortress        | 50      | not available | 1          |

The Runner and Guardian caps count base and outpost purchases together. The
Juggernaut and Fortress open the first time a side holds 50 points and stay
open for the rest of the match (the original enables their zones then).

Buying = drive Avatar onto the console pad, hold interact for 0.5 s per unit.
Claiming an outpost needs no button: entering its claim zone with 30 points
claims it (§5).
Points are visible to both players (open information, like the original).

## 4. Units

All units are unarmored-by-cleverness: no target prioritization, no retreating.

- **Runner** — ground drone. Spawns at the structure that built it, follows the
  lane network toward the enemy Base, attacks whatever blocks its path
  (turrets/units in range), otherwise beelines the gate. Fragile.
  **Reaching the enemy gate = victory.**
- **Guardian** — air drone. Built at Base: patrols a radius around own Base and
  engages enemy air/ground that enters. Built at Outpost: flies toward the enemy
  Base and attacks it and its defenders (offensive mode). Same stats, spawn
  location decides behavior — this asymmetry is a core strategic choice.
- **Juggernaut** — heavy Runner. Slow, high HP, same dumb pathing. Also wins by
  entering the gate. The classic play: save 50, escort it personally.
- **Fortress** — heavy Guardian, defensive only, large patrol radius, homing
  shots, long lifetime. The anti-rush insurance.

Initial stats (all in `balance.ts`, all placeholders):
Runner 60 HP / 8 dps / speed 4. Guardian 50 HP / 10 dps / speed 7.
Juggernaut 600 HP / 20 dps / speed 2.5. Fortress 500 HP / 25 dps / speed 6.
Avatar 1250 HP (the original's, §2); walker 4.69 m/s, hover 9.38 m/s.
On the imported arenas the units' HP and weapons are the original's spawner
records instead (§9: tank and jet 150 HP with 50-damage rounds every second,
Fortress 2000 HP with guided 100-damage rounds every 0.5 s, all at 12 m);
their speeds are still these.

## 5. Structures

- **Base**: gate (win trigger volume), 2 build consoles (ground/air),
  ammo/repair pad, ring of 4–6 **Base turrets**. Base turrets respawn
  120 s after destruction (attack timing matters — 60 s let the ring replace
  itself as fast as a superplane could strip it at authentic density; issue
  #31). Base core is indestructible: a centrepiece and anchor, never a target
  (§9: the original's "core" was its Dreadnought's spawn point).
- **Neutral turret**: dormant until captured (it shoots nobody). Captured
  **instantly** — no timer, no contest — by the original's rule (SIM_VERSION 34;
  `fcop-fidelity.md` R12, `fcop-re/ranges-turrets-capture.md` Q2):
  - an avatar **pressing the action key** (Interact, rising edge) within the
    turret's capture range plus its own radius, measured in 3D;
  - a **Runner** (tank) simply coming that close, also in 3D;
  - the **Warden** flying over it (flat distance, no button), as the original's
    Sky Captain does.
  Guardians, Juggernauts and Fortresses never capture. The range is the
  original's `(range + 1024) / 512` m on the imported arenas — 4.0 m on
  la-cantina, urban-jungle and venice-beach, 5.2 m on proving-ground and bug-hunt,
  5.6 m on hollywood-keys — and `CAPTURE_RADIUS` (5 m, ours) on district-01.
  Capturing pays +1 (§3). A captured turret fires at enemies of its owner and stays
  captured until it is destroyed; it then respawns **neutral after 25 s** (the
  original's spawner period; was 45 s). This used to be "stand in a 5 m radius for
  3 s uncontested, avatars only".
- **Outpost**: claimed by **driving into its claim zone with 30 pts** — no button,
  no hold; −30, first come first served (the original's touch zone, SIM_VERSION
  35, `fcop-fidelity.md` R14). The zone is `OUTPOST_CLAIM_RADIUS` around the
  outpost console, which stays as its visual anchor. A player's avatar trips it;
  the Warden claims only when it has decided to (the original's Sky Captain claims
  by a script decision, not by flying over). Grants: forward spawn for
  Runners/Guardians (at 2× cost) and an ammo pad.
  - On the **imported arenas a claim is permanent**, as the original's is: the
    console takes no damage and nothing targets it.
  - On district-01 (Metropolis' own outposts-as-a-menu, a deliberate deviation)
    the enemy can still destroy an owned outpost's console to revert it to
    neutral (claimable again after 10 s).
  - The original also opens the owner's two outpost-turret spawners there (25 s
    respawn) and shuts the enemy's. Metropolis' outposts have no turret slots —
    on the imported arenas they are two invented mid-field pads, while the
    original has four outposts with their own claim zones, pads and turret
    plates — so that part waits on importing the original's outposts (ledger
    R14).

## 6. Arena anatomy

- Logical playfield: 2D plane + heightfield (see architecture.md). Water areas:
  hover-only. Jump-only ledges: walker shortcuts.
- 2–3 ground lanes between the bases; lane graph is authored per map
  (waypoint polylines, no runtime pathfinding in v1). **Amended (§9):** an arena
  may instead carry the original's waypoint *graph*. That is still not runtime
  pathfinding — the routes are searched once at authoring time and committed as
  a next-hop signpost per (team, node), so a unit reads one array entry per
  waypoint and, at a fork, flips one seeded coin. It never searches.
  A unit on that graph advances at `GRAPH_WAYPOINT_RADIUS` (0.5 m), not the
  polylines' 3 m, and the difference is load-bearing rather than cosmetic: an
  original road is a metre-wide street in a wall lattice imported at 1 m
  resolution, and the only path the arena pipeline validates as walkable is the
  edge itself. A unit that advances 3 m early leaves that edge and cuts the
  corner through whatever the original built there. The pipeline validates the
  two beelines the sim generates around the graph as well — production console to
  entry node, road's far end to enemy gate — because those are equally part of
  the route a produced unit drives (issue #30).
- v1 ships **one arena** ("District 01"), sized so Hover crosses it in ~25 s.
  Use FC:MIT viewer on original maps as *reference* for proportions only.

## 7. Solo opponent ("Warden")

AI avatar analogous to Sky Captain: a superplane (flies, ignores terrain,
stronger than the player Avatar). Same rules and economy as a player — it earns
and spends points; it does not cheat resources. Difficulty 1–10 scales its
aggression thresholds and reaction delay (see PLAN Phase 4). It used to scale an
income multiplier on the trickle too; the trickle is gone (§3), and the original's
Sky Captain earns exactly like a human side — its budget is its Current Points.
Since SIM_VERSION 33 its falls cost it 10 points each, which starves the
difficulty-6+ Juggernaut save on district-01 (golden-04 pins it); the Sky Captain
port replaces this decision layer.

Its loss condition is the same on every arena — an enemy ground unit in its gate
— so it defends one radius around the gate (`WARDEN_DEFEND_RADIUS`) everywhere.
Until SIM_VERSION 32 a §9 arena tightened that radius to its core, because both
bases emitted a free Runner every 5 s and "an enemy unit near my gate" was the
steady state; the original has no such free stream, so the §1 radius is right
again. On the imported arenas the Warden also commits to a living push instead of
leaving it to capture another pad (`WARDEN_PUSH_COMMIT_RANGE`), a rung gated on
the arena carrying the original road graph — the city lattice it was measured on.
Rebuilding the Warden as the original's Sky Captain is the units/AI package's.

Committing means asking what is *stopping* the push before asking who to fly
alongside: the Warden takes the enemy emplacement nearest the push's tip and
closes to contact on it (`WARDEN_SUPPRESS_RADIUS`, `WARDEN_SUPPRESS_DISTANCE`),
escorting only while the way is clear. Contact, not standoff, and that is a
property of the arenas rather than a choice about the Warden: on the imported FCOP
arenas a defending emplacement is shootable from 8–17% of the directions around it
at 8 m and from essentially none at 20 m and beyond, because the wall lattice is
dense city geometry. There is no firing position, for anybody — a player kills
these by coming down the street they guard, and so does the Warden, inside the 12 m
the emplacement itself reaches. Flight does not change that: the Warden ignores
*terrain*, not walls, and its line of sight is the same lattice test as everyone
else's. Exempting flight from it would delete the arenas' cover model and, since
an emplacement's reach is 12 m, would make the Warden unanswerable.

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
rule below is **per-arena map data**, so an arena that carries none of it behaves
exactly as §1–§7 describe — that is what keeps the existing goldens valid.

The original's decoded model is `docs/specs/fcop-logic.md` §8; this section is
only what Metropolis adopts from it.

- **Win condition — §1's gate, the original's box.** There is **no destructible
  core** (SIM_VERSION 32). This section used to adopt a "destroy the enemy base"
  objective with a 3000 HP core; the decompiled executable says otherwise
  (`fcop-re/ranges-turrets-capture.md` top + Q4, `ai-and-rules.md` §0/§5): actor
  type 28, extracted as "TeamBase?", is the **Dreadnought**, and the 3000 HP was
  its own. The original wins when an enemy **tank or Dreadnought** — a Runner or
  Juggernaut — enters the base's gate trigger, then counts 1750 ticks (5.83 s)
  down to the results page, which is §1's rule and outro. Each base's gate is the
  imported gate trigger box (Mp 2457 × 1843 raw = 4.8 × 3.6 m; half-extent
  raw/1024 m, grown by the intruder's own radius). Jets and avatars never breach,
  so pillar 1 survives exactly as in §1.
- **No free production.** The original's tank, jet and Dreadnought spawners are
  shut in PA; units appear only when bought (§3). The "1 Runner per 5 s" this
  section used to adopt was the Dreadnought spawner's period.
- **The Juggernaut is the original Dreadnought.** It rolls out at the type-28
  record (node 0 of its Cnet, beside the HQ) rather than at the console it is
  bought from, with 3000 HP and four hull guns of weapon 3. The guns are modelled
  as four shooters at the hull's position sharing one target, each firing its own
  round: the original mounts them at the hull model's points (under 0.9 m off
  centre) with their own 237°/s slew relative to the hull, which is not modelled —
  so neither is their ±22.5° firing arc. The "four built-in base guns" the core
  used to carry were these guns. On §1 arenas the Juggernaut keeps §4's stats.
- **Every shooter fires the original's catalogue weapon** (SIM_VERSION 42;
  `fcop-fidelity.md` W3; `fcop-re/ranges-turrets-capture.md` Q3). A shooter's
  `weapon_id` indexes the mission's own type-98 catalogue, whose entries are
  identical on the six PA maps (`balance.ts` WORLD_WEAPONS):
  | Shooter | HP | Weapon | Damage | Refire | Round |
  |---|---|---|---|---|---|
  | team turret, neutral turret | 500 | 3 | 100 | 2.03 s | 7.62 m/s, lead-aimed, flies 12 m |
  | Dreadnought gun (×4) | 3000 (hull) | 3 | 100 | 2.03 s | the same |
  | tank (Runner), jet (Guardian) | 150 | 1 / 6 | 50 | 1.0 s | 7.62 m/s, lead-aimed, flies 12 m |
  | Flying Fortress | 2000 | 4 | 100 | 0.5 s | 7.62 m/s, guided, flies 24 m |
  All engage at 12 m, horizontal and centre to centre. The rounds are entities
  that fly — they used to be instant hits — and damage only what they strike
  (none has a blast); the wall lattice stops them, the heightfield does not (a
  lobbed shell is the only round that meets the ground). The rate machine is the
  original's (`cact_shooter_step`): the reload clamps the leftover clock, so a
  2.0 s entry fires every 61 ticks. The tanks', jets' and Fortress' HP and
  weapons come from their spawner records (`MapBase.runner/guardian/fortress`);
  their speeds, routing and targeting stay §4's (the units/AI package's), so a
  unit re-picks the nearest target in reach every tick.
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
    a Juggernaut over a Runner over an X1-Alpha (neutral turrets do neither);
  - fires only when its aim lies within **±22.5° of the barrel**, which slews at
    290°/s, and with a clear line; a refused round is put back and tried again
    0-0.85 s later (the sim's PRNG).
  `district-01` and the sandbox keep Metropolis' instant-hit turret and unit
  table (`TURRET_*`, `UNIT_*`): those arenas are not the original's.
- **Capture points are the original pads.** Every original `NeutralTurret`
  becomes a capture spot — 32 on Mp and Conft, 29 on Slim and Joke, against the
  4–6 of §5. They capture by §5's rule, which is the original's own since
  SIM_VERSION 34, with each arena's imported capture range; the density is a
  balance question, tuned in `balance.ts`, never by dropping content.
- **Power-ups.** `ItemPickup` spots grant ammo, health, a cloak or a
  slot's power-up, and re-arm on the original's timer: **50 s** after an
  ammo or health pickup is taken, **100 s** after a power-up or cloak, one alive
  per spot (the Csac spawners' tSAC, `fcop-fidelity.md` P9). The mapping of
  the original's grant kinds is recorded in `tools/generators/enrichArena.ts`.
  The original's rules, SIM_VERSION 37:
  - **ammo** fills that slot's magazine to its ceiling — Gun, Heavy or Special
    (the Gun's has its own pickup since SIM_VERSION 41, when its magazine became
    finite; it was imported as a heavy refill);
  - **health** refills to the maximum (P6);
  - **cloak** lasts **45 s**: turrets, units and the Warden skip the cloaked
    avatar (P7), and a homing missile within 4 m of it drops its lock
    (SIM_VERSION 41, the original's missile);
  - **invulnerability** lasts 20 s; no PA pickup carries it (I8);
  - a **power-up** is the original's, per slot (SIM_VERSION 43, P8): the Gun's,
    Heavy's or Special's pickup fills that slot's block-B magazine to its NORMAL
    ceiling, and the slot fires its **block B** — the record's powered weapon
    (§2) — until that magazine is empty, then block A again. Block B is, for
    example, the Mini-Gun's 2 damage with a 1 m splash (750 rounds), Hell Fire's
    three homing missiles a shot (18), the Hyper Velocity Rocket's 8-round burst,
    the Mortar's shell bursting into four 100-damage fragments at its apex, the
    Mines' 1000 in 8 m, the Shockwave's 8 m every 1.0 s. It is lost when the
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
  - **gate reached** (`EV_BREACH`): speech 6 (slot 1's gate) / 19 (slot 0's),
    on top of the breach fanfare.
  The turret and gate alerts work on every arena; intrusion needs the imported
  trigger volumes. What the lines say is not transcribed — the meaning is the
  event that plays them — so they are played by side, not "your base".
- **Lanes** may be the original waypoint graph — see the §6 amendment.

Not adopted: the original's `Aircraft` orbit parameters (air units keep §4's
model), the `Cfun` mission VM, and the `act_type` 14/89 marker classes.
