// Wall-graph connectivity for authored map features. Schema tests only check
// plots/heights/bounds; this catches features placed behind FCOP walls so the
// avatar cannot reach a buy console or a neutral spot (and units cannot leave).
//
// Flood is 4-connected on .5 cell centres (matching FCOP authoring) using the
// same crossesWall* helpers the walker/hover movement uses.
import { describe, expect, it } from "bun:test";
import { crossesWallX, crossesWallY } from "../src/collision";
import { getMapById, isWater, MAP_REGISTRY, type MapData, worldExtent } from "../src/map";

function floodHas(
  map: MapData,
  ax: number,
  ay: number,
): { size: number; has: (x: number, y: number) => boolean } {
  const sx = Math.floor(ax) + 0.5;
  const sy = Math.floor(ay) + 0.5;
  const key = (x: number, y: number): number => ((x * 2) | 0) * 200_000 + ((y * 2) | 0);
  const q: number[][] = [[sx, sy]];
  const seen = new Set<number>([key(sx, sy)]);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  const ext = worldExtent(map);
  let qi = 0;
  while (qi < q.length) {
    const [x, y] = q[qi++];
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0.5 || ny < 0.5 || nx > ext - 0.5 || ny > ext - 0.5) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      if (isWater(map, nx, ny)) continue;
      if (crossesWallX(map, x, nx, y) || crossesWallY(map, nx, y, ny)) continue;
      seen.add(k);
      q.push([nx, ny]);
    }
  }
  return {
    size: seen.size,
    has: (x, y) => seen.has(key(Math.floor(x) + 0.5, Math.floor(y) + 0.5)),
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
