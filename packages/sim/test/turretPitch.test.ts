// The pitch of the guns (fcop-fidelity.md G12, I6, G8). Every PA
// turret record carries flag byte 0x07, and its 0x02 is the construct's
// TURRET_DF_PITCH 0x08 (`turret_construct`, turret.c 874-877): the tick takes
// the elevation of its target's reference point over its own, negated, clamped
// to +-0x200, and turns it at the yaw's own `turn_rate * dt` (`turret_tick`
// 0x0041c5f8..0x0041c78c); with no target it levels (0x0041c687). The gun stands
// on its base's point 0 and fires from its model's point 0 through
// `math_matrix_from_angles(yaw, pitch, 0)`, and the ±22.5° arc is the dot of
// that matrix's row 2 with the aim in three dimensions (`discharge_arc_blocks`
// 0x0044db71). The Dreadnought's guns never pitch — no mount byte sets
// CACT_MOUNT_AIM_PITCH (mount.c 0x004259d8) — so their level barrels refuse an
// aim more than 22.5° above or below.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { TURRET_PITCH_LIMIT, WU_PER_METRE } from "../src/balance";
import { segmentBlocked } from "../src/collision";
import { EV_SHOT, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import {
  BUG_HUNT_ID,
  getMapById,
  HOLLYWOOD_KEYS_ID,
  LA_CANTINA_ID,
  sampleHeight,
  TEST_MAP_ID,
} from "../src/map";
import {
  createSim,
  entityRefHeight,
  GUN_SNAP_STRIDE,
  GUN_SNAP_TURRET_PITCH,
  GUN_SNAPSHOT_LEN,
  hash,
  type SimState,
  spawnUnit,
  step,
  writeGunSnapshot,
} from "../src/sim";
import { octagonalLength } from "../src/simMath";

const map = getMapById(LA_CANTINA_ID);
const idle = createTickInputs();
const UNIT = (2 * Math.PI) / 4096;

/** A spot `dist` m from (x, y) with a clear line, scanning 16 bearings. */
function clearSpot(state: SimState, x: number, y: number, dist: number): [number, number] {
  for (let d = dist; d >= dist / 2; d -= 0.5) {
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      const px = x + d * Math.cos(a);
      const py = y + d * Math.sin(a);
      if (!segmentBlocked(state.map, x, y, px, py)) return [px, py];
    }
  }
  throw new Error("no clear spot");
}

/** A team-0 ring turret, the enemy avatar parked `dist` m off, the turret `drop` m lower. */
function duel(dist: number, drop: number) {
  const state = createSim(map, 1);
  const ent = state.ent;
  let t = -1;
  for (let k = 0; k < state.baseTurretEntity.length && t < 0; k++) {
    if (ent.team[state.baseTurretEntity[k]] === 0) t = state.baseTurretEntity[k];
  }
  const [fx, fy] = clearSpot(state, ent.posX[t], ent.posY[t], dist);
  ent.height[t] -= drop;
  const foe = state.avatarId[1];
  ent.hp[foe] = 1e6;
  const park = () => {
    ent.posX[foe] = fx;
    ent.posY[foe] = fy;
    ent.velX[foe] = 0;
    ent.velY[foe] = 0;
  };
  park();
  return { state, ent, t, foe, park };
}

/** The pitch the original's tick wants, computed here with Math.atan2. */
function wanted(state: SimState, t: number, foe: number): number {
  const ent = state.ent;
  const dx = Math.trunc((ent.posX[foe] - ent.posX[t]) * WU_PER_METRE);
  const dz = Math.trunc((ent.posY[foe] - ent.posY[t]) * WU_PER_METRE);
  // The gun's reference height carries its base's point 0 since SIM_VERSION 112.
  const gun = ent.height[t] + entityRefHeight(state, t);
  const dy = (ent.height[foe] + entityRefHeight(state, foe) - gun) * WU_PER_METRE;
  const p = Math.floor(-Math.atan2(dy, octagonalLength(dx, dz)) / UNIT);
  return Math.max(-TURRET_PITCH_LIMIT, Math.min(TURRET_PITCH_LIMIT, p));
}

function shotsBy(state: SimState, id: number): number {
  let n = 0;
  for (let i = 0; i < state.events.count; i++) {
    const o = i * EVENT_STRIDE;
    if (state.events.data[o] === EV_SHOT && state.events.data[o + 1] === id) n += 1;
  }
  return n;
}

describe("the turret guns' models (fcop-fidelity.md G12)", () => {
  it("stand on their base's point 0 and fire from their own point 0", () => {
    const g = map.turretGuns;
    // Mp: gun 20 on base 21, neutral gun 31 on base 32 (RE pa_models.json).
    expect(g.baseTurret).toEqual({ stand: 0.337891, mx: -0.001953, my: 0.355469, mz: 0.330078 });
    expect(g.neutral.length).toBe(map.turretSpots.length);
    for (const n of g.neutral) {
      expect(n).toEqual({ stand: 0.996094, mx: 0, my: 0.240234, mz: 0.597656 });
    }
    // Joke's base 21 has its point 0 on the ground; Hk's second set its own.
    expect(getMapById(BUG_HUNT_ID).turretGuns.baseTurret.stand).toBe(0);
    const hk = getMapById(HOLLYWOOD_KEYS_ID).turretGuns.neutral;
    expect(new Set(hk.map((n) => n.stand))).toEqual(new Set([0.996094, 0.21875]));
    // An arena without models keeps Metropolis' stand-in muzzle.
    const test = getMapById(TEST_MAP_ID).turretGuns.baseTurret;
    expect(test).toEqual({ stand: 0, mx: 0, my: 0.6, mz: 0.6 });
  });
});

