# Open items after Phase 14 waves 4–7

> Status: **group A worked through 2026-10-25/26 (PR #71, SIM_VERSION 99)**,
> items 10 and 11 to the end (the skeleton shatter of item 9 too), and a
> reported fall through urban-jungle's ring grates fixed (fidelity P16); groups
> B–E open. Collected 2026-10-19 after PR #68 (Metropolis, SIM_VERSION 91) and
> amigo-labs/fcop-reverse-engineering#84 were merged. Each item names where it is
> recorded: the ledger row in `docs/specs/fcop-fidelity.md`, a `PLAN.md` box, or
> both. In group A every item is marked done, deferred with its reason, or moved
> to B or C (listed again at the end of those groups).

The owner's rule stands: only the original counts. The exceptions are online 1v1
and its lobby, the debug tools, and the HD textures as an option. Every item below
either brings Metropolis closer to the original or closes a question the RE has
not answered yet.

## A. Metropolis only (the RE data is already there)

1. ~~**3DAL colour animations on facers.**~~ **Done** ("Pulse the mine's star
   with its 3DAL colour animation").
   Was: **3DAL colour animations on facers.** `cobj_tick_color_anims` 0x0041a1a0 runs a
   triangle wave of `clock * speed` over a primitive's bytes 5..7, on 36 models. The
   only one drawn in PA is the mine's star (Mp 50, grey → magenta, speed 16). The
   colours are in the RE manifest's `color_anims`, not in the glb.
   - Work: carry `color_anims` through `gen:units` / `gen:paunits` and animate
     them in `render/facers.ts`. Allocate nothing in the frame loop.
   - Ledger: G13.
2. ~~**Riot Shield toggle-off sound.**~~ **Done** ("Sound the Riot Shield's
   block on every call"): EV_SHOT on every call; events are not hashed.
   Was: **Riot Shield toggle-off sound.** The original plays the block's sound on every
   call. Metropolis is silent when the call finds the sphere down.
   - Ledger: W5 (declared), A21.
3. ~~**Powered Fusion Torpedo / Plasma Flare rounds.**~~ **Done** ("Draw the
   powered torpedo's and flare's round as Cobj 47's star"): block B's rounds
   wear `fx/star-47.glb`, the blue star.
   - Ledger: W5.
4. ~~**Riot Shield arcs.**~~ **Done** ("Draw the Riot Shield's arcs on its
   sphere"): `EV_SHIELD_ARC_STEP` draws each arc's step, and `EV_SHIELD_ARC`
   carries the taken arc's angles. Events are not hashed: no golden moved.
   - Ledger: W5.
5. ~~**K-9 Drone model.**~~ **Done** ("Run the K-9 Drone's eleven-frame
   morph"): a frame per 870 world units travelled, as `missile.c` steps it.
   - Ledger: W5.
6. ~~**Radar live-list order.**~~ **Done** ("Walk the radar's registry in
   creation order, with the actors that have no entity"). The live list is
   oldest first (`cact_link` appends at the tail), the reverse of what
   Metropolis assumed. **Moved to C:** which actors carry flag 8 at load, and
   the RE's own contradiction (mission_frame.c says newest first).
   Was: **Radar live-list order.** The registry's order is approximated by descending
   entity id. Actors with no Metropolis entity are not counted: the X1's partner,
   the turret parts, and the flag-8 actors that are never culled.
   - Ledger: V3.
7. **Map-screen arrows.** They use frame 0's 3DBB box only, and a Prop's cell
   comes from its model origin, not its box centre. The emitter's 4 m leaf test is
   approximated by a 2.83 m sphere.
   - ~~A Prop's cell~~ **Done** ("Hang each Prop in the cell of its box's placed
     centre"): 22 Props change cells, Hk's lamps among them.
   - **Moved to B (RE export first):** the arrows' per-frame boxes. The RE
     object manifests carry frame 0's 3DBB box only.
   - **Moved to C (RE question):** the 4 m leaf test. The terrain quadtree walk
     that builds the leaf mask (0x00452de0) is still a stub in the RE.
   - Ledger: V4, G13.
8. **Facer depth sort and DCSQuad depth.** The original sorts each facer at its
   centre's depth less 0x100. Metropolis uses the depth buffer after the opaque
   scene, and a polygon offset stands in for the DCSQuads' drawer depth.
   - **Deferred (architecture):** every record of the original is sorted by its
     mean depth less a bias: a model's faces and facers alike
     (`CACT_MODEL_DEPTH_BIAS` 0x100), the DCSQuads (`PYRO_DRAW_DEPTH_BIAS`
     0x100), the terrain without. That is a painter's sort per face, which a
     depth buffer cannot reproduce per pixel. A constant depth pull of the bias
     would show models through walls, which is worse than the declared gap.
     What a z-buffer could take is only the order of overlapping half-alpha
     facers among themselves, a small gain for a per-frame sort.
   - Ledger: G13 (not modelled).
9. **Effects not drawn yet.** All are declared in the ledger:
   - **Done:** the node ramp's stagger ("Ramp the node bursts one frame in
     four") and the lapsed owner's bank 0 ("Raise a dead owner's round in
     bank 0").
   - **Moved to C (RE question), the killer's push:** the push needs the
     killer to be a type-2 actor found by its serial at the victim's death
     check (`cact_base_op4` 0x0041a309). A round that strikes expires and dies
     a frame later, and a blast comes after the round has died, so whether the
     push ever applies, and to which kills, turns on that timing.
   - **Done, the skeleton shatter:** "Break the wrecked X1's cockpit bone by
     bone" (`render/fx/skeletonShatter.ts`, RE `shatter.c`). The record is
     1:8, chained from 1:9 on the X1's partner, so it is the cockpit that
     breaks, not the legs.
   - **Moved to B (RE export first), a quad flying as one face:** the glbs are
     triangles and carry no triangle-to-primitive map to pair them back.
   - **No change needed, type 7's range kill:** it raises nothing, and
     Metropolis' arced rounds land before their lifetime, so nothing differs on
     screen.
   Was:
   - the killer's push (0x00437aa0): the death event names no killer round;
   - the skeleton shatter (0x004298c0): the X1's 1:8 pieces fly as faces;
   - a quad flying as one face: it flies as two triangles;
   - the node ramp's one-in-four stagger;
   - type 7's range kill;
   - a lapsed owner falling back to bank 0.
   - Ledger: E7, E10, E20.
   - Some of these need a sim event field. That means a SIM_VERSION bump with
     goldens re-recorded in the same commit.
10. **Extra weapons, small sim gaps.** Each is a SIM_VERSION bump if adopted:
    - ~~the grenade bounces without its model radius~~ **Done** ("Stand the
      bouncing round on its model's radius", SIM_VERSION 92).
    - **Done, the shield and the target's reference heights** (SIM_VERSION
      98): one sim-wide change, as planned. gen:pamodels reads each role's
      box-0 centre y (`refs`), and stage 2 carries it as `refHeights`. Every
      aim and the sphere reach for the target's reference point, which the
      original places unshifted (`math_matrix_place_point` 0x00458850), so a
      few centimetres over its position rather than the muzzle's 0.6 m.
    - **Done, the drone's ground** (SIM_VERSION 97): no RE export was needed,
      since the mission containers are in the RE repo. gen:coarse
      (`tools/generators/fcopCoarse.ts`) builds `cact_coarse_height_build`'s
      field (0x00455e00) from the Cptc and Ctil sections, stage 2 carries it
      into each map, and the drone samples it with `coarseHeightAt`
      (0x00456180).
    - **Done, the drone's health loss** (SIM_VERSION 96): the RE settles the
      order. The pair walk (`objects_pick_targets` 0x0044fe40 over
      `paint_grid_insert`'s 4 m cells) tells the body in the earlier cell
      first, and in one cell the later-made.
    - Ledger: W5.
11. **Kerbs and spilled walls** on la-cantina, Hk and Ovmp. Each opens when its
    arena is re-imported (`FcopArena.kerbs`).
    - ~~la-cantina~~ **Done** ("Open la-cantina's kerbs", SIM_VERSION 93: 2334
      wall bits).
    - **Done, Hk and Ovmp** (SIM_VERSION 95): stage 1 re-run against the RE
      dump gives their decks their own walls (the union is the old lattice bit
      for bit), and the kerb pass opens 9932 and 8159 bits.
    - **Done, the ground's kerbs on every arena** (SIM_VERSION 94): the "same
      map byte for byte" was not the missing decks. Stage 2's road carve read
      the bare snapshot and wrote it back over the ground lattice, so the
      ground lost its kerbs and lift shafts on every arena; only the decks
      kept theirs. The carve now builds on them and opens far less (Conft
      199 → 43, Mp 36 → 12).
    - Ledger: P15. PLAN.md Phase 14 wave 2, open box.

## B. Needs an RE export first (then a Metropolis pass)

12. **The X1-Alpha's draw modes.** The X1's parts still go through the RE's old
    export path (`extracted/x1`), so the X1 draws opaque. Its legs are half-alpha
    throughout, and Cobj 15/16 sit on layer 1.
    - RE: export `extracted/x1` with the face modes, as `tools/gfx/obj_mesh.py`
      now does for the object glbs.
    - Metropolis: `gen:x1`, then `render/avatarRig.ts` materials.
    - Ledger: G13.
13. **Lighting materials 0..5.** They shade the vertex colour and are not
    exported. The faces keep the loaders' lighting, and the facers draw unlit.
    - Ledger: G13.
13a. **Moved from group A (2026-10-25):**
    - the map screen's per-frame 3DBB boxes (item 7): the object manifests
      carry frame 0's box only;
    - a shatter quad flying as one face (item 9): the glbs carry no
      triangle-to-primitive map;
    - ~~the coarse height field per map (item 10), for the K-9 Drone's
      ground~~ **done** from the containers themselves (gen:coarse,
      SIM_VERSION 97).

## C. Open questions in the RE (research; Metropolis keeps its value until then)

14. **THRASH blend states 0x194 / 0x195** (`draw_submit.c`): how the D3D path
    draws a bit-15 texel. Answering it means decompiling the DLL.
15. **Add-tint doubling.** THRASH doubles it (0x00456a49); Glide's textured 0x30
    arm does not (0x004399c5). The export and Metropolis follow THRASH.
16. **The software walk's mode 12** on the 88 material-5 bit-3 faces.
17. **The screen flash strip:** is it added at its alpha 0x80 or whole? This is
    the same question as for every additive record.
    - Ledger: E19.
18. **Which campaign mission raises GlblData 0:83**, and so the flash.
19. **Armed mines.** Does an armed mine wait for a victim? It depends on the mine's
    gravity statistic: a dropped round at rest expires (0x00424606). Metropolis
    despawns a forgotten mine silently.
    - Ledger: E20, W1.
20. **Type 88 `word_14`**: an offsets array that no drawer reads.
21. **Gun slot code order.** The front end's codes and the EXE's name table
    disagree.
    - Ledger: F7.
22. **The dialog fonts' metrics** (Small Fonts / Courier sizes).
    - Ledger: F14.
23. **Remaining RE questions in the ledger's "Still open in the RE" section:**
    - the speed of the Sky Captain's weapons 8/9 and its turn rate;
    - the player-block words that make the captain ignore a player;
    - how the flamethrower, beam and shockwave spread damage over time;
    - how retail's six-slot weapon table serves the other nine weapons;
    - jet behaviour beyond routing;
    - the voice lines' content;
    - audio: the X1's walker loop codes (A9), the listener's facing (A15),
      whether a channel is ever freed (A16), and the crash tumble (A19).
23a. **Moved from group A (2026-10-25):**
    - the terrain quadtree walk that builds the 4 m leaf mask (0x00452de0, a
      stub in the RE), for the Props' and emitters' view test (item 7);
    - which actors carry flag 8 (never culled) at load, and mission_frame.c's
      "newest first" against `cact_link`'s tail append (item 6);
    - the killer's push (item 9): whether the killing type-2 round is still
      found by its serial at the victim's death check;
    - ~~the K-9 Drone's health loss: the order of its two notices (item 10)~~
      **answered and done** (SIM_VERSION 96: the pair walk's order).

## D. Older PLAN.md boxes still open

24. **Movies:** HELP / BRIEFING's `multibrf.mpg` and the film strip's `po_*.mpg`.
    They are not in the repo, so the files are needed first.
    - Ledger: F10. PLAN.md wave 7.
25. **The owner's side-by-side look** against the original.
    - PLAN.md wave 6.
26. **`hollywood-keys` and `venice-beach` deck import.** Blocked: their decks sit
    above the base surface, and the lane nodes land on the canal floor.
    - PLAN.md Phase 13.
27. **Close issue #27.**
    - PLAN.md Phase 14 wave 1.
28. **Older boxes from before the original's assets arrived.** Check whether these
    are obsolete and tick or drop them:
    - "Pincel texture atlases + shared palette", PLAN.md Phase 7;
    - "Original `Cwav` sound effects", PLAN.md Phase 12.

## E. Infrastructure

29. **The RE repo's CI has no runner.** Every job ends after about 3 s with
    `runner_id: 0`, so PR CI never runs a test there. Local runs are the only
    gate: full `ctest`, 585 tests at 04711ef. The owner has to assign a runner in
    the repository or organisation settings.

## How to run a pass (unchanged from waves 4–7)

- **Branches:** one per repo, freshly cut from `main`.
- **Agents:** one per item group, each in its own worktree. Agents never push; the
  integrator cherry-picks.
- **Checks on every integration:**
  - `bun run lint`, at the 15-warning baseline;
  - `typecheck`;
  - `bun test`;
  - `replay:verify`;
  - `gen:arena all --check`;
  - every `gen:*` `--check` with `FCOP_RE_REPO`;
  - `browserVerify`, after any sim change;
  - the headless smoke run.
- **RE:** `ctest`, `docmap --check` and `hygiene`. Reserve each write-up tag once
  only: the last wave tagged two write-ups M3-OJ.
