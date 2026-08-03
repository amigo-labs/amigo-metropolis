# Handoff — FCOP logic decode + arena-viz / terrain alignment

Status: historical working note. Superseded in part — read the ⚠️ below first.

⚠️ **2026-07-25.** Two claims here are wrong as stated, and both were load-bearing:

1. §2's ⛔CORRECTION (`off_X ≈ 96.5, NOT 112.5`) is right only for overlaying
   *actor-frame* data onto the *glb*. As a **terrain→sim** offset the nominal
   112.5 was correct all along: there are THREE frames, not two, and the sim
   heightfield sits one Til (+16 cells on X) east of the actor/glb frame. Measured
   offsets for all six arenas now live in
   `packages/client/src/render/mapAlign.generated.ts`, derived by correlating each
   mesh against its heightfield (`tools/generators/genMapAlign.ts`).
2. §3's "latent game bug" is **fixed** — and it was worse than described: as well
   as being ~8 cells off, the loader translated the mesh in Y, floating the art
   2.5 m above the collision surface.

Also stale: §4-§5's file lists, §6's `.bak` note, and the line below claiming
nothing was committed (the renders, `prep_viz.py` and `build_map.py` are in git).
Kept for the reasoning, not as instructions.

## 1. What is DONE and solid

Decoding of the original *Future Cop: L.A.P.D.* mission logic (see the full spec
`docs/specs/fcop-logic.md`, already written):

- **Parser** `tools/gfx/extract_logic.py` in the RE repo
  (`D:\github\amigo-labs\fcop-reverse-engineering`) decodes `Cact`/`Csac` (actors)
  and `Cnet` (waypoint graph) for all 16 mission containers →
  `extracted/logic/<Map>/{actors,nets}.json` + `summary.json`.
- Decoded per actor: type (full ACT registry), world position, and per-type params:
  turrets (engage_range/targeting_delay/turn_speed/weapon_id), pathed units
  (move_speed + `Cnet` ref via `rsl[2]`), aircraft (orbit_area/turn_rate/…),
  ItemPickup (`grants` bitfield), Trigger (volume + `triggering_actor_id`),
  and the **TeamBase (act_type 28)** — 2/arena, team-symmetric, HP 3000, 4 built-in
  defence weapons, 5 s spawn cadence, bound to its team `Cnet`.
- **"Enemy-in-base alert" mechanic** = `Trigger` (95) volumes around each base
  watching the enemy X1Alpha + enemy units; sound is wired in `Cfun` (not decoded).
- Layout/behaviour reference came from Ghoster738/Future-Cop-MIT, cloned at
  `D:\github\Future-Cop-MIT`.
- Memories written: `fcop-original-lanes-cnet`, `meshmap-alignment-bug`,
  `fcop-re-repo`.

## 2. THE KEY RESULT (the thing that was missing) — coordinate transform

The arena-visualisation work kept mis-aligning because two coordinate frames were
conflated. Now resolved exactly (verified against the committed `la-cantina.glb`
bounds — exact match):

- **Raw actor coords** = `(posX/8192, posY/8192)` = **0-based grid cell (col, row)**.
  **Cnet nodes** `(x/32, y/32)` are the SAME cell frame (`node_raw = actor_raw>>8`).
- **Sim map frame** (`packages/sim/maps/*.json`, `cellSize=1`) is **also the 0-based
  grid** — `convert.ts` pads the short axis by edge-repeat with **no offset/flip**.
  ⇒ **raw actor/Cnet coords ≈ sim cell coords directly** (X1Alpha raw (96,69) = sim
  spawn (96.5,69.5)).
- **The committed terrain `.glb` (`public/models/<map>/<map>.glb`) is CENTERED**
  (grid centre at origin), produced by `til_mesh.py` `assemble_map`. Net transform
  is a pure centering translation — **no axis swap, no sign flip**:
  ```
  glb_X = col - (8*gw + 8.5)
  glb_Z = row - (8*gh + 8.5)      (col→X, row→Z)   glb_Y = height (ignore)
  ```
  where `gw`/`gh` = Cptc GRDB grid size in Til units.
- **La Cantina (Mp): gw=13, gh=15** ⇒ offsets **X:112.5, Z:128.5**. glb spans
  X∈[-96.5,95.5], Z∈[-128.5,95.5].

