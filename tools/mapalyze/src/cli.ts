// mapalyze CLI — dev-only, offline, no network, no telemetry (PLAN.md §2, §7).
//
//   inspect     probe an export's structure so you can verify field mapping
//   list-types  tally distinct ACT type tokens (build the role mapping)
//   analyze     run the full pipeline → MapAnalysis JSON + map-analysis.md
//
// GUARDRAIL: only NET + ACT JSON is ever read. No TIL/OBJ/BMP/PYR/glTF.
//
//   bun run tools/mapalyze/src/cli.ts inspect    --net ./_local/mission.NET.json
//   bun run tools/mapalyze/src/cli.ts list-types --act ./_local/mission.ACT.json
//   bun run tools/mapalyze/src/cli.ts analyze --net a.json --act b.json \
//       --config tools/mapalyze/example.config.json --label pilot-A \
//       --out docs/specs/maps/_references/pilot-A/

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { findPointArrays, ingestAct, ingestNet, parseJson, tallyActorTypes } from "./ingest";
import { runAnalysis } from "./pipeline";
import { toMarkdown } from "./report";
import type { Config, Json } from "./types";

interface Args {
  readonly _: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    } else {
      positional.push(a);
    }
  }
  return { _: positional, flags };
}

function readJson(path: string): Json {
  return parseJson(readFileSync(path, "utf8"));
}

function loadConfig(path: string | undefined): Config {
  return path ? (readJson(path) as Config) : {};
}

/** Merge CLI numeric overrides (--grid/--k/--radius) into the loaded config. */
function withCliOverrides(config: Config, flags: ReadonlyMap<string, string>): Config {
  const grid = flags.get("grid");
  const k = flags.get("k");
  const radius = flags.get("radius");
  const graph = { ...config.graph };
  if (k !== undefined) {
    graph.k = Number(k);
    graph.inferEdges = graph.inferEdges ?? "knn";
  }
  if (radius !== undefined) {
    graph.radius = Number(radius);
    graph.inferEdges = "radius";
  }
  return {
    ...config,
    grid: grid !== undefined ? Number(grid) : config.grid,
    graph: k !== undefined || radius !== undefined ? graph : config.graph,
  };
}

function cmdInspect(flags: ReadonlyMap<string, string>, config: Config): number {
  const net = flags.get("net");
  const act = flags.get("act");
  if (!net && !act) {
    console.error("inspect: provide --net and/or --act");
    return 1;
  }
  for (const [kind, path] of [
    ["NET", net],
    ["ACT", act],
  ] as const) {
    if (!path) continue;
    const root = readJson(path);
    console.log(`\n=== ${kind}: ${path} ===`);
    const candidates = findPointArrays(root);
    if (candidates.length === 0) {
      console.log("  no coordinate-bearing arrays detected");
    }
    for (const c of candidates) {
      console.log(`  path: ${c.path}`);
      console.log(`    count:  ${c.count}`);
      console.log(`    fields: ${c.fieldNames.join(", ")}`);
      console.log(`    hasZ:   ${c.hasZ}`);
      console.log(`    sample: ${JSON.stringify(c.sample)}`);
    }
    if (kind === "NET") {
      const ing = ingestNet(root, config);
      console.log(
        `  → selected "${ing.path}": ${ing.nodes.length} nodes, ` +
          `ground axes (${ing.groundAxes[0]}, ${ing.groundAxes[1]}), ` +
          `explicit edges: ${ing.hasExplicitEdges}`,
      );
    } else {
      const ing = ingestAct(root, config);
      console.log(`  → selected "${ing.path}": ${ing.actors.length} actors`);
    }
  }
  return 0;
}

function cmdListTypes(flags: ReadonlyMap<string, string>, config: Config): number {
  const act = flags.get("act");
  if (!act) {
    console.error("list-types: provide --act");
    return 1;
  }
  const ing = ingestAct(readJson(act), config);
  const types = tallyActorTypes(ing.actors);
  console.log(`ACT types in ${act} (${ing.actors.length} actors):`);
  for (const t of types) {
    const label = t.type === "" ? "(untyped)" : t.type;
    console.log(`  ${label}: ${t.count}  e.g. [${t.sample[0]}, ${t.sample[1]}]`);
  }
  console.log(
    '\nMap these tokens to roles under "roles" in your config ' +
      "(base / turret / spawn / capture).",
  );
  return 0;
}

function cmdAnalyze(flags: ReadonlyMap<string, string>, config: Config): number {
  const net = flags.get("net");
  if (!net) {
    console.error("analyze: --net is required");
    return 1;
  }
  const act = flags.get("act");
  const label = flags.get("label") ?? "unlabeled";
  const out = flags.get("out") ?? join("docs", "specs", "maps", "_references", label);

  const analysis = runAnalysis(readJson(net), act ? readJson(act) : null, config, label);

  mkdirSync(out, { recursive: true });
  const jsonPath = join(out, "map-analysis.json");
  const mdPath = join(out, "map-analysis.md");
  writeFileSync(jsonPath, `${JSON.stringify(analysis, null, 2)}\n`);
  writeFileSync(mdPath, toMarkdown(analysis));

  console.log(analysis.summary);
  console.log(`\nwrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);
  return 0;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const config = withCliOverrides(loadConfig(args.flags.get("config")), args.flags);

  switch (command) {
    case "inspect":
      return cmdInspect(args.flags, config);
    case "list-types":
      return cmdListTypes(args.flags, config);
    case "analyze":
      return cmdAnalyze(args.flags, config);
    default:
      console.error(
        "usage: mapalyze <inspect|list-types|analyze> [--net f] [--act f] " +
          "[--config f] [--label s] [--out dir] [--grid n] [--k n] [--radius n]",
      );
      return command === undefined ? 1 : 1;
  }
}

process.exit(main());
