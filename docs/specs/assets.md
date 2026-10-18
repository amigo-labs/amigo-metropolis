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
  sim's transform lock (41 ticks, 1.37 s — the original's), driven by a client-local clock that one
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
- **Pickups and lifts wear each arena's own pack** (`packages/client/public/models/pa-props/<mapId>/obj_<cobj>.glb`,
  copied by `bun run gen:paprops` from the RE repo's
  `extracted/findings/pa_props/<Mission>/`). The same Cobj id is a different
  file on every arena — the geometry is shared, the textures are that arena's
  pages — so they are not run through `gen:units` and not keyed by Cobj alone.
  Each is one mesh with one textured material, loaded as exported (the
  original's own frame, origin at the record's position; a pickup's model
  floats about 0.6 m above it). `render/pickups.ts` draws one `InstancedMesh`
  per model, an instance per pickup, shown and turned per frame from the match
  snapshot (`MATCH_PICKUPS`) at the record's spin rate. `render/lifts.ts` draws
  one `InstancedMesh` per lift model, an instance per lift, at the height the
  lift snapshot (`writeLiftSnapshot`) gives its top. A Cobj's own X runs along
  the sim's y and its Z along the sim's x (the actors frame swaps the original's
  axes, as the terrain mesh does), so a lift's model is baked through that swap
  at load and drawn from both sides; the pickups, symmetric and spinning, are
  not.
- **Scenery wears each arena's own Cobjs too** (`packages/client/public/models/props/<mapId>/prop-<cobj>.glb`).
  A scenery record's Cobj id is in its own mission's numbering, which is not
  Mp's: urban-jungle's 36 and 41 are kiosks, Mp's are the Dreadnought hull and
  the Flying Fortress. Unlike the pickups these do run through `gen:units` (the
  outpost flag samples two pages and must become one atlas), from per-mission raws
  copied unchanged by `bun run gen:scenery` from the RE's
  `extracted/objects/<Mission>/`. Until Phase 14 wave 5 every arena drew Mp's
  file for the id, so urban-jungle and proving-ground parked a Dreadnought hull
  and Flying Fortresses among their kiosks, and bug-hunt and hollywood-keys
  dropped two and four kiosks they had no file for.
- **Scenery stands where the original's records stand it**
  (`render/arenaScenery.generated.ts`, written by `bun run gen:scenery`;
  fcop-fidelity.md G2, G10). Every type-11 record (DynamicProp) of the mission,
  placed or spawned by a script, read out of the mission's bytes through the RE's
  container walker: its model, its height as its construct takes it
  (`terrain_height_at` on the record's layer, computed over the RE's plate model
  of the mission's own terrain, so a flag on a deck stands on the deck), its yaw,
  and when it stands — an outpost's console until the claim, its two terminals
  from it, read off the outposts' activation scripts. `render/props.ts` draws the
  table (one InstancedMesh per model, an instance per record; one hidden by its
  outpost's claim is drawn at zero scale), the model's +z turned onto the sim's
  (cos yaw, sin yaw) as a unit's is. The map's `props` are not read. The
  outpost's console entity therefore has no unit model of its own.
- **Each arena's units are its own mission's Cobjs** (`packages/client/public/models/units/<mapId>/obj_NNN.glb`).
  `bun run gen:paunits` reads every role off the RE's
  `extracted/logic/<Mission>/pa_models.json` — the records that place or spawn
  it: tank, jet, Flying Fortress, the Dreadnought's hull and four guns, the
  type-8 turret's and the NeutralTurret's gun and base (Hk has a second
  NeutralTurret set, 43/44, on seven spots) and the Sky Captain per level band —
  into
  `render/arenaUnits.generated.ts`, and copies the arena's exports unchanged into
  `tools/generators/units/raw/fcop-units/<Mission>/`. A Cobj id is its own
  container's (Hk's tank 30 is another model than Mp's, Joke's units are bugs),
  and every mission embeds its own pages, so a file is shared between arenas only
  where the payload and every texel it can sample under its role's offsets are
  identical. `render/arenaUnits.ts` loads the arena's files with the arena (boot
  and every arena swap), a file once a session. Until Phase 14 wave 5 every arena
  drew Mp's units from fixed files loaded at boot.
- **A part keeps the original's origin.** Units are grounded and XZ-centred; a
  turret's gun and base and the Dreadnought's hull and guns are not, because the
  gun stands on the base's attach point 0 and the Dreadnought's guns on the
  hull's attach points 0-3, points in the raw's frame (the helper vertices the
  glb export drops, carried by `pa_models.json`).