### Consequence — how to align raw lanes/triggers with the terrain (the correct fix)
Everything (raw data AND sim) lives in the **0-based grid frame**. Only the `.glb`
is centered. So to overlay:
- **Place raw data at (col, row) unchanged**, and **shift the terrain glb by
  (+112.5, +128.5)** (undo centering) — OR shift raw data by (−112.5,−128.5) to the
  glb frame. For Mp specifically.
- Do NOT use bbox-centering and do NOT use the earlier heightfield-correlation
  `(−7,−8)` — those were the wrong approach and produced the apron misalignment the
  user (correctly) rejected.

⚠️ Watch the glTF import/export axis convention in Blender (Blender Y = −glTF Z).
Re-verify orientation per map; La Cantina is row-symmetric so a Y-flip hides itself.

### ⛔ CORRECTION (2026-07-22, verified in Blender against the textured glb)
The nominal formula `off = 8*gw + 8.5` is **WRONG on the padded/short axis**. For Mp
it gave **off_X = 112.5, which is one Til (16 cells) too large** — data landed ~16
cells left, into the edge-repeat apron. The **Z offset 128.5 was correct**.

Correct, robust method: **align the logic bounding-box centre to the glb
bounding-box centre** (both the art and the logic are symmetric about the arena
centre — do NOT trust the nominal grid formula on the padded axis):
- Logic bbox centre (all Cact actors + Cnet nodes): **col 96.16, row 112.03**.
- glb bbox centre in Blender: **X −0.5, Y 16.5** (measured: X∈[−96.5,95.5],
  Y∈[−95.5,128.5] after the glTF Z→−Y import flip).
- Mapping used (verified: turrets land dead-centre on octagon pads, bases on the
  team-tinted base structures, lanes trace the road channels):
  ```
  bx = col - 96.66   (= col - logic_cx + glb_cx)     # off_X ≈ 96.5, NOT 112.5
  by = 128.53 - row  (= -(row - logic_cy) + glb_cy)  # unchanged, ≈ 128.5
  ```
This is NOT the same as meshMap.ts's bbox-centering (§3): meshMap centres the glb on
`worldExtent/2` (the sim GRID centre, 120.5 for size 241), whereas the fix centres it
on the GAMEPLAY/logic content centre. Centring on grid-centre is exactly why §3 is off.

## 3. Latent game bug (candidate, not yet fixed)

`packages/client/src/render/meshMap.ts` centers the terrain by **bounding-box**
(`half - bbox.centre`). The CORRECT centering is the deterministic grid centering
above (`8*gw+8.5`). bbox-centering is off because the apron is asymmetric in the
padded grid → the in-game textured terrain is likely ~7–8 cells off the sim
collision/entities. See memory `meshmap-alignment-bug`. Proper fix belongs in the
asset pipeline (`til_mesh.py` emit cell-aligned glb) + `meshMap.ts` load at identity.

## 4. Blender viz state (scratchpad only, will be lost)

All renders + trial GLBs are in the session scratchpad (temporary):
`…/scratchpad/lacantina_*.png`, `la-cantina-clean*.glb`. These used the WRONG
alignment — regenerate with the §2 transform next time. Blender scene has leftover
objects (`Mesh_0*`, `CLEAN_check`, `CROP2`, collections `LaCantina_Triggers`,
`LaCantina_Lanes`, `DBG_turr`) — clear and rebuild.

## 5. Next step — ✅ DONE (2026-07-22)

Goal the user asked for: **isometric 3D view of ALL triggers + lanes on the clean
textured La Cantina map, correctly aligned.** — delivered.

Renders committed to `docs/renders/fcop-viz/`:
- `la-cantina-iso.png` — isometric beauty shot (all overlays on textured terrain).
- `la-cantina-top.png` — top-down (clearest alignment proof; full PA layout reads).
- `la-cantina-terrain-only.png` — bare terrain (bilateral symmetry, blue/red bases).
- `la-cantina-turret-pad-alignment.png` — zoom proving neutral turrets sit on pads.
- `prep_viz.py` + `viz_data.json` — data-prep step (reads RE-repo Mp/{actors,nets}.json,
  emits grid-frame overlay data). Re-run `prep_viz.py` to regenerate.

How it was built (all in the session Blender scene, temporary — rebuild from the two
files above if needed):
1. Import `public/models/la-cantina/la-cantina.glb` (imports as one mesh `Mesh_0`;
   glb bbox in Blender X∈[−96.5,95.5], Y∈[−95.5,128.5], Z∈[−2.5,3.9]).
