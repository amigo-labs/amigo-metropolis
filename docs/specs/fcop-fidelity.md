# fcop-fidelity.md — Metropolis against the decompiled original

Status: ledger, opened 2026-10-11. One row per assumption Metropolis makes about how
Future Cop: L.A.P.D.'s *Precinct Assault* (PA) works, checked against the decompiled
executable in `amigo-labs/fcop-reverse-engineering` (`origin/main` @ `7766374`, where
every byte of live game code is decompiled).

**Owner's rule (2026-10-11): the original wins.** Where the RE establishes a rule or a
number, Metropolis adopts it. Where the RE is still open, the Metropolis value stays and
the row says "waits on RE". Things the original does not have keep Metropolis' own
balance and are listed as deliberate deviations:
- `district-01` and the §1 rule arenas
- outposts as a purchase menu
- online/couch play

## Evidence

The readings behind this ledger are in [`fcop-re/`](fcop-re/). They were made by reading
the decompiled C against the retail disassembly and decoding the shipped mission bytes.
- [`ranges-turrets-capture.md`](fcop-re/ranges-turrets-capture.md): ranges, triggers,
  capture, turrets, the type-28 identification, timer units.
- [`player-and-weapons.md`](fcop-re/player-and-weapons.md) + `player-weapons.json`: the
  X1-Alpha (hover, walker, transform, respawn, health, pickups) and all 15 player weapons.
- [`ai-and-rules.md`](fcop-re/ai-and-rules.md) + `ai-and-rules.json`: economy, purchase,
  outposts, win condition, unit routing, the Sky Captain, voice cues.

Nothing here was observed in a running retail game. `tools/re/diffexec.py` (the executed
oracle) could not confirm these functions: the rebuild's actor structs use a different field
layout from retail, and the harness does not remap it. So every constant that matters was
checked by hand against the retail immediates instead. The reports say which.

**Units.** The engine clock is 300 Hz. Authored script/spawner periods are ×5 (1/60 s).
Shooter delays and weapon gaps are in 1/16 s. 8192 world units = 1 heightmap sample = 1
Metropolis cell = 1 "m"; every FCOP model is imported at that same native scale, so original
lengths and speeds apply 1:1 in cells.

## The finding that reshapes §9

**Actor type 28 is the Dreadnought, not a team base.** Two independent readings agree:
- its record class byte is 3 on every PA map, which the results screen counts as
  "Dreadnoughts";
- it drives its Cnet like a tank, and its four guns sit on its hull's model points;
- it is a 50-point purchase, one alive at a time.

Its 3000 HP is the Dreadnought's. The original has **no destructible core**. The PA win is
an enemy tank or Dreadnought entering your base's gate trigger, which is §1's rule. The
"free production every 5 s" was the Dreadnought spawner's period; that spawner is shut in
PA, and nothing is produced for free.

## Ledger

Decision column: **adopt** = take the original's value; **keep** = deliberate deviation;
**RE** = waits on the RE. The status column is updated by the commit that lands the row.

### Arena import (`tools/generators/fcopLogic.ts`, `enrichArena.ts`)

