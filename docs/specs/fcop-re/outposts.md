# Outposts, shared turret plates and the Sky Captain's turret count (FC:LAPD Precinct Assault)

RE tree `/home/user/fcop-reverse-engineering` (branch ccr-d7d804ff-sfewe6). Disassembly: `tools/re/disasm.py` on
`fixtures/FCopLAPD.exe`. Records: decoded from `fixtures/missions/<Map>` (tACT/tSAC bytes). Positions: actors.json
values, already in metres, in the extract_logic frame (runtime position[2] = x, position[0] = z). **Metropolis x = x + 16**
(`LOGIC_OFFSET_X`), z unchanged. Scripts were decoded with this scratchpad's `cdec.py`, `rpns.py` and `shdr2.py`
(`<Map>.dec.txt`, `<Map>.rpns.txt`, `<Map>.shdr2.txt`). Per-map extraction: `outposts.py` → `outposts_raw.json`, and
`build_outposts.py` → `outposts.json`.

Confidence: **[A]** read in the retail disassembly *and* the data/C. **[B]** read in the decompiled C or the decoded script
data, consistent but not checked at every VA. **[C]** inference.

Cfun notation: `spawn_actor(c, b, a)` is opcode 0x3c, which is `cfun_spawn_actor(template c, command b, flag a)`
(`src/game/cfun/spawner.c`; retail 0x0044f270 → 0x0044f2c0). The commands are b = 71 (0x47, **request one spawn**), b = 70
with a = 1 (0x46, **open**: clears shut bit 0 and zeroes the phase, so it spawns on the next spawner tick) and b = 70 with
a = 0 (0x46, **shut**: sets bit 0). `entity_38(c, b, a)` posts order b with parameter a to every live actor whose id is c
(`cfun_entity_set3`, 0x0043b3a0). The orders used are 0x3d DIE (`cact_kill`; retail drain 0x0043a980), 0x3c "op 0x0e"
(damage the prop by HP+1), 0x7a ENABLE on a type-14 zone (0x0041f79c; it runs the zone's reloc[2] script when mode bit
0x20 is set, 0x0041f7d1) and 0x4c, the radar colour on the objective node group. `entity_39(g, b, a)` is the same, but
for group byte_17 == g.

---------------------------------------------------------------------------------------------------------------------
## TL;DR

1. **The shared plates are the 8 outpost turret plates (4 outposts × 2 plates) on every PA map.** Each plate holds
   three stacked records: a **type-36 neutral turret** (spawner open, requested at match start, so **live at start**),
   a **team-1 type-8** and a **team-2 type-8** (both spawners **shut at load**, so **neither is live at start**). When a
   side claims the outpost, its script kills the plate's neutral turret (order 0x3d), shuts the neutral's spawner and
   opens **its own** type-8 spawner. The turret spawns on the next tick and respawns 25 s after each death, permanently.
   The other side's type-8 record on that plate is never used again. The base plates (8 per side on Mp/Conft/Ovmp, 6
   on Slim/Joke/Hk) hold one type-8 record each, which is live from t ≈ 0. [A] for the spawner mechanics, [B] for the
   scripts.
2. **The captain's count is 2 × (own live type-8 turrets), not 1 ×.** Every type-8 turret is *two* type-8 actors in
   the live list: the turret, plus its base part (part_b). `turret_construct` builds the part with `cact_create` from
   the **same tACT record**, so the part's type byte is 8 and its team byte is the record's. The scan
   (0x00421b70..0x00421b83) counts every live actor with type 8, team == the captain's and octagonal distance from home
   < 256 m. **At match start the count is 16 on Mp/Conft/Ovmp and 12 on Slim/Joke/Hk, which is ≥ 10. There is no
   deadlock.** Once its base turrets exist, the captain drops from defend (mode 2) to roaming (mode 0) unless an enemy
   tank is within 64 m of home or an enemy Dreadnought within 72 m. It claims outposts in mode 0 or 1 once its budget
   reaches 30. [A]
3. The outpost claim **does not shut the enemy's turret spawners**. It shuts the **neutral** turrets' spawners. The
   enemy's were never open. The claim zone and the outpost pads are type-14 zones with op-10 gate bit 0x04, so a mech
   claims by **pressing the action key while touching the zone**, not by driving in. [B]

