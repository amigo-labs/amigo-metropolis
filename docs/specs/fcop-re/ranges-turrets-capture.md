# Precinct Assault rules for Metropolis: what the retail executable does

> **Correction (2026-10-12, [`outposts.md`](outposts.md)).** "16/14 base guns per side" counts the outpost plates too. 8 (Mp/Conft/Ovmp) or 6 (Slim/Joke/Hk) per side are base turrets, live from the start. The rest are outpost-plate turrets, which spawn only after their outpost is claimed.


RE tree: `/home/user/fcop-reverse-engineering` @ 7766374. All claims were read against
`tools/re/disasm.py` on `fixtures/FCopLAPD.exe`, and the shipped record bytes were decoded
from `fixtures/missions/<Map>`. Decoders: `scratchpad/decode.py`, `cobj.py`, `air.py` and
`dump_raw.py`. The full per-map table is in RE session scratchpad (`re-turrets.json`, not kept; regenerate from the decoders described here).

**Units.** In this report 1 m = 1 heightmap sample = 8192 world units (wu), which is the
Metropolis convention. The engine clock is 300 Hz: every actor tick, the shooter and the Csac
tick get `frame_delta()` in 300 Hz ticks, capped at 60 (`game/frame/frame.c:74`,
`mission_frame.c:1322-1356`).

> **The one finding that changes Metropolis's model.** Actor type 28 (extracted as `TeamBase?`)
> is **not a base. It is the Dreadnought**, a 4-gun ground unit that drives its Cnet.
> Its record class byte (payload +0x19, `CFUN_SPAWN_GROUP_AT` 0x1d on the biased pointer) is 3
> on every PA map. `csac_credit_spawn` credits class 3 to the results row "Dreadnoughts"
> (`spawn.c:296-330`, `results.c:49`). By the same byte, tanks (type 5) are class 1, jets
> (type 9) are class 2 and the two heavy aircraft (type 9) are class 4, "Flying Fortresses".
> `cact_handler_type28` op 6 calls the type-5 handler, which ticks the route, before it steps
> its mounts (`mount.c:1006-1016`, retail 0x0042612c). Its "unit_template" (move_speed
> 1024, accel 1228) is its own route block at payload 0x30. It spawns at node 0 of its Cnet,
> which is next to the HQ, from a Csac spawner with period 5 s and limit 1.
> **Confidence: high.**
> **Metropolis should model type 28 as a Dreadnought unit, not as the team base.** The base
> guns are the type-8 team turrets: 16 per side on Mp, Conft and Ovmp, 14 on Slim, Joke and Hk.
> Nothing in the code places guns at the core centre.

---

## Q1: Range scale. Positions are copied unscaled; ranges are `raw << 4`

**Load path.** `cact_base_construct` (0x0041a530, `base.c:273-276`) copies the record's three
i32 into +0x50 (`position`) and +0x5c (the reference point, `previous`) with plain `mov`s
(0x0041a67c..0x0041a6a9) and does no scaling. The spawner path (`csac_load` 0x0044eff0 →
`cact_create_from_spawner`) hands the same tACT record to the same construct. Turrets then
overwrite `position` with the base part's model point 0. The offset is model units × 16
(`math_matrix_place_point` `>>12` on a 16.16 matrix, `matrix.c:796`), which is only a small
displacement. So the actors.json position /8192 is the runtime position in m. Runtime
`position[0]` is extract_logic's `z` (blob 0x10) and `position[2]` is its `x` (blob 0x18).

**Targeting.** `cact_shooter_acquire` passes `movsx [blk+0xa]; shl ecx,4` (0x0044e957 /
0x0044e96b, `shooter.c:298`). The keep-target test does the same (`shooter.c:489`).
`cact_shooter_init` stores the record's engage_range raw (0x0044ea7b, `block.c:472`).
`cact_target_score` (0x0043ba60, `target.c:148-164`) compares that value against raw position
deltas (+0x50/+0x58): first a box test, then `sqrt16_16(dx²>>16 + dz²>>16)`, which is in plain
wu, with `dist >= range` → reject. The distance is horizontal, centre to centre, with no radii.