| # | Metropolis had | Original | Decision | Status |
|---|---|---|---|---|
| I1 | `RANGE_SCALE` 1024: engage_range 6144 = 6 m | `raw << 4` world units: raw/512, so **12 m** | adopt | adopted in "Import ranges, triggers, delays and slew at the original's scales", SIM_VERSION 31: `RANGE_SCALE` 512, turret/base-gun profiles 12 m |
| I2 | Aircraft detection 28–32 m | raw/512: 56–63 m | adopt | adopted in the same commit, in the converter only (`rangeToCells`, `orbitLeashToCells` raw/1024, `orbitPatrolToCells` raw/2048): air units keep §4's own patrol model, so nothing in the sim reads them yet (units package) |
| I3 | `TRIGGER_SCALE` 8192 | half-width raw/1024 m + intruder radius. A gate box is about 4.8 × 3.6 m; Mp's base zone is 40 × 24 m | adopt | adopted in the same commit, SIM_VERSION 31: `TRIGGER_SCALE` 1024 half-extent; `sim.ts insideVolume` adds the intruder's `ARCHETYPE_RADIUS` |
| I4 | targeting_delay 16 = 8 ticks (60 Hz) | units of 1/16 s: 16 = 1.0 s, 32 = 2.0 s | adopt | adopted in the same commit, SIM_VERSION 31: `targetingDelayToSimTicks`, turrets 60 ticks (2.0 s), base guns 30 |
| I5 | turn_speed 2457 = 216°/s | `((raw<<8)/218)>>4` units per 300 Hz tick: 2457 = **290°/s** | adopt | adopted in the same commit, SIM_VERSION 31. The code is `((raw*16)/218)>>4` (`turret.c:715`), i.e. 11 units/tick; `raw<<8` in the cell to the left is a typo for it |
| I6 | Type 28 = base with 3000 HP core, 4 built-in guns stacked at its centre | Type 28 = **Dreadnought** spawn point (class 3, 3000 HP, 4 hull guns at model points) | adopt | adopted in "Model type 28 as the Dreadnought and win at the gate box", SIM_VERSION 32: logic JSON `dreadnoughts`; PA Juggernaut spawns at the record with 3000 HP and 4 guns (weapon 3: 100 dmg / 60 ticks / 12 m), modelled as 4 shooters at the hull (mount offsets and 237°/s slew not modelled); core HP and the base guns removed. Speed stays ours (U2) |
| I7 | Base production: 1 Runner per 5 s, free | none; tank/jet/Dreadnought spawners are shut and only purchases spawn | adopt | adopted in "Model type 28 as the Dreadnought and win at the gate box", SIM_VERSION 32: free production removed |
| I8 | Pickup grant "invincibility" unmapped (importer throws) | Flag exists (20 s), but **no PA pickup carries it** | adopt (map it anyway) | adopted in the same commit: `invincibility` -> `PICKUP_INVULN` in `enrichArena.ts`; no map changes (no PA pickup carries it) |
| I9 | Csac/tSAC periods in 1/60 s | confirmed ×5 at 300 Hz | — | confirmed |
| I10 | Positions /8192, angles 4096 = 360° | confirmed | — | confirmed |

### Match rules (`rules.md` §1/§3/§5/§9, `sim.ts`, `balance.ts`)

