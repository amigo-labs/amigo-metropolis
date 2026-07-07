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

**Stage B — CC0 pass (Phase 6 start).**
- Sources: Quaternius (mech/vehicle packs), Kenney (props, UI, SFX),
  Kay Lousberg — browse via poly.pizza. CC0 only, or CC-BY with attribution.
- Every imported asset gets a line in `CREDITS.md`: name, author, source URL,
  license. No line, no merge.

**Stage C — Own identity (Phase 6+).**
- Low-poly flat-shaded models in Blender, PS1-era proportions.
- Textures made in **amigo-pincel** (see §3).
- Unit designs must be original silhouettes. Same *role* as the classic
  archetypes, different *shape* (explicitly: no transforming police mech that
  reads as X1-Alpha).

## 2. License rules (repo is public)

- Committed assets: **CC0 or CC-BY only.** No purchased packs (their licenses
  allow use in builds, not redistribution in source).
- **No original Future Cop assets — including modified ones.** An edited
  original texture/model/sound is a derivative work and remains EA copyright.
  Filtering, recoloring, overpainting does not change this.
- The original game (via own copy + FC:MIT tooling) is **reference only**:
  proportions, arena dimensions, lane lengths, palette character, pacing.
  Looking is allowed; opening an original file as an editing base is not.
- No EA trademarks anywhere (names, logos, "Future Cop", "Precinct Assault"
  as-is; genre description "inspired by classic 1998 arena modes" is fine).
- Sounds: new productions only (jsfxr, recorded, or CC0 packs).

## 3. Texture style guide (PS1 era) + Pincel workflow

- Resolutions: 64×64 to 256×256, power of two. One texture atlas per archetype.
- Palette: one shared game palette (~32 colors), team colors as dedicated
  swap-able ramp (3 shades per team). Store palette as `.pal` + reference PNG
  in `assets/palette/`.
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
  Kenney CC0 where procedural doesn't cut it. Mixed through a tiny WebAudio
  wrapper (no audio library dependency).
- Music: CC0/CC-BY tracks for v1. (Long-term candidate: amigo-trommel —
  explicitly out of scope until Pincel v1.0 ships.)
- All audio triggered from the sim event ring buffer, never from render state.
