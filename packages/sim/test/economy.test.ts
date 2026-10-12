// Phase 3 economy & capture on a synthetic arena: the original's income table
// (no trickle; deaths pay the other side), alive caps and the heavy unlock,
// neutral turret capture, husk respawns, outpost claiming, forward spawning at
// 2× cost and console destruction reverting ownership.
//
// The income numbers pin the original's (fcop-re/ai-and-rules.md §2, §8;
// fcop-fidelity.md R2-R10), not the invented 20-point start, 1-per-10-s trickle
// and killer-paid bounties this file used to pin.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  ARCHETYPE_RADIUS,
  AVATAR_AMMO_HEAVY,
  CAPTURE_RADIUS,
  CONSOLE_HOLD_TICKS,
  COST_FORTRESS,
  COST_GUARDIAN,
  COST_JUGGERNAUT,
  COST_OUTPOST_CLAIM,
  COST_RUNNER,
  GUARDIAN_ALIVE_LIMIT,
  HEAVY_UNLOCK_POINTS,
  NEUTRAL_TURRET_RESPAWN_TICKS,
  OUTPOST_CONSOLE_RESPAWN_TICKS,
  OUTPOST_COST_MULTIPLIER,
  POINTS_AVATAR_DOWN,
  POINTS_CAPTURE_TURRET,
  POINTS_HEAVY_DIES,
  POINTS_TURRET_DIES,
  POINTS_UNIT_DIES,
  RESPAWN_TICKS,
  RUNNER_ALIVE_LIMIT,
  STARTING_POINTS,
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

describe("income (fcop-fidelity.md R2-R7)", () => {
  it("starts both sides at 10 and adds nothing over time", () => {
    reset();
    const sim = freshSim();
    expect(STARTING_POINTS).toBe(10);
    expect(sim.points[0]).toBe(10);
    expect(sim.points[1]).toBe(10);
    for (let t = 0; t < 30 * 60; t++) step(sim, inputs); // a quiet minute
    expect(sim.points[0]).toBe(10);
    expect(sim.points[1]).toBe(10);
  });

  it("a dead Runner or Guardian pays the other side 1, whoever killed it", () => {
    reset();
    const sim = freshSim();
    const runner = spawnUnit(sim, ARCHETYPE.RUNNER, 1, 30, 20);
    const guard = spawnUnit(sim, ARCHETYPE.GUARDIAN, 1, 30, 24);
    // No killer at all (environment): the death script pays regardless.
    sim.ent.hp[runner] = 0;
    sim.ent.hp[guard] = 0;
    step(sim, inputs);
    expect(POINTS_UNIT_DIES).toBe(1);
    expect(sim.points[0]).toBe(STARTING_POINTS + 2 * POINTS_UNIT_DIES);
    expect(sim.points[1]).toBe(STARTING_POINTS);
  });

  it("a dead Juggernaut or Fortress pays the other side 5", () => {
    reset();
    const sim = freshSim();
    const jugg = spawnUnit(sim, ARCHETYPE.JUGGERNAUT, 0, 30, 20);
    const fort = spawnUnit(sim, ARCHETYPE.FORTRESS, 0, 30, 24);
    sim.ent.hp[jugg] = 0;
    sim.ent.hp[fort] = 0;
    step(sim, inputs);
    expect(POINTS_HEAVY_DIES).toBe(5);
    expect(sim.points[1]).toBe(STARTING_POINTS + 2 * POINTS_HEAVY_DIES);
    expect(sim.points[0]).toBe(STARTING_POINTS);
  });

  it("an avatar going down pays 10 at its respawn and costs the victim 10, floored at 0", () => {
    reset();
    const sim = freshSim();
    sim.points[0] = 14;
    sim.ent.hp[sim.avatarId[0]] = -10; // below the pad's same-tick repair
    step(sim, inputs);
    // Paid by the downed side's own script when it comes back, not at the kill.
    expect(sim.points[1]).toBe(STARTING_POINTS);
    for (let t = 0; t < RESPAWN_TICKS && sim.avatarId[0] < 0; t++) step(sim, inputs);
    expect(sim.avatarId[0]).toBeGreaterThanOrEqual(0);
    expect(sim.points[1]).toBe(STARTING_POINTS + POINTS_AVATAR_DOWN);
    expect(sim.points[0]).toBe(14 - POINTS_AVATAR_DOWN);
    // A second fall with 4 left floors the victim at 0.
    sim.ent.hp[sim.avatarId[0]] = -10; // below the pad's same-tick repair
    step(sim, inputs);
    for (let t = 0; t < RESPAWN_TICKS && sim.avatarId[0] < 0; t++) step(sim, inputs);
    expect(sim.avatarId[0]).toBeGreaterThanOrEqual(0);
    expect(sim.points[0]).toBe(0);
    expect(sim.points[1]).toBe(STARTING_POINTS + 2 * POINTS_AVATAR_DOWN);
  });
});

