// Report: assemble the MapAnalysis contract, enforce the guardrails at runtime,
// and render a human-readable Markdown summary.
//
// The output guard (PLAN.md §4 Phase 4, §9) is the last line of defence: it
// throws if any position escaped normalization/quantization or if the role
// tally is inconsistent. Nothing leaves the tool without passing it.

import type { Chokepoint, Lane } from "./analyze";
import type { SnappedActor } from "./classify";
import type { Graph } from "./graph";
import { dist } from "./normalize";
import type { MapAnalysis, NodeRole, SymmetryType, Vec2 } from "./types";
import { NODE_ROLES } from "./types";

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** Lane closest to a point, by nearest node on each lane's path. */
function nearestLaneLabel(pos: Vec2, graph: Graph, lanes: readonly Lane[]): string {
  let bestLabel = "";
  let bestD = Number.POSITIVE_INFINITY;
  for (const lane of lanes) {
    let laneD = Number.POSITIVE_INFINITY;
    for (const idx of lane.path) {
      const d = dist(pos, graph.pos[idx] as Vec2);
      if (d < laneD) laneD = d;
    }
    if (laneD < bestD) {
      bestD = laneD;
      bestLabel = lane.label;
    }
  }
  return bestLabel;
}

function nearestBaseId(pos: Vec2, graph: Graph, bases: readonly number[]): string {
  let bestId = "";
  let bestD = Number.POSITIVE_INFINITY;
  for (const idx of bases) {
    const d = dist(pos, graph.pos[idx] as Vec2);
    if (d < bestD) {
      bestD = d;
      bestId = graph.ids[idx] as string;
    }
  }
  return bestId;
}

export interface BuildParams {
  readonly graph: Graph;
  readonly grid: number;
  readonly label: string;
  readonly bases: readonly number[];
  readonly roleCounts: Readonly<Record<NodeRole, number>>;
  readonly components: number;
  readonly lanes: readonly Lane[];
  readonly chokepoints: readonly Chokepoint[];
  readonly symmetry: { readonly type: SymmetryType; readonly score: number };
  readonly snapped: readonly SnappedActor[];
}

export function buildAnalysis(params: BuildParams): MapAnalysis {
  const { graph, grid, label, bases, roleCounts, components, lanes, chokepoints, symmetry } =
    params;

  const minLen = lanes.reduce((m, l) => Math.min(m, l.lengthNorm), Number.POSITIVE_INFINITY);
  const lanesOut = lanes.map((l) => ({
    from: graph.ids[l.fromIndex] as string,
    to: graph.ids[l.toIndex] as string,
    hops: l.hops,
    lengthNorm: round4(l.lengthNorm),
    lengthRatio: Number.isFinite(minLen) && minLen > 0 ? round4(l.lengthNorm / minLen) : 1,
  }));

  const basesOut = bases.map((idx) => ({
    id: graph.ids[idx] as string,
    pos: graph.pos[idx] as Vec2,
  }));

  const chokepointsOut = chokepoints.map((c) => ({
    pos: graph.pos[c.index] as Vec2,
    degree: c.degree,
    onLanes: c.onLanes,
  }));

  const turrets = params.snapped
    .filter((s) => s.role === "turret")
    .map((s) => ({ pos: s.pos, nearestLane: nearestLaneLabel(s.pos, graph, lanes) }))
    .sort((a, b) => a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1]);

  const spawns = params.snapped
    .filter((s) => s.role === "spawn")
    .map((s) => ({ pos: s.pos, nearestBase: nearestBaseId(s.pos, graph, bases) }))
    .sort((a, b) => a.pos[0] - b.pos[0] || a.pos[1] - b.pos[1]);

  const maxRatio = lanesOut.reduce((m, l) => Math.max(m, l.lengthRatio), 1);
  const summary =
    `${label}: ${graph.ids.length} nodes, ${graph.edgeCount} edges, ` +
    `${components} component${components === 1 ? "" : "s"}; ` +
    `${basesOut.length} base${basesOut.length === 1 ? "" : "s"}, ` +
    `${lanesOut.length} lane${lanesOut.length === 1 ? "" : "s"} ` +
    `(length ratio up to ${maxRatio.toFixed(2)}); ` +
    `${chokepointsOut.length} chokepoint${chokepointsOut.length === 1 ? "" : "s"}; ` +
    `symmetry ${symmetry.type}${symmetry.type === "none" ? "" : ` (score ${symmetry.score.toFixed(2)})`}. ` +
    "Relative, quantized topology only — not a geometric reconstruction.";

  const analysis: MapAnalysis = {
    schema: "mapalyze/1",
    provenance: "abstracted-analysis",
    label,
    space: {
      normalized: true,
      grid,
      note: "relative, quantized — not a geometric reconstruction",
    },
    topology: {
      nodeCount: graph.ids.length,
      edgeCount: graph.edgeCount,
      components,
      roleCounts,
    },
    bases: basesOut,
    lanes: lanesOut,
    chokepoints: chokepointsOut,
    turrets,
    spawns,
    symmetry: { type: symmetry.type, score: symmetry.score },
    summary,
  };

  validateAnalysis(analysis);
  return analysis;
}

