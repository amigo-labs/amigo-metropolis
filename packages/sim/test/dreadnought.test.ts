// The Dreadnought's guns as the original's mounts (SIM_VERSION 77;
// fcop-fidelity.md I6; RE mount.c 0x004258d0, discharge.c 949-977,
// pa_models.json `guns[]`): gun i on hull attach point i, its own yaw relative
// to the hull turning 9 angle units per 1/300 s, its own shooter and target,
// firing from its muzzle inside ±22.5° of its own forward.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  DREADNOUGHT_GUN_TURN,
  DREADNOUGHT_GUNS,
  DREADNOUGHT_MOUNTS,
  FRAME_CLOCK_PER_TICK,
  SHOOTER_FRONT_ARC_COS,
  TICK_DT,
} from "../src/balance";
import { EV_SHOT, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById, LA_CANTINA_ID, sampleHeight } from "../src/map";
import {
  createSim,
  GUN_SNAPSHOT_LEN,
  gunYawRadians,
  hash,
  type SimState,
  spawnUnit,
  step,
  writeGunSnapshot,
} from "../src/sim";

const map = getMapById(LA_CANTINA_ID);
const idle = createTickInputs();
// Open ground on la-cantina (warden.test.ts "a player's down").
const X = 152;
const Y = 128;
const TURN = DREADNOUGHT_GUN_TURN * FRAME_CLOCK_PER_TICK; // 90 units a tick
const UNIT = (2 * Math.PI) / 4096;

/** A Dreadnought of team 0 parked at (X, Y) facing `yaw`, re-parked by `park()`. */
function parked(state: SimState, yaw = 0): { id: number; park: () => void } {
  const id = spawnUnit(state, ARCHETYPE.JUGGERNAUT, 0, X, Y);
  const park = () => {
    state.ent.posX[id] = X;
    state.ent.posY[id] = Y;
    state.ent.yaw[id] = yaw;
    state.ent.velX[id] = 0;
    state.ent.velY[id] = 0;
    state.ent.height[id] = sampleHeight(state.map, X, Y);
    state.ent.timerA[id] = -1; // off its road: the route follower halts it
  };
  park();
  return { id, park };
}

/** Stands player 1's mech at (x, y), armoured so it does not go down. */
function foeAt(state: SimState, x: number, y: number): number {
  const a = state.avatarId[1];
  state.ent.posX[a] = x;
  state.ent.posY[a] = y;
  state.ent.height[a] = sampleHeight(state.map, x, y);
  state.ent.hp[a] = 1e6;
  return a;
}

/**
 * The world point of hull glb point (x, z) for a hull at (X, Y) facing `yaw`:
 * z along the forward, x along (sin yaw, -cos yaw), as the client draws the glb
 * (client test dreadnoughtFrame.test.ts holds that to the client's transform).
 */
function hullPoint(x: number, z: number, yaw: number): [number, number] {
  return [X + z * Math.cos(yaw) + x * Math.sin(yaw), Y + z * Math.sin(yaw) - x * Math.cos(yaw)];
}

