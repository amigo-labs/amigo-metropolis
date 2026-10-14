// Weapons, damage, death, respawn and points on a flat synthetic arena with
// one dummy turret spot placed in primary range of player 0's spawn.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  ARCHETYPE_MAX_HP,
  AVATAR_HP,
  DUMMY_RESPAWN_TICKS,
  ORIGINAL_WEAPON_PROFILES,
  POINTS_AVATAR_DOWN,
  PROFILE_NEUTRAL_TURRET,
  RESPAWN_TICKS,
  STARTING_POINTS,
} from "../src/balance";
import { countAlive } from "../src/entities";
import { EV_DEATH, EV_RESPAWN, EVENT_STRIDE } from "../src/events";
import { BTN_BACK, BTN_FORWARD, BTN_GUN, BTN_HEAVY, createTickInputs } from "../src/inputs";
import { loadMapFromJson, type MapJson } from "../src/map";
import { createSim, type SimState, step } from "../src/sim";
import { GUNS, HEAVIES } from "../src/weapons";
import { face } from "./drive";

// The default kit's numbers (the original's records, weapons.ts): the Mini-Gun
// hits its lock for 1 every tick; Hell Fire 2000 is a 25-damage homing missile
// every 15 ticks.
const PRIMARY_DAMAGE = GUNS[0].a.damage;
const HEAVY_DAMAGE = HEAVIES[0].a.damage;
const HEAVY_AMMO = HEAVIES[0].a.ammoCap;
const HEAVY_COOLDOWN_TICKS = HEAVIES[0].cooldownTicks;

// Flat 16×16 grid, 4 m cells. P0 spawns at (20,30) facing east; the dummy spot
// is at (30,30), 10 m ahead: inside the X1-Alpha's 12 m lock, and inside the
// dummy's own 12 m (the original neutral turret's gun since SIM_VERSION 52; was
// Metropolis' 28 m instant hit). P1 spawns far north to stay out of every
// engagement.
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
    // Minimal bases: gates in far corners, no ring turrets — the dummy spot
    // stays the only hostile.
    bases: [
      {
        gate: { x: 2, y: 2, radius: 2 },
        core: [14, 30],
        groundConsole: [20, 24],
        airConsole: [20, 36],
        turrets: [],
      },
      {
        gate: { x: 58, y: 58, radius: 2 },
        core: [36, 58],
        groundConsole: [30, 52],
        airConsole: [24, 58],
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
  for (const p of inputs.players) p.buttons = 0;
}

function simWithDummy(): SimState {
  return createSim(loadMapFromJson(flatArena([[30, 30]])), 7);
}

function eventTypes(sim: SimState): number[] {
  const out: number[] = [];
  for (let i = 0; i < sim.events.count; i++) {
    out.push(sim.events.data[i * EVENT_STRIDE]);
  }
  return out;
}

describe("primary hitscan", () => {
  it("locks the dummy ahead and hits it on every tick the trigger is held", () => {
    reset();
    const sim = simWithDummy();
    const dummy = sim.dummyEntity[0];
    expect(sim.ent.archetype[dummy]).toBe(ARCHETYPE.TURRET);
    // The spawn faces due east, at the dummy: the Gun fires along the facing.
    p0.buttons = BTN_GUN;
    for (let i = 0; i < 20; i++) step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(dummy);
    expect(sim.ent.hp[dummy]).toBe(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET] - 20 * PRIMARY_DAMAGE);
  });

  it("hits nothing with the hull turned away: no lock, no damage", () => {
    reset();
    const sim = simWithDummy();
    const dummy = sim.dummyEntity[0];
    const a0 = sim.avatarId[0];
    face(sim, a0, Math.PI / 2); // facing north, the dummy is east
    p0.buttons = BTN_GUN;
    for (let i = 0; i < 30; i++) step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(-1);
    expect(sim.ent.hp[dummy]).toBe(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET]);
  });

  it("killing the neutral dummy awards nothing and schedules its respawn", () => {
    reset();
    const sim = simWithDummy();
    p0.buttons = BTN_GUN; // facing the dummy from the spawn
    const need = Math.ceil(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET] / PRIMARY_DAMAGE);
    let died = false;
    for (let i = 0; i < need + 10; i++) {
      step(sim, inputs);
      if (eventTypes(sim).includes(EV_DEATH)) died = true;
      if (sim.dummyEntity[0] === -1) break;
    }
    expect(died).toBe(true);
    expect(sim.dummyEntity[0]).toBe(-1);
    // Rules.md §3 pays for ENEMY-OWNED turrets only — a neutral dummy is
    // target practice, so the ledger still shows the starting balance.
    expect(sim.points[0]).toBe(STARTING_POINTS);
    expect(sim.dummyRespawn[0]).toBeGreaterThan(0);

    // Stop firing; the dummy respawns after its timer with full hp.
    p0.buttons = 0;
    for (let i = 0; i < DUMMY_RESPAWN_TICKS + 1; i++) step(sim, inputs);
    expect(sim.dummyEntity[0]).toBeGreaterThanOrEqual(0);
    expect(sim.ent.hp[sim.dummyEntity[0]]).toBe(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET]);
  });
});