**Conclusion: metres = raw × 16 / 8192 = raw / 512. engage_range 6144 → 12.0 m. High
confidence.** Corroboration: weapon 3's projectile range field is also 6144, and `range_16 << 4`
in `cact_missile_spawn` (`discharge.c:675`) makes the rounds fly exactly 12 m, matching the
engage range.

| quantity | code | rule | PA values |
|---|---|---|---|
| shooter engage_range | above | raw/512 m | 6144 → **12 m** (every turret, neutral turret, tank, jet, Dreadnought gun) |
| aircraft target_detection_range (= `search_range`, AREC 0x36) | `shl eax,4` at 0x00420796 (`aircraft.c:726`) | raw/512 m | jets 28672 → **56 m**; Fortress and type-37 craft 32358 → **63.2 m** |
| aircraft re-search period | `(rand&0x1ff)+0x384` | 900..1411 ticks | **3.0..4.7 s** |
| aircraft orbit_area_x / _y (AREC 0x44/0x46) | stored `raw>>5` (`aircraft.c:1014`). The leash trips at `|d|>>8 > stored` (0x00420904..0x00420924), and a new destination is drawn at `±(0x400·stored)>>3` | leash half-extent = raw·8 wu = **raw/1024 m**; destinations within ±raw/2048 m | 24576×20480 → leash ±24 m × ±20 m, destinations ±12 × ±10 m. Fortress 30720×28672 → ±30 × ±28. orbit_area_x drives runtime position[2] = extract **x** |
| aircraft standoff (AREC 0x38) | `(dist>>4) < standoff` → reverse | raw/512 m | 512 → 1 m |
| trigger extents | loader `raw/2` (`cdq;sub;sar 1`, 0x0041fde2..0x0041fdff); test `|c<<8 − pos| − (ext<<4) − radius_68 < 0` (0x00420150..0x0042017f) | **half-extent = raw·8 wu = raw/1024 m** (full = raw/512 m), grown by the intruder's radius_68 | width_raw (record +0x14) → runtime position[2] (extract x); length_raw (+0x16) → position[0] (extract z); height_raw (+0x18) → y. Mp: zone 20480×12288 → **40 × 24 m**; core 2457×1843 → 4.8 × 3.6 m; action pads 819×614 → 1.6 × 1.2 m; height 2048 → ±2 m |
| neutral-turret capture radius | `movsx [esi+0xfc]; add 0x400; shl 4` + `[cand+0x68]` (0x0041ca04..0x0041ca20, `turret.c:1128`) | `(range+1024)·16` wu + intruder radius | see Q2 |

`range` in the capture radius is turret +0xfc. The construct loads it from record payload 0x4a
(`mov ax,[edi+0x4e]`, 0x0041c1de, on the payload−4 pointer). That is the last halfword of the
60-byte type-36 record, which extract_logic does not decode. Shipped values: Mp, Conft and
Ovmp **1024** → 4.0 m; Slim and Joke **1638** → 5.2 m; Hk **1843** → 5.6 m (all excluding
the intruder).

**X1-Alpha radius_68** = the bound legs model (Cobj 15 on every PA map) 3DBB box +0x0c `<< 4`,
refreshed per animation frame (`model.c:126/220`, `player_walk.c:128`). It is **0.553 m at
frame 0**, 0.453–0.713 m across its 371 boxes. The hover form's frames are inside that set.
Which frame is live at a given moment was not traced (medium confidence on the exact value).

Metropolis should use:
* `RANGE_SCALE = 512` (raw/512 m) for engage_range, target_detection_range, search_range and
  standoff. 6144 → 12 m and 28672 → 56 m; the current 1024 is half the reach.
* orbit_area: keep raw/1024, but as the leash half-extent (±24 × ±20 m), with patrol
  destinations drawn in ±raw/2048.
