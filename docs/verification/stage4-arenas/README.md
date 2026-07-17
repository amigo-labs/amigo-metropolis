# Stage 4 — textured arena render verification

Evidence for the Phase 10 (`PLAN.md`) visual-verification task: the six textured
arena meshes (`?render=mesh`) rendered in a real browser with a live rAF loop.

Regenerate with:

```
bun run verify:arenas
```

The harness (`tools/determinism/src/arenaShots.ts`) starts the Vite dev server,
launches Chromium, and for each arena loads `/?map=<id>&render=mesh&debug&cam=orbit`,
confirming the `.glb` loads (HTTP 200, no greybox fallback) with no console/page
errors, then shoots the identical camera in both `render=mesh` and `render=greybox`
so the mesh↔greybox alignment (base/marker positions) is directly comparable.

## Environment

This dev environment has no GPU. Chromium renders WebGL through **SwiftShader**
(software): `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)),
SwiftShader driver)`. That exercises the full GLTFLoader → material → shader
pipeline and catches asset 404s, glTF parse failures, misalignment and missing
decks — but not hardware-driver-specific quirks, so a final glance on real GPU
hardware stays optional.

## Result

All 6 arenas load textured, error-free, aligned with the greybox/markers;
`venice-beach` upper decks render. See `<id>-mesh.png` vs `<id>-greybox.png`
per arena, plus `venice-beach-mesh-decks.png` for the deck angle.

## Alignment fix found here

The first run showed every mesh floating off the arena (bases sitting on water):
the `.glb`s are authored origin-centered, but `buildArenaGroup` never applied the
offset that `meshMap.ts`'s own comment said the caller would. `loadMapMesh` now
re-centres the loaded mesh into the sim's `[0, extent]` frame; the committed
screenshots are the post-fix render.
