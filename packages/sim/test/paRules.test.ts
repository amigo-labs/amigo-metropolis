// Precinct Assault mode (rules.md §9) behaviour, on the arena that carries it.
//
// The most important test in here is the LAST one: a map without PA data must
// produce numbers identical to the pre-PA sim. Everything else verifies the new
// mechanics; that one verifies they cost nothing where they are not wanted, which
// is the property the golden replays depend on.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  ARCHETYPE_RADIUS,
  AVATAR_HP,
  DREADNOUGHT_GUN_DAMAGE,
  DREADNOUGHT_GUN_REFIRE_TICKS,
  MATCH_OUTRO_TICKS,
  PICKUP_HEALTH,
  PICKUP_HEALTH_AMOUNT,
  TRIGGER_REARM_TICKS,
  TURRET_COOLDOWN_TICKS,
  TURRET_DAMAGE,
  TURRET_RANGE,
} from "../src/balance";
import { EV_ALARM, EV_BREACH, EV_HIT, EV_PICKUP, EV_SHOT, EVENT_STRIDE } from "../src/events";
import { BUTTON_INTERACT, createTickInputs } from "../src/inputs";
import { DISTRICT_01_ID, getMapById, LA_CANTINA_ID } from "../src/map";
import { createSim, type SimState, spawnUnit, step } from "../src/sim";

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
  it("spawns every capturable pad and ring turret, and no guns on the base", () => {
    const state = createSim(map, 1);
    expect(state.neutralTurretEntity.length).toBe(32);
    // Team-unique ring only (8/base); dual mid plates are capturable, not ring.
    expect(state.baseTurretEntity.length).toBe(16);
    for (const id of state.neutralTurretEntity) expect(id).toBeGreaterThanOrEqual(0);
    // The four "built-in base guns" this used to spawn on each core were the
    // Dreadnought's hull guns (fcop-fidelity.md I6): every turret alive at the
    // start is a ring turret or a capturable pad.
    const ent = state.ent;
    let turrets = 0;
    for (let id = 0; id < ent.high; id++) {
      if (ent.alive[id] && ent.archetype[id] === ARCHETYPE.TURRET) turrets += 1;
    }
    expect(turrets).toBe(16 + 32);
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
    expect(profile.range).toBe(12); // engage_range 6144 / 512 (fcop-re Q1)
    expect(profile.range).toBeLessThan(TURRET_RANGE);
    expect(profile.damage).toBe(TURRET_DAMAGE);
  });

  it("carries each side's Dreadnought as its Juggernaut", () => {
    // fcop-re/ranges-turrets-capture.md top + Q4: the type-28 record is the
    // Dreadnought — 3000 HP, four hull guns of weapon 3 (100 dmg / 2.0 s / 12 m),
    // spawning at node 0 of its Cnet by the HQ.
    for (const team of [0, 1]) {
      const j = map.bases[team].juggernaut;
      if (!j) throw new Error("la-cantina must carry its Dreadnought");
      expect(j.hp).toBe(3000);
      expect(j.guns).toBe(4);
      const w = map.weapons[j.weapon];
      expect(w.range).toBe(12);
      expect(w.damage).toBe(DREADNOUGHT_GUN_DAMAGE);
      expect(w.delay).toBe(DREADNOUGHT_GUN_REFIRE_TICKS);
      // Next to its road's start (enrichArena validates the beeline).
      const graph = map.laneGraph;
      if (!graph) throw new Error("la-cantina must carry a lane graph");
      const entry = graph.nodes[graph.entry[team]];
      expect(Math.hypot(entry.x - j.x, entry.y - j.y)).toBeLessThan(8);
    }
  });
});

describe("no free production (fcop-fidelity.md I7)", () => {
  it("puts nothing on the field that nobody bought", () => {
    // The original's tank, jet and Dreadnought spawners are shut in PA; only a
    // purchase spawns a unit. The "1 Runner per 5 s" this pinned was the
    // Dreadnought spawner's period.
    const state = createSim(map, 1);
    run(state, 150 * 4);
    for (const team of [0, 1]) {
      for (const a of [ARCHETYPE.RUNNER, ARCHETYPE.GUARDIAN, ARCHETYPE.JUGGERNAUT]) {
        expect(countAliveOf(state, a, team)).toBe(0);
      }
    }
  });
});