* triggers: half-extent = raw/1024 m (full box = raw/512 m), plus the intruder radius.
  `TRIGGER_SCALE = 8192` is 16× too small: Mp's zone box is 40 × 24 m, not 2.5 × 1.5.
* the targeting test is horizontal and centre to centre. Turret aim keeps a target until the
  surface gap reaches range only on the non-PA search path; PA turrets drop a target on the
  shooter's centre-to-centre test.

---

## Q2: Capture. Instant, gated on a one-frame button press for the player; tanks and the captain capture by contact

Only type 36 (NeutralTurret) can be captured. `cact_handler_turret` op 0x0a → `turret_op10`
(0x0041c920, `turret.c:1080-1190`; disassembly checked).

**When it is asked.** Op 0x0a is issued only from the collision broad phase (`pair_allowed`,
`game/frame/objects.c:497-512`). That walk pairs an actor with others in the same or the four
"forward" neighbouring paint-grid cells, and each cell is a quarter of a terrain cell: 1<<15 wu
= **4 m** (`OBJECTS_QUARTER_SHIFT 15`). Both sides must be in the paint grid; turrets carry
flag 0x100 ("always"). So the capture radius only holds when the two are at most one 4 m cell
apart on each axis. Hk's 6.15 m radius is effectively clipped by that.

**Gate, in order.**
1. The turret is uncaptured (+0xfe == 0). **A capture is permanent** until the turret dies.
2. The candidate's team byte (+0x18) is team_a or team_b. These are record payload 0x44/0x45,
   and they are 1 and 2 on every PA turret.
3. The candidate type is 1 (X1), 0x12 (a sub-actor, resolved to its owner), **5 (PathedActor:
   tanks)** or **0x25 (37, the Sky Captain AI craft)**. Any other type, including aircraft (9)
   and Dreadnoughts (0x1c), cannot capture.
4. **Types 1 and 0x12 only:** the actor must be one of the two player slots, and its view
   block's `[+0xac]+0x40` must be **0**. That word is the state half of the button latch whose
   mask (+0x3c) the view construct seeds with **0x2000000** (`view_place.c:622-623`). It is
   latched every player tick by `player_fire_buttons` (`player_fire.c:868`). State 0 =
   **pressed this frame**: an edge, not "held" (`view_button_latch`, `draw.c:757`). The same
   word gates elevator riders and `TRIGGER_FLAG_PLAYER_GATE` triggers (extract's
   `action_button`), so it is the action/use key. Pad bit 0x00400000 (binding slot 5) is
   remapped to 0x2000000 (`draw.c:678`). The key's printed name was not established.
   Tanks and the captain need no button.
5. Distance: octagonal hypot between the two **reference points** (+0x5c). For every type but
   0x25 a second pass folds in the height difference (3D); type 0x25 is measured flat. Capture
   needs `distance < (range+0x400)·16 + candidate.radius_68`.

**What happens** (same frame; **no timer**):
- The turret's and its base part's team byte become the capturer's.
- +0xfe becomes 1 if team_a matched, else 2.
- The shooter is retargeted: `target_type = 4` (by team) and `targeting =` the *other* team
  (team_b if team_a captured). The turret's own search_kind/key get the same.
- +0x23 gets record byte 0x46 or 0x47 (1 or 2; meaning not established).
- +0x92/+0x93 (texture UV offset bytes) grow by record bytes 0x48/0x49 × state, both copied to
  the base part. That is a visual reskin: +60 or +120 texture-UV units, or +33/+66 on +0x93 for Hk's
  seven alternate-model turrets (the units are inferred, not established).
- Actor flag bit 0 is cleared.
- Mission counters are credited (`turret_score_capture`, a stub in the rebuild: it bumps a
  per-player stat halfword +0x12 and writes state code 6). What those feed was not
  established.
- The turret's contact script (`reloc[2]`) runs with the capturer's id when actor flag
  0x100000 is set. PA turrets carry it (flags 0x00110148), so a Cfun script runs. Its content
  was not read.

