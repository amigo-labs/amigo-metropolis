# PLAN.md — amigo-metropolis

Read `CLAUDE.md` and all of `docs/specs/` first. Work strictly phase by phase;
each phase ends with its Definition of Done (DoD) verified and committed.
Balance numbers come from `packages/sim/src/balance.ts`, seeded from rules.md.

## Phase 0 — Foundation: deterministic sim + render loop

- [x] Scaffold Bun workspace monorepo (`sim`, `client`, `server`, `tools`),
      Biome, strict tsconfig, `bun test` wired up
- [x] `sim`: SoA entity storage with free-list, fixed caps, dense id iteration
- [x] `sim`: `simMath.ts` — committed LUT sin/cos, vec2 helpers, mulberry32;
      unit tests pinning exact output values
- [x] `sim`: `createSim / step / hash / writeSnapshot` API per architecture.md,
      tick loop with quantized `TickInputs`
- [x] `sim`: FNV-1a state hash + replay record/verify in `tools/determinism`
- [x] `sim`: test map `MapData` with 128×128 heightfield + bilinear sampling
- [x] `client`: Three scene — heightfield mesh, orbit debug cam, one greybox
      cube driven by keyboard through the full input→tick→snapshot→interpolate path
- [x] Golden replay #1: 60 s scripted input, hash sequence committed
- [x] CI-style check: `bun test` runs goldens; a deliberately broken determinism
      rule (temporary test) is caught by the golden

**DoD:** cube drives over terrain at 60 fps with 30 Hz sim; same replay produces
identical hash sequence across two different browsers; zero frame-loop allocations
(verified via memory profile note in PR description).

## Phase 1 — Arena & Avatar

- [x] Author "District 01" map: heightfield, water mask, 2 base plots,
      3 lanes (waypoint polylines), 6 neutral turret spots, 2 outpost spots
      (map format: JSON in `packages/sim/maps/`, validated by schema test)
- [x] Avatar entity: walker/hover modes, transform lock, slope/water rules, jump
- [x] Hover drift handling (traction model) — tune until it *feels* right
      (accel/brake/coast knobs in balance.ts; defaults await a hardware feel pass)
- [x] Weapons: primary hitscan, heavy projectile w/ AoE, special; ammo model
- [x] Damage/death/respawn for Avatar; kill event + points hook (stub economy)
- [x] Chase camera (per-player), aim reticle
- [x] Greybox archetype renderer w/ instance colors replaces debug cube

**DoD:** solo sandbox — drive both modes across the arena, shoot destructible
test dummies, die, respawn. Golden replay #2 covers a movement+combat script.

## Phase 2 — Bases, units, lanes

- [x] Base structure: gate trigger volume, core (indestructible), turret ring
      with 60 s respawn, ground/air consoles, ammo/repair pad
- [x] Runner: spawn → lane-follow → engage-in-path → gate breach detection
- [x] Guardian: base patrol mode + outpost assault mode (spawn-site switch)
- [x] Juggernaut & Fortress (limits: 1 alive each)
- [x] Radial separation between friendly ground units
- [x] Win check system + match end state
- [x] Event ring buffer → minimal HUD (points, unit counts) + audio stubs

**DoD:** scripted match: spawn Runners on both sides, one side breaches, match
ends correctly. Golden replay #3 = full mini-match, breach on a known tick.

## Phase 3 — Economy & capture

- [x] Points ledger per player: all earn events from rules.md §3 + trickle
- [x] Console purchase interaction (pad presence + hold-to-buy, per-unit hold)
- [x] Neutral turret capture (3 s uncontested radius), ownership, husk/respawn
- [x] Outpost claim (30 pts at console), forward spawning at 2× cost,
      console destruction reverts to neutral
- [x] HUD: own+enemy points (open info), buy prompts, capture progress
- [x] Balance pass #1 against rules.md placeholder table
      (constants verified 1:1 vs rules.md §3/§4/§5; play-tuning stays ongoing)

**DoD:** full rules of the game playable by two local debug inputs; a human can
play a complete match against a scripted opponent doing fixed build orders.

## Phase 4 — Warden (AI opponent)

