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

- Transforming vehicle with two modes (toggle, ~0.8 s transform lock):
  - **Walker**: slower, can jump, precise handling, better on slopes.
  - **Hover**: fast, drifty (low traction), can cross water, cannot jump,
    steep slopes impassable.
- The lock (`TRANSFORM_LOCK_TICKS`, 24) is a **commitment**, not a formality: no
  moving, no jumping, no weapons for its whole length. It was 15 while the change
  was an invisible one-frame mesh swap; it grew when the change grew an animation
  to play (`assets.md` §4), and the extra 0.3 s of being a stationary target is
  the deliberate price of that. Deciding to change form is a real decision.
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
- **The weapon catalog is the original Precinct Assault set only** (SIM_VERSION
  26): **ten weapons**, four Guns / three Heavies / three Specials. Default kit
  matches the original weapons screen: Powered Mini-Gun · Hell Fire 2000 ·
  Mortar Launcher.
  | Slot | Weapons |
  |------|---------|
  | Gun | Powered Mini-Gun, Gatling Laser, Flamethrower, Electric Gun |
  | Heavy | Hell Fire 2000, Concussion Beam, Hyper Velocity Rocket |
  | Special | Mortar Launcher, Pop-Up Mines, Shockwave Generator |
- Damage and firing rate come from the original front-end panels (`febmp.bin` →
  134x40, green rate + red damage bars in a 55 px trough). Extracted panels and
  icons ship under `packages/client/public/ui/weapons/`. There is no finer
  numeric table in the executable. Arithmetic: the "Non-default catalog weapons"
  block in `balance.ts`.
- The bars are **ratios**, so they are anchored **per slot**: each slot's
  index-0 weapon keeps this game's numbers and the rest scale against it inside
  that slot. Anchoring across slots does not work — it puts Hell Fire's cooldown
  at 7 ticks against 24.
- **Declared deviations, none hidden:**
  1. The bars do **not** distinguish Mini-Gun from Gatling Laser — both read
     55/55 rate and 3/55 damage. The two keep their range difference (40 vs 44)
     as ours.
  2. Ranges, projectile speeds, TTLs, AoE radii, magazine sizes, mine arming
     and shockwave pulse radius are **ours throughout** — the panels carry
     rate and damage only.
- **Deliveries:** Pop-Up Mines place a proximity charge at the avatar's feet
  (arm delay, then trip on enemy contact). Shockwave Generator is a self-centred
  pulse — no aim, no projectile travel.
- Slot membership: the **Concussion Beam is a Heavy**, not a Special.
- Ammo: primary infinite; heavy/special finite, refilled at own Base/Outpost pads.
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
Avatar 300 HP; walker speed 5, hover speed 9.

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
  bought from, with 3000 HP and four hull guns of weapon 3 (100 damage every
  2.0 s, 12 m). The guns are modelled as four shooters at the hull's position
  sharing one target: the original mounts them at the hull model's points (under
  0.9 m off centre) with their own 237°/s slew, which at a 12 m reach changes
  nothing a player can see. The "four built-in base guns" the core used to carry
  were these guns. On §1 arenas the Juggernaut keeps §4's stats.
- **Turrets carry their own parameters.** Range, fire cadence, gun slew, field of
  view, rest rotation and health come from the arena's imported data instead of the
  global constants — for both kinds: capturable pads and base ring turrets.
  (A third kind, "built-in base guns" on the core, existed until SIM_VERSION 32;
  they were the Dreadnought's hull guns and now ride on the Juggernaut.) The
  original's reach is short: `engage_range` 6144 is
  12 m (`raw << 4` world units — fcop-re/ranges-turrets-capture.md Q1; it read
  6 m under an inferred scale until SIM_VERSION 31), against the pre-PA global
  28 m, and turrets are placed within a few metres
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
  them (§2, SIM_VERSION 21). The actor `weapon_id` has since been bound too: it
  indexes each mission's own type-98 catalogue, and every turret carries weapon 3
  (100 damage every 2.0 s — `fcop-re/ranges-turrets-capture.md` Q3). The
  Juggernaut's hull guns use it; turret damage moves to it with the weapons
  package (`fcop-fidelity.md` W3) and stays ours until then.
- **Capture points are the original pads.** Every original `NeutralTurret`
  becomes a capture spot — 32 on Mp and Conft, 29 on Slim and Joke, against the
  4–6 of §5. They capture by §5's rule, which is the original's own since
  SIM_VERSION 34, with each arena's imported capture range; the density is a
  balance question, tuned in `balance.ts`, never by dropping content.
- **Power-ups.** `ItemPickup` spots grant ammo, health, a cloak or a
  temporary damage boost, and re-arm on the original's timer: **50 s** after an
  ammo or health pickup is taken, **100 s** after a power-up or cloak, one alive
  per spot (the Csac spawners' tSAC, `fcop-fidelity.md` P9). The original's
  eight grant kinds do not map one-to-one — Metropolis' primary weapon has
  infinite ammo (§2) — so the mapping is recorded in
  `tools/generators/enrichArena.ts`. The original's rules, SIM_VERSION 37:
  - **health** refills to the maximum (P6);
  - **cloak** lasts **45 s**: turrets, units and the Warden skip the cloaked
    avatar (P7). The original also disarms a homing missile that comes within
    4 m of it; Metropolis has no homing rounds yet (the weapons package);
  - **invulnerability** lasts 20 s; no PA pickup carries it (I8);
  - the **damage boost** (x2, 15 s) is still Metropolis' stand-in for the
    original's per-slot block-B weapon (P8, the weapons package). It is lost
    when the avatar goes down.
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