**Before capture a neutral turret shoots nobody.** Its shooter targets team 10 (BaseShooter
`targeting` = 10), and no PA actor has team byte 10.

**On death** a captured type-36 scores a kill for the side it belonged to (op 5,
`turret.c:426-439`, stub). Its Csac spawner rebuilds it from the record, so it comes back
**neutral**. tSAC raw −1500 → 25 s after death (Q5).

Confidence: high on the gate, the effects and that there is no timer (all read in the
disassembly). Medium on the broad-phase clipping (it follows from the code, but was not
measured in play).

Metropolis should use: instant capture, no 90-tick timer. The player must press the action
key in a frame where it is within `(range+1024)/512 m + 0.55 m` (4.55 m on Mp, Conft and Ovmp;
5.75 m on Slim and Joke; 6.15 m on Hk), in 3D. Tanks capture by proximity alone (3D); the AI
captain captures by flat proximity. Jets and Dreadnoughts never capture. A capture is permanent
until the turret is destroyed. A destroyed turret respawns neutral after 25 s. Uncaptured
turrets are passive.

---

## Q3: Turrets (types 8 and 36), and the Dreadnought guns

**Record → runtime** (`turret_construct` 0x0041bf90; checked against the disassembly
0x0041c1a8..0x0041c2e7):

| field | payload | PA value | meaning |
|---|---|---|---|
| turret flag byte | 0x3c | **0x07** on all 196 PA turrets | bit0 → aim at the *shooter's* target; bit1 → pitch tracking; bit2 → the /218 rate block plus "aim". No 0x08 (spin) and no 0x20 (yaw arc limit) |
| rate ("turn_speed") | 0x38 | 2457 | `turn_rate = trunc(trunc(raw·16/218) >> 4)` = **11 angle units per 300 Hz tick = 3300/s = 290.0°/s** |
| yaw | 0x34 | per turret | rest yaw (12-bit). The turret returns to it with no target |
| search range | 0x3a | 6144 | used only by the turret's own search, which bit 0 bypasses |

- **Turn formula:** deg/s = `((raw·16/218)>>4) · 300 · 360/4096` (`turret.c:711-735`;
  `turret_turn` caps the step at `rate·dt`). Metropolis's raw/4096 turns/s gives 216°/s; the
  true rate is **290°/s**. The /300 block (flag 0x08) is a free spin and is not used in PA.
- **Pitch:** ±0x200 = **±45°** (`TURRET_PITCH_LIMIT`). **Yaw arc:** ±0x300 = 67.5° around rest,
  only with flag 0x20, which no PA turret has, so traverse is unlimited.
- **The 1500 re-search** (`mov word [esi+0xf0],0x5dc`, 0x0041c555) is 5 s, but only on the
  turret's own-search path, which PA turrets skip (bit 0). **The re-search PA turrets actually
  use** is the shooter's: `delay = trunc(targeting_delay·4096/218)` ticks (0x0044ea83..0x0044eaa6).
  **targeting_delay is in 1/16 s** (218 ≈ 4096·16/300): 32 → 601 ticks = **2.003 s** (turrets,
  tanks, jets) and 16 → 300 = **1.000 s** (Dreadnought guns, Fortress, captain). Metropolis's
  "16 → 8 sim ticks" reading is wrong: 16 is 1 s = 30 sim ticks.
- **Shooter behaviour** (BaseShooter, payload 0x20):
  - mode 3 = nearest **with terrain line of sight** between reference points. target_type 4 =
    by team byte; targeting = the enemy team.
  - Type 8 bitfield 0x4246: HOLD_TARGET 0x4000 (re-scan every delay while engaged) and 0x40
    (prefer higher target priority: Dreadnought 15 > tank 10 > X1 5 > others 0).
  - Type 36 bitfield 0x0206: no hold, no priority.
  - Both carry 0x02|0x04, blocking the rear and side sectors: **a round goes out only if the
    aim lies within 22.5° of the gun's forward axis** (`discharge.h:172-189`). A blocked shot,
    or a projectile with no terrain line of sight (`discharge.c:1178-1181`), is put back and
    the fire clock is pushed back by `(rand−0x38)&0xff` ticks (0–0.85 s).
  - fov 4096 means no acquisition cone.
