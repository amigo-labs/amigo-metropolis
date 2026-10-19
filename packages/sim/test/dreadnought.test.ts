// The Dreadnought's guns as the original's mounts (SIM_VERSION 77;
// fcop-fidelity.md I6; RE mount.c 0x004258d0, discharge.c 949-977,
// pa_models.json `guns[]`): gun i on hull attach point i, its own yaw relative
// to the hull turning 9 angle units per 1/300 s, its own shooter and target,
// firing from its muzzle inside ±22.5° of its own forward. On Joke's walking
// hull (SIM_VERSION 85; mount.c 1019-1030, type5.c 469-472) the point is the
// one of the frame the hull's walk shows, a frame per 775 world units.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  DREADNOUGHT_GUN_TURN,
  DREADNOUGHT_GUNS,
  DREADNOUGHT_MOUNTS,
  FRAME_CLOCK_PER_TICK,
  ROUTE_SPEED_UNIT,
  ROUTE_TOP_SPEED,
  SHOOTER_FRONT_ARC_COS,
  TICK_DT,
} from "../src/balance";
import { segmentBlocked } from "../src/collision";
import { EV_SHOT, EVENT_STRIDE, roundSource } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { BUG_HUNT_ID, getMapById, LA_CANTINA_ID, sampleHeight } from "../src/map";
import {
  createSim,
  entityRadius,
  GUN_SNAP_HULL_FRAME,
  GUN_SNAP_STRIDE,
  GUN_SNAPSHOT_LEN,
  gunYawRadians,
  hash,
  hitscan,
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
function parked(state: SimState, yaw = 0, x = X, y = Y): { id: number; park: () => void } {
  const id = spawnUnit(state, ARCHETYPE.JUGGERNAUT, 0, x, y);
  const park = () => {
    state.ent.posX[id] = x;
    state.ent.posY[id] = y;
    state.ent.yaw[id] = yaw;
    state.ent.velX[id] = 0;
    state.ent.velY[id] = 0;
    state.ent.height[id] = sampleHeight(state.map, x, y);
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
      expect(out[id * GUN_SNAP_STRIDE + g]).toBeCloseTo(state.gunYaw[k] * UNIT, 5);
      expect(out[id * GUN_SNAP_STRIDE + g]).toBeGreaterThan(0); // turning left, toward +y
    }
    // La Cantina's hull does not walk: frame 0.
    expect(state.hullWalk[0]).toBeNull();
    expect(out[id * GUN_SNAP_STRIDE + GUN_SNAP_HULL_FRAME]).toBe(0);
    const before = hash(state);
    state.gunYaw[id * DREADNOUGHT_GUNS + 2] += 1;
    expect(hash(state)).not.toBe(before);
  });
});

