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
  CFUN_DELTA_PER_TICK,
  COST_JUGGERNAUT,
  COST_RUNNER,
  GUARDIAN_LEASH_X,
  GUARDIAN_LEASH_Y,
  MATCH_OUTRO_TICKS,
  POINTS_UNIT_DIES,
  ROUTE_TOP_SPEED,
  RUNNER_ALIVE_LIMIT,
  STARTING_POINTS,
  UNIT_SEPARATION_RADIUS,
} from "../src/balance";
import { EV_BREACH, EV_PURCHASE, EV_PURCHASE_REFUSED, EVENT_STRIDE } from "../src/events";
import { BTN_ACTION, BTN_FORWARD, BTN_HEAVY, createTickInputs } from "../src/inputs";
import { loadMapFromJson, type MapJson } from "../src/map";
import {
  createSim,
  hash,
  QUEUE_BASE_JETS,
  QUEUE_BASE_TANKS,
  type SimState,
  spawnUnit,
  step,
} from "../src/sim";

/** Mp's fn30 poll, in ticks: the heavy zones open at the first check that sees 50 points. */
const HEAVY_POLL = 150;

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
        turrets: ringTurrets.west,
        heavyZones: {
          juggernaut: { x: 12, y: 14, radius: 0.8 },
          fortress: { x: 12, y: 22, radius: 0.8 },
          pollPeriod: HEAVY_POLL * CFUN_DELTA_PER_TICK,
        },
        fortressSpawn: [6, 30],
      },
      {
        gate: { x: 46, y: 6, radius: 3 },
        core: [54, 6],
        groundConsole: [54, 14],
        airConsole: [54, 22],
        turrets: ringTurrets.east,
        heavyZones: {
          juggernaut: { x: 48, y: 14, radius: 0.8 },
          fortress: { x: 48, y: 22, radius: 0.8 },
          pollPeriod: HEAVY_POLL * CFUN_DELTA_PER_TICK,
        },
        fortressSpawn: [54, 30],
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
/** Base East's gate behind a ring of three, flanking the lane's last 10 m. */
const ringedSim = (): SimState =>
  createSim(
    loadMapFromJson(
      warzone({
        west: [],
        east: [
          [40, 12],
          [44, 1],
          [46, 14],
        ],
      }),
    ),
    42,
  );

const inputs = createTickInputs();

function reset(): void {
  for (const p of inputs.players) p.buttons = 0;
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

  it("ring turrets respawn 37.5 s after destruction (the original's, R16)", () => {
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
    // Both rings authored 8 m apart mid-map — well inside a turret's 12 m.
    const sim = createSim(loadMapFromJson(warzone({ west: [[26, 30]], east: [[34, 30]] })), 42);
    const w = sim.baseTurretEntity[0];
    const e = sim.baseTurretEntity[1];
    for (let t = 0; t < 300; t++) step(sim, inputs);
    expect(sim.ent.alive[w]).toBe(1);
    expect(sim.ent.alive[e]).toBe(1);
    expect(sim.ent.hp[w]).toBe(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET]);
    expect(sim.ent.hp[e]).toBe(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET]);
  });

  it("nothing at a base repairs a damaged avatar (the original has no pad)", () => {
    reset();
    const sim = openSim(); // avatar 0 spawns at its base
    sim.ent.hp[0] = AVATAR_HP - 100;
    for (let t = 0; t < 300; t++) step(sim, inputs);
    expect(sim.ent.hp[0]).toBe(AVATAR_HP - 100);
  });
});