- **Weapon:** BaseShooter weapon_id → linear search of the mission's type-98 catalogue by its
  id byte (0x0044e900). The catalogue entry is the record's 32 payload bytes, with +8, +0xa and
  +0x18 run through `·4096/218`, +0x12 `/300` and +0x14 `·256/300` (`prepare.c:198-205,
  344-358`). Damage is +0x0c, splash `+0x0e << 4`, speed cap `(+0x12/300) << 4` wu/tick, range
  `+0x16 << 4`, rounds +0x06, magazine +0x02.
- The rate machine (`shooter.c:430-470`): the first round is immediate. A burst is `rounds`
  shots, `round_gap` apart; then `burst_gap`. Refire period ≈ burst_gap + (rounds−1)·round_gap.
  The clock stops while a due round waits for a target.

**Resolved table: every turret, neutral turret and Dreadnought gun on all six PA maps uses weapon 3, and
weapon 3 is byte-identical on Mp, Conft, Slim, Joke, Hk and Ovmp.**

| weapon | kind | damage | refire | burst | range | speed | splash | guided | magazine |
|---|---|---|---|---|---|---|---|---|---|
| **3** | 2 (aim with intercept lead, unguided round) | **100** | **2.003 s** (601 ticks) | 1 | **12 m** | **7.62 m/s** (13·16 = 208 wu/tick; the truncation of 4096/300 matters) | 0 | no | 20000 |

Other entries for comparison (Mp catalogue): ids 1/2/6 are 50 dmg, 1.0 s, 12 m, 7.62 m/s
(tanks and jets use 1 and 6). Id 4 is kind 3 (guided), 100 dmg, 0.5 s, 24 m (the Fortress).
Id 7 is kind 0x0c hitscan, 2 dmg every 0.06 s, 24 m (the captain). Id 9 is 200 dmg, 2.0 s,
6 m, splash 3.2 m. All of them are in the JSON.

| turret group | count Mp/Conft/Slim/Joke/Hk/Ovmp | team | HP | respawn after death |
|---|---|---|---|---|
| type 8 team turret | 32/32/28/28/28/32 | half 1, half 2 | 500 | Mp/Conft/Ovmp: 16 at 37.5 s (−2250) + 16 at 25 s (−1500); Slim/Joke/Hk: 12 at 37.5 s + 16 at 25 s |
| type 36 neutral | 32/32/29/29/35/39 | 0 | 500 | 25 s, returns neutral |

Turret positions are in the JSON. Confidence: high (each conversion was checked as a magic
multiply in the disassembly; the record bytes were decoded from the containers).

Metropolis should use: turn 290°/s, pitch ±45°, no yaw arc; fire only within ±22.5° of the
barrel; re-acquire every 2.0 s; acquisition needs terrain LOS; weapon 3 = 100 dmg every 2.0 s,
range 12 m, 7.62 m/s unguided round with intercept lead, no splash.

---

## Q4: The "base gun" mounts, which are the Dreadnought's four guns

`cact_type28_construct` (0x004262a0, `mount.c:784-848`, disassembly checked):
- The hull's model is aRSL entry 0. Gun i (i = 0..3) takes aRSL entry 3+i as its model, point
  index **i**, and flags byte payload 0x48+i (0 on every PA record: no pitch, no limit, no
  snap).
- turn `= ((i16)payload0x44 << 8)/218 >> 4` = **9 units/tick = 237°/s**; home yaw = payload
  0x46 = 0 (`mount.c:1099-1128`).
