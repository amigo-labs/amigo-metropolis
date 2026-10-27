# FCop: LAPD player-vehicle rules, read from the decompiled code (for Metropolis)

RE tree: `/home/user/fcop-reverse-engineering` @ origin/main 7766374. Read-only.
Companion data file: `player-weapons.json` (same directory).

Confidence scale: **H** = read from the transcription and spot-checked against
the retail disassembly (`disasm.py` immediates quoted); **M** = read from the
transcription and/or derived by arithmetic I did myself, not spot-checked;
**L** = inference, and labelled as one.

---

## 0. Units: how the engine's numbers become SI

| quantity | engine | SI | evidence |
|---|---|---|---|
| time | 1 unit = 1/300 s (QPC scaled to 10000/3 µs) | — | `src/game/mission/clock.c` header, `frame_externs.c:8` (H) |
| frame | delta is 8 to 60 units per frame (30 fps is about 10) | — | `docs/behavior/camera-and-movement.md` "Units" (M) |
| movement step | the player tick turns delta into **eighths**: one movement step per 8 units, with the remainder carried in byte +0xb6 | 1 step = 8/300 s = **26.67 ms (37.5 steps/s)** | `player.c:1970-1978`, retail `and dl,7` 0x00446f15, `sar ebx,3` 0x00446f3e (H) |
| distance | world units (wu); **8192 wu = 1 terrain sample = 1 m in Metropolis** (TERRAIN_SAMPLE_SHIFT 13) | m = wu / 8192 | `src/include/fcop/terrain.h:17`, `surface.h:62` (H) |
| velocity (player) | 16.16 per **step**, and `position += velocity >> 8` every step | 1.0 (0x10000) = 256 wu/step = 9600 wu/s = **1.171875 m/s** | hover `sar edx,8 / add` 0x00442bd0..0x00442bf9; walker 0x00444853 (H) |
| angle | 4096 = 360° | 1 unit = 0.08789° | `math.h:52` (H) |
| sine/cosine | 16.16, 1.0 = 0x10000 | — | `math.h:62` (H) |

Two warnings about scale:

- **The mech is small in these units.** The X1-Alpha legs' bounding box tops
  out at y 0.738 glTF units (512 model units, × 16 = 8192 wu per glTF unit).
  The walker is therefore about **0.74 samples tall**, and the hover rides
  0.5 samples off the ground (`docs/formats/x1-alpha.md`). Every distance and
  speed below is in samples, called metres. If Metropolis's avatar is
  scaled differently against its 1 m cell, multiply every length and speed by
  that same ratio. The ratios between the numbers hold either way.
- **The physics runs in fixed 8-unit steps** (37.5 Hz). Metropolis ticks at
  30 Hz, so a per-step constant has to be converted, not copied. I give each
  drag as a continuous rate k (1/s), alongside its per-30 Hz-tick retention
  `(1 - d)^(37.5/30)`.

---

## 1. Respawn and going down in Precinct Assault (state word 23 == 1)

**Which mode PA is.** `frontend_apply_mode` writes mission-state word 23 =
`(mode == 0)`, and mode 0 is PRECINCT ASSAULT (`src/game/frontend/mode.c:62-66,96-100`). (H)

**Going down: operation 4, `player_op4`, retail 0x00447610** (`player.c:2601-2799`). (H)

1. `was_zero = (block->byte_de == 0)`, after which byte_de is cleared. byte_de
   is the walker's deep-water flag, see §4. If `cact_base_op4(self, 0, …)`
   answers 0 (already dying), nothing else happens.
2. Only when byte_de was 0 (an ordinary death): a wreck is launched, effects 3
   (mech) and 9 (partner) start in bank 1, and in PA script sound 0x41 plays.
3. `serial |= 0x800000` on both actors.
4. **In PA (word 23 == 1) the mech is restored, never retired.** In the
   campaign, word 23 is 0 and the handlers are swapped to inert ones (the
   retire arm).
5. **The countdown is block+0x318 = 0x4b0 (1200 units = 4.0 s) for an ordinary
   death, or 0x96 (150 units = 0.5 s) when byte_de was set** (drowned or sunk:
   the "does not count" path, which has no wreck and no effects). Retail spells
   it `and ebx,0x41a; add ebx,0x96` at 0x004476e3/0x004476e9. (H)
6. Flags 0xa5 go onto both actors (`mov ecx,0xa5` 0x004476da). **Bit 0x80
   refuses all damage** (`player_credit_amount`, `player.c:2985`), so the
   downed mech is invulnerable.
7. **Health is set to the maximum at once**, at the moment of going down:
   partner and mech both get `word_1e`.
8. `block->stamp` takes the frame clock once, and `block->downs++` counts the
   deaths. There is **no limit and no lives counter**: nothing reads `downs`
   to refuse a restore. (M: nothing in player.c reads it)

**Who gets credit.** `player_credit_amount` (`player.c:2979-3036`) stores the
attacker's serial in `word_8c` each time a hit takes health below 0, so the
**last** hit that went negative is the one credited. `player_op4` then works
out who that was:

- **One viewport** (solo PA against the AI commander): the credit counts only
  when the killer is the commander actor itself, `id & 0x3fff` equal to the
  opponent's id. In that case the commander's `score++` (+0x3c) and its
  rethink countdown is zeroed, so it re-plans at once.
- **Two viewports** (split-screen): the other team slot's block `score`
  (+0x14) goes up by one, but only if the killer is that other mech.
- A credit of 0 counts for nobody. Drowning uses 0, and so do self-inflicted
  falls, which credit the mech's own serial.

Confidence H for the code. What `score` does at the end of a PA match is
outside these files (L).

**While counting down** (`player_tick`, `player.c:1949-1966`): every frame
the countdown loses the frame delta. The whole live frame is skipped: no
input, no movement, no firing, no camera update. `player_partner_draw`
returns early while +0x318 > 0, so the mech is not drawn (`player_partner.c:286`).
At ≤ 0, the down flags (0xa5) come off both actors and `player_respawn` runs. (H)

