# Precinct Assault AI and rules, extracted from FC:LAPD (RE repo @ 7766374)

> **Correction (2026-10-12, [`outposts.md`](outposts.md)).** Three statements below are wrong:
> - §1.5/§9, "8 base + 2 per outpost" and "defending is the early game's normal state": every type-8 turret counts **twice** (its base part is a second type-8 actor from the same record). The captain therefore starts at 16 (Mp/Conft/Ovmp) or 12 (Slim/Joke/Hk), at or above the threshold of 10, and roams from the start. The equivalent rule is "defend while fewer than 5 own team turrets are alive".
> - §2, "a claim shuts the enemy's spawners": a claim kills the plate's neutral turret and shuts **its** spawner, then opens the claimer's own type-8 spawner. The enemy's plate spawner was never open.
> - "Drive into the zone": claiming needs an action-key press while touching the type-14 zone (gate bit 0x04).


Units used throughout: 300 Hz engine clock (1 tick = 1/300 s); 8192 world units (wu) = 1 m (= 1 map cell);
angles 4096 = 360 deg; script/Csac authored units x5 = ticks. Distances in the Sky Captain AI are the
engine's **octagonal** estimate `|dx|+|dz|-min(|dx|,|dz|)/2` on x/z only (dispatch.c `sky_flat_distance`).

Confidence tags: **[A]** read from decompiled C *and* checked against bytes/data in this session;
**[B]** read from decompiled C or decoded script data, logic consistent but not hand-verified at every VA;
**[C]** inference from context (names, positions, which trigger fires it).

Throwaway tooling in this scratchpad: `cdec.py` (symbolic Cfun decompiler), `rpns.py` (actor script pool
dump), `shdr2.py` (resource-header scripts), `csac.py`, `rec.py`, `wep.py`, `wintrig.py`. Outputs:
`<Map>.dec.txt` (mission Cfun), `<Map>.rpns.txt` (per-actor scripts), `<Map>.shdr2.txt`.

---------------------------------------------------------------------------------------------------
## 0. The headline corrections for Metropolis

1. **There is no "TeamBase" core and no free production.** Actor type 28 (Metropolis' "TeamBase?",
   3000 HP, 4 guns, tSAC 300 units, limit 1) is the **Dreadnought**, a purchasable ground unit:
   Csac class byte 3, spawner shut (flags bit0 = 1) so it never spawns on a timer, bought for 50
   points through a script (`act47` / `act53`), alive limit 1. Mission frame code confirms type 28
   has 4 gun sub-actors (`mission_frame.c` `MISSION_TYPE_28_PARTS 4`). [A]
2. **Win = an enemy ground unit (tank or Dreadnought) enters your base's gate trigger.** There is
   no core HP and no timer. [A]
3. **No point trickle.** Points come only from kills/captures. Starting points are **10**. [A]
4. **The Sky Captain plays the human economy exactly**: its budget is state word 26 = slot 1's
   "Current Points", its purchases are the same items at the same prices. [A]
5. Units are bought **by driving into pads**, not from a menu. [A]

---------------------------------------------------------------------------------------------------
## 1. Sky Captain (actor type 37)

Files: `src/game/actor/dispatch.c` (whole module: handler 0x00421090, construct 0x004211f0, tick
0x004215b0, decision pass 0x00421910, respawn 0x00422bc0, restore 0x00420f60, pickup search 0x00422b20),
`src/game/actor/aircraft.c` (flight 0x00420700). A type 37 is a type-9 Aircraft (0x134 bytes) plus a
0xb4-byte AI block at +0x134; the tick ends in `aircraft_step` (0x004216d2). [A]

