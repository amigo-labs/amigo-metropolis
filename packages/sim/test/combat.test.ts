// Weapons, damage, death, respawn and points on a flat synthetic arena with
// one dummy turret spot placed in primary range of player 0's spawn.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  ARCHETYPE_MAX_HP,
  AVATAR_AMMO_HEAVY,
  AVATAR_HP,
  DUMMY_RESPAWN_TICKS,
  HEAVY_COOLDOWN_TICKS,
  POINTS_KILL_TURRET,
  PRIMARY_COOLDOWN_TICKS,
  PRIMARY_DAMAGE,
  RESPAWN_TICKS,
  TURRET_DAMAGE,
} from "../src/balance";
import { countAlive } from "../src/entities";
import { EV_DEATH, EV_RESPAWN, EVENT_STRIDE } from "../src/events";
import { BUTTON_FIRE1, BUTTON_FIRE2, createTickInputs } from "../src/inputs";
import { loadMapFromJson, type MapJson } from "../src/map";
import { createSim, type SimState, step } from "../src/sim";

// Flat 16×16 grid, 4 m cells. P0 spawns at (20,30); dummy spot at (50,30) —
// out of primary range (40) until P0 walks a few meters east. P1 spawns far
// north to stay out of every engagement.
function flatArena(dummies: number[][]): MapJson {
  const size = 16;
  const heights: number[][] = [];
  const water: string[] = [];
  for (let j = 0; j < size; j++) {
    heights.push(new Array(size).fill(0));
    water.push("0".repeat(size));
  }
  return {
    id: "flat-test",
    size,
    cellSize: 4,
    waterLevel: -10,
    heights,
    water,
    spawns: [
      { x: 20, y: 30, yaw: 0 },
      { x: 30, y: 58, yaw: 0 },
    ],
    basePlots: [
      { x: 20, y: 30, radius: 6 },
      { x: 30, y: 58, radius: 6 },
    ],
    // Minimal bases: pads mirror the plots (ammo refill semantics), gates in
    // far corners, no ring turrets — the dummy spot stays the only hostile.
    bases: [
      {
        gate: { x: 2, y: 2, radius: 2 },
        core: [14, 30],
        groundConsole: [20, 24],
        airConsole: [20, 36],
        pad: { x: 20, y: 30, radius: 6 },
        turrets: [],
      },
      {
        gate: { x: 58, y: 58, radius: 2 },
        core: [36, 58],
        groundConsole: [30, 52],
        airConsole: [24, 58],
        pad: { x: 30, y: 58, radius: 6 },
        turrets: [],
      },
    ],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: dummies,
  };
}

const inputs = createTickInputs();
const p0 = inputs.players[0];

function reset(): void {
  for (const p of inputs.players) {
    p.moveX = 0;
    p.moveY = 0;
    p.aimX = 0;
    p.aimY = 0;
    p.buttons = 0;
  }
}

function simWithDummy(): SimState {
  return createSim(loadMapFromJson(flatArena([[50, 30]])), 7);
}

function eventTypes(sim: SimState): number[] {
  const out: number[] = [];
  for (let i = 0; i < sim.events.count; i++) {
    out.push(sim.events.data[i * EVENT_STRIDE]);
  }
  return out;
}

describe("primary hitscan", () => {
  it("hits the dummy in range, paced by the cooldown", () => {
    reset();
    const sim = simWithDummy();
    const dummy = sim.dummyEntity[0];
    expect(sim.ent.archetype[dummy]).toBe(ARCHETYPE.TURRET);
    p0.aimX = 127; // aim due east at the dummy
    p0.buttons = BUTTON_FIRE1;
    for (let i = 0; i < PRIMARY_COOLDOWN_TICKS * 4; i++) step(sim, inputs);
    // 30 m away, in range: 4 shots in 4 cooldown windows.
    expect(sim.ent.hp[dummy]).toBe(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET] - 4 * PRIMARY_DAMAGE);
  });

  it("misses when aiming away", () => {
    reset();
    const sim = simWithDummy();
    const dummy = sim.dummyEntity[0];
    p0.aimY = 127; // aim north, dummy is east
    p0.buttons = BUTTON_FIRE1;
    for (let i = 0; i < 30; i++) step(sim, inputs);
    expect(sim.ent.hp[dummy]).toBe(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET]);
  });

  it("killing the dummy awards turret points and schedules its respawn", () => {
    reset();
    const sim = simWithDummy();
    p0.aimX = 127;
    p0.buttons = BUTTON_FIRE1;
    const need = Math.ceil(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET] / PRIMARY_DAMAGE);
    let died = false;
    for (let i = 0; i < need * PRIMARY_COOLDOWN_TICKS + 10; i++) {
      step(sim, inputs);
      if (eventTypes(sim).includes(EV_DEATH)) died = true;
      if (sim.dummyEntity[0] === -1) break;
    }
    expect(died).toBe(true);
    expect(sim.dummyEntity[0]).toBe(-1);
    expect(sim.points[0]).toBe(POINTS_KILL_TURRET);
    expect(sim.dummyRespawn[0]).toBeGreaterThan(0);

    // Stop firing; the dummy respawns after its timer with full hp.
    p0.buttons = 0;
    for (let i = 0; i < DUMMY_RESPAWN_TICKS + 1; i++) step(sim, inputs);
    expect(sim.dummyEntity[0]).toBeGreaterThanOrEqual(0);
    expect(sim.ent.hp[sim.dummyEntity[0]]).toBe(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET]);
  });
});