**`player_respawn`, retail 0x004474a0** (`player.c:1787-1878`) restores: (H)

- **position = `block->placed`**, the construct's spawn point: the actor
  record's x/z with y snapped to `terrain_height_at(layer) + 0x200`
  (0x200 wu = 6 cm). That is the **same fixed spawn every time**: the
  mission's X1Alpha record for that team slot, and no spawn choice;
- facing = the record's spawn facing. **A negative value means spawn in hover
  form** (row = 1). In the shipped PA records, both Hk spawns are negative
  (−3072, −1024), so Hk starts and respawns in hover. Every other PA map starts
  in walker form. (H, read from the records with a scratch script);
- flags cleared, carrier NULL, transform direction 0, `player_reset` (all
  motion zeroed, form set by row);
- health = max, and the gauge with it;
- **all three magazines A refilled to their ceilings** (`cact_type99_ammo_add(slot, -1)`);
- **all block-B (powered-up) ammunition cleared** (`memset(ammo_b, 0)`): the
  power-ups are lost;
- the actor's `reloc[1]` mission script runs.

It does **not** clear the cloak timer (+0x324), the invulnerability timer
(+0x326), the weapon cooldowns or the lock. The tail of the tick keeps
counting +0x324 and +0x326 down during the countdown (`player.c:2112-2117`). (H)

> **Metropolis should use:** in PA, going down never ends anything. The mech
> respawns **4.0 s** after death (0.5 s after a drowning or sinking death) at
> its team's fixed spawn point, facing its spawn facing, in its spawn form. It
> comes back at full health with full normal ammunition, and its power-ups are
> lost. It cannot be damaged and is not drawn while down. There are no lives.
> The kill is credited to the opponent only when the opponent's own actor
> dealt the last hit that took health negative. Today `RESPAWN_TICKS = 240`
> (8 s @30 Hz); the original is **120 ticks @30 Hz**.

---

## 2. Transform walker ↔ hover

`player_transform_step`, retail 0x00442120 (`player.c:1394-1560`),
constants in `src/include/fcop/actor_player_transform.h:260-310`. (H)

- **Input: bits 0x00800000 *and* 0x02000000 held together** (`test ecx,0x800000`
  0x004421a3, `test ecx,0x2000000` 0x004421ab). 0x00800000 alone is the
  lock-cycle button: the latch at view+0x34, `view_place.c:613`, which
  `player_fire_buttons` uses to cycle the target. 0x02000000 alone is the
  movement "slow" modifier. So transform = lock-cycle + slow pressed together.
  The physical keys behind them are not named in the code.
- Refused when a ramp is already running, a view anchor is up, or the walker
  is sunk (byte_de). Refused **with a sound (script 0x2a)** while standing on
  surface material 1 (block byte_146: water; see §4).
- **Duration: progress 0 → 0x10000 at 160 per time unit = 409.6 units =
  1.365 s**, both directions (`lea edx,[eax+eax*4]; shl edx,5` 0x0044233b/
  0x00442344, clamp `cmp eax,0x10000` 0x00442349). The x1-alpha doc's
  "3 s" is the exported glTF clip's sampling (30 × 0.1 s), not the game's
  timing. `docs/behavior/camera-and-movement.md:195` repeats the 3 s and is
  wrong by this reading.
- **Locked while it runs:** the bits passed to the movement tick are cut to
  0x000c0000, which removes every movement, turn, jump and strafe bit
  (0x0044244c). The block's own button word keeps 0x054c0000, so **Gun
  (0x04000000), Heavy (0x00400000) and Special (0x01000000) can all still
  fire**, and the lock-cycle is dropped. The **hover tick runs for the whole
  ramp in both directions** (row = 1), so the mech coasts under hover physics
  with drag 0.05 per step (state 0, idle), and the ride height
  (`word_f2 = progress >> 4`, 0 to 0x1000 = 0.5 m) lerps with it.
- Out of hover the row stays 1 until progress reaches 0; then the walker tick
  takes over and the movement loop sound stops.

> **Metropolis should use:** transform duration **1.365 s = 41 ticks @30 Hz**
> (today 24). Movement input is locked, **weapons are not** (all three fire
> buttons keep working), and the hull coasts with hover drag during the ramp.
> The trigger is a chord of two buttons, not a dedicated key. That is a
> control choice and can stay a toggle.

---

## 3. Hover movement model (retail 0x00442510, `src/game/actor/player_hover.c`)

Each of the `eighths` steps runs the order below (all H; the immediates are
listed in `scratchpad/hover.asm`).

**Input → state** (`player_hover.c:96-148`). Without the slow bit (0x02000000)
the fast row applies: forward = state 3, back = 4, strafe = 7/8, and
0x08000000 = brake (state 0x13), which takes priority over everything. With
the slow bit: states 1, 2, 5, 6. Turn bits 0x20000000/0x10000000 are separate.
Forward or back with a strafe bit held becomes a **diagonal** at 181/256 ×
(√2 length), so the diagonal pushes no harder than straight ahead. The
analogue stick path is dead in retail (0x00416300 answers false), so all
input is digital.

**Push per step** (jump table at 0x00442e30; `mov ecx,…` at 0x00442850..0x00442884):

| state | push (16.16 / step) | steady speed = push / drag(0.05) |
|---|---|---|
| 3/4 fast fwd/back | ±0x6666 (0.4) | **9.38 m/s** |
| 1/2 slow fwd/back | ±0x3333 (0.2) | 4.69 m/s |
| 7/8 fast strafe | ±0x2000 (0.125) | 2.93 m/s |
| 5/6 slow strafe | ±0x1000 (0.0625) | 1.47 m/s |

**Drag** (fraction of the velocity removed per step, horizontal always and
vertical only with control):

