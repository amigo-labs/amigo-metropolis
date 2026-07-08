// Analyze: the graph algorithms that turn a normalized, classified graph into
// topology metrics, lanes, chokepoints, and a symmetry verdict. Everything here
// is hand-rolled (zero runtime deps, PLAN.md §3) and deterministic — stable
// sorts, fixed tolerances, no time/locale/random.

import type { Graph } from "./graph";
import { dist } from "./normalize";
import type { SymmetryType, Vec2 } from "./types";

/** A lane is a node-disjoint route between a pair of bases. */
export interface Lane {
  readonly fromIndex: number;
  readonly toIndex: number;
  /** Node indices along the route, inclusive of both base endpoints. */
  readonly path: readonly number[];
  readonly hops: number;
  readonly lengthNorm: number;
  /** "fromId->toId". */
  readonly label: string;
}

export interface Chokepoint {
  readonly index: number;
  readonly degree: number;
  readonly onLanes: readonly string[];
}

/** Number of connected components (BFS over dense index adjacency). */
export function countComponents(graph: Graph): number {
  const n = graph.ids.length;
  const seen = new Uint8Array(n);
  let components = 0;
  const queue: number[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    components++;
    seen[s] = 1;
    queue.length = 0;
    queue.push(s);
    while (queue.length > 0) {
      const u = queue.pop() as number;
      for (const v of graph.adj[u] as readonly number[]) {
        if (!seen[v]) {
          seen[v] = 1;
          queue.push(v);
        }
      }
    }
  }
  return components;
}

/**
 * Dijkstra shortest path (Euclidean edge weights in normalized space), O(V²) so
 * it is fully deterministic. `blocked` nodes are skipped except src/dst. Ties
 * break toward the lower node index. Returns null when dst is unreachable.
 */
function dijkstra(
  graph: Graph,
  src: number,
  dst: number,
  blocked: ReadonlySet<number>,
): { path: number[]; length: number } | null {
  const n = graph.ids.length;
  const distTo = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  distTo[src] = 0;

  for (;;) {
    let u = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      if (done[i] || (distTo[i] as number) >= best) continue;
      best = distTo[i] as number;
      u = i;
    }
    if (u === -1) break;
    if (u === dst) break;
    done[u] = 1;
    const pu = graph.pos[u] as Vec2;
    for (const v of graph.adj[u] as readonly number[]) {
      if (done[v]) continue;
      if (v !== src && v !== dst && blocked.has(v)) continue;
      const nd = (distTo[u] as number) + dist(pu, graph.pos[v] as Vec2);
      if (nd < (distTo[v] as number)) {
        distTo[v] = nd;
        prev[v] = u;
      }
    }
  }

  if (!Number.isFinite(distTo[dst])) return null;
  const path: number[] = [];
  for (let at = dst; at !== -1; at = prev[at] as number) path.push(at);
  path.reverse();
  return { path, length: distTo[dst] as number };
}

/**
 * Lanes between every base pair: repeatedly take the shortest path, then block
 * its intermediate nodes and search again, yielding node-disjoint routes. A
 * direct base-to-base edge (no intermediate) is recorded once, then we stop.
 */
export function computeLanes(graph: Graph, bases: readonly number[]): Lane[] {
  const lanes: Lane[] = [];
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < bases.length; i++) {
    for (let j = i + 1; j < bases.length; j++) {
      pairs.push([bases[i] as number, bases[j] as number]);
    }
  }
  for (const [a, b] of pairs) {
    const blocked = new Set<number>();
    for (;;) {
      const result = dijkstra(graph, a, b, blocked);
      if (!result) break;
      const { path, length } = result;
      let lengthNorm = 0;
      for (let i = 1; i < path.length; i++) {
        lengthNorm += dist(
          graph.pos[path[i - 1] as number] as Vec2,
          graph.pos[path[i] as number] as Vec2,
        );
      }
      // `length` and the recomputed `lengthNorm` agree; keep the explicit sum.
      void length;
      lanes.push({
        fromIndex: a,
        toIndex: b,
        path,
        hops: path.length - 1,
        lengthNorm,
        label: `${graph.ids[a]}->${graph.ids[b]}`,
      });
      const intermediates = path.slice(1, -1);
      if (intermediates.length === 0) break;
      for (const m of intermediates) blocked.add(m);
    }
  }
  // Stable: shortest first, then by endpoints.
  return lanes.sort(
    (x, y) =>
      x.lengthNorm - y.lengthNorm ||
      x.fromIndex - y.fromIndex ||
      x.toIndex - y.toIndex ||
      x.hops - y.hops,
  );
}