- [x] Warden avatar: superplane movement (ignores terrain), own weapon set
- [x] Decision layer (runs inside sim, PRNG-only randomness): state machine or
      behavior tree over {defend, harass avatar, capture, escort push, buy logic}
- [x] Difficulty 1–10: income multiplier, reaction delay ticks, aggression
      thresholds in `balance.ts`
- [x] AI must be replay-stable (goldens include AI matches)

**DoD:** difficulty 3 loses to a competent human, difficulty 8 usually wins;
golden replay #4 = full AI-vs-scripted-input match.
(Golden #4 committed: d8 breaches a scripted defense at tick 7660. Probe runs:
d3 cannot crack an intact turret ring — no Juggernaut below the aggression
threshold — while d8 wins in ~4 min. The human calibration pass on the
difficulty curve stays open, like the hover feel pass; play via `?warden=N`.)

## Phase 5 — Couch splitscreen (REMOVED)

Shipped and met its DoD (two humans, one machine, gamepads), then removed by
owner decision during Phase 8: the couch menu entry, `?splitscreen`/`?players`
deep links, gamepad assignment lobby, `GamepadInput` device and rumble are
gone (git history has them). What Phase 5 built and the game still uses:
the 2-tick local input delay queue (online-feel parity in every mode), the
multi-view `setScissor`/`setViewport` renderer (`render/playerView.ts`, kept
for post-v1 2v2) and the shared camera-relative movement/aim mapping
(`input/gamepadMapping.ts` — the keyboard path builds on it). The splitscreen
perf pass is moot.

## Phase 6 — Online 1v1 (Durable Objects)

- [x] `server`: Worker + DO, room codes, WebSocket Hibernation, binary protocol
      per architecture.md §5