describe("the Juggernaut is the original Dreadnought", () => {
  it("spawns at the Dreadnought record with its HP, not at the console", () => {
    const state = createSim(map, 1);
    const j = map.bases[0].juggernaut;
    if (!j) throw new Error("la-cantina must carry its Dreadnought");
    // A console purchase routes the spawn to the record (sim.ts systemBuy); the
    // unit itself takes the imported stats in spawnUnit.
    const id = spawnUnit(state, ARCHETYPE.JUGGERNAUT, 0, j.x, j.y);
    expect(state.ent.hp[id]).toBe(3000);
    expect(state.ent.weaponProfile[id]).toBe(j.weapon);
  });

  it("fires a volley of four 100-damage shots, then waits the refire", () => {
    const state = createSim(map, 1);
    const ent = state.ent;
    const j = map.bases[0].juggernaut;
    if (!j) throw new Error("la-cantina must carry its Dreadnought");
    const id = spawnUnit(state, ARCHETYPE.JUGGERNAUT, 0, j.x, j.y);
    // Put the enemy avatar 5 m off, in the open by the Dreadnought's spawn.
    const foe = state.avatarId[1];
    ent.posX[foe] = ent.posX[id] + 0.5;
    ent.posY[foe] = ent.posY[id] + 0.5;
    ent.hp[foe] = 100000;
    let shots = 0;
    let damage = 0;
    for (let t = 0; t < DREADNOUGHT_GUN_REFIRE_TICKS; t++) {
      ent.posX[foe] = ent.posX[id] + 0.5;
      ent.posY[foe] = ent.posY[id] + 0.5;
      step(state, idle);
      for (let i = 0; i < state.events.count; i++) {
        const o = i * EVENT_STRIDE;
        const type = state.events.data[o];
        if (type === EV_SHOT && state.events.data[o + 1] === id) shots += 1;
        if (type === EV_HIT && state.events.data[o + 1] === foe) damage += state.events.data[o + 3];
      }
    }
    // One volley inside one refire window: four guns, 100 each.
    expect(shots).toBe(4);
    expect(damage).toBeGreaterThanOrEqual(4 * DREADNOUGHT_GUN_DAMAGE);
  });
});