/** Enforce the guardrails at runtime. Throws on any violation. */
export function validateAnalysis(a: MapAnalysis): void {
  if (a.schema !== "mapalyze/1") throw new Error("guard: bad schema tag");
  if (a.provenance !== "abstracted-analysis") throw new Error("guard: bad provenance");
  const grid = a.space.grid;
  if (!(grid > 0) || !Number.isInteger(grid))
    throw new Error("guard: grid must be a positive integer");

  const checkPos = (pos: Vec2, where: string): void => {
    if (pos.length !== 2) throw new Error(`guard: ${where} pos must have 2 components`);
    for (const v of pos) {
      if (!Number.isFinite(v)) throw new Error(`guard: ${where} pos is not finite`);
      if (v < 0 || v > 1) throw new Error(`guard: ${where} pos ${v} outside [0,1]`);
      if (Math.abs(v * grid - Math.round(v * grid)) > 1e-6) {
        throw new Error(`guard: ${where} pos ${v} is not grid-snapped`);
      }
    }
  };

  for (const b of a.bases) checkPos(b.pos, "base");
  for (const c of a.chokepoints) checkPos(c.pos, "chokepoint");
  for (const t of a.turrets) checkPos(t.pos, "turret");
  for (const s of a.spawns) checkPos(s.pos, "spawn");

  let roleSum = 0;
  for (const r of NODE_ROLES) roleSum += a.topology.roleCounts[r];
  if (roleSum !== a.topology.nodeCount) {
    throw new Error(`guard: role counts (${roleSum}) != nodeCount (${a.topology.nodeCount})`);
  }

  for (const l of a.lanes) {
    if (!Number.isFinite(l.lengthNorm) || l.lengthNorm < 0)
      throw new Error("guard: bad lane length");
    if (!(l.lengthRatio >= 1 - 1e-9)) throw new Error("guard: lane ratio < 1");
  }
  if (!Number.isFinite(a.symmetry.score) || a.symmetry.score < 0 || a.symmetry.score > 1) {
    throw new Error("guard: symmetry score outside [0,1]");
  }
}

/** Render the analysis as Markdown prose (map-analysis.md). */
export function toMarkdown(a: MapAnalysis): string {
  const lines: string[] = [];
  lines.push(`# Map analysis — ${a.label}`);
  lines.push("");
  lines.push(`> ${a.summary}`);
  lines.push("");
  lines.push(
    `_Provenance: **${a.provenance}**. Space: normalized to the unit square, ` +
      `quantized to a ${a.space.grid}-step grid. ${a.space.note}._`,
  );
  lines.push("");

  lines.push("## Topology");
  lines.push("");
  lines.push(`- Nodes: ${a.topology.nodeCount}`);
  lines.push(`- Edges: ${a.topology.edgeCount}`);
  lines.push(`- Components: ${a.topology.components}`);
  lines.push("- Roles:");
  for (const role of NODE_ROLES) {
    const count = a.topology.roleCounts[role];
    if (count > 0) lines.push(`  - ${role}: ${count}`);
  }
  lines.push("");

  lines.push("## Bases");
  lines.push("");
  if (a.bases.length === 0) lines.push("_none detected_");
  for (const b of a.bases) lines.push(`- \`${b.id}\` at (${b.pos[0]}, ${b.pos[1]})`);
  lines.push("");

  lines.push("## Lanes");
  lines.push("");
  if (a.lanes.length === 0) lines.push("_none detected_");
  else {
    lines.push("| from | to | hops | length | ratio |");
    lines.push("| --- | --- | ---: | ---: | ---: |");
    for (const l of a.lanes) {
      lines.push(`| ${l.from} | ${l.to} | ${l.hops} | ${l.lengthNorm} | ${l.lengthRatio} |`);
    }
  }
  lines.push("");

  lines.push("## Chokepoints");
  lines.push("");
  if (a.chokepoints.length === 0) lines.push("_none detected_");
  for (const c of a.chokepoints) {
    lines.push(
      `- (${c.pos[0]}, ${c.pos[1]}) — degree ${c.degree}, on lanes ${c.onLanes.join(", ")}`,
    );
  }
  lines.push("");

  lines.push("## Turrets");
  lines.push("");
  if (a.turrets.length === 0) lines.push("_none detected_");
  for (const t of a.turrets)
    lines.push(`- (${t.pos[0]}, ${t.pos[1]}) — nearest lane ${t.nearestLane}`);
  lines.push("");

  lines.push("## Spawns");
  lines.push("");
  if (a.spawns.length === 0) lines.push("_none detected_");
  for (const s of a.spawns)
    lines.push(`- (${s.pos[0]}, ${s.pos[1]}) — nearest base \`${s.nearestBase}\``);
  lines.push("");

  lines.push("## Symmetry");
  lines.push("");
  lines.push(`- Type: ${a.symmetry.type}`);
  lines.push(`- Score: ${a.symmetry.score}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}
