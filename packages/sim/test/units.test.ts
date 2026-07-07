// Phase 2 systems on a synthetic 60 m "warzone" arena: base structures,
// console purchases, unit lane-following, engagement, separation, the win
// check and the post-breach freeze. Avatars spawn in the far north so they
// never interfere with the lane fighting in the south (all ranges < 48 m).
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  AIR_ALTITUDE,
  ARCHETYPE_MAX_HP,
  AVATAR_HP,
  BASE_TURRET_RESPAWN_TICKS,
  GUARDIAN_ASSAULT_STANDOFF,
  PAD_REPAIR_HP_PER_TICK,
  RUNNER_SPEED,
  UNIT_SEPARATION_RADIUS,
} from "../src/balance";
import { EV_BREACH, EV_PURCHASE, EVENT_STRIDE } from "../src/events";
import { BUTTON_FIRE2, BUTTON_INTERACT, createTickInputs } from "../src/inputs";
import { loadMapFromJson, type MapJson } from "../src/map";
import { createSim, hash, type SimState, spawnUnit, step } from "../src/sim";
import { UNIT_MODE_ASSAULT } from "../src/units";

// Flat 16×16 grid, 4 m cells → 60 m square. One straight lane along y=6
// between the two gates; avatars/pads live at y=54.
function warzone(ringTurrets: { west: number[][]; east: number[][] }): MapJson {
  const size = 16;
  const heights: number[][] = [];
  const water: string[] = [];
  for (let j = 0; j < size; j++) {
    heights.push(new Array(size).fill(0));
    water.push("0".repeat(size));
  }
  return {
    id: "warzone-test",
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
        turrets: ringTurrets.west,
      },
      {
        gate: { x: 46, y: 6, radius: 3 },
        core: [54, 6],
        groundConsole: [54, 14],
        airConsole: [54, 22],
        pad: { x: 54, y: 54, radius: 4 },
        turrets: ringTurrets.east,
      },
    ],
    lanes: [
      [
        [14, 6],
        [46, 6],
      ],
    ],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
  };
}

const openSim = (): SimState => createSim(loadMapFromJson(warzone({ west: [], east: [] })), 42);
const defendedSim = (): SimState =>
  createSim(loadMapFromJson(warzone({ west: [], east: [[46, 14]] })), 42);

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

describe("base structures", () => {
  it("spawns one ring turret per authored slot, owned by its team", () => {
    const sim = defendedSim();
    expect(sim.baseTurretEntity.length).toBe(1);
    const id = sim.baseTurretEntity[0];
    expect(id).toBeGreaterThanOrEqual(0);
    expect(sim.ent.archetype[id]).toBe(ARCHETYPE.TURRET);
    expect(sim.ent.team[id]).toBe(1);
    expect(sim.ent.ownerId[id]).toBe(1);
  });

  it("ring turrets respawn 60 s after destruction", () => {
    reset();
    const sim = defendedSim();
    const id = sim.baseTurretEntity[0];
    sim.ent.hp[id] = 0; // killed by whatever means
    step(sim, inputs);
    expect(sim.baseTurretEntity[0]).toBe(-1);
    // The death tick's own spawning pass already counted down once.
    expect(sim.baseTurretRespawn[0]).toBe(BASE_TURRET_RESPAWN_TICKS - 1);
    for (let t = 0; t < BASE_TURRET_RESPAWN_TICKS; t++) step(sim, inputs);
    const back = sim.baseTurretEntity[0];
    expect(back).toBeGreaterThanOrEqual(0);
    expect(sim.ent.alive[back]).toBe(1);
    expect(sim.ent.hp[back]).toBe(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET]);
  });

  it("owned turrets never fight each other, even in mutual range", () => {
    reset();
    // Both rings authored 10 m apart mid-map — well inside TURRET_RANGE.
    const sim = createSim(loadMapFromJson(warzone({ west: [[26, 30]], east: [[34, 30]] })), 42);
    const w = sim.baseTurretEntity[0];
    const e = sim.baseTurretEntity[1];
    for (let t = 0; t < 300; t++) step(sim, inputs);
    expect(sim.ent.alive[w]).toBe(1);
    expect(sim.ent.alive[e]).toBe(1);
    expect(sim.ent.hp[w]).toBe(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET]);
    expect(sim.ent.hp[e]).toBe(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET]);
  });

  it("the pad repairs a damaged avatar standing on it", () => {
    reset();
    const sim = openSim(); // avatar 0 spawns on its pad
    sim.ent.hp[0] = AVATAR_HP - 100;
    step(sim, inputs);
    expect(sim.ent.hp[0]).toBe(AVATAR_HP - 100 + PAD_REPAIR_HP_PER_TICK);
    for (let t = 0; t < 300; t++) step(sim, inputs);
    expect(sim.ent.hp[0]).toBe(AVATAR_HP); // clamped at max
  });
});

