// Schema + playability validation for the four single-storey FCOP arenas:
// urban-jungle (mission Conft), proving-ground (Slim), la-cantina (Mp) and
// bug-hunt (Joke). All four are now rebuilt from their own original Precinct
// Assault logic (tools/generators/enrichArena.ts), so all four run the same
// assertions — including the lane-graph block, which used to be la-cantina's
// alone. hollywood-keys and venice-beach are layered and stay in
// layeredArenas.test.ts; see that file for why they are not imported yet.
//
// The heightfields are extracted 1:1 from the original missions (int8, 1/32 m
// units) by tools/generators/convert.ts; regenerating one changes gameplay
// everywhere it is sampled, so a changed heightsPin means a SIM_VERSION bump +
// golden regeneration for every golden recorded on it. Stage 2 never touches
// terrain, so every heightsPin below survived the rebuild unchanged.
//
// Stage 1 has no water, so the district-01 river assertions are absent. The
// mirror assertion is NOT absent any more — see the mirrorAxis field.
import { describe, expect, it } from "bun:test";
import { AVATAR_JUMP_SPEED, AVATAR_WALKER_MAX_SLOPE, GRAVITY } from "../src/balance";
import { crossesWallX, crossesWallY } from "../src/collision";
import { fnv1aBytes, fnv1aInit } from "../src/hash";
import {
  BUG_HUNT_ID,
  getMapById,
  isWater,
  LA_CANTINA_ID,
  type MapData,
  PROVING_GROUND_ID,
  sampleHeight,
  URBAN_JUNGLE_ID,
  worldExtent,
} from "../src/map";
import { resolveWalker } from "../src/units";

/**
 * Rise a walker can clear by jumping. `sim.ts` skips the slope gate entirely
 * while airborne ("a jump can carry them onto a ledge", sim.ts:663), so a step
 * the horizontal test rejects is still passable if the jump reaches it.
 * balance.ts pins the clearance at 1.4 m against a 1.6 m apex; the assertion
 * below stops the two drifting apart.
 */
const JUMPABLE_RISE = 1.4;
const JUMP_APEX = (AVATAR_JUMP_SPEED * AVATAR_JUMP_SPEED) / (2 * GRAVITY);

/**
 * Worst uphill rise, in metres, among the sub-cell steps of one straight ground
 * segment that exceed the walker slope limit. 0 means the whole segment is
 * walkable.
 *
 * This mirrors the avatar stepper (sim.ts:670-698) rather than approximating it,
 * and the two details that matter were both wrong in the earlier version of this
 * measurement:
 *
 * - **Only uphill counts.** The stepper rejects a step on
 *   `rise > GROUND_EPS && rise > run * maxSlope`. A downhill drop is a fall the
 *   walker survives — gravity is integrated — not a wall. Taking `Math.abs`
 *   counted every descent as impassable, which is ~40% of the hits on these four
 *   arenas.
 * - **Heights come from `resolveWalker`**, the function the stepper calls, with
 *   the resolved height carried forward as the walker's own height. On a
 *   single-storey arena that is bit-identical to `sampleHeight`; on a layered one
 *   it stops a deck within STEP_SNAP reading as a cliff.
 */
