# The original's terrain trace (2026-11-01)

> Status: **done** (2026-11-01, SIM_VERSION 117; ledger row T1, PLAN.md Phase 14
> wave 8). Owner's rule: only the original counts (`docs/specs/fcop-fidelity.md`,
> PLAN.md Phase 14). Found by the owner's question "do shots at other heights work
> cleanly?" — they did not.
>
> What the work found beyond the plan:
> - **8.6 is the footprint, not a hover probe.** `player_ground_probe` /
>   `player_ground_push` are the X1's wall contact in both forms: four corner
>   traces and four edge traces each tick, a push per wall kind. On an arena with
>   plates no wall stops the move any more; the X1 is pushed off the plates'
>   walls (terrainTrace.test.ts holds it to never crossing one).
> - **The RE's bone chain disagrees with the data.** Its transcription of
>   `player_bone_chain` with `math_matrix_from_angles_b` misses the cockpit's own
>   3DBB box by about 450 raw units on Mp's records; FC:MIT's decode reproduces
>   every frame's box to 1.63, so `gen:x1muzzles` uses it and the RE has a
>   target.
> - **The balance moved, as the original's.** The rings' guns see over ledges
>   the lattice closed: a lone Runner breaches no arena, the d8 Sky Captain
>   resolves 7 of 20 seed runs in fifteen minutes (19 before).

## The gap

Every line the original tests against the arena — a hitscan shot, a round's
step, a turret's clear line, a target search, the sustained weapons' sweeps — goes
through **one** function: `terrain_trace_segment` (retail 0x00454790, its cell
test `terrain_trace_cell` 0x00455480; RE `src/game/world/trace.c`,
`src/include/fcop/trace.h`). It walks the segment **in three dimensions** through
the original's plates: the floor plates (types 0x00..0x46) as planes, the wall
plates (0x47..0x6e) as vertical quads with their own height, and answers the
first plate the segment crosses, with the hit point and the plate's material.

Metropolis replaces it everywhere with `segmentBlockT` / `segmentBlocked`
(`packages/sim/src/collision.ts`): a 2D walk over the wall lattice of **layer
0**, with no heights and no floors. The lattice is the walker's collision: every
near-vertical face taller than a kerb is a wall bit (`tools/generators/kerbs.ts`),
whatever its height. So in a match:

1. **A shot across a ledge is stopped by the ledge.** From a deck, a ramp's top or
   a plinth down onto a target below, the line meets the edge's wall bit and
   stops, though it passes metres above the face. The same holds upwards.
2. **Floors stop nothing.** From under a deck a shot reaches a target on it.
3. **The wrong lattice on a deck.** `segmentBlockT` is never given a layer, so a
   shot fired on Hk's or Ovmp's decks is traced against the road's walls below.
4. **The X1's direct shot starts at the body's centre**, not at the gun's muzzle
   point the original traces from (`player_fire_direct` 0x004596b0).
5. **The direct shot's end point** is the lock's position; the original's is a
   random point on a sphere about the target's reference point, on the muzzle's
   side (0x00459758..0x00459835, two `game_rand` draws). With a 3D trace that
   end point decides whether a target behind a parapet is hit.

The ledger carries the lattice stand-in only for the sustained weapons (row W1,
"the terrain trace is the wall lattice (no floors)"); for every other line it is
not recorded at all.

## The call sites

The original's seventeen callers, and what stands for each in Metropolis. The
last column is the original's `hit_floors` argument.

| Original | Metropolis | floors |
|---|---|---|
| `player_fire_direct` 0x004598c5 (player_fire.c) | `directShot` sim.ts | 1 |
| `discharge_hitscan` 0x0044dc2e (discharge.c) | `hitscan` sim.ts | 1 |
| `discharge_launch` 0x0044d98d (discharge.c) | `shooterTurret`, `shooterUnit`, `shooterDreadnought` sim.ts; `captainWeapons` warden.ts | 1 |
| `cact_discharge_instant` 0x0044e421 (discharge_instant.c) | the instant arm of the same shooters | 1 |
| `cact_round_advance` 0x00423ef3 (type7.c) | `systemProjectiles` sim.ts (straight and arced rounds) | 1 |
| `missile_advance` (missile.c:965) | `guidedTick` sim.ts | 0 |
| `cact_bounce_advance` 0x00424722 (type15.c) | `bounceTick` sim.ts (grenade, mines) | 0 |
| `cact_find_target` 0x0043bd74, modes other than nearest (target.c) | `nearestEnemyFrom` units.ts, `nearestEnemyAvatar` sim.ts, the captain's search warden.ts | 0 |
| `sustain_attached_sweep` 0x0044b3f4 | `wallT` sustain.ts (flame trail) | 1 |
| `sustain_aimed_sweep` 0x0044b8d9 / 0x0044bda9 | `wallT` sustain.ts (beam) | 1 |
| `player_walk_tick` 0x004448a6 (head trace) | `deckOverhead` sim.ts | 1 |
| `player_ground_probe` (player.c, eight probes) | the hover's ledge test, walker.ts | 0 |
| `hud_draw_lock_beam` (draw.c) | client `render/lockBeam.ts` | 1 |
| `view_trace` 0x00445df0 (view_place.c) | client `render/cameraTrace.ts` (samples the heightfield) | 1 |

