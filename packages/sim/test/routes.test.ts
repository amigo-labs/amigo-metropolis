// The original's route followers (fcop-fidelity.md U1/U2; fcop-re/ai-and-rules.md
// §4: route.c `cnet_route_next`, route_tick.c, route_near.c), pinned on a small
// synthetic road graph so every rule is visible on its own:
//
//   team 0's net (directed):   0 -> 1 -> 2 (north) -> 4 -> 5 <-> 6
//                                    \-> 3 (south) -/
//   team 1's net:              7 -> 8
//
// A Runner (the PA tank) steps toward the nearest enemy within 16 m on 60 % of
// its steps and at random on the rest; a Juggernaut (the Dreadnought) always at
// random. Neither steps straight back, both walk the legs at 1.98 m/s choosing
// one leg ahead and rounding the corners, slow for traffic in 1 s holds, and
// never stop to fight. The cursor itself is pinned against the RE's
// transcription in routeCursor.test.ts.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  ROUTE_CONTACT_HOLD,
  ROUTE_HOLD_ENGINE_TICKS,
  ROUTE_SPEED_WORD,
  ROUTE_TOP_SPEED,
  TICK_DT,
} from "../src/balance";
import { createTickInputs } from "../src/inputs";
import { loadMapFromJson, type MapJson } from "../src/map";
import { createSim, type SimState, spawnUnit, step } from "../src/sim";

const NODES = [
  [10, 30], // 0 team 0 entry
  [20, 30], // 1 the fork
  [30, 40], // 2 north branch
  [30, 20], // 3 south branch
  [40, 30], // 4
  [50, 30], // 5
  [54, 34], // 6 (5 <-> 6: a dead end whose only way out is back)
  [50, 10], // 7 team 1 entry
  [10, 10], // 8
];
const EDGES = [
  [1, -1, -1, -1],
  [2, 3, -1, -1],
  [4, -1, -1, -1],
  [4, -1, -1, -1],
  [5, -1, -1, -1],
  [6, -1, -1, -1],
  [5, -1, -1, -1],
  [8, -1, -1, -1],
  [-1, -1, -1, -1],
];

/** A flat 60 m arena with the graph above; `enemyAt` places team 1's avatar. */
function roads(enemyAt: number[], ownAt: number[] = [5, 55], closed: number[] = []): MapJson {
  const size = 16;
  const heights: number[][] = [];
  const water: string[] = [];
  for (let j = 0; j < size; j++) {
    heights.push(new Array(size).fill(0));
    water.push("0".repeat(size));
  }
  const none = NODES.map(() => -1);
  return {
    id: "routes-test",
    size,
    cellSize: 4,
    waterLevel: -10,
    heights,
    water,
    spawns: [
      { x: ownAt[0], y: ownAt[1], yaw: 0 },
      { x: enemyAt[0], y: enemyAt[1], yaw: 0 },
    ],
    basePlots: [
      { x: 5, y: 55, radius: 3 },
      { x: 55, y: 55, radius: 3 },
    ],
    bases: [
      {
        gate: { x: 2, y: 2, radius: 1 },
        core: [5, 50],
        groundConsole: [10, 30],
        airConsole: [5, 45],
        turrets: [],
      },
      {
        gate: { x: 58, y: 58, radius: 1 },
        core: [55, 50],
        groundConsole: [50, 10],
        airConsole: [55, 45],
        turrets: [],
      },
    ],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
    laneGraph: {
      nodes: NODES,
      edges: EDGES,
      nextHopA: [
        [1, 2, 4, 4, 5, -1, -1, -1, -1],
        [...none.slice(0, 7), 8, -1],
      ],
      nextHopB: [[-1, 3, -1, -1, -1, -1, -1, -1, -1], none],
      entry: [0, 7],
      closed,
    },
  } as MapJson;
}

const idle = createTickInputs();