function worstUphillRise(map: MapData, ax: number, ay: number, bx: number, by: number): number {
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(len));
  const run = len / steps;
  let h = sampleHeight(map, ax, ay);
  let worst = 0;
  for (let t = 1; t <= steps; t++) {
    const f = t / steps;
    const next = resolveWalker(map, ax + (bx - ax) * f, ay + (by - ay) * f, h).height;
    const rise = next - h;
    if (rise > 0 && rise / run >= AVATAR_WALKER_MAX_SLOPE && rise > worst) worst = rise;
    h = next;
  }
  return worst;
}

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
  /** Feature counts, per arena — each carries its own mission's full set. */
  turretSpots: number;
  outpostSpots: number;
  dummySpots: number;
  ringTurrets: number;
  /**
   * Precinct Assault extras (rules.md §9); 0 on an arena still on the pre-PA
   * hand-authored layout.
   */
  graphNodes: number;
  weapons: number;
  baseDefence: number;
  pickups: number;
  triggerVolumes: number;
  coreHp: number;
  productionTicks: number;
  /** Original scenery placements. Render-only — determinismGuard.test.ts enforces it. */
  props: number;
  /**
   * Grid line the arena's terrain is mirror-symmetric about, in BOTH axes.
   *
   * It is the centre of the arena's real (unpadded) content: the terrain occupies
   * sim [16, 16 + content] on X, so the axis is 16 + content/2 — 112 on la-cantina
   * (241²) and 120 on the three 257² arenas. That is measured, not assumed:
   * tools/generators/test/mapAlign.test.ts re-derives the same footprint from each
   * committed .glb by vertex correlation, and binds it to the offset stage 2
   * applies. packages/sim may not import from the client (determinismGuard), so
   * the number is carried here and the link is asserted there.
   */
  mirrorAxis: number;
  /**
   * True when every base structure shares one elevation with the spawn. False
   * where the original puts the X1Alpha on a platform and the base on the floor
   * beside it, so the plot spans two levels by design.
   */
  flatPlots: boolean;
  /**
   * Lane edges whose uphill gradient exceeds AVATAR_WALKER_MAX_SLOPE. Ground
   * units check walls only and never slope (units.ts stepAndSnap), so a steep
   * ramp is drivable; the pin keeps the count from growing unnoticed and
   * guarantees the player still has at least one escortable route (asserted
   * separately).
   */
  steepLaneEdges: number;
  /**
   * The subset of `steepLaneEdges` the walker cannot jump either — a rise above
   * JUMPABLE_RISE. This is the number that means "impassable"; `steepLaneEdges`
   * on its own is a regression anchor, not a playability claim.
   *
   * These are 1.4-2.5 m terrain steps, not kerbs: no blocking rise on any of the
   * four arenas is small enough for a step-up tolerance to help. See the pinning
   * test for the distribution.
   */
  hardWallLaneEdges: number;
  /**
   * Sub-cell steps along the committed `lanes` polyline whose uphill gradient
   * exceeds the walker slope limit. 0 on Mp, whose shortest road is clean;
   * non-zero on the three imported arenas, whose original roads climb steps the
   * avatar has to jump or route around. Units are unaffected — they never check
   * slope.
   */
  steepLaneSteps: number;
  /** The subset of `steepLaneSteps` above JUMPABLE_RISE. */
  hardWallLaneSteps: number;
}

