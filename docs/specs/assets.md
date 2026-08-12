# assets.md — Asset Pipeline & Licensing

Status: v1

## 0. Principle

Gameplay first. The game must be fully playable and tunable in greybox.
Visuals are Phase 6. Nothing in Phases 0–5 may depend on final assets.

## 1. Pipeline stages

**Stage A — Greybox (Phases 0–5).**
Procedural Three geometry with vertex colors, flat shading:
- Avatar walker: box torso + leg boxes; hover: flat wedge. Transform: the same
  swap, played as a morph — see §4.
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
- **Scale: the original's own.** FCOP terrain imports at one grid cell per metre
  and the Cobj extractions are already in those metres, so units, scenery and
  arena share one frame and nothing is fitted to a target footprint
  (`tools/generators/units/manifest.ts`, `nativeScale`). Units used to be
  stretched onto hand-picked footprints — by a different factor each, 1.02x to
  2.87x — which put the X1-Alpha walker at 2.80 m against its authored 0.98 m,
  and drew Cobj 29 at 3.20 m as a unit and 1.47 m as scenery from the same bytes
  in the same arena. Anything measured against the avatar rather than against
  the arena follows this scale: greybox stand-ins (`render/greybox.ts`), the
  chase framing (`camera.spec` §7), and `ARCHETYPE_RADIUS` in `balance.ts`,
  which is half the model's footprint.
- **Projectiles and weapon effects keep their pivot, not the ground.** The third
  model family (`FX_MODELS` → `packages/client/public/models/fx/`) follows the
  same native-scale law, but is neither grounded nor XZ-centred: a shell flies
  about the centre the original authored it on, and dropping `minY` to 0 would
  lift every bolt off the line it travels. `docs/specs/fcop-fx.md` records which
  mesh belongs to which weapon and how that was established.
- **Facer geometry may mix with textured geometry in one model.** The original's
  `Star` / `Billboard` / `Line` primitives carry colour in `COLOR_0` and no UVs,
  while bodies carry UVs and no colour; a model can have both — every FCOP
  projectile does, and so does the Sky Captain gunship. The pipeline packs the
  real pages plus a small white patch that the facers' synthesised UVs point at,
  so one primitive carries both. Demanding UVs on *every* primitive is what made
  `fortress.glb` ship untextured for six line facers' sake.
- Named nodes for code-driven animation (rigid transforms, no skinning):
  `root, hull, turret_yaw, barrel_pitch, leg_l, leg_r, fx_muzzle, fx_thruster`.
- **Reality check, avatar walk (v20):** the pipeline emits ONE node per unit —
  `joinMeshes` merges everything and `bakeSkinRestPose` folds the original's two
  skins into the vertices — so no unit ships with named part nodes today. The
  walk animation gets its parts by labelling connected components at load time
  instead (`packages/client/src/render/avatarRig.ts`): position-welded, the
  walker falls into nine islands and the largest one is exactly the original's
  legs mesh. That yields hip swing only; knee bend needs the generator to emit
  the joints, which waits on `gen:units` becoming byte-reproducible.
- The avatar therefore draws as **three** `InstancedMesh`es (body, `leg_l`,
  `leg_r`) rather than one — a deliberate, bounded exception to the
  one-mesh-per-archetype rule in `CLAUDE.md`, capped at four instances. Still no
  `Object3D` tree and no per-limb matrix update.
- **Walker ↔ hover transformation** (`render/morph.ts`): three beats over the
  sim's transform lock (~0.8 s), driven by a client-local clock that one
  `EV_TRANSFORM` event starts.
  1. **Collapse** — the form being LEFT squashes to a third of its height,
     spreads sideways, tucks both hips to the same angle (not the gait's
     antiphase swing) and turns a full circle on the spot.
  2. **Discharge** — arcs in the Electric Gun's palette (`0xe8ffff` core,
     `0x40c0ff` glow) crackle over a metre-high cage around the mech, densest at
     the halfway point, where a flash and a ground ring cover the mesh swap.
  3. **Unfold** — the form being ENTERED runs the collapse backwards.
  The two forms are never on screen together. A cross-fade would need
  per-instance opacity, i.e. a `ShaderMaterial`; the client has none and is not
  getting one for this, so the swap hides inside the flash instead. That also
  means neither the rig nor the hover bucket needs extra capacity.
  The mesh swap point is NOT `ANIM_HOVER`: the sim flips the mode byte on the
  first tick of the lock, so the snapshot reads as the destination for the whole
  window. `render/morph.ts` owns which half of the morph draws which form.
- Max ~1500 tris per standard unit, ~5000 for Juggernaut/Fortress/Avatar.
- Materials: single atlas texture, `flatShading: true`, no PBR maps.

## 5. Audio

- SFX: jsfxr presets committed as JSON (regenerable) + rendered .ogg; plus
  packs like Kenney where procedural doesn't cut it. Mixed through a tiny
  WebAudio wrapper (no audio library dependency).
- Music: any tracks for v1. (Long-term candidate: amigo-trommel —
  explicitly out of scope until Pincel v1.0 ships.)
- All audio triggered from the sim event ring buffer, never from render state.