/** Iterative Tarjan articulation points (handles disconnected graphs). */
export function articulationPoints(graph: Graph): Set<number> {
  const n = graph.ids.length;
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const parent = new Int32Array(n).fill(-1);
  const ap = new Set<number>();
  let timer = 0;

  for (let s = 0; s < n; s++) {
    if (disc[s] !== -1) continue;
    let rootChildren = 0;
    // Stack frames: [node, adjacency cursor].
    const stack: Array<[number, number]> = [[s, 0]];
    disc[s] = low[s] = timer++;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as [number, number];
      const u = frame[0];
      const adjU = graph.adj[u] as readonly number[];
      if (frame[1] < adjU.length) {
        const v = adjU[frame[1] as number] as number;
        frame[1]++;
        if (v === (parent[u] as number)) continue;
        if ((disc[v] as number) === -1) {
          parent[v] = u;
          disc[v] = low[v] = timer++;
          if (u === s) rootChildren++;
          stack.push([v, 0]);
        } else {
          if ((disc[v] as number) < (low[u] as number)) low[u] = disc[v] as number;
        }
      } else {
        stack.pop();
        const p = parent[u] as number;
        if (p !== -1) {
          if ((low[u] as number) < (low[p] as number)) low[p] = low[u] as number;
          if (p !== s && (low[u] as number) >= (disc[p] as number)) ap.add(p);
        }
      }
    }
    if (rootChildren > 1) ap.add(s);
  }
  return ap;
}

/** Articulation points that lie on at least one lane become chokepoints. */
export function computeChokepoints(graph: Graph, lanes: readonly Lane[]): Chokepoint[] {
  const aps = articulationPoints(graph);
  const laneNodes = new Map<number, Set<string>>();
  for (const lane of lanes) {
    for (const idx of lane.path) {
      if (!laneNodes.has(idx)) laneNodes.set(idx, new Set());
      (laneNodes.get(idx) as Set<string>).add(lane.label);
    }
  }
  const out: Chokepoint[] = [];
  for (const idx of [...aps].sort((a, b) => a - b)) {
    const labels = laneNodes.get(idx);
    if (!labels) continue;
    out.push({
      index: idx,
      degree: (graph.adj[idx] as readonly number[]).length,
      onLanes: [...labels].sort(),
    });
  }
  return out;
}

/**
 * Symmetry: centre the node cloud on its centroid, then test three transforms
 * via one-to-one nearest-neighbour matching within a quantization-aware
 * tolerance. Returns the best-scoring transform, or "none" below threshold.
 */
export function computeSymmetry(
  positions: readonly Vec2[],
  grid: number,
): { type: SymmetryType; score: number } {
  const n = positions.length;
  if (n === 0) return { type: "none", score: 0 };

  let cx = 0;
  let cy = 0;
  for (const p of positions) {
    cx += p[0];
    cy += p[1];
  }
  cx /= n;
  cy /= n;

  const centered: Vec2[] = positions.map((p) => [p[0] - cx, p[1] - cy]);
  const tol = 2 / grid;

  const transforms: Array<{ type: SymmetryType; fn: (p: Vec2) => Vec2 }> = [
    { type: "mirror-x", fn: (p) => [p[0], -p[1]] },
    { type: "mirror-y", fn: (p) => [-p[0], p[1]] },
    { type: "rot180", fn: (p) => [-p[0], -p[1]] },
  ];

  let bestType: SymmetryType = "none";
  let bestScore = 0;
  for (const { type, fn } of transforms) {
    let matched = 0;
    const used = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const t = fn(centered[i] as Vec2);
      let pick = -1;
      let pickD = tol;
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        const d = dist(t, centered[j] as Vec2);
        if (d <= pickD) {
          pickD = d;
          pick = j;
        }
      }
      if (pick !== -1) {
        used[pick] = 1;
        matched++;
      }
    }
    const score = matched / n;
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  const rounded = Math.round(bestScore * grid) / grid;
  return bestScore >= 0.8 ? { type: bestType, score: rounded } : { type: "none", score: rounded };
}
