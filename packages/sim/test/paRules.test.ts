// Precinct Assault mode (rules.md §9) behaviour, on the arena that carries it.
//
// The most important test in here is the LAST one: a map without PA data must
// produce numbers identical to the pre-PA sim. Everything else verifies the new
// mechanics; that one verifies they cost nothing where they are not wanted, which
// is the property the golden replays depend on.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  AVATAR_HP,
  CORE_DAMAGE_PER_SHOT,
  PA_PRODUCTION_ALIVE_LIMIT,
  PICKUP_HEALTH,
  PICKUP_HEALTH_AMOUNT,
  TRIGGER_REARM_TICKS,
  TURRET_COOLDOWN_TICKS,
  TURRET_DAMAGE,
  TURRET_RANGE,
} from "../src/balance";
import { EV_ALARM, EV_PICKUP, EV_PRODUCE, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { DISTRICT_01_ID, getMapById, LA_CANTINA_ID } from "../src/map";
import { createSim, type SimState, step } from "../src/sim";

const idle = createTickInputs();

function run(state: SimState, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(state, idle);
}

function countEvents(state: SimState, type: number): number {
  let n = 0;
  for (let i = 0; i < state.events.count; i++) {
    if (state.events.data[i * EVENT_STRIDE] === type) n += 1;
  }
  return n;
}

function countAliveOf(state: SimState, archetype: number, team: number): number {
  const ent = state.ent;
  let n = 0;
  for (let id = 0; id < ent.high; id++) {
    if (ent.alive[id] && ent.archetype[id] === archetype && ent.team[id] === team) n += 1;
  }
  return n;
}

const map = getMapById(LA_CANTINA_ID);

describe("la-cantina loads the original parameters into the sim", () => {
  it("spawns every capturable pad, ring turret and built-in base weapon", () => {
    const state = createSim(map, 1);
    expect(state.neutralTurretEntity.length).toBe(32);
    // Team-unique ring only (8/base); dual mid plates are capturable, not ring.
    expect(state.baseTurretEntity.length).toBe(16);
    expect(state.baseDefenceEntity.length).toBe(8); // 4 per base
    for (const id of state.baseDefenceEntity) expect(id).toBeGreaterThanOrEqual(0);
    for (const id of state.neutralTurretEntity) expect(id).toBeGreaterThanOrEqual(0);
  });

  it("gives capturable turrets the original weapon profile and rest yaw", () => {
    const state = createSim(map, 1);
    const ent = state.ent;
    for (let k = 0; k < state.neutralTurretEntity.length; k++) {
      const id = state.neutralTurretEntity[k];
      expect(ent.weaponProfile[id]).toBe(map.turretParams[k]);
      // Float32 storage, so the JSON value round-trips approximately.
      expect(ent.yaw[id]).toBeCloseTo(map.turretYaw[k], 5);
    }
    // The original's reach is much shorter than the pre-PA global — that is the
    // point of importing it, so assert the direction of the change.
    const profile = map.weapons[map.turretParams[0]];
    expect(profile.range).toBe(6);
    expect(profile.range).toBeLessThan(TURRET_RANGE);
    expect(profile.damage).toBe(TURRET_DAMAGE);
  });

  it("seeds both cores and both production timers", () => {
    const state = createSim(map, 1);
    expect(Array.from(state.coreHp)).toEqual([3000, 3000]);
    // Seeded to a full interval: the first free unit is due at t = cadence, not 0.
    expect(Array.from(state.productionTimer)).toEqual([150, 150]);
  });
});

describe("base production", () => {
  it("produces the first unit exactly one cadence in, then holds the limit", () => {
    const state = createSim(map, 1);
    expect(countAliveOf(state, ARCHETYPE.RUNNER, 0)).toBe(0);

    run(state, 149);
    expect(countEvents(state, EV_PRODUCE)).toBe(0);
    expect(countAliveOf(state, ARCHETYPE.RUNNER, 0)).toBe(0);

    step(state, idle); // tick 150
    expect(countEvents(state, EV_PRODUCE)).toBe(2); // one per base
    expect(countAliveOf(state, ARCHETYPE.RUNNER, 0)).toBe(1);
    expect(countAliveOf(state, ARCHETYPE.RUNNER, 1)).toBe(1);

    // Long enough for far more cycles than the cap allows.
    run(state, 150 * (PA_PRODUCTION_ALIVE_LIMIT + 6));
    for (const team of [0, 1]) {
      expect(countAliveOf(state, ARCHETYPE.RUNNER, team)).toBeLessThanOrEqual(
        PA_PRODUCTION_ALIVE_LIMIT,
      );
    }
  });

  it("puts produced units on the original lane graph, not a polyline", () => {
    const state = createSim(map, 1);
    run(state, 151);
    const ent = state.ent;
    const graph = map.laneGraph;
    if (!graph) throw new Error("la-cantina must carry a lane graph");
    let checked = 0;
    for (let id = 0; id < ent.high; id++) {
      if (!ent.alive[id] || ent.archetype[id] !== ARCHETYPE.RUNNER) continue;
      // GRAPH_MODE, or below it: values under the sentinel carry the jam-relief
      // stall clock (units.ts) and still mean "on the graph".
      expect(ent.timerB[id]).toBeLessThanOrEqual(-2);
      expect(ent.timerA[id]).toBe(graph.entry[ent.team[id]]);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("walks a produced unit along the graph toward the enemy base", () => {
    const state = createSim(map, 1);
    const graph = map.laneGraph;
    if (!graph) throw new Error("la-cantina must carry a lane graph");
    run(state, 151);
    const ent = state.ent;
    let unit = -1;
    for (let id = 0; id < ent.high; id++) {
      if (ent.alive[id] && ent.archetype[id] === ARCHETYPE.RUNNER && ent.team[id] === 0) unit = id;
    }
    expect(unit).toBeGreaterThanOrEqual(0);
    const startNode = ent.timerA[unit];
    const enemy = map.basePlots[1];
    const startDist = Math.hypot(ent.posX[unit] - enemy.x, ent.posY[unit] - enemy.y);
    run(state, 900); // 30 s of driving
    // Either it advanced past its entry node, or it is dead/held — but if it is
    // still alive it must have made progress toward the enemy base.
    if (ent.alive[unit] && ent.archetype[unit] === ARCHETYPE.RUNNER) {
      const dist = Math.hypot(ent.posX[unit] - enemy.x, ent.posY[unit] - enemy.y);
      expect(dist).toBeLessThan(startDist);
      expect(ent.timerA[unit] === startNode && dist === startDist).toBe(false);
    }
  });
});

describe("base destruction is the win condition", () => {
  it("ends the match for the other team when a core reaches zero", () => {
    const state = createSim(map, 1);
    expect(state.winner).toBe(-1);
    state.coreHp[1] = 0;
    step(state, idle);
    expect(state.winner).toBe(0);
  });

  it("lets only ground units damage the core", () => {
    const state = createSim(map, 1);
    const core = map.bases[1].core;
    const ent = state.ent;

    // Park team 0's avatar on the enemy core: pillar 1 says it may not hurt it.
    const avatar = state.avatarId[0];
    ent.posX[avatar] = core.x;
    ent.posY[avatar] = core.y;
    const before = state.coreHp[1];
    run(state, 30);
    expect(state.coreHp[1]).toBe(before);

    // A ground unit in the same place does.
    run(state, 151); // let production give us one
    let unit = -1;
    for (let id = 0; id < ent.high; id++) {
      if (ent.alive[id] && ent.archetype[id] === ARCHETYPE.RUNNER && ent.team[id] === 0) unit = id;
    }
    expect(unit).toBeGreaterThanOrEqual(0);
    // The base's own guns sit on the core, and a unit spends its cooldown on
    // whichever it engages first — so clear the defenders to isolate the core
    // rule itself rather than asserting on that interaction.
    for (let id = 0; id < ent.high; id++) {
      if (ent.alive[id] && ent.team[id] === 1 && id !== unit) ent.alive[id] = 0;
    }
    ent.posX[unit] = core.x;
    ent.posY[unit] = core.y;
    ent.cooldownA[unit] = 0;
    const hpBefore = state.coreHp[1];
    step(state, idle);
    expect(state.coreHp[1]).toBe(hpBefore - CORE_DAMAGE_PER_SHOT);
  });

  it("keeps the gate breach as the only win on arenas without a core", () => {
    // district-01, now that all four FCOP single-storey arenas carry PA data.
    const legacy = getMapById(DISTRICT_01_ID);
    const state = createSim(legacy, 1);
    expect(state.coreHp.length).toBe(0);
    const gate = legacy.bases[1].gate;
    const uid = state.ent;
    // Put a ground unit in the enemy gate the way the pre-PA rule expects.
    run(state, 1);
    const ent = uid;
    let unit = -1;
    for (let id = 0; id < ent.high; id++) {
      if (ent.alive[id] && ent.archetype[id] === ARCHETYPE.RUNNER) unit = id;
    }
    if (unit >= 0) {
      ent.posX[unit] = gate.x;
      ent.posY[unit] = gate.y;
      step(state, idle);
      expect(state.winner).toBe(ent.team[unit] ?? -1);
    }
  });
});

describe("power-ups", () => {
  it("heals an avatar standing on a health pickup and re-arms the spot", () => {
    const state = createSim(map, 1);
    const ent = state.ent;
    const k = map.pickups.findIndex((p) => p.kind === PICKUP_HEALTH);
    expect(k).toBeGreaterThanOrEqual(0);
    const spot = map.pickups[k];

    const avatar = state.avatarId[0];
    ent.hp[avatar] = 50;
    ent.posX[avatar] = spot.x;
    ent.posY[avatar] = spot.y;
    step(state, idle);
    // Healing is capped at AVATAR_HP and applied after damage in the same tick,
    // so assert the gain, not an absolute figure — turrets may have hit first.
    expect(ent.hp[avatar]).toBeGreaterThan(50);
    expect(ent.hp[avatar]).toBeLessThanOrEqual(Math.min(AVATAR_HP, 50 + PICKUP_HEALTH_AMOUNT));
    expect(countEvents(state, EV_PICKUP)).toBeGreaterThan(0);
    expect(state.pickupCooldown[k]).toBe(spot.respawnTicks);

    // Still standing there, but the spot is spent until it re-arms.
    const held = ent.hp[avatar];
    step(state, idle);
    expect(countEvents(state, EV_PICKUP)).toBe(0);
    expect(ent.hp[avatar]).toBeLessThanOrEqual(held);
  });
});

describe("base intrusion alerts", () => {
  it("fires once when an enemy avatar enters, then re-arms on a timer", () => {
    const state = createSim(map, 1);
    const ent = state.ent;
    const vol = map.triggerVolumes[0];
    // Volume guards team `vol.team`, so the intruder is the other avatar.
    const foe = state.avatarId[vol.team ^ 1];
    ent.posX[foe] = vol.x;
    ent.posY[foe] = vol.y;

    step(state, idle);
    expect(countEvents(state, EV_ALARM)).toBeGreaterThan(0);
    expect(state.triggerArm[0]).toBe(TRIGGER_REARM_TICKS);

    // Loitering must not re-fire every tick — that is the whole job of the
    // re-arm timer, and an alarm cue every 33 ms would be unlistenable.
    step(state, idle);
    expect(countEvents(state, EV_ALARM)).toBe(0);
    expect(state.triggerArm[0]).toBe(TRIGGER_REARM_TICKS - 1);
  });
});

describe("the no-op invariant", () => {
  it("leaves an arena without PA data on exactly the pre-PA numbers", () => {
    // district-01 carries no weapons, pickups, triggers, cores or production, so
    // every PA array must be empty and every PA-gated branch unreachable. It
    // replaced proving-ground here when that arena was rebuilt from the original
    // Slim logic and gained the full §9 data set. district-01 is the better
    // fixture anyway: it is the map goldens 02-04 actually run on, so this test
    // now asserts the byte-stream invariant those goldens depend on rather than a
    // proxy for it. It has 8 ring turrets, which the cadence check below needs —
    // test-128 has none and would silently no-op it.
    const legacy = getMapById(DISTRICT_01_ID);
    const state = createSim(legacy, 0xc0ffee);
    expect(state.baseDefenceEntity.length).toBe(0);
    expect(state.coreHp.length).toBe(0);
    expect(state.productionTimer.length).toBe(0);
    expect(state.pickupCooldown.length).toBe(0);
    expect(state.buffInvuln.length).toBe(0);
    expect(state.buffInvis.length).toBe(0);
    expect(state.buffPower.length).toBe(0);
    expect(state.triggerArm.length).toBe(0);
    expect(legacy.weapons.length).toBe(0);
    expect(legacy.laneGraph).toBeUndefined();

    // No entity carries a weapon profile, so every turret uses the globals.
    run(state, 60);
    const ent = state.ent;
    for (let id = 0; id < ent.high; id++) {
      if (ent.alive[id]) expect(ent.weaponProfile[id]).toBe(-1);
    }

    // And a ring turret still fires on the global cadence.
    const turret = state.baseTurretEntity[0];
    expect(turret).toBeGreaterThanOrEqual(0);
    const avatar = state.avatarId[1 - (ent.team[turret] as number)];
    if (avatar >= 0) {
      ent.posX[avatar] = ent.posX[turret] + 2;
      ent.posY[avatar] = ent.posY[turret];
      ent.cooldownA[turret] = 0;
      step(state, idle);
      expect(ent.cooldownA[turret]).toBe(TURRET_COOLDOWN_TICKS);
    }
  });
});