describe("alive caps and the heavy unlock (fcop-fidelity.md R9, R10)", () => {
  function hold(sim: SimState, x: number, y: number, buttons: number, ticks: number): void {
    sim.ent.posX[0] = x;
    sim.ent.posY[0] = y;
    inputs.players[0].buttons = buttons;
    for (let t = 0; t < ticks; t++) step(sim, inputs);
    inputs.players[0].buttons = 0;
  }

  it("caps Runners and Guardians at 20 alive per side", () => {
    reset();
    const sim = freshSim();
    expect(RUNNER_ALIVE_LIMIT).toBe(20);
    expect(GUARDIAN_ALIVE_LIMIT).toBe(20);
    for (let k = 0; k < RUNNER_ALIVE_LIMIT; k++) spawnUnit(sim, ARCHETYPE.RUNNER, 0, 6, 40);
    sim.points[0] = 100;
    hold(sim, 6, 14, BUTTON_INTERACT, CONSOLE_HOLD_TICKS * 3);
    expect(sim.points[0]).toBe(100); // the ground console refuses the 21st
    hold(sim, 6, 22, BUTTON_INTERACT, CONSOLE_HOLD_TICKS);
    expect(sim.points[0]).toBe(100 - COST_GUARDIAN); // the jet cap is separate
  });

  it("opens the heavy units the first time a side reaches 50, and keeps them open", () => {
    reset();
    const sim = freshSim();
    expect(HEAVY_UNLOCK_POINTS).toBe(50);
    expect(sim.heavyUnlocked[0]).toBe(0);
    sim.points[0] = HEAVY_UNLOCK_POINTS - 1;
    step(sim, inputs);
    expect(sim.heavyUnlocked[0]).toBe(0);
    sim.points[0] = HEAVY_UNLOCK_POINTS;
    step(sim, inputs);
    expect(sim.heavyUnlocked[0]).toBe(1);
    expect(sim.heavyUnlocked[1]).toBe(0); // per side
    // Spend below 50: the purchase stays open, and a second heavy can be bought
    // with the next 50 points.
    hold(sim, 6, 14, BUTTON_INTERACT | BUTTON_FIRE2, CONSOLE_HOLD_TICKS + 1);
    expect(sim.points[0]).toBe(HEAVY_UNLOCK_POINTS - COST_JUGGERNAUT);
    expect(sim.heavyUnlocked[0]).toBe(1);
    sim.points[0] = COST_FORTRESS;
    hold(sim, 6, 22, BUTTON_INTERACT | BUTTON_FIRE2, CONSOLE_HOLD_TICKS + 1);
    expect(sim.points[0]).toBe(0);
  });

  it("refuses a heavy unit until the end of the tick the side first holds 50", () => {
    reset();
    const sim = freshSim();
    // The unlock is checked after every credit, at the end of the tick, so a side
    // whose points arrive this tick can buy from the next one.
    sim.points[0] = HEAVY_UNLOCK_POINTS;
    sim.ent.posX[0] = 6;
    sim.ent.posY[0] = 14;
    inputs.players[0].buttons = BUTTON_INTERACT | BUTTON_FIRE2;
    step(sim, inputs);
    expect(sim.buyTarget[0]).toBe(-1); // refused on the first tick
    expect(sim.heavyUnlocked[0]).toBe(1); // ...and open from the next
    inputs.players[0].buttons = 0;
  });
});

