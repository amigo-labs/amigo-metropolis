// Unit tests against the synthetic (freely-invented) 3-lane fixture. No EA /
// Future Cop data is used anywhere (PLAN.md §2). The fixture is a two-base map
// with three node-disjoint lanes and one articulation-point chokepoint, built
// to be left-right (mirror-y) symmetric.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/graph";
import { parseJson } from "../src/ingest";
import { applyFit, computeFit, normalize } from "../src/normalize";
import { runAnalysis } from "../src/pipeline";
import type { Config, RawPoint } from "../src/types";

const FIX = join(import.meta.dir, "..", "fixtures");
const netRoot = parseJson(readFileSync(join(FIX, "synthetic-3lane.net.json"), "utf8"));
const actRoot = parseJson(readFileSync(join(FIX, "synthetic-3lane.act.json"), "utf8"));

function analyze(config: Config = {}) {
  return runAnalysis(netRoot, actRoot, config, "test");
}

describe("normalize", () => {
  test("fits to the unit square and snaps to the grid", () => {
    const pts: RawPoint[] = [
      { id: "a", gx: 10, gy: 20 },
      { id: "b", gx: 110, gy: 20 },
      { id: "c", gx: 60, gy: 120 },
    ];
    const { positions } = normalize(pts, 100);
    expect(positions[0]).toEqual([0, 0]);
    expect(positions[1]).toEqual([1, 0]);
    expect(positions[2]).toEqual([0.5, 1]);
  });

  test("is idempotent: re-normalizing normalized points is a no-op", () => {
    const pts: RawPoint[] = [
      { id: "a", gx: 0, gy: 100 },
      { id: "b", gx: 200, gy: 100 },
      { id: "c", gx: 100, gy: 55 },
      { id: "d", gx: 60, gy: 170 },
    ];
    const first = normalize(pts, 100);
    const asPoints: RawPoint[] = first.positions.map((p, i) => ({
      id: String(i),
      gx: p[0],
      gy: p[1],
    }));
    const second = normalize(asPoints, 100);
    expect(second.positions).toEqual(first.positions);
  });

  test("degenerate axis maps to zero instead of dividing by zero", () => {
    const pts: RawPoint[] = [
      { id: "a", gx: 5, gy: 5 },
      { id: "b", gx: 5, gy: 25 },
    ];
    const { positions } = normalize(pts, 100);
    expect(positions[0]).toEqual([0, 0]);
    expect(positions[1]).toEqual([0, 1]);
  });
});

describe("graph inference", () => {
  test("kNN synthesizes a connected graph when no edges are present", () => {
    const fit = computeFit([
      { id: "0", gx: 0, gy: 0 },
      { id: "3", gx: 30, gy: 0 },
    ]);
    const pos = [
      applyFit(fit, 0, 0, 100),
      applyFit(fit, 10, 0, 100),
      applyFit(fit, 20, 0, 100),
      applyFit(fit, 30, 0, 100),
    ];
    const graph = buildGraph(["0", "1", "2", "3"], pos, {
      neighbors: [[], [], [], []],
      hasExplicitEdges: false,
      config: { graph: { inferEdges: "knn", k: 2 } },
    });
    expect(graph.edgeCount).toBeGreaterThan(0);
    // Chain of 4 collinear points, k=2 → each links to its two nearest.
    expect(graph.adj[0]).toContain(1);
    expect(graph.adj[3]).toContain(2);
  });
});

describe("3-lane fixture", () => {
  test("topology: 9 nodes, 10 edges, 1 component", () => {
    const a = analyze();
    expect(a.topology.nodeCount).toBe(9);
    expect(a.topology.edgeCount).toBe(10);
    expect(a.topology.components).toBe(1);
  });

  test("detects exactly 2 bases", () => {
    const a = analyze();
    expect(a.bases.length).toBe(2);
    expect(a.bases.map((b) => b.id).sort()).toEqual(["0", "1"]);
  });

  test("finds 3 lanes, shortest normalized to ratio 1.0, strictly increasing", () => {
    const a = analyze();
    expect(a.lanes.length).toBe(3);
    expect(a.lanes[0]?.lengthRatio).toBe(1);
    for (let i = 1; i < a.lanes.length; i++) {
      expect(a.lanes[i]?.lengthRatio).toBeGreaterThan(a.lanes[i - 1]?.lengthRatio as number);
    }
    // center (2 hops) < south (3 hops) < north (4 hops)
    expect(a.lanes.map((l) => l.hops)).toEqual([2, 3, 4]);
  });

  test("role counts match the fixture layout", () => {
    const a = analyze();
    expect(a.topology.roleCounts).toEqual({
      base: 2,
      turret: 2,
      spawn: 2,
      capture: 1,
      junction: 0,
      chokepoint: 1,
      endpoint: 0,
      other: 1,
    });
  });

  test("one chokepoint: the center node (articulation point on a lane)", () => {
    const a = analyze();
    expect(a.chokepoints.length).toBe(1);
    const c = a.chokepoints[0];
    expect(c?.degree).toBe(3);
    expect(c?.onLanes).toContain("0->1");
    expect(c?.pos).toEqual([0.5, 0.47]);
  });

  test("turrets and spawns are surfaced from ACT", () => {
    const a = analyze();
    expect(a.turrets.length).toBe(2);
    expect(a.spawns.length).toBe(2);
    for (const s of a.spawns) expect(["0", "1"]).toContain(s.nearestBase);
  });

  test("detects mirror-y symmetry with a perfect score", () => {
    const a = analyze();
    expect(a.symmetry.type).toBe("mirror-y");
    expect(a.symmetry.score).toBe(1);
  });

  test("all positions are quantized and inside the unit square", () => {
    const a = analyze();
    const check = (p: readonly [number, number]) => {
      for (const v of p) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6);
      }
    };
    for (const b of a.bases) check(b.pos);
    for (const c of a.chokepoints) check(c.pos);
    for (const t of a.turrets) check(t.pos);
    for (const s of a.spawns) check(s.pos);
  });

  test("is deterministic: two runs produce byte-identical output", () => {
    const one = JSON.stringify(analyze());
    const two = JSON.stringify(analyze());
    expect(one).toBe(two);
  });

  test("output carries the abstracted-analysis provenance, never geometry", () => {
    const a = analyze();
    expect(a.schema).toBe("mapalyze/1");
    expect(a.provenance).toBe("abstracted-analysis");
    expect(a.space.normalized).toBe(true);
  });
});