describe("console purchases (one unit per press, rules.md §3)", () => {
  // The original's purchase spots answer the Action Key on the frame it goes down
  // and sell one unit per press (fcop-fidelity.md R17). Was: a 0.5 s hold per unit
  // (CONSOLE_HOLD_TICKS), with the button held buying one every 15 ticks.

  /** One tick with `buttons` down, then one with them released: one press. */
  function press(sim: SimState, buttons: number): void {
    inputs.players[0].buttons = buttons;
    step(sim, inputs);
  }
  function release(sim: SimState): void {
    inputs.players[0].buttons = 0;
    step(sim, inputs);
  }

  it("a press at the ground console buys one Runner; holding buys no more", () => {
    reset();
    const sim = openSim();
    sim.ent.posX[0] = 6;
    sim.ent.posY[0] = 14; // on the own ground console
    press(sim, BTN_ACTION);
    const bought = findEvents(sim, EV_PURCHASE);
    expect(bought.length).toBe(1);
    const [buyer, player, archetype] = bought[0];
    // Accepted at the press, by the buyer; the tank itself is queued (R18).
    expect(buyer).toBe(sim.avatarId[0]);
    expect(player).toBe(0);
    expect(archetype).toBe(ARCHETYPE.RUNNER);
    expect(sim.unitQueue[QUEUE_BASE_TANKS]).toBe(1);
    expect(sim.points[0]).toBe(STARTING_POINTS - COST_RUNNER);
    // Keeping the key down is not a press: nothing more, however long.
    for (let t = 0; t < 60; t++) {
      step(sim, inputs);
      expect(findEvents(sim, EV_PURCHASE).length).toBe(0);
    }
    expect(sim.points[0]).toBe(STARTING_POINTS - COST_RUNNER);
    // Release and press again: the next unit.
    release(sim);
    press(sim, BTN_ACTION);
    expect(findEvents(sim, EV_PURCHASE).length).toBe(1);
    expect(sim.points[0]).toBe(STARTING_POINTS - 2 * COST_RUNNER);
  });

  it("bought tanks come out of the tank spawner one a queue period; jets at once", () => {
    reset();
    const sim = openSim();
    const base = sim.map.bases[0];
    sim.points[0] = 20;
    sim.ent.posX[0] = 6;
    sim.ent.posY[0] = 14;
    for (let k = 0; k < 3; k++) {
      press(sim, BTN_ACTION);
      release(sim);
    }
    expect(sim.unitQueue[QUEUE_BASE_TANKS]).toBe(3);
    const out: number[] = [];
    for (let t = 0; t < 4 * base.queueTicks.tank; t++) {
      step(sim, inputs);
      for (let id = 0; id < sim.ent.high; id++) {
        if (!sim.ent.alive[id] || sim.ent.archetype[id] !== ARCHETYPE.RUNNER) continue;
        if (out.includes(id)) continue;
        out.push(id);
        expect(sim.ent.posX[id]).toBeCloseTo(base.tankSpawn.x, 0);
        expect(sim.ent.posY[id]).toBeCloseTo(base.tankSpawn.y, 0);
        out.push(-t - 1); // remember when
      }
    }
    const ticks = out.filter((v) => v < 0).map((v) => -v - 1);
    expect(ticks.length).toBe(3);
    expect(ticks[1] - ticks[0]).toBe(base.queueTicks.tank);
    expect(ticks[2] - ticks[1]).toBe(base.queueTicks.tank);
    expect(sim.unitQueue[QUEUE_BASE_TANKS]).toBe(0);
    // A jet does not queue.
    sim.ent.posX[0] = 6;
    sim.ent.posY[0] = 22;
    press(sim, BTN_ACTION);
    expect(findEvents(sim, EV_PURCHASE)[0][2]).toBe(ARCHETYPE.GUARDIAN);
    expect(sim.unitQueue[QUEUE_BASE_JETS]).toBe(0);
  });

  it("a queued tank counts against the 20 from its purchase", () => {
    reset();
    const sim = openSim();
    sim.points[0] = 100;
    for (let k = 0; k < RUNNER_ALIVE_LIMIT - 1; k++) spawnUnit(sim, ARCHETYPE.RUNNER, 0, 6, 40);
    sim.ent.posX[0] = 6;
    sim.ent.posY[0] = 14;
    press(sim, BTN_ACTION); // the 20th: queued
    expect(findEvents(sim, EV_PURCHASE).length).toBe(1);
    release(sim);
    press(sim, BTN_ACTION); // a 21st, with only 19 alive: refused
    expect(findEvents(sim, EV_PURCHASE_REFUSED)[0][2]).toBe(ARCHETYPE.RUNNER);
    expect(sim.points[0]).toBe(100 - COST_RUNNER);
  });

  it("every press is one unit: five taps, five Runners", () => {
    reset();
    const sim = openSim();
    sim.ent.posX[0] = 6;
    sim.ent.posY[0] = 14;
    let n = 0;
    for (let k = 0; k < 5; k++) {
      press(sim, BTN_ACTION);
      n += findEvents(sim, EV_PURCHASE).length;
      release(sim);
    }
    expect(n).toBe(5);
    expect(sim.points[0]).toBe(STARTING_POINTS - 5 * COST_RUNNER);
  });

  it("a press with the points short is refused out loud and charges nothing", () => {
    reset();
    const sim = openSim();
    sim.points[0] = 0;
    sim.ent.posX[0] = 6;
    sim.ent.posY[0] = 14;
    press(sim, BTN_ACTION);
    expect(findEvents(sim, EV_PURCHASE).length).toBe(0);
    const refused = findEvents(sim, EV_PURCHASE_REFUSED);
    expect(refused.length).toBe(1);
    expect(refused[0]).toEqual([sim.avatarId[0], 0, ARCHETYPE.RUNNER]);
    expect(sim.points[0]).toBe(0);
    // Held, it is not pressed again: one answer per press.
    step(sim, inputs);
    expect(findEvents(sim, EV_PURCHASE_REFUSED).length).toBe(0);
  });

  /** Runs the side's heavy-zone poll past its next check. */
  function openHeavy(sim: SimState): void {
    for (let t = 0; t < HEAVY_POLL + 1; t++) step(sim, inputs);
    expect(sim.heavyUnlocked[0]).toBe(1);
  }

  it("the Dreadnought zone sells one at its record; a press while it lives is refused", () => {
    reset();
    const sim = openSim();
    sim.points[0] = 120;
    openHeavy(sim); // the side holds 50: the poll opens the zones (R10)
    sim.ent.posX[0] = 12;
    sim.ent.posY[0] = 14; // in the Dreadnought zone
    release(sim);
    press(sim, BTN_ACTION);
    const first = findEvents(sim, EV_PURCHASE);
    expect(first[0][2]).toBe(ARCHETYPE.JUGGERNAUT);
    expect(sim.points[0]).toBe(120 - COST_JUGGERNAUT);
    const jugg = first[0][0];
    // The latch holds while it lives: the zone answers with the refuse sound.
    release(sim);
    press(sim, BTN_ACTION);
    expect(findEvents(sim, EV_PURCHASE).length).toBe(0);
    expect(findEvents(sim, EV_PURCHASE_REFUSED)[0][2]).toBe(ARCHETYPE.JUGGERNAUT);
    // …and its death reopens it.
    sim.ent.hp[jugg] = 0;
    release(sim);
    press(sim, BTN_ACTION);
    expect(findEvents(sim, EV_PURCHASE)[0][2]).toBe(ARCHETYPE.JUGGERNAUT);
  });

  it("the air console sells Guardians; the Fortress zone sells Fortresses at its spawner", () => {
    reset();
    const sim = openSim();
    sim.points[0] = 120;
    openHeavy(sim);
    sim.ent.posX[0] = 6;
    sim.ent.posY[0] = 22; // on the own air console
    release(sim);
    press(sim, BTN_ACTION);
    expect(findEvents(sim, EV_PURCHASE)[0][2]).toBe(ARCHETYPE.GUARDIAN);
    // Holding Heavy there buys nothing heavier: the heavy units have zones.
    release(sim);
    press(sim, BTN_ACTION | BTN_HEAVY);
    expect(findEvents(sim, EV_PURCHASE)[0][2]).toBe(ARCHETYPE.GUARDIAN);
    sim.ent.posX[0] = 12;
    sim.ent.posY[0] = 22; // the Fortress zone
    release(sim);
    press(sim, BTN_ACTION);
    const bought = findEvents(sim, EV_PURCHASE);
    expect(bought[0][2]).toBe(ARCHETYPE.FORTRESS);
    // At its spawner (it has flown one tick since).
    expect(
      Math.hypot(sim.ent.posX[bought[0][0]] - 6, sim.ent.posY[bought[0][0]] - 30),
    ).toBeLessThan(0.5);
  });

  it("a press away from any console buys nothing and refuses nothing", () => {
    reset();
    const sim = openSim();
    press(sim, BTN_ACTION); // at spawn, far from consoles
    expect(findEvents(sim, EV_PURCHASE).length).toBe(0);
    expect(findEvents(sim, EV_PURCHASE_REFUSED).length).toBe(0);
    expect(sim.points[0]).toBe(STARTING_POINTS);
  });
});

