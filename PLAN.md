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

- [ ] Warden avatar: superplane movement (ignores terrain), own weapon set
- [ ] Decision layer (runs inside sim, PRNG-only randomness): state machine or
      behavior tree over {defend, harass avatar, capture, escort push, buy logic}
- [ ] Difficulty 1–10: income multiplier, reaction delay ticks, aggression
      thresholds in `balance.ts`
- [ ] AI must be replay-stable (goldens include AI matches)

**DoD:** difficulty 3 loses to a competent human, difficulty 8 usually wins;
golden replay #4 = full AI-vs-scripted-input match.

## Phase 5 — Couch splitscreen

- [ ] Gamepad API: enumeration, assignment screen (press A to join), rumble opt.
- [ ] Two-camera setScissor/setViewport rendering, per-player HUD anchors
- [ ] 2-tick local input delay queue for all modes (parity with online feel)
- [ ] Perf pass: 60 fps splitscreen on mid-range laptop + iPad Safari

**DoD:** two humans on one machine play a full match with gamepads.

## Phase 6 — Online 1v1 (Durable Objects)

- [ ] `server`: Worker + DO, room codes, WebSocket Hibernation, binary protocol
      per architecture.md §5
- [ ] Client net module: input send, frame receive, stall handling ("waiting
      for opponent" overlay), 3-tick delay
- [ ] Hash exchange every 30 ticks, desync flag + graceful end + dump both replays
- [ ] Reconnect: DO input history → rejoin fast-forward
- [ ] simVersion handshake
- [ ] Playtest across two real networks; measure input latency feel

**DoD:** two machines complete a match over the internet; artificially induced
desync (debug flag) is detected within 30 ticks and both replays are dumped.

## Phase 7 — Look & sound (Stage B/C of assets.md)

- [ ] CC0 model pass (Quaternius/Kenney) mapped to archetypes, CREDITS.md
- [ ] Pincel texture atlases + shared palette; NearestFilter pipeline
- [ ] jsfxr SFX set wired to event buffer; CC0 music loop; volume settings
- [ ] PWA polish: manifest, icons, offline solo mode, install prompt
- [ ] Title screen with working title; menu flow (solo / couch / online)

**DoD:** a stranger can open the URL, understand the game, and finish a solo
match without explanation.

## Backlog (post-v1, do not start)

More arenas · map editor · rollback netcode upgrade · 2v2 · touch controls ·
Warden personalities · replay viewer UI · amigo-trommel soundtrack.
