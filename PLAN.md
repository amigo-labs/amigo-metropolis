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
- [x] `sim`: FNV-1a state hash + replay record/verify in `tools/replay`
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
`tools/gen/genBrand.py`), a dependency-free service worker for offline solo, and
an install prompt; `CREDITS.md` created.
The shared game palette (assets.md §3) is now in place — an in-house, CC0
~32-color palette with 3-shade team ramps is the single source of truth for
every in-game color (`packages/client/src/render/palette.ts`), replacing the
hex literals scattered across the greybox meshes, base structures and terrain.
Still open on that line item — the texture atlases themselves and the runtime
NearestFilter sampling path, which want real per-archetype art to exercise.

The Stage B model pass landed: CC0 models (Quaternius + Kenney via poly.pizza,
raw downloads committed) are processed by `bun run gen:units`
(`tools/gen/genUnitModels.ts` + manifest) into one spec-conformant glb per
archetype under `public/models/units/`, swapped into the live InstancedMesh
buckets by `render/unitMeshes.ts` with per-archetype greybox fallback. Mesh
rendering (textured maps + unit models) is now the DEFAULT look (owner
decision); `?render=greybox` keeps the full Stage A debug view. Verified by
`tools/gen/test/unitModels.test.ts` (budgets/origin/footprint vs manifest) and
`bun run verify:units` (SwiftShader lineup screenshots in
`docs/verification/stage7-units/`). Still open on the look side: the Pincel
texture-atlas / NearestFilter pipeline (the models ship vertex-colored, so the
atlas task wants per-archetype art). The feel-tuning of the SFX presets stays
an open pass like the hover-feel / difficulty-curve passes.)

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
      `bun run verify:arenas` (harness: `tools/replay/src/arenaShots.ts`). All 6
      arenas load textured with no console/page/asset errors and no greybox
      fallback; venice-beach decks render; greybox↔mesh screenshots for every
      arena committed under `docs/verification/stage4-arenas/`. This surfaced +
      fixed a real alignment bug: the `.glb`s are authored origin-centered, but
      `buildArenaGroup` never applied the offset its own comment described, so
      the meshes floated off the sim/greybox frame (bases on water). `loadMapMesh`
      now re-centres the mesh into the sim's `[0, extent]` frame. A final glance
      on real GPU hardware stays optional (SwiftShader can't show driver quirks).

## Backlog (post-v1, do not start)

More arenas · map editor · rollback netcode upgrade · 2v2 ·
touch controls (pulled forward — planned in `docs/plans/touch-controls.md`,
not started) · Warden personalities · replay viewer UI ·
amigo-trommel soundtrack.
