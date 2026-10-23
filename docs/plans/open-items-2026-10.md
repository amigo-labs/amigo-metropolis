# Open items after Phase 14 waves 4–7

> Status: **open, scheduled for the week of 2026-10-26.** Collected 2026-10-19
> after PR #68 (Metropolis, SIM_VERSION 91) and amigo-labs/fcop-reverse-engineering#84
> were merged. Nothing here is started. Each item names where it is recorded:
> the ledger row in `docs/specs/fcop-fidelity.md`, a `PLAN.md` box, or both.

The owner's rule stands: only the original counts. The exceptions are online 1v1
and its lobby, the debug tools, and the HD textures as an option. Every item below
either brings Metropolis closer to the original or closes a question the RE has
not answered yet.

## A. Metropolis only (the RE data is already there)

1. **3DAL colour animations on facers.** `cobj_tick_color_anims` 0x0041a1a0 runs a
   triangle wave of `clock * speed` over a primitive's bytes 5..7, on 36 models. The
   only one drawn in PA is the mine's star (Mp 50, grey → magenta, speed 16). The
   colours are in the RE manifest's `color_anims`, not in the glb.
   - Work: carry `color_anims` through `gen:units` / `gen:paunits` and animate
     them in `render/facers.ts`. Allocate nothing in the frame loop.
   - Ledger: G13.
2. **Riot Shield toggle-off sound.** The original plays the block's sound on every
   call. Metropolis is silent when the call finds the sphere down.
   - Ledger: W5 (declared), A21.
3. **Powered Fusion Torpedo / Plasma Flare rounds.** Block B uses the blue star.
   Metropolis draws block A's red star for both blocks.
   - Work: pick the star per block in the round renderer (`fx/star-46.glb` today).
   - Ledger: W5.
4. **Riot Shield arcs.** The arcs' own links along the sphere's surface are not
   drawn, and the strike link starts at the sphere's centre because
   `EV_SHIELD_ARC` carries no arc point.
   - Ledger: W5.
5. **K-9 Drone model.** It is drawn at frame 0 of its 11-frame morph. Play the
   morph.
   - Ledger: W5.
6. **Radar live-list order.** The registry's order is approximated by descending
   entity id. Actors with no Metropolis entity are not counted: the X1's partner,
   the turret parts, and the flag-8 actors that are never culled.
   - Ledger: V3.
7. **Map-screen arrows.** They use frame 0's 3DBB box only, and a Prop's cell
   comes from its model origin, not its box centre. The emitter's 4 m leaf test is
   approximated by a 2.83 m sphere.
   - Ledger: V4, G13.
8. **Facer depth sort and DCSQuad depth.** The original sorts each facer at its
   centre's depth less 0x100. Metropolis uses the depth buffer after the opaque
   scene, and a polygon offset stands in for the DCSQuads' drawer depth.
   - Ledger: G13 (not modelled).
9. **Effects not drawn yet.** All are declared in the ledger:
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
    - the shield and the target's reference heights are taken as equal;
    - the drone reads the ground from the heightfield, not the original's coarse
      envelope;
    - the drone's health loss uses the body's health from before the hit;
    - the grenade bounces without its model radius (+0x68 not read).
    - Ledger: W5.
11. **Kerbs and spilled walls** on la-cantina, Hk and Ovmp. Each opens when its
    arena is re-imported (`FcopArena.kerbs`).
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

## D. Older PLAN.md boxes still open

24. **Movies:** HELP / BRIEFING's `multibrf.mpg` and the film strip's `po_*.mpg`.
    They are not in the repo, so the files are needed first.
    - Ledger: F10. PLAN.md wave 7.
25. **The owner's side-by-side look** against the original.
    - PLAN.md wave 6.
26. **`hollywood-keys` and `venice-beach` deck import.** Blocked: their decks sit
    above the base surface, and the lane nodes land on the canal floor.
    - PLAN.md Phase 13.
27. ~~**Close issue #27.**~~ Done: #27 was closed 2026-10-14 with PR #67; the
    PLAN.md box is ticked (wave 8).
    - PLAN.md Phase 14 wave 1.
28. ~~**Older boxes from before the original's assets arrived.**~~ Done (wave 8):
    both are superseded by Phase 14 and ticked as such:
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
