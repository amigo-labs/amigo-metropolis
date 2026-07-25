// Schema + playability validation for the committed FCOP v1 arenas beyond
// urban-jungle (which has its own file): proving-ground (mission Slim),
// la-cantina (mission Mp) and bug-hunt (mission Joke), each with an exact
// heights-hash pin. The heightfields are extracted 1:1 from the original
// missions (int8, 1/32 m units) by tools/generators/convert.ts; regenerating one
// changes gameplay everywhere it is sampled, so a changed pin means a
// SIM_VERSION bump + golden regeneration for every golden recorded on it.
//
// Like urban-jungle, FCOP terrain is asymmetric and Stage 1 has no water —
// the district-01 mirror + river assertions are deliberately absent.
import { describe, expect, it } from "bun:test";
import { AVATAR_WALKER_MAX_SLOPE } from "../src/balance";
import { crossesWallX, crossesWallY } from "../src/collision";
import { fnv1aBytes, fnv1aInit } from "../src/hash";
import {
  BUG_HUNT_ID,
  getMapById,
  isWater,
  LA_CANTINA_ID,
  PROVING_GROUND_ID,
  sampleHeight,
  worldExtent,
} from "../src/map";

interface ArenaExpectation {
  id: string;
  size: number;
  laneCount: number;
  /** Flat ground height of the base zones (spawn/base structure elevation). */
  groundHeight: number;
  /** Pinned after generation (tools/generators/convert.ts); see header contract. */
  heightsPin: number;
  /** FNV-1a pins over the loaded wall bit arrays — the collision geometry. */
  wallsVPin: number;
  wallsHPin: number;
  /** Feature counts, per arena — la-cantina carries the original's full set. */
  turretSpots: number;
  outpostSpots: number;
  dummySpots: number;
  ringTurrets: number;
  /**
   * Precinct Assault extras (rules.md §9); 0 on the arenas still on the pre-PA
   * hand-authored layout.
   */
  graphNodes: number;
  weapons: number;
  baseDefence: number;
  pickups: number;
  triggerVolumes: number;
  coreHp: number;
  productionTicks: number;
  /**
   * True when every base structure shares one elevation. False on PA arenas: the
   * original puts the X1Alpha spawn on a 1 m platform and the base itself on the
   * floor beside it, so the plot spans two levels by design.
   */
  flatPlots: boolean;
  /**
   * Lane edges allowed to exceed AVATAR_WALKER_MAX_SLOPE. Ground units check
   * walls only and never slope (units.ts stepAndSnap), so a steep ramp is
   * drivable; the pin keeps the count from growing unnoticed and guarantees the
   * player still has at least one escortable route (asserted separately).
   */
  steepLaneEdges: number;
}

const ARENAS: ArenaExpectation[] = [
  {
    id: PROVING_GROUND_ID,
    size: 257,
    laneCount: 3,
    groundHeight: 1, // X1Alpha shelves at 1 m (not outer rim apron)
    heightsPin: 1261122911,
    wallsVPin: 420789996,
    wallsHPin: 3689709048,
    turretSpots: 4,
    outpostSpots: 2,
    dummySpots: 4,
    ringTurrets: 4,
    graphNodes: 0,
    weapons: 0,
    baseDefence: 0,
    pickups: 0,
    triggerVolumes: 0,
    coreHp: 0,
    productionTicks: 0,
    flatPlots: true,
    steepLaneEdges: 0,
  },
  {
    // Rebuilt from the original Mp logic (tools/generators/enrichArena.ts): the
    // full Precinct Assault layout, one Til east of where it used to sit.
    id: LA_CANTINA_ID,
    size: 241,
    laneCount: 1, // one committed polyline route; the graph is the real network
    // Both X1Alpha spawns sit on the original 1 m base platforms at col 112.
    groundHeight: 1,
    heightsPin: 1164295261, // terrain untouched
    // Walls differ from stage 1: 56 bits carved to open the original roads and
    // 10 to reconnect the outer ring, out of 4009 (1.6%). See enrichArena.ts.
    wallsVPin: 3187547238,
    wallsHPin: 1909053213,
    turretSpots: 32, // every original NeutralTurret pad
    outpostSpots: 2,
    dummySpots: 0, // no original counterpart
    ringTurrets: 16, // original base-defence Turret actors per base
    graphNodes: 283, // both Cnet graphs, 143 + 140
    weapons: 2,
    baseDefence: 4,
    pickups: 8,
    triggerVolumes: 13,
    coreHp: 3000,
    productionTicks: 150, // 5 s
    flatPlots: false,
    steepLaneEdges: 10,
  },
  {
    id: BUG_HUNT_ID,
    size: 257,
    laneCount: 3,
    groundHeight: 1, // shares proving-ground X1Alpha shelf layout
    heightsPin: 3837183847,
    wallsVPin: 293805412,
    wallsHPin: 1740349393,
    turretSpots: 4,
    outpostSpots: 2,
    dummySpots: 4,
    ringTurrets: 4,
    graphNodes: 0,
    weapons: 0,
    baseDefence: 0,
    pickups: 0,
    triggerVolumes: 0,
    coreHp: 0,
    productionTicks: 0,
    flatPlots: true,
    steepLaneEdges: 0,
  },
];

