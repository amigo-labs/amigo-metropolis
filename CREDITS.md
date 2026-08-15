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
| Sound effects | `packages/client/src/audio/presets.ts` | sfxr parameter presets rendered at runtime by a clean-room synth (`audio/sfxr.ts`). The synth is the shipped default and the permanent fallback for every cue; a cue is upgraded to a committed original sound only if one is listed in `audio/sfxFiles.generated.ts`. No audio binary is committed today — the pipeline for them exists (`bun run gen:sfx`) but the cue picking is an open ear pass, see `packages/client/public/sfx/README.md` |
| Music loop | `packages/client/src/audio/music.ts` | procedural minor-key pad + arpeggio, rendered to a seamless loop at runtime |
| Music tracks — "Neon Coil", "Rust Circuit", "Slim Cover" | `packages/client/public/music/track{1,2,3}.mp3` | provided by the project owner; the source files live in `assets/audio/`. Selectable in the menu's Sound drawer (`audio/tracks.ts`) |
| Sound effects — Precinct Assault cues | `packages/client/src/audio/presets.ts` | sfxr presets for the alarm / pickup / production / core-hit events (rules.md §9); these are authored, not extracted. `alarm` is authored for as long as its binding stays unrecovered: the original's alert cue is in no sound table — `Trigger` (95) only detects — and was bound in the `Cfun` mission script. `Cfun` has since been disassembled, but no opcode in it is a proven sound-play op, so there is still nothing to extract (`docs/specs/fcop-logic.md` §8.6) |
| Brand art — logo + city backdrop | `assets/brand/`, `packages/client/public/icons/` | AI-generated (Google Gemini) source art, provided by the project owner and released as CC0. `tools/generators/genBrand.py` crops the shield emblem into the app/favicon icons; the "FUTURE COP" sign on the source backdrop is blurred out (a holdover from the earlier no-trademark policy — no longer required, see `docs/specs/assets.md` §2). The compressed menu backdrop is no longer shipped — the menu renders the live 3D arena instead |
| Shared color palette | `packages/client/src/render/palette.ts` | original ~32-color game palette (assets.md §3), the single source of truth for every in-game color |
| Greybox unit/structure meshes | `packages/client/src/render/` | procedural Three.js geometry (Stage A, `?render=greybox`) |

The sfxr synth is an original TypeScript write-up of DrPetter's sfxr technique
(a public-domain algorithm), not a copied port of any GPL/MIT implementation.

## Third-party assets