---------------------------------------------------------------------------------------------------------------------
## Q1. What the shared-plate type-8 records are

### Load state of every turret spawner (all six maps; tSAC +0x0c.. decoded)

| group | tSAC period | flags bit 0 (shut) | enable (+0x12) | limit | started by |
|---|---|---|---|---|---|
| base type 8 (team 1 and team 2) | −2250 → **37.5 s** | **0 (open)** | −1 (unlimited) | 1 | **request 0x47** from mission fn27 at t ≈ 0 |
| outpost type 8 (team 1 and team 2) | −1500 → **25 s** | **1 (shut)** | −1 | 1 | nothing. Opened only by its side's claim script |
| type 36 neutral (incl. the 8 outpost-plate neutrals) | −1500 → **25 s** | 0 (open) | −1 | 1 | **group request** `spawn_neutrals(50, 0x47, 0)` from fn29 at t ≈ 0 |

* **Start-up functions** [B]: the slot-0 X1's resource-header script (`Cact12`, in `<Map>.shdr2.txt`) zeroes the timers
  that gate three run-once mission functions. These are fn27 (`T[3]==0` on Mp/Conft/Hk/Ovmp, `T[5]==0` on
  Slim/Joke), which **requests every base turret** (16 ids on the 8-turret maps, 12 on Slim/Joke), fn28 (pickups) and fn29
  (`spawn_neutrals(c=50, b=71)`, every neutral turret, group byte 50). Each has a 25-tick period with a random phase, so
  it runs within the first 0.083 s (`cfun_tick` 0x00436be0, `cfun_load` phase rule). A request is accepted when
  live < limit and enable ≠ 0 (0x0044f2d4..0x0044f2e3). `csac_tick` (0x0044f3b0) then spawns the requested nibble
  regardless of the shut bit. **No function requests or opens an outpost type-8 spawner at load**, and their shut bit
  stops the timer (0x0044f427). [A] spawner, [B] scripts.
* **Spawner semantics** [A]: 0x0044f2c0 open arm 0x0044f32a..0x0044f344. It acts only if bit 0 is set, then clears it
  and zeroes the phase, so the spawn comes on the next `csac_tick`. The shut arm is at 0x0044f34a (`or byte [eax+0x10], 1`).
  After a spawn the phase is the full period, and it counts down only while live < limit. So the respawn comes **one
  period after death**: 25 s for outpost and neutral turrets, 37.5 s for base turrets.

### Per-plate tables (outpost plates; generated, full data in outposts.json)

Every outpost plate on every map has **neutral t36 live at start; team-1 t8 shut; team-2 t8 shut**. Csac ids are
identical on all six maps because the PA missions were cloned. Only the positions differ.

#### Mp

Captain home (record 287): (96.062, 66.812); farthest own type-8 plate 74.5 m (octagonal) < 256 m. Base plates: 8 team 1 + 8 team 2, each one type-8 record, open, live at start (fn27 request), respawn 37.5 s. Neutral-only plates: 24.

| outpost (owner word) | claim zone Cact (x, z) | plate (x, z) [Metropolis x] | neutral t36 (live at start) | team-1 t8 (shut) | team-2 t8 (shut) | slot-0 pads tank/jet | slot-1 pads tank/jet |
|---|---|---|---|---|---|---|---|
| 0 (W40) | 152 (116.5, 96.125) | (113.438, 91.625) [129.44] | Csac113 | Csac157 | Csac85 | 150/151 | 149/153 |
|  |  | (113.438, 100.562) [129.44] | Csac119 | Csac158 | Csac162 |  |  |
| 1 (W41) | 169 (75.689, 96.0) | (78.626, 100.625) [94.63] | Csac267 | Csac182 | Csac184 | 166/167 | 170/171 |
|  |  | (78.749, 91.562) [94.75] | Csac265 | Csac176 | Csac180 |  |  |
| 2 (W42) | 191 (75.627, 128.062) | (78.563, 123.562) [94.56] | Csac271 | Csac199 | Csac198 | 188/189 | 192/193 |
|  |  | (78.563, 132.562) [94.56] | Csac274 | Csac203 | Csac202 |  |  |
| 3 (W43) | 213 (116.438, 128.125) | (113.5, 123.5) [129.5] | Csac279 | Csac217 | Csac220 | 210/211 | 214/215 |
|  |  | (113.563, 132.562) [129.56] | Csac277 | Csac45 | Csac224 |  |  |