- [x] Client net module: input send, frame receive, stall handling ("waiting
      for opponent" overlay), 3-tick delay
- [x] Hash exchange every 30 ticks, desync flag + graceful end + dump both replays
- [x] Reconnect: DO input history → rejoin fast-forward
- [x] simVersion handshake
- [~] Playtest across two real networks; measure input latency feel

**DoD:** two machines complete a match over the internet; artificially induced
desync (debug flag) is detected within 30 ticks and both replays are dumped.
(The binary protocol lives in `packages/sim/src/protocol.ts` beside the replay
codec — the per-tick input frame IS the replay frame. The relay's decidable
logic is a pure, Cloudflare-free `RoomLogic` (`packages/server/src/room.ts`,
14 unit tests); `index.ts` is a thin Worker + Durable Object over it using the
WebSocket Hibernation API, persisting config + confirmed frames to DO storage
so reconnect survives eviction. The client's `NetLockstep`
(`packages/client/src/net/`) sends input 3 ticks ahead and steps only
server-confirmed frames. The DoD is proven IN-PROCESS by
`packages/client/test/netLockstep.test.ts`: two clients wired through the real
`RoomLogic` stay bit-identical to the offline sim, an induced desync is flagged
within 30 ticks with both replays dumped, and a dropped client re-simulates to
the same state. Wired into the client at `?online=<CODE>` (+ `?relay=<wsBase>`);
the seed is derived from the room code so both peers build an identical sim.
Deploy is wired for a single origin: the root `wrangler.toml` now publishes ONE
Worker that both serves the built client (`[assets]` over `packages/client/dist`,
built by a `[build]` step, SPA fallback) and runs the relay (`run_worker_first`
pins `/room/*` to the Worker + Durable Object). Client and relay share a host,
so the deployed URL plays Solo immediately and online 1v1 needs no
separate relay host (same-origin `wss://<host>/room/<CODE>`). Still open, like
the hover-feel / difficulty passes: the two-network latency
playtest on the live deploy.)

## Phase 7 — Look & sound (Stage B/C of assets.md)

- [x] Model pass (Quaternius/Kenney or direct rebuilds) mapped to archetypes, CREDITS.md
- [ ] Pincel texture atlases + shared palette; NearestFilter pipeline
- [x] jsfxr SFX set wired to event buffer; CC0 music loop; volume settings
- [x] PWA polish: manifest, icons, offline solo mode, install prompt
- [x] Title screen with working title; menu flow (solo / online)

**DoD:** a stranger can open the URL, understand the game, and finish a solo
match without explanation.
(Shell + audio landed. A bare URL opens the "Metropolis" title screen over
an arena backdrop with one click per mode — Solo (Warden difficulty),
Online (host/join room codes) — plus How-to-play and Sound drawers; deep links
(`?warden`, `?online`, `?play`, `?debug`) still boot straight in.
Audio is real now: a dependency-free clean-room sfxr synth renders committed
JSON presets (`audio/presets.ts`) for every event cue and a self-authored CC0
music loop, mixed through a tiny WebAudio wrapper with persisted master/sfx/music
volumes, triggered only from the sim event ring buffer. PWA: web manifest,
app/favicon icons (now the CC0 Metropolis shield brand art, cropped by
`tools/generators/genBrand.py`), a dependency-free service worker for offline solo, and
an install prompt; `CREDITS.md` created.
The shared game palette (assets.md §3) is now in place — an in-house, CC0
~32-color palette with 3-shade team ramps is the single source of truth for
every in-game color (`packages/client/src/render/palette.ts`), replacing the
hex literals scattered across the greybox meshes, base structures and terrain.
Still open on that line item — the texture atlases themselves and the runtime
NearestFilter sampling path, which want real per-archetype art to exercise.

The Stage B model pass landed — with the ORIGINAL Precinct Assault models:
8 of 9 units are FCOP Cobj extractions from the `Mp` container (X1-Alpha hover,
Hovertank, Flyer, heavy gunship, Sky Captain jet + gunship form, neutral
turret, outpost flag console; raws committed under `tools/generators/units/raw/fcop/`,
provenance in CREDITS.md). Only the avatar-walker is a CC0 Quaternius stand-in:
the X1 walker's 45-clip rig does not survive the extraction cleanly (folded
bind pose) — a Stage C pose bake can replace it. `bun run gen:units`
(`tools/generators/genUnitModels.ts` + manifest) processes raws into one
spec-conformant glb per archetype under `public/models/units/` (texture pages
packed into one atlas, team units desaturated so the whole-unit instanceColor
tint owns the hue), swapped into the live InstancedMesh buckets by
`render/unitMeshes.ts` with per-archetype greybox fallback. Mesh rendering
(textured maps + unit models) is now the DEFAULT look (owner decision);
`?render=greybox` keeps the full Stage A debug view. Verified by
`tools/generators/test/unitModels.test.ts` (budgets/origin/footprint vs manifest) and
`bun run verify:units` (SwiftShader lineup screenshots in
`docs/verification/stage7-units/`). Still open on the look side: the Pincel
texture-atlas / NearestFilter pipeline. The feel-tuning of the SFX presets
stays an open pass like the hover-feel / difficulty-curve passes.)

## Phase 8 — Netcode transport & hosting (P2P/TURN) — hosting.spec.md

Zero-cost online path: match traffic goes peer-to-peer over a relay-only WebRTC
DataChannel through Cloudflare TURN; Durable Objects handle only the handshake
(lobby/signaling, directory, budget gatekeeper). The Phase-6 WS relay
(`/room/<CODE>`) stays as the code-based fallback. Read `docs/specs/hosting.spec.md`
before touching any of this.

- [x] H0 — Setup & Wrangler: DO bindings (`LobbyDO`, `DirectoryDO`,
      `GatekeeperDO`), routes (`/lobby/*`, `/api/*`), test scaffold
- [x] H1 — Signaling DO: lobby create/join, SDP/ICE brokering for exactly
      2 peers, in-memory state, alarm TTL
- [x] H2 — WebRTC transport in the client: relay-only `RTCPeerConnection`,
      unordered/no-retransmit DataChannel, input redundancy (last k ticks per
      packet, k = D + 2), wired to the sim tick
- [x] H3 — Lobby system & directory: optional password (server-side hash
      check), public list vs. private code, directory register/unregister,
      lobby UI in the menu
- [x] H4 — Budget gatekeeper: token bucket + per-UTC-day hard counter,
      reservation/reconciliation, reset 00:00 UTC, "sold out" UI path
