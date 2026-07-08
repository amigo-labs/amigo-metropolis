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

## Phase 5 — Couch splitscreen

- [x] Gamepad API: enumeration, assignment screen (press A to join), rumble opt.
- [x] Two-camera setScissor/setViewport rendering, per-player HUD anchors
- [x] 2-tick local input delay queue for all modes (parity with online feel)
- [~] Perf pass: 60 fps splitscreen on mid-range laptop + iPad Safari

**DoD:** two humans on one machine play a full match with gamepads.
(Playable via `?splitscreen` (or `?players=2`): a lobby assigns devices —
gamepad "A" to join, Start/Enter to begin — then two chase-cam viewports split
`?split=v|h` with per-player HUDs. Controls are world-relative (parity with the
keyboard/mouse scheme); left stick drives, right stick aims. Rumble on hit/death
(`?rumble=0` to mute). A synthetic-gamepad e2e drives both slots and confirms
each avatar moves in-sim. The 60 fps pass on real mid-range hardware / iPad
Safari stays open, like the hover-feel and difficulty-curve passes — the frame
loop is allocation-free and shares one set of instance matrices across both
viewport renders, so only draw calls double, not sim or scene rebuilds.)

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
so the deployed URL plays Solo/Couch immediately and online 1v1 needs no
separate relay host (same-origin `wss://<host>/room/<CODE>`). Still open, like
the hover-feel / difficulty / splitscreen-perf passes: the two-network latency
playtest on the live deploy.)

## Phase 7 — Look & sound (Stage B/C of assets.md)

- [ ] CC0 model pass (Quaternius/Kenney) mapped to archetypes, CREDITS.md
- [ ] Pincel texture atlases + shared palette; NearestFilter pipeline
- [x] jsfxr SFX set wired to event buffer; CC0 music loop; volume settings
- [x] PWA polish: manifest, icons, offline solo mode, install prompt
- [x] Title screen with working title; menu flow (solo / couch / online)

**DoD:** a stranger can open the URL, understand the game, and finish a solo
match without explanation.
(Shell + audio landed. A bare URL opens the "District Breach" title screen over
an arena backdrop with one click per mode — Solo (Warden difficulty), Couch,
Online (host/join room codes) — plus How-to-play and Sound drawers; deep links
(`?warden`, `?splitscreen`, `?online`, `?play`, `?debug`) still boot straight in.
Audio is real now: a dependency-free clean-room sfxr synth renders committed
JSON presets (`audio/presets.ts`) for every event cue and a self-authored CC0
music loop, mixed through a tiny WebAudio wrapper with persisted master/sfx/music
volumes, triggered only from the sim event ring buffer. PWA: web manifest,
self-authored generated icons (`tools/gen/genIcons.ts`), a dependency-free
service worker for offline solo, and an install prompt; `CREDITS.md` created.
The shared game palette (assets.md §3) is now in place — an in-house, CC0
~32-color palette with 3-shade team ramps is the single source of truth for
every in-game color (`packages/client/src/render/palette.ts`), replacing the
hex literals scattered across the greybox meshes, base structures and terrain.
`tools/gen/genPalette.ts` emits the committed `.pal` (JASC-PAL) + reference PNG
in `assets/palette/`, and a unit test keeps the `.pal` in sync with the data.
Still open on that line item — the texture atlases themselves and the runtime
NearestFilter sampling path, which want real per-archetype art to exercise.

Still open — the two asset-import tasks: the Stage B CC0 3D-model pass and the
Pincel texture-atlas / NearestFilter pipeline. They need external CC0 binaries
chosen and license-verified against assets.md §2, so they are best done with the
asset sources in hand rather than committed blind; the game meets the DoD in
greybox until then. The feel-tuning of the SFX presets stays an open pass like
the hover-feel / difficulty-curve passes.)

## Backlog (post-v1, do not start)

More arenas · map editor · rollback netcode upgrade · 2v2 · touch controls ·
Warden personalities · replay viewer UI · amigo-trommel soundtrack.