| condition | d / step | continuous k | retention per 30 Hz tick |
|---|---|---|---|
| default, any input or idle < 0x700 units | 0x0ccc = 0.05 (0x004427b9) | 1.92 /s | 0.938 |
| brake (state 0x13, with control) | 0x2666 = 0.15 (0x004428a5) | 6.09 /s | 0.816 |
| facing snap pending (after a wall hit) | 0x6000 = 0.375 (0x004427d0) | 17.6 /s | 0.556 |
| idle ramp | idle timer +delta per frame in state 0, capped 0x800; above 0x700 (5.97 s) drag = 0.05 + (idle − 0x700)·21300/256/65536, reaching 0.375 at 0x800 (6.83 s) | | |

- Initial acceleration, fast forward: 0.4 units/step = **17.6 m/s²**. Time
  constant 0.52 s, 95 % of top speed after 1.56 s. Released, it coasts with a
  half-life of 0.36 s.
- **Stop:** in state 0, with control and not shoved, a velocity whose every
  component is below 0x2000 (0.146 m/s) is zeroed (0x00442b98).
- **Speed cap:** horizontal |v| ≤ 0x92147 (9.13 units) = **10.70 m/s**
  (`cmp eax,0x92147` 0x00442b1c). Flat-ground thrust alone tops out at
  9.38 m/s; the cap only binds on downhill slopes and impulses.
- **Turn rate:** rate word c2 goes up by the frame delta each step toward the
  pressed side (reset to 0 on reversal or release), clamped ±0x60
  (0x0044273f). Facing += c2 >> 1 per step, so the maximum is **48 units/step
  = 158.2°/s**, reached after about 0.27-0.32 s (about 10-12 steps at
  30-37.5 fps; the ramp is frame-rate dependent). While a wall snap is
  pending the shift is >> 3 (39.6°/s).
- **Gravity and lift:** gravity −0x9800 (0.59375 units/step) per step =
  **26.1 m/s²**, and terminal fall −12.0 units = **14.06 m/s** (`0xfff40000`
  0x00442ad5). Thrust = lift·0.59375 along the surface normal, where lift
  is the normal's y clamped to 0..1 and raised to a 0.15 floor. On flat
  ground it cancels gravity exactly.
- **Slope response:** where the normal's horizontal length t ≥ 0.25 (14.5°),
  a downhill push of 32·(t−0.25)³·lift·0.59375 is added per step
  (`cmp eax,0x4000` 0x0044296a, `shl eax,5`). The push is also projected
  onto the surface plane. **Climb limit (derived, M):** push ≥ thrust only
  while (t−0.25)³·cos ≤ 0.021 for the fast push, which is about **33°**, and
  about **29°** for the slow push. There is no hard slope gate in the hover
  tick.
- **Ride height:** **0x1000 wu = 0.5 m** above the surface (`word_f2`, set by
  the transform/reset, 0x00441b46). The surface is probed from 0xccc (0.4 m)
  above the position, and every step the hover is **snapped up** to
  surface+0.5 m. A rise of up to about 0.96 m within one step is simply
  climbed; anything higher is a wall, handled by the 8-segment contact push.
  Within 0xcc (2.5 cm) above ride height it is held down.
- **Ledges:** above that it goes airborne (flags_b9 bit 0, no control: no
  thrust, no push effect beyond drag, no turning brake). **In the slow
  fore/aft states (1, 2) the hover is held at a ledge**: put back and
  horizontal velocity zeroed when the drop is ≥ 0x333 (0.1 m). Fast states
  drive off.
- **Landing impact:** vertical speed > 0x50000 (5.86 m/s) gives state 0x12,
  and > 0x93333 (10.78 m/s) also gives damage (see §5). The first needs a fall
  of about 0.83 m, the second about 2.5 m.
- **Water:** the hover rides on water like any surface. Surface material 1
  sets byte_146 every step, and that **refuses the transform** (§2). A hover
  cannot sink: byte_de is set only in walker form (`player.c:796-806`).

> **Metropolis should use (hover):** top speed **9.4 m/s forward/back**
> (current value is 9). Strafe 2.9 m/s, slow modifier half of each.
> Horizontal drag k = 1.92/s (`v' = v + (a_push − 1.92 v)·dt`, a_push =
> 17.6 m/s² forward), brake k = 6.1/s, hard cap 10.7 m/s. After about 6 s with
> no input, drag ramps to 17.6/s; snap to zero below 0.15 m/s. Turn **158°/s**
> with about 0.3 s ramp-up. Ride height 0.5 m (current value 0.3, scale caveat
> §0). Gravity 26.1 m/s², terminal fall 14.1 m/s. The slope push starts at
> 14.5° and stops forward progress at about 29-33°; there is no hard gate.
> Hold at ledges only in slow mode.

---

## 4. Walker movement model (retail 0x00444100, `player_walk.c`; velocity 0x00444f40, `player_move.c`)

**Push per step** (jump table 0x00444eb0; `mov edi,…` 0x004445ec..0x0044465d,
H). The drag is **0.375 per step** on every axis (`-0x6000`, factored
multiply). Steady speed = push / 0.375:

| state | push | steady speed |
|---|---|---|
| 3/4 fast fwd/back | ±0x18000 (1.5) | **4.69 m/s** |
| 1/2 slow fwd/back | ±0xa000 (0.625) | 1.95 m/s |
| 7/8 fast strafe | ±0x10000 | 3.13 m/s |
| 5/6 slow strafe | ±0xa000 | 1.95 m/s |

- Acceleration: k = 17.6 /s, time constant 57 ms, 95 % after 0.17 s, so it
  is effectively instant (initial 66 m/s²). Retention per 30 Hz tick is
  0.556. Diagonals behave as in the hover.
- **Stop:** in the settle states (0, 9, 0x12) and not shoved, a velocity whose
  largest component is < 0x8000 (0.586 m/s) is zeroed (`cmp ecx,0x8000`
  0x00444825). A moving state with nothing commanded falls back to 0 on the
  ground.
