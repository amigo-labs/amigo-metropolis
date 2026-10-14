// Can a bought unit actually drive into the enemy gate? (issue #30; the objective
// was "the enemy core" until SIM_VERSION 32 — the original has none, and its win
// is a tank or Dreadnought entering the gate box, fcop-fidelity.md R1.)
//
// Phase 13 imported three more arenas and they read as clean: every Cnet edge
// wall-free, every graph reaching its cores. A difficulty-8 Warden still got
// 76-90% of the way and stopped dead — zero core hits, zero intrusion alarms,
// on proving-ground even after capturing all 29 pads. The recorded conclusion
// was "not the road".
//
// It was the road. A produced unit travels THREE kinds of segment and stage 2
// validated one:
//
//   leg 1  production console -> the graph entry node   (a beeline the SIM makes)
//   leg 2  node -> node along the committed signposts   (the extracted Cnet)
//   leg 3  the chain's last node -> the enemy gate      (again the sim's own)
//
// Legs 1 and 3 exist because `moveGroundUnit` generates them, not because the
// data asks for them, so nothing in the extraction says they have to be clear.
// Measured at both ground step lengths, 5 of the 12 were jammed: on Slim and Joke
// NEITHER team could leave its own base, and on Conft team 0 could neither leave
// its base nor enter the enemy's. la-cantina was clean on all four, which is
// exactly why it was the one arena that played.
//
// This file pins the fix as a deterministic property — no combat, no Warden, no
// luck: one unopposed unit, the committed signposts, and the sim's own stepper.
// A regression here names the leg and the arena instead of showing up three
// months later as "the AI feels passive".
import { describe, expect, it } from "bun:test";
import {
  GRAPH_WAYPOINT_RADIUS,
  JUGGERNAUT_SPEED,
  RUNNER_SPEED,
  TICK_DT,
  WAYPOINT_RADIUS,
} from "../src/balance";
import {
  BUG_HUNT_ID,
  getMapById,
  LA_CANTINA_ID,
  PROVING_GROUND_ID,
  URBAN_JUNGLE_ID,
} from "../src/map";
import { chainGoal, GROUND_STEPS, segmentWalkable, walkRoad } from "../src/roads";

/** One arena's road expectations, transcribed from `bun run gen:arena <id>`. */
interface RoadExpectation {
  readonly id: string;
  /**
   * Node each team's produced units join the road at, and how far that is from
   * the production console.
   *
   * The Cnet's own base node (node 0 of the team's net) wherever a unit can walk
   * to it — Mp and Conft keep theirs. Where it is walled off from the console,
   * stage 2 joins at the nearest chain node it CAN walk to instead of deleting
   * the wall: which node produced units join at is ours to choose, the wall is
   * extracted data.
   */
  readonly entry: readonly [number, number];
  /** Console -> entry distance per team, metres, as the generator reports it. */
  readonly entryDistance: readonly [number, number];
  /**
   * Upper bound on the unopposed console -> enemy gate drive, seconds. One number for
   * both archetypes: a Juggernaut at 2.5 m/s is the slow case, so a bound it
   * clears covers a Runner too.
   */
  readonly driveLimit: number;
}

const ROADS: RoadExpectation[] = [
  {
    id: LA_CANTINA_ID,
    // Both legs shortened from 8.3/8.1 m when the ground console stopped being
    // the aircraft one: the tank console is the one the original parks on the
    // road, which is what you would expect of the pad that rolls ground units
    // out. Corroborates the shop reading in enrichArena's assignConsoles().
    entry: [143, 6],
    entryDistance: [3.3, 3.1],
    driveLimit: 40, // 18.9 s / 30.2 s measured to the gate box (Runner / Juggernaut step)
  },
  {
    id: URBAN_JUNGLE_ID,
    // 6.6/6.6 m, and team 0's leg carved open, while the ground console was the
    // jet shop (a kiosk Cobj id read as if Conft numbered its Cobjs as Mp does).
    // From the tank shop team 0 walks to #1 (#0 is walled off) and team 1 to the
    // Cnet's own node.
    entry: [1, 237],
    entryDistance: [4.3, 3.6],
    driveLimit: 70, // 30.1 s / 48.2 s (team 1, the slower) as the generator reports it
  },
  {
    id: PROVING_GROUND_ID,
    // Slim's bases are Joke's, and since the ground console is the tank shop
    // (it was the jet shop, 7.6/5.5 m out, for the same reason as urban-jungle)
    // its entries and legs are bug-hunt's, one node index apart on team 1.
    entry: [1, 293],
    entryDistance: [3.2, 3.0],
    driveLimit: 70, // 36.4 s / 58.1 s (team 0, the slower) as the generator reports it
  },
  {
    id: BUG_HUNT_ID,
    // Same shortening as la-cantina, same cause (7.6/5.5 m before the console
    // icons were read rather than guessed at from trigger footprints).
    entry: [1, 304],
    entryDistance: [3.2, 3.0],
    driveLimit: 70, // 36.4 s / 58.1 s measured to the gate box
  },
];