describe("runner lane-following and the win check", () => {
  it("a runner walks the lane into the enemy gate and wins the match", () => {
    reset();
    const sim = openSim();
    const id = spawnUnit(sim, ARCHETYPE.RUNNER, 0, 14, 6);
    expect(id).toBeGreaterThanOrEqual(0);
    let breachTick = -1;
    for (let t = 0; t < 800 + MATCH_OUTRO_TICKS; t++) {
      step(sim, inputs);
      if (breachTick < 0 && findEvents(sim, EV_BREACH).length > 0) breachTick = t;
      if (sim.winner >= 0) {
        // The match ends one outro after the breach (rules.md §1).
        expect(t - breachTick).toBe(MATCH_OUTRO_TICKS);
        break;
      }
    }
    expect(sim.winner).toBe(0);
    expect(breachTick).toBeGreaterThan(0);
    // 32 m of lane at the original's 1.98 m/s (ROUTE_TOP_SPEED on every arena
    // since SIM_VERSION 52; was 4 m/s), breach at gate radius 3 → ~29 m.
    const expected = Math.floor(29 / (ROUTE_TOP_SPEED / 30));
    expect(Math.abs(breachTick - expected)).toBeLessThan(30);
  });

  it("the breach emits EV_BREACH, plays the outro, then freezes the sim", () => {
    reset();
    const sim = openSim();
    spawnUnit(sim, ARCHETYPE.RUNNER, 1, 46, 6); // team 1 walks the lane west
    let sawBreach: number[][] = [];
    for (let t = 0; t < 800 && sawBreach.length === 0; t++) {
      step(sim, inputs);
      sawBreach = findEvents(sim, EV_BREACH);
    }
    expect(sawBreach.length).toBe(1);
    expect(sawBreach[0][1]).toBe(1);
    // The original's 1750-tick countdown (5.83 s): the match plays on, decided,
    // and only ends when it runs out. The avatar still moves meanwhile.
    expect(sim.winner).toBe(-1);
    expect(sim.outroTimer).toBe(MATCH_OUTRO_TICKS);
    expect(sim.outroWinner).toBe(1);
    inputs.players[0].buttons = BTN_FORWARD; // the spawn faces +X
    const xBefore = sim.ent.posX[0];
    for (let t = 0; t < MATCH_OUTRO_TICKS - 1; t++) step(sim, inputs);
    expect(sim.ent.posX[0]).not.toBe(xBefore);
    expect(sim.winner).toBe(-1);
    step(sim, inputs);
    expect(sim.winner).toBe(1);
    inputs.players[0].buttons = 0;
    // Frozen: avatars ignore input, only the tick advances the hash.
    const x0 = sim.ent.posX[0];
    inputs.players[0].buttons = BTN_FORWARD;
    const h1 = hash(sim);
    step(sim, inputs);
    expect(sim.ent.posX[0]).toBe(x0);
    expect(hash(sim)).not.toBe(h1); // tick still advances…
    expect(sim.winner).toBe(1); // …but the result stands
  });

  it("a lone runner dies to the enemy ring (escort matters)", () => {
    // The original's tank never stops to fight (SIM_VERSION 52 on the polyline
    // lanes too): it drives into the ring's fire at 1.98 m/s, shooting on the
    // move, and its 150 HP is two of the ring's 100-damage rounds. A ring of three
    // over the lane's last 10 m kills it short of the gate.
    reset();
    const sim = ringedSim();
    const id = spawnUnit(sim, ARCHETYPE.RUNNER, 0, 14, 6);
    for (let t = 0; t < 900; t++) step(sim, inputs);
    expect(sim.ent.alive[id]).toBe(0); // shredded on approach
    expect(sim.winner).toBe(-1);
    // The dead Runner pays the other side 1 (its death script, whoever killed
    // it — fcop-fidelity.md R6); there is no trickle on top.
    expect(sim.points[1]).toBe(STARTING_POINTS + POINTS_UNIT_DIES);
  });

  it("a juggernaut drives through the ring's fire, shooting on the move, and breaches", () => {
    // Was: it halted to kill the turret in its path (Metropolis' engage-in-path).
    // The original's Dreadnought never stops: 3000 HP against 100-damage rounds,
    // its four guns on whatever comes within 12 m.
    reset();
    const sim = ringedSim();
    const ring = [sim.baseTurretEntity[0], sim.baseTurretEntity[1], sim.baseTurretEntity[2]];
    const id = spawnUnit(sim, ARCHETYPE.JUGGERNAUT, 0, 14, 6);
    let hitRing = false;
    for (let t = 0; t < 1200 && sim.winner < 0; t++) {
      step(sim, inputs);
      for (const tid of ring) {
        if (!sim.ent.alive[tid] || sim.ent.hp[tid] < ARCHETYPE_MAX_HP[ARCHETYPE.TURRET]) {
          hitRing = true;
        }
      }
    }
    expect(hitRing).toBe(true); // its guns fired on the ring as it passed
    expect(sim.ent.alive[id]).toBe(1); // survived the run (3000 hp)
    expect(sim.ent.hp[id]).toBeLessThan(ARCHETYPE_MAX_HP[ARCHETYPE.JUGGERNAUT]); // under fire
    expect(sim.winner).toBe(0); // and breached
  });
});

