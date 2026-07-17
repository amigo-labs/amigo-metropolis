# assets.md — Asset Pipeline & Licensing

Status: v1

## 0. Principle

Gameplay first. The game must be fully playable and tunable in greybox.
Visuals are Phase 6. Nothing in Phases 0–5 may depend on final assets.

## 1. Pipeline stages

**Stage A — Greybox (Phases 0–5).**
Procedural Three geometry with vertex colors, flat shading:
- Avatar walker: box torso + leg boxes; hover: flat wedge. Transform = swap.
- Runner: box + barrel cylinder. Guardian: flattened cone. Juggernaut: 2× runner
  scale. Fortress: large disc. Turret: cylinder + cone. Base: block with gate cutout.
- Team tint via instance color (red/blue), neutral = grey.
Greybox archetypes live in `client/src/render/greybox.ts` and stay in the repo
forever as a debug render mode (`?render=greybox`).

**Stage B — Asset pass (Phase 6 start).**
- Sources: Quaternius (mech/vehicle packs), Kenney (props, UI, SFX),
  Kay Lousberg via poly.pizza; direct rebuilds of the original Future Cop
  designs; or anything else. No license restriction.
- Note imported third-party assets in `CREDITS.md` (name, author, source URL,
  license) for provenance where the source is known.

**Stage C — Identity pass (Phase 6+).**
- Low-poly flat-shaded models in Blender, PS1-era proportions.
- Textures made in **amigo-pincel** (see §3).
- Unit designs may recreate the classic archetypes directly, including
  recognizable silhouettes such as the transforming X1-Alpha-style police mech.

## 2. Asset policy

- **No license restriction on committed assets.** Any source is fine, including
  purchased packs and CC0/CC-BY assets.
- **Original Future Cop assets may be used directly.** The original game (via
  own copy + FC:MIT tooling) may serve as reference, as an editing base, or be
  rebuilt from scratch. Modified originals (recolors, overpaints, re-meshes)
  are fine.
- **FCOP-derived map data may be committed.** Functional map data (heightfields,
  nav/lane data) extracted or rebuilt from the original game may live in the repo
  (e.g. `packages/sim/maps/*.json`), provided provenance is noted in `CREDITS.md`.
- **EA / Future Cop names, logos, and designs may be used** ("Future Cop",
  "Precinct Assault", X1-Alpha, etc.).
- Note third-party asset sources in `CREDITS.md` for provenance where known.

## 3. Texture style guide (PS1 era) + Pincel workflow

- Resolutions: 64×64 to 256×256, power of two. One texture atlas per archetype.
- Palette: one shared game palette (~32 colors), team colors as dedicated
  swap-able ramp (3 shades per team). The single source of truth is
  `packages/client/src/render/palette.ts`.
- Character: hard pixels (`NearestFilter`, no mipmaps or `NearestMipmapNearest`),
  visible dithering for gradients, painted highlights instead of normal maps,
  slight grime pass. Affine-texture wobble NOT emulated (readability > nostalgia).
- Workflow: author atlases in **amigo-pincel** (dogfooding case #1); export PNG;
  `assets/src/` holds .pincel sources, `packages/client/public/tex/` holds exports.
  If the Pincel MCP server is available, texture variant generation may be
  driven through it in Claude Code sessions.

## 4. glTF conventions (Stage B/C)

- One .glb per archetype in `packages/client/public/models/`.
- Y-up, meters, origin at ground contact center, +Z facing forward.
- Named nodes for code-driven animation (rigid transforms, no skinning):
  `root, hull, turret_yaw, barrel_pitch, leg_l, leg_r, fx_muzzle, fx_thruster`.
- Max ~1500 tris per standard unit, ~5000 for Juggernaut/Fortress/Avatar.
- Materials: single atlas texture, `flatShading: true`, no PBR maps.

## 5. Audio

- SFX: jsfxr presets committed as JSON (regenerable) + rendered .ogg; plus
  packs like Kenney where procedural doesn't cut it. Mixed through a tiny
  WebAudio wrapper (no audio library dependency).
- Music: any tracks for v1. (Long-term candidate: amigo-trommel —
  explicitly out of scope until Pincel v1.0 ships.)
- All audio triggered from the sim event ring buffer, never from render state.