describe("heavy projectile", () => {
  it("flies, explodes on the dummy, and consumes ammo", () => {
    reset();
    const sim = simWithDummy();
    const dummy = sim.dummyEntity[0];
    p0.aimX = 127;
    p0.buttons = BUTTON_FIRE2;
    step(sim, inputs);
    expect(sim.ent.ammoA[0]).toBe(AVATAR_AMMO_HEAVY - 1); // refill ran before the shot
    expect(countAlive(sim.ent)).toBe(4); // 2 avatars + dummy + projectile
    step(sim, inputs);
    expect(sim.ent.ammoA[0]).toBe(AVATAR_AMMO_HEAVY); // base plot refills next tick
    // One heavy (60) does not kill the 100 hp dummy; wait for impact.
    p0.buttons = 0;
    for (let i = 0; i < 60; i++) step(sim, inputs);
    expect(sim.ent.hp[dummy]).toBe(40);
    expect(countAlive(sim.ent)).toBe(3); // projectile gone
  });

  it("ammo depletes away from the base plot and respects the cooldown", () => {
    reset();
    const sim = simWithDummy();
    // Walk off the plot first (10 m north-east), then fire twice.
    p0.moveX = 127;
    for (let i = 0; i < 75; i++) step(sim, inputs); // 12.5 m east
    p0.moveX = 0;
    p0.aimX = 127;
    p0.buttons = BUTTON_FIRE2;
    step(sim, inputs);
    expect(sim.ent.ammoA[0]).toBe(AVATAR_AMMO_HEAVY - 1);
    step(sim, inputs); // cooldown blocks the second shot
    expect(sim.ent.ammoA[0]).toBe(AVATAR_AMMO_HEAVY - 1);
    for (let i = 0; i < HEAVY_COOLDOWN_TICKS; i++) step(sim, inputs);
    expect(sim.ent.ammoA[0]).toBe(AVATAR_AMMO_HEAVY - 2);
  });
});

describe("dummy turret retaliation, death and respawn", () => {
  it("turret damages the avatar in range; avatar dies and respawns", () => {
    reset();
    const sim = simWithDummy();
    // Walk into turret range (28) and stand there.
    p0.moveX = 127;
    for (let i = 0; i < 60; i++) step(sim, inputs); // x ≈ 30, 20 m from dummy
    p0.moveX = 0;
    let sawDamage = false;
    let deathTick = -1;
    const maxTicks = Math.ceil(AVATAR_HP / TURRET_DAMAGE + 2) * 30;
    for (let i = 0; i < maxTicks; i++) {
      step(sim, inputs);
      if (sim.avatarId[0] === -1) {
        deathTick = sim.tick;
        break;
      }
      if (sim.ent.hp[sim.avatarId[0]] < AVATAR_HP) sawDamage = true;
    }
    expect(sawDamage).toBe(true);
    expect(deathTick).toBeGreaterThan(0);
    // systemSpawning runs after damage/death in the same tick, so the timer
    // has already counted down once.
    expect(sim.respawnTimer[0]).toBe(RESPAWN_TICKS - 1);
    expect(sim.points[1]).toBe(0); // dummies never earn players points

    // Respawn: full hp, back at the spawn point, EV_RESPAWN fired.
    let respawned = false;
    for (let i = 0; i < RESPAWN_TICKS; i++) {
      step(sim, inputs);
      if (eventTypes(sim).includes(EV_RESPAWN)) respawned = true;
    }
    expect(respawned).toBe(true);
    const id = sim.avatarId[0];
    expect(id).toBeGreaterThanOrEqual(0);
    expect(sim.ent.hp[id]).toBe(AVATAR_HP);
    expect(sim.ent.posX[id]).toBe(20);
  });
});

describe("combat determinism", () => {
  it("two sims stay hash-identical through kills and respawns", async () => {
    const { hash } = await import("../src/sim");
    reset();
    const a = simWithDummy();
    const b = simWithDummy();
    const ins = createTickInputs();
    for (let t = 0; t < 900; t++) {
      ins.players[0].moveX = t % 90 < 45 ? 127 : -40;
      ins.players[0].aimX = 127;
      ins.players[0].buttons = (t % 3 === 0 ? BUTTON_FIRE1 : 0) | (t % 50 === 0 ? BUTTON_FIRE2 : 0);
      step(a, ins);
      step(b, ins);
      expect(hash(a)).toBe(hash(b));
    }
  });
});
