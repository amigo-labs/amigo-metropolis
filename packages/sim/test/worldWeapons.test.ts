// The world's weapons on a Precinct Assault arena (fcop-fidelity.md W3;
// fcop-re/ranges-turrets-capture.md Q3): every turret, neutral turret and
// Dreadnought gun fires catalogue weapon 3, the tanks and jets weapon 1/6, the
// Flying Fortress weapon 4 — rounds that fly, on the original's rate machine,
// re-search period, hold-target, priority and firing arc. district-01 keeps
// Metropolis' own instant-hit table.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  ARCHETYPE_MAX_HP,
  AVATAR_LOCK_RANGE,
  SHOOTER_FRONT_ARC_COS,
  WORLD_WEAPONS,
} from "../src/balance";
import { segmentBlocked } from "../src/collision";
import { EV_HIT, EV_SHOT, EVENT_STRIDE, SHOT_SLOT_LAUNCH } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById, LA_CANTINA_ID, TEST_MAP_ID } from "../src/map";
import { createSim, type SimState, spawnUnit, step } from "../src/sim";
import { PROJ_ROUND } from "../src/weapons";

const map = getMapById(LA_CANTINA_ID);
const idle = createTickInputs();

/**
 * A spot about `dist` m from (x, y) with a clear line to it, scanning 16
 * bearings and distances down to half of it; undefined if the lattice walls the
 * spot in on every side.
 */
function clearSpot(
  state: SimState,
  x: number,
  y: number,
  dist: number,
): [number, number] | undefined {
  for (let d = dist; d >= dist / 2; d -= 0.5) {
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      const px = x + d * Math.cos(a);
      const py = y + d * Math.sin(a);
      if (!segmentBlocked(state.map, x, y, px, py)) return [px, py];
    }
  }
  return undefined;
}

/** A team-0 ring turret with the enemy avatar parked ~`dist` m away in the open. */
function ringDuel(dist: number) {
  const state = createSim(map, 1);
  const ent = state.ent;
  let t = -1;
  let spot: [number, number] | undefined;
  for (let k = 0; k < state.baseTurretEntity.length && spot === undefined; k++) {
    t = state.baseTurretEntity[k];
    if (ent.team[t] !== 0) continue;
    spot = clearSpot(state, ent.posX[t], ent.posY[t], dist);
  }
  if (spot === undefined) throw new Error("no team-0 ring turret with a clear line");
  const [fx, fy] = spot;
  const foe = state.avatarId[1];
  ent.hp[foe] = 1e6;
  const park = () => {
    ent.posX[foe] = fx;
    ent.posY[foe] = fy;
    ent.velX[foe] = 0;
    ent.velY[foe] = 0;
  };
  park();
  return { state, ent, t, foe, park, fx, fy };
}

function shotsBy(state: SimState, id: number): number {
  let n = 0;
  for (let i = 0; i < state.events.count; i++) {
    const o = i * EVENT_STRIDE;
    if (state.events.data[o] === EV_SHOT && state.events.data[o + 1] === id) {
      expect(state.events.data[o + 2]).toBe(SHOT_SLOT_LAUNCH); // the round renders itself
      n += 1;
    }
  }
  return n;
}