#### Conft

Captain home (record 287): (104.187, 179.562); farthest own type-8 plate 110.0 m (octagonal) < 256 m. Base plates: 8 team 1 + 8 team 2, each one type-8 record, open, live at start (fn27 request), respawn 37.5 s. Neutral-only plates: 24.

| outpost (owner word) | claim zone Cact (x, z) | plate (x, z) [Metropolis x] | neutral t36 (live at start) | team-1 t8 (shut) | team-2 t8 (shut) | slot-0 pads tank/jet | slot-1 pads tank/jet |
|---|---|---|---|---|---|---|---|
| 0 (W40) | 152 (137.937, 91.0) | (131.438, 92.562) [147.44] | Csac119 | Csac158 | Csac162 | 150/151 | 149/153 |
|  |  | (131.563, 83.5) [147.56] | Csac113 | Csac157 | Csac85 |  |  |
| 1 (W41) | 169 (70.252, 85.062) | (76.501, 92.562) [92.5] | Csac267 | Csac182 | Csac184 | 166/167 | 170/171 |
|  |  | (76.562, 83.375) [92.56] | Csac265 | Csac176 | Csac180 |  |  |
| 2 (W42) | 191 (70.314, 149.0) | (76.438, 156.688) [92.44] | Csac274 | Csac203 | Csac202 | 188/189 | 192/193 |
|  |  | (76.501, 147.5) [92.5] | Csac271 | Csac199 | Csac198 |  |  |
| 3 (W43) | 213 (137.875, 155.062) | (131.501, 156.562) [147.5] | Csac277 | Csac45 | Csac224 | 210/211 | 214/215 |
|  |  | (131.625, 147.562) [147.62] | Csac279 | Csac217 | Csac220 |  |  |

#### Slim

Captain home (record 164): (120.0, 174.938); farthest own type-8 plate 96.1 m (octagonal) < 256 m. Base plates: 6 team 1 + 6 team 2, each one type-8 record, open, live at start (fn27 request), respawn 37.5 s. Neutral-only plates: 21.

| outpost (owner word) | claim zone Cact (x, z) | plate (x, z) [Metropolis x] | neutral t36 (live at start) | team-1 t8 (shut) | team-2 t8 (shut) | slot-0 pads tank/jet | slot-1 pads tank/jet |
|---|---|---|---|---|---|---|---|
| 0 (W40) | 152 (114.75, 90.062) | (112.376, 82.625) [128.38] | Csac113 | Csac157 | Csac85 | 150/151 | 149/153 |
|  |  | (122.438, 90.625) [138.44] | Csac119 | Csac158 | Csac162 |  |  |
| 1 (W41) | 169 (81.376, 112.875) | (84.501, 116.688) [100.5] | Csac267 | Csac182 | Csac184 | 166/167 | 170/171 |
|  |  | (86.562, 106.5) [102.56] | Csac265 | Csac176 | Csac180 |  |  |
| 2 (W42) | 191 (89.376, 143.375) | (84.563, 140.5) [100.56] | Csac271 | Csac199 | Csac198 | 188/189 | 192/193 |
|  |  | (91.501, 156.625) [107.5] | Csac274 | Csac203 | Csac202 |  |  |
| 3 (W43) | 213 (124.062, 134.312) | (117.125, 146.25) [133.12] | Csac277 | Csac45 | Csac224 | 210/211 | 214/215 |
|  |  | (120.875, 136.625) [136.88] | Csac279 | Csac217 | Csac220 |  |  |

#### Joke

Captain home (record 164): (120.0, 175.0); farthest own type-8 plate 96.2 m (octagonal) < 256 m. Base plates: 6 team 1 + 6 team 2, each one type-8 record, open, live at start (fn27 request), respawn 37.5 s. Neutral-only plates: 21.