describe("a turret's gun pitches (fcop-fidelity.md G12)", () => {
  it("turns toward the target's elevation at the yaw's 110 units a tick", () => {
    const { state, ent, t, foe, park } = duel(6, 5);
    expect(ent.pitch[t]).toBe(0);
    let prev = 0;
    for (let k = 0; k < 12; k++) {
      park();
      step(state, idle);
      const now = ent.pitch[t];
      expect(Math.abs(now - prev)).toBeLessThanOrEqual(110);
      prev = now;
    }
    const want = wanted(state, t, foe);
    expect(want).toBeLessThan(-200); // well above: a target above is a negative pitch
    expect(Math.abs(ent.pitch[t] - want)).toBeLessThanOrEqual(1); // atan2Poly against atan2
  });

  it("stops at an eighth of a turn", () => {
    const { state, ent, t, park } = duel(4, 30);
    for (let k = 0; k < 12; k++) {
      park();
      step(state, idle);
    }
    expect(ent.pitch[t]).toBe(-TURRET_PITCH_LIMIT);
  });

  it("levels once its target is gone", () => {
    const { state, ent, t, foe } = duel(6, 5);
    const fx = ent.posX[foe];
    const fy = ent.posY[foe];
    for (let k = 0; k < 6; k++) step(state, idle);
    expect(ent.pitch[t]).toBeLessThan(-200);
    // Out of reach: the next due round drops it, and the gun levels at its rate.
    for (let k = 0; k < 90; k++) {
      ent.posX[foe] = ent.posX[t] + (fx - ent.posX[t]) * 5;
      ent.posY[foe] = ent.posY[t] + (fy - ent.posY[t]) * 5;
      step(state, idle);
    }
    expect(ent.cooldownC[t]).toBe(0);
    expect(ent.pitch[t]).toBe(0);
  });

  it("fires at a target well up, which a level barrel's arc would refuse", () => {
    const { state, ent, t, foe, park } = duel(6, 5);
    let shots = 0;
    for (let k = 0; k < 61; k++) {
      park();
      step(state, idle);
      shots += shotsBy(state, t);
    }
    const g = map.turretGuns.baseTurret;
    const rise = ent.height[foe] - (ent.height[t] + g.stand + g.my);
    const run = Math.hypot(ent.posX[foe] - ent.posX[t], ent.posY[foe] - ent.posY[t]);
    expect(Math.atan2(rise, run) * (180 / Math.PI)).toBeGreaterThan(25);
    expect(shots).toBeGreaterThanOrEqual(1);
  });

  it("is hashed and in the snapshot, raising the muzzle positive", () => {
    const { state, ent, t, park } = duel(6, 5);
    for (let k = 0; k < 6; k++) {
      park();
      step(state, idle);
    }
    const out = new Float32Array(GUN_SNAPSHOT_LEN);
    writeGunSnapshot(state, out);
    expect(out[t * GUN_SNAP_STRIDE + GUN_SNAP_TURRET_PITCH]).toBeCloseTo(-ent.pitch[t] * UNIT, 6);
    expect(out[t * GUN_SNAP_STRIDE + GUN_SNAP_TURRET_PITCH]).toBeGreaterThan(0);
    const h = hash(state);
    ent.pitch[t] += 1;
    expect(hash(state)).not.toBe(h);
  });
});

describe("the Dreadnought's guns never pitch (fcop-fidelity.md I6)", () => {
  /** Rounds from a team-0 Dreadnought parked on open ground, the foe `ahead` m in front. */
  function shotsAt(ahead: number): number {
    const state = createSim(map, 1);
    const ent = state.ent;
    const x = 152;
    const y = 128;
    const id = spawnUnit(state, ARCHETYPE.JUGGERNAUT, 0, x, y);
    const foe = state.avatarId[1];
    ent.hp[foe] = 1e6;
    let shots = 0;
    for (let k = 0; k < 61; k++) {
      ent.posX[id] = x;
      ent.posY[id] = y;
      ent.yaw[id] = 0;
      ent.velX[id] = 0;
      ent.velY[id] = 0;
      ent.height[id] = sampleHeight(state.map, x, y);
      ent.timerA[id] = -1;
      ent.posX[foe] = x + ahead;
      ent.posY[foe] = y;
      ent.velX[foe] = 0;
      ent.velY[foe] = 0;
      step(state, idle);
      shots += shotsBy(state, id);
    }
    return shots;
  }

  it("fire level, and refuse a target more than 22.5° below their barrels", () => {
    expect(shotsAt(4)).toBe(4);
    // Half a metre ahead of the hull's centre the foe's reference point (0.29-
    // 0.37 m up, the legs' frame's box centre) lies 25-30° below every muzzle
    // (the fore pair 0.49 m up, the aft pair 0.79 m). A metre ahead did until
    // SIM_VERSION 112, when the reference point stood 0.023 m up.
    expect(shotsAt(0.5)).toBe(0);
  });
});
