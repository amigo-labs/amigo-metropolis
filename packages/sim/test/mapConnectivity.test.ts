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
import { ORIGINAL_CAPTURE_RANGE } from "../src/balance";
import { getMapById, MAP_REGISTRY, type MapData, resolveHeight } from "../src/map";
import { type ReachSet, reachableFrom } from "../src/reach";
import { rideHeight } from "../src/sim";

// Water is not blocked: on NORMAL a walker that enters it becomes a hover and
// crosses it (fcop-fidelity.md P13), and on Hk the spawns stand on it. Ovmp's
// neutral pad at (173, 193.5) is reached only across it. (Until the water plate
// was read as water on deck 1 too, the walk-only flood stepped over it there.)
function floodHas(map: MapData, ax: number, ay: number, startLayer?: number): ReachSet {
  return reachableFrom(map, ax, ay, startLayer === undefined ? {} : { startLayer });
}

/**
 * Deck-aware: is the feature at (x, y) on `layer` served by a surface the flood
 * stands on — its own, or one within `reach` in plan and `rise` in height of it
 * (`sphere`: both together, as a 3D touch is measured). The ground counts at the
 * water's surface where there is water: a walker that enters it hovers. The
 * same test tools/generators/enrichArena.ts repairReachability holds the
 * generator to.
 */
function served(
  map: MapData,
  f: ReachSet,
  p: { x: number; y: number; layer: number },
  reach: number,
  rise: number,
  sphere = false,
  lift = 0,
): boolean {
  if (f.hasLayer(p.x, p.y, p.layer)) return true;
  const th = resolveHeight(map, p.x, p.y, p.layer) + lift;
  const ci = Math.floor(p.x);
  const cj = Math.floor(p.y);
  const r = Math.ceil(reach);
  for (let i = ci - r; i <= ci + r; i++) {
    for (let j = cj - r; j <= cj + r; j++) {
      const cx = i + 0.5;
      const cy = j + 0.5;
      const flat = (cx - p.x) ** 2 + (cy - p.y) ** 2;
      if (flat > reach * reach && (i !== ci || j !== cj)) continue;
      for (let L = 0; L <= map.layerHeights.length; L++) {
        if (!f.hasLayer(cx, cy, L)) continue;
        const h = L === 0 ? rideHeight(map, cx, cy, true) : resolveHeight(map, cx, cy, L);
        const dh = h - th;
        if (sphere ? flat + dh * dh <= reach * reach : Math.abs(dh) <= rise) return true;
      }
    }
  }
  return false;
}

const PLAYABLE_IDS = MAP_REGISTRY.map((m) => m.id);

for (const id of PLAYABLE_IDS) {
  const map = getMapById(id);

  describe(`${id} wall connectivity`, () => {
    it("base structures are reachable from the team spawn", () => {
      for (let team = 0; team < 2; team++) {
        const spawn = map.spawns[team];
        const base = map.bases[team];
        const f = floodHas(map, spawn.x, spawn.y, spawn.layer);
        expect(f.size).toBeGreaterThan(20);
        // The gate and the core are a produced unit's to reach (the
        // Dreadnought stands on its node's surface itself): their cell will do.
        expect(f.has(base.gate.x, base.gate.y)).toBe(true);
        expect(f.has(base.core.x, base.core.y)).toBe(true);
        // A shop answers inside its trigger box about the console, on the
        // console's own surface, grown by the buyer's radius (fcop-fidelity.md
        // R17): Hk's stand on a deck over the canal and are bought from the water.
        const r = spawn.hover ? map.radii.hover : map.radii.walker;
        for (const [c, box] of [
          [base.groundConsole, base.groundBuy],
          [base.airConsole, base.airBuy],
        ] as const) {
          // Every PA shop box is 2 m high either way (raw 2048, the trigger's
          // half-extent raw/1024).
          if (!served(map, f, c, box.halfW + r, 2 + r)) {
            throw new Error(`base ${team} console (${c.x}, ${c.y}) on surface ${c.layer} unserved`);
          }
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
      const f = floodHas(map, map.spawns[0].x, map.spawns[0].y, map.spawns[0].layer);
      // Capturing is PROXIMITY, not occupancy: sim.ts gives a pad to a press
      // within the arena's capture range plus the avatar's radius — at least
      // 4.0 + 0.4 m on every imported arena — and ORIGINAL_CAPTURE_RANGE, 4 m, is
      // inside that everywhere.
      // The original mounts these pads on raised plinths with parapets around
      // them — all 8 of la-cantina's outer-ring pads have a walkable cell one
      // cell away and none at all on the pad itself. Demanding the pad's own cell
      // be walkable therefore asks for something the game never asks for, and the
      // only way to grant it is to knock the original's parapets down, which is
      // what the generator used to do. Same reasoning the ring-turret check above
      // already applies.
      // A capture is measured in 3D (sim.ts withinCapture), so a pad on a deck
      // needs an approach within the range of the deck, not of the ground
      // under it. An outpost's zone and pads are touched in 3D as well, its
      // radius plus the mech's (sim.ts touchesZone).
      const reach = ORIGINAL_CAPTURE_RANGE;
      for (const p of map.turretSpots) {
        if (!served(map, f, p, reach, reach, true)) {
          throw new Error(`capture pad (${p.x}, ${p.y}) on surface ${p.layer} has no approach`);
        }
      }
      const r = map.spawns[0].hover ? map.radii.hover : map.radii.walker;
      map.outposts.forEach((o, k) => {
        for (const p of [map.outpostSpots[k], o.tankPad, o.jetPad]) {
          if (!served(map, f, p, o.zone + r, o.zone + r, true)) {
            throw new Error(`outpost ${k} zone (${p.x}, ${p.y}) on surface ${p.layer} untouched`);
          }
        }
      });
    });

    it("teams can reach each other on the ground graph", () => {
      const s = map.spawns;
      const f = floodHas(map, s[0].x, s[0].y, s[0].layer);
      // On the surface the other spawn stands on (Hk's: the canal's water).
      expect(f.hasLayer(s[1].x, s[1].y, s[1].layer)).toBe(true);
    });

    it("every pickup is collected walking, but the one on Slim's platform", () => {
      // A pickup's box: its narrower half-extent in plan, its half-height about
      // its lift (sim.ts systemPickups). The exception is the original's: the
      // pickup at (146.06, 124.06) on proving-ground and bug-hunt (Slim and Joke
      // share the ground) stands on a 1.8 m platform no walkable surface leads
      // onto; the flood walks and does not jump. Pinned so the list cannot grow.
      const f = floodHas(map, map.spawns[0].x, map.spawns[0].y, map.spawns[0].layer);
      const unwalked = map.pickups
        .filter((p) => !served(map, f, p, Math.min(p.halfW, p.halfL), p.halfH, false, p.lift))
        .map((p) => `${p.x},${p.y}`);
      const known = id === "proving-ground" || id === "bug-hunt" ? ["146.064,124.0625"] : [];
      expect(unwalked).toEqual(known);
    });
  });
}
