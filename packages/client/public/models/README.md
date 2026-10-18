# Model assets

## Unit models (Stage B) — `units/`

Every unit is an ORIGINAL Precinct Assault model, following
`docs/specs/assets.md` §4: Y-up, metres, +Z forward, **the size the original
authored**, one one-material primitive per file with the original's 256px
texture pages packed as one atlas, so the runtime can swap it into its bucket's
InstancedMesh. Provenance in `CREDITS.md`.

- `avatar-walker`, `avatar-hover`: the X1-Alpha's two forms, assembled by the
  RE's `extract_x1.py`; every arena draws these two.
- `<map-id>/obj_NNN`: each arena's own units — the Cobj its own mission names
  for the tank, the jet, the Flying Fortress, the Dreadnought's hull and guns,
  the type-8 turret's and the NeutralTurret's gun and base (Hk has two
  NeutralTurret sets), the Sky Captain per level band and the outpost console.
  `NNN` is that mission's Cobj id, which means another model on another arena.
  `bun run gen:paunits` reads the roles off the RE's
  `extracted/logic/<Mission>/pa_models.json` into
  `src/render/arenaUnits.generated.ts` and copies the raws unchanged; a file
  is shared by arenas whose payload and sampled texels are identical, and lives
  in the folder of the first. Loaded with the arena (`src/render/arenaUnits.ts`).

Units are grounded and XZ-centred; a turret part and the Dreadnought's parts
keep the original's origin, because the gun stands on the base's attach point
and the Dreadnought's guns on the hull's.

**Team colour is the original's:** the texels are never recoloured. Each page
holds the art twice and every actor carries a texture offset onto its side's
half (`docs/specs/fcop-fidelity.md` G4); the client adds it per instance in the
vertex shader (`src/render/teamUv.ts`). The X1's file marks its beacon, which
keeps its texels, in a `_TEAMUV` vertex attribute. Until Phase 14 wave 5 the
pipeline desaturated the units and the client tinted them red and blue.

The raws are already in map metres, the same frame the FCOP terrain imports at
(one grid cell per metre), so nothing is stretched to a target footprint.
Regenerate with `bun run gen:units` (`tools/generators/genUnitModels.ts`, driven
by `tools/generators/units/manifest.ts`);
`tools/generators/test/unitModels.test.ts` asserts the committed output matches
the manifest and the table. A unit whose file is missing or fails to load keeps
its greybox mesh at runtime. `bun run verify:units` shoots a lineup of all
archetypes (mesh + greybox pairs) into `docs/verification/stage7-units/`.

## Arena scenery — `props/<map-id>/`

One `.glb` per original `DynamicProp` model, in a folder per arena and named
`prop-<cobj>` after the Cobj resource id the map's `props` entries carry, so
`src/render/props.ts` maps a placement onto a URL with no second lookup table.
Every imported arena has 36 placements across 8 models: the outpost flags
(16×, hazard stripes until the outpost is claimed, then the claimer's flag —
the same per-instance texture offset as the units), the outpost console and six
small kiosks showing the unit-icon/digit strip.

The id is the arena's own mission's, and the missions number their Cobjs
differently — urban-jungle's 36 and 41 are kiosks, where Mp's are the
Dreadnought hull and the Flying Fortress — so the folder is the arena's. Even
where a mission shares Mp's payload, the texels are its own pages: each file is
built from that mission's export (`tools/generators/units/raw/fcop-props/<Mission>/`,
copied unchanged by `bun run gen:scenery`; `ARENA_SCENERY` in the manifest
records which Mp model each one is a twin of).

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