describe("the Dreadnought's mounts", () => {
  it("imports the arena's own hull points, Joke's its larger hull's", () => {
    for (const team of [0, 1]) {
      const j = map.bases[team].juggernaut;
      expect(j.guns).toBe(DREADNOUGHT_GUNS);
      expect(j.mounts).toEqual(DREADNOUGHT_MOUNTS);
      expect(j.gunTurn).toBe(9);
      expect(map.weapons[j.weapon].arcCos).toBe(SHOOTER_FRONT_ARC_COS);
    }
    const joke = getMapById("bug-hunt").bases[0].juggernaut;
    expect(joke.mounts[0].y).toBeCloseTo(1.1035, 3);
    expect(joke.mounts[0].z).toBeCloseTo(0.5547, 3);
  });

  it("turns each gun 237.3°/s toward its target, the hull not at all", () => {
    const state = createSim(map, 1);
    const { id, park } = parked(state);
    // Straight to the hull's left (+y here): every gun wants about +90°.
    foeAt(state, X, Y + 6);
    let turned = false;
    let last = new Int16Array(DREADNOUGHT_GUNS);
    for (let t = 0; t < 30; t++) {
      park();
      foeAt(state, X, Y + 6);
      step(state, idle);
      expect(state.ent.yaw[id]).toBe(0);
      for (let g = 0; g < DREADNOUGHT_GUNS; g++) {
        const y = state.gunYaw[id * DREADNOUGHT_GUNS + g];
        const moved = (y - last[g] + 4096) % 4096;
        expect(moved <= TURN || 4096 - moved <= TURN).toBe(true);
        if (moved === TURN) turned = true;
      }
      last = state.gunYaw.slice(id * DREADNOUGHT_GUNS, (id + 1) * DREADNOUGHT_GUNS);
    }
    expect(turned).toBe(true);
    // After 30 ticks every gun is on its bearing, about a quarter turn left.
    for (let g = 0; g < DREADNOUGHT_GUNS; g++) {
      const yaw = gunYawRadians(state.gunYaw[id * DREADNOUGHT_GUNS + g]);
      expect(yaw).toBeGreaterThan(1.3);
      expect(yaw).toBeLessThan(1.8);
    }
  });

  it("fires each gun from its own muzzle, only once its sector is on the target", () => {
    const yaw = 0.9;
    const state = createSim(map, 1);
    const { park } = parked(state, yaw);
    // 6 m to the hull's left, a quarter turn from every gun's home.
    const fx = X - 6 * Math.sin(yaw);
    const fy = Y + 6 * Math.cos(yaw);
    const shots: { tick: number; x: number; y: number }[] = [];
    const was = new Uint8Array(state.ent.cap);
    for (let t = 0; t < 90; t++) {
      park();
      foeAt(state, fx, fy);
      for (let p = 0; p < state.ent.high; p++) was[p] = state.ent.alive[p];
      step(state, idle);
      // The rounds born this tick, taken back over their one tick of flight.
      for (let p = 0; p < state.ent.high; p++) {
        if (was[p] || !state.ent.alive[p] || state.ent.archetype[p] !== ARCHETYPE.PROJECTILE) {
          continue;
        }
        if (state.ent.team[p] !== 0) continue;
        const x = state.ent.posX[p] - state.ent.velX[p] * TICK_DT;
        const y = state.ent.posY[p] - state.ent.velY[p] * TICK_DT;
        shots.push({ tick: t, x, y });
      }
    }
    // Four guns, each a round inside the window; none before its gun turned
    // 67.5° of the 90° (at 90 units a tick, at least 8 ticks).
    expect(shots.length).toBeGreaterThanOrEqual(4);
    for (const s of shots) expect(s.tick).toBeGreaterThanOrEqual(7);
    // Every round leaves from a gun's muzzle, 5 cm on from its mount, and the
    // first four from four different guns.
    const mounts = DREADNOUGHT_MOUNTS.map((m) => hullPoint(m.x, m.z, yaw));
    const used = new Set<number>();
    for (const [i, s] of shots.entries()) {
      const d = mounts.map(([mx, my]) => Math.hypot(s.x - mx, s.y - my));
      const near = Math.min(...d);
      expect(near).toBeGreaterThan(0.04);
      expect(near).toBeLessThan(0.06);
      if (i < 4) used.add(d.indexOf(near));
    }
    expect(used.size).toBe(4);
  });

  it("holds its fire while the target is outside every gun's sector", () => {
    const state = createSim(map, 1);
    const { id, park } = parked(state);
    let fired = false;
    for (let t = 0; t < 6; t++) {
      park();
      foeAt(state, X, Y + 6); // 90° off; the guns cannot get there in 6 ticks
      step(state, idle);
      for (let i = 0; i < state.events.count; i++) {
        const o = i * EVENT_STRIDE;
        if (state.events.data[o] === EV_SHOT && state.events.data[o + 1] === id) fired = true;
      }
    }
    expect(fired).toBe(false);
  });

  it("gives each gun its own target, searched from its own mount", () => {
    const state = createSim(map, 1);
    const { id, park } = parked(state);
    const a = foeAt(state, X, Y + 5);
    const u = spawnUnit(state, ARCHETYPE.RUNNER, 1, X, Y - 5);
    for (let t = 0; t < 40; t++) {
      park();
      foeAt(state, X, Y + 5);
      state.ent.posX[u] = X;
      state.ent.posY[u] = Y - 5;
      state.ent.hp[u] = 1e6;
      step(state, idle);
    }
    // Guns 0 and 2 stand on the glb's -x, the +y side here: the mech; 1 and 3 the tank.
    const targets = [0, 1, 2, 3].map((g) => state.gunTarget[id * DREADNOUGHT_GUNS + g] - 1);
    expect(targets).toEqual([a, u, a, u]);
  });

  it("exposes each gun's yaw relative to its hull, and hashes it", () => {
    const state = createSim(map, 1);
    const { id, park } = parked(state);
    for (let t = 0; t < 5; t++) {
      park();
      foeAt(state, X, Y + 6);
      step(state, idle);
    }
    const out = new Float32Array(GUN_SNAPSHOT_LEN);
    writeGunSnapshot(state, out);
    for (let g = 0; g < DREADNOUGHT_GUNS; g++) {
      const k = id * DREADNOUGHT_GUNS + g;
      expect(out[k]).toBeCloseTo(state.gunYaw[k] * UNIT, 5);
      expect(out[k]).toBeGreaterThan(0); // turning left, toward +y
    }
    const before = hash(state);
    state.gunYaw[id * DREADNOUGHT_GUNS + 2] += 1;
    expect(hash(state)).not.toBe(before);
  });
});
