// Phase 3 economy & capture on a synthetic arena: trickle income, neutral
// turret capture (uncontested presence), husk respawns, outpost claiming,
// forward spawning at 2× cost and console destruction reverting ownership.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  AVATAR_AMMO_HEAVY,
  CAPTURE_TICKS,
  CONSOLE_HOLD_TICKS,
  COST_GUARDIAN,
  COST_OUTPOST_CLAIM,
  COST_RUNNER,
  NEUTRAL_TURRET_RESPAWN_TICKS,
  OUTPOST_CONSOLE_RESPAWN_TICKS,
  OUTPOST_COST_MULTIPLIER,
  POINTS_CAPTURE_TURRET,
  POINTS_KILL_TURRET,
  STARTING_POINTS,
  TRICKLE_INTERVAL_TICKS,
  TRICKLE_POINTS,
} from "../src/balance";
import { EV_CAPTURE, EV_CLAIM, EV_PURCHASE, EVENT_STRIDE } from "../src/events";
import { BUTTON_FIRE1, BUTTON_FIRE2, BUTTON_INTERACT, createTickInputs } from "../src/inputs";
import { loadMapFromJson, type MapJson } from "../src/map";
import { createSim, type SimState, spawnUnit, step, TURRET_CAPTURABLE } from "../src/sim";
import { UNIT_MODE_ASSAULT } from "../src/units";

// Flat 16×16 grid, 4 m cells → 60 m square. One lane along y=6, a neutral
// turret spot mid-map and one outpost spot between lane and bases.
function battleground(): MapJson {
  const size = 16;
  const heights: number[][] = [];
  const water: string[] = [];
  for (let j = 0; j < size; j++) {
    heights.push(new Array(size).fill(0));
    water.push("0".repeat(size));
  }
  return {
    id: "battleground-test",
    size,
    cellSize: 4,
    waterLevel: -10,
    heights,
    water,
    spawns: [
      { x: 6, y: 54, yaw: 0 },
      { x: 54, y: 54, yaw: 0 },
    ],
    basePlots: [
      { x: 6, y: 54, radius: 6 },
      { x: 54, y: 54, radius: 6 },
    ],
    bases: [
      {
        gate: { x: 14, y: 6, radius: 3 },
        core: [6, 6],
        groundConsole: [6, 14],
        airConsole: [6, 22],
        pad: { x: 6, y: 54, radius: 4 },
        turrets: [],
      },
      {
        gate: { x: 46, y: 6, radius: 3 },
        core: [54, 6],
        groundConsole: [54, 14],
        airConsole: [54, 22],
        pad: { x: 54, y: 54, radius: 4 },
        turrets: [],
      },
    ],
    lanes: [
      [
        [14, 6],
        [46, 6],
      ],
    ],
    turretSpots: [[30, 30]],
    outpostSpots: [[30, 46]],
    dummySpots: [],
  };
}

const freshSim = (): SimState => createSim(loadMapFromJson(battleground()), 42);
const inputs = createTickInputs();

function reset(): void {
  for (const p of inputs.players) {
    p.moveX = 0;
    p.moveY = 0;
    p.aimX = 0;
    p.aimY = 0;
    p.buttons = 0;
  }
}

function findEvents(sim: SimState, type: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < sim.events.count; i++) {
    const o = i * EVENT_STRIDE;
    if (sim.events.data[o] === type) {
      out.push([sim.events.data[o + 1], sim.events.data[o + 2], sim.events.data[o + 3]]);
    }
  }
  return out;
}

describe("trickle income", () => {
  it("pays both ledgers every interval on top of the starting balance", () => {
    reset();
    const sim = freshSim();
    expect(sim.points[0]).toBe(STARTING_POINTS);
    for (let t = 0; t < TRICKLE_INTERVAL_TICKS * 2 + 1; t++) step(sim, inputs);
    expect(sim.points[0]).toBe(STARTING_POINTS + 2 * TRICKLE_POINTS);
    expect(sim.points[1]).toBe(STARTING_POINTS + 2 * TRICKLE_POINTS);
  });
});

