# rules.md — Game Rules

Status: v1 (initial balance values are placeholders — tune via playtesting)

Design pillars, in priority order:

1. **The player is escort and disruptor, never the win condition.** You cannot win
   by attacking the enemy base yourself. Only your units can breach.
2. **Presence is currency.** Building happens at physical consoles; capturing
   requires standing there. Every decision costs map control.
3. **Units are dumb on purpose.** They follow lanes blindly and die easily.
   Their stupidity creates the escort gameplay.
4. **Readable in 5 minutes, deep over 50 matches.**

## 1. Match structure

- 1v1. Each side: one **Base**, one **Avatar** (player- or AI-controlled).
- Arena contains neutral **Turrets** and neutral **Outposts**.
- **Win condition: a friendly ground unit (Runner or Juggernaut) physically enters
  the enemy Base gate.** Nothing else ends the match.
- No match timer in v1 (original had none; revisit if stalemates emerge).

## 2. The Avatar

- Transforming vehicle with two modes (toggle, ~0.5 s transform lock):
  - **Walker**: slower, can jump, precise handling, better on slopes.
  - **Hover**: fast, drifty (low traction), can cross water, cannot jump,
    steep slopes impassable.
- **Drive only in facing direction** (no holonomic strafe): throttle is the
  stick component along aim/lock heading; reverse is allowed. Turn by aiming.
- The slope asymmetry is **deliberate**: `AVATAR_HOVER_MAX_SLOPE` (0.5) is
  stricter than `AVATAR_WALKER_MAX_SLOPE` (0.6), because hover rides clearance
  and trades terrain for speed and water. Each form has ground the other cannot
  take, and neither is meant to go everywhere.
