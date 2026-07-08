// Graph: build an undirected, deduplicated, stably-sorted adjacency from either
// the export's explicit edges or, when it carries none, synthesized edges via
// k-nearest-neighbour (default k=3) or a radius join. Inference runs in the
// NORMALIZED space, so a radius threshold is a fraction of the unit square.
//
// Pure and deterministic: adjacency lists are sorted by node index, so the same
// input yields the same graph and the downstream analysis is reproducible.

import { dist } from "./normalize";
import type { Config, Vec2 } from "./types";

export interface Graph {
  /** index → node id. */
  readonly ids: readonly string[];
  /** node id → index. */
  readonly index: ReadonlyMap<string, number>;
  /** normalized positions, parallel to `ids`. */
  readonly pos: readonly Vec2[];
  /** adjacency by index; each list sorted ascending, no duplicates, no self. */
  readonly adj: ReadonlyArray<readonly number[]>;
  readonly edgeCount: number;
}

const DEFAULT_K = 3;

export interface BuildOptions {
  /** Per-node neighbour ids from ingest (may be empty). */
  readonly neighbors: ReadonlyArray<readonly string[]>;
  readonly hasExplicitEdges: boolean;
  readonly config: Config;
}

export function buildGraph(
  ids: readonly string[],
  pos: readonly Vec2[],
  opts: BuildOptions,
): Graph {
  const index = new Map<string, number>();
  ids.forEach((id, i) => {
    index.set(id, i);
  });

  const adjSets: Set<number>[] = ids.map(() => new Set<number>());
  const link = (a: number, b: number): void => {
    if (a === b) return;
    (adjSets[a] as Set<number>).add(b);
    (adjSets[b] as Set<number>).add(a);
  };

  if (opts.hasExplicitEdges) {
    opts.neighbors.forEach((list, i) => {
      for (const nid of list) {
        const j = index.get(nid);
        if (j !== undefined) link(i, j);
      }
    });
  } else {
    inferEdges(pos, opts.config, link);
  }

  const adj = adjSets.map((s) => [...s].sort((a, b) => a - b));
  let degSum = 0;
  for (const list of adj) degSum += list.length;

  return { ids, index, pos, adj, edgeCount: degSum / 2 };
}

function inferEdges(
  pos: readonly Vec2[],
  config: Config,
  link: (a: number, b: number) => void,
): void {
  const mode = config.graph?.inferEdges ?? "knn";
  const n = pos.length;
  if (mode === "radius") {
    const r = config.graph?.radius ?? 0.15;
    for (let i = 0; i < n; i++) {
      const pi = pos[i] as Vec2;
      for (let j = i + 1; j < n; j++) {
        if (dist(pi, pos[j] as Vec2) <= r) link(i, j);
      }
    }
    return;
  }
  // k-nearest-neighbour. Symmetrized: if i picks j, the edge exists both ways.
  const k = Math.max(1, config.graph?.k ?? DEFAULT_K);
  for (let i = 0; i < n; i++) {
    const pi = pos[i] as Vec2;
    const order: number[] = [];
    for (let j = 0; j < n; j++) if (j !== i) order.push(j);
    order.sort((a, b) => {
      const da = dist(pi, pos[a] as Vec2);
      const db = dist(pi, pos[b] as Vec2);
      return da - db || a - b;
    });
    for (let m = 0; m < k && m < order.length; m++) link(i, order[m] as number);
  }
}

/** All undirected edges as index pairs [a,b] with a<b, sorted. For reporting. */
export function edgeList(graph: Graph): ReadonlyArray<readonly [number, number]> {
  const out: [number, number][] = [];
  graph.adj.forEach((list, i) => {
    for (const j of list) if (i < j) out.push([i, j]);
  });
  return out;
}
