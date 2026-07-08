# amigo-metropolis

Browser-based arena strategy-action game — a mechanics homage to the *Precinct
Assault* mode of Future Cop: L.A.P.D. (1998), zero original IP. One
deterministic lockstep simulation drives solo, couch splitscreen and online
1v1. Working title: "District Breach".

Read `CLAUDE.md` (hard rules) and `docs/specs/` (source of truth) before
touching code. Work follows `PLAN.md` phase by phase.

## Quickstart

```sh
bun install
bun test               # sim tests + golden replays (must pass before any commit)
bun run dev            # sandbox: WASD + mouse solo; ?warden=1-10 vs the AI;
                       #   ?splitscreen (two gamepads, press A to join) for couch
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
- `tools/replay` — replay record/verify CLI + cross-engine harness
- `tools/gen` — code generators (committed sin LUT)

## Golden replays

`packages/sim/test/goldens/` holds scripted replays plus their expected
per-tick FNV-1a hash sequences; `bun test` re-simulates them. Any sim change
that alters hashes must bump `SIM_VERSION` and regenerate goldens in the same
commit (`bun tools/replay/src/cli.ts record drive-01 packages/sim/test/goldens/golden-01-drive.mrep`)
with justification in the commit message.