- **Turn rate:** 0x20 units/step minus `speed84·0x20 >> 9`, with
  speed84 = |v| >> 11. That is **105.5°/s at rest, falling linearly to 0 at
  18.75 m/s; 79°/s at full 4.69 m/s run**. Formula: deg/s = 105.47 × (1 −
  v/18.75). There is no ramp, and no turning while airborne.
- **Gravity** is the same −0x9800 per step (26.1 m/s²), terminal 14.06 m/s.
  Airborne (or in states 0x0b, 0x0c, 0x0e, 0x10) the short path applies:
  **no thrust, horizontal drag 0x666 = 0.025 per step (k = 0.95 /s), no
  vertical drag.**
- **Jumps** (jump bit 0x08000000; H for the numbers, M for the simulated
  apex):
  - **Standing or walking (fast row, not running), ground probe ahead.** The
    ground 1 m ahead (sine >> 3) is probed from 8 m up. If it rises more than
    0xae1 (0.34 m), this is a **high jump**: state 0x0a crouches (leg track 4)
    until the track's launch flag, then 0x0b takes off with **v_y = 0x78000 =
    8.79 m/s**. The simulation gives an **apex of 1.37 m and 0.67 s in the
    air**. At the 9th airborne step (byte_c2 = 10 counting down, 0.24 s) a
    one-off **forward lunge of 0x1cccc = +2.11 m/s** is applied. The lunge is
    suppressed when the probe found a wall more than 0x2333 (1.1 m) higher.
    Otherwise this is a **hop**: state 0x0f, then 0x10 gives v_y = 0x58000 =
    6.45 m/s **plus a forward push of 4.0 units (+4.69 m/s)**. Apex 0.71 m,
    0.48 s, about 1.8 m forward.
  - **While running fast (state 3) → leap:** the third animation continuation
    (frames 2-5 and 0x12-0x1f pick track 0x37, others 0x36) leads to state
    0x0d. That gives v_y = 0x64000 = 7.32 m/s plus push 1.5 (+1.76 m/s) on top
    of the run. Apex 0.93 m, 0.56 s. It is refused on a steep slope.
  - **Slow modifier + jump = state 9, a crouch:** the bounding box is lowered
    (0x126 centre −0x5a), and the mech does not move.
  - Refused while the slope is steep (flag 0x40), or in states 3, 0x0d, 0x0e.
  - Bit 0 of block+0xdf (set only by a cheat, `cheat.c:196`) raises the lifts
    to 0xa0000, 0x85555 and 0x75555. Ignore it.
  - A ceiling at head height (0x24c0 = 1.15 m) while rising stops the rise and
    halves the horizontal velocity.
- **Max slope:** the surface counts as **steep when its normal's horizontal
  part > 0.625 (0xa000, 0x00444cdc), about 38.7°**. Steep ground disables
  jump, leap and ledge-hold. There is no hard slope wall. The thrust term
  pushes downhill as 40·(t−0.3)³·lift·0.59375 above t = 0.3 (17.5°). A
  derived limit (M): the fast push 1.5 stops climbing at about 49°, the slow
  push at about 38.6°. The ride `up` follows the normal by a quarter each step.
- **Step-up:** the surface probe starts 0xccc (0.4 m) above the feet and has
  +0x200 slack, so a rise of up to about 0.46 m per step is snapped onto. Within
  0x333 (0.1 m) above the surface the walker is held down. **States 1, 2 and
  5** (slow fwd/back and one slow strafe) hold at a ledge of 0.1 m or more.
- **Landing:** vertical speed > 0x50000 (5.86 m/s; 0x80000 = 9.38 m/s on leg
  tracks flagged "tough") gives state 0x12 (track 5, settle). Above 0x93333,
  impact damage (§5).
