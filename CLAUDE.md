# amigo-metropolis

Browser-based arena strategy-action game. Spiritual successor to the *Precinct Assault*
mode of Future Cop: L.A.P.D. (1998) — mechanics homage, zero original IP.
Codename: **Metropolis**. Display title: **Metropolis**.

Solo vs. AI, couch splitscreen, and online 1v1 — all driven by one deterministic
lockstep simulation.

## Stack

- **TypeScript only.** No Rust/WASM in this repo. The sim is portable pure TS.
- Bun (runtime, tests, workspaces), Biome (lint/format), TypeScript strict.
- `packages/sim` — pure deterministic simulation. No DOM, no Three, no I/O.
- `packages/client` — Three.js (WebGL2) renderer, input, interpolation, PWA shell.
- `packages/server` — Cloudflare Worker + Durable Object lockstep relay.
- Specs live in `docs/specs/`. Read them before implementing. They are the source
  of truth; if code and spec disagree, raise it — don't silently pick one.

## Commands

- `bun install` — install workspace deps
- `bun test` — run all tests (sim tests must pass before any commit)
- `bun run lint` — Biome check
- `bun run dev` — client dev server
- `bun run replay:verify` — run golden replays against current sim (Phase 0+)

## Hard rules — determinism (packages/sim)

Violating any of these causes multiplayer desyncs. They are non-negotiable.

1. **No transcendental `Math.*` in sim code.** Banned: `sin, cos, tan, atan2, asin,
   acos, pow, exp, log, sqrt` variants that are engine-dependent — of these, plain
   `Math.sqrt` IS allowed (IEEE-exact), the rest are NOT. Use `simMath.ts`
   (lookup-table sin/cos, polynomial atan2). Prefer direction vectors + normalize
   over angles wherever possible.
2. **Allowed arithmetic:** `+ - * /`, `Math.sqrt`, `Math.floor/ceil/abs/min/max/sign`,
   integer bitwise ops. These are IEEE-754-exact and identical across V8/JSC/SpiderMonkey.
3. **PRNG:** seeded mulberry32 in sim state. Never `Math.random()` in sim code.
4. **Time:** the sim knows only its tick counter. Never `Date.now()`,
   `performance.now()`, or wall-clock anything inside `packages/sim`.
5. **Iteration order:** entity storage is an array indexed by dense entity id;
   iterate in id order. Never iterate `Map`/`Set`/object keys where insertion
   order could differ between peers.
6. **Sim hash:** every tick produces a 32-bit FNV-1a hash over canonical state.
   Golden replay tests assert hash sequences. Any sim change that alters hashes
   requires regenerating goldens in the same commit, with justification in the
   commit message.
7. Sim is synchronous and single-threaded. No `async` inside the tick.

## Hard rules — renderer (packages/client)

1. **Zero allocations in the frame loop.** No `new Vector3()`, no array literals,
   no closures created per frame. Preallocate scratch objects at module scope.
2. `matrixAutoUpdate = false` for everything; write instance matrices directly.
3. One `InstancedMesh` per entity archetype (tank, plane, projectile, turret…).
4. The renderer reads sim state ONLY via the snapshot interface
   (`docs/specs/architecture.md#snapshot`). Never reach into sim internals.
5. Renderer must stay swappable: no sim logic in client, no Three types in sim.

## Assets & licensing (see docs/specs/assets.md)

- Repo is public: only CC0 or CC-BY (attributed in `CREDITS.md`) assets may be
  committed. No purchased packs, no ripped or **modified** original Future Cop
  assets — edited originals are still derivatives and are forbidden.
- Original game may be used as *reference* (proportions, palette, layout) only.
- No EA trademarks or recognizable Future Cop designs (incl. X1-Alpha silhouette).

## Workflow

- Follow `PLAN.md` phase by phase. Check off tasks as completed.
- Atomic commits, imperative mood, one logical change each.
- Each phase has a Definition of Done; do not start the next phase before it's met.
- New gameplay constants go in `packages/sim/src/balance.ts` — never inline.