| outpost (owner word) | claim zone Cact (x, z) | plate (x, z) [Metropolis x] | neutral t36 (live at start) | team-1 t8 (shut) | team-2 t8 (shut) | slot-0 pads tank/jet | slot-1 pads tank/jet |
|---|---|---|---|---|---|---|---|
| 0 (W40) | 152 (114.75, 90.062) | (112.376, 82.625) [128.38] | Csac113 | Csac157 | Csac85 | 150/151 | 149/153 |
|  |  | (122.438, 90.625) [138.44] | Csac119 | Csac158 | Csac162 |  |  |
| 1 (W41) | 169 (81.376, 112.875) | (78.501, 116.625) [94.5] | Csac267 | Csac182 | Csac184 | 166/167 | 170/171 |
|  |  | (86.562, 106.5) [102.56] | Csac265 | Csac176 | Csac180 |  |  |
| 2 (W42) | 191 (89.376, 143.375) | (86.438, 149.5) [102.44] | Csac274 | Csac203 | Csac202 | 188/189 | 192/193 |
|  |  | (89.875, 138.5) [105.88] | Csac271 | Csac199 | Csac198 |  |  |
| 3 (W43) | 213 (124.062, 134.312) | (117.125, 146.25) [133.12] | Csac277 | Csac45 | Csac224 | 210/211 | 214/215 |
|  |  | (120.875, 136.625) [136.88] | Csac279 | Csac217 | Csac220 |  |  |

#### Hk

Captain home (record 64): (206.499, 119.562); farthest own type-8 plate 130.3 m (octagonal) < 256 m. Base plates: 6 team 1 + 6 team 2, each one type-8 record, open, live at start (fn27 request), respawn 37.5 s. Neutral-only plates: 27.

| outpost (owner word) | claim zone Cact (x, z) | plate (x, z) [Metropolis x] | neutral t36 (live at start) | team-1 t8 (shut) | team-2 t8 (shut) | slot-0 pads tank/jet | slot-1 pads tank/jet |
|---|---|---|---|---|---|---|---|
| 0 (W40) | 152 (163.375, 66.125) | (161.563, 77.438) [177.56] | Csac119 | Csac158 | Csac162 | 150/151 | 149/153 |
|  |  | (174.376, 77.5) [190.38] | Csac113 | Csac157 | Csac85 |  |  |
| 1 (W41) | 169 (108.814, 66.5) | (97.499, 77.312) [113.5] | Csac265 | Csac176 | Csac180 | 166/167 | 170/171 |
|  |  | (110.376, 77.438) [126.38] | Csac267 | Csac182 | Csac184 |  |  |
| 2 (W42) | 191 (109.377, 173.812) | (97.625, 162.5) [113.62] | Csac271 | Csac199 | Csac198 | 188/189 | 192/193 |
|  |  | (110.501, 162.625) [126.5] | Csac274 | Csac203 | Csac202 |  |  |
| 3 (W43) | 213 (163.188, 174.062) | (161.625, 162.625) [177.62] | Csac277 | Csac45 | Csac224 | 210/211 | 214/215 |
|  |  | (174.501, 162.562) [190.5] | Csac279 | Csac217 | Csac220 |  |  |

#### Ovmp

Captain home (record 98): (128.062, 221.062); farthest own type-8 plate 117.8 m (octagonal) < 256 m. Base plates: 8 team 1 + 8 team 2, each one type-8 record, open, live at start (fn27 request), respawn 37.5 s. Neutral-only plates: 31.

| outpost (owner word) | claim zone Cact (x, z) | plate (x, z) [Metropolis x] | neutral t36 (live at start) | team-1 t8 (shut) | team-2 t8 (shut) | slot-0 pads tank/jet | slot-1 pads tank/jet |
|---|---|---|---|---|---|---|---|
| 0 (W40) | 152 (157.625, 120.062) | (148.438, 113.438) [164.44] | Csac119 | Csac158 | Csac162 | 150/151 | 149/153 |
|  |  | (160.376, 128.438) [176.38] | Csac113 | Csac157 | Csac85 |  |  |
| 1 (W41) | 169 (98.439, 120.062) | (95.687, 128.438) [111.69] | Csac265 | Csac176 | Csac180 | 166/167 | 170/171 |
|  |  | (107.501, 113.688) [123.5] | Csac267 | Csac182 | Csac184 |  |  |
| 2 (W42) | 191 (98.189, 167.938) | (95.625, 159.562) [111.62] | Csac271 | Csac199 | Csac198 | 188/189 | 192/193 |
|  |  | (107.438, 174.438) [123.44] | Csac274 | Csac203 | Csac202 |  |  |
| 3 (W43) | 213 (157.938, 168.062) | (148.625, 174.438) [164.62] | Csac277 | Csac45 | Csac224 | 210/211 | 214/215 |
|  |  | (160.501, 159.562) [176.5] | Csac279 | Csac217 | Csac220 |  |  |