describe("PA turrets fire the original's weapon 3 (fcop-fidelity.md W3)", () => {
  it("is the catalogue's entry: 100 dmg, 2.0 s, 7.62 m/s, 12 m, lead-aimed", () => {
    const w = WORLD_WEAPONS[3];
    expect(w.damage).toBe(100);
    expect(w.burstGap).toBe(32);
    expect(w.speed).toBe(4096);
    expect(w.range).toBe(6144);
    expect(w.kind).toBe(2);
  });

  it("fires a round every 61 ticks that flies at 7.62 m/s and hits for 100", () => {
    const { state, ent, t, foe, park } = ringDuel(6);
    ent.yaw[t] = Math.atan2(ent.posY[foe] - ent.posY[t], ent.posX[foe] - ent.posX[t]);
    const fired: number[] = [];
    let damage = 0;
    let checkedSpeed = false;
    for (let k = 0; k < 130; k++) {
      park();
      step(state, idle);
      if (shotsBy(state, t) > 0) fired.push(k);
      for (let i = 0; i < state.events.count; i++) {
        const o = i * EVENT_STRIDE;
        if (state.events.data[o] === EV_HIT && state.events.data[o + 1] === foe) {
          damage += state.events.data[o + 3];
        }
      }
      for (let e = 0; e < ent.high && !checkedSpeed; e++) {
        if (
          ent.alive[e] &&
          ent.archetype[e] === ARCHETYPE.PROJECTILE &&
          ent.mode[e] === PROJ_ROUND
        ) {
          expect(Math.hypot(ent.velX[e], ent.velY[e])).toBeCloseTo(7.6171875, 4);
          expect(ent.ammoA[e]).toBe(100);
          checkedSpeed = true;
        }
      }
    }
    expect(checkedSpeed).toBe(true);
    // 601 engine units at 10 a tick; the reload clamps the leftover, so 61.
    expect(fired).toEqual([0, 61, 122]);
    // 6 m at 7.62 m/s is under a second: the first two have landed.
    expect(damage).toBeGreaterThanOrEqual(200);
    expect(damage % 100).toBe(0);
  });

  it("fires only once its barrel is within 22.5° of the aim", () => {
    const { state, ent, t, foe, park } = ringDuel(6);
    const bearing = Math.atan2(ent.posY[foe] - ent.posY[t], ent.posX[foe] - ent.posX[t]);
    ent.yaw[t] = bearing + Math.PI; // pointing away
    let first = -1;
    let errAtShot = 0;
    for (let k = 0; k < 90 && first < 0; k++) {
      park();
      step(state, idle);
      if (shotsBy(state, t) > 0) {
        first = k;
        let d = ent.yaw[t] - bearing;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        errAtShot = Math.abs(d);
      }
    }
    // 290°/s is 9.67° a tick: 157.5° of slew before the arc admits the round.
    expect(first).toBeGreaterThanOrEqual(16);
    expect(Math.cos(errAtShot)).toBeGreaterThanOrEqual(SHOOTER_FRONT_ARC_COS - 1e-6);
  });

  it("a team turret prefers the Dreadnought to a nearer X1-Alpha", () => {
    const { state, ent, t, foe } = ringDuel(4);
    const spot = clearSpot(state, ent.posX[t], ent.posY[t], 9);
    if (spot === undefined) throw new Error("no clear spot for the Dreadnought");
    const [jx, jy] = spot;
    const j = spawnUnit(state, ARCHETYPE.JUGGERNAUT, 1, jx, jy);
    ent.hp[j] = 1e6;
    const hold = () => {
      ent.posX[j] = jx;
      ent.posY[j] = jy;
    };
    hold();
    step(state, idle);
    expect(ent.cooldownC[t] - 1).toBe(j);
    expect(foe).toBeGreaterThanOrEqual(0);
  });

  it("a captured neutral turret re-searches on its 2.0 s targeting delay", () => {
    const state = createSim(map, 1);
    const ent = state.ent;
    let t = -1;
    let spot: [number, number] | undefined;
    for (let k = 0; k < state.neutralTurretEntity.length && spot === undefined; k++) {
      t = state.neutralTurretEntity[k];
      spot = clearSpot(state, ent.posX[t], ent.posY[t], 5);
    }
    if (spot === undefined) throw new Error("no neutral turret with a clear line");
    ent.team[t] = 0;
    ent.ownerId[t] = 0;
    const foe = state.avatarId[1];
    const [fx, fy] = spot;
    ent.posX[foe] = fx;
    ent.posY[foe] = fy;
    ent.hp[foe] = 1e6;
    ent.yaw[t] = Math.atan2(fy - ent.posY[t], fx - ent.posX[t]); // barrel already on it
    step(state, idle); // tick 0: the first search finds it, the round goes out
    expect(ent.cooldownC[t] - 1).toBe(foe);
    // Gone out of reach before the next round falls due (tick 61), back at 71.
    // The due round drops the lost target, but the search countdown was reloaded
    // with 601 units at tick 0 and only runs while a round waits, so the turret
    // finds it again a full search period later, at tick 121 — not at 71.
    let reacquired = -1;
    for (let k = 1; k < 200 && reacquired < 0; k++) {
      ent.posX[foe] = k < 71 ? fx + 30 : fx;
      ent.posY[foe] = fy;
      step(state, idle);
      if (k > 61 && ent.cooldownC[t] - 1 === foe) reacquired = k;
    }
    expect(reacquired).toBe(121);
  });
});

/** a - b folded into (-PI, PI]. */
function angleOff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * A team-0 ring turret with the enemy avatar parked 6 m off its rest yaw by at
 * least a quarter turn, in the open: the gun has a long way back.
 */