2. Map every raw `(col,row)` → Blender via the **§2-CORRECTION** mapping
   (`bx = col − 96.66`, `by = 128.53 − row`), raycast Z onto the terrain.
3. Lanes = mesh(verts=Cnet nodes, edges=adjacency) + Skin+Subsurf tubes; triggers =
   true-footprint cubes (visible height 3.5) coloured by kind (proximity/watch/button);
   turret/base/spawn/pickup markers as emissive prims.
4. ✅ Verified: neutral turrets (type 36) sit dead-centre on octagon pads; bases on the
   team-tinted base structures; lanes trace the road channels; spawns at base mouths.

Open (lower priority): the meshMap fix (§3) — now with a concrete target (centre the
glb on the gameplay/logic content centre, not `worldExtent/2`); other 5 arenas need
their own logic-bbox-centre computed the same way; `Cfun` scripting still undecoded.

## 6. Terrain decks and per-deck walls (added 2026-08-03, issue #29)

The heightmap dump `extracted/heightmaps/<Map>_terrain.json` has since grown the
fields that let a bridged arena be converted as one:

| field | meaning |
|---|---|
| `walk_height` | the walkable FLOOR per point, int8 in 1/32 m — this is rank 0 |
| `layers[]` | the EXTRA stacked surfaces, rank 1..N: `heights`, `mask`, and now `wallsV`/`wallsH` |
| `wallsV`/`wallsH` (top level) | the UNION of the wall lattice over every deck |
| `rank0_wallsV`/`rank0_wallsH` | the subset standing on the GROUND deck |
| `tile_effects` | `Ctil` SLFX/ScTA animated tile surfaces (not consumed yet) |

`union(rank0, layers[])` equals the top-level pair **exactly on all 15 missions**;
a wall separating two decks belongs to both, and the extractor's 16 orphan edges
are attributed to rank 0. That identity is re-checked in-tree for Mp by
`tools/generators/test/fcopWalls.test.ts`, so the split can never quietly lose a
wall.

Stage 1 takes `rank0_walls*` as the map's own `wallsV/H` for a `layered` arena and
carries each deck's lattice in `layers[]`; a single-storey arena still takes the
union, so their committed lattices are untouched. Charging a bridge's parapets to
the road running underneath is what used to make the original's roads look walled
off, and it cost la-cantina 56 carved wall bits plus 10 more to reconnect its ring
— now 37 and 2.

### `MULTI_THRESH`, and one circular argument it caused

`til_mesh.py` splits a point's stacked surfaces into ranks only where they are more
than `MULTI_THRESH = 16` quanta (0.5 m) apart, and **deliberately keeps a ramp's
continuous run inside one rank**. Two consequences worth knowing before measuring
anything about decks:

1. No deck can ever be within `STEP_SNAP` (0.35 m) of the floor beneath it. That
   is the extractor's constant, not a property of any arena — `layeredArenas.test.ts`
   once used it as proof that decks were unreachable, which could not have come out
   any other way.
2. Because ramps stay in rank 0, a deck is entered **sideways** at its edge, where
   the ground has risen to meet it. Measured entry cells: la-cantina 1180, Hk
   616 + 1374, Ovmp 998 + 130. `resolveWalker` already makes that transition; what
   could not see it was the reachability flood, now `packages/sim/src/reach.ts`.

### Actor deck membership

ACT `pos_h` (exported as `height`) is **0.0 on every actor of every PC mission**, so
which storey an actor belongs to cannot be read from the container at all. It is
inferred from the terrain instead: `annotate_actor_layers.py` →
`extracted/logic/<Map>/actors.layered.json` (`layer` = lowest surface at the cell,
`layer_top` = highest) plus `extracted/logic/layer_report.md`. Sampling carries the
`+16`-cell X offset between the actor frame and the heightfield grid.

Counts that matter for the remaining import work: on Mp only 15 of 254 actors sit
on a cell with a deck overhead and **all 15 are scenery** (9 `DynamicProp`, 6
`PathedActor`), which is why la-cantina needed no per-feature layer field. Hk has
69 of 592 — including 8 `Turret`, 3 `NeutralTurret` and 2 `TeamBase?` — and Ovmp 5
of 265. Those are issue #33's.

## 7. Note
`public/models/la-cantina/` has stray `tex0X.png.bak` backups committed alongside
the active textures — probably unintended.