- **Water** (`player_order` code 1, `player.c:796-811`, and the tick, `player.c:1937-1947`):
  - On **HARD** (the slot's difficulty word == 0), in walker form: byte_de = 1
    and the invulnerability timer is cleared. **The walker sinks**: its ground
    becomes position − 0xc0 every step, so it sinks 0.0234 m a step, at 37.5
    steps a second **0.879 m/s**, and the vertical velocity is zeroed. Once the
    water surface is more than **0x3800 (1.75 m)** above it, the tick deals
    `health + 1` with no credit, which **drowns it after 75 steps, about
    2.0 s**. The respawn then takes 0.5 s, with no wreck and nobody credited.
    (Corrected in Metropolis, SIM_VERSION 72: this read 0.625 m/s and 2.8 s,
    0.0234 m multiplied by the step's 26.7 ms instead of divided by it. The
    RE's `camera-and-movement.md` "Water, for the walker" carries the same
    slip.) While the marker is set the button word keeps only Map and Camera
    (`PLAYER_FORM_BITS_KEEP` 0x000c0000, 0x0044245a) and no transform is asked
    for (0x004421c9): the sinking mech neither moves, fires nor transforms.
  - On **NORMAL/EASY**, in walker form: **an automatic transform to hover is
    requested** (byte_2fd = 1).
  - Either form: byte_146, so no transforming on water.
- **Other surface materials** (`PLAYER_ORDER_AMOUNT`, `player.c:712-724`) deal
  damage **per movement step**:
  - codes 6-15, walker: 16, 32, 16, 32, 10000, 10000, 8, 16, 1, 1;
  - codes 6-15, hover: 16, 32, 8, 16, 8, 16, 0, 0, 1, 1;
  - code 2: 10000 (a kill surface);
  - codes 3, 4, 5 set a one-step "mode" 2, 1, 3. In the walker it scales the
    push by 5·mode/128, the thrust by 1+(4−mode)/4, and the drag to
    −768·(4−mode). These read as slippery or conveyor surfaces. **L:** which
    shipped surfaces carry them was not established.

> **Metropolis should use (walker):** **4.69 m/s** fwd/back (current value 5),
> strafe 3.1 m/s, effectively instant acceleration (k = 17.6/s). Stop below
> 0.59 m/s. Turn **105°·(1 − v/18.75 m/s)**. Jump v_y **8.8 m/s against
> 26.1 m/s²** (apex 1.37 m, 0.67 s), with a +2.1 m/s forward lunge at 0.24 s.
> Today it is 8 m/s against 20 m/s², apex 1.6 m. **Note the apex is lower
> than Metropolis's 1.4 m ledge assumption.** The original walker clears
> about 1.37 m in the high jump, and only when the step was about 0.34 m or
> more higher 1 m ahead. A running "leap" gives 0.93 m, a "hop" 0.71 m.
> Airborne horizontal drag k = 0.95/s and no air control. Steep above 38.7°
> (normal tilt 0.625). Deep water on HARD sinks at 0.88 m/s and drowns at
> 1.75 m depth (2.0 s); on NORMAL/EASY the walker auto-transforms to hover.

---

## 5. Health

- **Base health in PA = 1000.** It is the u16 at record +20 (base-entity
  health) of every PA X1Alpha record: Conft, Hk, Joke, Mp, Ovmp, Slim, both
  slots. The campaign records have 5000. (H, dumped with
  `scratchpad/x1rec.py`)
- **Per-difficulty scaling** (`player_construct`, `player.c:1094-1118`;
  `imul ecx,ecx,0x64` 0x00446c3c, row-3 `0x31ff9c` 0x00446c44, clamp 0x7fff
  0x00446c61). (H) Row 3 means infinite ammo and no damage, a cheat or debug
  row.

  | difficulty word (2 for slot 0, 0x26 for slot 1) | max health |
  |---|---|
  | 0 HARD | 1000 |
  | 1 NORMAL (the default) | 1250 |
  | 2 EASY | 1500 |
  | 3 | 32767 |

  The words come from the per-player HARD/NORMAL/EASY pick: `launch.c:258-259`
  and `config.c:76`, where the default is NORMAL.
- **The ×3/2** is applied when `ms[3] == 2 && ms[23] == 0`, that is two
  viewports *and* not PA (two-player co-op campaign). **It never applies in
  PA.** (H)
- **No regeneration:** nothing in the player tick increases health. Health
  only comes back through pickups (§6) and the restore at going down. (M: the
  whole tick and its callees were read)
- **No damage sharing in PA:** `player_credit_amount` hands damage to the
  other slot only when two viewports are up and word 23 == 0. In PA word 23
  also halves the HUD shake "share", which is not damage. (H)
- **Impact (landing) damage** (`player_impact_damage`, retail 0x004438e0;
  `cmp eax,0x93333` 0x004438e7, `0x300000` clamp, `0x9cc4`, `0xddb3`, H):
  - the vertical landing speed v is taken. At or below **10.78 m/s** there is
    no damage, and v is clamped at 56.25 m/s;
  - x = (v − 10.78 m/s) × 0.3048, quantised;
  - f(x) = 0.6124·x for x ≤ 0.5, 0.8660·x^1.5 for x ≤ 0.75, x² above that;
  - damage = maxHealth·f(x)·100 / {100, 125, 150}[difficulty], which equals
    **1000·f(x) in absolute HP on every difficulty**.
  - Sample values: 11 m/s gives 40 HP, 12 m/s gives 227, 13 m/s gives 481,
    14 m/s gives 961, and the terminal 14.06 m/s gives about 1000. So a free
    fall of about 3.8 m or more is lethal on HARD and leaves 250/500 HP on
    NORMAL/EASY. It is credited to the mech itself, which counts as nobody.
- Invulnerability: block+0x326 > 0 refuses all damage (`player.c:2913-2915`).
  Flag 0x80 refuses damage while down, and difficulty row 3 refuses it as well.

> **Metropolis should use:** **avatar HP 1250** if it models the default
> NORMAL difficulty, or 1000 for HARD/"tournament". Today it is 300, so all
> weapon damage below has to be rescaled by the same factor if 300 is kept.
> There is no regeneration. Fall damage is `1000·f((v−10.8)·0.305)` above a
> 10.8 m/s landing speed.

---

## 6. Pickups (`pickup.c`, grant retail 0x0041e950)

**What exists in PA.** Every PA pickup is a **Csac-spawned ItemPickup (type 16)**
with grant flags DIRECT (0x1000000) | CONSUMED (0x2000000) plus exactly one
effect bit:

| bit | effect (box touch passes amount −1 = "fill") | in PA |
|---|---|---|
| 0x01/0x02/0x04 | **Gun/Heavy/Special ammo A refilled to its ceiling** (`cact_type99_ammo_add(slot, -1)` → block A +0x04 cap × difficulty 1/1.25/1.5) | one each per map |
| 0x10/0x20/0x40 | **Power-up of that slot**: ammo_b = block B ceiling × difficulty. When B was empty, the slot also switches to block B (burst counter from B, the projectile models swapped). The slot fires **block B (the "powered" stats in player-weapons.json) until ammo_b runs out**, then reverts to A | 1-2 each per map |
| 0x20000 | **Health refilled to maximum** (direct, amount −1 = fill) | one per map |
| 0x40000 | **Cloak: block+0x324 = 0x34bc = 13500 units = 45.0 s.** In split-screen the mech and partner are hidden from the other player's view (`mission_frame.c:1706-1725`), and the mech's texture scrolls (shimmer, `player_partner.c:290`). The AI commander's target search skips the mech (dispatch.c 0x00421910), and **a missile within 0x8000 (4 m) of it disarms**, dropping its homing (missile 0x0042379f). | 1-2 per map |
| 0x80000 | **Invulnerability: block+0x326 = 0x1770 = 6000 units = 20.0 s.** Damage is refused and the HUD gauge blinks; the AI also skips the mech | **not used by any PA pickup** (it exists in the campaign) |

There is no damage or power multiplier pickup. The "power" in FCop is the
B-block weapon upgrade, a different weapon stat block with its own ammo.
**Metropolis's `power ×2 for 450 ticks` has no counterpart.** The B blocks
are per-weapon redesigns (for example Mini-Gun B: 2 dmg plus a 1 m splash,
600 rounds; Hell Fire B: splitting missile, 15 rounds). (H for the flags and
timers; the census is from my dump of every PA type-16 record)

**Pickup box:** collected when the mech's position is strictly inside the
pickup's half-extents × 16 on all three axes (`cact_pickup_box_touch`). Only
type 1 (the mech), or its partner standing in for it, can collect. In PA only
the collector benefits: health is shared only in two-viewport non-PA. (H)

**Respawn of pickups** (`spawn.c` csac_load/csac_tick, M). Each pickup has its
own Csac spawner with a limit of 1 alive at a time:

- period = `(tSAC word × 5)` time units;
- the shipped words are −3000 (ammo A ×3 and health), giving 15000 units =
  **50 s**, and −6000 (power-ups and cloak), giving 30000 units = **100 s**;
- the countdown only runs while none is alive (`live < limit` gate), so
  **a pickup reappears 50 s / 100 s after it was taken**;
- a negative word makes the loader start the countdown at the full period
  (`spawn.c:158-161`). The loader comment calls that "fired at once", which
  disagrees with the code. If no mission script requests a spawn earlier,
  the first appearance is 50 s / 100 s into the match (**L** on that).

> **Metropolis should use:** health pickup = **full heal**, not +100. Ammo
> pickups refill one slot's normal magazine to its cap. The power-up is a
> per-slot weapon upgrade (block B) with its own magazine, which is lost on
> death. Cloak lasts 45 s: AI and turret targeting ignore the mech and
> homing missiles near it disarm. Invulnerability (20 s) exists in the engine
> but is not placed in PA. Pickups respawn 50 s (ammo, health) or 100 s
> (power, cloak) after collection, one alive per spawner. Today Metropolis
> has invuln/invis at 300 ticks (10 s) and power ×2: the original timers are
> **cloak 1350 ticks @30 Hz** and **invuln 600 ticks**.

---

## 7. Weapons (full per-block data in `player-weapons.json`)

**Where the table is: in the mission data, not the exe.** Each mission
container carries 15 **type-99 Cact records** whose 0x44-byte bodies are
`{key, key>>4, 0, 0, stats A[0x20], stats B[0x20]}`. The keys are exactly the
loadout codes `{0,1,2,3,5} {0x10,0x12..0x15} {0x20..0x24}`, and the blocks are
**byte-identical in all 15 missions**, including the 6 PA maps (verified for
Conft/Hk/Joke/Mp/Ovmp/Slim/M1a1). The loader is 0x00458c60, with the rescale
helpers 0x00458d30 and 0x0044eb10 (`prepare.c:335-438`). The exe holds only
the id→name string table (`docs/findings/weapon_table.md`). (H)

**Stat block fields** (`actor_block.h:228`, `actor_discharge.h:334`):

| offset | meaning |
|---|---|
| +0 | weapon kind |
| +1 | flags (1 = 0x80000 on round, 2 = damage falloff with flight distance, 4 = kept round / detonate on 2nd press, 8 = spin) |
| +2 | starting ammo |
| +4 | ammo cap |
| +6 | rounds per burst |
| +8 | burst gap |
| +0xa | round gap; gaps in raw × 4096/218 time units (≈ raw × 0.0626 s) |
| +0xc | damage |
| +0xe | blast radius (× 16 wu = raw/512 m); for hitscan it is the lock scatter in wu |
| +0x10 | mine trigger / sphere reach |
| +0x12 | speed (raw/300; × 16 = wu per 1/300 s, which is about raw/512 m/s) |
| +0x14 | acceleration (raw × 256/300; +delta·acc/16 per unit) |
| +0x16 | range (× 16 wu = raw/512 m), which **for arced and bouncing rounds is gravity in wu/s² instead** (type7.h:50) |
| +0x18 | fuse/lifetime (raw × 4096/218 units) |
| +0x1a | impact fx |
| +0x1b | launch fx |
| +0x1c | sound |
| +0x1f | hit message kind |

Starting ammo and cap are scaled by difficulty: ×1, ×1.25, ×1.5.

**Fire rules** (`player_fire.c:740-888`, H):

- **Gun (0x04000000) and Heavy (0x00400000) fire every frame they are held**,
  limited by a per-slot cooldown that decays by the frame delta. Gaps are
  **added** to the cooldown, so a negative round gap carries over.
- **Special (0x01000000)** is held-fire too, *unless* any loadout slot's
  block A has flag 4 (Plasma Flare, Grenade). Then it is press-edge, and a
  second press while the kept round is alive **detonates** every live round
  of that class.
- **A gap of 0 means one shot per frame**, so 30-37.5 shots/s. Frame-rate
  bound!
- When the ammo about to be spent is exactly 5, a low-ammo warning (script
  0x0e) plays. With none left, an empty click (0x0d).
- **Hitscan guns (Mini-Gun, Gatling Laser, Electric, and the Flamethrower's
  aim) only damage the LOCKED target.** With no lock the line goes `range`
  ahead and does nothing, except a B block with a blast, which area-damages
  at the line's end. With a lock the end point is a random point on a sphere
  of radius (+0xe or target half-height/2) around the target, on the muzzle
  side, so the hit is guaranteed unless terrain blocks the line.
  `player_fire_direct` 0x004598f9..0x00459991.
- **Lock:**
  - range **0x18000 = 12 m** horizontal;
  - acquire cone cos 0xf9ee is **±12.5°**, hold cone cos 0xe804 is **±25°**;
  - auto-acquire every frame while there is no lock;
  - lock-cycle on a press of 0x00800000 (`player.c:1226-1310`).
- **Projectiles:**
  - missiles fly along the heading without a lock; kinds 3, 0x12, 0x13 and
    0x15 home on the lock;
  - **arced and bouncing rounds aim at the lock, or with no lock at a point
    0x10000 wu = 8 m ahead at muzzle height**;
  - if the target is out of ballistic reach the round is fired at the boundary
    elevation and falls short;
  - blasts are linear-falloff area damage over **horizontal** distance:
    dmg·(r−d)/r (`damage.c:209-218`).
- Heavy-slot fire kicks the gun back with a recoil animation.

**The PA catalogue.** All 15 weapons. A = the normal block; B = after the
slot's power-up pickup. HARD ammo shown; ×1.25 on NORMAL.

| code | UI name | A: dmg / refire / ammo / ballistics | B (powered) |
|---|---|---|---|
| 0x00 | Powered Mini-Gun | hitscan, 1 dmg every frame (≈30/s), 6000 rds, 12 m | 2 dmg every frame + 1 m splash, 600 rds |
| 0x01 | Gatling Laser | hitscan, 1 dmg every frame, 5000 rds, 12 m (green tracer) | 2 dmg + 1 m splash, 600 rds (red tracer) |
| 0x02 | Flamethrower | sustained fire, 6 dmg per node, every frame, 3000 | 10 dmg, 1 shot per 0.06 s, 600 |
| 0x03 | Electric Gun | hitscan link, 3 dmg every 0.06 s (2 frames), 3000 rds, 9.6 m | 6 dmg, arcs to 2 more targets, 500 rds |
| 0x05 | Riot Shield | toggle sphere r = 1.6 m, 20 dmg, ammo 600 spent every 0.06 s while up | r = 2.4 m, 40 dmg, 300 |
| 0x10 | Hell Fire 2000 | homing missile, 25 dmg, 1 per 0.50 s, 145 rds, launch 2.0 m/s → top 15.8 m/s (accel 71 m/s²), 16 m, no blast | splitting missile (×3), 25 dmg, 1/0.75 s, 15 |
| 0x12 | Concussion Beam | aimed sustained beam, 50 dmg, 1 m radius, 8 m, 1 per 1.0 s, 75 | 100 dmg, 2 m, 16 m, 15 |
| 0x13 | Hyper Velocity Rocket | lead-aimed missile (straight without lock), 30 dmg, **burst of 4 on 4 consecutive frames, then 1.13 s** (round gap −37 units carries into the 450-unit burst gap), 120 rds, 2.5 → 19.9 m/s (23 m/s²), 16 m | burst of 8, spinning, then 1.08 s, 80 |
| 0x14 | Fusion Torpedo | homing torpedo, 100 dmg, 1 m blast with **damage falloff over the distance flown**, 1 per 1.0 s, 40, 1.5 → 11.7 m/s (13.7 m/s²), 16 m | 150 dmg, 2 m blast, 10 |
| 0x15 | K-9 Drone | ground-hugging homing missile (health 2×dmg), 150 dmg, 1 per 3.0 s, 25, 0.6 → 4.7 m/s, 16 m | burst of 3, 200 dmg, 4.0 s, 18 |
| 0x20 | Mortar Launcher | arced shell, 200 dmg, 3.2 m blast, 1 per 2.0 s, 25, launch 7.6 m/s, g = 6.0 m/s², max reach about 9.7 m | bursts into 4 at apex (one per quadrant, up to 2 m/s off the shell; the shell flies on and goes off too: `cact_round_advance` 0x00423e40), 100 dmg each, 4 m, 1/1.0 s, 10 |
| 0x21 | Plasma Flare | arced, kept round (press-to-fire, 2nd press detonates), 250 dmg, 6 m blast, 1 per 2.0 s, 30, 7.6 m/s, g = 5.2, reach about 11.2 m | bursts into 4, 200 dmg, 6 m, 1/3.0 s, 15 |
| 0x22 | Pop-Up Mines | dropped mine, 600 dmg, **5.6 m blast**, 1 per 1.0 s, 30. Falls from the muzzle under a fixed 8 m/s² (the spawner's, not the record's), bounces, and explodes the tick it comes to rest (RE M3-OP). A proximity trigger of 2 m + target half-extent springs it first: flung down, it pops up and explodes 1.0 s later. Lifetime field 5.0 s, not reached on open ground | 1000 dmg, 8 m blast, 15 |
| 0x23 | Shockwave Generator | self-centred sustained effect, 300 dmg, 6 m, 1 per 3.0 s, 20 | 300 dmg, 8 m, 1/1.0 s, 10 |
| 0x24 | Grenade Launcher | ballistic-solved bouncing grenade (bounces 5/8 vertical, 7/8 horizontal), kept round, 400 dmg, 4.2 m blast, 1/1.0 s, 30, 7.6 m/s, g = 8.0 m/s², reach about 7.3 m, fuse 3.0-4.5 s random | burst of 2, 600 dmg, 16 |

Defaults (`config.c:80` and `mode.c`): loadout = 0x00 / 0x10 / 0x20, which is
Powered Mini-Gun / Hell Fire 2000 / Mortar Launcher, and that matches
Metropolis.

> **Metropolis should use:** the table above, with ranges, speeds and ammo
> taken from the data instead of invented. In particular:
> - hitscan guns hurt only the locked target, the lock range is 12 m with a
>   ±12.5° acquire cone, and guns fire every frame;
> - missiles are slow-launched and accelerate to 12-20 m/s;
> - the mortar's reach is about 10 m, and arced rounds aim 8 m ahead with no
>   lock;
> - blasts fall off linearly over horizontal distance;
> - damage is absolute HP against a 1000/1250 HP mech. The Mini-Gun's
>   ≈30 dps against 1250 HP is a ≈40 s kill, and the Mortar's 200 is 16 % of
>   a NORMAL mech.
>
> Rate of fire for gap-0 guns has to be pinned to a fixed rate (the original
> is frame-bound; use 30/s at 30 Hz).

---

## 8. diffexec (the executed oracle), 256 cases per function

| file | function | result | agreed | blocks reached |
|---|---|---|---|---|
| player_move.c | 0x00444f00 player_bounds_pair | diff | 0/256 | 1/1 |
| | 0x00444f40 player_velocity_delta | diff | 0/384 | 31/31 |
| player_hover.c | 0x00442510 player_hover_tick | diff | 0/512 | 129/133 |
| player_walk.c | 0x00444100 player_walk_tick | diff | 0/256 | 43/47 |
| player_transform.c | 0x00441ab0 player_reset | diff | 0/256 | 3/4 |
| | 0x00441c40 player_shape_bind | diff | 0/256 | 1/1 |
| | 0x00441cf0 player_transform_shape | skip (C passes 2 dwords, retail 4) | | |
| player_fire.c | 0x004452a0 player_fire_buttons | diff | 4/384 | 6/10 |
| | 0x00458ed0 player_fire_slot | diff, suspect | 275/512 | 27/43 |
| | 0x004590d0 player_fire_launch | diff, suspect | 262/768 | 48/60 |
| | 0x004595e0 player_fire_direct | diff, suspect (helper effect.c does not build for i386) | 0/384 | 49/72 |
| pickup.c | 0x0041e470 cact_handler_type16 | diff | 27/256 | 12/16 |
| | 0x0041e6e0 cact_pickup_construct | diff | 152/384 | 20/23 |
| | 0x0041e8a0 cact_pickup_box_touch | match (al-only) | 256 | 3/9 |
| | 0x0041e950 cact_pickup_grant | diff, suspect | 68/256 | 13/40 |
| | 0x0041eb10 cact_pickup_sky_touch | diff | 179/256 | 14/14 |

**The non-suspect diffs are layout artefacts, not misreadings.** I checked this
by compiling the headers `-m32 -ffreestanding` as diffexec does. In the
rebuild's i386 layout, `player_actor::block` is at **0x118** (retail 0xac),
`cact_instance::position` at **0x14** (retail 0x50), and `cact_view::ride` at
**0xf0** (retail 0xec). The rebuild uses "named views", not byte images
(`actor.h`, `player.c` comments), so every case where retail and the C walk
the same arena pointer reads different words. The report shows exactly that:

- for `player_hover_tick`, retail calls 0x00443fe0 with 0x76 where the C
  passes an arena pointer;
- in `player_bounds_pair`, retail writes through `[[p+0xac]+0x2dc]+8` while
  the C faults reading 0x2e1;
- in `cact_pickup_construct`, the arena words written differ in offset only.

So diffexec **cannot validate** these files today, and none of the numbers above
rests on it. They rest on the transcription plus the retail immediates I
spot-checked in `disasm.py` / range disassembly:

- hover: 0xccc, 0x2666, 0x6000, 0x3333, 0x6666, 0x1000, 0x2000, 0x60,
  0x700, 0x800, 0x4000, 0xd999, 0x9800, 0xfff40000, 0x92147, 0x50000, 0xcc,
  0x333, `sar 8` integrate;
- walker: 0x18000, 0xa000, 0x40000, 0x58000, 0x64000, 0x78000, 0x1cccc,
  0xae1, 0x2333, 0x24c0, 0xc0, 0x8000, 0x50000, 0x333, 0xa000;
- respawn: 0x41a/0x96, 0xa5;
- tick: `and dl,7`, `sar ebx,3`, 0x3800;
- transform: ×160 and 0x10000;
- impact: 0x93333, 0x300000, 0x9cc4, 0xddb3;
- health: ×0x64, 0x31ff9c, 0x7fff, +0x200.

No diff touches a constant. Fixing this needs a retail-offset layout for
`player_actor`/`cact_view` in the diffexec runtime, which is a repo task and
not done here. Reports: `scratchpad/diffexec-*.json`.

---

## 9. Could not establish

1. ~~How the sustained weapons apply damage over time~~ — answered by RE M3-OR
   (fcop-fidelity.md W1, modelled in SIM_VERSION 105, `sim/src/sustain.ts`): the
   flame's trail nodes (one every 2 frames at 30 fps, each hurting each body it
   reaches once -- the lock twice, asked as the target and again in the registry
   walk, 0x0044b2fc / 0x0044b3b1), the beam once per body per shot along
   its segment, the shockwave an expanding shell blasting every fourth frame with
   falloff from its current outer radius; the Riot Shield's is W5's.