function offRestDuel() {
  const state = createSim(map, 1);
  const ent = state.ent;
  for (let k = 0; k < state.baseTurretEntity.length; k++) {
    const t = state.baseTurretEntity[k];
    if (ent.team[t] !== 0) continue;
    const rest = ent.restYaw[t];
    for (let i = 4; i <= 12; i++) {
      const a = rest + (i * Math.PI) / 8;
      const fx = ent.posX[t] + 6 * Math.cos(a);
      const fy = ent.posY[t] + 6 * Math.sin(a);
      if (segmentBlocked(state.map, ent.posX[t], ent.posY[t], fx, fy)) continue;
      const foe = state.avatarId[1];
      ent.hp[foe] = 1e6;
      ent.posX[foe] = fx;
      ent.posY[foe] = fy;
      ent.yaw[t] = Math.atan2(fy - ent.posY[t], fx - ent.posX[t]); // on it
      return { state, ent, t, foe, rest, fx, fy };
    }
  }
  throw new Error("no team-0 ring turret with a clear line off its rest yaw");
}

describe("a turret gun whose target is gone turns back to rest (fcop-fidelity.md G12)", () => {
  it("every turret is built at its rest yaw, the record's angle", () => {
    const state = createSim(map, 1);
    const ent = state.ent;
    const ids = [...state.baseTurretEntity, ...state.neutralTurretEntity].filter((id) => id >= 0);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(ent.restYaw[id]).toBe(ent.yaw[id]);
    for (let k = 0; k < state.neutralTurretEntity.length; k++) {
      expect(ent.restYaw[state.neutralTurretEntity[k]]).toBeCloseTo(map.turretYaw[k], 5);
    }
  });

  it("turns back at its turn rate once its due round drops the target, and stops on it", () => {
    const { state, ent, t, foe, rest, fx, fy } = offRestDuel();
    const w = map.weapons[ent.weaponProfile[t]];
    step(state, idle); // tick 0: found, on it, fired
    expect(ent.cooldownC[t] - 1).toBe(foe);
    // Out of reach along the same bearing: the gun keeps aiming at it until the
    // round due at tick 61 drops it (the original aims at its shooter's target
    // until the shooter lets it go), then turns back.
    const far = () => {
      ent.posX[foe] = ent.posX[t] + (fx - ent.posX[t]) * 5;
      ent.posY[foe] = ent.posY[t] + (fy - ent.posY[t]) * 5;
    };
    const aim = ent.yaw[t];
    for (let k = 1; k <= 60; k++) {
      far();
      step(state, idle);
    }
    expect(ent.cooldownC[t] - 1).toBe(foe);
    expect(Math.abs(angleOff(ent.yaw[t], aim))).toBeLessThan(0.02);
    let off = Math.abs(angleOff(ent.yaw[t], rest));
    expect(off).toBeGreaterThan(Math.PI / 2 - 0.05);
    const ticks = Math.ceil(off / w.turnSpeed);
    for (let k = 61; k <= 60 + ticks; k++) {
      far();
      step(state, idle);
      expect(ent.cooldownC[t]).toBe(0);
      const now = Math.abs(angleOff(ent.yaw[t], rest));
      expect(off - now).toBeCloseTo(Math.min(w.turnSpeed, off), 4); // 110 units a tick
      off = now;
    }
    expect(ent.yaw[t]).toBe(rest); // on it, not past it
    for (let k = 0; k < 10; k++) {
      far();
      step(state, idle);
    }
    expect(ent.yaw[t]).toBe(rest); // and it stays
  });

  it("turns back from the tick after its target dies, though the id is reused", () => {
    const { state, ent, t, foe, rest } = offRestDuel();
    step(state, idle);
    expect(ent.cooldownC[t] - 1).toBe(foe);
    ent.hp[foe] = 0;
    step(state, idle); // the down: despawned, the turret's target forgotten
    expect(ent.alive[foe]).toBe(0);
    expect(ent.cooldownC[t]).toBe(0);
    // An enemy tank takes the freed id at once (the free-list is LIFO), out of
    // reach: the gun does not take it for its old target.
    const away = ent.posX[t] + 25;
    const r = spawnUnit(state, ARCHETYPE.RUNNER, 1, away, ent.posY[t]);
    expect(r).toBe(foe);
    const aim = ent.yaw[t];
    const w = map.weapons[ent.weaponProfile[t]];
    step(state, idle);
    const now = Math.abs(angleOff(ent.yaw[t], rest));
    expect(Math.abs(angleOff(aim, rest)) - now).toBeCloseTo(w.turnSpeed, 4);
    for (let k = 0; k < 30; k++) {
      ent.posX[r] = away;
      ent.posY[r] = ent.posY[t];
      step(state, idle);
    }
    expect(ent.cooldownC[t]).toBe(0);
    expect(ent.yaw[t]).toBe(rest);
  });
});