### 1.1 Record (identical in all 22 shipped instances; per-level-band Cact variants differ only in model)
HP 1000, speed raw 1843, turn rate 4096, alt min/cruise/max 614/655/716 (<<4 wu above the coarse
ground envelope = 1.20/1.28/1.40 m), standoff 512 (<<4 = 1 m), team byte 2, target group byte 1
(= human slot 0's team), weapons 7 / 8 / 9 in three shooter blocks, all three shooters
engage_range 6144 (<<4 = 12 m), targeting_delay 16 (=300 ticks = 1.0 s), target_type 4 (by team),
targeting 1. Measured with `rec.py Mp 287`. [A]

Which variant loads is script-gated on level: Mp `Cact287` W19<3, `295` 3..5, `296` 6..8, `297` W19>8;
Joke has two (W19<9, ==9). Each variant's header script also sets W17=1, W16=0, W27..34=0 (`Mp.shdr2.txt`). [A]

### 1.2 Level (state word 19)
* Source: frontend "SKY CAPTAIN / LEVEL" sub-pick written by `frontend_launch_selection` 0x0040b6a5
  (PA + one viewport only). [A] Construct clamps it to 0..9 **in the state block** (0x0042120b..1f). [A]
* Progression: results page 0x004080a0 increments word 19 (`inc` at 0x00408121) when one viewport
  and slot 0 did **not** lose; footer offers "play the next level". HUD shows `L%02d` = word19+1. [A]
* Script fn55 announces level at start: voice id `74 + W19 - 1` (W19>0). [A]

### 1.3 Stats per level  (full table in ai-and-rules.json)
| L | max HP | flat speed m/s | rethink s (mode0/1; mode2) | respawn s | MG arc | missile arc |
|---|---|---|---|---|---|---|
| 0 | 250 | 2.72 | 2.83-3.68 ; 2.72-2.83 | 7.0 | front +-22.5 | front |
| 1 | 250 | 3.01 | 2.56-3.41 | 6.5 | front+side | front |
| 2 | 500 | 3.31 | 2.29-3.14 | 6.0 | front+side | front |
| 3 | 500 | 3.60 | 2.03-2.88 | 5.5 | front+side | front+side |
| 4 | 750 | 3.75 | 1.76-2.61 | 5.0 | " | " |
| 5 | 750 | 3.90 | 1.49-2.34 | 4.5 | " | " |
| 6 | 1000 | 4.05 | 1.23-2.08 | 4.0 | " | " |
| 7 | 1000 | 4.20 | 0.96-1.81 | 3.5 | " | all round |
| 8 | 1125 | 4.36 | 0.69-1.54 | 3.0 | " | all round |
| 9 | 1250 | 4.51 | 0.43-1.28 ; 0.32-0.43 | 2.5 | " | all round |

Formulas (all [A] from the construct/tick): HP: L<6 `max - (max>>2)*((7-L)>>1)`, L>7 `max + (max>>3)*(L-7)`;
speed internal `(1843<<12)/300 = 25163`, then `+(L-3)*0x800` below 3, `+(L-3)*0x420` from 3; level flight
moves `speed*dt>>8` wu/tick (aircraft.c 0x00420b84; banking reduces it). Rethink reload
`0x350 - 80*L` ticks then `+rand&0xff` (modes 0,1) or `-rand&0x1f` (mode 2) (0x00421658..0x0042168f).
Respawn: crash landing sets `state_timer = (14-L)*150` ticks (aircraft.c 0x00420d90). Arc bits: the
construct rewrites shooter bitfield bits 0..2 (6 below L1 / 2 from L1 for weapon 7; 6 / 2 / 0 for
L<3 / 3..6 / >=7 for weapon 8); those bits are `ARC_BLOCK_REAR 0x2`, `ARC_BLOCK_SIDE 0x4`
(actor_discharge.h:187-189; sectors front 0-22.5, side 22.5-157.5, rear 157.5-180 deg). The construct
comment says "nothing decompiled reads bits 0..2" - discharge.c does; arc reading is **[B]**.

### 1.4 Weapons (per-mission type-98 catalogue; ids 7/8/9 identical in all six arenas, `wep.py`)
| id | block | kind | dmg | refire | DPS | range | blast |
|---|---|---|---|---|---|---|---|
| 7 | instance shooter | 0x0c hitscan | 2 | 18 ticks (0.06 s) | 33 | 24 m | - |
| 8 | ai->weapon[0] | 3 guided missile (needs LOS) | 25 | 150 ticks (0.50 s) | 50 | 24 m | - |
| 9 | ai->weapon[1] | 4 arced round | 200 | 601 ticks (2.0 s) | 100 | range field 6 m | 3.2 m |
Refire = catalogue burst_gap `raw*4096/218` ticks (block.c:436, prepare.c loader); damage +0x0c,
blast +0x0e<<4, range +0x16<<4 (actor_discharge.h:335-343); magazines unlimited. [A] for numbers,
[B] for "range" meaning of kind 4 (it is the ballistic drop term). Speeds (RE M3-OR): weapon 8 is a
kind-3 round launched by `cact_missile_spawn` (0x0044d000) at `trunc(8192/300) << 4` = 432 wu per engine
unit = 15.82 m/s, already at its cap because +0x14 is 0 (0x0044d103; Slim and Joke carry 0x7a: launched at
`top * 2`, accelerating); weapon 9 is a kind-4 round, `cact_round_spawn_arced` (0x0044d440) on the
ballistic solve `cact_discharge_arc` (0x0044d190) at 4096 -> 7.62 m/s with +0x16 = 3072 as the drop. [A]
All three shooters share one target: `sky_aim` 0x00421820 writes weapon[1]->weapon[0]->instance. Aim
is only assigned when target is inside engage range 12 m (true hypotenuse, `sky_in_weapon_range`). [A]

### 1.5 Decision pass (0x00421910), run once per rethink
**Reference points**: `home` = point_0c = its own spawn position (Mp (96,66.8), next to slot-1 base);
`pbase` = point_00 = human slot 0's position at construct (its base spawn). `self` = current position.
Distances below converted to metres. [A]

**Scan** of every live actor of type 1,5,6,8,9,28,36 (types: 1 human X1Alpha, 5 tank, 9 jet (byte_19<10)
or Flying Fortress (byte_19>=10), 28 Dreadnought, 8 turret, 36 neutral/capturable turret):
* own units (team == captain's) except turrets, measured from **pbase**: own tank within 52 m
  (`near_tank`, +1 score), own Dreadnought within 60 m (`near_dread`, +10 score), own Fortress anywhere
  (`near_fortress`). (Score is bumped each time the slot's best is replaced, so it depends on list order.)
* everything else (enemy units, all turrets, neutral turrets), measured from **home**: enemy tank
  within 64 m (`far_tank`), enemy Dreadnought within 72 m (`far_dread`), count of **own** turrets within
  256 m (`own_turrets`), enemy jets/fortresses (unbounded).
* the same set again measured from **self** plus a penalty `(9-L)*0.5 m`: enemy human (`own_player`,
  skipped while the human's view block halfwords +0x324/+0x326 are positive - see could-not-establish),
  enemy tank, enemy Dreadnought, enemy jet, enemy Fortress, human-owned neutral turret, neutral
  turret (this slot adds `rand&0x3fff` jitter to its stored distance on every losing candidate).

**Mode machine** (mode byte mirrored to word 39; construct starts in mode 2):
1. Promote to **mode 2 (defend home)** if `far_dread` or `far_tank` exists, or `own_turrets < 10` and
   mode != 1. In mode 2: engage `far_dread` unless `far_tank` is strictly nearer, else engage `far_tank`;
   else if `own_turrets < 10` **move toward the human** (slot 0) without aiming; else -> mode 0.
   (8 base turrets + 2 per owned outpost, so early game `own_turrets < 10` is normally true: the
   captain's default is "defend, or go after the player".)
2. If not mode 2: promote to **mode 1 (attack/escort)** when score >= 2. Mode 1: if `near_dread`
   (own Dreadnought within 60 m of pbase) move to it - unless it has no weapon target and a neutral
   turret is within 8 m, then go capture that; else if `near_tank` (own tank within 52 m of pbase) drop
   weapon target and move to it; else -> mode 0.
3. **Mode 0 (opportunist)**, first hit wins, all from `self` with the level penalty:
   human with HP < 1/4 max within 40 m (aim+chase, event 3) > enemy Dreadnought 40 m > enemy tank 32 m >
   neutral turret 48 m (move only) > enemy jet 24 m > human-owned neutral turret 40 m (move only) >
   enemy Fortress 24 m (quirk: compares flat distance, not hypotenuse) > nearest neutral turret
   (any range) > nearest human-owned turret (any range) > else state CRUISE and destination =
   midpoint(home, pbase).
   "engage X" = aim if within 12 m, then set move target X (state ENGAGE).
4. Then, whatever the mode: if the human is visible-to-AI and not already the weapon target, and the
   current weapon target is not the chosen Dreadnought/tank, aim at the human if within 12 m (event 2).
5. If mode changed: destination := mode0 midpoint / mode1 pbase (event 1) / mode2 home.

**Flight per tick** (aircraft.c): commander never patrols; ENGAGE with a move target flies at the
target's position, otherwise at `destination`. Reverse direction while within 1 m (standoff) - this is
what makes it circle/jitter on a target. Altitude: saturating P-controller around
`envelope + 1.28 m`, clamped hard to the envelope. Turning: steer = horizontal unit direction
(15-bit) x `turn_rate*dt>>3` (16.16), low-passed (`acc=(3acc+in)/4`), added to the unit heading and
renormalised; pitch clamped +-0x8000. **Retracted (RE M3-OR):** the heading accumulates the
unfiltered step (`heading += [ebp-0x14..]` at 0x00420b2a), not the low-passed `steer` (that only banks the
model), and the 15-bit rescale is a pure shift, so the step is 2^15..2^16 x turn x delta / 2^35 of the unit
heading: at 30 fps 65-152 deg/s at turn 4096 (the captain), 81-190 deg/s at 5120 (jets, Fortress), by the
distance's bit pattern; 262-621 deg/s boosted. **[A]** Weapon 7 fires every tick it has a target; weapons 8/9 are
ticked in `sky_tick` (0x0042169b).

### 1.6 Retreat and heal (tick 0x004215b0) [A]
Threshold `= maxHP/2 - rand(0..63)`, halved in modes 1/2 (so ~50% HP in mode 0, ~25% when attacking or
defending). While HP < threshold:
* within 2 m of home: full restore on the spot (event 4);
* if ENGAGE: destination home, state CRUISE, drop weapons, `speed += speed >> (4 - L/4)` (+6.25% L0-3,
  +12.5% L4-7, +25% L8-9), no rethink this tick;
* if CRUISE: nearest restoring ItemPickup; within 10 m -> turn rate x4 (once); within 0.5 m -> take it
  (killed if consumable) and full restore; else if nearer than home -> divert to it; no pickup -> fly
  home, x4 turn within 10 m of home.
Restore (0x00420f60) = HP to max, new threshold, ENGAGE, rethink now, cruise speed/turn restored, event 4.

### 1.7 Death and respawn [A]
HP < 0 -> aircraft crash tumble -> on ground: `state_timer=(14-L)*150`, stats (First Death stamp, deaths
+1), credit to the human if he did it, then its **death script** (RPNS pool@1779 Mp):
`W25+=10; W31+=10; W26 = max(W26-10, 0); F27=1` (voice 28/29/44/45). Op 4 counts down; respawn
(0x00422bc0) at its anchor, full HP, random heading, mode 0, weapons dropped, event 9 (voice 83).

### 1.8 Budget model (word 26) [A]
* Word 26 **is** "Current Points" of slot 1 (results page key 0xd = word 25+slot, HUD `%03ld` of word
  25+slot, draw.c:550). In 1P, construct sets it to 0 (0x004214fc); fn26 only seeds W26=10 when W3==2.
* It accrues exactly like a human side: +1 when a slot-0 tank/jet dies (death scripts pool@1547/1179,
  any killer), +1 when a slot-0 base/outpost turret dies (pool@1537/1561), +5 when the human's
  Dreadnought/Fortress dies (pool@1739/1763), +10 when the human goes down (pool@136, run at his
  respawn by `player_respawn` 0x004475e9), +1 per neutral turret captured by the captain's team
  (0x0041cb7b) and +1 per human-owned neutral turret destroyed (0x0041bdca..); -10 (floor 0) when the
  captain dies. Each engine credit also zeroes its rethink countdown (forces a new decision pass).
  The human's down is not one of those script points: its engine credit is taken at the down
  (`player_op4` 0x004477ab..0x004477ea: the captain's tally +1, rethink 0), and only when the actor
  the mech remembers as having put it below zero is the captain itself (a round counts as its
  owner, whose id it carries); a down by its tanks, jets or turrets credits nothing there.
* Counts: word 29 = captain tanks alive, word 30 = captain jets alive (the death scripts decrement
  them; dispatch's "CLASS_A/B_COUNT" are these). Cap 20 each (`SKY_UNIT_CAP 0x14`), same 20 the
  human pads check.
* Request words and their consumer scripts (Mp fun.json):
  | word | meaning | consumer | cost paid by dispatch |
  |---|---|---|---|
  | 40..43 | outpost 0..3 owner (writes its team byte 2) | fn22-25: when ==2, enable the captain-side capture zone (turret swap, W34++) + voice 14/12/8/10 | 30 |
  | 44 | base tanks | fn01 -> F12 -> fn19 spawns `Csac77` one per 3.4 s; voice 30/46 (50%) | 1 each |
  | 45 | base jets | fn00 -> F10 -> fn17 spawns `Csac33` one per 0.97 s; voice 47-49 | 1 each |
  | 46 | Dreadnought | fn05 spawns `Csac57` now, voice 16 | 50 |
  | 47 | Flying Fortress | fn06 spawns `Csac6` now, voice 18 | 50 |
  | 48+2i / 49+2i | tanks / jets at outpost i | fn33/32/35/34/37/36/39/38 -> F1/F2/F3/F5/F6/F14/F7/F9 queues | 2 each |
  Note fn05/06 just ask spawner 57/6 for one; the spawner limit 1 silently refuses a second one and the
  50 points are already spent (retail quirk).
* Spending, per decision pass (0x00422405..0x004229ac):
  * **mode 2**: (L>=9 and far Dreadnought <18 m or far tank <16 m of home and tanks<20 and budget>0)
    -> 1 base tank. `hd = dist(self,home) - L*8 m`. If jets < L/4+4: if hd<64 m buy base jets
    `n = min(rand(0..3)+L/4+4, 20-jets, budget) + 2*(L/4) - 4`; if hd<64 m or jets<10, for owned
    outposts 2,3: `rand(0..3)` jets each, capped so that budget keeps >=5. If hd<64 m and no own Fortress:
    budget > 65+rand(0..7) -> buy a Fortress (-50).
  * **modes 0 and 1**: claim every unclaimed outpost (order {3,2,1,0} or {1,0,3,2}, chosen once by
    rand&1 at construct) while budget >= 30.
  * **mode 1**: owned outposts 0,1: `want=rand(0..7)+7+L/4-2` tanks (need >=7 and 2*want<=budget);
    then if tanks>11: owned outposts 0,1 `rand(0..3)+4+L/4-2` jets (need >=4).
  * **mode 0**: no own Dreadnought within 60 m of pbase and budget>=50 -> buy Dreadnought. Then if
    (slot-order 1 and L<8) or (slot-order 0 and L<6) or (no outpost refused for money and it has a
    Dreadnought alive) and L+6 <= 20-tanks: owned outposts 0,1 get `rand(0..7)+L+6+L/4-2` tanks (need
    >= L+6, 2*want <= budget); and if tanks<2 (and, once it owns an outpost or L>=5, only while the human
    owns outposts 0 and 1): base tanks `rand(0..3)+L+6 (+6 if human owns all 4 outposts)`. Slot-order 0
    keeps at least 1 jet alive (buys 1-2 base jets).
* Free opening order at construct: L>=1 base tanks `min(10, rand(0..3)+9-L)`, jets the rest of 10;
  L0 nothing (0x00421476). Unpaid.

---------------------------------------------------------------------------------------------------
## 2. Human economy (all six arenas use identical numbers; `cdec.py`/`rpns.py` diffed) [A]

* **Start**: 10 points (fn26 `W25=10`, `W26=10` only in 2P). Timer gate T4 is armed by the slot-0
  X1Alpha's resource-header script (`Cact12`, which also sets W23=1, the PA flag).
* **Current Points** W25+slot (spend), **Points Scored** W31+slot (never decremented), **Outposts
  Claimed** W33+slot. HUD shows Current Points and `tanks/jets alive` (W27/W28 for slot 0, W29/W30 for
  slot 1 - the rebuild calls them "ammo", draw.c:551-552). Score plate blinks when >=30 points and
  fewer than 4 outposts are claimed in total (draw.c:1416) = "you can afford an outpost".
* **Income**: enemy tank/jet dies +1, enemy base or outpost turret dies +1, capture a neutral turret +1,
  destroy an enemy-captured neutral turret +1, enemy Dreadnought/Fortress dies +5, enemy avatar/captain
  goes down +10 and the victim loses 10 (floor 0). Unit-death points go to the opposing side **whoever
  killed it** (death scripts, not kill credit). **No trickle**: no script or engine path increments
  W25/W26 over time (writers: scripts, turret.c 0x0041be0c/0x0041cb80/0x0041cc10, cheat 0x0044ec90).
* **Buying** (no menu; HUD/radar code only displays):
  * base pads = Trigger volumes with `action_button`, watched actor = own X1Alpha (Mp act106 jet,
    act107 tank): cost **1**, needs alive count < 20; jet spawns at once, tank is queued (one per ~3.4 s).
    Accept/deny sounds via pending-sound slot `*P[3] = 63 / 73`.
  * **outpost claim**: drive into the outpost's claim zone (type-14 touch zone, e.g. Mp act152) with
    >=30 points: -30, W33++, outpost owner word 40+i := 1 (or 2), enemy outpost-turret spawners shut, own
    opened (respawn 25 s), colour/radar orders, claim zone killed - **claims are permanent**, first come
    first served. Voice 7..14.
  * owned outpost pads (type-14 zones enabled by the claim): tank or jet for **2**.
  * Dreadnought / Flying Fortress zones in base (Mp act47/act51), enabled the first time you reach 50
    points (fn30): cost **50**, one alive at a time (flag F18..F21 + spawner limit 1), voice 15/17.
* Neutral turrets (type 36, 32 per arena, respawn 25 s): captured by proximity of a human avatar, a
  tank (type 5) or the Sky Captain within `radius + (1024+0x400)*16 wu` ~ 4 m (0x0041c920), switch
  team, retarget, +1 point.

## 3. Production [A]
Class byte (tACT +0x25 of the Csac template): 1 Tank (Pathed, 150 HP, weapon 1/6), 2 Jet (Aircraft,
150 HP), 3 Dreadnought (type 28, 3000 HP, route mode 0, four guns of weapon 3 = 100 dmg every 2.0 s, 12 m),
4 Flying Fortress (Aircraft, 2000 HP, weapon 4 = 100 dmg every 0.5 s, kind 3). Tanks/jets carry weapon 1
(slot 0) or 6 (slot 1): 50 dmg every 1.0 s, engage 12 m; neutral turrets use group 50. Tank/jet spawners: limit 20, **shut**
(timed spawning off) - production is purchase-only. Queues: tanks one per 3.25-3.40 s per spawn
point, captain jets one per 0.83-0.97 s, human jets immediate. Caps: 20 tanks + 20 jets alive per
side (scripts), 1 Dreadnought + 1 Fortress. Base turrets (8 per side, 500 HP) respawn every 37.5 s,
outpost turrets 25 s once owned, pickups 50/100 s. Spawn credits ("Created" stats) per class:
spawn.c 0x0044f4b6..0x0044f563; the kill-side counter (0x0044f120) is still a stub.

## 4. Route following (route.c 0x00440f70, route_init.c 0x004415f0, route_tick.c 0x004402a0) [A]
* PA tanks (all six arenas): mode nibble **4 = SEEK_TEAM**, key = enemy team, wander 1638 (=40% per
  step), search range 8192 (<<4 = 16 m), flags 0 (no backtracking). Dreadnought: mode 0 (random), flags
  0x8 (ignores traffic).
* Each step at a node: with p = wander/4096 the step is random; otherwise find the nearest enemy-team
  actor within 16 m (`cact_find_target` mode NEAREST) - none found -> random step. (The held target is
  always dropped and re-found: retail `js` never taken, route.c header.)
* Candidate scoring for each of up to 4 links: no link -4; just-left node -2 (refused); node before
  that -1 (last resort only); node with script-closed bit -3. Else random mode: `rand&0xffff`; seek
  mode: `dot = (cand-here)·(target/256 - here)` in node units, score `floor(log2(dot))+0x20` for
  dot>=0, `0x1f-floor(log2(-dot))` for dot<0 (flee modes negate dot). Occupancy: `score >>= n` where n =
  units already heading to that node (node nibble). Pick: walk links 3..0, keep the higher score, ties
  by coin flip. No candidate -> halt.
* Speed: top speed `((1024<<8)/300)>>4 = 54` wu/tick = **1.98 m/s**; accel `(1228<<8)/300/16` = 65
  wu/tick^2 (full speed in one tick), decel 32 wu/tick^2. Arrival: leg complete when travelled >=
  leg length (no radius); heading blends across a corner window around the node (no angular rate).
  speed_scale 4096 -> no corner slowdown.
* Traffic (route_near.c 0x004248f0, on pair-test contact gap < 2 m): needs other within 0x1400 wu
  vertical and inside cos16 deg (or cos60 deg when very close). Another route follower on same target
  node: the one with more leg left yields (speed = half the other's, capped at own top), deadlock
  breaker releases the other; different nodes: yield if it comes from where I go or goes where I go
  next. Non-follower obstacle within 2 m dead ahead: stop; otherwise half own velocity + quarter top
  speed. Every slowdown holds 300 ticks (1 s).
* Jets/fortresses are Aircraft: speed 2048 (4.0 m/s) / 2457 (4.8 m/s); periodic target search every
  900+rand(511) ticks within search range, patrol box, ENGAGE/CRUISE dwell timers.

## 5. Win / match end [A]
* Each base has a gate trigger set (Mp: 6 triggers at z=144.6 for slot 0, 6 at z=79.5 for slot 1;
  half-extents raw 2457 x 1843) watching the **enemy's five tank spawn templates and its Dreadnought**
  (not jets, not the avatar). Fire -> script flag F25 (slot-0 base reached) / F16 (slot-1 base reached).
* fn42 (F25): voice 19 (interrupt), **W16 = 1**, phase countdown `*P[2] = 1750` ticks (5.83 s), 1P: voice
  36/37/62. fn02 (F16): voice 6, countdown 1750, 1P: voice 65..67.
* `mission_frame_net` 0x00407fe0 counts the countdown down; at zero in PA it silences both avatars'
  movement loops (`snd_loop_set_mode(0x27)` - 0x27 is a sound mode, not an operation) and goes to
  state 0xd, the results page. **Slot 0 lost iff W16 == W17**; W17 is set to 1 at load by the slot-1
  resource (Cact16 in 2P, the Sky Captain variant in 1P). Winner in 1P advances the level (sec. 1.2).
* There is no TeamBase destruction effect because there is no destructible base; Dreadnought death
  = +5 and reopens its purchase.

## 6. Voice/alert lines (ops 0x0c queue, 0x0d interrupt; none of the six arenas uses 0x0e/0x0f) [A]/[C]
Speech id N -> `extracted/voice/wav/v{N+1:03d}.wav` (name m{N+1:04d}); verified for all 86 ids in all
six PA arenas (tTOS order == snds order, `extract_voice.py` cross-check). Meanings are from the
trigger/script that plays them [C - no transcripts]. Intrusion alert = **id 2** (enemy tank,
Dreadnought or avatar in slot-0 base zone, 20480x12288 raw retrigger volumes, cooldown 2500 ticks
8.3 s) and **id 3** (same for slot 1's base). Turret under fire: 4 / 5 (cooldown 10 s); base turret
lost: 0 / 1. Gate reached: 19 (slot 0 loses) / 6 (slot 1 loses). Full list in ai-and-rules.json.
Sound effects (not voice): pending-sound slot `*P[3]` 63 accept, 73 deny, 83 pickup.

## 7. diffexec (256 cases)
| file | function | result | note |
|---|---|---|---|
| dispatch.c | 0x00420f60 sky_pickup_restore | diff 0/256, 4/4 blocks, suspect | |
| | 0x00420ff0 sky_refresh_destination | diff 3/256, 5/7, **not suspect** | faults at different offsets (C 0xa5 vs retail 0xf9): rebuild struct layout ≠ retail; hand-checked vs disasm - logic identical |
| | 0x00421090 cact_handler_type37 | diff 96/512, 14/20, suspect | |
| | 0x004211f0 sky_construct | diff 0/256, 30/32, suspect | |
| | 0x004215b0 sky_tick | diff 4/256, 16/32, suspect | |
| | 0x00421820 sky_aim | diff 2/256, 3/6, **not suspect** | retail writes through +0x134 block, C layout differs; logic matches listing |
| | 0x00421910 cact_dispatch_types | diff 0/384, 57/313, suspect | coverage low (57 of 313 blocks) |
| | 0x00422af0 sky_set_move_target | diff 0/256, 5/5, **not suspect** | arena words differ only by field offset; 43-byte listing hand-checked: identical |
| | 0x00422b20 sky_find_pickup | diff 95/256, 9/15, suspect | |
| | 0x00422bc0 sky_respawn | diff 0/256, 1/1, suspect | |
| route.c | 0x00440f70 cnet_route_next | diff 47/512, 51/54, **not suspect** | 80 cases: C's documented NULL-graph/bounds guards return -2 where retail faults; 55: C refuses `from >= count` (rebuild guard) where retail walks on; 34: target_serial word differs (C reads serial at its own cact_instance offset). Unmapped g_last_links/scores. No algorithm diff found, but not fully closed |
| spawn.c | 0x0044eff0 csac_load | diff 0/256, suspect | |
| | 0x0044f120 csac_on_spawned_death | diff 91/256, 4/36, suspect | |
| | 0x0044f3b0 csac_tick | diff 42/256, 11/16, suspect | |
| | 0x0044f470 csac_spawn | diff 0/256, 1/28, not flagged | harness: C keeps its own table (`g_count` unmapped); retail faults on arena record; no logic comparison happened |
| vm.c | 0x00457550 cfun_exec | diff 0/768, 80/96, suspect | |
No diff points at a misreading of the rules above; most are layout/unmapped-global artefacts.

---------------------------------------------------------------------------------------------------
## 8. Metropolis should use ...
* **Starting points 10**, not 20. **Remove the trickle** (or document it as a deliberate deviation).
* **Unit kill = +1 to the opposing side regardless of killer**; turret kill **+1** (not 2); neutral
  turret capture **+1** (not 3); Dreadnought/Fortress kill **+5**; avatar down **+10 and victim -10**
  (floor 0).
* Costs: tank/jet **1 at base, 2 at an owned outpost** (Metropolis' OUTPOST_COST_MULTIPLIER 2 matches),
  outpost claim 30, Juggernaut/Fortress 50, alive limit 1 - all match.
* Caps: **20 tanks + 20 jets alive per side** (Metropolis 8 total).
* **No free production**: production only by purchase; queue tanks at ~3.3 s per spawn point.
* Win: enemy **tank or Dreadnought entering the base gate volume**; 5.83 s outro; no core HP, no timer.
  (If Metropolis keeps the 3000 HP core it is an invention: 3000 HP belongs to the Dreadnought.)
* Outposts: claimed by touching the claim zone with >=30 points; permanent; opens own turret spawners
  (25 s respawn) and shuts the enemy's.
* Warden -> Sky Captain: HP 250..1250 by level, speed 2.7..4.5 m/s, weapons 33 dps hitscan 24 m +
  50 dps missile + 200-dmg 3.2 m bomb every 2 s, rethink `(848-80L)` ticks, respawn `(14-L)*150` ticks,
  the three-mode machine and spend rules of sec. 1.5/1.8, budget = its own Current Points (start 0
  plus a free 10-unit opening order).
* Unit routing: SEEK_TEAM within 16 m with 40% random steps, log2 octave scoring, occupancy halving,
  no doubling back (prev refused, prev2 last resort), speed ~2 m/s, 1 s yield holds.
* Alarm: use voice id 2 (own base) / 3 (enemy base) with an 8.3 s cooldown; turret-under-fire 4/5
  (10 s), turret lost 0/1. These are speech lines played by script op 0x0c - the "no sound opcode is
  proven" note is obsolete.

## 9. Could not establish
* What the human view-block halfwords +0x324/+0x326 are (the captain ignores the human as a mode-0 /
  bonus target while either is positive; HUD blinks blue on +0x326 > 0 - maybe invincibility/cloak).
* Voice line content (no transcripts); meanings above are inferred from the triggering script.
* Exact trigger box size in metres (raw 2457x1843 for gates; behaviour doc says x8 effective).
* `csac_score_kill` (per-class "Destroyed" stats) is a stub; player block +0x40 gate on neutral-turret
  capture is a stub.
* Whether `own_turrets < 10` ever goes false in practice (needs >= 10 own turrets, i.e. all base turrets
  plus an owned outpost's pair) - the arithmetic is certain, the play balance is not measured.
* The diffexec diffs listed as harness/layout were not driven to `match`.