describe("the graph arrival radius is bounded on both sides", () => {
  it("exceeds a tick of travel, so a unit cannot step over its own waypoint", () => {
    // The lower bound, and the reason it is not smaller: a unit samples its
    // distance to the waypoint once per tick, so a radius under one tick's travel
    // can be jumped clean over — the unit then orbits the node forever.
    const fastest = Math.max(...GROUND_STEPS);
    expect(fastest).toBeCloseTo(RUNNER_SPEED * TICK_DT, 10);
    expect(Math.min(...GROUND_STEPS)).toBeCloseTo(JUGGERNAUT_SPEED * TICK_DT, 10);
    expect(GRAPH_WAYPOINT_RADIUS).toBeGreaterThan(fastest * 2);
  });

  it("stays far tighter than the hand-authored polyline radius", () => {
    // The upper bound: the only path stage 2 validates is the edge, so a unit has
    // to travel the edge. At the polyline's 3 m a unit leaves the road up to 3 m
    // early and cuts the corner through whatever is there — 32% and 35% of all
    // ground-unit ticks jammed against a wall on Slim and Joke.
    expect(GRAPH_WAYPOINT_RADIUS).toBeLessThan(WAYPOINT_RADIUS / 4);
    // ...and it has to be small against the cell the wall lattice is built on,
    // or "on the road" stops meaning anything.
    expect(GRAPH_WAYPOINT_RADIUS).toBeLessThanOrEqual(getMapById(LA_CANTINA_ID).cellSize / 2);
  });
});

describe.each(ROADS)("$id roads", (arena: RoadExpectation) => {
  const map = getMapById(arena.id);
  const graph = map.laneGraph;

  it("carries the original lane graph", () => {
    expect(graph).toBeDefined();
  });

  it("joins produced units to the road where they can actually walk to it", () => {
    if (!graph) return;
    for (let team = 0; team < 2; team++) {
      expect(graph.entry[team]).toBe(arena.entry[team]);
      const cons = map.bases[team].groundConsole;
      const node = graph.nodes[graph.entry[team]];
      const d = Math.sqrt((node.x - cons.x) ** 2 + (node.y - cons.y) ** 2);
      expect(d).toBeCloseTo(arena.entryDistance[team], 0);
      // Leg 1. Before the fix this was false for 4 of the 8 teams across the four
      // arenas, and a base whose units cannot reach the road produces nothing.
      expect(segmentWalkable(map, cons.x, cons.y, node.x, node.y)).toBe(true);
    }
  });

  it("lets the road's far end reach the enemy gate", () => {
    if (!graph) return;
    for (let team = 0; team < 2; team++) {
      const end = graph.nodes[chainGoal(map, team)];
      const gate = map.bases[team ^ 1].gate;
      // Leg 3. `moveGroundUnit` beelines the gate once the signposts run out, so
      // this is the last few metres of every push. Conft's was walled.
      expect(segmentWalkable(map, end.x, end.y, gate.x, gate.y)).toBe(true);
      // The gate is the original's trigger box (fcop-re/ai-and-rules.md §5), a
      // few metres from the Dreadnought's spot by the HQ — not on it.
      expect(gate.halfW).toBeGreaterThan(0);
      expect(gate.halfL).toBeGreaterThan(0);
    }
  });

  it("lets each side's Juggernaut reach the road from its own spawn", () => {
    // Leg 1 for the Juggernaut: it rolls out at the Dreadnought record, node 0 of
    // its Cnet by the HQ, and heads for the same entry node a Runner joins at.
    if (!graph) return;
    for (let team = 0; team < 2; team++) {
      const j = map.bases[team].juggernaut;
      expect(j).toBeDefined();
      if (!j) continue;
      const node = graph.nodes[graph.entry[team]];
      expect(segmentWalkable(map, j.x, j.y, node.x, node.y)).toBe(true);
    }
  });

  for (const step of GROUND_STEPS) {
    it(`drives console -> enemy gate unopposed at ${step} m/tick, both teams`, () => {
      if (!graph) return;
      for (let team = 0; team < 2; team++) {
        const w = walkRoad(map, team, step);
        // The whole journey, in one assertion, for both ground archetypes: a
        // Runner's step and a Juggernaut's sample the wall lattice differently, so
        // "walkable" has to hold at both. This is the statement the arena is
        // playable at all — everything past it is balance.
        // Reported as an object so a failure says which leg and where, rather
        // than "expected true". Which leg it ARRIVES on is not pinned: where the
        // road runs through the gate box the walk finishes on the graph leg, and
        // on the gate beeline elsewhere.
        expect(
          w.reached
            ? "reached"
            : `stopped on leg ${w.leg} at (${Math.round(w.x)}, ${Math.round(w.y)}), ${Math.round(w.distanceToGate)} m short, aiming at node ${w.node}`,
        ).toBe("reached");
        // Inside the box: within its half-diagonal plus a Runner's radius.
        const g = map.bases[team ^ 1].gate;
        expect(w.distanceToGate).toBeLessThanOrEqual(Math.hypot(g.halfW, g.halfL) + 1);
        expect(w.ticks / 30).toBeLessThan(arena.driveLimit);
      }
    });
  }
});