**Which turret is live on each plate at start:** on every outpost plate, the **neutral (type 36)** only. On every base
plate, that plate's own **type 8**. No type-8 record is live on any outpost plate at start. [A]/[B]

**Are the outpost type-8 records tied to outposts and swapped by the claim scripts? Yes.** Decoded from the RPNS pool
(`<Map>.rpns.txt`). Mp outpost 0 is shown; the same ids are used on all six maps:

```
claim zone act152 (type 14, mode 0x06, selector 1/value 1 = any type-1 X1Alpha), reloc24 = touch script, SELF = toucher id:
  if SELF == 12 (slot-0 X1):  if W25 > 29: order 0x7a(1) -> act150; VOICE 13   else deny sound *P[3]=73
  else (slot-1 X1, 2P):       if W26 > 29: order 0x7a(1) -> act149; VOICE 14   else deny
act150 (slot-0 tank pad, type 14, mode 0x36 = disabled + run-reloc2c-on-enable, selector 2/value 12 = only act12),
  reloc2c on enable: W40 = 1; request Csac146 (marker prop); DIE act152 (the claim zone); order 0x3c -> act147
  (destroys the neutral centre prop); request Csac49 (prop); order 0x7a(1) -> act151; W25 -= 30
act151 (slot-0 jet pad), reloc2c on enable:
  DIE 156, DIE 113, SHUT Csac113 (neutral, plate A), OPEN Csac157 (team-1 t8, plate A)
  DIE 159, DIE 119, SHUT Csac119 (neutral, plate B), OPEN Csac158 (team-1 t8, plate B)
  group 11 (the outpost's 4 corner props): order 0x44 = 25 (reskin), order 0x3e = 1; W33++; act264 order 0x4c = 65 (radar); F23 = 1
slot-1 chain act149 -> act153: identical, but OPEN Csac85 / Csac162 (team-2 t8), reskin 51, 0x3e = 2, W34++, radar 66;
  act149 deducts 30 from W26 only `if W3 == 2` (2P); in 1P the captain's dispatch already paid it.
```

(Ids 156/159 on outpost 0 and 195/194 and 219/223 on outposts 2/3 name no actor on these maps: dead posts, no-ops.)
In 1P the captain claims without touching anything. Its decision pass writes `W[40+i] = 2` and pays 30
(0x004229b6 claim loop). Mission fn22..fn25 (gate `W3==1 && W[40+i]==2`, run once) then post `0x7a(1)` to that
outpost's slot-1 tank pad (149/170/192/214), which runs the same slot-1 chain. [B]

---------------------------------------------------------------------------------------------------------------------
## Q2. The Sky Captain's own-turret count

**What it counts** (`cact_dispatch_types` 0x00421910, `src/game/actor/dispatch.c:466-580`). [A]
* It walks the live list from its head at 0x0050e400 (0x0042191e), skips serial 0 (0x00421961) and reads the type at
  +0x16 (0x0042196c).
* A type-8 actor always goes to the "far" measure (0x004219c3 `cmp bl, 8; je`). Its distance is the octagonal flat
  distance `|dx|+|dz|−min/2` from **point_0c = home**, the captain's own spawn position (0x00421ab6..0x00421af0).
* Arm 0x00421b70: `mov al,[esi+0x18]; cmp al,[edx+0x18]; jne; cmp ecx,0x200000; jge; inc [ebp-4]`. That is the
  **same team byte as the captain's own +0x18** (team 2) and distance **< 0x200000 wu = 256 m**.
  The C is at `dispatch.c:573-577`.
