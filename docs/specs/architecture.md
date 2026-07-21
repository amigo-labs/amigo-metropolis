# architecture.md — Technical Architecture

Status: v1

## 0. One paragraph

One deterministic TypeScript simulation drives every mode. Solo and online
play differ **only in where inputs come from**. The renderer is a dumb
consumer of flat snapshots. The server is a dumb relay of inputs. If the sim is
deterministic, everything else follows; protect that property above all.

## 1. Monorepo layout (Bun workspaces)

```
packages/
  sim/        # pure TS, zero deps, runs in browser / DO / bun test
  client/     # Three.js renderer, input, interpolation, UI, PWA
  server/     # CF Worker + Durable Object lockstep relay
docs/specs/   # this folder
tools/        # replay recorder/verifier CLI, balance sheets
```

`sim` may not import from `client` or `server`. Enforce via Biome/tsconfig paths.

## 2. Simulation (`packages/sim`)

- **Fixed tick: 30 Hz.** All gameplay time in ticks (`const TICK_HZ = 30`).
- Deterministic: see CLAUDE.md hard rules. `simMath.ts` provides LUT sin/cos
  (4096-entry table, generated at build time and **committed** as constants, not
  computed at runtime), vector helpers, mulberry32.
- **State**: Structure-of-Arrays in preallocated typed arrays, dense entity ids
  with a free-list. Fixed caps (`MAX_ENTITIES = 1024`) — allocation-free steady
  state, trivially hashable, cache-friendly.
- **API surface** (keep this exact shape):

```ts
createSim(mapData: MapData, seed: number, options?: SimOptions): SimState
step(state: SimState, inputs: TickInputs): void          // advances 1 tick
hash(state: SimState): number                            // FNV-1a 32-bit
writeSnapshot(state: SimState, out: Float32Array): number // returns entity count
```

- `SimOptions` is match config beyond map+seed — currently the Warden
  assignment `{wardenPlayer, wardenDifficulty}` (rules.md §7). It travels in
  the replay header and the online handshake; every peer must pass the same
  options or the sims diverge by construction.

- **Inputs** (`TickInputs`): per player `{ moveX, moveY, aimX, aimY, buttons }`
  with axes quantized to int8 (-127..127) — quantization is part of determinism
  (no raw floats from gamepads enter the sim). `buttons` bitfield: fire1, fire2,
  fire3, transform, jump, interact.
- **Systems order is fixed** (order is behavior — document any change):
  input → avatar movement → unit lane-following → targeting → projectiles →
  damage/death → capture progress → economy → spawning → win check.
- **Lane following**: authored waypoint polylines per map; units seek current
  waypoint, advance on proximity. No dynamic pathfinding in v1. Avoidance =
  simple radial separation between friendly ground units.
- **Terrain**: heightfield grid (e.g. 128×128, fixed cell size) in `MapData`.
  Sim samples height bilinearly for ground snap and slope checks; hover checks
  water mask, walker checks slope limit. Same data feeds the render mesh —
  single source of truth.

## 3. Snapshot (sim → renderer contract) <a id="snapshot"></a>

Flat `Float32Array`, stride 10 per entity:

```
[id, archetype, teamId, x, y, height, yaw, animState, hpFrac, aux]
```

- Written once per tick into one of two rotating buffers (current/previous).
- Renderer interpolates previous→current by render-frame alpha. Never
  extrapolate; never read sim internals.
- Events that don't interpolate (shots fired, deaths, captures, purchases, UI
  pings) go through a per-tick **event ring buffer** `(tick, type, a, b, c)`
  consumed by renderer/audio/UI.

## 4. Client (`packages/client`)

- Three.js, WebGL2 renderer, `three` is the only heavyweight dependency.
- One `InstancedMesh` per archetype; instance matrices written in place.
  Greybox archetypes until Phase 6 (see assets.md).
- Frame loop: accumulate real time → run 0..n sim steps → write snapshot →
  interpolate → render. Zero allocations (CLAUDE.md rules).
- **Input**: keyboard/mouse, sampled per tick, quantized, pushed into the
  input queue. (Gamepad input shipped with the removed couch splitscreen mode;
  its camera-relative mapping helpers remain shared with the keyboard path.)
- **Multi-view rendering**: same scene, N cameras, `setScissor`/`setViewport`
  rects (render-only work; kept for post-v1 2v2 even though the couch mode
  that introduced it was removed).
- **Local input delay**: even solo runs inputs through a 2-tick delay queue so
  online feels identical to offline (no habit-breaking between modes).

## 5. Netcode (`packages/server` + client net module)

- **Deterministic lockstep over WebSocket.** Clients send
  `{tick, playerId, input}`; the Durable Object sequences per-tick input frames,
  broadcasts `{tick, inputs[2]}`. Clients only step tick T when they hold all
  inputs for T. Input delay 3 ticks (100 ms) online.
- **DO responsibilities only**: room lifecycle (create/join via 5-char code),
  tick sequencing, input relay, per-tick hash comparison (clients attach their
  hash every 30 ticks; mismatch → flag desync, log both, end match gracefully),
  reconnect grace (DO keeps full input history per match → rejoining client
  fast-forwards by re-simulating). Use WebSocket Hibernation API.
- The server never simulates. The AI (Warden) is part of the sim and therefore
  runs identically on both clients — AI decisions must only read sim state and
  sim PRNG, never local-only data.
- **Message encoding**: binary from day one — tiny fixed-size ArrayBuffers, no
  JSON on the hot path (JSON would work at this scale, but the format is part
  of the replay file spec, so define it once, binary, and keep it).

## 6. Replays & desync tooling

- A replay = `{mapId, seed, version, wardenConfig, inputFrames[]}`. Byte
  format = network format. Recorded in every mode automatically (dev builds).
  Format 2 added the Warden config (the AI runs inside the sim, so AI matches
  replay from the header alone); format-1 files still decode as warden-less.
- `tools/determinism`: `record`, `verify` (re-simulate, compare hash sequence),
  `bisect` (find first diverging tick between two runs).
- **Golden replays** live in `packages/sim/test/goldens/` and run in CI/`bun test`.
  This is the safety net that makes "determinism by discipline" real.

## 7. Deploy

- Client: static PWA on Cloudflare (injectManifest, per web-base conventions).
- Server: Worker + DO, `wrangler.toml` in `packages/server`.
- Version handshake: client sends `simVersion` (bumped on any hash-affecting
  change) on join; DO rejects mismatched rooms.