The first ten are this plan's scope. The two movement traces stay on the wall
lattice for now: the walker's and the hover's movement model is the original's
over the lattice (RE M3-OV, SIM_VERSION 108/113), and changing what it collides
with is a separate pass (wave 8.6 below). The two client ones follow at the end,
render-only.

## Steps

Each step is one commit (or a short run of them), checked as `docs/plans/open-items-2026-10.md`
"How to run a pass" describes.

### 8.1 The ledger row (no code)

A new row in `docs/specs/fcop-fidelity.md` (T1, "The terrain trace"): the gap
above, the call-site table, decision **adopt**. Row W1's "the terrain trace is
the wall lattice" points at it.

### 8.2 The data: `gen:trace` (no hash)

`tools/generators/fcopTrace.ts`, on the pattern of `fcopCoarse.ts` and
`fcopTerrain.ts` (which already read the same resources):

- From `<RE>/fixtures/missions/<Mission>`: the Cptc GRDB (width, height,
  margin, one word per grid cell: the Ctil section id at bits 2..15), and of
  every Ctil section a cell references, its `Sect` chunk's four byte ranges the
  trace reads: the 17 x 17 x 3 height bytes (+12), the four material bytes
  (+0x370), the 256-entry cell index (+0x3cc) and the plate words (+0x5d0).
  Measured on the six PA containers: 35 (Conft) to 94 (Ovmp) sections, roughly
  1-3 KB each in those ranges.
- Out: `tools/generators/fcop/<mission>-trace.json`. Stage 2 (`enrichArena.ts`)
  copies it into `packages/sim/maps/<id>.json` as `trace`, base64, with its
  origin moved into the sim's frame the way `coarse` is (16 m on the sim's x,
  `LOGIC_OFFSET_X`). `map.ts` parses it into typed arrays (`MapTrace`: an
  `Int32Array` grid, one `Uint8Array` of all sections, an offset per section).
- The two plate tables (`TERRAIN_TYPE_CORNERS[0x70][4]`, `TERRAIN_TYPE_FLAGS[0x70]`,
  retail 0x0048c608 / 0x0048c7c8) as `packages/sim/src/traceTables.generated.ts`,
  read from the RE's `src/game/world/height.c`, where they are defined, by the
  same generator.
- `--check` like every `gen:*`; the test maps and the sandbox carry no `trace`.

The map JSON grows by roughly 150-400 KB per arena (today 1.2-2.1 MB).

### 8.3 The port: `packages/sim/src/trace.ts` (no hash)

`terrainTraceSegment(trace, from, to, outHit, hitFloors)` and
`terrainTraceCell(...)`, transcribed from `trace.c` statement by statement, with
the RE's addresses as comments, in world units on the original's axes:

- **Integer arithmetic only.** Every value is an int32: `| 0` after each add,
  `Math.imul` for 32-bit products, `>>>` where retail is unsigned.
  `mul_shr16` (bits 16..47 of a signed 64-bit product) is done exactly with 16-bit
  halves, no `BigInt` in the tick. `recip6`'s `0x80000000 / q` is `Math.floor` of
  the double quotient, which is exact for operands below 2^32. No transcendental
  `Math.*` (CLAUDE.md determinism rule 1); none is needed.
- **Retail's four quirks are kept**, as `trace.c` keeps them: the displaced
  shape-1 floor plane, the stale running best distance in the wall pick, the
  `y_at_b` seed from `hit_floors`, the zero-length first piece on a cell
  boundary.
- **The stale best distance** (`g_pick_best`, a stack slot that carries over
  from the previous call) lives in `SimState` and is hashed, so a resync or a
  replay seek starts from the same value. A module-level variable would be
  deterministic between peers but not across a snapshot restore.
- **Zero allocations**: scratch `Int32Array`s at module scope.
- **Frame conversion** in one helper beside `coarseHeightAt`: sim (x, y,
  height) in metres -> original (x, y, z) in world units is
  (`floor((y - originY) * 8192)`, `floor(h * 8192)`, `floor((x - originX) * 8192)`);
  the hit point back by the inverse. The sim's heights are the original's
  (SIM_VERSION 100: every feature stands on `terrain_height_at`).
- **Without `trace`** (test maps, sandbox, `layered-test`) the helper falls back
  to today's `segmentBlockT`, so their tests and goldens keep their meaning.

**Verification, bit for bit.** The RE already drives the decompiled trace over
real containers and dumps every ray with its answer
(`tests/tools/trace_dump.c`, checked independently by `tests/trace_model.py`).
Run it over the six PA containers, commit the dumps as fixtures
(`packages/sim/test/fixtures/trace/<mission>.bin`, with the RE commit they came
from), and a sim test replays every ray: result word and hit point must be equal.
If the dump's five ray families do not reach far enough (long diagonals with a
height change, segments across decks), add a mode to `trace_dump` in the RE repo
that reads rays from a file, and dump a set drawn from the PA arenas (an RE PR
first).

