// Precinct Assault mode (rules.md §9) behaviour, on the arena that carries it.
//
// The LAST one checks district-01, which carries no PA data: since SIM_VERSION 52
// it loads the original's profiles, units and capture range on its own geometry
// (it used to pin that such a map stays on the pre-PA numbers).

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  ARCHETYPE_RADIUS,
  AVATAR_HP,
  CFUN_DELTA_PER_TICK,
  COST_RUNNER,
  DREADNOUGHT_GUN_DAMAGE,
  MATCH_OUTRO_TICKS,
  NEUTRAL_TURRET_RESPAWN_TICKS,
  ORIGINAL_CAPTURE_RANGE,
  OUTPOST_COST_MULTIPLIER,
  OUTPOST_TURRET_RESPAWN_TICKS,
  PICKUP_HEALTH,
  PICKUP_INVIS,
  PICKUP_INVIS_TICKS,
  PICKUP_INVULN_TICKS,
  PICKUP_POWER,
  PICKUP_POWER_HEAVY,
  PICKUP_POWER_SPECIAL,
  POINTS_TURRET_DIES,
  RESPAWN_TICKS,
  TRIGGER_REARM_TICKS,
  TURRET_ALERT_COOLDOWN_TICKS,
  UNIT_QUEUES,
} from "../src/balance";
import { segmentBlocked } from "../src/collision";
import {
  EV_ALARM,
  EV_BREACH,
  EV_HIT,
  EV_PICKUP,
  EV_PURCHASE,
  EV_SHOT,
  EV_TURRET_LOST,
  EV_TURRET_UNDER_FIRE,
  EVENT_STRIDE,
} from "../src/events";
import { BTN_ACTION, BTN_GUN, createTickInputs } from "../src/inputs";
import { getMapById, LA_CANTINA_ID, resolveHeight, TEST_MAP_ID } from "../src/map";
import {
  claimOutpostSlot,
  createSim,
  MODE_HOVER,
  MODE_WALKER,
  QUEUE_OUTPOST,
  type SimState,
  spawnUnit,
  step,
  TURRET_DEFENSE,
} from "../src/sim";
import { AIR_ANCHOR_MASK, nearestEnemyInRange } from "../src/units";
import { faceAlong } from "./drive";

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
/** Every arena imported from the original's Precinct Assault missions. */
const PA_ARENA_IDS = [
  "la-cantina",
  "urban-jungle",
  "proving-ground",
  "bug-hunt",
  "hollywood-keys",
  "venice-beach",
];

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
    // The original's reach: engage_range 6144 / 512 (fcop-re Q1) — against the
    // 28 m of Metropolis' retired global table.
    const profile = map.weapons[map.turretParams[0]];
    expect(profile.range).toBe(12);
    // Weapon 3 of the mission's catalogue (fcop-fidelity.md W3; Q3): 100 damage,
    // 601 engine units between rounds, a 7.62 m/s lead-aimed round flying 12 m,
    // fired only within 22.5° of the barrel; re-search every 2.0 s.
    expect(profile.damage).toBe(100);
    expect(profile.refireUnits).toBe(601);
    expect(profile.searchUnits).toBe(601);
    expect(profile.speed).toBeCloseTo(7.617, 3);
    expect(profile.flight).toBe(12);
    expect(profile.lead).toBe(1);
    expect(profile.guided).toBe(0);
    expect(profile.arcCos).toBeCloseTo(Math.cos((22.5 * Math.PI) / 180), 12);
    // A neutral turret neither holds a target nor prefers one; the team ring does both.
    expect(profile.hold).toBe(0);
    expect(profile.priority).toBe(0);
    const ring = map.weapons[map.bases[0].turrets[0].weapon];
    expect(ring.hold).toBe(1);
    expect(ring.priority).toBe(1);
    expect(ring.damage).toBe(100);
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
      expect(w.refireUnits).toBe(601);
      // Re-search 16 -> 1.0 s, the guns' own targeting delay.
      expect(w.searchUnits).toBe(300);
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

  it("fires four 100-damage rounds, one a gun, then waits the refire", () => {
    const state = createSim(map, 1);
    const ent = state.ent;
    const j = map.bases[0].juggernaut;
    if (!j) throw new Error("la-cantina must carry its Dreadnought");
    const id = spawnUnit(state, ARCHETYPE.JUGGERNAUT, 0, j.x, j.y);
    // Put the enemy avatar 4 m ahead, in the open by the Dreadnought's spawn: far
    // enough that the guns, which never pitch, see it inside their 22.5° arc
    // (the arc is tested in three dimensions, discharge_arc_blocks).
    const foe = state.avatarId[1];
    ent.posX[foe] = ent.posX[id] + 4;
    ent.posY[foe] = ent.posY[id];
    ent.hp[foe] = 100000;
    let shots = 0;
    let damage = 0;
    // 601 engine units at 10 a tick, the reload clamping the leftover: 61 ticks.
    for (let t = 0; t < 61; t++) {
      ent.posX[foe] = ent.posX[id] + 4;
      ent.posY[foe] = ent.posY[id];
      step(state, idle);
      for (let i = 0; i < state.events.count; i++) {
        const o = i * EVENT_STRIDE;
        const type = state.events.data[o];
        if (type === EV_SHOT && state.events.data[o + 1] === id) shots += 1;
        if (type === EV_HIT && state.events.data[o + 1] === foe) damage += state.events.data[o + 3];
      }
    }
    // Inside one refire window each of the four guns fires once, as its own
    // mount comes round onto the target (dreadnought.test.ts), 100 each.
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
    // The test map: a circle gate, the same win test, the same outro.
    const legacy = getMapById(TEST_MAP_ID);
    const state = createSim(legacy, 1);
    const gate = legacy.bases[1].gate;
    expect(gate.halfW).toBe(0);
    const unit = spawnUnit(state, ARCHETYPE.RUNNER, 0, gate.x, gate.y);
    state.ent.posX[unit] = gate.x;
    state.ent.posY[unit] = gate.y;
    step(state, idle);
    expect(state.outroWinner).toBe(0);
    run(state, MATCH_OUTRO_TICKS);
    expect(state.winner).toBe(0);
  });
});