* **Not counted:** any type 36. The table-2 guard at 0x00421a9e..0x00421ab0 admits only 0x1c/5/9/8, and a type 36
  that the captain's team captured is routed to the point_00 measure and dropped at 0x00421a15. **Turrets captured
  from neutral do not count.** Dreadnought guns, tanks and the rest are not type 8 either.
* 256 m covers each whole arena. The farthest team-2 type-8 plate from home is 74.5 m (Mp), 110.0 m (Conft), 96.1/96.2 m
  (Slim/Joke), 130.3 m (Hk) and 117.8 m (Ovmp). So "near home" means **every own live type-8 actor**.

**The doubling (the missing factor)** [A]
* `turret_construct` 0x0041bf90, for record types 8/0x21/0x24, builds a sub-template on its stack
  (0x0041c02c..0x0041c089): handler 0x0041ce30 (`cact_handler_turret_part`), a spliced aRSL, **record = the turret's
  own tACT record** (`[esp+0x1c] = edi`) and res = 0. It then calls `cact_create` (0x0043ada0) at 0x0041c08e and stores
  the result at +0x104 (part_b, 0x0041c093).
* `cact_create` gives the part a serial (0x0043add6), constructs it (0x0043add9) and **links it into the same live list**
  (0x0043ade0 → `cact_link` 0x0043ad70, tail append to 0x0050e400/0x0050e404).
* The part construct 0x0041cf70 only rewrites record type 0x18→0x0b, takes the turret arm for type 8 (0x0041cf8b) and
  runs the base construct through 0x0041a420 op 2 (0x0041cfd2). That is `cact_base_construct` 0x0041a530, which writes
  **+0x18 = record team** (0x0041a59d) and **+0x16 = record type = 8** (0x0041a5b0).
* So every live type-8 turret contributes **2** to `close_type8`. The part dies with its owner: the turret's ops 9/0x0b/0x0e
  mirror the owner's HP word +0x1c into both parts (`turret.c` 0x0041bc60 arm), and a negative word_1c gets op 4 from
  `cact_tick_expired` (0x0043a910). [B] for the part's death timing.

**Threshold and modes** [A]
* Promotion to mode 2 (0x00421cea..0x00421d28) happens when `far_dread || far_tank || (count < 10 && mode != 1)`
  (`cmp ecx,0xa; jge` 0x00421d1c, `cmp al,1; je` 0x00421d21).
* In mode 2 (0x00421eac) it handles the far Dreadnought or tank. Otherwise, if count < 10, it moves toward player slot 0
  (`[0x511fd0]`, no aim); **else it sets mode 0** (0x00421ecc). The construct starts in mode 2 with rethink = 0
  (0x004213ce, 0x004213e8) and clears W40..W55 (0x00421448..0x0042146f, after its own header script set W40..43 =
  1,2,3,4; those stores are dead).
* Outposts are claimed only in modes 0 and 1 (0x004229b6: `W[40+slot] != 0` skips; budget ≥ 30).

