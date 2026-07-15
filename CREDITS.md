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

_None yet._ The Stage B model pass (Quaternius / Kenney / Kay Lousberg via
poly.pizza, or direct rebuilds of the original) and the Pincel texture-atlas
pass are still open (see `PLAN.md` Phase 7) — the shared palette they build on
is now in place (above). Note each imported outside asset in the table below for
provenance where the source is known.

| Asset | Author | Source | License |
| --- | --- | --- | --- |
| — | — | — | — |

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