describe("neutral turret capture (rules.md §5)", () => {
  it("spawns dormant: no shots at avatars parked in range", () => {
    reset();
    const sim = freshSim();
    sim.ent.posX[0] = 33;
    sim.ent.posY[0] = 42; // 12 m from the spot: inside TURRET_RANGE, outside capture
    for (let t = 0; t < 120; t++) step(sim, inputs);
    expect(sim.ent.hp[0]).toBe(300);
  });

  it("a lone avatar captures after 3 s and the turret starts fighting", () => {
    reset();
    const sim = freshSim();
    sim.ent.posX[0] = 33;
    sim.ent.posY[0] = 30; // 3 m from the spot
    let captured: number[][] = [];
    let ticks = 0;
    for (let t = 1; t <= CAPTURE_TICKS + 2 && captured.length === 0; t++) {
      step(sim, inputs);
      captured = findEvents(sim, EV_CAPTURE);
      ticks = t;
    }
    expect(captured.length).toBe(1);
    expect(ticks).toBe(CAPTURE_TICKS);
    const tid = captured[0][0];
    expect(captured[0][1]).toBe(0);
    expect(sim.ent.team[tid]).toBe(0);
    expect(sim.ent.ownerId[tid]).toBe(0);
    expect(sim.points[0]).toBe(STARTING_POINTS + POINTS_CAPTURE_TURRET);
    // The captured turret now engages an enemy unit walking by.
    const runner = spawnUnit(sim, ARCHETYPE.RUNNER, 1, 30, 20);
    let hurt = false;
    for (let t = 0; t < 90 && !hurt; t++) {
      step(sim, inputs);
      hurt = !sim.ent.alive[runner] || sim.ent.hp[runner] < 60;
    }
    expect(hurt).toBe(true);
  });

  it("an enemy avatar in the radius contests the capture", () => {
    reset();
    const sim = freshSim();
    sim.ent.posX[0] = 33;
    sim.ent.posY[0] = 30;
    sim.ent.posX[1] = 27;
    sim.ent.posY[1] = 30; // both inside CAPTURE_RADIUS
    for (let t = 0; t < CAPTURE_TICKS * 3; t++) step(sim, inputs);
    const tid = sim.neutralTurretEntity[0];
    expect(sim.ent.ownerId[tid]).toBe(-1); // still neutral
    expect(sim.captureProgress[0]).toBe(0);
  });

  it("destroying an enemy-owned turret pays 2 and it respawns neutral", () => {
    reset();
    const sim = freshSim();
    // Hand the turret to team 1, then let avatar 0 shoot it dead.
    const tid = sim.neutralTurretEntity[0];
    sim.ent.team[tid] = 1;
    sim.ent.ownerId[tid] = 1;
    sim.ent.posX[0] = 30;
    sim.ent.posY[0] = 62; // 32 m south: outside TURRET_RANGE, inside PRIMARY_RANGE
    inputs.players[0].aimY = -127; // aim straight at the turret
    inputs.players[0].buttons = BUTTON_FIRE1;
    let died = -1;
    for (let t = 1; t < 400 && died < 0; t++) {
      step(sim, inputs);
      if (!sim.ent.alive[tid]) died = t;
    }
    expect(died).toBeGreaterThan(0);
    const trickled = Math.floor((sim.tick - 1) / TRICKLE_INTERVAL_TICKS) * TRICKLE_POINTS;
    expect(sim.points[0]).toBe(STARTING_POINTS + trickled + POINTS_KILL_TURRET);
    expect(sim.neutralTurretEntity[0]).toBe(-1);
    // Husk: back as NEUTRAL after 45 s.
    inputs.players[0].buttons = 0;
    for (let t = 0; t < NEUTRAL_TURRET_RESPAWN_TICKS; t++) step(sim, inputs);
    const back = sim.neutralTurretEntity[0];
    expect(back).toBeGreaterThanOrEqual(0);
    expect(sim.ent.team[back]).toBe(-1);
    expect(sim.ent.ownerId[back]).toBe(-1);
    expect(sim.ent.mode[back]).toBe(TURRET_CAPTURABLE);
  });
});