### 8.4 The X1's gun muzzle (hash)

The original traces the direct shot from point 0 of the gun's model block:
`view + 0x178` or `view + 0x1c4` by the low bit of the ammo being spent, block 0
always for the Electric Gun (0x00459666..0x004596b0). Metropolis fires every
X1 round from `MUZZLE_OFFSET` / `MUZZLE_HEIGHT` (0.6 m / 0.6 m, balance.ts).
First establish which model those two blocks hold and where its point 0 lies
per cockpit frame (gen:x1 already carries the cockpit's point 0 for the lock
beam; the guns' points may need an RE export, which becomes an RE target if it
is not in the dump). Then the X1's rounds and lines start there. If the data
is not reachable yet, the step waits and the ledger row says "waits on RE"; the
trace (8.5) does not wait for it.

### 8.5 The call sites on the trace (SIM_VERSION bump, goldens)

One commit, one SIM_VERSION, golden replays regenerated in the same commit with
the justification in its message (CLAUDE.md determinism rule 6). Every one of
the first ten rows of the table goes onto `terrainTraceSegment` with the
original's `hit_floors`, its segment and its use of the hit point:

- `directShot`: from the muzzle (8.4, or today's point until then) to the end
  point; **with the scatter**: the two PRNG draws and the sphere of
  (`word_0e`, else the target's half height / 2), turned to the muzzle's side,
  as `player_fire_direct` does, and the Gatling Laser's `previous` end point.
  A blocked line ends at the hit point (the EV_SHOT reach in 3D), and a powered
  blast goes off there, as now.
- `hitscan`, the shooters' clear-line test, the instant arm: from their muzzle
  points (already the model's since SIM_VERSION 115/116) to the target's
  reference point (`previous`).
- `systemProjectiles` straight and arced rounds: the tick's segment from the old
  to the new position, floors on; the round dies at the hit point.
- `guidedTick`, `bounceTick`: floors off, as retail; their own height tests
  (below the floor, the bounce) stay as they are.
- The target searches: between the two reference points, floors off, and only
  in the modes that test a line (`cact_find_target`, mode != nearest).
- `sustain.ts` `wallT`: the node and the beam segments, floors on; the W1 row's
  stand-in is removed from the ledger.

What does **not** change: the lock (horizontal 12 m, the two cones, no line of
sight — `updateLock` is the original's already), the walker's and the hover's
movement, the units' movement on the road net.

### 8.6 Movement on the trace (later, its own decision)

`deckOverhead` (the walker's head trace) and the hover's ledge probes onto
`terrainTraceSegment` with their own `hit_floors`. This touches the movement
model that M3-OV/M3-PB settled over the lattice, so it gets its own ledger
reading before it starts; it is listed so the trace has one owner, not two.

### 8.7 The client (no hash)

`render/cameraTrace.ts` (`view_trace`, with the see-through bit 7 of the
material byte, which the trace's result word carries in bits 8..15) and the lock
beam's end on the same `terrainTraceSegment` over the map's `trace`, imported
from `@metropolis/sim` as a pure map query, the way `sampleHeight` is. This
retires the heightfield sampling and `viewTerrain.generated.ts`'s see-through
cells.

## Checks

- `bun test` with the ray fixtures (8.3), `bun run lint`, `typecheck`.
- `replay:verify` after 8.5 with the regenerated goldens; `browserVerify` and the
  headless smoke run.
- `gen:trace --check`, `gen:arena all --check` with `FCOP_RE_REPO`.
- Scenario tests (sim, deterministic), at least:
  - a hitscan shot from a deck edge down onto a target below hits (Hk);
  - a shot from under a deck at a target on it is stopped by the floor;
  - a shot across a kerb still hits, a shot into a building face is stopped,
    and the hit point lies on the face;
  - a mortar shell over a wall that is lower than its arc is not stopped;
  - a turret on a plinth sees and hits a mech below it.
- Pins: `bun run pin:drive` at the scenarios on Hk and la-cantina, before and
  after, so the owner can look at each.

## Risks

- **Balance.** Shots that were blocked at ledges now land, and shots through
  floors no longer do. Every turret on a plinth and every fight across a deck
  edge changes. That is the original's balance, which is the point, but the
  bots' behaviour should be watched in the smoke runs.
- **Performance.** A trace per live round per tick plus the searches. The DDA
  visits one cell per metre and tests at most eight plates a cell (the RE's
  `TRACE_MAX_CANDIDATES` note). Measure in the smoke run with every weapon firing.
- **The lattice and the plates are two descriptions of one terrain.** The lattice
  stays the walker's (8.6 decides later); every line goes to the plates. No sim
  data is duplicated: both are built from the same container by stage 1/2.

## PLAN.md

Phase 14 gets a wave 8 with one box per step (8.1-8.7), ticked as each lands.