Stage B unit models (PLAN.md Phase 7 model pass). The raw files are committed
under `tools/generators/units/raw/`; the shipped per-archetype meshes at
`packages/client/public/models/units/<key>.glb` are derived from them by
`bun run gen:units` (`tools/generators/genUnitModels.ts`, driven by
`tools/generators/units/manifest.ts` — the manifest pins each model's source).
All gameplay units are ORIGINAL Precinct Assault models (see the FCOP-derived
section below), including the X1-Alpha walker and hover forms assembled by the
RE repo's `extract_x1.py` (five Cobj parts: legs, cockpit, twin guns, beacon).
The same generator and manifest also build the arena scenery at
`packages/client/public/models/props/<key>.glb` from `PROP_MODELS`, unfitted and
unrotated — see the FCOP-derived row below. The Pincel texture-atlas pass is
still open (see `PLAN.md` Phase 7). Stage C can reintroduce the X1's animation
clips; Stage B ships rigid rest poses only.

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
| `packages/sim/maps/urban-jungle.json` | *Future Cop: L.A.P.D.* mission **Conft** | walkable-floor heightfield extracted from the original mission (int8, 1/32 m units), padded square (225→257); full Precinct Assault layout rebuilt from the committed `conft-logic.json` by `bun run gen:arena` — spawns, bases, 32 capture pads, 16+16 ring turrets, pickups, intrusion volumes, props and both `Cnet` lane graphs, one Til east of the old hand-authored frame |
| `packages/sim/maps/proving-ground.json` | *Future Cop: L.A.P.D.* mission **Slim** | same pipeline (padded square 225→257); layout rebuilt from `slim-logic.json` — 29 capture pads, 14+14 ring turrets. No longer shares a layout with Bug Hunt: Slim and Joke are different missions |
| `packages/sim/maps/la-cantina.json` | *Future Cop: L.A.P.D.* mission **Mp** | same pipeline (padded square 209→241); layout rebuilt from `mp-logic.json` — 32 capture pads, 16+16 ring turrets |
| `packages/sim/maps/bug-hunt.json` | *Future Cop: L.A.P.D.* mission **Joke** | same pipeline (padded square 225→257); layout rebuilt from `joke-logic.json` — 29 capture pads, 14+14 ring turrets; heights from Joke |
| `packages/sim/maps/hollywood-keys.json` | *Future Cop: L.A.P.D.* mission **Hk** | layered; features still hand-authored — spawns on the main walkable ground nearest the original X1Alpha, because the decks are unreachable for the walker (min 0.594 m above the base surface vs a 0.35 m step). `hk-logic.json` is committed and ready for the day a layer model lands |
| `packages/sim/maps/venice-beach.json` | *Future Cop: L.A.P.D.* mission **Ovmp** | layered; features still hand-authored, same reason as Hollywood Keys — spawns on the -2 m ground shelves under the original X1Alpha deck positions. `ovmp-logic.json` is committed |
| `packages/client/public/models/<map-id>/` (all 6 arenas) | *Future Cop: L.A.P.D.* missions **Conft / Slim / Mp / Joke / Hk / Ovmp** | textured terrain meshes (`.glb` + extracted `texNN.png` textures) built from the original Til resources by the Stage 4 pipeline (`til_mesh.py` in `amigo-labs/fcop-reverse-engineering`); render-only, loaded under `?render=mesh` — see `packages/client/public/models/README.md` |
| `packages/client/public/models/units/` (units) + raws in `tools/generators/units/raw/fcop/` | *Future Cop: L.A.P.D.* Precinct Assault container **Mp** | original Cobj unit models (X1-Alpha walker + hover assemblies from `extract_x1.py`, Hovertank 30, Flyer 41, heavy gunship 36, Sky Captain jet 54 / gunship form 57, outpost flag console 29), extracted as glb in `amigo-labs/fcop-reverse-engineering`, then processed by `bun run gen:units` (footprint/origin/orientation, texture pages packed, team units desaturated for the instanceColor tint) |
| `packages/client/public/models/units/turret-standard.glb` + `turret-defense.glb` (+ raws in `tools/generators/units/raw/custom/`) | *Future Cop: L.A.P.D.* Mp Cobj 32+31 (Standard) / 21+20 (Defense) | Two-part assemblies (base+gun); textures packed + desaturated by `bun run gen:units` for team tint |
| `packages/client/public/models/props/` (10 models) + raws in `tools/generators/units/raw/fcop/` | *Future Cop: L.A.P.D.* Precinct Assault container **Mp** | original Cobj scenery for the arenas' `DynamicProp` placements (36 per arena): hazard-striped barrier 28, the parked heavy gunship 36 and flyer 41 (urban-jungle / proving-ground scenery), and the unit-icon kiosks 27, 33, 34, 35, 39, 40 alongside outpost console 29 (whose raw is shared with the `console` unit model, same bytes). Extracted as glb by `extract_objects.py` in `amigo-labs/fcop-reverse-engineering` and packaged as `extracted/findings/props/Mp/` by `export_prop_pack.py`, then processed by `bun run gen:units` — texture pages packed, morph frame 0 kept, but source scale, origin and orientation preserved, because these stand at the original's own coordinates |
| `packages/client/public/fx/particles.png` + `particles.json` | *Future Cop: L.A.P.D.* global `Cpyr` resource | original particle sprite atlas (`PYDT`/`PYPL`/`PIX8`), extracted by `extract_media.py` in `amigo-labs/fcop-reverse-engineering`. Used as billboards for muzzle flash, explosion fireballs and hit sparks (`render/fx.ts`). The atlas is complete and **static** — 8 particles, one sprite each — so the original's explosion is a scaled, faded sprite and nothing here carries a frame sequence (`docs/specs/fcop-fx.md` §1). Bolts and beams are not in this file at all; they are Cobj facer geometry, see the row below |
| `packages/client/public/models/fx/` (7 shipped) + raws in `tools/generators/units/raw/fcop-fx/` (13) | *Future Cop: L.A.P.D.* Precinct Assault container **Mp** | original Cobj projectile and weapon-effect meshes: the single/twin/flat bolts (12, 14, 13), rockets (42 heavy, 43 Helfire, 44 Hyper Velocity), glow stars (46/47, shared by Fusion Torpedo and Plasma Flare), Robo Dog (48, 11 morph frames), mortar shell (49), mine (50), grenade (52) and the second bolt variant (53). Extracted as glb by `extract_objects.py` in `amigo-labs/fcop-reverse-engineering`. Which mesh belongs to which weapon is settled by the actor-type 98/99 template tables in the same extract — the derivation, and what is extracted vs. derived, is written up in `docs/specs/fcop-fx.md` |
| `docs/renders/fcop-ui/` (3 images) | *Future Cop: L.A.P.D.* front-end and in-match capture | screen captures of the original's weapons/hardpoint screen, the load/zone screen and the in-match HUD. Reference only — never shipped in the client bundle. They are the source for the cockpit visual language in `docs/specs/ui.md` §3 and for the hardpoint layout the weapons screen reproduces |
| `packages/client/public/ui/weapons/` (+ copies under `docs/renders/fcop-ui/weapons/`) | *Future Cop: L.A.P.D.* `febmp.bin` | original weapon **icons** (45×42) and **panels** (134×39/40 with rate/damage bars) for the ten catalog weapons. Extracted by `extract_frontend.py` in `amigo-labs/fcop-reverse-engineering` (`extracted/frontend/bmpNNN.png`). Icons ship on the title-menu loadout strip; panels are reference / future hardpoint UI |