describe("outposts (rules.md §5)", () => {
  function claim(sim: SimState, player: number): void {
    sim.ent.posX[player] = 30;
    sim.ent.posY[player] = 46; // on the outpost console
    inputs.players[player].buttons = BUTTON_INTERACT;
    for (let t = 0; t < CONSOLE_HOLD_TICKS; t++) step(sim, inputs);
    inputs.players[player].buttons = 0;
  }

  it("holding interact at a neutral outpost claims it for 30 points", () => {
    reset();
    const sim = freshSim();
    sim.points[0] = 40;
    claim(sim, 0);
    expect(sim.outpostOwner[0]).toBe(0);
    expect(sim.points[0]).toBe(40 - COST_OUTPOST_CLAIM);
    const cid = sim.outpostConsole[0];
    expect(sim.ent.team[cid]).toBe(0);
  });

  it("claiming emits EV_CLAIM and is blocked without the points", () => {
    reset();
    const sim = freshSim();
    sim.points[0] = COST_OUTPOST_CLAIM - 1;
    claim(sim, 0);
    expect(sim.outpostOwner[0]).toBe(-1); // too poor: hold never progressed
    sim.points[0] = COST_OUTPOST_CLAIM;
    sim.ent.posX[0] = 30;
    sim.ent.posY[0] = 46;
    inputs.players[0].buttons = BUTTON_INTERACT;
    let claimed: number[][] = [];
    for (let t = 0; t < CONSOLE_HOLD_TICKS && claimed.length === 0; t++) {
      step(sim, inputs);
      claimed = findEvents(sim, EV_CLAIM);
    }
    expect(claimed.length).toBe(1);
    expect(claimed[0][1]).toBe(0);
  });

  it("an owned outpost forward-spawns runners and assault guardians at 2×", () => {
    reset();
    const sim = freshSim();
    sim.points[0] = 60;
    claim(sim, 0);
    const afterClaim = sim.points[0];
    // Runner at 2× cost, spawned AT the outpost, joining the nearest lane.
    inputs.players[0].buttons = BUTTON_INTERACT;
    let bought: number[][] = [];
    for (let t = 0; t < CONSOLE_HOLD_TICKS && bought.length === 0; t++) {
      step(sim, inputs);
      bought = findEvents(sim, EV_PURCHASE);
    }
    expect(bought.length).toBe(1);
    expect(bought[0][2]).toBe(ARCHETYPE.RUNNER);
    expect(sim.points[0]).toBe(afterClaim - COST_RUNNER * OUTPOST_COST_MULTIPLIER);
    const rid = bought[0][0];
    expect(Math.hypot(sim.ent.posX[rid] - 30, sim.ent.posY[rid] - 46)).toBeLessThan(8);
    // FIRE2 orders the air unit — it leaves in ASSAULT mode (spawn-site switch).
    inputs.players[0].buttons = BUTTON_INTERACT | BUTTON_FIRE2;
    bought = [];
    for (let t = 0; t < CONSOLE_HOLD_TICKS + 1 && bought.length === 0; t++) {
      step(sim, inputs);
      bought = findEvents(sim, EV_PURCHASE);
    }
    expect(bought.length).toBe(1);
    expect(bought[0][2]).toBe(ARCHETYPE.GUARDIAN);
    expect(sim.ent.mode[bought[0][0]]).toBe(UNIT_MODE_ASSAULT);
    expect(sim.points[0]).toBe(
      afterClaim - (COST_RUNNER + COST_GUARDIAN) * OUTPOST_COST_MULTIPLIER,
    );
  });

  it("an owned outpost refills the owner's ammo, not the enemy's", () => {
    reset();
    const sim = freshSim();
    sim.points[0] = 40;
    claim(sim, 0);
    sim.ent.ammoA[0] = 0;
    sim.ent.ammoA[1] = 0;
    sim.ent.posX[1] = 33;
    sim.ent.posY[1] = 46; // enemy avatar also on the pad
    step(sim, inputs);
    expect(sim.ent.ammoA[0]).toBe(AVATAR_AMMO_HEAVY);
    expect(sim.ent.ammoA[1]).toBe(0);
  });

  it("destroying the console reverts the outpost; it respawns neutral", () => {
    reset();
    const sim = freshSim();
    sim.points[0] = 40;
    claim(sim, 0);
    const cid = sim.outpostConsole[0];
    sim.ent.hp[cid] = 0; // enemy demolition
    step(sim, inputs);
    expect(sim.outpostOwner[0]).toBe(-1);
    expect(sim.outpostConsole[0]).toBe(-1);
    for (let t = 0; t < OUTPOST_CONSOLE_RESPAWN_TICKS; t++) step(sim, inputs);
    const back = sim.outpostConsole[0];
    expect(back).toBeGreaterThanOrEqual(0);
    expect(sim.ent.team[back]).toBe(-1); // claimable again
  });
});