| # | Metropolis had | Original | Decision | Status |
|---|---|---|---|---|
| R1 | §9 win: destroy the enemy core | Enemy **tank or Dreadnought** enters your gate trigger; 1750 ticks (5.83 s) countdown, then results. No timer | adopt (§9 returns to §1's gate rule) | adopted in "Model type 28 as the Dreadnought and win at the gate box", SIM_VERSION 32: gate = imported gate trigger box + intruder radius; Runner/Juggernaut only; `MATCH_OUTRO_TICKS` 175 on every arena (district-01 too) |
| R2 | Start 20 points | **10** | adopt | adopted in "Pay points the way the original does", SIM_VERSION 33: `STARTING_POINTS` 10 on every arena, the Warden included (the Sky Captain's 0 + free opening order is U3's) |
| R3 | Trickle 1 point / 10 s | **none** | adopt | adopted in "Pay points the way the original does", SIM_VERSION 33: trickle and the Warden's income multiplier removed on every arena |
| R4 | Kill avatar +10 | Avatar down: killer side **+10, victim −10** (floor 0) | adopt | adopted in "Pay points the way the original does", SIM_VERSION 33: the other side +10, the victim −10 floored at 0, whoever did it; a player's paid at its respawn (`player_respawn`), the Warden's when it falls (the captain's death script) |
| R5 | Kill turret +2 | **+1** (enemy base or outpost turret) | adopt | adopted in "Pay points the way the original does", SIM_VERSION 33: a base ring turret's death pays the other side 1, whoever killed it (Metropolis has no outpost turrets, R14) |
| R6 | Kill unit +1 (to the killer) | enemy tank/jet dies: **+1 to the other side whoever killed it**; Dreadnought/Fortress **+5** | adopt | adopted in "Pay points the way the original does", SIM_VERSION 33 |
| R7 | Capture turret +3 | **+1**, and +1 for destroying an enemy-held one | adopt | adopted in "Pay points the way the original does", SIM_VERSION 33: capture +1; a captured pad's death pays the side opposite its owner 1 |
| R8 | Costs 1/1/50/50, outpost 30, outpost units ×2 | identical | — | confirmed |
| R9 | Alive caps: production 8; Juggernaut 1, Fortress 1 | **20 tanks + 20 jets** per side; Dreadnought 1, Fortress 1 | adopt | adopted in "Pay points the way the original does", SIM_VERSION 33: `RUNNER_ALIVE_LIMIT`/`GUARDIAN_ALIVE_LIMIT` 20 per side, base and outpost purchases together, every arena |
| R10 | Heavy units buyable at once | Dreadnought/Fortress pads unlock the first time a side reaches 50 points | adopt | adopted in "Pay points the way the original does", SIM_VERSION 33: sticky per-side `heavyUnlocked`, set at the end of the tick a side holds 50. With the price also 50 it only refuses a purchase on the tick the points arrive |
| R11 | "No match timer — original had none" | correct (the countdown is the win outro) | — | confirmed |
| R12 | Capture: stand 3 s within 5 m, uncontested | **Instant** on an action-key press within `(range+1024)/512` m + own radius (4.0–5.6 m by map). Tanks capture by proximity, jets and Dreadnoughts cannot. Captured is permanent until destroyed; respawns neutral after 25 s | adopt | adopted in "Capture neutral turrets instantly on the action key", SIM_VERSION 34: Interact's rising edge, 3D, within `MapData.captureRange` (imported per arena: 4.0 / 5.2 / 5.6 m; district-01 keeps 5 m) + `ARCHETYPE_RADIUS`; Runners by 3D proximity, the Warden by flat proximity (the captain's type 0x25); no contest; `NEUTRAL_TURRET_RESPAWN_TICKS` 750. Euclidean distance, not the original's octagonal estimate; the broad-phase 4 m cell clipping (Hk) is not modelled |
| R13 | Neutral turrets fire? | Uncaptured turrets **never fire** | adopt | confirmed: already true (sim.ts `systemTargeting` skips unowned capturables) |
| R14 | Outpost claim at a console, 30 points | Drive into the claim zone with ≥ 30 points; permanent; opens own unit pads and turret spawners | adopt (console kept as the zone's visual) | partly adopted in "Claim outposts by entering the zone, permanently on the imported arenas", SIM_VERSION 35: entering `OUTPOST_CLAIM_RADIUS` (3 m, ours: the zone size is not in the record) with ≥ 30 claims, no button, on every arena; the Warden claims only by decision (the captain's script write); permanent on the imported arenas (console invulnerable and untargeted), district-01 keeps console-destruction revert. **Open:** the outpost turret spawners — Metropolis' outposts are 2 invented mid-field pads with no turret slots, the original has 4 outposts (type-14 claim zone at the centre, pads, two turret plates each carrying a per-side type-8 turret with 25 s respawn and a NeutralTurret on the same plate; Mp e.g. (116.5, 96.1)). Needs an import of the original outposts; the plate's neutral-vs-owned "turret swap" (fn22-25) is not fully read |
| R15 | Intrusion alert: authored sfx | Voice id 2 (own base) / 3 (enemy base), 8.3 s cooldown. Turret under fire 4/5, turret lost 0/1, gate reached 19/6 | adopt | adopted in "Speak the original's alert lines", SIM_VERSION 36: EV_ALARM per base with a 250-tick cooldown and ground units only; new EV_TURRET_UNDER_FIRE (ring turret hit, 300 ticks per side) and EV_TURRET_LOST; EV_BREACH adds the gate line. The client plays `extracted/voice/wav` v001-v007 and v020 (8-bit, 38-54 KB each) by side, with sfxr stand-ins until a file loads. Played by side, not by the local player's point of view (no transcripts) |

### The X1-Alpha (`balance.ts`, `sim.ts`)

| # | Metropolis had | Original | Decision | Status |
|---|---|---|---|---|
| P1 | HP 300 | **1250** (NORMAL; HARD 1000, EASY 1500), no regen | adopt 1250 | open: deferred to the weapons package, because every damage number is absolute HP against it (W1/W3). The X1-Alpha package leaves `AVATAR_HP` 300 |
| P2 | Respawn 8 s | **4 s** (0.5 s after drowning), full HP, full normal ammo, power-ups lost, at the team spawn in spawn form; no lives | adopt | adopted in "Bring the X1-Alpha back the way the original does", SIM_VERSION 37: `RESPAWN_TICKS` 120; the power-up is cleared at the down, cloak/invulnerability keep counting; `MapSpawn.hover` (both Hk records, carried in `fcopArenas.ts`) spawns and respawns in hover. The 0.5 s drowning path has no counterpart: drowning is HARD's, and Metropolis models NORMAL (P4). The Warden keeps 8 s (`WARDEN_RESPAWN_TICKS`, U3's) |
| P3 | Transform 0.8 s, no weapons | **1.365 s (41 ticks)**: movement locked, weapons fire, coasts on hover physics, refused on water | adopt | open |
| P4 | Walker 5 m/s, jump 8 against gravity 20 | **4.69 m/s**, strafe 3.13, turn 105°·(1 − v/18.75), jump 8.8 against 26.1 (apex 1.37 m), steep at normal 0.625 | adopt | open |
| P5 | Hover 9 m/s, traction knobs | **9.38 m/s** (strafe 2.93, slow ×½), drag 1.92/s, brake 6.1/s, cap 10.7, turn 158°/s, ride height 0.5 m | adopt | open |
| P6 | Pickup health +100 | **full heal** | adopt | adopted in "Bring the X1-Alpha back the way the original does", SIM_VERSION 37 |
| P7 | Invisible 10 s | **cloak 45 s**: AI and turrets skip the mech | adopt | adopted in "Bring the X1-Alpha back the way the original does", SIM_VERSION 37: `PICKUP_INVIS_TICKS` 1350; turrets and units already skipped it, the Warden's hunt now does too (and skips an invulnerable one, as the commander does). Invulnerability 600 ticks (20 s), unused in PA. Not modelled: the homing-missile disarm within 4 m, because Metropolis has no homing rounds yet (W1) |
| P8 | Power-up ×2 damage 15 s | per-slot **block B weapon** with its own magazine | adopt | open: deferred to the weapons package with the B blocks (W1). Since SIM_VERSION 37 the x2 stand-in is lost at a down, as block B is |
| P9 | Pickup re-arm from tSAC | 50 s (ammo, health), 100 s (power, cloak) | confirmed (data) | confirmed: all six arenas import 1500 / 3000 ticks, re-armed per spot after collection (paRules pins it). The first appearance stays at match start (the original's 50/100 s is an L reading) |

### Weapons (`balance.ts`, `weapons.ts`)

| # | Metropolis had | Original | Decision | Status |
|---|---|---|---|---|
| W1 | Damage and rate scaled from the 55 px bars; ranges, ammo and speeds invented | Full A/B records for all 15 weapons in the mission data (`player-weapons.json`) | adopt | open |
| W2 | Soft lock 44 m, hitscan hits anything on the line | Lock **12 m**, acquire ±12.5°, hold ±25°. Hitscan damages **only the locked target** | adopt | open |
| W3 | Turret damage 15 (global) | Every turret, neutral turret and Dreadnought gun uses weapon 3: **100 dmg every 2.0 s**, 12 m, 7.62 m/s lead-aimed round, no splash; fires within ±22.5° of the barrel | adopt | open |
| W4 | "Reach mismatch" note (`balance.ts`) | Dissolves: player hitscan 12 m = turret 12 m | adopt | open |

### Units and AI (`units.ts`, `warden.ts`)

| # | Metropolis had | Original | Decision | Status |
|---|---|---|---|---|
| U1 | Fork: seeded 50/50, no doubling back | Seek the nearest enemy-team actor within 16 m. Otherwise score neighbours by log2 of the dot product, halve per unit already heading there, 40 % random step, never straight back | adopt | open |
| U2 | Unit speed 4 m/s (Runner) | tank ≈ 1.98 m/s | adopt | open |
| U3 | Warden: invented, 450 HP | Sky Captain: HP 250…1250 by level 0–9, speed 2.7–4.5 m/s. Weapons 7/8/9. Rethink (848 − 80L) ticks, respawn (14 − L)·150 ticks. Three decision modes. Its budget is its own Current Points, plus a free opening order of 10 units | adopt | open |

### Still open in the RE (Metropolis keeps its value)

- Projectile speed scale of Sky Captain weapons 8/9; the aircraft turn rate in °/s.
- The kill-side per-class statistics (`csac_score_kill` is a stub); the player-block words
  that make the captain ignore a player.
- How the flamethrower, beam, shockwave and riot shield spread damage over time; whether an
  untriggered mine detonates after its 5 s lifetime.
- How retail's six-slot weapon table serves the other nine weapons.
- Jet behaviour beyond routing (air units keep §4's patrol/assault model).
- Voice line content (no transcripts; meanings are inferred from the scripts that play them).
