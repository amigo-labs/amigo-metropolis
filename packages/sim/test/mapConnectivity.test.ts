// Wall-graph connectivity for authored map features. Schema tests only check
// plots/heights/bounds; this catches features placed behind FCOP walls so the
// avatar cannot reach a buy console or a neutral spot (and units cannot leave).
//
// Flood is 4-connected on cell centres (cellSize-aware: FCOP cellSize=1 and
// district-01 cellSize=2) using the same crossesWall* helpers walker/hover use.
//
// The flood itself now lives in src/reach.ts and is shared with the arena
// generator, because a private copy here is exactly how this test came to pass on
// a bridged arena whose roads were walled off: it walked cells only, on layer 0's
// walls, so it could not see either a deck or a road under one. See that file.
import { describe, expect, it } from "bun:test";
import { CAPTURE_RADIUS } from "../src/balance";
import { getMapById, MAP_REGISTRY, type MapData } from "../src/map";
import { type ReachSet, reachableFrom } from "../src/reach";

function floodHas(map: MapData, ax: number, ay: number): ReachSet {
  return reachableFrom(map, ax, ay, { blockWater: true });
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
        ];
        for (const p of pts) {
          expect(f.has(p.x, p.y)).toBe(true);
        }
        // Ring turrets are shot at, not stood on, so requiring their own cell to
        // be walkable would forbid the plinths and parapets the original mounts
        // them on. What must hold is that they are not sealed inside solid
        // geometry: some neighbouring cell has to be reachable, or nobody can
        // ever engage them and they are invulnerable scenery.
        const cell = map.cellSize;
        for (const [i, t] of base.turrets.entries()) {
          const touching =
            f.has(t.x, t.y) ||
            f.has(t.x + cell, t.y) ||
            f.has(t.x - cell, t.y) ||
            f.has(t.x, t.y + cell) ||
            f.has(t.x, t.y - cell);
          if (!touching) throw new Error(`base ${team} ring turret ${i} is sealed off`);
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

    it("neutral turrets and outposts are capturable from spawn 0", () => {
      // On FCOP maps both teams share one ground component; spawn 0 is enough.
      const f = floodHas(map, map.spawns[0].x, map.spawns[0].y);
      // Capturing is PROXIMITY, not occupancy: sim.ts holds a pad for whoever is
      // within CAPTURE_RADIUS of it, and the Warden parks at CAPTURE_RADIUS - 1.
      // The original mounts these pads on raised plinths with parapets around
      // them — all 8 of la-cantina's outer-ring pads have a walkable cell one
      // cell away and none at all on the pad itself. Demanding the pad's own cell
      // be walkable therefore asks for something the game never asks for, and the
      // only way to grant it is to knock the original's parapets down, which is
      // what the generator used to do. Same reasoning the ring-turret check above
      // already applies, and the stricter of the sim's two radii is the bound.
      const reach = CAPTURE_RADIUS - 1;
      const capturable = (p: { x: number; y: number }): boolean => {
        const cell = map.cellSize;
        for (let dx = -reach; dx <= reach; dx += cell) {
          for (let dy = -reach; dy <= reach; dy += cell) {
            if (dx * dx + dy * dy > reach * reach) continue;
            if (f.has(p.x + dx, p.y + dy)) return true;
          }
        }
        return false;
      };
      for (const p of map.turretSpots) {
        if (!capturable(p)) throw new Error(`capture pad (${p.x}, ${p.y}) has no approach`);
      }
      for (const p of map.outpostSpots) {
        if (!capturable(p)) throw new Error(`outpost (${p.x}, ${p.y}) has no approach`);
      }
    });

    it("teams can reach each other on the ground graph", () => {
      const f = floodHas(map, map.spawns[0].x, map.spawns[0].y);
      expect(f.has(map.spawns[1].x, map.spawns[1].y)).toBe(true);
    });
  });
}
