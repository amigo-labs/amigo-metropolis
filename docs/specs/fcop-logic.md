# fcop-logic.md — Original FC:LAPD unit logic (reverse-engineered)

Status: reference (not a v1 requirement)

## 0. One paragraph

Yes — the original *Future Cop: L.A.P.D.* (1998) mission files carry unit
**logic as data**: where every actor stands, what type it is, its combat
parameters (turret range / fire-delay / turn-speed / target selector, aircraft
orbit zone / speed), and — for ground units — a reference to a **waypoint graph**
(`Cnet`) that defines the roads they drive. This is fully readable. What is
*not* in the data is the moment-to-moment decision algorithm (which target is
nearest this frame); that lived in the compiled engine. This doc records the
byte layout, the behaviour model, and what it means for Metropolis. It is
reference material, not a v1 spec change.

## 1. Sources

- **Data layout + field semantics**: the open reimplementation
  [Ghoster738/Future-Cop-MIT](https://github.com/Ghoster738/Future-Cop-MIT)
  (`src/Data/Mission/ACTResource.*`, `NetResource.*`, `ACT/*`). Cloned locally
  at `D:\github\Future-Cop-MIT`.
- **Raw containers + extractor**: the private RE repo
  `amigo-labs/fcop-reverse-engineering`. The parser
  `tools/gfx/extract_logic.py` (added by this work) decodes `Cact`/`Csac` and
  `Cnet` from every mission and writes `extracted/logic/<Map>/{actors,nets}.json`.
- The in-repo mission containers are the **PC build → little-endian**; 4CC tags
  are stored byte-reversed on disk (`tag[::-1]` = readable).

## 2. The logic chunks

Each mission container holds, besides the already-decoded geometry/terrain/audio:

| Chunk | Meaning | Per-mission count (example) |
|---|---|---|
| `Cact` | Actor instance (one per resource): placement + parameters | M1a1 368, Mp 146 |
| `Csac` | Same structure as `Cact`, but carries a spawn sub-chunk (`tSAC`) | M1a1 118, Mp 108 (≈ constant → shared class table) |
| `Cnet` | Directed waypoint graph (the "roads") | campaign M1a1 23, M2c 29 vs. MP arena Mp/Conft/Slim = 2 |
| `Cfun` | Function/trigger bytecode (mission scripting) | 1 per mission |

The `Cnet` count scaling is the tell: story missions carry many path networks
(units patrol/advance along authored roads); MP arenas carry ~2 (little pathing
needed). This matches Precinct Assault's design.

## 3. Byte layouts

### 3.1 Cnet — waypoint graph (`NetResource`)

Header 16 B; `nodes_amount` (u16) at `0x0E`; then `nodes_amount` nodes of 12 B
from `0x10`. Per node:

- `0x00` u32 `bitfield_0`, `0x04` u16 `bitfield_1`
- `0x06` i16 `x`, `0x08` i16 `y` → world = `(x/32, y/32)` (`INTEGER_FACTOR = 1/32`)
- `0x0A` u16 height/flags: height = sign-extend(`(v>>4)&0xFFF`) `/32`;
  `ground_cast = v&3`
- **Adjacency**: up to 4 neighbour node indices, packed as 3×10 bits in
  `bitfield_0>>2` plus 1×10 bits in `bitfield_1>>6`. Sentinel `0x3FF` = no edge.
- `state = bitfield_0 & 3` (0=enabled, 2=disabled).

Node raw coord = actor raw position `>> 8` (both resolve to the same world
scale). Node Y (up) is not stored — the engine raycasts it against terrain.

### 3.2 Cact / Csac — actor record (`ACTResource` + `ACT/*`)

The resource payload is a sub-chunk container: **`tACT` → `aRSL` → `tSAC`**.

`tACT` (28 B header + type payload):
- `0x08` u32 `matching` (actor id), `0x0C` u8 **`act_type`**
- `0x10` i32 `position_y`, `0x14` i32 `position_height`, `0x18` i32 `position_x`
  → world cell = value `/8192` (**note order Y, height, X**)
- `0x1C…` type-specific parameter block, length `chunk_size − 28` (= `getSize()`)

Rotation is per-type (in the payload), converted by `angle = −π/2048 · v`
(4096 = 360°); turret rotations are offset by `−1024` first.

`aRSL` = resource links, `(size−12)/8` entries of `[u32 type4cc][u32 id]`. Link
semantics are positional per type: e.g. `PathedActor` → `rsl[0]` = alive `Cobj`
model, `rsl[1]` = destroyed model, **`rsl[2]` = `Cnet` path**.

`tSAC` = spawn info (only on `Csac`): `game_ticks` (i16, |t|/60 s), `spawn_limit`.

**Actor type registry** (`ACT/Internal/Hash`): `1` X1Alpha, `5` PathedActor,
`6` StationaryActor, `8` Turret, `9` Aircraft, `10` Elevator, `11` DynamicProp,
`12` WalkableProp, `16` ItemPickup, `20` PathedTurret, `25` MoveableProp,
`35` MapObjectiveNodeGroup, `36` NeutralTurret, `37` SkyCaptain, `95` Trigger,
`96` Prop, `97` DCSQuad. Unlisted codes → Unknown.

**Parameter block** (inheritance `BaseEntity → BaseShooter → {BaseTurret |
BasePathedEntity} → leaf`; sizes verified against `getSize()`):
- `BaseEntity` (16 B): flags, health, collision_damage, team, group_id,
  target_priority.
- `BaseShooter` (16 B): weapon_id, target_type, targeting, fov, **engage_range**,
  **targeting_delay** (fire cooldown/detection delay).
- `BaseTurret` (14 B): gun_rotation, **turn_speed**, height_offset.
- `BasePathedEntity` (20 B): **move_speed**, acceleration, height_offset.

## 4. Behaviour model — data vs. engine

FC:MIT splits **parsing** (`Data/Mission/ACT`) from **runtime** (`Game/ACT`).
Every field below is data in the original `Cact`. FC:MIT's runtime only
*simulates* path movement + animation; targeting/firing/projectiles are **not**
reimplemented there (they were engine code, only partly recovered as field
semantics).

| Question | (a) Stored as `Cact` data | (b) Engine behaviour |
|---|---|---|
| **Aircraft flight** | spawn_type/pos, move_speed, turn_rate, orbit_area_x/y, height_offset, time_to_descend, target_detection_range | orbit/descend algorithm (engine; only stubbed in FC:MIT) |
| **Ground unit (Pathed)** | move_speed, acceleration, **Cnet path ref** (`rsl[2]`), start node (= position), graph topology | traverse graph node→node; FC:MIT picks a **random** neighbour at each junction + linear interpolation (its guess of the engine rule) |
| **Turret targeting** | weapon_id, target_type, targeting, **engage_range**, **targeting_delay**, fov, **turn_speed**, gun_rotation, base_rotation, shooter bitfield | pick current target in range + slew gun + fire on cooldown (engine; not in FC:MIT) |

So for the three questions asked:
- *How a tank drives* → **data** (its `Cnet` graph + start node + speed).
- *Where a plane flies* → **parametric data** (orbit zone, speed, turn rate,
  descend time); the exact path-through-space is engine-computed from those.
- *When/where a turret shoots* → the **rules are data** (who it targets, range,
  fire cadence); only the per-frame "nearest target right now" pick is engine code.

## 5. Validation (evidence the decode is correct)

Run: `python tools/gfx/extract_logic.py` in the RE repo. Cross-checks:

- **Ground-truth positions**: decoded X1Alpha (type 1) spawns match the
  hand-placed values in `tools/generators/convert.ts` within ~0.5 cell —
  Conft (90.2, 71.0)/(117.8, 169.0) vs. authored (90.5, 71.5)/(117.5, 169.5);
  Mp (96.1, 69.1)/(96.0, 155.0) vs. authored (96, 69)/(96, 155).
- **Field ranges** match FC:MIT's documented values: fov ≡ 0x1000, turret
  engage_range ∈ {4096, 5120, 6144}, targeting_delay ∈ {16…96}, and vary
  per-turret in campaigns (not a constant → real data).
- **Path coupling**: all **248/248** pathed actors reference a `Cnet`; a sampled
  PathedActor starts at (112.8, 70.6), exactly on node 0 of its referenced net
  (112.75, 70.59).
- **Counts** match the raw `fcop.py` resource inventory (M1a1 = 368 `Cact` +
  118 `Csac` + 23 `Cnet`; Mp = 146 + 108 + 2).

## 6. Options for Metropolis

Current sim (`packages/sim/src/units.ts`, `docs/specs/rules.md`) deliberately
uses **hand-authored lanes** and keeps units "dumb on purpose — no runtime
pathfinding in v1". The original data opens these options; none is adopted yet:

1. **Import `Cnet` as lanes.** Replace hand-authored waypoint polylines with the
   original path graph per arena. Would give authentic road layouts.
   ⚠️ **Design tension**: `rules.md` intentionally forbids runtime pathfinding;
   a full graph with junctions implies node-choice logic. A middle path is to
   flatten a `Cnet` into fixed polylines (pick canonical routes) — keeps the sim
   dumb while using original geometry.
2. **Seed turret balance from data.** Use original engage_range / targeting_delay
   / turn_speed as reference points for `packages/sim/src/balance.ts` values.
3. **Aircraft patrol shape.** Use orbit_area / speed / turn_rate as reference for
   the air-unit orbit in `moveAirUnit()`.

Any adoption is a **deliberate** deviation from the v1 "dumb units" rule and must
be raised as such, per `CLAUDE.md` (spec is source of truth).

## 7. Tooling

- `tools/gfx/extract_logic.py` (RE repo) — decodes `Cact`/`Csac`/`Cnet` → JSON.
- Raw inspection: `tools/audio/{dump_chunks,body,hexat,rawgrep}.mjs`.
- `Cfun` (mission scripting bytecode) is **not** decoded — 7-bit var-length
  encoding, deferred. **Single-player only; out of scope for Metropolis MP.**

## 8. Multiplayer focus (Precinct Assault)

Metropolis ships the 6 MP arenas **Conft, Slim, Mp, Joke, Hk, Ovmp**. Everything
below is scoped to those; campaign missions and the `Cfun` mission VM are ignored.

### 8.1 The team production base (`act_type = 28`, "TeamBase?")

Not in FC:MIT (it lists 28 as Unknown). Identified here purely from the data and
it is the **core Precinct Assault mechanic**:

- **Exactly 2 per arena**, team-symmetric: each sits ~7 cells from one X1Alpha
  spawn and far from the other. Byte `team` = 1 vs 2.
- **Each base is bound to its own `Cnet`**: team-0 base → `Cnet` id 1, team-1 base
  → `Cnet` id 2. So the two path networks per arena are the two teams' lanes.
- Carries a **`tSAC` spawn timer**: `spawn_ticks = 300` = **5 s**, `spawn_limit = 1`
  → produces a unit onto its lane every 5 s.
- `health = 3000` (the structure you attack). Model refs: alive `Cobj` + destroyed `Cobj`.

Full 112-byte payload (RE'd here, no FC:MIT reference; identical across all 12 MP
instances):
- `0x00` **BaseEntity** — flags, `health = 3000`, collision_damage 10, `team` (1/2),
  group 3, target_priority 15.
- `0x10, 0x40, 0x50, 0x60` — **4 identical BaseShooter defence weapons**: weapon_id 3,
  target_type 4, `targeting = enemy team` (verified: team-2 base → targets 1, team-1 →
  targets 2 in every instance), fov `0x1000`, engage_range 6144, targeting_delay 16.
  → the base's built-in defensive ring.
- `0x20` — **produced-unit movement template**: move_speed 1024, acceleration 1228
  (matches the `PathedActor` values → the unit this base spawns).

This ties the whole MP loop together: **base → its `Cnet` lane → `PathedActor`
units traverse it toward the enemy base**, on a 5 s production cadence, while 4
built-in weapons defend the base.

### 8.2 MP-relevant, already extracted

| Data | Where | Note |
|---|---|---|
| X1Alpha spawns (type 1) | `actors.json` | 2/arena, validated vs. `convert.ts` |
| Base turrets (`Turret` 8) + capturable (`NeutralTurret` 36) | `actors.json` params | placement + engage_range / targeting_delay / turn_speed / weapon_id |
| Combat units (`PathedActor` 5) | `actors.json` | move_speed + `Cnet` ref (`rsl[2]`) |
| Lanes (`Cnet`) | `nets.json` | 2 per MP arena; per-team (see 8.1) |
| Spawn cadence (`tSAC`) | `spawn_ticks`/`spawn_seconds`/`spawn_limit` | on turrets, units, pickups, bases |
| Air units (`Aircraft` 9) | `actors.json` params | +orbit fields: orbit_area_x/y, turn_rate, move_speed, time_to_descend, target_detection_range, spawn_type |
| Power-ups (`ItemPickup` 16) | `actors.json` params | `grants` list: reload/power-up gun·heavy·special, restore_health, invisibility, invincibility |
| Trigger volumes (`Trigger` 95) | `actors.json` params | width/length/height (raw), flags (retrigger/action_button/disable), `triggering_actor_id` (watched actor); see §8.6 |

### 8.3 Ignore (single-player or scenery)

- Campaign-only missions and `Cfun`, `canm`, `MapObjectiveNodeGroup` (35),
  `SkyCaptain` (37, just a PA map-type marker).
- Scenery/decoration actor types still Unknown that carry `Cobj` models and appear
  in prop-like counts: codes 87–99 (mostly), 98, 90–93. Low MP value.

### 8.4 Remaining MP-optional targets (by value)

Done: `TeamBase?` payload (§8.1), `ItemPickup` contents, `Aircraft` orbit fields,
partial characterization of logic types 14 & 89 (§8.5) — all in `extract_logic.py`.
No high-value MP data known to remain undecoded.

### 8.5 Partially characterized logic markers (`act_type` 14 & 89)

Both are Unknown in FC:MIT and invisible (no `Cobj` model, no team/health, only
NULL RSL refs). Characterized here from spatial + payload analysis; **tentative,
kept numeric (`type_14`/`type_89`) in the parser to avoid false precision.**

- **Type 14** — 24 B, **exactly 24 per arena** (all six). Instances form **clusters
  of ~5 at symmetric strongpoints** (the arena's corner outposts) plus a few near
  the base approaches, hugging the lanes (median ~2–6 cells from a `Cnet` node) and
  near turrets. Payload is highly templated (tail ≈ `[614,0,566,12|16]`, byte0 ∈
  {144,152}); duplicate positions appear in two variants → plausibly a
  **capture/strongpoint marker group** (2 states/team variants). Confidence: medium
  (lane-associated strongpoint marker); exact function unconfirmed.
- **Type 89** — 68 B, ~15 per arena (Hk 59, the large layered map → count scales
  with map area). Instances form **evenly-spaced lines/columns of oriented points**
  in open space, away from lanes/turrets/bases. Payload carries a per-point heading
  (u16@0, varies) plus motion/engagement constants (1024/1228/6144/8192). →
  plausibly an **oriented waypoint route in open areas** (distinct from the ground
  `Cnet`; possibly an air/secondary path). Confidence: lower.

Neither is required for the MP model in §8.1–8.3; documented for completeness.
Note: type 14 places ~2 instances at each base, but it is a **passive marker** — the
"enemy in base" detection is done by `Trigger` (95), see §8.6.

### 8.6 Base intrusion triggers ("enemy in your base" → alert)

Each base is wrapped in a cluster of `Trigger` (95) volumes (Conft: ~15 per base).
A trigger fires when the actor named by its `triggering_actor_id` enters its volume.
The pattern holds across **all 6 arenas** (each of the 2 bases per arena is guarded):

- **Proximity zones** (flag `retrigger`) watch the **enemy** `X1Alpha` player and the
  enemy `PathedActor` units — i.e. they detect an intruder entering your base.
- **Button zones** (flag `action_button`, point-sized) watch the base's **own**
  `X1Alpha` — player interactions at the base.
- Some triggers watch the opposing `TeamBase` itself (win/damage wiring).

Example (Conft): base team-2's trigger #234 (`retrigger`) watches actor 12 = the
enemy X1Alpha; its siblings watch enemy units 75/87/173/144/205.

The trigger only **detects**; it carries no sound. The actual alert sound is wired
in the `Cfun` mission script, which references the trigger by `matching_number`.
`Cfun` is single-player-scoped and left undecoded — so the detection half is
confirmed in the data, the sound half lives in the (undecoded) script layer.