describe("heavy projectile", () => {
  it("flies, homes onto the dummy, hits it, and consumes ammo", () => {
    reset();
    const sim = simWithDummy();
    const dummy = sim.dummyEntity[0];
    p0.buttons = BTN_HEAVY; // facing the dummy from the spawn
    step(sim, inputs);
    expect(sim.ent.ammoA[0]).toBe(HEAVY_AMMO - 1);
    expect(countAlive(sim.ent)).toBe(4); // 2 avatars + dummy + projectile
    step(sim, inputs);
    expect(sim.ent.ammoA[0]).toBe(HEAVY_AMMO - 1); // nothing refills it at a base
    // One Hell Fire (25) does not kill the 500 hp dummy; wait for impact.
    p0.buttons = 0;
    for (let i = 0; i < 60; i++) step(sim, inputs);
    expect(sim.ent.hp[dummy]).toBe(ARCHETYPE_MAX_HP[ARCHETYPE.TURRET] - HEAVY_DAMAGE);
    // The missile is gone (the dummy's own rounds may be in the air: it shoots
    // back since SIM_VERSION 52).
    let ours = 0;
    for (let id = 0; id < sim.ent.high; id++) {
      if (sim.ent.alive[id] && sim.ent.archetype[id] === ARCHETYPE.PROJECTILE) {
        if (sim.ent.ownerId[id] === 0) ours += 1;
      }
    }
    expect(ours).toBe(0);
  });

  it("ammo depletes away from the base plot and respects the cooldown", () => {
    reset();
    const sim = simWithDummy();
    // Walk off the plot first, then fire twice.
    p0.buttons = BTN_FORWARD; // the spawn faces east
    for (let i = 0; i < 75; i++) step(sim, inputs); // ~11.7 m east
    p0.buttons = BTN_HEAVY;
    step(sim, inputs);
    expect(sim.ent.ammoA[0]).toBe(HEAVY_AMMO - 1);
    step(sim, inputs); // cooldown blocks the second shot
    expect(sim.ent.ammoA[0]).toBe(HEAVY_AMMO - 1);
    for (let i = 0; i < HEAVY_COOLDOWN_TICKS; i++) step(sim, inputs);
    expect(sim.ent.ammoA[0]).toBe(HEAVY_AMMO - 2);
  });
});

describe("dummy turret retaliation, death and respawn", () => {
  it("turret damages the avatar in range; avatar dies and respawns", () => {
    reset();
    const sim = simWithDummy();
    // Walk toward the dummy and stand in its 12 m without firing back.
    p0.buttons = BTN_FORWARD; // the spawn faces east
    for (let i = 0; i < 45; i++) step(sim, inputs); // ~7 m east, 3 m from the dummy
    p0.buttons = 0;
    let sawDamage = false;
    let deathTick = -1;
    // The dummy's gun: the original neutral turret's, 100 a round every 61 ticks.
    const gun = ORIGINAL_WEAPON_PROFILES[PROFILE_NEUTRAL_TURRET];
    const maxTicks = Math.ceil(AVATAR_HP / gun.damage + 2) * Math.ceil(gun.refireUnits / 10 + 1);
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
    // Nothing is paid at the kill: there is no trickle, and a player's going-
    // down is paid by its own respawn (fcop-fidelity.md R3, R4).
    expect(sim.points[1]).toBe(STARTING_POINTS);

    // Respawn: full hp, back at the spawn point, EV_RESPAWN fired.
    let respawned = false;
    for (let i = 0; i < RESPAWN_TICKS && !respawned; i++) {
      step(sim, inputs);
      if (eventTypes(sim).includes(EV_RESPAWN)) respawned = true;
    }
    expect(respawned).toBe(true);
    // ...which pays the other side 10 and costs the downed side 10, floor 0.
    expect(sim.points[1]).toBe(STARTING_POINTS + POINTS_AVATAR_DOWN);
    expect(sim.points[0]).toBe(Math.max(STARTING_POINTS - POINTS_AVATAR_DOWN, 0));
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
      // East toward the dummy and back west, hull facing it throughout.
      ins.players[0].buttons =
        (t % 90 < 45 ? BTN_FORWARD : BTN_BACK) |
        (t % 3 === 0 ? BTN_GUN : 0) |
        (t % 50 === 0 ? BTN_HEAVY : 0);
      step(a, ins);
      step(b, ins);
      expect(hash(a)).toBe(hash(b));
    }
  });
});