describe("guardian behavior (the original's aircraft on every arena, SIM_VERSION 52)", () => {
  // Was Metropolis' patrol orbit of the own core (30 m) and an assault run to a
  // standoff from the enemy core. The original's jet patrols a leash about the
  // spawner it was built at — the base air console here, (6, 22) — and flies at
  // what it finds within 56 m (units.ts moveAircraft; unitTargeting.test.ts).
  it("patrols its leash about the base air console, at altitude", () => {
    reset();
    const sim = openSim();
    const id = spawnUnit(sim, ARCHETYPE.GUARDIAN, 0, 10, 10);
    for (let t = 0; t < 300; t++) {
      step(sim, inputs);
      expect(Math.abs(sim.ent.posX[id] - 6)).toBeLessThan(GUARDIAN_LEASH_X + 2);
      expect(Math.abs(sim.ent.posY[id] - 22)).toBeLessThan(GUARDIAN_LEASH_Y + 2);
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

  it("built far from its anchor, it flies back into its leash", () => {
    reset();
    const sim = openSim();
    const id = spawnUnit(sim, ARCHETYPE.GUARDIAN, 0, 54, 54); // ~57 m from (6, 22)
    for (let t = 0; t < 600; t++) step(sim, inputs);
    expect(Math.abs(sim.ent.posX[id] - 6)).toBeLessThan(GUARDIAN_LEASH_X);
    expect(Math.abs(sim.ent.posY[id] - 22)).toBeLessThan(GUARDIAN_LEASH_Y);
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
        // A press every 60 ticks: real purchases, one unit each.
        const btn = t % 60 === 0 ? BTN_ACTION : 0;
        run.ins.players[0].buttons = btn;
        run.ins.players[1].buttons = btn;
        step(run.sim, run.ins);
      }
      expect(hash(A.sim)).toBe(hash(B.sim));
    }
  });
});