**Count at match start (once fn27's base turrets are up, within ~0.1 s)**

| map | own (team-2) base turrets | outpost t8 live | count = 2 × live own t8 | ≥ 10? | mode 2 again (no threat, no outposts) after losing |
|---|---|---|---|---|---|
| Mp | 8 | 0 | **16** | yes | 4 base turrets (16−8 = 8 < 10; 3 lost leaves exactly 10) |
| Conft | 8 | 0 | **16** | yes | 4 |
| Ovmp | 8 | 0 | **16** | yes | 4 |
| Slim | 6 | 0 | **12** | yes | 2 |
| Joke | 6 | 0 | **12** | yes | 2 |
| Hk | 6 | 0 | **12** | yes | 2 |

Each outpost the captain owns adds 2 turrets, so **+4** to the count once spawned (they are opened, so they spawn on
the next tick). **The deadlock dissolves.** At start the count is 16 or 12, and the captain leaves defend at its first
rethink after the base turrets exist. It then roams (mode 0), captures neutral turrets (+1 budget each) and claims
outposts at 30 budget. It falls back to defend only when enemy units approach home or its turret stock is depleted.
Equivalent rule: **defend while fewer than 5 own team turrets are alive** (base + owned outpost).
[C] The very first decision pass runs on the captain's first tick and probably precedes the turret spawn, so it may
spend one rethink interval (~2.7 s at L0) flying toward the player before switching to mode 0. Not traced.

---------------------------------------------------------------------------------------------------------------------
## Q3. Outposts

* **Four per map**, indexed by owner word W40..W43 (0 = nobody, 1 = slot 0, 2 = slot 1/captain). Positions are in the
  tables above and in `outposts.json` (`claim_zone`, `plates`, `pads`, `footprint_corner_props`).
* **Claim zone** = one type-14 Cact per outpost (Mp 152/169/191/213, the same ids on every map). Record: radius 614
  raw → radius_68 614<<4 wu = **1.2 m**, half_h = half_v = 614 (×16 wu = 1.2 m). Mode 0x06: bit 0x02 runs reloc[0]
  with the toucher's id and the zone survives (0x0041f8b7); bit 0x04 sets the op-10 gate (0x0041f518). Selector 1,
  value 1 means any type-1 actor (X1Alpha). Contact comes from the pair test (`collide.c:371-430`): octagonal distance
  < radius sum, then the coarse boxes. So you claim within about **1.2 m + the mech's own radius (~0.45–0.7 m)** of the
  zone centre, horizontally and vertically. [B]/[C] for the exact reach.
* **Button:** with gate bit 0x04 the op-10 match refuses a player whose `[+0xac]+0x40` is non-zero (0x0041e678..0x0041e6a0).
  That is the action-key latch the turret capture uses (0 = pressed this frame, `ranges-turrets-capture.md` Q2). So a
  claim and an outpost-pad purchase need **an action-key press while in contact**. [B]
* **Cost** 30: the touch needs W25 > 29 (slot 0) or W26 > 29. It is deducted in the slot's tank-pad enable script (slot 0
  always, slot 1 only in 2P). The 1P captain pays 30 in its decision pass (`SKY_SLOT_COST`, dispatch.c:1028-1043). [B]
* **What claiming does** (per side; see Q1 listing): it kills the claim zone (0x3d, so no second claim) and destroys the
  neutral centre prop. It spawns two marker props. It enables the side's two pads: tank and jet, **2 points each**,
  the tank queued through F-flags. On both of the outpost's **2 turret plates** it kills the neutral turret, shuts the
  neutral spawner and **opens the side's own type-8 spawner**. It reskins the 4 corner props, recolours the radar
  contact, increments W33/W34 and plays a voice (claim zone: slot 0 13/11/7/9, slot 1 14/12/8/10 for outposts 0..3).
  For the 1P captain fn22..25 queue voice 14/12/8/10. [B]
* **Plates per outpost:** 2. **Turrets per owned outpost:** 2, respawning **25 s** after death (tSAC −1500 × 5 = 7500
  ticks), indefinitely (enable −1). [A]
* **Permanence:** permanent. The zone is dead, fn22..25 run once, and no script closes an opened outpost spawner or
  reopens a neutral one. [B]
* The DIE order sets `CACT_FLAG_DEATH_SCRIPT_ARG` (`mission_frame.c:1058`), so killing a neutral turret that the other
  side had captured scores nothing (`turret.c:485`: the score needs that flag clear). [B]

---------------------------------------------------------------------------------------------------------------------
## Q4. Contradictions with the earlier write-ups