/** Runs a Runner from the entry until it has chosen at the fork; returns 2 or 3. */
function forkChoice(seed: number, enemyAt: number[], crowd = false, closed: number[] = []): number {
  const state = createSim(loadMapFromJson(roads(enemyAt, undefined, closed)), seed);
  // A follower already counted toward node 2 (the occupancy nibble).
  if (crowd) state.route.occupancy[2] = 1;
  const id = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
  for (let t = 0; t < 30 * 20; t++) {
    step(state, idle);
    const node = state.ent.timerA[id];
    if (node === 2 || node === 3) return node;
  }
  throw new Error("never reached the fork");
}

describe("route followers on the original road graph", () => {
  it("walk the legs at the route block's 1.98 m/s, on the leg between the corners", () => {
    expect(ROUTE_TOP_SPEED).toBeCloseTo(1.9775, 4);
    expect(ROUTE_SPEED_WORD).toBe(54);
    const state = createSim(loadMapFromJson(roads([55, 55])), 7);
    const id = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    step(state, idle);
    let x = state.ent.posX[id];
    for (let t = 0; t < 60; t++) {
      step(state, idle);
      // 540 world units a tick, to the original's lerp's rounding.
      expect(state.ent.posX[id] - x).toBeCloseTo(ROUTE_TOP_SPEED * TICK_DT, 3);
      expect(state.ent.posY[id]).toBe(30); // on the leg: the corner is further on
      x = state.ent.posX[id];
    }
  });

  it("choose the node after the next one while still on the leg (the look-ahead)", () => {
    const state = createSim(loadMapFromJson(roads([55, 55])), 5);
    const id = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    // The spawn node 0 picks node 1 at once; the first tick of that leg picks
    // the branch after it, 10 m before the fork.
    expect(state.ent.timerA[id]).toBe(1);
    expect(state.route.next[id]).toBe(-1);
    step(state, idle);
    expect(state.ent.timerA[id]).toBe(1);
    expect([2, 3]).toContain(state.route.next[id]);
    expect(state.ent.posX[id]).toBeLessThan(10.1);
  });

  it("round the corner: the heading blends across the window, the path cuts inside", () => {
    const state = createSim(loadMapFromJson(roads([55, 55])), 5);
    const id = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    step(state, idle);
    const branch = state.route.next[id]; // 2 north (+y), 3 south
    const side = branch === 2 ? 1 : -1;
    let inside = 0;
    let between = 0;
    for (let t = 0; t < 30 * 6; t++) {
      step(state, idle);
      const x = state.ent.posX[id];
      const y = state.ent.posY[id];
      const yaw = state.ent.yaw[id] * side; // 0 east, pi/4 on the branch
      // Within ~3.5 m of the fork (the window: half the 14.1 m branch).
      if (Math.hypot(x - 20, y - 30) < 3.4) {
        // Before the fork the straight leg is y = 30; past it, the diagonal.
        const off = x < 20 ? (y - 30) * side : x - 20 - (y - 30) * side;
        if (off > 0.01) inside += 1;
        if (yaw > 0.01 && yaw < Math.PI / 4 - 0.01) between += 1;
      }
    }
    expect(inside).toBeGreaterThan(40);
    expect(between).toBeGreaterThan(40);
  });

  it("never step straight back: a dead end whose only exit is back halts them", () => {
    const state = createSim(loadMapFromJson(roads([55, 55])), 3);
    const id = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    const visited: number[] = [];
    for (let t = 0; t < 30 * 60; t++) {
      step(state, idle);
      const node = state.ent.timerA[id];
      if (visited[visited.length - 1] !== node) visited.push(node);
    }
    // 0 -> 1 -> (2|3) -> 4 -> 5 -> 6, and at 6 the one link is the node just
    // left (refused outright): the follower halts there for good, short of the
    // node by the tick it did not write.
    expect(visited.slice(-2)).toEqual([5, 6]);
    expect(Math.hypot(state.ent.posX[id] - 54, state.ent.posY[id] - 34)).toBeLessThan(0.07);
    expect(state.route.velocity[id]).toBe(0);
    expect(state.ent.velX[id]).toBe(0);
  });

  it("steer toward the nearest enemy within 16 m on the 60 % of steps that seek", () => {
    let north = 0;
    let northAlone = 0;
    const N = 200;
    for (let seed = 1; seed <= N; seed++) {
      // Team 1's avatar beside the north branch, 14.4 m from where the
      // follower stands when it chooses (the leg's start, not the fork).
      if (forkChoice(seed, [22, 38]) === 2) north += 1;
      // Nobody within 16 m: every step is random.
      if (forkChoice(seed, [55, 55]) === 2) northAlone += 1;
    }
    // Seek wins on 60 % of steps, the random 40 % split evenly: ~80 % north.
    expect(north / N).toBeGreaterThan(0.7);
    expect(north / N).toBeLessThan(0.9);
    expect(northAlone / N).toBeGreaterThan(0.38);
    expect(northAlone / N).toBeLessThan(0.62);
  });

  it("halve a node's score per follower counted toward it", () => {
    // The enemy 4 m east of the fork: both branches align within one octave
    // (dot 42880 and 39040 node units², both 32 + 15 = 47), a tie the coin
    // settles. One count on node 2 costs that branch an octave — 47 >> 1 =
    // 23 — so every seeking step goes south.
    let north = 0;
    let northFree = 0;
    const N = 200;
    for (let seed = 1; seed <= N; seed++) {
      if (forkChoice(seed, [24, 30.2], true) === 2) north += 1;
      if (forkChoice(seed, [24, 30.2]) === 2) northFree += 1;
    }
    expect(northFree / N).toBeGreaterThan(0.38);
    expect(northFree / N).toBeLessThan(0.62);
    expect(north / N).toBeLessThan(0.3);
  });

  it("refuse a node a script has closed (the node's state bit 1)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      expect(forkChoice(seed, [55, 55], false, [2])).toBe(3);
    }
  });

  it("count a node's followers as the original's nibble: not the first leg, not after death", () => {
    const state = createSim(loadMapFromJson(roads([55, 55])), 21);
    const id = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    const occ = state.route.occupancy;
    // Walking its first leg, to node 1: counted nowhere.
    expect(occ[1]).toBe(0);
    let t = 0;
    while (state.ent.timerA[id] === 1 && t++ < 30 * 10) step(state, idle);
    const branch = state.ent.timerA[id];
    expect([2, 3]).toContain(branch);
    expect(occ[branch]).toBe(1);
    expect(occ[1]).toBe(0); // left, floored at 0
    state.ent.hp[id] = 0;
    step(state, idle);
    expect(state.ent.alive[id]).toBe(0);
    expect(occ[branch]).toBe(0); // operation 5 on the way out
  });

  it("do not stop for an enemy in range: the gun fires on the move", () => {
    // Team 1's avatar stands 4 m off the first leg; the Runner drives past it.
    const state = createSim(loadMapFromJson(roads([16, 34])), 9);
    const id = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    step(state, idle);
    const x0 = state.ent.posX[id];
    for (let t = 0; t < 90; t++) step(state, idle);
    expect(state.ent.posX[id] - x0).toBeGreaterThan(ROUTE_TOP_SPEED * 2.9);
  });

  it("stop for 1 s for a non-follower dead ahead within 2 m", () => {
    // Team 0's own avatar stands on the first leg at x = 15.
    const state = createSim(loadMapFromJson(roads([55, 55], [15, 30])), 11);
    const id = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    for (let t = 0; t < 30 * 10; t++) {
      step(state, idle);
      expect(state.ent.posX[id]).toBeLessThan(13.1);
    }
    expect(state.route.speed[id]).toBe(0);
    expect(state.route.hold[id]).toBeGreaterThan(0);
    expect(state.route.hold[id]).toBeLessThanOrEqual(ROUTE_HOLD_ENGINE_TICKS);
  });

  it("yield to a follower ahead on the same leg: half its speed word, held 300 ticks", () => {
    const state = createSim(loadMapFromJson(roads([55, 55])), 13);
    const front = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    for (let t = 0; t < 30; t++) step(state, idle); // ~2 m ahead
    const back = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    step(state, idle);
    step(state, idle);
    expect(state.ent.posX[front] - state.ent.posX[back]).toBeLessThan(2 + 2 * 0.95);
    expect(state.route.speed[back]).toBe(ROUTE_SPEED_WORD >> 1);
    expect(state.route.hold[back]).toBe(ROUTE_HOLD_ENGINE_TICKS);
    // The front one is further along: it keeps its speed.
    expect(state.route.speed[front]).toBe(ROUTE_SPEED_WORD);
  });

  it("the Juggernaut ignores traffic (the Dreadnought's route flag 0x8)", () => {
    const state = createSim(loadMapFromJson(roads([55, 55])), 17);
    const front = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    for (let t = 0; t < 45; t++) step(state, idle);
    state.route.speed[front] = 0; // stalled ahead, ~3 m on
    const jug = spawnUnit(state, ARCHETYPE.JUGGERNAUT, 0, 10, 30);
    for (let t = 0; t < 8; t++) {
      step(state, idle);
      // Within the 2 m gap of the stalled tank, and still at its top speed.
      expect(state.route.speed[jug]).toBe(ROUTE_SPEED_WORD);
      expect(state.route.velocity[jug]).toBe(ROUTE_SPEED_WORD);
    }
  });

  it("a Dreadnought that runs into a follower: the one behind halves, the one in front is pushed", () => {
    const state = createSim(loadMapFromJson(roads([55, 55])), 17);
    const front = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    for (let t = 0; t < 45; t++) step(state, idle);
    state.route.speed[front] = 0;
    const jug = spawnUnit(state, ARCHETYPE.JUGGERNAUT, 0, 10, 30);
    let t = 0;
    while (state.route.hold[jug] === 0 && t++ < 60) step(state, idle);
    // The contact (cnet_route_contact): the tank, less of the leg left, is in
    // front; the Dreadnought behind keeps half its speed word and holds +300,
    // the tank -300.
    expect(state.route.hold[jug]).toBe(ROUTE_CONTACT_HOLD);
    expect(state.route.hold[front]).toBe(-ROUTE_CONTACT_HOLD);
    expect(state.route.velocity[jug]).toBe(ROUTE_SPEED_WORD >> 1);
    // Two tanks never touch: their records lack the collision bit 0x200.
    const other = createSim(loadMapFromJson(roads([55, 55])), 17);
    const a = spawnUnit(other, ARCHETYPE.RUNNER, 0, 10, 30);
    for (let k = 0; k < 45; k++) step(other, idle);
    other.route.speed[a] = 0;
    const b = spawnUnit(other, ARCHETYPE.RUNNER, 0, 10, 30);
    for (let k = 0; k < 60; k++) {
      step(other, idle);
      expect(other.route.hold[a]).toBeGreaterThanOrEqual(0);
    }
    expect(other.route.hold[b]).toBe(ROUTE_HOLD_ENGINE_TICKS);
  });

  it("each side drives its own net: an outpost spawn joins its own team's road", () => {
    const state: SimState = createSim(loadMapFromJson(roads([55, 55])), 19);
    // Nearest node overall is team 1's node 8 (10, 10); team 0 must take node 0.
    const id = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 14, undefined, true);
    expect(state.ent.timerA[id]).toBe(0);
    const g = state.map.laneGraph;
    expect(g?.net[8]).toBe(1);
    expect(g?.net[0]).toBe(0);
  });
});
