# Textured map meshes (Stage 4)

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