describe("neutral turret capture (rules.md §5, fcop-fidelity.md R12)", () => {
  // These pinned a 3 s uncontested stand within 5 m until SIM_VERSION 34. The
  // original captures on one action-key press, in range + radius, with no
  // contest; tanks capture by proximity (fcop-re/ranges-turrets-capture.md Q2).
  it("spawns dormant: no shots at avatars parked in range", () => {
    reset();
    const sim = freshSim();
    sim.ent.posX[0] = 33;
    sim.ent.posY[0] = 42; // 12 m from the spot: inside TURRET_RANGE, outside capture
    for (let t = 0; t < 120; t++) step(sim, inputs);
    expect(sim.ent.hp[0]).toBe(300);
  });

  /** Puts avatar `p` at (x, y) and runs one tick with `buttons` held. */
  function at(sim: SimState, p: number, x: number, y: number, buttons: number): void {
    sim.ent.posX[sim.avatarId[p]] = x;
    sim.ent.posY[sim.avatarId[p]] = y;
    inputs.players[p].buttons = buttons;
    step(sim, inputs);
  }

  it("an avatar captures instantly on the action-key press, and the turret fights", () => {
    reset();
    const sim = freshSim();
    // Standing next to it does nothing: the original gates the avatar on a press.
    for (let t = 0; t < 120; t++) at(sim, 0, 33, 30, 0);
    expect(findEvents(sim, EV_CAPTURE).length).toBe(0);
    expect(sim.ent.ownerId[sim.neutralTurretEntity[0]]).toBe(-1);
    // One press, and it flips on that tick: no timer (fcop-fidelity.md R12).
    at(sim, 0, 33, 30, BUTTON_INTERACT);
    const captured = findEvents(sim, EV_CAPTURE);
    expect(captured.length).toBe(1);
    const tid = captured[0][0];
    expect(captured[0][1]).toBe(0);
    expect(sim.ent.team[tid]).toBe(0);
    expect(sim.ent.ownerId[tid]).toBe(0);
    expect(POINTS_CAPTURE_TURRET).toBe(1);
    expect(sim.points[0]).toBe(STARTING_POINTS + POINTS_CAPTURE_TURRET);
    // The captured turret now engages an enemy unit walking by.
    inputs.players[0].buttons = 0;
    const runner = spawnUnit(sim, ARCHETYPE.RUNNER, 1, 30, 20);
    let hurt = false;
    for (let t = 0; t < 90 && !hurt; t++) {
      step(sim, inputs);
      hurt = !sim.ent.alive[runner] || sim.ent.hp[runner] < 60;
    }
    expect(hurt).toBe(true);
  });

  it("reaches the arena's range plus the avatar's own radius, in 3D", () => {
    reset();
    const sim = freshSim();
    expect(sim.map.captureRange).toBe(0); // no imported range: CAPTURE_RADIUS
    const reach = CAPTURE_RADIUS + ARCHETYPE_RADIUS[ARCHETYPE.AVATAR];
    at(sim, 0, 30 + reach + 0.05, 30, BUTTON_INTERACT);
    expect(findEvents(sim, EV_CAPTURE).length).toBe(0);
    at(sim, 0, 30 + reach + 0.05, 30, 0);
    // Close enough on the ground, but the height counts too.
    sim.ent.height[sim.avatarId[0]] = reach;
    sim.ent.posX[sim.avatarId[0]] = 31;
    sim.ent.posY[sim.avatarId[0]] = 30;
    inputs.players[0].buttons = BUTTON_INTERACT;
    step(sim, inputs);
    expect(findEvents(sim, EV_CAPTURE).length).toBe(0);
    sim.ent.height[sim.avatarId[0]] = 0; // back on the ground
    at(sim, 0, 31, 30, 0);
    at(sim, 0, 30 + reach - 0.05, 30, BUTTON_INTERACT);
    expect(findEvents(sim, EV_CAPTURE).length).toBe(1);
  });

  it("counts the press, not the hold", () => {
    reset();
    const sim = freshSim();
    at(sim, 0, 45, 30, BUTTON_INTERACT); // pressed out of range...
    for (let t = 0; t < 30; t++) at(sim, 0, 33, 30, BUTTON_INTERACT); // ...held into it
    expect(sim.ent.ownerId[sim.neutralTurretEntity[0]]).toBe(-1);
    at(sim, 0, 33, 30, 0);
    at(sim, 0, 33, 30, BUTTON_INTERACT); // a fresh press takes it
    expect(sim.ent.ownerId[sim.neutralTurretEntity[0]]).toBe(0);
  });

  it("is not contested, and a captured turret stays captured until destroyed", () => {
    reset();
    const sim = freshSim();
    // The enemy standing on it changes nothing: the first press wins.
    sim.ent.posX[sim.avatarId[1]] = 27;
    sim.ent.posY[sim.avatarId[1]] = 30;
    at(sim, 0, 33, 30, BUTTON_INTERACT);
    const tid = sim.neutralTurretEntity[0];
    expect(sim.ent.ownerId[tid]).toBe(0);
    // The other side cannot press it back.
    inputs.players[0].buttons = 0;
    for (let t = 0; t < 4; t++) {
      inputs.players[1].buttons = t % 2 === 0 ? BUTTON_INTERACT : 0;
      step(sim, inputs);
    }
    expect(sim.ent.ownerId[tid]).toBe(0);
    expect(sim.points[1]).toBe(STARTING_POINTS);
  });

  it("a Runner captures by coming close; Guardians and Juggernauts never do", () => {
    reset();
    const sim = freshSim();
    const tid = sim.neutralTurretEntity[0];
    const guard = spawnUnit(sim, ARCHETYPE.GUARDIAN, 1, 30, 30);
    const jugg = spawnUnit(sim, ARCHETYPE.JUGGERNAUT, 1, 31, 30);
    sim.ent.posX[guard] = 30;
    sim.ent.posY[guard] = 30;
    sim.ent.height[guard] = 0;
    step(sim, inputs);
    expect(sim.ent.ownerId[tid]).toBe(-1);
    sim.ent.hp[guard] = 0;
    sim.ent.hp[jugg] = 0;
    step(sim, inputs);
    const runner = spawnUnit(sim, ARCHETYPE.RUNNER, 1, 32, 30);
    step(sim, inputs);
    expect(sim.ent.alive[runner]).toBe(1);
    expect(sim.ent.ownerId[tid]).toBe(1);
    expect(sim.points[1]).toBe(STARTING_POINTS + POINTS_CAPTURE_TURRET);
  });

  it("destroying an enemy-owned turret pays 1 and it respawns neutral", () => {
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
    expect(POINTS_TURRET_DIES).toBe(1);
    expect(sim.points[0]).toBe(STARTING_POINTS + POINTS_TURRET_DIES);
    expect(sim.neutralTurretEntity[0]).toBe(-1);
    // Husk: back as NEUTRAL after the original's 25 s.
    expect(NEUTRAL_TURRET_RESPAWN_TICKS).toBe(750);
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
