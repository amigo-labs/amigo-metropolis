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
- **A model's faces keep the original's draw modes** (fcop-fidelity.md G13; RE
  `docs/formats/objects.md` "Face draw modes"). The RE keys every Cobj's faces
  by the mode `cact_model_shade_face` gives them — `opaque`, `half` (op bit 3:
  the bit-15 texels average with the frame buffer) and `add` (material 6,
  Glide `ONE / ONE`, tinted) — and gen:units keeps one atlas and one primitive
  and material per (mode, tint), opaque first. The client merges them into the
  archetype's one InstancedMesh with a geometry group per material
  (`render/fcopModel.ts`): an opaque group cut at alpha 0.25, a half group drawn
  twice (its solid texels with the opaque faces, its bit-15 texels blended
  50/50 without a depth write), an add group `CustomBlending` ONE / ONE with the
  tint doubled. Groups are draw calls of the same mesh, not a split: the
  instance matrices, morph texture and team offset are the mesh's. The few
  vertex-coloured faces (Joke 75 / Slim 76's `untextured`) sample a small white
  patch packed beside the pages, so one atlas still serves the model. Units are
  grounded and sized on their body, the faces that do not add: the Sky
  Captain's searchlight cones are light.
- **The camera-facing facers are screen geometry, drawn from their records**
  (`render/facers.ts`; RE `docs/formats/objects.md` "Facers"). `cobj_prim_emit`
  builds a billboard, rect, line or star on the screen every frame; the glb
  carries them as records in its root extras (gen:units moves them with the
  mesh and puts their (u, v) on the atlas) and keeps no geometry for them.
  The declared split: each model with facers gets, beside its InstancedMesh,
  one dynamic batch per blend (textured add, half, opaque; the stars), rebuilt
  every frame into preallocated buffers from that InstancedMesh's own instance
  matrices — `render/fx/ribbons.ts`' RibbonBuffer, the same path the bolts take.
  Not an InstancedMesh per facer kind: a facer's corners depend on the camera
  and on each end's depth (a line's normal is its on-screen direction turned
  90 degrees, a star's wedge count its on-screen radius), which is the
  original's CPU work per frame, and the batch reads the archetype's matrices
  rather than holding a second set. No Object3D tree, `matrixAutoUpdate` off,
  nothing allocated in the frame loop.
- Named nodes for code-driven animation (rigid transforms, no skinning):
  `root, hull, turret_yaw, barrel_pitch, leg_l, leg_r, fx_muzzle, fx_thruster`.
- **The X1-Alpha is the original's rig, one InstancedMesh** (`bun run gen:x1`,
  `tools/generators/fcopX1.ts`; `render/avatarRig.ts`; fcop-fidelity.md G11).
  The RE exports the legs (8 joints, 371 frames) and the cockpit (7 joints, 30
  frames) as rigidly skinned glbs; the generator bakes each joint's skin matrix
  per frame, with the cockpit's mount (the legs' 3DHS point 0 of the frame), the
  two guns (the cockpit skeleton's records 2 and 4) and the beacon (its point 2),
  into a bone table, `avatar-x1.anim.bin` (30 x 401 RGBA float texels, a 3x4
  matrix per slot per frame), and merges the five parts into one bind-pose
  primitive, `avatar-x1.glb`, whose `_X1BONE` names each vertex's slot and
  `_X1FACE` its face (the 3DQL primitive its triangle came from, paired back by
  the corners' positions from `faces.json`, so a quad's two triangles share
  one; the skeleton shatter tests a quad whole by it). The
  vertex shader fetches the slot's matrix by the instance's legs and cockpit
  frames (`instanceX1`: legs frame, cockpit frame, the cockpit's aim yaw and
  pitch) — `render/x1Pose.ts` is its CPU twin, held against the RE's own
  assembled walker, hover and transform. Walker, transformation and hover are
  the same mesh at other frames, so nothing swaps and nothing is split: the
  one-mesh-per-archetype rule holds for the X1 again.
- **The X1's faces keep the original's draw modes and layers** (fcop-fidelity.md
  G13; RE `docs/formats/x1-alpha.md` "Draw modes and layers"). `avatar-x1.glb`
  has a primitive per mode, opaque then half — the legs are half throughout —
  which `render/fcopModel.ts` turns into geometry groups of the X1's one
  InstancedMesh, as it does a unit's: the opaque faces cut at alpha 0.25, the
  half faces **drawn twice over the same instanced triangles**, their solid
  texels with the opaque faces and their bit-15 texels blended 50/50 without a
  depth write. That second draw is the declared exception rule 3 asks for in
  writing, and the same one every unit with half faces takes: it is a draw call
  of the same mesh, not a second InstancedMesh — one geometry, one set of
  instance matrices, pose, layer masks and team offset, a material per pass,
  each with the same pose patch — because one pass cannot both write depth for
  the solid texels and blend the bit-15 ones behind what is drawn after them.
  Each face's layer (op1 bits 4..6) rides in `_X1LAYER`; per instance the
  shader gets the two masks the original's partner draws the legs and the
  cockpit with, read off the transform's progress (walker 3 / 5, the ramp
  7 / 0xf, hover 5 / 0xb; the guns and the beacon 1), and collapses a face whose
  layer bit is clear onto the model's origin, where it covers no pixel. The
  draw form comes off the avatar snapshot (`render/x1Walk.ts` `x1DrawForm`: the
  walker's tick, the legs on their hover track, else the ramp).
- **The frames are the original's state machine's**, which runs in the sim
  (`packages/sim/src/walker.ts`, SIM_VERSION 83): the walker's tick, the
  transform's mode-3 ramp (legs track 0x0c 330 -> 359, cockpit track 2 0 -> 29,
  160 a unit of the 300 Hz clock) and the AnmD player; `render/x1Walk.ts` reads
  both blocks' frames off the avatar snapshot (`writeAvatarSnapshot`) once a sim
  tick. The legs' tracks also carry the walker's movement-loop codes, which
  `audio/cues.ts` plays. The RE manifest's clip seconds are not
  used; the clips' `full` timeline is read as an index of frames.