- Shooter: gun 0 copies the block from payload 0x20, and guns 1..3 re-init from payload
  0x50/0x60/0x70. All four are weapon 3, engage 12 m, delay 16 → 1.0 s, bitfield 0x0206
  (fire within ±22.5° of the gun's forward axis). The hull's own weapon is nulled.

Each tick a gun is placed at `cact_model_point(owner, owner->model_28, i)` (`mount.c:529`).
Retail 0x00429830: on a non-skeleton model this is 4DVL vertex `4DGI[0x30+i]` of the hull's
current frame, transformed by the hull's full matrix (`>>12`, so ×16 wu). The hull models are
static (one frame).

| map | hull Cobj | point 0 | point 1 | point 2 | point 3 |
|---|---|---|---|---|---|
| Mp, Slim, Hk, Ovmp (Cobj 36), Conft (Cobj 37, same geometry) | radius 1.29 m | (+0.268, 0.486, +0.283) | (−0.258, 0.486, +0.283) | (+0.264, 0.795, −0.404) | (−0.254, 0.795, −0.404) |
| Joke (Cobj 35) | radius 1.48 m | (+0.277, 1.104, +0.555) | (−0.273, 1.096, +0.545) | (−0.281, 1.086, −0.568) | (+0.272, 1.086, −0.570) |

Offsets are in m, in model axes (x lateral, y up, z forward). Model +z is the hull's forward
axis (matrix row 2 = route heading). At yaw 0 the hull faces runtime +position[2] (extract/
Metropolis **+x**), and model +x lies along runtime +position[0] (Metropolis **+z**). The
front pair is lower; the rear pair is higher and further back. Gun models are Cobj 37/37/38/38
(Mp), 38/38/39/39 (Conft) and 36/36/37/37 (Joke).

**Yaw.** The hull's yaw is the cursor's (`word_12a`): the bearing of the current Cnet leg,
first set from node 0 toward the first step (`route_init.c:330`). The route flags (0x0008) do
not have YAW_LOCKED 0x1000, so a gun's yaw is **relative to the hull**:
`desired = bearing − hull_yaw` (`mount.c:316-320`), and its matrix is composed with the hull's
(`mount.c:383-395`). With no target the guns turn back to home 0, which is hull-forward. There
is no pitch tracking.

Confidence: high on the offsets and the yaw composition. Medium that "model +x = Metropolis
+z" survives Metropolis's own mesh mirroring (the extractor negates X for glTF).

---

## Q5: tSAC timers

`csac_load` (0x0044eff0, `spawn.c:148-165`): period = `raw·5` ticks at 300 Hz, so
**raw is in 1/60 s**, and extract_logic's `spawn_seconds = |raw|/60` is right.
- **Negative:** made positive, and the phase starts at the full period, so the first timed
  spawn comes one period after load (a script's 0x46 "open" zeroes the phase, `cfun/spawner.c`).
- **Positive:** the phase is random in [0, period).

The phase counts down only while live < limit, the enable halfword is non-zero and the shut bit
is clear (`spawn.c:440-470`). So with limit 1, a respawn comes about one period after death.

PA values: turrets −2250 → 37.5 s and −1500 → 25 s; pickups −3000 → 50 s; tanks, jets and the
Dreadnought +300 → 5 s.

**Not the same unit as BaseShooter.targeting_delay or the weapon gaps, which are 1/16 s
(Q3).** High confidence.

---

## Q6: diffexec (`--cases 256`)

| file | function | result | blocks |
|---|---|---|---|
| shooter.c | 0x0044e5e0 cact_shooter_step | diff 123/256, suspect | 23/49 |
| | 0x0044e810 cact_shooter_orders | diff 193/256; **match 124/128** on rerun (deep) | 9/15 |
| | 0x0044e930 cact_shooter_acquire | **match 256/256** (deep) | 5/14 |
| target.c | 0x0043ba60 cact_target_score | diff 301/512 | 19/22 |
| | 0x0043bc00 cact_find_target | diff 570/1024, suspect | 39/66 |
| | 0x0045a1b0 cact_find_target_near | diff 97/256, suspect | 12/13 |
| turret.c | 0x0041bc60 cact_handler_turret | diff 83/512 | 28/49 |
| | 0x0041bf90 turret_construct | **match** 192/256 (+gap 56, al-only 8) | 18/48 |
| | 0x0041c3e0 turret_tick | diff 0/256 | 57/68 |
| | 0x0041c830 turret_orders_drain | diff 144/384 | 13/17 |
| | 0x0041c920 turret_op10 | **match** 256/256 | 9/59 |
| | 0x00429830 cact_model_point | skip (C has 4 args, retail 3) | — |
| mount.c | 0x004253c0 handler_mount 43/512 · 0x00425530 mount_construct 0/384 · 0x00425710 handler_type20 53/384 · 0x004258d0 mount_step 1/896 · 0x00425f10 type20_construct 253/256 · 0x00425fa0 mount_spawn 0/256 · 0x00426080 handler_type28 77/512 · 0x004262a0 type28_construct 7/256 | all diff | mostly full |

**Why they diff: the harness, not the readings.** diffexec runs the C against arena memory but
does not remap structs. In the rebuild's i386 build, `cact_instance` is a named struct with
`position` at **+0x20** (retail +0x50), `previous` at +0x2c (+0x5c), `radius_68` at +0x38
(+0x68), `type` at +0x0a (+0x16) and the shooter block at **+0xb4** (+0xa0). This was measured
with `clang -m32` and `nm -S` on `offsetof`. Any function that reads an actor through a pointer
therefore reads different words from the C side. The detailed cases show exactly that:

- `cact_target_score`: retail reads +0x50/+0x58, passes the box and calls sqrt; the C reads
  other words and rejects.
- `turret_tick`: `shooter_step(self+0xa0…)` in retail against `self+0xb4` in the C.
- `type28_construct`: the same +0xa0/+0xb4 shooter pointer. The remaining argument differences
  are retail pushing sign-extended or dirty-upper registers (`movsx` word_4a, `mov cl,[…]`
  bytes) where the C zero-extends. The callee keeps only the low 16 or 8 bits, so this is
  harmless.
- `mount_construct`: retail calls `cact_base_handler` 0x0041a420; the C's call resolves to
  0x0041a530 because the rebuild-linked handler is used.
- `shooter_step`: the registry globals are unmapped (`suspect`).

The functions that do not pass actor layout through a pointer match: `shooter_acquire`,
`shooter_orders` and `turret_construct`. **No diff points at a misreading that would affect
Q1–Q4.** Every Q1–Q4 constant was instead read directly from the retail bytes:

| address | what it confirms |
|---|---|
| 0x0041a67c | position copy, unscaled |
| 0x0044e96b | engage_range `shl 4` |
| 0x0044ea7b / 0x0044ea83 | engage_range copied raw; delay /218 |
| 0x0043ba6b..0x0043bada | target_score box test, sqrt and `dist >= range` |
| 0x0041c1de / 0x0041c255..0x0041c272 | capture range from payload 0x4a; turn rate /218 then `>>4` |
| 0x0041ca11..0x0041ca20 | `(range+0x400)<<4` |
| 0x0041c962..0x0041c99a | the type list (1, 0x12, 5, 0x25) and the `[+0xac]+0x40` button gate |
| 0x0041fde2..0x0041fdff / 0x00420150.. | trigger halving and `<<4` |
| 0x00420796 | aircraft search range `shl 4` |
| 0x004262c7..0x0042632d | the Dreadnought record offsets |
| 0x00429858..0x004298a8 | the model point |

Caveat: diffexec gives no independent coverage for `turret_op10`'s capture arithmetic, since
its 256 matches reached 9 of 59 blocks. That part rests on the disassembly alone.

---

## Not established

- What +0x23, the capture/kill stat words and the turret contact scripts change.
- The display name of the 0x2000000 key.
- Whether the AI captain's "flat" capture is used in single-player PA.
- How the HQ core and zone triggers are scripted (the triggers' Cfun bodies were not read).
- Which live animation frame sets the X1's radius in hover form (0.45–0.71 m bound).
- What route flag 0x0008 on the Dreadnought means.