describe("PA units carry their spawner records (fcop-fidelity.md W3)", () => {
  it("tank 150 HP / weapon 1, jet 150 / weapon 6-or-1, Fortress 2000 / weapon 4", () => {
    const state = createSim(map, 1);
    const ent = state.ent;
    const c = map.bases[0].groundConsole;
    const r = spawnUnit(state, ARCHETYPE.RUNNER, 0, c.x, c.y);
    const g = spawnUnit(state, ARCHETYPE.GUARDIAN, 0, c.x, c.y);
    const f = spawnUnit(state, ARCHETYPE.FORTRESS, 0, c.x, c.y);
    expect([ent.hp[r], ent.hp[g], ent.hp[f]]).toEqual([150, 150, 2000]);
    const wr = map.weapons[ent.weaponProfile[r]];
    const wg = map.weapons[ent.weaponProfile[g]];
    const wf = map.weapons[ent.weaponProfile[f]];
    for (const w of [wr, wg]) {
      expect(w.damage).toBe(50);
      expect(w.refireUnits).toBe(300); // 1.0 s
      expect(w.range).toBe(12);
      expect(w.flight).toBe(12);
      expect(w.lead).toBe(1);
      expect(w.speed).toBeCloseTo(7.617, 3);
    }
    expect(wf.damage).toBe(100);
    expect(wf.refireUnits).toBe(150); // 0.5 s
    expect(wf.guided).toBe(1);
    expect(wf.flight).toBe(24);
    expect(wf.range).toBe(12); // its shooter's engage range
  });

  it("a Fortress round homes on its target", () => {
    const state = createSim(map, 1);
    const ent = state.ent;
    const c = map.bases[0].airConsole;
    const f = spawnUnit(state, ARCHETYPE.FORTRESS, 0, c.x, c.y);
    const foe = state.avatarId[1];
    ent.posX[foe] = ent.posX[f] + 5;
    ent.posY[foe] = ent.posY[f];
    ent.hp[foe] = 1e6;
    step(state, idle);
    let round = -1;
    for (let e = 0; e < ent.high; e++) {
      if (ent.alive[e] && ent.archetype[e] === ARCHETYPE.PROJECTILE && ent.mode[e] === PROJ_ROUND) {
        round = e;
      }
    }
    if (round < 0) return; // a wall between them on this spot: nothing to pin
    expect(ent.cooldownC[round]).toBe(foe);
    expect(ent.ammoB[round] & 1).toBe(1);
  });

  it("an arena with no records of its own carries the original's (SIM_VERSION 52)", () => {
    // The test map imports nothing: its units get the same records the PA arenas
    // import, from balance.ts ORIGINAL_UNIT_PROFILES.
    const d01 = getMapById(TEST_MAP_ID);
    const pa = getMapById("la-cantina");
    const state = createSim(d01, 1);
    const ent = state.ent;
    const c = d01.bases[0].groundConsole;
    const want = [
      [ARCHETYPE.RUNNER, 150, pa.bases[0].runner.weapon],
      [ARCHETYPE.GUARDIAN, 150, pa.bases[0].guardian.weapon],
      [ARCHETYPE.FORTRESS, 2000, pa.bases[0].fortress.weapon],
      [ARCHETYPE.JUGGERNAUT, 3000, pa.bases[0].juggernaut.weapon],
    ];
    for (const [a, hp, weapon] of want) {
      const id = spawnUnit(state, a, 0, c.x, c.y);
      expect(ent.hp[id]).toBe(hp);
      expect(ent.hp[id]).toBe(ARCHETYPE_MAX_HP[a]);
      expect(ent.weaponProfile[id]).toBe(weapon);
      expect(d01.weapons[weapon]).toEqual(pa.weapons[weapon]);
    }
  });
});

describe("the reach the two sides trade at (fcop-fidelity.md W4)", () => {
  it("the X1-Alpha's lock and every PA shooter's reach are the same 12 m", () => {
    for (const w of map.weapons) expect(w.range).toBe(AVATAR_LOCK_RANGE);
  });
});