- The greybox buckets keep the two rest poses (`avatar-walker`,
  `avatar-hover`, the RE's assembled walker and hover through `gen:units`) as
  the stand-ins while the rig loads, and in `?x1rig=off`.
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
  lift snapshot (`writeLiftSnapshot`) gives its top. Both turn as every record
  angle does (below): the lift by its record's yaw, the pickup by its spin
  angle. Until "Stand every record angle through one mapping" a lift's model was
  baked through the actors frame's axis swap a second time and drawn from both
  sides — a mirror in the model's own x, since the RE's glb already carries the
  Cobj's x negated.
- **One record angle, one turn** (`render/recordYaw.ts`; fcop-fidelity.md G12).
  A record's angle a (4096 a turn) is the construct's `My(a)`, and the engine
  draws a vertex at `v * M + position` (row-vector, `camera_place_to_view`
  carrying the placement's rows through the view): the model's +z heads the
  game's (sin a, 0, cos a), the sim's (cos a, sin a). So the record angle is the
  sim's yaw (`recordYaw`), and an RE glb — the Cobj with its x negated — turns
  in three by pi/2 - a about +y (`recordTurn`, `yawTurn`), not mirrored: the
  actors frame's swap of x and z and the export's negation cancel. A geometry
  with the units' quarter turn baked turns by -a. Scenery, turret bases, lifts
  and pickups take this one function; the units and the X1 already turn so.
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
  from it, read off the outposts' activation scripts; a base's two heavy
  terminals (the Dreadnought's and the Flying Fortress's) once the poll that
  opens its heavy zones has requested them, which the sim reports
  (`MapBase.heavyZones.terminals`, `MATCH_SLOT_TERMINALS`, SIM_VERSION 80).
  `render/props.ts` draws the table (one InstancedMesh per model, an instance
  per record; one hidden by its outpost's claim or its base's poll is drawn at
  zero scale), the model's +z turned onto the sim's
  (cos yaw, sin yaw) as a unit's is. The map JSONs carry no scenery: their
  `props`, with yaws of Metropolis' own, are gone. The outpost's console entity
  has no unit model of its own.
- **The Props and the DCSQuads** (fcop-fidelity.md G13). A type-96 Prop is a
  model the original builds as a sound emitter, not an actor: gen:scenery reads
  every one with the type-11 records (`props`, `propModels` in
  `render/arenaScenery.generated.ts`), as `snd_emit_build` stands it — layer and
  height, `Mz Mx My` with its random angles drawn from the RE's `game_rand`
  (seed 0x457, a stand-in for the original's wall clock), the rows' scales, the
  spin, swing and frame period — and copies its model into the scenery raws;
  `gen:units` builds it into the arena's `props/` folder with the raw's origin
  kept (`keepOrigin`: a lamp hangs below its origin) and the frames a record
  steps as morph targets. `render/emitterProps.ts` draws them, one InstancedMesh
  per model, turning the spinning ones and stepping the frames per frame. A
  model of camera-facing facers only (Hk 65, Slim 63 / 83, Joke 62 / 82) is
  built as its facers' records and their atlas, and its InstancedMesh, empty
  and hidden, holds the matrices they ride (render/facers.ts). A type-97
  DCSQuad is a decal quad: its Cdcs rect's crop is copied unchanged into
  `public/models/decals/<mapId>/`, and `render/decals.ts` draws the quads, one
  InstancedMesh per image, additively with the record's doubled tint.
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
  separate actors with their own transforms: the turret's base at its own
  yaw — the one its construct reads off the turret's record at +0x42, not the
  gun's +0x34 (`turretBases` in `render/arenaScenery.generated.ts`, keyed by
  spot, kind and team) — and its gun turning on it (a part bucket per turret set; Hk's second
  set has a gun bucket of its own), the Dreadnought's four guns on the hull (a
  part bucket per gun model, capacity four guns of every Dreadnought). Further
  bounded exceptions to the one-mesh-per-archetype rule (the only ones: the X1
  is one mesh); still no `Object3D` tree, every matrix written straight into its
  slot. Each gun turns about its own origin on its point by the sim's gun
  snapshot (`writeGunSnapshot`), between two ticks on the shortest arc.
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
  the interpolated positions); the flags all start with the arena. The X1's
  skeletons play by their own rig (above).
