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
// random. Neither steps straight back, both walk the legs at 1.98 m/s, slow for
// traffic in 1 s holds, and never stop to fight.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { ROUTE_HOLD_TICKS, ROUTE_TOP_SPEED, TICK_DT } from "../src/balance";
import { createTickInputs } from "../src/inputs";
import { loadMapFromJson, type MapJson } from "../src/map";
import { createSim, type SimState, spawnUnit, step } from "../src/sim";
import { startRoute } from "../src/units";

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
function roads(enemyAt: number[], ownAt: number[] = [5, 55]): MapJson {
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
    },
  } as MapJson;
}

const idle = createTickInputs();

/** Runs a Runner from the entry until it has chosen at the fork; returns 2 or 3. */
function forkChoice(seed: number, enemyAt: number[], crowd = false): number {
  const state = createSim(loadMapFromJson(roads(enemyAt)), seed);
  if (crowd) {
    // A team-0 follower parked on the north leg, already heading to node 2.
    const parked = spawnUnit(state, ARCHETYPE.RUNNER, 0, 25, 35);
    startRoute(state, parked, 2);
    state.ent.aimX[parked] = 0;
  }
  const id = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
  for (let t = 0; t < 30 * 20; t++) {
    step(state, idle);
    const node = state.ent.timerA[id];
    if (node === 2 || node === 3) return node;
  }
  throw new Error("never reached the fork");
}

describe("route followers on the original road graph", () => {
  it("walk the legs at the route block's 1.98 m/s and turn at the nodes", () => {
    expect(ROUTE_TOP_SPEED).toBeCloseTo(1.9775, 4);
    const state = createSim(loadMapFromJson(roads([55, 55])), 7);
    const id = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    step(state, idle);
    let x = state.ent.posX[id];
    for (let t = 0; t < 60; t++) {
      step(state, idle);
      expect(state.ent.posX[id] - x).toBeCloseTo(ROUTE_TOP_SPEED * TICK_DT, 5);
      expect(state.ent.posY[id]).toBe(30); // on the leg, never off it
      x = state.ent.posX[id];
    }
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
    // left (refused outright): the follower halts on 6 for good.
    expect(visited.slice(-3)).toEqual([5, 6, -1]);
    expect(state.ent.posX[id]).toBe(54);
    expect(state.ent.posY[id]).toBe(34);
    expect(state.ent.velX[id]).toBe(0);
  });

  it("steer toward the nearest enemy within 16 m on the 60 % of steps that seek", () => {
    let north = 0;
    let northAlone = 0;
    const N = 200;
    for (let seed = 1; seed <= N; seed++) {
      // Team 1's avatar 11.7 m from the fork, beside the north branch.
      if (forkChoice(seed, [26, 40]) === 2) north += 1;
      // Nobody within 16 m: every step is random.
      if (forkChoice(seed, [55, 55]) === 2) northAlone += 1;
    }
    // Seek wins on 60 % of steps, the random 40 % split evenly: ~80 % north.
    expect(north / N).toBeGreaterThan(0.7);
    expect(north / N).toBeLessThan(0.9);
    expect(northAlone / N).toBeGreaterThan(0.38);
    expect(northAlone / N).toBeLessThan(0.62);
  });

  it("halve a node's score per follower already heading there", () => {
    // The enemy 12 m due east of the fork: both branches align within one
    // octave (dot 124800 and 120960 node units², both 32 + 16 = 48), a tie the
    // coin settles. A follower already heading north costs that branch an
    // octave — 48 >> 1 = 24 — so every seeking step goes south.
    let north = 0;
    let northFree = 0;
    const N = 200;
    for (let seed = 1; seed <= N; seed++) {
      if (forkChoice(seed, [32, 30.2], true) === 2) north += 1;
      if (forkChoice(seed, [32, 30.2]) === 2) northFree += 1;
    }
    expect(northFree / N).toBeGreaterThan(0.38);
    expect(northFree / N).toBeLessThan(0.62);
    expect(north / N).toBeLessThan(0.3);
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
    expect(state.ent.aimX[id]).toBe(0);
    expect(state.ent.timerB[id]).toBeGreaterThan(0);
    expect(state.ent.timerB[id]).toBeLessThanOrEqual(ROUTE_HOLD_TICKS);
  });

  it("yield to a follower ahead on the same leg: half its speed, held for 1 s", () => {
    const state = createSim(loadMapFromJson(roads([55, 55])), 13);
    const front = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    for (let t = 0; t < 30; t++) step(state, idle); // ~2 m ahead
    const back = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    step(state, idle);
    step(state, idle);
    expect(state.ent.posX[front] - state.ent.posX[back]).toBeLessThan(2 + 2 * 0.76);
    expect(state.ent.aimX[back]).toBeCloseTo(ROUTE_TOP_SPEED / 2, 5);
    expect(state.ent.timerB[back]).toBe(ROUTE_HOLD_TICKS);
    // The front one is further along: it keeps its speed.
    expect(state.ent.aimX[front]).toBeCloseTo(ROUTE_TOP_SPEED, 5);
  });

  it("the Juggernaut ignores traffic (the Dreadnought's route flag 0x8)", () => {
    const state = createSim(loadMapFromJson(roads([55, 55])), 17);
    const front = spawnUnit(state, ARCHETYPE.RUNNER, 0, 10, 30);
    for (let t = 0; t < 30; t++) step(state, idle);
    state.ent.aimX[front] = 0; // stalled ahead
    const jug = spawnUnit(state, ARCHETYPE.JUGGERNAUT, 0, 10, 30);
    for (let t = 0; t < 40; t++) step(state, idle);
    expect(state.ent.aimX[jug]).toBe(ROUTE_TOP_SPEED);
    expect(state.ent.posX[jug]).toBeGreaterThan(state.ent.posX[front]);
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