describe("console purchases", () => {
  it("interact at the ground console spawns a Runner with a purchase event", () => {
    reset();
    const sim = openSim();
    sim.ent.posX[0] = 6;
    sim.ent.posY[0] = 14; // on the own ground console
    inputs.players[0].buttons = BUTTON_INTERACT;
    step(sim, inputs);
    const bought = findEvents(sim, EV_PURCHASE);
    expect(bought.length).toBe(1);
    const [uid, player, archetype] = bought[0];
    expect(player).toBe(0);
    expect(archetype).toBe(ARCHETYPE.RUNNER);
    expect(sim.ent.alive[uid]).toBe(1);
    expect(sim.ent.team[uid]).toBe(0);
    // Held button must not buy again (edge detection).
    for (let t = 0; t < 10; t++) step(sim, inputs);
    expect(findEvents(sim, EV_PURCHASE).length).toBe(0);
  });

  it("interact+fire2 buys the heavy variant, capped at one alive", () => {
    reset();
    const sim = openSim();
    sim.ent.posX[0] = 6;
    sim.ent.posY[0] = 14;
    inputs.players[0].buttons = BUTTON_INTERACT | BUTTON_FIRE2;
    step(sim, inputs);
    let bought = findEvents(sim, EV_PURCHASE);
    expect(bought.length).toBe(1);
    expect(bought[0][2]).toBe(ARCHETYPE.JUGGERNAUT);
    const jugg = bought[0][0];
    // Re-press: limit blocks a second Juggernaut.
    inputs.players[0].buttons = 0;
    step(sim, inputs);
    inputs.players[0].buttons = BUTTON_INTERACT | BUTTON_FIRE2;
    step(sim, inputs);
    expect(findEvents(sim, EV_PURCHASE).length).toBe(0);
    // Kill it → the slot frees up.
    sim.ent.hp[jugg] = 0;
    inputs.players[0].buttons = 0;
    step(sim, inputs);
    inputs.players[0].buttons = BUTTON_INTERACT | BUTTON_FIRE2;
    step(sim, inputs);
    bought = findEvents(sim, EV_PURCHASE);
    expect(bought.length).toBe(1);
    expect(bought[0][2]).toBe(ARCHETYPE.JUGGERNAUT);
  });

  it("the air console sells Guardians and Fortresses", () => {
    reset();
    const sim = openSim();
    sim.ent.posX[0] = 6;
    sim.ent.posY[0] = 22; // on the own air console
    inputs.players[0].buttons = BUTTON_INTERACT;
    step(sim, inputs);
    expect(findEvents(sim, EV_PURCHASE)[0][2]).toBe(ARCHETYPE.GUARDIAN);
    inputs.players[0].buttons = 0;
    step(sim, inputs);
    inputs.players[0].buttons = BUTTON_INTERACT | BUTTON_FIRE2;
    step(sim, inputs);
    expect(findEvents(sim, EV_PURCHASE)[0][2]).toBe(ARCHETYPE.FORTRESS);
  });

  it("interact away from any console buys nothing", () => {
    reset();
    const sim = openSim();
    inputs.players[0].buttons = BUTTON_INTERACT; // at spawn, far from consoles
    step(sim, inputs);
    expect(findEvents(sim, EV_PURCHASE).length).toBe(0);
  });
});

describe("runner lane-following and the win check", () => {
  it("a runner walks the lane into the enemy gate and wins the match", () => {
    reset();
    const sim = openSim();
    const id = spawnUnit(sim, ARCHETYPE.RUNNER, 0, 14, 6);
    expect(id).toBeGreaterThanOrEqual(0);
    let breachTick = -1;
    for (let t = 0; t < 400; t++) {
      step(sim, inputs);
      if (sim.winner >= 0) {
        breachTick = t;
        break;
      }
    }
    expect(sim.winner).toBe(0);
    expect(breachTick).toBeGreaterThan(0);
    // 32 m of lane at RUNNER_SPEED, breach at gate radius 3 → ~29 m.
    const expected = Math.floor(29 / (RUNNER_SPEED / 30));
    expect(Math.abs(breachTick - expected)).toBeLessThan(30);
  });

  it("the breach emits EV_BREACH and freezes the sim", () => {
    reset();
    const sim = openSim();
    spawnUnit(sim, ARCHETYPE.RUNNER, 1, 46, 6); // team 1 walks the lane west
    let sawBreach: number[][] = [];
    for (let t = 0; t < 400 && sawBreach.length === 0; t++) {
      step(sim, inputs);
      sawBreach = findEvents(sim, EV_BREACH);
    }
    expect(sim.winner).toBe(1);
    expect(sawBreach.length).toBe(1);
    expect(sawBreach[0][1]).toBe(1);
    // Frozen: avatars ignore input, only the tick advances the hash.
    const x0 = sim.ent.posX[0];
    inputs.players[0].moveX = 127;
    const h1 = hash(sim);
    step(sim, inputs);
    expect(sim.ent.posX[0]).toBe(x0);
    expect(hash(sim)).not.toBe(h1); // tick still advances…
    expect(sim.winner).toBe(1); // …but the result stands
  });

  it("a lone runner dies to the enemy ring turret (escort matters)", () => {
    reset();
    const sim = defendedSim();
    const id = spawnUnit(sim, ARCHETYPE.RUNNER, 0, 14, 6);
    for (let t = 0; t < 600; t++) step(sim, inputs);
    expect(sim.ent.alive[id]).toBe(0); // shredded on approach
    expect(sim.winner).toBe(-1);
    // The kill credits the turret's owner.
    expect(sim.points[1]).toBeGreaterThan(0);
  });

  it("a juggernaut kills the ring turret in its path and then breaches", () => {
    reset();
    const sim = defendedSim();
    const turret = sim.baseTurretEntity[0];
    const id = spawnUnit(sim, ARCHETYPE.JUGGERNAUT, 0, 14, 6);
    let turretDied = -1;
    for (let t = 0; t < 1200 && sim.winner < 0; t++) {
      step(sim, inputs);
      if (turretDied < 0 && !sim.ent.alive[turret]) turretDied = t;
    }
    expect(turretDied).toBeGreaterThan(0); // engage-in-path stopped and shot it
    expect(sim.ent.alive[id]).toBe(1); // survived the exchange (600 hp)
    expect(sim.winner).toBe(0); // then resumed and breached
  });
});