describe("power-ups (fcop-fidelity.md P6, P7, P9)", () => {
  it("a health pickup refills to the maximum, and the spot re-arms", () => {
    const state = createSim(map, 1);
    const ent = state.ent;
    const k = map.pickups.findIndex((p) => p.kind === PICKUP_HEALTH);
    expect(k).toBeGreaterThanOrEqual(0);
    const spot = map.pickups[k];

    const avatar = state.avatarId[0];
    ent.hp[avatar] = 50;
    ent.posX[avatar] = spot.x;
    ent.posY[avatar] = spot.y;
    // Inside the box in height too: the mech on the ground under the pickup.
    ent.height[avatar] = resolveHeight(map, spot.x, spot.y, 0);
    step(state, idle);
    // The original's grant passes amount -1, "fill" (player-and-weapons.md §6):
    // full health, not +100. Pickups run after damage in the tick, so whatever
    // hit it first, it ends the tick full.
    expect(ent.hp[avatar]).toBe(AVATAR_HP);
    expect(countEvents(state, EV_PICKUP)).toBeGreaterThan(0);
    expect(state.pickupCooldown[k]).toBe(spot.respawnTicks);

    // Still standing there, but the spot is spent until it re-arms.
    ent.hp[avatar] = 50;
    step(state, idle);
    expect(countEvents(state, EV_PICKUP)).toBe(0);
    expect(ent.hp[avatar]).toBeLessThanOrEqual(50);
  });

  it("re-arms 50 s after ammo and health, 100 s after power and cloak, on every arena", () => {
    // The Csac spawners' tSAC words -3000 / -6000 x 5 engine units at 300 Hz
    // (player-and-weapons.md §6), carried by the imported data as is.
    for (const id of [
      "la-cantina",
      "urban-jungle",
      "proving-ground",
      "bug-hunt",
      "hollywood-keys",
      "venice-beach",
    ]) {
      const m = getMapById(id);
      expect(m.pickups.length).toBeGreaterThan(0);
      for (const p of m.pickups) {
        const slow =
          p.kind === PICKUP_POWER ||
          p.kind === PICKUP_POWER_HEAVY ||
          p.kind === PICKUP_POWER_SPECIAL ||
          p.kind === PICKUP_INVIS;
        expect(p.respawnTicks).toBe(slow ? 3000 : 1500);
      }
    }
  });

  it("a cloak lasts 45 s, and turrets, units and the Warden skip the cloaked avatar", () => {
    const state = createSim(map, 1, { wardenPlayer: 1, wardenDifficulty: 10 });
    const ent = state.ent;
    const k = map.pickups.findIndex((p) => p.kind === PICKUP_INVIS);
    expect(k).toBeGreaterThanOrEqual(0);
    const avatar = state.avatarId[0];
    ent.posX[avatar] = map.pickups[k].x;
    ent.posY[avatar] = map.pickups[k].y;
    ent.height[avatar] = resolveHeight(map, map.pickups[k].x, map.pickups[k].y, 0);
    step(state, idle);
    expect(state.buffInvis[0]).toBe(PICKUP_INVIS_TICKS);
    expect(PICKUP_INVIS_TICKS).toBe(1350); // 0x34bc = 13500 units at 300 Hz

    // An enemy Runner right next to it acquires nothing.
    const runner = spawnUnit(state, ARCHETYPE.RUNNER, 1, ent.posX[avatar] + 2, ent.posY[avatar]);
    expect(nearestEnemyInRange(state, runner, 6)).toBe(-1);
    // The Warden (the Sky Captain) never makes it its weapons' target while the
    // cloak runs: its scan skips the cloaked mech (the view-block gate, P7) and its
    // shooters' own search skips it like a turret's. It may still fly at it — its
    // defend mode chases player slot 0 itself, cloak or not.
    const warden = state.avatarId[1];
    let aimed = 0;
    for (let t = 0; t < 600; t++) {
      ent.posX[warden] = ent.posX[avatar] + 3;
      ent.posY[warden] = ent.posY[avatar];
      step(state, idle);
      if (state.captain.aim === avatar) aimed++;
    }
    expect(aimed).toBe(0);
    // ...which is the cloak's doing: uncloaked, the same captain takes it within
    // its shooters' 1.0 s search.
    state.buffInvis[0] = 0;
    let taken = -1;
    for (let t = 0; t < 60 && taken < 0; t++) {
      ent.posX[warden] = ent.posX[avatar] + 3;
      ent.posY[warden] = ent.posY[avatar];
      step(state, idle);
      if (state.captain.aim === avatar) taken = t;
    }
    expect(taken).toBeGreaterThanOrEqual(0);
    // And uncloaked, a Runner sees it again.
    const r2 = spawnUnit(state, ARCHETYPE.RUNNER, 1, ent.posX[avatar] + 2, ent.posY[avatar]);
    expect(nearestEnemyInRange(state, r2, 6)).toBe(state.avatarId[0]);
  });

  it("an invulnerability grant lasts 20 s", () => {
    // 0x1770 = 6000 units (player-and-weapons.md §6). No PA pickup carries it
    // (fcop-fidelity.md I8), so this pins the constant the kind would use.
    expect(PICKUP_INVULN_TICKS).toBe(600);
  });
});

