# Open items after Phase 14 waves 4–7

> Status: **group A worked through 2026-10-25/26 (PR #71, SIM_VERSION 99)**,
> items 10 and 11 to the end (the skeleton shatter of item 9 too), and a
> reported fall through urban-jungle's ring grates fixed (fidelity P16).
> **Groups B–E worked through 2026-10-26** (amigo-metropolis#73,
> fcop-reverse-engineering#86 and #87, SIM_VERSION 104): every item is done,
> answered from the binary, or names what still blocks it — 25 (the owner's look)
> and 29 (the RE CI's runner) are the owner's; a few remainders are noted in
> 12, 13, 13a, 22 and 23. What still keeps Metropolis apart from the original is
> ordered in `fidelity-gaps-2026-10.md`. Collected 2026-10-19 after PR #68 (Metropolis, SIM_VERSION 91) and
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
   - ~~Moved to B (RE export first): the arrows' per-frame boxes.~~ **Done**
     ("Build the map-screen arrows on the box of the current frame"; 13a).
   - ~~Moved to C (RE question): the 4 m leaf test.~~ **Done** ("Draw and voice
     the Props by their cell's quadtree leaves"; 23a).
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
   - ~~Moved to C (RE question)~~ **Done** (23a, "Push a missile's victim's
     shatter the missile's way"), **the killer's push:** the push needs the
     killer to be a type-2 actor found by its serial at the victim's death
     check (`cact_base_op4` 0x0041a309). A round that strikes expires and dies
     a frame later, and a blast comes after the round has died, so whether the
     push ever applies, and to which kills, turns on that timing.
   - **Done, the skeleton shatter:** "Break the wrecked X1's cockpit bone by
     bone" (`render/fx/skeletonShatter.ts`, RE `shatter.c`). The record is
     1:8, chained from 1:9 on the X1's partner, so it is the cockpit that
     breaks, not the legs.
   - ~~Moved to B (RE export first), a quad flying as one face~~ **Done for the
     skeleton shatter** (13a, "Test the skeleton shatter's quads whole"); the
     faces shatter's units carry no face map yet.
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

12. ~~**The X1-Alpha's draw modes.**~~ **Done** (RE "tools/gfx: export the X1's
    parts with the faces' draw modes and layers", fcop-reverse-engineering#86;
    "Draw the X1-Alpha's faces in the original's draw modes and layers").
    - **Export:** `extracted/x1` carries each face's mode and layer.
    - **Drawing:** the rig draws a geometry group per mode, with the half faces
      in two passes.
    - **Layers:** the shader gates op1 bits 4..6 by the partner's masks
      (`player_partner_draw` 0x00447bf3..0x00447c41). Walker / ramp / hover:
      legs 3 / 7 / 5, cockpit 5 / 0xf / 0xb; guns and beacon 1. The gate itself
      is in `cact_model_draw_prims` 0x004284b0.
    - **Shatter:** the cockpit's shatter draws every layer (mask 0xff,
      0x004385cb).
    - **Alloc fix:** "Keep the X1's frame loop off paths it reaches only at a
      transform" fixed the frame loop's JIT deopts that the port exposed.
      `x1Alloc` still sees a residual ~2.5 % of dirty processes, against ~10 %
      on main before.
    - Ledger: G13.
13. ~~**Lighting materials 0..5.**~~ **Done** (RE M3-OL; "Carry the faces'
    lighting inputs into the models", "Shade the models' faces with the
    original's one light").
    - **Selector:** op0 bits 4..6 index the table at 0x0042900c: grey or colour,
      unlit, lit at n[0], or lit per corner.
    - **Shade:** 0x00427fb0 / 0x00428000, against one light fixed in the world
      (0x0048b7a8, from above, the same in every mission). The floor is 0x20,
      0x80 is unity, and a lit colour loses its blue.
    - **Export:** the object glbs carry `_FCOP_LIGHT` and the lit NORMAL.
    - **Drawing:** `render/fcopModel.ts` shades every FCOP model's faces with
      them.
    - **Facers:** the original lights none, so drawing them unlit is exact.
    - **Still open:** the X1 keeps three's lighting until `extract_x1.py`
      exports the same attribute and `avatarRig.ts` shades it.
    - Ledger: G13.
13a. **Moved from group A (2026-10-25):**
    - ~~the map screen's per-frame 3DBB boxes (item 7)~~ **Done** (RE M3-OM;
      "Build the map-screen arrows on the box of the current frame").
      - The table is box-major (`pause_map_draw_actor` 0x0045180d), and RE
        `bboxes.json` carries every Cobj's table.
      - Nothing moves on screen: Cobj 28's six cloth frames share one box 0.
    - ~~a shatter quad flying as one face (item 9)~~ **Done for the skeleton
      shatter** (RE M3-OM; "Test the skeleton shatter's quads whole").
      - `gen:x1` pairs the triangles back to their 3DQL primitives
        (`_X1FACE`), and a quad is tested whole as the original does
        (0x00429e54..0x00429ed9).
      - No cockpit face changes: all 43 quads lie in one bone each.
      - **Still open, the faces shatter:** the units' glbs carry no face map.
        That needs a face index in every RE object glb.
    - ~~the coarse height field per map (item 10), for the K-9 Drone's
      ground~~ **done** from the containers themselves (gen:coarse,
      SIM_VERSION 97).

## C. Open questions in the RE (research; Metropolis keeps its value until then)

14. ~~**THRASH blend states 0x194 / 0x195**~~ **Answered** (RE M3-OO, read off
    `d3da.dll`).
    - **States:** 0x194 / 0x195 are SRCBLEND / DESTBLEND.
    - **Pairs:** blend byte 2 is (ONE, ONE), 3 is (ZERO, INVSRCCOLOR), the rest
      (SRCALPHA, INVSRCALPHA).
    - **Bit-15 texels:** THRASH pages are ARGB4444 (0x00415751), so D3D blends a
      bit-15 texel at 8/15 on every textured face.
    - **Metropolis:** keeps the Glide / software reading.
    - Ledger: G13, G3.
15. ~~**Add-tint doubling.**~~ **Answered** (M3-OO).
    - **Doubled** on THRASH (d3da modulates by `rgb_doubled`) and in software.
    - **Undoubled** on Glide only.
    - Which path a retail PC ran is its configuration (`Group` /
      `Thrash Driver`), not the binary. Metropolis keeps the doubling.
16. ~~**The software walk's mode 12**~~ **Answered** (M3-OO): opaque in
    software (0x0040d986), half on Glide and D3D. Metropolis keeps half.
17. ~~**The screen flash strip**~~ **Answered** (M3-OO): it is added whole, as
    (ONE, ONE) on D3D and Glide alike, which is how Metropolis draws it.
    - Ledger: E19.
18. ~~**Which campaign mission raises GlblData 0:83**~~ **Answered** (RE M3-OP).
    - **Who raises it:** only the class table, through `cact_effect_emit`
      0x0042b910.
    - **Which missions:** only M3a's turrets, tanks and type-31 actor, and Un's
      type-11 actors, carry a class that names it.
    - **So:** the flash never shows in Precinct Assault.
    - Ledger: E19.
19. ~~**Armed mines.**~~ **Done** (RE M3-OP; "Drop the Pop-Up Mine as the
    original's bouncing round", SIM_VERSION 101).
    - **The original:** the mine's gravity is fixed (0x0044d746), not a
      statistic. It never waits: it blows on the tick it comes to rest
      (0x00424606).
    - **Metropolis:** the mine drops from the muzzle, bounces and blows where it
      settles (~1.4 s on flat ground). A sprung mine pops up and blows 1 s
      later.
    - **Removed:** the arming delay and the silent despawn.
    - Ledger: E20, W1.
20. ~~**Type 88 `word_14`**~~ **Answered** (RE M3-EH, M3-OP).
    - It is the strands' drift rate, read by the link's tick at 0x0043d61d.
    - The docs and the export were stale and are corrected.
    - Metropolis' strands do not drift yet (E5).
21. ~~**Gun slot code order.**~~ **Done** (RE M3-OQ; "Send the loadout as the
    original's codes", protocol 5).
    - **Cause:** there was no disagreement in the game. The RE export wrote
      `slot << 4 | entry`.
    - **The game:** it saves an entry as the code `frontend_commit_loadout`
      (0x0040c2d0) looks it up in:
      - 0, 2, 1, 3, 5;
      - 0x10, 0x12..0x15;
      - 0x20, 0x22, 0x21, 0x23, 0x24.
    - **Check:** with those codes, the pictures, the EXE's name table and the
      sim catalogue agree on all fifteen.
    - **Metropolis:** the lobby's loadout messages carry them. No sim or replay
      change.
    - Ledger: F7.
22. ~~**The dialog fonts' metrics**~~ **Answered: not in the executable** (RE
    M3-OQ).
    - No code sets a dialog font, so USER32 takes the base units from the
      system's raster fonts.
    - Metropolis' estimates stay until someone measures on Windows 9x
      (MapDialogRect of (4, 8) in dialogs 0x71 and 0xa5).
    - Ledger: F14.
23. **Remaining RE questions in the ledger's "Still open in the RE" section:**
    - ~~the speed of the Sky Captain's weapons 8/9 and its turn rate~~ **Done**
      (RE M3-OR).
      - SIM_VERSION 102: the missile flies at 15.82 m/s, launched at its cap,
        and the bomb is the original's arced round.
      - SIM_VERSION 103: every aircraft turns by the original's heading step,
        not an angular rate. Jets turn at 5120, the captain at 4096 with its
        ×4 boost home.
    - ~~the player-block words that make the captain ignore a player~~
      **Answered** (RE M3-OR): they are the cloak and invulnerability timers,
      as P7 already modelled.
    - ~~how the flamethrower, beam and shockwave spread damage over time~~
      **Answered** (RE M3-OR, ledger W1). Not modelled in the sim yet: it
      needs trails and shells there.
      - **Flamethrower:** a trail node every 2 frames, each hurting a body once.
      - **Beam:** once per body per shot.
      - **Shockwave:** a shell blasting every fourth frame. Its start radius
        waits on the raiser's scale (M3-OK).
    - ~~how retail's six-slot weapon table serves the other nine weapons~~
      **Answered** (RE M3-OR): each type-99 record's load gate on state words
      10..15 loads only the two players' loadouts.
    - ~~jet behaviour beyond routing~~ **Done** (RE M3-OR; SIM_VERSION 104):
      - the ENGAGE / CRUISE dwell;
      - the search that replaces the target;
      - the patrol box's axes.
    - **Not RE, the voice lines' content:** there is no speech-to-text here.
      The event map is `pa_voice_triggers.json` (84 lines played, 2 never), and
      the words need a listener.
    - ~~audio: A9, A15, A16, A19~~ **Answered** (RE M3-OQ):
      - A9: nothing open.
      - A15: the facing is the slot's chase-camera yaw. Metropolis already
        matches; RE `loop.c` is fixed.
      - A16: confirmed, a channel is never freed by its sound ending.
      - A19: the tumble and its effects on impact are decompiled. Moving them
        into Metropolis needs a sim tumble, which is Metropolis' own gap.
23a. **Moved from group A (2026-10-25):**
    - ~~the terrain quadtree walk that builds the 4 m leaf mask (0x00452de0, a
      stub in the RE), for the Props' and emitters' view test (item 7)~~
      **Done** (RE M3-ON; "Draw and voice the Props by their cell's quadtree
      leaves").
      - 0x00452de0 had landed in M3-E. It was re-read and is unchanged.
      - RE error fixed: `DRAW_LEAF_SOURCE` had each nibble backwards. Leaf
        (x, z) is 0x8000 >> (4x + z) (0x00452cb3..0x00452d7e).
      - A Prop is drawn, and claims its voice, where its footprint meets a
        visible leaf of its cell's quadtree.
    - ~~which actors carry flag 8 (never culled) at load, and mission_frame.c's
      "newest first"~~ **Done** (RE M3-OP; "Keep the radar registry's flag-8
      actors at any distance").
      - **Never culled:** every unit, turret, Sky Captain, round and Dreadnought
        mount, plus 8 type-11 records.
      - **Culled:** never an X1, partner, turret base part or pickup.
      - "Newest first" is retracted in the RE.
    - ~~the killer's push (item 9)~~ **Done** (RE M3-OP; "Push a missile's
      victim's shatter the missile's way", render only).
      - It happens only on a missile-class round's killing contact with an
        older body.
      - Blasts never push, because they credit the owner.
      - It moves only the death record's shatter faces.
    - ~~the K-9 Drone's health loss: the order of its two notices (item 10)~~
      **answered and done** (SIM_VERSION 96: the pair walk's order).

## D. Older PLAN.md boxes still open

24. ~~**Movies:** HELP / BRIEFING's `multibrf.mpg` and the film strip's
    `po_*.mpg`.~~ **Done** (RE M3-OS; "Re-encode the original's 27 movies to AV1
    for the browser", "Play the original's movies where the original does").
    - **The original:** `docs/formats/movies.md` covers `movie_play` 0x00408800
      and its ten call sites, their rectangles, the Movies-slider volume and the
      skips.
    - **Storage:** the owner supplied the files. As decided, only AV1 + AAC
      re-encodes are committed (`gen:movies`, 165 MB → 22.8 MB). The RE repo
      keeps a manifest, not the movies.
    - **Where they play:** at boot, on HELP / BRIEFING, from the film strip and
      after a won round that finishes a map.
    - **Fallback:** without an AV1 decoder, or offline, there is no movie, as
      before.
    - Ledger: F10. PLAN.md wave 7.
25. **The owner's side-by-side look** against the original. Still the owner's.
    - PLAN.md wave 6.
26. ~~**`hollywood-keys` and `venice-beach` deck import.**~~ **Done**
    ("Carry each record's height selector and the original's height", "Stand
    every feature on the original's surface", SIM_VERSION 100, fidelity I13).
    - **The original's rule:** it stores no actor Y. Each construct asks
      `terrain_height_at` (0x004545d0) with a selector byte from its own record:
      - X1 at 0x00446b66;
      - turret at 0x0041cff1;
      - pickup at 0x0041e7db;
      - type-14 at 0x0041f719;
      - trigger at 0x0041fdb1.
    - **Generator:** gen:palogic runs that query over the shipped plates, and
      the flood and the repair are deck-aware.
    - **Hk:** the mechs, gates, shops and roads stand on the canal water, and
      its ring guns on the street deck.
    - **Other arenas:** the rule applies on all six, so plinth turrets,
      deck-edge nodes and a few pickups and pads move on the others too.
    - **Unreached:** one pickup on Slim and Joke sits on a 1.8 m platform no
      walkable surface reaches. It is pinned.
    - PLAN.md Phase 13.
27. ~~**Close issue #27.**~~ **Done**: it was closed on 2026-10-14 by PR #67,
    and the box is ticked.
28. ~~**Older boxes from before the original's assets arrived.**~~ **Done**:
    - the Pincel atlas box is obsolete, because the original's own pages
      replaced authored atlases;
    - the `Cwav` box is superseded by Phase 14 wave 1.

## E. Infrastructure

29. **The RE repo's CI has no runner.** Every job still ends after about 4 s with
    `runner_id: 0` on `ubuntu-latest` (seen again on fcop-reverse-engineering#86
    and #87). That points at the private repo's Actions billing or minutes,
    which only the owner can change in the organisation's settings. Until then
    local runs are the only gate: the full `ctest` on Linux, 590 tests at
    432b222e.

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