for (const arena of ARENAS) {
  const map = getMapById(arena.id);

  describe(`${arena.id} schema`, () => {
    it("loads with the authored dimensions and feature counts", () => {
      expect(map.size).toBe(arena.size);
      expect(map.cellSize).toBe(1);
      expect(worldExtent(map)).toBe(arena.size - 1);
      expect(map.spawns.length).toBe(2);
      expect(map.basePlots.length).toBe(2);
      expect(map.bases.length).toBe(2);
      expect(map.lanes.length).toBe(arena.laneCount);
      expect(map.turretSpots.length).toBe(arena.turretSpots);
      expect(map.outpostSpots.length).toBe(arena.outpostSpots);
      expect(map.dummySpots.length).toBe(arena.dummySpots);
      expect(map.weapons.length).toBe(arena.weapons);
      expect(map.pickups.length).toBe(arena.pickups);
      expect(map.triggerVolumes.length).toBe(arena.triggerVolumes);
      expect(map.laneGraph?.nodes.length ?? 0).toBe(arena.graphNodes);
      for (const base of map.bases) {
        expect(base.turrets.length).toBe(arena.ringTurrets);
        expect(base.defence.length).toBe(arena.baseDefence);
        expect(base.coreHp).toBe(arena.coreHp);
        expect(base.productionTicks).toBe(arena.productionTicks);
      }
      // Per-spot lists stay parallel to turretSpots or the guns get shuffled.
      if (arena.weapons > 0) {
        expect(map.turretParams.length).toBe(arena.turretSpots);
        expect(map.turretYaw.length).toBe(arena.turretSpots);
      }
    });

    it("pins the exact FNV-1a hash of the loaded heights", () => {
      const bytes = new Uint8Array(map.heights.buffer);
      expect(fnv1aBytes(fnv1aInit(), bytes, 0, bytes.length)).toBe(arena.heightsPin);
    });

    it("pins the exact FNV-1a hashes of the wall arrays", () => {
      expect(map.wallsV.length).toBe(arena.size * arena.size);
      expect(map.wallsH.length).toBe(arena.size * arena.size);
      expect(fnv1aBytes(fnv1aInit(), map.wallsV, 0, map.wallsV.length)).toBe(arena.wallsVPin);
      expect(fnv1aBytes(fnv1aInit(), map.wallsH, 0, map.wallsH.length)).toBe(arena.wallsHPin);
    });

    it("lanes never cross a wall (sub-cell sampling, sim semantics)", () => {
      for (const lane of map.lanes) {
        for (let i = 0; i < lane.length - 1; i++) {
          const a = lane[i];
          const b = lane[i + 1];
          const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 4);
          let px = a.x;
          let py = a.y;
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const cx = a.x + (b.x - a.x) * t;
            const cy = a.y + (b.y - a.y) * t;
            expect(crossesWallX(map, px, cx, py)).toBe(false);
            expect(crossesWallY(map, cx, py, cy)).toBe(false);
            px = cx;
            py = cy;
          }
        }
      }
    });

    it("has no water this stage and keeps all authored features dry", () => {
      let waterCells = 0;
      for (const w of map.waterMask) waterCells += w;
      expect(waterCells).toBe(0);
      for (const s of map.spawns) expect(isWater(map, s.x, s.y)).toBe(false);
      for (const p of [...map.turretSpots, ...map.outpostSpots, ...map.dummySpots]) {
        expect(isWater(map, p.x, p.y)).toBe(false);
      }
    });

    it("spawns sit on their own flat base plots", () => {
      for (let team = 0; team < 2; team++) {
        const s = map.spawns[team];
        const b = map.basePlots[team];
        const d = Math.hypot(s.x - b.x, s.y - b.y);
        expect(d).toBeLessThanOrEqual(b.radius);
        expect(sampleHeight(map, s.x, s.y)).toBeCloseTo(arena.groundHeight, 1);
      }
    });

    it("base structures sit dry on their own plots", () => {
      for (let team = 0; team < 2; team++) {
        const base = map.bases[team];
        const plotC = map.basePlots[team];
        // The build area: what the player drives to. Ring turrets are checked
        // separately — the original spreads them up to ~20 cells along the base
        // approach, so a plot containing them would cover a quarter of the arena.
        const pts = [
          { x: base.gate.x, y: base.gate.y },
          base.core,
          base.groundConsole,
          base.airConsole,
          { x: base.pad.x, y: base.pad.y },
        ];
        for (const p of pts) {
          expect(Math.hypot(p.x - plotC.x, p.y - plotC.y)).toBeLessThanOrEqual(plotC.radius);
          expect(isWater(map, p.x, p.y)).toBe(false);
          if (arena.flatPlots) {
            expect(sampleHeight(map, p.x, p.y)).toBeCloseTo(arena.groundHeight, 1);
          } else {
            // PA plots span the base floor and the 1 m spawn platform, so assert
            // what actually matters: nothing sits in a hole or on a spire.
            const h = sampleHeight(map, p.x, p.y);
            expect(h).toBeGreaterThan(-1);
            expect(h).toBeLessThan(3);
          }
        }
        for (const t of base.turrets) {
          expect(isWater(map, t.x, t.y)).toBe(false);
          const extent = worldExtent(map);
          expect(t.x >= 0 && t.x <= extent && t.y >= 0 && t.y <= extent).toBe(true);
        }
      }
    });

    it("every feature coordinate is within bounds", () => {
      const extent = worldExtent(map);
      const ok = (x: number, y: number) => x >= 0 && x <= extent && y >= 0 && y <= extent;
      for (const s of map.spawns) expect(ok(s.x, s.y)).toBe(true);
      for (const p of [
        ...map.turretSpots,
        ...map.outpostSpots,
        ...map.dummySpots,
        ...map.pickups,
        ...map.triggerVolumes,
        ...(map.laneGraph?.nodes ?? []),
      ]) {
        expect(ok(p.x, p.y)).toBe(true);
      }
    });

    it("every lane starts near base 0 and ends near base 1", () => {
      for (const lane of map.lanes) {
        const first = lane[0];
        const last = lane[lane.length - 1];
        const b0 = map.basePlots[0];
        const b1 = map.basePlots[1];
        expect(Math.hypot(first.x - b0.x, first.y - b0.y)).toBeLessThan(b0.radius + 10);
        expect(Math.hypot(last.x - b1.x, last.y - b1.y)).toBeLessThan(b1.radius + 10);
      }
    });

    if (arena.graphNodes > 0) {
      it("the committed lane graph routes each team from its base to the enemy's", () => {
        const g = map.laneGraph;
        expect(g).toBeDefined();
        if (!g) return;
        const n = g.nodes.length;
        for (let team = 0; team < 2; team++) {
          // Entry sits at the team's own base...
          const own = map.basePlots[team];
          const entry = g.nodes[g.entry[team]];
          expect(Math.hypot(entry.x - own.x, entry.y - own.y)).toBeLessThan(own.radius + 12);
          // ...and following the committed signposts arrives at the enemy's,
          // which is the whole point of precomputing them.
          let at = g.entry[team];
          let steps = 0;
          while (g.nextHopA[team * n + at] >= 0) {
            at = g.nextHopA[team * n + at];
            expect(steps++).toBeLessThan(n);
          }
          const foe = map.basePlots[team ^ 1];
          const end = g.nodes[at];
          expect(Math.hypot(end.x - foe.x, end.y - foe.y)).toBeLessThan(foe.radius + 12);
        }
      });

      it("no lane-graph edge crosses a wall", () => {
        const g = map.laneGraph;
        if (!g) return;
        const n = g.nodes.length;
        for (let k = 0; k < n; k++) {
          for (let s = 0; s < 4; s++) {
            const nb = g.edges[k * 4 + s];
            if (nb < 0 || nb <= k) continue;
            const a = g.nodes[k];
            const b = g.nodes[nb];
            const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 4);
            let px = a.x;
            let py = a.y;
            for (let t = 1; t <= steps; t++) {
              const cx = a.x + (b.x - a.x) * (t / steps);
              const cy = a.y + (b.y - a.y) * (t / steps);
              expect(crossesWallX(map, px, cx, py)).toBe(false);
              expect(crossesWallY(map, cx, py, cy)).toBe(false);
              px = cx;
              py = cy;
            }
          }
        }
      });

      it("at least one base-to-base route stays inside the walker slope limit", () => {
        // Units ignore slope, but the player escorting them does not, so at least
        // one committed route has to be drivable by the avatar end to end.
        const g = map.laneGraph;
        if (!g) return;
        const n = g.nodes.length;
        let escortable = 0;
        for (let team = 0; team < 2; team++) {
          let at = g.entry[team];
          let ok = true;
          while (g.nextHopA[team * n + at] >= 0) {
            const a = g.nodes[at];
            const b = g.nodes[g.nextHopA[team * n + at]];
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            const steps = Math.max(1, Math.ceil(len));
            let prev = sampleHeight(map, a.x, a.y);
            for (let t = 1; t <= steps; t++) {
              const h = sampleHeight(
                map,
                a.x + (b.x - a.x) * (t / steps),
                a.y + (b.y - a.y) * (t / steps),
              );
              if (Math.abs(h - prev) / (len / steps) >= AVATAR_WALKER_MAX_SLOPE) ok = false;
              prev = h;
            }
            at = g.nextHopA[team * n + at];
          }
          if (ok) escortable++;
        }
        expect(escortable).toBeGreaterThan(0);
      });

      it("pins how many lane-graph edges exceed the walker slope limit", () => {
        const g = map.laneGraph;
        if (!g) return;
        const n = g.nodes.length;
        let steep = 0;
        for (let k = 0; k < n; k++) {
          for (let s = 0; s < 4; s++) {
            const nb = g.edges[k * 4 + s];
            if (nb < 0 || nb <= k) continue;
            const a = g.nodes[k];
            const b = g.nodes[nb];
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            const steps = Math.max(1, Math.ceil(len));
            let prev = sampleHeight(map, a.x, a.y);
            for (let t = 1; t <= steps; t++) {
              const h = sampleHeight(
                map,
                a.x + (b.x - a.x) * (t / steps),
                a.y + (b.y - a.y) * (t / steps),
              );
              if (Math.abs(h - prev) / (len / steps) >= AVATAR_WALKER_MAX_SLOPE) {
                steep++;
                break;
              }
              prev = h;
            }
          }
        }
        expect(steep).toBe(arena.steepLaneEdges);
      });

      it("keeps the arena's mirror symmetry: spawns on the centre axis", () => {
        // The heightfield is mirror-symmetric about col 112 (match 0.992) and the
        // original actors about the same axis. A spawn off it means the one-Til
        // frame offset has drifted again — the exact bug this arena had.
        const axis = 112;
        for (const s of map.spawns) expect(Math.abs(s.x - axis)).toBeLessThan(1);
        const rows = map.spawns.map((s) => s.y).sort((a, b) => a - b);
        expect(rows[0] + rows[1]).toBeCloseTo(2 * axis, 0);
      });
    }

    it("lanes are walker-traversable: dry and within the slope limit", () => {
      for (const lane of map.lanes) {
        for (let i = 0; i < lane.length - 1; i++) {
          const a = lane[i];
          const b = lane[i + 1];
          const segLen = Math.hypot(b.x - a.x, b.y - a.y);
          const steps = Math.ceil(segLen);
          let prevH = sampleHeight(map, a.x, a.y);
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const x = a.x + (b.x - a.x) * t;
            const y = a.y + (b.y - a.y) * t;
            expect(isWater(map, x, y)).toBe(false);
            const h = sampleHeight(map, x, y);
            const slope = Math.abs(h - prevH) / (segLen / steps);
            expect(slope).toBeLessThan(AVATAR_WALKER_MAX_SLOPE);
            prevH = h;
          }
        }
      }
    });
  });
}
