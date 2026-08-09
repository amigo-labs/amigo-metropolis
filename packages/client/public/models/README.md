# Model assets

## Unit models (Stage B) — `units/`

One `.glb` per entity archetype (`avatar-walker`, `avatar-hover`, `runner`,
`guardian`, `juggernaut`, `fortress`, `turret`, `console`, `warden`), following
`docs/specs/assets.md` §4: Y-up, meters, +Z forward, origin at the
ground-contact center, **the size the original authored**, tri budgets
1500/5000. Each file is a single one-material primitive — the FCOP originals
keep their packed 256px texture pages as one atlas, untextured sources carry
baked vertex colors — so the runtime (`src/render/unitMeshes.ts`) can swap it
into the archetype's one InstancedMesh; the whole-unit team tint comes from
instance colors, exactly as in greybox mode (team units are desaturated by the
pipeline so the tint owns the hue, like FCOP's own grey team variants). The
projectile stays procedural (payload-colored sphere).

Every unit is an ORIGINAL Precinct Assault model from the `Mp` container
(extracted in `amigo-labs/fcop-reverse-engineering`), including the X1-Alpha
walker and hover forms assembled by `extract_x1.py`. This used to note the
avatar-walker as a CC0 stand-in "because the X1-Alpha walker's rig does not
survive extraction cleanly" — the assembly landed in `4a57b3e` and the note was
left behind. Provenance in `CREDITS.md`.

The raws are already in map metres, the same frame the FCOP terrain imports at
(one grid cell per metre), so `nativeScale` is on for all of them and nothing is
stretched to a target footprint. The arena scenery below is the same bytes for
Cobj 29 as the `console` unit — when the two disagreed on size, the fitting was
the thing that was wrong.
Regenerate with `bun run gen:units` (`tools/generators/genUnitModels.ts`, driven
by `tools/generators/units/manifest.ts`);
`tools/generators/test/unitModels.test.ts` asserts the committed output matches
the manifest. Any archetype whose file is missing or fails to load keeps its
greybox mesh at runtime, so models can be swapped one at a time.
`bun run verify:units` shoots a lineup of all archetypes (mesh + greybox pairs)
into `docs/verification/stage7-units/`.

## Arena scenery — `props/`

One `.glb` per original `DynamicProp` model, named `prop-<cobj>` after the Cobj
resource id the map's `props` entries carry, so `src/render/props.ts` maps a
placement onto a URL with no second lookup table. la-cantina has 36 placements
across 8 models: a hazard-striped barrier (Cobj 28, 16×) and seven small kiosks
showing the unit-icon/digit strip (27, 29, 33, 34, 35, 39, 40).

These come out of the same generator and manifest as the units
(`PROP_MODELS`), but with **two contracts inverted**: they keep their source
scale, and they keep their source origin in XZ. Scenery is placed in the
original's own frame at the original's own coordinates, so fitting it to a
footprint or re-centring it would move it off the spot it was authored on —
Cobj 28's bbox centre alone is 0.32 m off in Z. For the same reason nothing
here is re-oriented; there is no +Z-forward convention to correct for.

Render-only: the sim never reads `props`
(`packages/sim/test/determinismGuard.test.ts` enforces it). Drawn on the
`?render=mesh` path only, since these are the arena's own art and belong with
the textured terrain rather than on top of greybox blocks. A missing file costs
that model's scenery and nothing else — there is deliberately no greybox
stand-in. Contract test: `tools/generators/test/propModels.test.ts`.

## Textured map meshes (Stage 4)

FCOP-derived terrain meshes, one directory per arena: `<map-id>/<map-id>.glb`
plus its external `texNN.png` textures. Loaded at runtime by
`src/render/meshMap.ts` under `?render=mesh`; maps without a directory here
fall back to greybox terrain.

Committed per the asset policy (`docs/specs/assets.md` §2, owner decision
2026-07-15 superseding the 2026-07-14 keep-local decision). Provenance is
tracked in `CREDITS.md`.

Regeneration: Part A of the Stage 4 pipeline (`til_mesh.py`) in
`amigo-labs/fcop-reverse-engineering` writes `extracted/meshes/<Cont>/`;
copy that directory here and rename `<Cont>.glb` to `<map-id>.glb`.
Container → map-id: Conft=urban-jungle, Slim=proving-ground, Mp=la-cantina,
Joke=bug-hunt, Hk=hollywood-keys, Ovmp=venice-beach.
