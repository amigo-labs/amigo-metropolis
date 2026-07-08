# mapalyze

Dev-only, offline tool that distills the **functional design DNA** of a map —
lane topology, proportions, chokepoints, role distribution, symmetry — from the
functional exports of [`FCMissionReader`](https://github.com/Ghoster738/Future-Cop-MIT)
into an **abstracted, normalized, quantized** analysis.

That analysis (`MapAnalysis`, schema `mapalyze/1`) is the *only* thing that
leaves the tool and the only thing committed. It is intentionally built so it
**cannot reconstruct** an original map's geometry or art — only relations
survive. See `PLAN.md` at the repo root for the full spec.

> **Not part of the game bundle.** Nothing here is imported by `packages/*`
> runtime code. No Three.js, no network, no telemetry. Zero runtime deps — only
> `node:` builtins (runs under Bun). All transforms are pure and deterministic:
> same input → byte-identical output.

## Guardrails (non-negotiable — `PLAN.md` §2)

- **Input is only `NET` + `ACT` JSON.** mapalyze never reads `TIL`/`OBJ`
  geometry, `BMP`/`PYR` textures, or glTF.
- **Output is always normalized + quantized.** Positions are remapped to the
  unit square `[0,1]²` and snapped to a grid (default `100`, i.e. 2 decimals).
  No raw world coordinates ever appear in the output.
- **Raw exports are never committed.** They live in the git-ignored
  `tools/mapalyze/_local/`. Only the abstracted output under
  `docs/specs/maps/_references/` may be committed.
- **No EA-derived test fixtures.** Every fixture in `fixtures/` is synthetic and
  freely invented.

## Pipeline

```
ingest → normalize → graph → classify → analyze → report
         └─ guardrail boundary: world geometry is discarded here ─┘
```

1. **ingest** — load JSON; auto-detect the node/actor arrays and coordinates;
   read explicit edges/neighbours if present. Field/role overrides via config.
2. **normalize** — fit a bounding box on the ground plane (`x`,`z` if a `z`
   field exists, else `x`,`y`), remap to `[0,1]²`, snap to the grid.
3. **graph** — use explicit edges, or infer them via kNN (default `k=3`) or a
   radius join. Undirected, deduplicated, stably sorted.
4. **classify** — roles from ACT config (`base`/`turret`/`spawn`/`capture`) plus
   graph-derived (`endpoint`, `junction`, `chokepoint`). Base fallback: the
   Euclidean-farthest node pair when ACT provides none.
5. **analyze** — connected components; lanes (node-disjoint shortest paths
   between base pairs, via Dijkstra) + length ratios; chokepoints (Tarjan
   articulation points that lie on a lane); symmetry (mirror-x / mirror-y /
   rot180 / none + score).
6. **report** — write `map-analysis.json` + `map-analysis.md`, after a runtime
   guard re-checks every guardrail.

## Building FCMissionReader (Linux / CMake)

FCMissionReader ships with the `Future-Cop-MIT` project. Build it once, locally;
its raw output stays in `tools/mapalyze/_local/` and is never committed.

```bash
# Prerequisites: git, cmake, a C++ toolchain, SDL2 (per the upstream README).
git clone https://github.com/Ghoster738/Future-Cop-MIT.git
cd Future-Cop-MIT
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j

# Export a mission's FUNCTIONAL data as JSON (NET nav graph + ACT actors) into
# this repo's git-ignored scratch dir. Consult the upstream tool's --help for
# the exact export flags in your version; export ONLY NET + ACT, never TIL/OBJ
# geometry or BMP/PYR textures.
mkdir -p /path/to/amigo-metropolis/tools/mapalyze/_local
```

Exact flags vary by FCMissionReader version — that is precisely why ingest is
schema-tolerant and why you should verify the mapping with `inspect` /
`list-types` before running `analyze`.

## Usage

```bash
# 1. Inspect an export's structure to verify field mapping.
bun run tools/mapalyze/src/cli.ts inspect --net ./tools/mapalyze/_local/mission.NET.json

# 2. List distinct ACT type tokens to build your role mapping.
bun run tools/mapalyze/src/cli.ts list-types --act ./tools/mapalyze/_local/mission.ACT.json

# 3. Run the analysis.
bun run tools/mapalyze/src/cli.ts analyze \
  --net   ./tools/mapalyze/_local/mission.NET.json \
  --act   ./tools/mapalyze/_local/mission.ACT.json \
  --config tools/mapalyze/example.config.json \
  --label pilot-A \
  --out   docs/specs/maps/_references/pilot-A/
```

Flags: `--config <path>` (field/role overrides, see `example.config.json`),
`--label <name>`, `--out <dir>`, `--grid <n>`, `--k <n>`, `--radius <n>`.

### Try it against the synthetic fixture

```bash
bun run tools/mapalyze/src/cli.ts analyze \
  --net tools/mapalyze/fixtures/synthetic-3lane.net.json \
  --act tools/mapalyze/fixtures/synthetic-3lane.act.json \
  --label synthetic --out /tmp/mapalyze-demo
```

## Workflow: handing the analysis back to Claude

1. Run `analyze`; review `docs/specs/maps/_references/<label>/map-analysis.md`.
2. Give Claude **the abstracted analysis** (JSON + MD) — **never** the raw
   exports.
3. Claude authors a **new, from-scratch** amigo-metropolis map spec (abstract
   lane graph, node types, balancing params, blockout convention, CC0 theming),
   informed by the principles — not a reconstruction of any original map.

## Tests

```bash
bun test tools/mapalyze     # synthetic fixtures only
```
