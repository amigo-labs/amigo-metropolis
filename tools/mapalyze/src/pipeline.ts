// Pipeline: the end-to-end transform, shared by the CLI and the tests.
//
//   ingest → normalize (guardrail boundary) → graph → classify → analyze → report
//
// Pure with respect to its inputs: given the same NET/ACT JSON and config it
// produces a byte-identical MapAnalysis.

import { computeChokepoints, computeLanes, computeSymmetry, countComponents } from "./analyze";
import type { CanonicalRole } from "./classify";
import { assignRoles, detectBases, resolveRole, snapActors } from "./classify";
import { buildGraph } from "./graph";
import { ingestAct, ingestNet } from "./ingest";
import { computeFit, normalize } from "./normalize";
import { buildAnalysis } from "./report";
import type { Config, Json, MapAnalysis } from "./types";

export function runAnalysis(
  netRoot: Json,
  actRoot: Json | null,
  config: Config,
  label: string,
): MapAnalysis {
  const grid = config.grid ?? 100;

  const net = ingestNet(netRoot, config);
  const act = actRoot !== null ? ingestAct(actRoot, config) : { actors: [], path: "" };

  // One fit from the NET nodes; ACT actors ride the same frame so snapping works.
  const fit = computeFit(net.nodes);
  const norm = normalize(net.nodes, grid, fit);
  const graph = buildGraph(norm.ids, norm.positions, {
    neighbors: net.nodes.map((n) => n.neighbors),
    hasExplicitEdges: net.hasExplicitEdges,
    config,
  });

  const actorPositions = act.actors.map(
    (a) => normalize([a], grid, fit).positions[0] as readonly [number, number],
  );
  const actorRoles: Array<CanonicalRole | null> = act.actors.map((a) =>
    resolveRole(a.type, config),
  );
  const snapped = snapActors(actorPositions, actorRoles, graph, config);

  const bases = detectBases(graph, snapped);
  const baseSet = new Set(bases);

  const lanes = computeLanes(graph, bases);
  const chokepoints = computeChokepoints(graph, lanes);
  const chokepointSet = new Set(chokepoints.map((c) => c.index));

  const { roleCounts } = assignRoles(graph, snapped, baseSet, chokepointSet);
  const components = countComponents(graph);
  const symmetry = computeSymmetry(norm.positions, grid);

  return buildAnalysis({
    graph,
    grid,
    label,
    bases,
    roleCounts,
    components,
    lanes,
    chokepoints,
    symmetry,
    snapped,
  });
}