- [x] H5 — Hardening: short-lived TURN credentials, reconnect/abort logic,
      chaos-tested lifecycle cleanup (no ghost lobbies)

**DoD:** two machines complete a deterministic match over the P2P path with
identical tick hashes; a public lobby is discoverable and a password-protected
one is joinable only with the right password; a simulated budget overrun turns
new sessions away with "sold out" and recovers at UTC midnight; abort chaos
leaves no ghost lobbies. Live two-network TURN playtest stays an open pass,
like the Phase-6 relay playtest.
(All five in-process gates are proven by tests: `p2pLockstep.test.ts` finishes
150 ticks bit-identical to the offline sim over a 35 %-loss channel and flags
an induced desync within 30 ticks; `lobby.test.ts` + `directory.test.ts` cover
listing and the server-side password gate; `gatekeeper.test.ts` drains a day,
gets "sold out", and recovers at the UTC reset; `lobbyChaos.test.ts` settles
300 seeded hostile event sequences with zero ghost lobbies. TURN credentials
are issued per lobby via the Cloudflare Realtime API once `TURN_KEY_ID` +
`TURN_KEY_API_TOKEN` are configured — without them clients fall back to
non-relay dev candidates. The optional GraphQL-analytics drift reconciliation
from hosting.spec.md §3.4 stays unimplemented by design (out-of-band safety
net); the gatekeeper's own counters are the source of truth.)

## Phase 9 — Layered arenas (PA-style) — DONE

Multi-deck maps in the Precinct Assault mold: `MapData.layers` + `resolveHeight`,
per-entity `entLayer` with walker deck transitions (`resolveWalker`), hover
ignores layers. Shipped as SIM_VERSION 10 with golden replay #6 (goldens 01–05
no-op re-recorded); two layered arenas — Hollywood Keys and Venice Beach — plus
the synthetic `layered-test` map; client renders upper decks via
`buildDeckMeshes`. Merged in PR #14. Execution plan (checkboxes historical, all
work landed): `docs/superpowers/plans/2026-07-12-layered-v2.md`.

## Phase 10 — Textured map rendering (Stage 4) — DONE

FCOP-derived textured map meshes as an alternative render path. Part A (the UV
extraction pipeline, `til_mesh.py`) lives in the private RE repo, not here.
Map assets ARE committed under `packages/client/public/models/` (owner decision
2026-07-15, superseding the 2026-07-14 keep-local decision — provenance in
`CREDITS.md`, regeneration notes in `public/models/README.md`), so the CI-built
live deploy ships them too. Spec + plan:
`docs/superpowers/{specs,plans}/2026-07-13-stage4-*`.

