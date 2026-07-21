# amigo-metropolis

Browser-based arena strategy-action game — a homage to the *Precinct
Assault* mode of Future Cop: L.A.P.D. (1998). One deterministic lockstep
simulation drives solo, couch splitscreen and online 1v1. Title: **Metropolis**.

Read `CLAUDE.md` (hard rules) and `docs/specs/` (source of truth) before
touching code. Work follows `PLAN.md` phase by phase.

## Quickstart

```sh
bun install
bun test               # sim tests + golden replays (must pass before any commit)
bun run dev            # opens the "Metropolis" title menu (solo / couch /
                       #   online). Deep links skip it: ?warden=1-10 vs the AI;
                       #   ?splitscreen (two gamepads, press A to join) for couch;
                       #   ?online=<CODE> for 1v1 lockstep (see below); ?play or
                       #   ?debug boot the solo sandbox directly
bun run build          # production bundle (installable PWA, offline solo)
bun run lint           # Biome
bun run typecheck      # tsc per package
bun run replay:verify  # re-simulate goldens against the current sim
```

`bun run replay:verify:browser` re-runs every golden in Chromium (V8) and in
Bun (JavaScriptCore) and asserts both engines reproduce the committed hash
sequences bit-exactly (needs a Chromium binary; set `CHROMIUM_PATH`).

## Layout

- `packages/sim` — pure deterministic simulation (zero deps, no DOM/Three/I/O)
- `packages/client` — Three.js renderer, input, interpolation, PWA shell
- `packages/server` — Cloudflare Worker + Durable Object relay (Phase 6)
- `tools/determinism` — replay record/verify CLI + cross-engine harness
- `tools/generators` — authoring-time generators (committed sin LUT, map JSON, and
  brand icons/backdrop from `assets/brand/` via `genBrand.py`)

## Online 1v1 (Phase 6)

Deterministic lockstep over WebSocket: clients send inputs, the relay only
sequences and rebroadcasts them, and each client steps a tick once it holds
both players' inputs for it (3-tick input delay). The relay never simulates.

```sh
cd packages/server
bun run dev      # local relay (Worker + Durable Object) via wrangler dev
bun run build    # validate the Worker bundles (wrangler deploy --dry-run)
bun run deploy   # deploy the relay to Cloudflare (wrangler deploy)
```

Then open two tabs at `…/?online=ABCDE&relay=ws://localhost:8787` (same 5-char
code = same room). The room code seeds the match, so both peers build an
identical sim; only inputs cross the wire. `?relay=<wsBase>` points at the
relay (defaults to same-origin).

The relay's Cloudflare config is `wrangler.toml` at the **repo root** (its
`main` points into `packages/server`). It sits at the root so a **Workers
Builds** Git integration works with the default settings — deploy command
`npx wrangler deploy` from the workspace root — without a custom root directory
(wrangler won't auto-detect an app inside a Bun workspace root, so it needs the
config there). The `name` must match the Workers Builds project.

## One deploy, whole game (Cloudflare)

`wrangler deploy` publishes a **single Worker** that serves both the game and
the relay:

- a `[build]` step builds the client (`packages/client/dist`);
- `[assets]` serves that build as static files, with an SPA fallback to the app
  shell;
- `run_worker_first = ["/room/*"]` keeps the relay WebSocket routes on the
  Worker + Durable Object.

Because the client and relay share one origin, opening the deployed URL boots
the title screen and Solo/Couch play immediately, and **online 1v1 works with
no extra host** — the client's relay URL defaults to `wss://<host>/room/<CODE>`.
Two players just open `…/?online=ABCDE` with the same 5-char code (or use the
menu's host/join). The whole thing runs offline in dev with `wrangler dev` from
`packages/server`.

The protocol is binary and shared with the replay format — one definition in
`packages/sim/src/protocol.ts`. The full lockstep contract (bit-identical
peers, desync detection within 30 ticks with both replays dumped, reconnect
fast-forward) is proven in-process by `packages/client/test/netLockstep.test.ts`,
which wires two `NetLockstep` clients through the real relay logic without a
browser or Workers runtime.

## Golden replays

`packages/sim/test/goldens/` holds scripted replays plus their expected
per-tick FNV-1a hash sequences; `bun test` re-simulates them. Any sim change
that alters hashes must bump `SIM_VERSION` and regenerate goldens in the same
commit (`bun tools/determinism/src/cli.ts record drive-01 packages/sim/test/goldens/golden-01-drive.mrep`)
with justification in the commit message.