describe("going down and coming back (fcop-fidelity.md P2)", () => {
  it("respawns 4 s later at its spawn: full health, full ammo, power-up lost, cloak kept", () => {
    const state = createSim(map, 1);
    const ent = state.ent;
    const avatar = state.avatarId[0];
    state.powerAmmo[1] = 10; // a powered Heavy
    state.buffInvis[0] = 1000;
    ent.ammoA[avatar] = 0;
    ent.ammoB[avatar] = 0;
    ent.hp[avatar] = -1;
    step(state, idle);
    expect(state.avatarId[0]).toBe(-1);
    // `player_op4`: 0x4b0 = 1200 units = 4.0 s; Metropolis had 8 s.
    expect(RESPAWN_TICKS).toBe(120);
    expect(state.respawnTimer[0]).toBe(RESPAWN_TICKS - 1);
    // Power-ups are lost (`player_respawn` clears block B); the cloak keeps
    // counting down while the mech is down.
    expect(state.powerAmmo[1]).toBe(0);
    expect(state.buffInvis[0]).toBe(999);
    run(state, RESPAWN_TICKS - 1);
    const back = state.avatarId[0];
    expect(back).toBeGreaterThanOrEqual(0);
    expect(ent.hp[back]).toBe(AVATAR_HP);
    expect(ent.ammoA[back]).toBeGreaterThan(0);
    expect(ent.ammoB[back]).toBeGreaterThan(0);
    expect(ent.posX[back]).toBe(Math.fround(map.spawns[0].x));
    expect(ent.posY[back]).toBe(Math.fround(map.spawns[0].y));
    expect(ent.yaw[back]).toBe(Math.fround(map.spawns[0].yaw));
    expect(ent.mode[back]).toBe(MODE_WALKER);
    expect(state.buffInvis[0]).toBe(1000 - RESPAWN_TICKS);
  });

  it("comes back in its spawn form: hover on hollywood-keys", () => {
    // Both of Hk's X1Alpha records carry a negative facing = hover
    // (player-and-weapons.md §1); every other PA arena spawns walkers.
    const hk = getMapById("hollywood-keys");
    expect(hk.spawns.every((s) => s.hover)).toBe(true);
    for (const id of ["la-cantina", "urban-jungle", "proving-ground", "bug-hunt", "venice-beach"]) {
      expect(getMapById(id).spawns.some((s) => s.hover)).toBe(false);
    }
    const state = createSim(hk, 1);
    const avatar = state.avatarId[0];
    expect(state.ent.mode[avatar]).toBe(MODE_HOVER);
    state.ent.hp[avatar] = -1;
    run(state, RESPAWN_TICKS);
    expect(state.ent.mode[state.avatarId[0]]).toBe(MODE_HOVER);
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
    // None imported: the original's 4.0 m (Metropolis' 5 m until SIM_VERSION 52).
    expect(getMapById(TEST_MAP_ID).captureRange).toBe(ORIGINAL_CAPTURE_RANGE);
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
      press.players[0].buttons = BTN_ACTION;
      step(state, press);
    };
    pressAt(reach + 0.05);
    expect(ent.ownerId[tid]).toBe(-1);
    pressAt(reach - 0.05);
    expect(ent.ownerId[tid]).toBe(0);
  });
});