describe("the gate is the win condition (fcop-fidelity.md R1)", () => {
  /** Puts a fresh unit of `archetype` for `team` at (x, y) and steps once. */
  function placeAndStep(archetype: number, team: number, x: number, y: number): SimState {
    const state = createSim(map, 1);
    const id = spawnUnit(state, archetype, team, x, y);
    state.ent.posX[id] = x;
    state.ent.posY[id] = y;
    step(state, idle);
    return state;
  }

  it("is the imported gate trigger box, not the Dreadnought spot", () => {
    for (const team of [0, 1]) {
      const g = map.bases[team].gate;
      // Mp's gate trigger: 2457 x 1843 raw -> half-extents raw/1024 m.
      expect(g.halfW).toBeCloseTo(2.4, 2);
      expect(g.halfL).toBeCloseTo(1.8, 2);
      const core = map.bases[team].core;
      expect(Math.hypot(g.x - core.x, g.y - core.y)).toBeGreaterThan(5);
    }
  });

  it("an enemy Runner or Juggernaut inside decides it; the match ends one outro later", () => {
    for (const a of [ARCHETYPE.RUNNER, ARCHETYPE.JUGGERNAUT]) {
      const g = map.bases[1].gate;
      const state = placeAndStep(a, 0, g.x, g.y);
      expect(countEvents(state, EV_BREACH)).toBe(1);
      expect(state.winner).toBe(-1);
      expect(state.outroWinner).toBe(0);
      run(state, MATCH_OUTRO_TICKS);
      expect(state.winner).toBe(0);
    }
  });

  it("grows the box by the intruder's radius, and no further", () => {
    const g = map.bases[1].gate;
    const r = ARCHETYPE_RADIUS[ARCHETYPE.RUNNER];
    const inside = placeAndStep(ARCHETYPE.RUNNER, 0, g.x + g.halfW + r - 0.01, g.y);
    expect(inside.outroWinner).toBe(0);
    const outside = placeAndStep(ARCHETYPE.RUNNER, 0, g.x + g.halfW + r + 0.05, g.y);
    expect(outside.outroWinner).toBe(-1);
  });

  it("a jet or an avatar in the gate decides nothing", () => {
    const g = map.bases[1].gate;
    const jet = placeAndStep(ARCHETYPE.GUARDIAN, 0, g.x, g.y);
    expect(jet.outroWinner).toBe(-1);
    const state = createSim(map, 1);
    const avatar = state.avatarId[0];
    state.ent.posX[avatar] = g.x;
    state.ent.posY[avatar] = g.y;
    run(state, 5);
    expect(state.outroWinner).toBe(-1);
    expect(state.winner).toBe(-1);
  });

  it("the first breach decides; a later one during the outro changes nothing", () => {
    const g1 = map.bases[1].gate;
    const g0 = map.bases[0].gate;
    const state = placeAndStep(ARCHETYPE.RUNNER, 0, g1.x, g1.y);
    expect(state.outroWinner).toBe(0);
    const late = spawnUnit(state, ARCHETYPE.RUNNER, 1, g0.x, g0.y);
    state.ent.posX[late] = g0.x;
    state.ent.posY[late] = g0.y;
    run(state, MATCH_OUTRO_TICKS);
    expect(state.winner).toBe(0);
  });

  it("keeps the gate breach as the only win on the §1 arenas too", () => {
    // district-01: a circle gate, the same win test, the same outro.
    const legacy = getMapById(DISTRICT_01_ID);
    const state = createSim(legacy, 1);
    const gate = legacy.bases[1].gate;
    expect(gate.halfW).toBe(0);
    const unit = spawnUnit(state, ARCHETYPE.RUNNER, 0, gate.x, gate.y);
    state.ent.posX[unit] = gate.x;
    state.ent.posY[unit] = gate.y;
    state.ent.hp[unit] = 1000; // the ring's 28 m guns would kill it before the check
    step(state, idle);
    expect(state.outroWinner).toBe(0);
    run(state, MATCH_OUTRO_TICKS);
    expect(state.winner).toBe(0);
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

describe("capture on the imported arenas (fcop-fidelity.md R12)", () => {
  it("carries each mission's capture range: (raw + 1024) / 512 m", () => {
    // fcop-re/ranges-turrets-capture.md Q2: Mp/Conft/Ovmp 1024 -> 4.0 m,
    // Slim/Joke 1638 -> 5.2 m, Hk 1843 -> 5.6 m (before the capturer's radius).
    expect(getMapById("la-cantina").captureRange).toBe(4);
    expect(getMapById("urban-jungle").captureRange).toBe(4);
    expect(getMapById("venice-beach").captureRange).toBe(4);
    expect(getMapById("proving-ground").captureRange).toBeCloseTo(5.2, 2);
    expect(getMapById("bug-hunt").captureRange).toBeCloseTo(5.2, 2);
    expect(getMapById("hollywood-keys").captureRange).toBeCloseTo(5.6, 2);
    expect(getMapById(DISTRICT_01_ID).captureRange).toBe(0); // none: ours
  });

  it("takes a la-cantina pad on a press within 4.0 m + the avatar's radius", () => {
    const state = createSim(map, 1);
    const ent = state.ent;
    // Pad 1 (107.9, 114.9): the ground 4 m west of it is level with its base, so
    // the 3D distance is the flat one.
    const tid = state.neutralTurretEntity[1];
    const a = state.avatarId[0];
    const press = createTickInputs();
    const reach = 4 + ARCHETYPE_RADIUS[ARCHETYPE.AVATAR];
    const pressAt = (dx: number): void => {
      ent.posX[a] = ent.posX[tid] - dx;
      ent.posY[a] = ent.posY[tid];
      ent.height[a] = ent.height[tid];
      press.players[0].buttons = 0;
      step(state, press);
      ent.posX[a] = ent.posX[tid] - dx;
      ent.posY[a] = ent.posY[tid];
      ent.height[a] = ent.height[tid];
      press.players[0].buttons = BUTTON_INTERACT;
      step(state, press);
    };
    pressAt(reach + 0.05);
    expect(ent.ownerId[tid]).toBe(-1);
    pressAt(reach - 0.05);
    expect(ent.ownerId[tid]).toBe(0);
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
    // district-01 carries no weapons, pickups, triggers or Dreadnought, so
    // every PA array must be empty and every PA-gated branch unreachable. It
    // replaced proving-ground here when that arena was rebuilt from the original
    // Slim logic and gained the full §9 data set. district-01 is the better
    // fixture anyway: it is the map goldens 02-04 actually run on, so this test
    // now asserts the byte-stream invariant those goldens depend on rather than a
    // proxy for it. It has 8 ring turrets, which the cadence check below needs —
    // test-128 has none and would silently no-op it.
    const legacy = getMapById(DISTRICT_01_ID);
    const state = createSim(legacy, 0xc0ffee);
    expect(legacy.bases[0].juggernaut).toBeUndefined();
    expect(legacy.bases[1].juggernaut).toBeUndefined();
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