describe("Joke's walking hull (bug-hunt)", () => {
  const joke = getMapById(BUG_HUNT_ID);

  it("imports the hull's walk and every mount's point frame by frame", () => {
    for (const team of [0, 1]) {
      const j = joke.bases[team].juggernaut;
      expect(j.walk).toEqual({
        from: 0,
        to: 19,
        mode: 2,
        end: 0,
        link: 0,
        linkB: 0,
        linkC: 0,
        flags: 0,
        period: 775,
        event: 0,
      });
      for (const m of j.mounts) {
        expect(m.frames?.length).toBe(20);
        expect(m.frames?.[0]).toEqual({ x: m.x, y: m.y, z: m.z });
      }
    }
    // Gun 0's point rises and draws back over the stride (pa_models.json by_frame).
    const f = joke.bases[0].juggernaut.mounts[0].frames ?? [];
    expect(f[12].y).toBeCloseTo(1.6621, 3);
    expect(f[12].z).toBeCloseTo(0.207, 3);
  });

  it("walks a frame per 775 world units, by the speed the last move left", () => {
    const state = createSim(joke, 1);
    const j = joke.bases[0].juggernaut;
    const id = spawnUnit(state, ARCHETYPE.JUGGERNAUT, 0, j.x, j.y);
    const walk = state.hullWalk[0];
    if (!walk) throw new Error("no walk");
    expect(walk.index[id]).toBe(0);
    expect(walk.frame[id]).toBe(0);
    expect(walk.clock[id]).toBe(0);
    // 54 world units an engine tick at the top speed, 540 a sim tick.
    const word = Math.floor(ROUTE_TOP_SPEED / ROUTE_SPEED_UNIT + 0.5);
    expect(word).toBe(54);
    // A mirror of cact_anim_step on a looping 0..19 track of period 775.
    let frame = 0;
    let clock = 0;
    let moving = false;
    for (let t = 0; t < 60; t++) {
      step(state, idle);
      clock += moving ? word * FRAME_CLOCK_PER_TICK : 0;
      while (clock > 775) {
        clock -= 775;
        frame = frame === 19 ? 0 : frame + 1;
      }
      moving = Math.hypot(state.ent.velX[id], state.ent.velY[id]) > 0;
      expect(`${t}:${walk.frame[id]}:${walk.clock[id]}`).toBe(`${t}:${frame}:${clock}`);
    }
    // It has walked: 59 ticks of 540 is 41 frames, twice round and one on.
    expect(walk.frame[id]).toBe(41 % 20);
    const out = new Float32Array(GUN_SNAPSHOT_LEN);
    writeGunSnapshot(state, out);
    expect(out[id * GUN_SNAP_STRIDE + GUN_SNAP_HULL_FRAME]).toBe(walk.frame[id]);
    const before = hash(state);
    walk.clock[id] += 1;
    expect(hash(state)).not.toBe(before);
  });

  it("is hit at the radius of the frame its walk shows (SIM_VERSION 88)", () => {
    // Cobj 35's 3DBB box per frame, the halfword at +12, raw / 512 m: the
    // stride's mid-frame (9) is the narrowest, 548 against frame 0's 757.
    const raw = [
      757, 745, 727, 702, 673, 648, 624, 605, 580, 548, 566, 587, 611, 628, 650, 672, 694, 716, 735,
      748,
    ];
    expect(joke.radii.dreadnoughtByFrame).toEqual(raw.map((v) => v / 512));
    expect(joke.radii.dreadnoughtByFrame[0]).toBe(joke.radii.dreadnought);
    const node = joke.laneGraph?.nodes[80];
    if (!node) throw new Error("no node");
    // A ray `off` m to the side of the hull's centre, from 6 m out along a
    // bearing with a clear line at every offset tried.
    const from = (a: number, off: number): [number, number] => [
      node.x - 6 * Math.cos(a) - off * Math.sin(a),
      node.y - 6 * Math.sin(a) + off * Math.cos(a),
    ];
    let a = 0;
    for (let k = 0; k < 16; k++) {
      a = (k * Math.PI) / 8;
      const clear = [0, 1, 1.25].every((off) => {
        const [sx, sy] = from(a, off);
        return !segmentBlocked(joke, sx, sy, sx + 6 * Math.cos(a), sy + 6 * Math.sin(a));
      });
      if (clear) break;
    }
    const at = (frame: number, off: number) => {
      const state = createSim(joke, 1);
      const { id } = parked(state, 0, node.x, node.y);
      const walk = state.hullWalk[0];
      if (!walk) throw new Error("no walk");
      walk.frame[id] = frame;
      expect(entityRadius(state, id)).toBe(raw[frame] / 512);
      const me = state.avatarId[1];
      [state.ent.posX[me], state.ent.posY[me]] = from(a, off);
      const hp = state.ent.hp[id];
      hitscan(state, me, 1, Math.cos(a), Math.sin(a), 12, 10);
      return state.ent.hp[id] < hp;
    };
    expect(at(9, 0)).toBe(true);
    // 1.25 m off: inside frame 0's 1.479 m, outside frame 9's 1.070 m.
    expect(at(0, 1.25)).toBe(true);
    expect(at(9, 1.25)).toBe(false);
    expect(at(9, 1.0)).toBe(true);
    // A static hull keeps its one radius.
    const lc = createSim(map, 1);
    const { id } = parked(lc);
    expect(lc.hullWalk[0]).toBeNull();
    expect(map.radii.dreadnoughtByFrame).toEqual([]);
    expect(entityRadius(lc, id)).toBe(map.radii.dreadnought);
  });

  it("fires each gun from its point in the frame the hull shows", () => {
    const j = joke.bases[0].juggernaut;
    // On the road (a Cnet node in the open), facing a clear 6 m.
    const node = joke.laneGraph?.nodes[80];
    if (!node) throw new Error("no node");
    const hx = node.x;
    const hy = node.y;
    let yaw = 0;
    for (let a = 0; a < 8; a++) {
      yaw = (a * Math.PI) / 4;
      if (!segmentBlocked(joke, hx, hy, hx + 6 * Math.cos(yaw), hy + 6 * Math.sin(yaw))) break;
    }
    const at = (frame: number) => {
      const state = createSim(joke, 1);
      const { id, park } = parked(state, yaw, hx, hy);
      const walk = state.hullWalk[0];
      if (!walk) throw new Error("no walk");
      walk.frame[id] = frame; // parked, the walk stays on it
      const fx = hx + 6 * Math.cos(yaw);
      const fy = hy + 6 * Math.sin(yaw);
      const was = new Uint8Array(state.ent.cap);
      for (let t = 0; t < 60; t++) {
        park();
        const a = state.avatarId[1];
        state.ent.posX[a] = fx;
        state.ent.posY[a] = fy;
        state.ent.height[a] = sampleHeight(state.map, fx, fy);
        state.ent.hp[a] = 1e6;
        for (let p = 0; p < state.ent.high; p++) was[p] = state.ent.alive[p];
        step(state, idle);
        expect(walk.frame[id]).toBe(frame);
        for (let p = 0; p < state.ent.high; p++) {
          if (was[p] || !state.ent.alive[p] || state.ent.archetype[p] !== ARCHETYPE.PROJECTILE) {
            continue;
          }
          // The hull's own (the base ring's turrets stand by its spawn too).
          if (state.roundFrom[p] !== roundSource(ARCHETYPE.JUGGERNAUT, 0)) continue;
          // The round, taken back over its tick of flight, against each gun's
          // muzzle on the frame's point at the gun's yaw.
          const x = state.ent.posX[p] - state.ent.velX[p] * TICK_DT;
          const y = state.ent.posY[p] - state.ent.velY[p] * TICK_DT;
          let best = Number.POSITIVE_INFINITY;
          for (let g = 0; g < DREADNOUGHT_GUNS; g++) {
            const m = j.mounts[g];
            const pt = m.frames?.[frame] ?? m;
            const gy = yaw + gunYawRadians(state.gunYaw[id * DREADNOUGHT_GUNS + g]);
            const px = hx + pt.z * Math.cos(yaw) + pt.x * Math.sin(yaw);
            const py = hy + pt.z * Math.sin(yaw) - pt.x * Math.cos(yaw);
            const mx = px + m.mz * Math.cos(gy) + m.mx * Math.sin(gy);
            const my = py + m.mz * Math.sin(gy) - m.mx * Math.cos(gy);
            best = Math.min(best, Math.hypot(x - mx, y - my));
          }
          return best;
        }
      }
      return -1;
    };
    // Frame 12 stands the front guns 0.35 m further back than frame 0.
    for (const frame of [0, 12]) {
      const d = at(frame);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(0.01);
    }
  });
});