- [x] Tasks B1–B3: glTF map load path (`render/meshMap.ts`), `?render=mesh`
      branch in `buildArenaGroup`, texture dispose (merged in PR #15)
- [x] Task B4: upgraded base and spawn meshes — PBR + team emissive on base
      structures, beveled core cap, `buildSpawnMarkers` (spawn rings +
      outpost posts)
- [x] Maps without a local mesh asset fall back to greybox terrain under
      `?render=mesh` (instead of an empty world), so the asset rollout can
      happen map by map
- [x] Task B5 asset side: Part A output exists in the RE repo for ALL 6
      arenas (`extracted/meshes/<Cont>/`, 7–18 MB each). Copied, renamed and
      COMMITTED under `public/models/<map-id>/`; verified: every `.glb` is
      valid glTF v2 with all external texture URIs resolving, and Vite
      serves each `/models/<id>/<id>.glb` with HTTP 200
- [x] Visual verification via headless render. The dev env has no GPU, so this
      runs in Chromium over SwiftShader (software WebGL, with a live rAF loop) —
      `bun run verify:arenas` (harness: `tools/determinism/src/arenaShots.ts`). All 6
      arenas load textured with no console/page/asset errors and no greybox
      fallback; venice-beach decks render; greybox↔mesh screenshots for every
      arena committed under `docs/verification/stage4-arenas/`. This surfaced +
      fixed a real alignment bug: the `.glb`s are authored origin-centered, but
      `buildArenaGroup` never applied the offset its own comment described, so
      the meshes floated off the sim/greybox frame (bases on water). `loadMapMesh`
      now re-centres the mesh into the sim's `[0, extent]` frame. A final glance
      on real GPU hardware stays optional (SwiftShader can't show driver quirks).

## Phase 11 — Touch / mobile controls (pulled forward from backlog)

Client-only (`docs/plans/touch-controls.md`): a new `LocalInputSource` + DOM
overlay — the deterministic sim is untouched, so no golden regeneration.
Entry: `?touch=1`/`?touch=0` override, else coarse-pointer auto-detect; the
Phase 7 menu is the touch entry point (deep links still boot straight in).

- [x] Pure stick/button mapping (`input/touchMapping.ts`) + unit tests
- [x] `TouchInput` source: dual floating sticks — camera-relative analog move,
      snap-to-unit hold-last aim with FIRE1 auto-fire while engaged — plus
      on-screen TRANSFORM/JUMP/USE(hold)/HVY/SPC buttons, pointer-capture
      bookkeeping; reuses gamepadMapping + movement + aimAssist unchanged
- [x] Overlay DOM (`touchControls.ts`) + `body.touch` CSS, no-zoom viewport
      meta, safe-area anchoring; desktop DOM and input stay byte-for-byte
      unchanged (`?touch=0` forces them even on touch hardware)
- [x] Touch E2E (`bun run e2e:touch`): emulated touch device, synthetic
      pointers drive both sticks, in-sim movement + re-facing asserted through
      the `?debug` hook; no console/page errors

**DoD:** on a phone / emulated coarse-pointer device (or `?touch=1`) the menu
starts a solo match; the avatar drives + aims via floating on-screen sticks,
primary auto-fires on aim engage, buttons cover the rest; no page scroll/zoom;
desktop input and the sim are untouched. (The feel pass on real phone hardware
stays open, like the hover-feel / difficulty / SFX passes.)

## Phase 12 — La Cantina: the original Precinct Assault arena

Rebuild `la-cantina` (mission Mp) from the reverse-engineered original logic
instead of a hand-authored approximation, and adopt the original rule set for it
(`docs/specs/rules.md` §9 — a deliberate, documented spec deviation).

- [x] Fix the terrain→sim alignment for all six arenas: measured per-map offsets
      (`tools/generators/genMapAlign.ts` → `render/mapAlign.generated.ts`), with a
      test that re-derives them from the committed `.glb` + heightfield
- [x] Commit the extracted Mp actor/`Cnet` logic in-tree
      (`tools/generators/fcop/mp-logic.json`) so the arena is regenerable without
      the private RE repo, and pin the inferred unit scales
- [x] Map schema for the PA features, every field optional so the other arenas
      and the goldens are untouched
- [x] Regenerate the arena (`tools/generators/enrichArena.ts`): authentic spawns,
      bases, 32 capture pads, 16+16 ring turrets, built-in base defence, pickups,
      intrusion volumes, props and both lane graphs — one Til east of where the
      old features sat
- [x] PA mechanics in the sim (SIM_VERSION 13): per-turret weapon profiles with
      slew + FOV, `Cnet` graph traversal via committed next-hop signposts, base
      production, base-destruction win, pickups, intrusion alerts. Gated on map
      data, so all six existing goldens re-header only — no hash sequence moved
- [x] Greybox base blocks no longer drawn over the baked art (`?structures=greybox`
      keeps them for volume checks); render bucket capacities derived from the
      registry after la-cantina's 72 turrets overflowed the literal 64
- [x] Audio: sfxr cues for alarm / pickup / production / core hit, positional
      stereo panning with distance rolloff, and the three orphaned music tracks
      wired up
- [x] `golden-07-pa`: a 120 s Warden match on la-cantina, with beats asserting
      production cadence and capture, plus tests proving the core CAN be razed
      once its defenders are gone and that an unattended match correctly stalemates
- [ ] Original `Cwav` sound effects: the pipeline is in place — `bun run gen:sfx`
      plus an additive per-cue upgrade in `audio/engine.ts`, with the sfxr synth
      as the permanent fallback — but `tools/generators/sfx/manifest.ts` is empty
      because the 348 unique extracted sounds carry no semantic labels. The RE
      repo narrows them to 46 PA-only candidates with classifier tags; picking one
      per cue still needs someone who knows the game by ear (owner pass)
- [x] `DynamicProp` scenery meshes: all 8 referenced Cobj models come from the
      RE repo's handoff pack and render as one InstancedMesh each
      (`render/props.ts`), unfitted and unrotated so they keep the original's
      own scale and placement

**Definition of Done:** la-cantina plays end to end under §9 — production runs,
the enemy base can be destroyed, pads capture, pickups and alarms fire — with
`bun test`, `bun run replay:verify` and `bun run verify:arenas` green, and the
fidelity screenshots showing turrets on their original pads.

Deliberately NOT in this phase: the other five arenas share the same +16 frame
error in their authored features. The terrain fix improves all of them; importing
their layouts is one arena at a time. → Phase 13.

## Phase 13 — The other FCOP arenas in the original frame

Issue #30: every arena's authored features sat one Til (16 cells) west of where
the original put them, because `convert.ts` authored them in the actor frame.
Phase 12 fixed `la-cantina` by adding stage 2; this points that stage at the rest.

- [x] `tools/generators/fcopArenas.ts`: the mapId ↔ mission ↔ wall-budget table
      the in-tree pipeline reads, so `gen:arena urban-jungle` stops looking for a
      logic file that can never exist. `gen:palogic` takes `--map` or `--mission`
- [x] `gen:walls`: commit each arena's pristine stage-1 wall lattice before it is
      first enriched (a one-way ratchet — after stage 2 runs, the pristine lattice
      exists nowhere in-tree). Verifies `mp-walls.json` rather than regenerating
      it, since la-cantina was already enriched
- [x] Commit the extracted `Cact`/`Cnet` logic for all five remaining missions, so
      every arena is regenerable without the private RE repo
- [x] Generalise stage 2: field axis and mid-line derived from the bases (Hk is
      X-separated, which mis-paired teams), bases paired with their nearest
      X1Alpha, spawn facing derived, only team-owned `Cnet`s imported (Hk carries a
      third), per-arena wall budgets, `assertFrameOffset` against the measured
      terrain alignment, plus `--check` and `--probe`
- [x] Rebuild `urban-jungle` (Conft), `proving-ground` (Slim) and `bug-hunt` (Joke).
      SIM_VERSION 14; golden-05 re-recorded. Two generator bugs surfaced and fixed:
      the lane carve deduped one-way `Cnet` edges as if undirected, and the
      reachability repair ignored the bases' own consoles and ring turrets
- [x] `urban-jungle.test.ts` folded into `fcop-arenas.test.ts`, so all four arenas
      run the lane-graph block; the mirror guard is per-arena and tied back to the
      vertex-correlated terrain footprint
- [ ] `hollywood-keys` and `venice-beach`: **blocked, not skipped.** Their logic is
      committed and stage 2 reports "OK — no problems" on them, and it is wrong
      anyway: every deck sits ≥0.594 m above the base surface against a 0.35 m
      step, decks are 62% / 44% of those grids, and importing puts all 140 of Hk's
      lane nodes and both spawns on the canal floor under the city. Needs per-layer
      walls, a layer on each feature and a deck-aware flood. Pinned as a
      failing-when-fixed test in `layeredArenas.test.ts`
- [x] The lane nodes' missing Y was never missing: each `Cnet` node carries a
      `ground_cast` selecting which stacked surface it sits on (HIGH/LOW/MIDDLE),
      and the extract dropped it. Carried now, measured in `fcop-logic.md` §3.1 and
      re-derivable via `analyzeGroundCast.ts`. That is why the decks have no
      steppable route on and never needed one — the roads are authored *on* them —
      and why 45–93% of the blocked original lane edges touch a node the
      flattening drops off its deck. Removes "an actor Y from the extractor" from
      the blocker above; per-layer walls (RE-side `til_mesh.py`) still stand
- [x] Base ring turrets use their imported weapon profile, gun rotation and health
      (SIM_VERSION 15, issue #31). v13 wired profiles into the capturable pads and
      the built-in base guns but not the ring, so 32 of la-cantina's 72 turrets ran
      at the global 28 m against an imported 6 m `engage_range` — measured as 100%
      of the damage that killed produced units, all of it from outside the 14 m a
      Runner can answer from. la-cantina goes from "no result in 10 minutes" to a
      difficulty-8 Warden winning in 187 s. golden-05 and golden-07 re-recorded
- [x] Produced units can drive their roads on all four arenas (SIM_VERSION 16). It
      WAS the road: a unit travels three kinds of segment and stage 2 validated
      one. The Cnet edges were checked; the two beelines the sim generates around
      them — production console → graph entry node, road's far end → enemy gate —
      were not, and 5 of those 12 legs were walled. On Slim and Joke **neither team
      could leave its own base**; on Conft team 0 could neither leave its own nor
      enter the enemy's. la-cantina was clean on all four legs, which is why it was
      the one arena that played. Two fixes: `GRAPH_WAYPOINT_RADIUS` 0.5 m so a unit
      travels the edge instead of cutting the corner 3 m early (32% and 35% of
      ground-unit ticks were spent jammed against a wall on Slim and Joke), and a
      carve that walks every segment the way a unit steps — both ground step
      lengths, 5 cm either side of the centre line — instead of in fixed 0.25 m
      slices, which is how a road running exactly along a lattice line read as
      walled. Pinned deterministically in `paRoads.test.ts`; wall edits 99→117 (Mp),
      242→283 (Conft), 304→328 (Slim), 311→335 (Joke); goldens 05 and 07 re-recorded
- [x] The Warden plays the §9 objective, and a base's built-in guns stop carrying
      the core's health (SIM_VERSION 17, issue #31). The last mile turned out to be
      two behaviour defects and one modelling artifact before it was any kind of
      number. Two rungs of the goal ladder were written for the §1 loss condition:
      `WGOAL_DEFEND` fired on any enemy ground unit within 55 m of its own gate,
      which under free production every 5 s is the steady state and not an
      emergency — 63%, 89% and 91% of a ten-minute match spent on home defence on
      la-cantina, urban-jungle and bug-hunt, never pushing — and `WGOAL_CAPTURE`
      outranked `WGOAL_ESCORT` unconditionally, so a Warden whose push had reached
      the enemy core flew off for its 30th pad (67-75% capturing against 9%
      escorting). Escort went from 0% of ticks to 34-80%. The artifact: the built-in
      base guns had `hp: base.health`, i.e. the core's 3000, because `BaseShooter`
      stores no health — four of those standing ON the core gate it at a unit's own
      14 m reach. They now take the originals' 500; `coreHp` keeps the extracted
      3000, and only `bases[].defence[].hp` moved (8 fields per arena, verified
      structurally; no heights or walls pin moved). Together, core damage over ten
      minutes with the enemy stream off the field: 90 → 320 on la-cantina, 4 → 1073
      on urban-jungle, 20 → 40 on proving-ground. An escorted push now reaches AND
      damages the core on three of the four arenas, where before only la-cantina
      did. **No balance constant was turned**, and two were measured and rejected so
      a later pass does not spend budget there: `BASE_TURRET_RESPAWN_TICKS` is not
      even monotone (120 s wins urban-jungle outright and drops la-cantina from 320
      to 130), and `CORE_DAMAGE_PER_SHOT` scales an arriving siege linearly while
      changing arrival not at all. A movement rule letting a unit close on a core
      inside its own reach was tried and reverted: it fixed arrival on the two stuck
      arenas and cost more elsewhere (la-cantina 320 → 10), because a unit that
      walks is a unit that is not shooting. goldens 05 and 07 re-recorded
- [x] The hover can drive the original's streets (SIM_VERSION 18, issue #34). The
      issue asked which side was wrong about the roads' kerbs — the movement model,
      the heightfield resolution, or nothing — and left the movement model open
      after the RE side struck the resolution hypothesis (`Ctil` stores one height
      point per cell corner, so there is no sub-cell ramp the import could drop).
      It was the model, on the form nobody had measured: the walker has a jump for
      a step it cannot climb and the hover has nothing, and the hover judged a
      climb over the 0.3 m it covers in a tick. On a bilinear heightfield that
      reads a 0.17 m kerb as a 0.58-gradient wall — and a diagonal crossing of one
      cell is quadratic, so it reads worse — which locked the fast form out of
      10-13% of every arena's `Cnet`: 68/518, 72/640, **32/315** and 75/661. That
      middle number is la-cantina, the arena whose roads the walker finds clean,
      and 67 of its 70 blocking sub-steps were flat again within 2.4 m. Two
      halves, both in `slopeBlocks`: `HOVER_CUSHION_SPAN` (2.4 m, the avatar's own
      footprint diameter) takes a second reading a span on and blocks only if the
      ground is still climbing there, and `AVATAR_HOVER_MAX_SLOPE` goes 0.35 → 0.5,
      which sits between what the roads climb (la-cantina's steepest sustained
      climb is 0.40) and the arenas' 1.3-3 m terrain steps, where the sustained
      climbs on the other three have their mass.
      Hover-impassable edges 68→20, 72→44, 32→**0**, 75→45; teams that can drive
      their own road network end to end in hover 2 → 7 of 8 (it was la-cantina's
      two, and neither team on any other arena); blocking steps on the
      committed shortest road 19→1, 7→5, 0→0, 7→5. The asymmetry is now two-sided
      in the original's own terrain rather than only in rules.md: 2 lane edges each
      on Slim and Joke are past a walker's jump and the cushion rides over them,
      and the hover's step ceiling (span × limit = 1.2 m) stays under that jump's
      1.4 m. What did NOT change: the 1.3-3 m terrain steps are still walls for a
      form with no jump, so "transform or route around" survives as an arena
      feature and stays pinned — it just stops applying to kerbs. No map data and
      no walker rule moved, and the goldens prove the second half: golden-02 is the
      only replay that drives in hover and the only one whose hashes moved
- [ ] Two gaps remain, both #31's and both now characterised rather than guessed:
      **bug-hunt** is the one arena where an escort changes nothing (18.6 m, 0 core
      hits). Not the road (paRoads drives it unopposed), not the geometry (remove its
      defenders and it razes like the rest — now asserted for all four in
      `paAttribution.test.ts`), and not the ring layout (bug-hunt and proving-ground
      place their emplacements at identical distances from the core and
      proving-ground gets in). It is throughput: the same escort destroys 70
      defending turrets in ten minutes on urban-jungle, 48 on proving-ground and 24
      here, because bug-hunt's walls give more of its ring line of sight onto the
      last stretch. **And a Warden vs an idle player still resolves nothing in ten
      minutes on any of the four** — but for a reason that is no longer about the
      Warden's play: both bases produce free Runners at the same rate, two equal
      streams make the mid-line a stable front, and the Warden escorts whatever unit
      is deepest, which after each exchange is a fresh one near its own base. So its
      push never reaches the range where committing applies. Whether an AI should
      break a symmetric free stream unaided is a pillar-1 design question, not only
      a number
      One earlier measurement in this phase was wrong and is worth correcting rather
      than quietly dropping: "the base guns' HP (3000 → 500) changes nothing". It
      changes nothing in an idle-vs-idle match, which is where it was measured — the
      streams annihilate at the mid-line and no gun is ever shot at. In the escorted
      case, the only one where the last mile exists, it is most of the fix

**Definition of Done:** all four single-storey arenas play under §9 — production
runs, pads capture, the enemy core can be razed — with `bun test`,
`bun run replay:verify` and `bun run verify:arenas` green, `gen:arena all --check`
reporting byte-identical output, and the per-arena fidelity screenshots showing
turrets on their original pads. **Structurally met on all four**: production runs
and reaches, pads capture, and razing works once the defence is beaten — now
asserted for all four arenas, not just la-cantina (`paAttribution.test.ts`). A
party that is trying reaches AND damages the core on three of the four; bug-hunt
and the symmetric-free-stream stalemate are the remaining open items above (#31).

## Backlog (post-v1, do not start)

More arenas · map editor · rollback netcode upgrade · 2v2 ·
Warden personalities · replay viewer UI ·
amigo-trommel soundtrack.
