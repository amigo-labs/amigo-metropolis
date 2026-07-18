# Model assets

## Unit models (Stage B) — `units/`

One `.glb` per entity archetype (`avatar-walker`, `avatar-hover`, `runner`,
`guardian`, `juggernaut`, `fortress`, `turret`, `console`, `warden`), following
`docs/specs/assets.md` §4: Y-up, meters, +Z forward, origin at the
ground-contact center, footprint matched to the greybox extents, tri budgets
1500/5000. Each file is a single texture-free vertex-colored primitive so the
runtime (`src/render/unitMeshes.ts`) can swap it into the archetype's one
InstancedMesh; the whole-unit team tint comes from instance colors, exactly as
in greybox mode. The projectile stays procedural (payload-colored sphere).

Derived from committed CC0 raw downloads (provenance in `CREDITS.md`):
regenerate with `bun run gen:units` (`tools/gen/genUnitModels.ts`, driven by
`tools/gen/units/manifest.ts`); `tools/gen/test/unitModels.test.ts` asserts
the committed output matches the manifest. Any archetype whose file is missing
or fails to load keeps its greybox mesh at runtime, so models can be swapped
one at a time. `bun run verify:units` shoots a lineup of all archetypes
(mesh + greybox pairs) into `docs/verification/stage7-units/`.

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