- **The turret and the Dreadnought draw as parts**, as the original's are
  separate actors with their own transforms: the turret's base at the record's
  rest yaw and its gun turning on it (a part bucket per turret set; Hk's second
  set has a gun bucket of its own), the Dreadnought's four guns on the hull (a
  part bucket per gun model, capacity four guns of every Dreadnought). Further
  bounded exceptions to the one-mesh-per-archetype rule, beside the avatar's;
  still no `Object3D` tree, every matrix written straight into its slot. Each
  gun turns about its own origin on its point by the sim's gun snapshot
  (`writeGunSnapshot`), between two ticks on the shortest arc.
- **Team colour is a texture offset, not a tint** (`render/teamUv.ts`;
  fcop-fidelity.md G4). The original holds the art twice on a page and gives
  each actor an offset onto its side's half; the client adds it per instance to
  the map lookup in the vertex shader, by the side `render/sides.ts` gives the
  team, and a NeutralTurret by its capture state. The texels stay the
  original's: `gen:units` no longer desaturates units (projectiles keep their
  tint), and the X1's file marks its beacon, which keeps its texels, in a 0/1
  `_TEAMUV` vertex attribute. The outpost flags (scenery Cobj 28) take the
  claimer's offset the same way. Only the greybox stand-ins are tinted.
- **Every animated model plays its track 0** (fcop-fidelity.md G9, G10), stepped
  frame by frame as `cact_anim_step` steps it: by time — the jet's rotor (Cobj
  22, three frames at 10/300 s), Joke's Fortress and Sky Captain, the outpost
  flags' cloth (six frames at 20/300 s) — or by the distance travelled — Joke's
  tank and Dreadnought hull, a frame per 575 / 775 world units. `gen:units` keeps
  those morph targets and bakes a skeleton's frames into targets (Joke's jet, 15
  frames of four bones: frame k is the skin at keyframe k), so every one is a
  morph: the client writes a one-hot frame per instance into the bucket's morph
  texture (an InstancedMesh morphs only through it) on the sim's clock. A unit's
  track starts where the client first draws it, as the original's starts at its
  actor's construct (`render/unitTracks.ts`, which also measures the travel from
  the interpolated positions); the flags all start with the arena. The X1's clips
  still show one frame (render/avatarRig.ts).
- Max ~1500 tris per standard unit, ~5000 for Juggernaut/Fortress/Avatar.
- Materials: single atlas texture, `flatShading: true`, no PBR maps.

## 5. Audio

Since the owner's rule of 2026-10-13 (`fcop-fidelity.md`, audio rows A1–A21) Metropolis
plays only the original's sound:

- SFX and speech: the original's `Cwav` samples and voice bank, copied unchanged into
  `packages/client/public/sfx/` (`tools/generators/importFcopAudio.ts` from an RE
  checkout). No synth, no packs, no per-sound level: the original has none.
- Which file an event plays, at which priority, polyphony and loop: the RE's run of the
  retail loader (`docs/specs/fcop-re/pa-audio.json`) and the voice ops of the arenas'
  scripts (`pa-voice.json`), generated into `audio/fcopAudio.generated.ts` by
  `bun run gen:sfx`. Mixed by a WebAudio model of the original's 24-channel module
  (`audio/mixer.ts`, `audio/engine.ts`; no audio library dependency).
- Music: each arena's own track (`public/music/<Mission>.wav`, 8-bit stereo 14260 Hz).
- All audio is driven from the sim's event ring and the snapshot interface, never from
  sim internals, and nothing the audio does reaches the sim.
- The front end's UI sounds: the exe's nine WAVE slots (`public/sfx/ui/`), played as
  the original's PlaySoundA plays them — one at a time, outside the game's mixer
  (`menu/frontend/uiSound.ts`; `fcop-fidelity.md` F17).

## 6. Front end

The menu is the original's bitmap front end (`docs/specs/ui.md` §3, PLAN.md Phase 14
wave 7). Its pictures, loading screens and UI sounds are the original's, copied
unchanged into `packages/client/public/ui/frontend/` and `public/sfx/ui/` by
`bun run gen:frontend` (`tools/generators/importFcopFrontend.ts`) from an RE checkout,
which also writes the screen and dialog data the menu draws from
(`menu/frontend/frontendData.generated.ts`, from `extracted/frontend/screens.json`,
`dialogs.json` and `ui_sounds.json`). `--check` rebuilds it all in memory and fails on
any difference. Nothing is redrawn or re-encoded; the dialogs are the system's own
chrome, rebuilt in CSS (`menu/win9x/`), not pictures.
