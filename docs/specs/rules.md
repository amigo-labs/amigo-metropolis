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
- Same three weapon slots in both modes: primary (hitscan-ish rapid),
  heavy (projectile, AoE), special (slow, high damage).
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
  (waypoint polylines, no runtime pathfinding in v1).
- v1 ships **one arena** ("District 01"), sized so Hover crosses it in ~25 s.
  Use FC:MIT viewer on original maps as *reference* for proportions only.

## 7. Solo opponent ("Warden")

AI avatar analogous to Sky Captain: a superplane (flies, ignores terrain,
stronger than the player Avatar). Same rules and economy as a player — it earns
and spends points; it does not cheat resources. Difficulty 1–10 scales its
income multiplier, aggression thresholds, and reaction delay (see PLAN Phase 4).

## 8. Out of scope for v1

More arenas, 2v2, ranked/matchmaking, mobile touch controls, cosmetics,
replays-as-feature (replays exist as a test artifact from day one).