describe("outposts on the imported arenas (fcop-fidelity.md R14)", () => {
  /** Stands avatar `p` at (x, y) on the ground, then presses the action key. */
  function pressAt(state: SimState, p: number, x: number, y: number): void {
    const ent = state.ent;
    const a = state.avatarId[p];
    const release = createTickInputs();
    ent.posX[a] = x;
    ent.posY[a] = y;
    ent.height[a] = resolveHeight(state.map, x, y, 0);
    step(state, release);
    const press = createTickInputs();
    press.players[p].buttons = BTN_ACTION;
    ent.posX[a] = x;
    ent.posY[a] = y;
    step(state, press);
  }

  it("imports the original's four outposts, each with two plates on a neutral turret", () => {
    for (const id of PA_ARENA_IDS) {
      const m = getMapById(id);
      expect(m.outpostSpots.length).toBe(4);
      expect(m.outposts.length).toBe(4);
      expect(m.outpostPlates.length).toBe(8);
      for (const o of m.outposts) expect(o.zone).toBeCloseTo(1.2, 2);
      for (const pl of m.outpostPlates) {
        // Each team's record stands on its neutral's plate, to a few cm.
        const n = m.turretSpots[pl.spot];
        for (const t of pl.turrets) expect(Math.hypot(t.x - n.x, t.y - n.y)).toBeLessThan(0.2);
      }
    }
    // la-cantina (Mp) outpost 0: claim zone (116.5, 96.125) + 16 on x
    // (fcop-re/outposts.md, Mp table).
    expect(map.outpostSpots[0].x).toBeCloseTo(132.5, 3);
    expect(map.outpostSpots[0].y).toBeCloseTo(96.125, 3);
  });

  it("claims on the action key inside the 1.2 m zone, not on entry, and for good", () => {
    // venice-beach outpost 0 from 5 m east: an open line on which the console is
    // hit 23 times in 2 s with the two guards below removed (measured); a test
    // that cannot hit the console proves nothing.
    const vb = getMapById("venice-beach");
    const state = createSim(vb, 1);
    const ent = state.ent;
    const spot = vb.outpostSpots[0];
    const reach = vb.outposts[0].zone + ARCHETYPE_RADIUS[ARCHETYPE.AVATAR];
    state.points[0] = 40;
    const a = state.avatarId[0];
    for (let t = 0; t < 10; t++) {
      ent.posX[a] = spot.x;
      ent.posY[a] = spot.y;
      step(state, idle);
    }
    expect(state.outpostOwner[0]).toBe(-1); // standing in it is not a claim
    pressAt(state, 0, spot.x + reach + 0.05, spot.y);
    expect(state.outpostOwner[0]).toBe(-1); // just outside the zone
    pressAt(state, 0, spot.x + reach - 0.05, spot.y);
    expect(state.outpostOwner[0]).toBe(0);
    expect(state.points[0]).toBe(10);
    const cid = state.outpostConsole[0];
    const hp = ent.hp[cid];
    // The claimer steps off, or it would be the target and take the shots.
    ent.posX[a] = spot.x;
    ent.posY[a] = spot.y + 20;
    // An enemy Runner next to it does not take it for a target...
    const runner = spawnUnit(state, ARCHETYPE.RUNNER, 1, spot.x + 3, spot.y);
    expect(nearestEnemyInRange(state, runner, 14)).not.toBe(cid);
    // ...and the enemy avatar shooting it point-blank does not hurt it.
    const foe = state.avatarId[1];
    const fire = createTickInputs();
    faceAlong(state, foe, -1, 0); // facing the console, west
    fire.players[1].buttons = BTN_GUN;
    for (let k = 0; k < 60; k++) {
      ent.posX[foe] = spot.x + 5; // an open line of fire (no wall in between)
      ent.posY[foe] = spot.y;
      step(state, fire);
      for (let i = 0; i < state.events.count; i++) {
        const o = i * EVENT_STRIDE;
        if (state.events.data[o] === EV_HIT) expect(state.events.data[o + 1]).not.toBe(cid);
      }
    }
    expect(ent.alive[cid]).toBe(1);
    expect(ent.hp[cid]).toBe(hp);
    expect(state.outpostOwner[0]).toBe(0);
  });

  it("a claim kills its plates' neutral turrets for good and raises the claimer's own", () => {
    // fcop-re/outposts.md Q1: DIE + SHUT the neutral, OPEN the claimer's type-8.
    const state = createSim(map, 1);
    const ent = state.ent;
    const plates = map.outpostPlates.filter((pl) => pl.outpost === 0);
    expect(plates.length).toBe(2);
    // Player 1 captured one of the plate's neutrals beforehand.
    const taken = state.neutralTurretEntity[plates[0].spot];
    ent.team[taken] = 1;
    ent.ownerId[taken] = 1;
    state.points[0] = 40;
    state.points[1] = 0;
    pressAt(state, 0, map.outpostSpots[0].x, map.outpostSpots[0].y);
    expect(state.outpostOwner[0]).toBe(0);
    // Its death paid nobody: player 1 has nothing, player 0 paid 30 only.
    expect(state.points[1]).toBe(0);
    expect(state.points[0]).toBe(10);
    const turrets: number[] = [];
    for (const pl of plates) {
      const j = map.outpostPlates.indexOf(pl);
      expect(state.neutralTurretEntity[pl.spot]).toBe(-1);
      expect(state.neutralTurretRespawn[pl.spot]).toBe(-1);
      const tid = state.plateTurretEntity[j];
      expect(tid).toBeGreaterThanOrEqual(0);
      expect(ent.team[tid]).toBe(0);
      expect(ent.mode[tid]).toBe(TURRET_DEFENSE);
      expect(ent.hp[tid]).toBe(pl.turrets[0].hp);
      expect(ent.posX[tid]).toBeCloseTo(pl.turrets[0].x, 3);
      turrets.push(j);
    }
    // The neutrals never come back; the claimer's turret does, 25 s after a death.
    const j = turrets[0];
    ent.hp[state.plateTurretEntity[j]] = 0;
    step(state, idle);
    expect(state.plateTurretEntity[j]).toBe(-1);
    expect(state.points[1]).toBe(POINTS_TURRET_DIES); // an outpost turret's death pays
    // The death tick counts: it stands again at the end of the 750th tick.
    run(state, OUTPOST_TURRET_RESPAWN_TICKS - 2);
    expect(state.plateTurretEntity[j]).toBe(-1);
    step(state, idle);
    expect(state.plateTurretEntity[j]).toBeGreaterThanOrEqual(0);
    expect(ent.team[state.plateTurretEntity[j]]).toBe(0);
    run(state, 2 * NEUTRAL_TURRET_RESPAWN_TICKS);
    for (const pl of plates) expect(state.neutralTurretEntity[pl.spot]).toBe(-1);
  });

  it("an owned outpost sells a tank at its tank pad and a jet at its jet pad, 2 each", () => {
    const state = createSim(map, 1);
    const ent = state.ent;
    state.points[0] = 50;
    pressAt(state, 0, map.outpostSpots[0].x, map.outpostSpots[0].y);
    expect(state.outpostOwner[0]).toBe(0);
    const o = map.outposts[0];
    const buy = createTickInputs();
    const a = state.avatarId[0];
    /** One press on the pad (released, then down): the unit it bought, or -1. */
    const pressPad = (x: number, y: number): number => {
      let bought = -1;
      for (const buttons of [0, BTN_ACTION]) {
        buy.players[0].buttons = buttons;
        ent.posX[a] = x;
        ent.posY[a] = y;
        ent.height[a] = resolveHeight(map, x, y, 0);
        step(state, buy);
        for (let i = 0; i < state.events.count; i++) {
          const e = i * EVENT_STRIDE;
          if (state.events.data[e] === EV_PURCHASE) bought = state.events.data[e + 1];
        }
      }
      return bought;
    };
    // The tank is accepted at the press and queued to the outpost's tank spawner
    // (R18): it comes out at the queue's next poll.
    expect(pressPad(o.tankPad.x, o.tankPad.y)).toBe(a);
    expect(state.points[0]).toBe(20 - COST_RUNNER * OUTPOST_COST_MULTIPLIER);
    const q = 0 * UNIT_QUEUES + QUEUE_OUTPOST;
    expect(state.unitQueue[q]).toBe(1);
    let tank = -1;
    for (let t = 0; t <= o.queuePeriod[0].tank / CFUN_DELTA_PER_TICK && tank < 0; t++) {
      step(state, idle);
      for (let id = 0; id < state.ent.high; id++) {
        if (state.ent.alive[id] && ent.archetype[id] === ARCHETYPE.RUNNER && ent.team[id] === 0) {
          tank = id;
        }
      }
    }
    expect(tank).toBeGreaterThanOrEqual(0);
    expect(state.unitQueue[q]).toBe(0);
    expect(
      Math.hypot(ent.posX[tank] - o.tankSpawn[0].x, ent.posY[tank] - o.tankSpawn[0].y),
    ).toBeLessThan(1);
    const jet = pressPad(o.jetPad.x, o.jetPad.y);
    expect(jet).toBeGreaterThanOrEqual(0);
    expect(ent.archetype[jet]).toBe(ARCHETYPE.GUARDIAN);
    expect(ent.mode[jet] & AIR_ANCHOR_MASK).toBe(1); // patrols outpost 0, the spawner it was built at
    expect(state.points[0]).toBe(16);
    // Not the other side's: player 1 on the same pad buys nothing.
    const other = createSim(map, 1);
    other.points[0] = 50;
    other.points[1] = 50;
    pressAt(other, 0, map.outpostSpots[0].x, map.outpostSpots[0].y);
    const b = other.avatarId[1];
    const foeBuy = createTickInputs();
    for (let t = 0; t < 30; t++) {
      foeBuy.players[1].buttons = t % 2 === 1 ? BTN_ACTION : 0; // fifteen presses
      other.ent.posX[b] = o.tankPad.x;
      other.ent.posY[b] = o.tankPad.y;
      step(other, foeBuy);
    }
    expect(other.points[1]).toBe(50);
  });

  it("the Sky Captain's claim opens the same plates for its side", () => {
    const state = createSim(map, 1, { wardenPlayer: 1, wardenDifficulty: 8 });
    state.points[1] = 30;
    expect(claimOutpostSlot(state, 1, 2)).toBe(true);
    step(state, idle);
    for (let j = 0; j < map.outpostPlates.length; j++) {
      const pl = map.outpostPlates[j];
      const tid = state.plateTurretEntity[j];
      if (pl.outpost !== 2) {
        expect(tid).toBe(-1);
        continue;
      }
      expect(state.ent.team[tid]).toBe(1);
      expect(state.ent.posX[tid]).toBeCloseTo(pl.turrets[1].x, 3);
      expect(state.neutralTurretEntity[pl.spot]).toBe(-1);
    }
  });

  it("the Warden claims by a decision, never by flying over an outpost", () => {
    // Defending (an enemy tank parked at its home), it claims nothing, even
    // hovering on a claim zone with the points.
    const state = createSim(map, 1, { wardenPlayer: 1, wardenDifficulty: 8 });
    const w = state.avatarId[1];
    const home = map.spawns[1];
    const tank = spawnUnit(state, ARCHETYPE.RUNNER, 0, home.x + 6, home.y);
    state.ent.timerA[tank] = -1;
    state.ent.hp[tank] = 1e6;
    const spot = map.outpostSpots[1];
    state.points[1] = 40;
    for (let t = 0; t < 10; t++) {
      state.ent.posX[w] = spot.x;
      state.ent.posY[w] = spot.y;
      step(state, idle);
    }
    expect(state.captain.mode).toBe(2); // SKY_MODE_DEFEND
    expect(state.outpostOwner[1]).toBe(-1);
    // Roaming, it claims on its first decision from its spawn, far from any zone
    // (its construct's order: 3, 2, 1, 0 or 1, 0, 3, 2).
    const roam = createSim(map, 1, { wardenPlayer: 1, wardenDifficulty: 8 });
    roam.points[1] = 40;
    step(roam, idle);
    let owned = 0;
    for (let k = 0; k < 4; k++) if (roam.outpostOwner[k] === 1) owned += 1;
    expect(owned).toBe(1);
    expect(roam.points[1]).toBe(10);
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

  it("holds the whole base quiet for the original's 8.3 s (fcop-fidelity.md R15)", () => {
    expect(TRIGGER_REARM_TICKS).toBe(250); // 2500 engine ticks at 300 Hz
    const state = createSim(map, 1);
    const ent = state.ent;
    const vol = map.triggerVolumes[0];
    const foe = state.avatarId[vol.team ^ 1];
    ent.posX[foe] = vol.x;
    ent.posY[foe] = vol.y;
    step(state, idle);
    // Every volume guarding that base re-armed together: one alert per base.
    let alerts = 0;
    for (let i = 0; i < state.events.count; i++) {
      if (state.events.data[i * EVENT_STRIDE] === EV_ALARM) alerts += 1;
    }
    expect(alerts).toBe(1);
    for (let u = 0; u < map.triggerVolumes.length; u++) {
      if (map.triggerVolumes[u].team === vol.team) {
        expect(state.triggerArm[u]).toBe(TRIGGER_REARM_TICKS);
      }
    }
    let again = -1;
    for (let t = 1; t <= TRIGGER_REARM_TICKS + 5 && again < 0; t++) {
      ent.posX[foe] = vol.x;
      ent.posY[foe] = vol.y;
      step(state, idle);
      if (countEvents(state, EV_ALARM) > 0) again = t;
    }
    expect(again).toBe(TRIGGER_REARM_TICKS);
  });

  it("is tripped by an enemy tank or Dreadnought, not by a jet", () => {
    const state = createSim(map, 1);
    const vol = map.triggerVolumes[0];
    const jet = spawnUnit(state, ARCHETYPE.GUARDIAN, vol.team ^ 1, vol.x, vol.y);
    state.ent.posX[jet] = vol.x;
    state.ent.posY[jet] = vol.y;
    step(state, idle);
    expect(countEvents(state, EV_ALARM)).toBe(0);
    spawnUnit(state, ARCHETYPE.RUNNER, vol.team ^ 1, vol.x, vol.y);
    step(state, idle);
    expect(countEvents(state, EV_ALARM)).toBe(1);
  });
});

describe("base turret alerts (fcop-fidelity.md R15)", () => {
  it("says a base turret is under fire at most once per side per 10 s", () => {
    // From a side of the turret no wall covers, so the shots land.
    expect(TURRET_ALERT_COOLDOWN_TICKS).toBe(300);
    const state = createSim(map, 1);
    const ent = state.ent;
    // The first ring turret with a wall-free line 6 m out along an axis.
    let tid = -1;
    let side: number[] | undefined;
    for (let k = 0; k < state.baseTurretEntity.length && side === undefined; k++) {
      tid = state.baseTurretEntity[k];
      const x = ent.posX[tid];
      const y = ent.posY[tid];
      side = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].find(([dx, dy]) => !segmentBlocked(map, x, y, x + 6 * dx, y + 6 * dy));
    }
    if (side === undefined) throw new Error("every ring turret is walled in");
    const team = ent.team[tid];
    const foe = state.avatarId[team ^ 1];
    const tx = ent.posX[tid];
    const ty = ent.posY[tid];
    const fire = createTickInputs();
    faceAlong(state, foe, -side[0], -side[1]); // back at the turret
    fire.players[team ^ 1].buttons = BTN_GUN;
    const fired: number[] = [];
    // Faced at the turret from the start, the walker hits it every tick.
    for (let t = 0; t < TURRET_ALERT_COOLDOWN_TICKS + 60; t++) {
      ent.posX[foe] = tx + 6 * side[0];
      ent.posY[foe] = ty + 6 * side[1];
      ent.hp[foe] = AVATAR_HP; // both stay alive: only the alert is under test
      ent.hp[tid] = 100;
      step(state, fire);
      for (let i = 0; i < state.events.count; i++) {
        const o = i * EVENT_STRIDE;
        if (state.events.data[o] === EV_TURRET_UNDER_FIRE) {
          expect(state.events.data[o + 1]).toBe(tid);
          expect(state.events.data[o + 2]).toBe(team);
          fired.push(t);
        }
      }
    }
    expect(fired.length).toBe(2);
    expect(fired[1] - fired[0]).toBe(TURRET_ALERT_COOLDOWN_TICKS);
  });

  it("says a base turret was lost, with its side", () => {
    const state = createSim(map, 1);
    const tid = state.baseTurretEntity[0];
    const team = state.ent.team[tid];
    state.ent.hp[tid] = 0;
    step(state, idle);
    let lost = 0;
    for (let i = 0; i < state.events.count; i++) {
      const o = i * EVENT_STRIDE;
      if (state.events.data[o] === EV_TURRET_LOST) {
        lost += 1;
        expect(state.events.data[o + 1]).toBe(tid);
        expect(state.events.data[o + 2]).toBe(team);
        expect(state.events.data[o + 3]).toBe(0);
      }
    }
    expect(lost).toBe(1);
  });
});