- **`gen:units` is byte-reproducible** across environments: a rebuild that
  decodes an atlas to the committed file's pixels keeps the committed PNG bytes
  (the deflate stream is the encoder's: another zlib gave La Cantina's kiosks
  and five FX models other bytes for the same texels), so an unchanged model
  rebuilds to its committed file. `bun run gen:units --check` builds every model
  in memory and fails on any difference.
- Max ~1500 tris per standard unit, ~5000 for Juggernaut/Fortress/Avatar.
- Materials: single atlas texture, no PBR maps. An FCOP model's faces carry the
  original's lighting inputs per corner (`_FCOP_LIGHT`: the material and its 3DTL
  colour bytes; NORMAL the normal it is lit against; a kept morph's NORMAL
  targets), and `render/fcopModel.ts` shades them as the original does, unlit
  by three's lights (`fcop-fidelity.md` G13). Anything without the attribute
  keeps `flatShading: true` under the scene's lights.

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

## 7. Weapon effects

Since Phase 14 wave 4 (`fcop-fidelity.md`, "Weapon effects") the effects are the
original's effect records, not a Metropolis design:

- The records (types 87–94) a weapon, a death or the mech's transform raises on
  the six arenas, from the RE's effect export (`extracted/effects/`), folded into
  `packages/client/src/effects/fcopEffects.generated.ts` by `bun run gen:fx`
  (`tools/generators/fcopEffects.ts`, `--check` to verify).
- The particle atlas (`public/fx/particles.png`, `particles.json`) is the RE's page
  0 with each sprite through its own palette, unchanged; `public/fx/trails.png` is
  each arena's own trail rect, the Mini Gun ribbon's frames and the bolts' texels,
  cropped from its `tex10`. No sprite, ring, tracer or bolt colour is authored here.
- The bolts of world rows 1, 3 and 6 are not models: their Cobjs (Mp 12, 14, 53) are
  line facers, read from Mp's container by `gen:fx` into `FX_BOLTS` and drawn as
  screen-facing quads (`fcop-fidelity.md` E13). Rows 4, 8 and 9 ship as `gen:units`
  models (`public/models/fx/round-row4/8/9.glb`).
- Drawn by `render/fx.ts` from the sim's events and the snapshot interface only.