describe("guardian behavior", () => {
  it("patrols: orbits the own core and stays inside the patrol ring", () => {
    reset();
    const sim = openSim();
    const id = spawnUnit(sim, ARCHETYPE.GUARDIAN, 0, 10, 10);
    for (let t = 0; t < 300; t++) {
      step(sim, inputs);
      const dx = sim.ent.posX[id] - 6;
      const dy = sim.ent.posY[id] - 6;
      expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThan(35);
    }
    expect(sim.ent.height[id]).toBe(AIR_ALTITUDE); // flat map: flies at altitude
  });

  it("patrol intercepts an intruder near the base", () => {
    reset();
    const sim = openSim();
    const guard = spawnUnit(sim, ARCHETYPE.GUARDIAN, 0, 6, 30); // south of base plot
    const intruder = spawnUnit(sim, ARCHETYPE.RUNNER, 1, 46, 6); // walks west into the zone
    let d0 = -1;
    let engaged = false;
    for (let t = 0; t < 600 && !engaged; t++) {
      step(sim, inputs);
      if (!sim.ent.alive[intruder]) break;
      const dx = sim.ent.posX[guard] - sim.ent.posX[intruder];
      const dy = sim.ent.posY[guard] - sim.ent.posY[intruder];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d0 < 0) d0 = d;
      if (d < 20) engaged = true;
    }
    expect(engaged).toBe(true); // closed in on the intruder
  });

  it("assault mode presses to the enemy core and holds the standoff", () => {
    reset();
    const sim = openSim();
    const id = spawnUnit(sim, ARCHETYPE.GUARDIAN, 0, 6, 6, UNIT_MODE_ASSAULT);
    for (let t = 0; t < 400; t++) step(sim, inputs);
    const dx = sim.ent.posX[id] - 54;
    const dy = sim.ent.posY[id] - 6;
    const d = Math.sqrt(dx * dx + dy * dy);
    expect(d).toBeLessThan(GUARDIAN_ASSAULT_STANDOFF + 2);
    expect(d).toBeGreaterThan(GUARDIAN_ASSAULT_STANDOFF - 4);
  });
});

describe("radial separation", () => {
  it("stacked friendly ground units push apart to the separation radius", () => {
    reset();
    const sim = openSim();
    const a = spawnUnit(sim, ARCHETYPE.RUNNER, 0, 30, 30);
    const b = spawnUnit(sim, ARCHETYPE.RUNNER, 0, 30, 30);
    step(sim, inputs);
    const d1 = Math.hypot(sim.ent.posX[b] - sim.ent.posX[a], sim.ent.posY[b] - sim.ent.posY[a]);
    expect(d1).toBeGreaterThan(0); // exact stack broken deterministically
    for (let t = 0; t < 120; t++) step(sim, inputs);
    const d = Math.hypot(sim.ent.posX[b] - sim.ent.posX[a], sim.ent.posY[b] - sim.ent.posY[a]);
    expect(d).toBeGreaterThan(UNIT_SEPARATION_RADIUS * 0.8);
  });
});

describe("determinism with units in play", () => {
  it("mirrored runs stay hash-identical through purchases and a breach", () => {
    const make = (): { sim: SimState; ins: ReturnType<typeof createTickInputs> } => ({
      sim: openSim(),
      ins: createTickInputs(),
    });
    const A = make();
    const B = make();
    for (const run of [A, B]) {
      run.sim.ent.posX[0] = 6;
      run.sim.ent.posY[0] = 14;
      run.sim.ent.posX[1] = 54;
      run.sim.ent.posY[1] = 14; // near own ground console? (team 1's is at (54,14))
    }
    for (let t = 0; t < 900; t++) {
      for (const run of [A, B]) {
        const btn = t % 60 === 0 ? BUTTON_INTERACT : 0;
        run.ins.players[0].buttons = btn;
        run.ins.players[1].buttons = btn;
        step(run.sim, run.ins);
      }
      expect(hash(A.sim)).toBe(hash(B.sim));
    }
  });
});
