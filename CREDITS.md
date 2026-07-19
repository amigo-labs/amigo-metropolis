# CREDITS

Asset attribution for amigo-metropolis. See `docs/specs/assets.md` for the asset
policy. There is no license restriction on committed assets; this file tracks
provenance for third-party assets (name, author, source URL, license) where the
source is known.

## In-house assets (CC0)

Authored for this project and released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). No attribution
required, but listed for provenance.

| Asset | Where | How it's made |
| --- | --- | --- |
| Sound effects | `packages/client/src/audio/presets.ts` | sfxr parameter presets rendered at runtime by a clean-room synth (`audio/sfxr.ts`); no binary committed |
| Music loop | `packages/client/src/audio/music.ts` | procedural minor-key pad + arpeggio, rendered to a seamless loop at runtime |
| Brand art — logo + city backdrop | `assets/brand/`, `packages/client/public/icons/` | AI-generated (Google Gemini) source art, provided by the project owner and released as CC0. `tools/gen/genBrand.py` crops the shield emblem into the app/favicon icons; the "FUTURE COP" sign on the source backdrop is blurred out (a holdover from the earlier no-trademark policy — no longer required, see `docs/specs/assets.md` §2). The compressed menu backdrop is no longer shipped — the menu renders the live 3D arena instead |
| Shared color palette | `packages/client/src/render/palette.ts` | original ~32-color game palette (assets.md §3), the single source of truth for every in-game color |
| Greybox unit/structure meshes | `packages/client/src/render/` | procedural Three.js geometry (Stage A, `?render=greybox`) |

The sfxr synth is an original TypeScript write-up of DrPetter's sfxr technique
(a public-domain algorithm), not a copied port of any GPL/MIT implementation.

## Third-party assets

Stage B unit models (PLAN.md Phase 7 model pass). The raw files are committed
under `tools/gen/units/raw/`; the shipped per-archetype meshes at
`packages/client/public/models/units/<key>.glb` are derived from them by
`bun run gen:units` (`tools/gen/genUnitModels.ts`, driven by
`tools/gen/units/manifest.ts` — the manifest pins each model's source).
Most units are the ORIGINAL Precinct Assault models (see the FCOP-derived
section below); the only outside asset is the avatar-walker stand-in — the
original X1-Alpha walker rig does not survive the Cobj extraction cleanly,
so a CC0 mech fills in until a Stage C pose bake. The Pincel texture-atlas
pass is still open (see `PLAN.md` Phase 7).

| Asset | Author | Source | License |
| --- | --- | --- | --- |
| Mech (→ `avatar-walker`) | Quaternius | <https://poly.pizza/m/o3Ps8z8ByP> | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

The projectile keeps its procedural low-poly sphere (greybox, payload-colored)
by design — no asset needed.

## Reference / source material

The original *Future Cop: L.A.P.D.* (1998) is used as reference and may be
rebuilt directly — proportions, arena dimensions, lane lengths, designs, palette
character, pacing. There is no license restriction; original or modified EA
assets and Future Cop trademarks may be used (see `docs/specs/assets.md` §2).

### Committed FCOP-derived map data

| Map | Source | How it's made |
| --- | --- | --- |
| `packages/sim/maps/urban-jungle.json` | *Future Cop: L.A.P.D.* mission **Conft** | walkable-floor heightfield extracted from the original mission (int8, 1/32 m units), padded square (225→257) and authored with amigo-metropolis features (bases/spawns/lanes); no original art, textures, or geometry meshes committed |
| `packages/sim/maps/proving-ground.json` | *Future Cop: L.A.P.D.* mission **Slim** | same pipeline (padded square 225→257), features authored on the flat 0 m play field |
| `packages/sim/maps/la-cantina.json` | *Future Cop: L.A.P.D.* mission **Mp** | same pipeline (padded square 209→241), features authored on the 0.594 m apron around the central building |
| `packages/sim/maps/bug-hunt.json` | *Future Cop: L.A.P.D.* mission **Joke** | same pipeline (padded square 225→257), a Proving Ground terrain variant with lanes re-routed on its own heights |
| `packages/client/public/models/<map-id>/` (all 6 arenas) | *Future Cop: L.A.P.D.* missions **Conft / Slim / Mp / Joke / Hk / Ovmp** | textured terrain meshes (`.glb` + extracted `texNN.png` textures) built from the original Til resources by the Stage 4 pipeline (`til_mesh.py` in `amigo-labs/fcop-reverse-engineering`); render-only, loaded under `?render=mesh` — see `packages/client/public/models/README.md` |
| `packages/client/public/models/units/` (8 of 9 units) + raws in `tools/gen/units/raw/fcop/` | *Future Cop: L.A.P.D.* Precinct Assault container **Mp** | original Cobj unit models (X1-Alpha hover form 16, Hovertank 30, Flyer 41, heavy gunship 36, Sky Captain jet 54 / gunship form 57, neutral turret 32, outpost flag console 29), extracted as glb by `extract_objects.py` in `amigo-labs/fcop-reverse-engineering`, then processed by `bun run gen:units` (footprint/origin/orientation, texture pages packed, team units desaturated for the instanceColor tint) |
