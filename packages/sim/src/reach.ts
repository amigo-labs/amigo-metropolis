// Layer-aware reachability flood over the wall lattice (issue #29).
//
// WHY THIS EXISTS
// There used to be two floods — `floodFrom` in tools/generators/enrichArena.ts
// and a private copy in packages/sim/test/mapConnectivity.test.ts — and both were
// layer-blind: they walked cells only, against layer 0's walls, and called a
// target reached the moment its GROUND cell was wall-free. On a bridged arena
// that is the wrong question twice over. It says a road under a bridge is blocked
// (the bridge's parapets are charged to it) and it says a deck is reachable when
// only the ground beneath it is.
//
// WHAT MAKES A DECK REACHABLE
// Not a vertical hop: the extractor clusters stacked surfaces at least half a
// metre apart (MULTI_THRESH), so no deck is ever within STEP_SNAP of the floor
// under it, and measuring the vertical gap can only ever say "unreachable". A
// deck is entered SIDEWAYS, where the ground rises to meet its edge — a ramp, in
// other words, which the extractor deliberately keeps inside layer 0 as one
// continuous run. la-cantina has 1180 such entry cells.
//
// So the flood walks (cell, layer) nodes: it crosses walls on the layer it is
// standing on, and on arrival it asks `resolveWalker` which surface it ends up on
// — the same rule the movers use, rather than a second opinion about it.
//
// SINGLE-LAYER MAPS ARE UNCHANGED. With no extra decks, `resolveWalker` returns
// layer 0 everywhere and every node is (cell, 0), which is node-for-node the old
// flood. This module is authoring/test machinery and is never called from the
// tick, but it stays inside the determinism rules anyway so it can be.

import { crossesWallX, crossesWallY } from "./collision";
import { isWater, type MapData, resolveHeight, worldExtent } from "./map";
import { resolveWalker } from "./units";

export interface ReachOptions {
  /**
   * Skip water cells (walkers never enter water). The generator's flood did not
   * check water and the connectivity test did, so it stays a caller's choice
   * rather than a silent behaviour change on one of them.
   */
  blockWater?: boolean;
  /** Layer to start on. Defaults to whatever `resolveWalker` says at the seed. */
  startLayer?: number;
}

export interface ReachSet {
  /** Distinct (cell, layer) nodes reached. */
  readonly size: number;
  /** Distinct CELLS reached, on any layer. */
  readonly cells: number;
  /**
   * The reached cells as dense keys, `i * map.size + j` (x-major — the key the
   * generator's breach BFS walks). Layer is collapsed away: a cell is in here if
   * any deck of it was reached.
   */
  readonly cellKeys: ReadonlySet<number>;
  /** Is the cell containing (x, y) reached on any layer? */
  has(x: number, y: number): boolean;
  /** Is the cell containing (x, y) reached on this exact layer? */
  hasLayer(x: number, y: number, layer: number): boolean;
  /** Lowest reached layer at the cell containing (x, y), or -1 if unreached. */
  layerAt(x: number, y: number): number;
}

/** Grid index of the cell containing world coordinate `v` (clamped). */
function cellIndex(map: MapData, v: number): number {
  const i = Math.floor(v / map.cellSize);
  if (i < 0) return 0;
  if (i > map.size - 1) return map.size - 1;
  return i;
}

/** Centre of the cell containing world coordinate `v`. */
function cellCenter(map: MapData, v: number): number {
  return (Math.floor(v / map.cellSize) + 0.5) * map.cellSize;
}

/**
 * 4-connected flood from (ax, ay) over cell centres and decks.
 *
 * Walls only, plus optional water — no slope limit, matching both floods this
 * replaces. Descents are not blocked (a walker survives a fall; the kerb report's
 * uphill-only rule is the same call), so a one-way drop off a deck is reachable
 * in this graph exactly as it is in the sim.
 */
export function reachableFrom(
  map: MapData,
  ax: number,
  ay: number,
  opts: ReachOptions = {},
): ReachSet {
  const cell = map.cellSize;
  const half = cell * 0.5;
  const ext = worldExtent(map);
  const size = map.size;
  // One node per (cell, layer). Layer count is fixed per map, so the key stays a
  // dense integer and iteration order stays id order (CLAUDE.md hard rule 5).
  const layerCount = map.layerHeights.length + 1;
  const nodeKey = (i: number, j: number, layer: number): number =>
    (i * size + j) * layerCount + layer;

  const sx = cellCenter(map, ax);
  const sy = cellCenter(map, ay);
  const seedH = resolveHeight(map, sx, sy, opts.startLayer ?? 0);
  const seedLayer =
    opts.startLayer ?? resolveWalker(map, sx, sy, resolveHeight(map, sx, sy, 0)).layer;

  const seen = new Set<number>();
  const cellsSeen = new Set<number>();
  // Parallel arrays instead of tuples so the queue allocates once per node.
  const qx: number[] = [sx];
  const qy: number[] = [sy];
  const qL: number[] = [seedLayer];
  const qH: number[] = [seedH];
  seen.add(nodeKey(cellIndex(map, sx), cellIndex(map, sy), seedLayer));
  cellsSeen.add(cellIndex(map, sx) * size + cellIndex(map, sy));

  const dirs = [
    [cell, 0],
    [-cell, 0],
    [0, cell],
    [0, -cell],
  ] as const;

  for (let qi = 0; qi < qx.length; qi++) {
    const x = qx[qi];
    const y = qy[qi];
    const layer = qL[qi];
    const h = qH[qi];
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < half || ny < half || nx > ext - half || ny > ext - half) continue;
      if (opts.blockWater === true && isWater(map, nx, ny)) continue;
      // Cross the wall on the deck we are standing on, not on the ground below.
      if (dx !== 0 && crossesWallX(map, x, nx, y, layer)) continue;
      if (dy !== 0 && crossesWallY(map, x, y, ny, layer)) continue;
      // Which surface do we land on? Same question the movers ask.
      const wr = resolveWalker(map, nx, ny, h);
      const k = nodeKey(cellIndex(map, nx), cellIndex(map, ny), wr.layer);
      if (seen.has(k)) continue;
      seen.add(k);
      cellsSeen.add(cellIndex(map, nx) * size + cellIndex(map, ny));
      qx.push(nx);
      qy.push(ny);
      qL.push(wr.layer);
      qH.push(wr.height);
    }
  }

  return {
    size: seen.size,
    cells: cellsSeen.size,
    cellKeys: cellsSeen,
    has: (x, y) => cellsSeen.has(cellIndex(map, x) * size + cellIndex(map, y)),
    hasLayer: (x, y, layer) => seen.has(nodeKey(cellIndex(map, x), cellIndex(map, y), layer)),
    layerAt: (x, y) => {
      const i = cellIndex(map, x);
      const j = cellIndex(map, y);
      for (let L = 0; L < layerCount; L++) {
        if (seen.has(nodeKey(i, j, L))) return L;
      }
      return -1;
    },
  };
}