1. **ai-and-rules.md §1.5** says: "(8 base turrets + 2 per owned outpost, so early game `own_turrets < 10` is normally
   true: the captain's default is 'defend, or go after the player'.)" Its §9 says: "Whether `own_turrets < 10` ever goes
   false in practice (needs >= 10 own turrets, i.e. all base turrets plus an owned outpost's pair)".
   **This report:** each turret counts twice (turret + base part), so the start count is 16 (or 12 on Slim/Joke/Hk),
   which is ≥ 10. The default is mode 0. The "8" is also 6 on Slim/Joke/Hk. [A]
2. **precinct-assault.md** (Sky Captain, Defend): "with ten turrets or more it drops to roaming. Since a side starts with
   8 base turrets and an outpost adds 2, this is the early game's normal state." Its could-not-establish list has:
   "Whether the Sky Captain's turret count ever reaches ten". **This report:** it is ≥ 10 from the start, so defending
   is *not* the normal early state. [A]
3. **ai-and-rules.md §2** says: "outpost claim: drive into the outpost's claim zone ... enemy outpost-turret spawners
   shut, own opened". **precinct-assault.md** says: "Driving into an outpost's claim zone with 30 points or more claims
   it ... the enemy's turret spawners at that outpost are shut and the side's own opened".
   **This report:** the scripts shut the **neutral** turrets' spawners on the two plates (and kill those neutrals). The
   enemy's type-8 spawners there are shut from load and never touched. A claim needs the action key while touching the
   zone (gate bit 0x04). [B]
4. **ranges-turrets-capture.md** (headline) says: "The base guns are the type-8 team turrets: 16 per side on Mp, Conft
   and Ovmp, 14 on Slim, Joke and Hk." Its Q3 table says: "type 8 team turret | 32/32/28/28/28/32 ... 16 at 37.5 s + 16
   at 25 s". **This report:** only 8 (or 6) per side are base guns. The other 8 per side are outpost-plate turrets that
   do not exist until that side claims the outpost (spawner shut at load). The 37.5 s/25 s split is right. [A]
5. **combat.md** says: "the team turret, which belongs to a side from the start". This holds for base turrets only.
   Outpost team turrets appear on claim. [B]
6. **ranges Q5** says of a negative period: "the first timed spawn comes one period after load". That is right for the
   timer. Base and neutral turrets nonetheless exist at t ≈ 0, because fn27/fn29 *request* them. [B]
7. No contradiction: ai-and-rules §1.8 (W40..43 owner words, fn22-25, cost 30), "claims are permanent", the 25 s and
   37.5 s respawns, and the outpost pads at 2 points.

---------------------------------------------------------------------------------------------------------------------
## Metropolis should

* **Keep dropping the dual-team outpost records from the permanent base ring, but do it by outpost membership, not by
  pad key.** The half-cell key leaks on Conft: Csac217 (team 1) sits at x 131.7505 → Metropolis 147.75 → key 148.0,
  while its plate-mates key to 147.5. Team 1's Conft ring therefore gets a 9th turret that is really outpost 3's. (Mp
  plate 157/85/113 also splits the neutral off, harmlessly.) [B]
* **Model each outpost's 2 plates as:** at start one live capturable neutral turret per plate. On a claim by side S:
  remove that neutral (no points, no respawn) and spawn S's team turret on the plate at once, with 500 HP, weapon 3,
  respawning 25 s after each death, for the rest of the match. The base ring is 8 (Mp/Conft/Ovmp) or 6 (Slim/Joke/Hk)
  per side, respawning 37.5 s.
* **Sky Captain defend gate:** `ownLiveTeamTurrets * 2 < 10` (equivalently fewer than 5 live own type-8 turrets, base +
  outpost, anywhere on the map), never counting captured neutrals. Distance 256 m from home is effectively unbounded.
  Do not invent "turrets near home" radii.
* The captain claims outposts by writing ownership and paying 30 in modes 0/1. It never needs to touch the zone.
* Claim and outpost pads: touch plus action key, zone radius ≈ 1.2 m plus the mech's radius. Cost 30 for a claim and
  2 per pad unit. One claim per outpost, ever.

---------------------------------------------------------------------------------------------------------------------
## Could not establish

* The exact contact reach of a type-14 zone. `cact_hit_boxes` for a model-less zone was not read, and the 4 m broad-phase
  cell may clip it.
* Whether the captain's first decision pass precedes the fn27 spawn. It only affects the first ~3 s.
* Hk's fn27 is the Mp list copied: it also requests Csac19 (a neutral on Hk, also requested by fn29), Csac22/29 (pickups,
  also requested by fn28) and Csac31 (absent). If two requests for one spawner land before its live count rises, both
  are spawned (`csac_tick` ignores the limit for requests), which would stack a second neutral turret. Ordering not
  traced.
* What order 0x3e (byte_23 = 1/2) on the corner props and the 0x44 reskin values mean visually.
* In 2P a slot-1 claim never writes W40..43 (only the slot-0 script writes `W[40+i]=1`). Whether anything in 2P reads
  those words was not checked.
* The `+0xac → +0x40` latch object is not decompiled (the gate rests on the ranges report's reading of
  `view_button_latch`).
