// Wall-graph connectivity for authored map features. Schema tests only check
// plots/heights/bounds; this catches features placed behind FCOP walls so the
// avatar cannot reach a buy console or a neutral spot (and units cannot leave).
//
// Flood is 4-connected on cell centres (cellSize-aware: FCOP cellSize=1 and
// district-01 cellSize=2) using the same crossesWall* helpers walker/hover use.
import { describe, expect, it } from "bun:test";
import { crossesWallX, crossesWallY } from "../src/collision";
import { getMapById, isWater, MAP_REGISTRY, type MapData, worldExtent } from "../src/map";

/**
 * Snap a world coordinate to the centre of the cell that contains it.
 * Matches collision.ts indexing: cell column i holds [i*cell, (i+1)*cell).
 */
function cellCenter(map: MapData, v: number): number {
  const cell = map.cellSize;
  const i = Math.floor(v / cell);
  return (i + 0.5) * cell;
}

/** Grid index of the cell that contains world coordinate `v` (clamped). */
function cellIndex(map: MapData, v: number): number {
  const i = Math.floor(v / map.cellSize);
  if (i < 0) return 0;
  if (i > map.size - 1) return map.size - 1;
  return i;
}

function floodHas(
  map: MapData,
  ax: number,
  ay: number,
): { size: number; has: (x: number, y: number) => boolean } {
  const cell = map.cellSize;
  const half = cell * 0.5;
  const ext = worldExtent(map);
  // Dense key over the size×size vertex lattice — no fixed world-space stride.
  const key = (i: number, j: number): number => i * map.size + j;
  const sx = cellCenter(map, ax);
  const sy = cellCenter(map, ay);
  const q: number[][] = [[sx, sy]];
  const seen = new Set<number>([key(cellIndex(map, sx), cellIndex(map, sy))]);
  const dirs = [
    [cell, 0],
    [-cell, 0],
    [0, cell],
    [0, -cell],
  ] as const;
  let qi = 0;
  while (qi < q.length) {
    const [x, y] = q[qi++];
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      // Stay on cell centres inside the playable extent.
      if (nx < half || ny < half || nx > ext - half || ny > ext - half) continue;
      const ni = cellIndex(map, nx);
      const nj = cellIndex(map, ny);
      const k = key(ni, nj);
      if (seen.has(k)) continue;
      if (isWater(map, nx, ny)) continue;
      if (crossesWallX(map, x, nx, y) || crossesWallY(map, nx, y, ny)) continue;
      seen.add(k);
      q.push([nx, ny]);
    }
  }
  return {
    size: seen.size,
    has: (x, y) => seen.has(key(cellIndex(map, x), cellIndex(map, y))),
  };
}

const PLAYABLE_IDS = [
  ...MAP_REGISTRY.map((m) => m.id),
  "district-01", // retired from picker but still golden-backed
];

for (const id of PLAYABLE_IDS) {
  const map = getMapById(id);

  describe(`${id} wall connectivity`, () => {
    it("base structures are reachable from the team spawn", () => {
      for (let team = 0; team < 2; team++) {
        const spawn = map.spawns[team];
        const base = map.bases[team];
        const f = floodHas(map, spawn.x, spawn.y);
        expect(f.size).toBeGreaterThan(20);
        const pts: { name: string; x: number; y: number }[] = [
          { name: "gate", x: base.gate.x, y: base.gate.y },
          { name: "core", x: base.core.x, y: base.core.y },
          { name: "groundConsole", x: base.groundConsole.x, y: base.groundConsole.y },
          { name: "airConsole", x: base.airConsole.x, y: base.airConsole.y },
          { name: "pad", x: base.pad.x, y: base.pad.y },
          ...base.turrets.map((p, i) => ({ name: `ring${i}`, x: p.x, y: p.y })),
        ];
        for (const p of pts) {
          expect(f.has(p.x, p.y)).toBe(true);
        }
      }
    });

    it("unit buy consoles can reach a lane waypoint", () => {
      if (map.lanes.length === 0) return;
      for (let team = 0; team < 2; team++) {
        const base = map.bases[team];
        const lane = map.lanes[0];
        let bestI = 0;
        let bestD = Number.POSITIVE_INFINITY;
        for (let i = 0; i < lane.length; i++) {
          const d = Math.hypot(lane[i].x - base.groundConsole.x, lane[i].y - base.groundConsole.y);
          if (d < bestD) {
            bestD = d;
            bestI = i;
          }
        }
        const wp = lane[bestI];
        const g = floodHas(map, base.groundConsole.x, base.groundConsole.y);
        const a = floodHas(map, base.airConsole.x, base.airConsole.y);
        expect(g.has(wp.x, wp.y)).toBe(true);
        expect(a.has(wp.x, wp.y)).toBe(true);
      }
    });

    it("neutral turrets and outposts are reachable from spawn 0", () => {
      // On FCOP maps both teams share one ground component; spawn 0 is enough.
      const f = floodHas(map, map.spawns[0].x, map.spawns[0].y);
      for (const p of map.turretSpots) {
        expect(f.has(p.x, p.y)).toBe(true);
      }
      for (const p of map.outpostSpots) {
        expect(f.has(p.x, p.y)).toBe(true);
      }
    });

    it("teams can reach each other on the ground graph", () => {
      const f = floodHas(map, map.spawns[0].x, map.spawns[0].y);
      expect(f.has(map.spawns[1].x, map.spawns[1].y)).toBe(true);
    });
  });
}