2. ~~**Mine lifetime semantics.**~~ **Settled (RE M3-OP):** nothing suppresses
   the rest-expiry. The tick sets health 0xffff the moment the round settles
   (0x00424606), whatever its fuse radius, and the expiry pass blows it there:
   an untriggered mine explodes where it comes to rest, a second or so after
   the drop, and never waits for its 5.0 s lifetime.
3. **Missile homing turn rate** (`missile_home`) and the HVR lead details.
   Speeds and accelerations are given; the steering rate is not.
4. ~~The six-entry type-99 table~~ — answered by RE M3-OR: each type-99
   record's resource header gates its load on state words 10..15 (the two
   players' gun / heavy / special codes), so the six slots hold exactly the
   two loadouts.
5. **Names of the input bits.** Which keys or pad buttons map to 0x02000000
   (slow), 0x08000000 (jump/brake), 0x00800000 (lock-cycle) and so on is not
   in the code.
6. **The jump crouch time**: how long state 0x0a / 0x0f plays leg track 4 /
   0x11 before the launch flag. That is animation data (AnmD), not read here.
7. **The first appearance of pickups** at match start (50/100 s by the
   loader's arithmetic, unless a PA script requests spawns), and **what the
   kill `score` does** in PA scoring or win logic.
8. **Exact hover/walker slope limits.** No hard gate exists, and the angles
   in §3/§4 are my own steady-state derivation (M).
9. Whether the **frame delta is fixed in networked PA** (lockstep). If it is
   not 8-10, the gap-0 gun rate and the hover turn-ramp change.
10. What hit-message kind 8 (Electric Gun, Riot Shield) does to the target's
    byte +0x19. Kind 0x10 would be a 2 s input stun (block+0x31a = 0x258),
    but no PA weapon's decompiled path sends it.