- What each form measures a climb **over** is part of the asymmetry, not an
  implementation detail (issue #34). The walker judges the step it is taking. The
  hover judges the step AND the ground `HOVER_CUSHION_SPAN` (2.4 m, its own
  footprint) further on, and is stopped only when both are too steep — a cushion
  rides over a step its hull spans and is beaten by ground that keeps climbing.
  Judged per tick instead, the two are one reading: on a bilinear heightfield a
  0.17 m kerb is a 0.58-gradient wall while you are on it, which is how the hover
  used to be locked out of 10-13% of every FCOP arena's road network, la-cantina
  included. The step it clears this way tops out at span × limit = **1.2 m**,
  under the walker's 1.4 m jump, so the walker still owns more ground on both
  axes — and the hover owns some the walker cannot jump at all, 2 lane edges each
  on proving-ground and bug-hunt.
- Neither of those makes the originals' terrain uniformly drivable, and it should
  not: their roads also carry 1.3-3 m steps. Those stay walls for the hover, which
  has no jump — transform or route around. `fcop-arenas.test.ts` pins per arena
  what each form cannot pass, and how many teams can drive their whole road
  network in hover (7 of 8, and la-cantina is clean in both forms).
- The **jump** is the walker's answer to a step it cannot climb: the slope gate
  is skipped while airborne, so an 8 m/s launch against 20 m/s² gravity clears a
  ledge up to ~1.4 m. On the imported FCOP arenas that covers 70-100% of the
  original terrain's blocking steps; the rest are 1.4-2.5 m walls to route
  around, and a walk-only path to the enemy base exists on every arena.
  `fcop-arenas.test.ts` pins both counts per arena.
- Same three weapon slots in both modes: primary (hitscan-ish rapid),
  heavy (projectile, AoE), special (slow, high damage).
- **The weapon catalog carries the original's numbers** (SIM_VERSION 21).
  Future Cop has 15 weapons, five per slot, with the slot in the high nibble of
  the weapon id (`0x0x` Gun, `0x1x` Heavy, `0x2x` Special). Damage and firing
  rate are published in the game's own front-end: one 134x40 panel per weapon in
  `febmp.bin`, a green rate bar and a red damage bar in a 55 px trough, bar
  length = value. There is no finer numeric table in the executable or the data.
  Seven of Metropolis' nine weapons exist there and take those values:
  Powered Mini-Gun, Gatling Laser, Flamethrower, Hell Fire 2000, Concussion Beam,
  Mortar Launcher, Plasma Flare — display names included.
- The bars are **ratios**, so they are anchored **per slot**: each slot's index-0
  weapon keeps this game's existing numbers and the rest scale against it inside
  that slot. Anchoring across slots was tried and does not work — it puts Hell
  Fire's cooldown at 7 ticks against 24. Within a slot the ratios land on what
  this game already had, so almost all the movement is in the gun slot. Arithmetic
  and per-weapon values: the "Non-default catalog weapons" block in `balance.ts`.
- **Two declared deviations, neither hidden:**
  1. The bars do **not** distinguish Mini-Gun from Gatling Laser — both read
     55/55 rate and 3/55 damage. Adopted literally that ships two identical
     picks out of five, which is worse play, so the two keep their range
     difference (40 vs 44) as ours. In the original the Laser is a continuous
     beam, and that is on neither bar.
  2. Ranges, projectile speeds, TTLs, AoE radii and magazine sizes are **ours
     throughout** — the panels carry rate and damage only.
- Two of the nine are Metropolis' own and are marked as such in the catalog:
  Cluster Bomb and Rail Cannon. The eight original weapons Metropolis does not
  have (Electric Gun, Riot Shield, Hyper Velocity Rocket, Fusion Torpedo, K-9
  Drone, Pop-Up Mines, Shockwave Generator, Grenade Launcher) are tracked as
  issues, not approximated: a deployable shield, a drone and mines are new
  mechanics, not table rows.
- Slot membership follows the original too: the **Concussion Beam is a Heavy**
  (`Beam Cannon`, `0x12`), not a Special, so Heavy has four entries and Special
  two. Its id-to-name pairing was made by elimination, so which heavy id it is
  is not certain — that it is a heavy does not rest on the elimination, since
  both leftover ids were heavies.
- Ammo: primary infinite; heavy/special finite, refilled at own Base/Outpost pads.
- Death: respawn at own Base after `RESPAWN_TICKS` (placeholder: 8 s).
  Killer's owner earns **10 pts**.
- The Avatar deals no damage to the enemy Base core (pillar 1). Base *turrets*
  are attackable by anyone.

## 3. Economy

One resource: **Points**. Both players start with `STARTING_POINTS`
(placeholder: 20 — an opening wave, not a Juggernaut). Earned by:

| Event                          | Points |
|--------------------------------|--------|
| Capture neutral turret         | 3      |
| Destroy enemy-owned turret     | 2      |
| Destroy enemy unit (any)       | 1      |
| Destroy enemy Base turret      | 2      |
| Kill enemy Avatar              | 10     |
| Trickle income                 | 1 per 10 s |

Spending (at Base consoles / Outpost consoles):

| Purchase        | At Base | At Outpost | Limit        |
|-----------------|---------|------------|--------------|
| Runner (tank)   | 1       | 2          | none         |
| Guardian (plane)| 1       | 2          | none         |
| Claim Outpost   | 30 (at the outpost itself) | —  | per outpost  |
| Juggernaut      | 50      | not available | 1 alive at a time |
| Fortress        | 50      | not available | 1 alive at a time |

Buying = drive Avatar onto the console pad, hold interact for 0.5 s per unit.
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
Avatar 300 HP; walker speed 5, hover speed 9.

## 5. Structures

- **Base**: gate (win trigger volume), 2 build consoles (ground/air),
  ammo/repair pad, ring of 4–6 **Base turrets**. Base turrets respawn
  60 s after destruction (attack timing matters). Base core is indestructible.
- **Neutral turret**: capture by Avatar standing in radius for 3 s uncontested.
  Fires at enemies of its owner. Can be destroyed (reverts to neutral husk,
  respawns neutral after 45 s).
- **Outpost**: claimable for 30 pts at its console. Grants: forward spawn for
  Runners/Guardians (at 2× cost), ammo pad, 2 own turret slots. Enemy can
  destroy an owned outpost's console to revert it to neutral (claimable again).

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
income multiplier, aggression thresholds, and reaction delay (see PLAN Phase 4).

Its goal ladder reads the arena's rule set where the two differ, because two of
its rungs are about the loss condition and §9 changes what that is. Under §1 an
enemy ground unit near the Warden's own gate *is* the loss condition, so it
outranks every other goal, and a unit of its own that reaches the enemy gate has
already won, so there is nothing to escort. Under §9 neither holds: both bases
emit a free Runner every 5 s, which makes "an enemy unit near my gate" the steady
state rather than an emergency, and arriving at the enemy core is where the work
starts rather than where it ends. So on an arena carrying a core the Warden
defends a tight radius around it and leaves the approaches to its 20 emplacements,
and it commits to a push that has arrived instead of leaving it there to capture
another pad (`WARDEN_CORE_DEFEND_RADIUS`, `WARDEN_PUSH_COMMIT_RANGE`). Both are
gated on map data like every other §9 mechanic, so a §1 arena behaves as before.

Committing means asking what is *stopping* the push before asking who to fly
alongside: the Warden takes the enemy emplacement nearest the push's tip and
closes to contact on it (`WARDEN_SUPPRESS_RADIUS`, `WARDEN_SUPPRESS_DISTANCE`),
escorting only while the way is clear. Contact, not standoff, and that is a
property of the arenas rather than a choice about the Warden: on the imported FCOP
arenas a defending emplacement is shootable from 8–17% of the directions around it
at 8 m and from essentially none at 20 m and beyond, because the wall lattice is
dense city geometry. There is no firing position, for anybody — a player kills
these by coming down the street they guard, and so does the Warden, inside the 6 m
the emplacement itself reaches. Flight does not change that: the Warden ignores
*terrain*, not walls, and its line of sight is the same lattice test as everyone
else's. Exempting flight from it would delete the arenas' cover model and, since
an emplacement's reach is 6 m, would make the Warden unanswerable.

## 8. Out of scope for v1

More arenas, 2v2, ranked/matchmaking, mobile touch controls, cosmetics,
replays-as-feature (replays exist as a test artifact from day one).

## 9. Precinct Assault mode (FCOP arenas)

Status: adopted for four FCOP arenas — `la-cantina` (mission Mp), `urban-jungle`
(Conft), `proving-ground` (Slim) and `bug-hunt` (Joke). `la-cantina` is
**multi-deck** since issue #29: it carries the two bridge decks its source terrain
describes, and its walls are attributed to the deck they stand on rather than
flattened into one lattice.

`hollywood-keys` and `venice-beach` stay on §1–§7. That is not for want of data —
their logic is extracted and committed. It is also NOT because their decks are
unreachable: that argument was retired as circular, because the extractor only
separates surfaces more than 0.5 m apart and keeps ramps inside the ground rank, so
"every deck is above the step height" is a restatement of its clustering constant.
Decks are entered sideways at their edges, and both arenas have thousands of such
entry cells. What is genuinely missing is per-FEATURE layer information: Hk puts 8
`Turret`, 3 `NeutralTurret` and 2 `TeamBase?` on cells with a deck overhead and
nothing in `MapJson` can say which storey they belong to. See
`packages/sim/test/layeredArenas.test.ts` for the measurements and issue #33.

A deliberate deviation from §1–§6, taken on the owner's call: where the original
*Precinct Assault* mission data says how the arena works, the data wins. Every
rule below is **per-arena map data**, so an arena that carries none of it behaves
exactly as §1–§7 describe — that is what keeps the existing goldens valid.

The original's decoded model is `docs/specs/fcop-logic.md` §8; this section is
only what Metropolis adopts from it.

- **Win condition — destroy the enemy base.** A base carries `coreHp` (the
  original stores 3000). Only *units* damage it; the Avatar and the Warden never
  can, so pillar 1 survives — you still cannot win by attacking the base
  yourself. On an arena with `coreHp > 0` this **replaces** the gate breach of
  §1; gate-breach remains the only win condition where `coreHp` is 0.
- **Base production.** Each base produces one Runner onto its own lane every
  `productionTicks` (the original: 5 s), free, up to `productionLimit` alive.
  This is **additive** to the §3 points economy: consoles, costs and the Warden's
  spending are unchanged. The alive limit is ours, not the original's — the
  original stores a per-cycle spawn count, and two bases at 12 units/min would
  otherwise fill the entity store.
- **Turrets carry their own parameters.** Range, fire cadence, gun slew, field of
  view, rest rotation and health come from the arena's imported data instead of the
  global constants — for **all three** kinds: capturable pads, base ring turrets
  and the built-in base guns. Health too, with one exception: `BaseShooter` carries
  no health field, so the built-in guns take the 500 every original `Turret` actor
  has rather than the base structure's own 3000. That number is ours, like their
  position — they sit on the core because the original stores no coordinates for
  them — and four 3000 HP guns standing on the objective gated it at a unit's own
  reach (issue #31). The original's reach is short: `engage_range` 6144 is
  6 m, against the pre-PA global 28 m, and turrets are placed within a few metres
  of the road they guard. That short reach is load-bearing, not decoration — it is
  what keeps a turret inside the 14 m a Runner can shoot back from, so a push can
  answer a turret instead of dying to one it cannot reach (`paAttribution.test.ts`
  asserts the relation for every profile an arena carries).
  Damage stays on the global value. This used to say "the original's weapon
  table was not decoded"; it is decoded now — 15 records in the game executable
  plus the front-end panels in `febmp.bin`, with firing rate and damage read off
  the game's own bars. It still does not apply here: those ids are a **different
  id space** from the `weapon_id` on `BaseShooter` actors, so the figures are the
  player's loadout and say nothing about a turret. The avatar's weapons DID adopt
  them (§2, SIM_VERSION 21); binding the actor `weapon_id` space to the executable's
  is still open, and until it is, turret damage stays ours.
- **Capture points are the original pads.** Every original `NeutralTurret`
  becomes a capture spot — 32 on Mp and Conft, 29 on Slim and Joke, against the
  4–6 of §5. Capture rules
  themselves are unchanged; the density is a balance question, tuned in
  `balance.ts`, never by dropping content.
- **Power-ups.** `ItemPickup` spots grant ammo, health, invisibility or a
  temporary damage boost, and re-arm on the original's timer. The original's
  eight grant kinds do not map one-to-one — Metropolis' primary weapon has
  infinite ammo (§2) — so the mapping is recorded in
  `tools/generators/enrichArena.ts`.
- **Base intrusion alert.** Each base is wrapped in trigger volumes that fire
  when an enemy Avatar or unit enters. Detection only: the original's alert sound
  lived in the undecoded `Cfun` script, so the cue is ours to author.
- **Lanes** may be the original waypoint graph — see the §6 amendment.

Not adopted: the original's `Aircraft` orbit parameters (air units keep §4's
model), the `Cfun` mission VM, and the `act_type` 14/89 marker classes.