// Every row below is transcribed from `bun run gen:arena <id>`'s report, never
// predicted: the counts are properties of each mission's actor table.
// laneCount 1 and dummySpots 0 are structural — stage 2 commits team 0's
// polyline as the one lane (the graph is the real network) and dummy turrets are
// a Phase-1 sandbox concept with no original counterpart.
const ARENAS: ArenaExpectation[] = [
  {
    // Rebuilt from the original Conft logic. Both X1Alpha spawns land on the
    // 0.906 m base platforms; at the old +0 frame they sat on the 0 m floor.
    id: URBAN_JUNGLE_ID,
    size: 257,
    laneCount: 1,
    groundHeight: 0.906,
    heightsPin: 264067427, // terrain untouched by the rebuild
    // 219 bits carved to open the original roads + 23 to reconnect the ring
    // and the base's own structures, of 4096 (5.9%).
    wallsVPin: 1944393474,
    wallsHPin: 3661246389,
    turretSpots: 32,
    outpostSpots: 2,
    dummySpots: 0,
    ringTurrets: 16,
    graphNodes: 462, // both Cnet graphs, 237 + 225
    weapons: 2,
    baseDefence: 4,
    pickups: 11,
    triggerVolumes: 13,
    coreHp: 3000,
    productionTicks: 150, // 5 s
    props: 36,
    mirrorAxis: 120,
    flatPlots: false, // spawn platform above the base floor
    steepLaneEdges: 40,
    hardWallLaneEdges: 8, // of 518 edges; smallest blocking rise 0.50 m
    steepLaneSteps: 1,
    hardWallLaneSteps: 1,
  },
  {
    // Rebuilt from the original Slim logic. Slim and Joke used to share one
    // hand-authored layout (convert.ts's RIM_* constants); they are different
    // missions and importing splits them, which is why the counts below differ
    // from bug-hunt's despite the identical base positions.
    id: PROVING_GROUND_ID,
    size: 257,
    laneCount: 1,
    // Flat 0 m plateau. The old `groundHeight: 1` was an artifact: the authored
    // spawn straddled a 2 m shelf and a 0 m floor, and the bilinear sampler
    // averaged them to exactly 1. There is no 1 m shelf on this arena.
    groundHeight: 0,
    heightsPin: 1261122911, // terrain untouched by the rebuild
    // 283 bits carved + 21 to reconnect, of 4096 (7.4%) — Slim's road network
    // is the densest of the four, at 640 edges.
    wallsVPin: 2238596254,
    wallsHPin: 4155115572,
    turretSpots: 29,
    outpostSpots: 2,
    dummySpots: 0,
    ringTurrets: 14, // Slim places 14 per base, not Mp's 16
    graphNodes: 578, // 292 + 286
    weapons: 2,
    baseDefence: 4,
    pickups: 9,
    triggerVolumes: 13,
    coreHp: 3000,
    productionTicks: 150,
    props: 36,
    mirrorAxis: 120,
    flatPlots: true, // spawn and base share the 0 m floor here
    steepLaneEdges: 43,
    hardWallLaneEdges: 13, // of 640 edges; smallest blocking rise 0.55 m
    steepLaneSteps: 4,
    hardWallLaneSteps: 1,
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
    // Walls differ from stage 1: 83 bits carved to open the original roads and
    // 16 to reconnect the ring and the bases, out of 4009 (2.5%). Both counts
    // grew when the carve stopped skipping one-way edges — see enrichArena.ts.
    wallsVPin: 2734110619,
    wallsHPin: 1084975133,
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
    props: 36,
    mirrorAxis: 112,
    flatPlots: false,
    steepLaneEdges: 10,
    // Mp is the clean one: every steep edge is jumpable and the committed road
    // has no blocking step at all. It is why the other three went unnoticed.
    hardWallLaneEdges: 0,
    steepLaneSteps: 0,
    hardWallLaneSteps: 0,
  },
  {
    // Rebuilt from the original Joke logic — see proving-ground on the split.
    id: BUG_HUNT_ID,
    size: 257,
    laneCount: 1,
    groundHeight: 0,
    heightsPin: 3837183847, // terrain untouched by the rebuild
    // 287 bits carved + 24 to reconnect, of 4096 (7.6%).
    wallsVPin: 3771208529,
    wallsHPin: 1896827259,
    turretSpots: 29,
    outpostSpots: 2,
    dummySpots: 0,
    ringTurrets: 14,
    graphNodes: 594, // 303 + 291
    weapons: 2,
    baseDefence: 4,
    pickups: 9,
    triggerVolumes: 13,
    coreHp: 3000,
    productionTicks: 150,
    props: 36,
    mirrorAxis: 120,
    flatPlots: true,
    steepLaneEdges: 43,
    hardWallLaneEdges: 13, // of 661 edges; smallest blocking rise 0.55 m
    steepLaneSteps: 4,
    hardWallLaneSteps: 1,
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
      expect(map.props.length).toBe(arena.props);
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
            if (nb < 0) continue;
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

      it("at least one team can walk its road network to the enemy base", () => {
        // The player has to be able to escort a push on foot, so a walker-clean
        // path from a team's entry to the enemy plot has to EXIST in the road
        // network. Deliberately not "the committed nextHopA route is clean":
        // nextHopA is the units' signpost and minimises hop count, units ignore
        // slope entirely (units.ts stepAndSnap checks walls only), and the player
        // steers for themselves. On Conft, Slim and Joke the shortest route does
        // climb a few of the original's terrain steps while a clean path through
        // the same graph exists; on Mp the shortest route is clean already.
        //
        // The flood below deliberately allows NO jumping and NO descent-as-block:
        // it is the strongest form of the claim, a route the walker simply walks.
        const g = map.laneGraph;
        if (!g) return;
        let escortable = 0;
        for (let team = 0; team < 2; team++) {
          const foe = map.basePlots[team ^ 1];
          const queue = [g.entry[team]];
          const seen = new Set(queue);
          for (let i = 0; i < queue.length; i++) {
            const k = queue[i];
            const at = g.nodes[k];
            if (Math.hypot(at.x - foe.x, at.y - foe.y) < foe.radius + 12) {
              escortable++;
              break;
            }
            for (let s = 0; s < 4; s++) {
              const nb = g.edges[k * 4 + s];
              if (nb < 0 || seen.has(nb)) continue;
              const a = g.nodes[k];
              const b = g.nodes[nb];
              if (worstUphillRise(map, a.x, a.y, b.x, b.y) > 0) continue;
              seen.add(nb);
              queue.push(nb);
            }
          }
        }
        expect(escortable).toBeGreaterThan(0);
      });

      it("pins how many lane-graph edges the walker cannot climb, and cannot jump", () => {
        // The jump clearance and the apex have to stay consistent, or the
        // hardWall split below silently changes meaning.
        expect(JUMP_APEX).toBeGreaterThan(JUMPABLE_RISE);

        const g = map.laneGraph;
        if (!g) return;
        const n = g.nodes.length;
        let steep = 0;
        let hardWall = 0;
        let smallestBlockingRise = Number.POSITIVE_INFINITY;
        for (let k = 0; k < n; k++) {
          for (let s = 0; s < 4; s++) {
            const nb = g.edges[k * 4 + s];
            if (nb < 0) continue;
            const a = g.nodes[k];
            const b = g.nodes[nb];
            const rise = worstUphillRise(map, a.x, a.y, b.x, b.y);
            if (rise === 0) continue;
            steep++;
            if (rise < smallestBlockingRise) smallestBlockingRise = rise;
            if (rise > JUMPABLE_RISE) hardWall++;
          }
        }
        expect(steep).toBe(arena.steepLaneEdges);
        expect(hardWall).toBe(arena.hardWallLaneEdges);

        // The finding that settles what these obstacles ARE: not one blocking
        // rise anywhere is small enough for a kerb-sized step-up tolerance to
        // clear (STEP_SNAP is 0.35 m). They are 0.6 m-plus terrain steps, so no
        // tolerance and no value of AVATAR_WALKER_MAX_SLOPE short of "climbs
        // walls" makes the original roads uniformly walkable. Jump or route
        // around is the answer, and both exist.
        if (steep > 0) expect(smallestBlockingRise).toBeGreaterThan(0.35);
      });

      it("keeps the arena's mirror symmetry: the two spawns mirror each other", () => {
        // This is the guard that catches the one-Til frame offset drifting again —
        // the exact bug all four of these arenas had. The heightfield is
        // mirror-symmetric about mirrorAxis in both axes, the original actors are
        // symmetric about the same line, and the two X1Alpha spawns are therefore
        // a mirrored pair: each coordinate sums to twice the axis.
        //
        // Deliberately NOT the old `|s.x - axis| < 1`: that is true on la-cantina,
        // where the bases straddle the centre line, and false on a correctly
        // imported Conft, whose spawns sit at x 106.2 and 133.7. Summing the pair
        // holds on all four and is the stronger claim — a uniform shift of both
        // spawns breaks it, which is precisely the failure mode.
        const axis = arena.mirrorAxis;
        const [a, b] = map.spawns;
        expect(a.x + b.x).toBeCloseTo(2 * axis, 0);
        expect(a.y + b.y).toBeCloseTo(2 * axis, 0);
        // ...and the pair genuinely straddles the line rather than both landing
        // on it, which a collapsed import would also satisfy above.
        expect(Math.abs(a.y - b.y)).toBeGreaterThan(20);
      });
    }

    it("the committed lane is dry, and its walker-steep segments are pinned", () => {
      // `lanes` is team 0's nextHopA route flattened to a polyline — the units'
      // road. Dryness is absolute. Slope is pinned rather than forbidden: units
      // ignore it, and on the three imported non-Mp arenas the original's
      // shortest road climbs steps the avatar has to jump. Pinning the count is
      // what stops that growing unnoticed; the previous assertion of zero only
      // held because Mp's shortest road happens to be clean.
      let steep = 0;
      let hardWall = 0;
      for (const lane of map.lanes) {
        for (let i = 0; i < lane.length - 1; i++) {
          const a = lane[i];
          const b = lane[i + 1];
          const segLen = Math.hypot(b.x - a.x, b.y - a.y);
          const steps = Math.ceil(segLen);
          // Dryness is checked per sub-step; slope is measured by the shared
          // helper so the lane and the graph cannot disagree about what "steep"
          // means.
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            expect(isWater(map, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)).toBe(false);
          }
          for (let s = 0; s < steps; s++) {
            const t0 = s / steps;
            const t1 = (s + 1) / steps;
            const rise = worstUphillRise(
              map,
              a.x + (b.x - a.x) * t0,
              a.y + (b.y - a.y) * t0,
              a.x + (b.x - a.x) * t1,
              a.y + (b.y - a.y) * t1,
            );
            if (rise === 0) continue;
            steep++;
            if (rise > JUMPABLE_RISE) hardWall++;
          }
        }
      }
      expect(steep).toBe(arena.steepLaneSteps);
      expect(hardWall).toBe(arena.hardWallLaneSteps);
    });
  });
}
