// The bodies' orientations beyond the yaw (fcop-fidelity.md I6, U1, A19, G1;
// SIM_VERSION 114): the route cursor's own height and the hull's matrix
// (`cnet_route_orient` 0x00424bc0's fourth arm, rebuilt on a tick whose step
// answers bit 1, `cact_pathed_move` 0x00424e1e), Hk's tanks' bank (route flag
// 0x20, 0x00440be6 / 0x00441296), the halted descent (0x004414b0), the
// Dreadnought's guns on the tilted hull, the aircraft's up row
// (`math_matrix_from_forward_up` 0x0043fbc0) and the cockpit's aim
// (`player_partner_tick` 0x004470d0).

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHETYPE } from "../src/archetypes";
import {
  AVATAR_SNAP_AIM_PITCH,
  AVATAR_SNAPSHOT_LEN,
  writeAvatarSnapshot,
} from "../src/avatarSnapshot";
import {
  AIRCRAFT_HEADING_ONE,
  COCKPIT_AIM_PITCH_LIMIT,
  COCKPIT_AIM_STEP,
  TICK_DT,
  WU_PER_METRE,
} from "../src/balance";
import { EV_SHOT, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import {
  getMapById,
  HOLLYWOOD_KEYS_ID,
  LA_CANTINA_ID,
  loadMapFromJson,
  type MapJson,
  sampleHeight,
} from "../src/map";
import {
  bodyFrame,
  createFrame,
  TILT_SNAP_STRIDE,
  TILT_SNAPSHOT_LEN,
  writeTiltSnapshot,
} from "../src/orient";
import { fixedMul, reciprocalSpan } from "../src/route";
import { createSim, type SimState, spawnUnit, step } from "../src/sim";
import { AIR_CRASH, aircraftCrash, surfaceBelow } from "../src/units";

const idle = createTickInputs();

/** A 12-bit angle, signed. */
function s12(v: number): number {
  return (v << 20) >> 20;
}

/** Team `team`'s tank on its base's spawner node. */
function tankAt(state: SimState, team: number): number {
  const b = state.map.bases[team];
  return spawnUnit(state, ARCHETYPE.RUNNER, team, b.tankSpawn.x, b.tankSpawn.y);
}

describe("a route follower stands at the cursor's own height", () => {
  it("the spawn node's height plus the record's bias, then the leg's line", () => {
    const state = createSim(getMapById(LA_CANTINA_ID), 1);
    const id = tankAt(state, 0);
    const c = state.route;
    const bias = state.map.laneGraph?.runnerRoute.bias ?? 0;
    expect(bias).toBe(307);
    // 0x00441899: leg_from.y << 8 plus the bias << 4.
    expect(state.ent.height[id]).toBe(((c.legFrom[id * 3 + 1] << 8) + (bias << 4)) / WU_PER_METRE);
    let checked = 0;
    for (let t = 0; t < 600; t++) {
      step(state, idle);
      if ((c.phase[id] & 3) !== 0 || c.travelled[id] === 0) continue;
      // Off a corner window the height is the leg's straight line (0x004405f4).
      const frac = fixedMul(c.travelled[id], reciprocalSpan(c.legLength[id]) | 0);
      const y = (c.legFrom[id * 3 + 1] << 8) + fixedMul(frac, c.leg[id * 3 + 1]) + (bias << 4);
      expect(state.ent.height[id]).toBe(y / WU_PER_METRE);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("a halted follower sinks to the ground plus its box's lower half", () => {
    const state = createSim(getMapById(LA_CANTINA_ID), 1);
    const id = tankAt(state, 0);
    const ent = state.ent;
    // `terrain_height_at(.., -1)`: the highest surface there (here a deck).
    const ground = surfaceBelow(
      state.map,
      ent.posX[id],
      ent.posY[id],
      Number.POSITIVE_INFINITY,
    ).height;
    expect(ground).toBeGreaterThan(sampleHeight(state.map, ent.posX[id], ent.posY[id]));
    state.route.phase[id] |= 4; // CNET_ROUTE_HALTED
    ent.height[id] = ground + 1;
    step(state, idle);
    // top_speed * dt / 2 = 54 * 10 / 2 world units a tick (0x00441537).
    expect(Math.round((ground + 1 - ent.height[id]) * WU_PER_METRE)).toBe(270);
    for (let t = 0; t < 60; t++) step(state, idle);
    // Mp's tank box 0: centre y -4, half 102, raw / 512 m.
    expect(Math.floor(ent.height[id] * WU_PER_METRE)).toBe(
      Math.floor((ground + (102 + 4) / 512) * WU_PER_METRE),
    );
    const settled = ent.height[id];
    step(state, idle);
    expect(ent.height[id]).toBe(settled);
  });
});

describe("the hull's matrix is the cursor's last orientation", () => {
  it("rebuilt only inside a corner window, kept past it", () => {
    const state = createSim(getMapById("urban-jungle"), 1);
    const id = tankAt(state, 0);
    const c = state.route;
    let stale = 0;
    let pitched = 0;
    for (let t = 0; t < 1500; t++) {
      const yaw = c.hullYaw[id];
      const pitch = c.hullPitch[id];
      step(state, idle);
      if (!state.ent.alive[id]) break;
      if (c.hullYaw[id] !== yaw || c.hullPitch[id] !== pitch) {
        // A rebuild: from the cursor's channels, on a tick inside a window.
        expect(c.phase[id] & 3).not.toBe(0);
        expect(c.hullYaw[id]).toBe(c.yaw[id]);
        expect(c.hullPitch[id]).toBe(c.pitch[id]);
      }
      if (c.hullYaw[id] !== c.yaw[id]) stale++;
      if (s12(c.hullPitch[id]) !== 0) pitched++;
    }
    // The window's exit snaps the cursor and leaves the matrix (0x004406f3).
    expect(stale).toBeGreaterThan(0);
    // Urban-jungle's roads climb and fall: the hull pitches with them.
    expect(pitched).toBeGreaterThan(0);
  });

  it("is drawn and met as math_matrix_from_angles(yaw, pitch, bank)", () => {
    const state = createSim(getMapById(LA_CANTINA_ID), 1);
    const id = tankAt(state, 0);
    state.route.hullYaw[id] = 0;
    state.route.hullPitch[id] = -0x200; // the nose 45 degrees up
    state.route.hullBank[id] = 0;
    const f = createFrame();
    bodyFrame(f, state, id);
    expect(f.az[0]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(f.az[2]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(f.ay[0]).toBeCloseTo(-Math.SQRT1_2, 3);
    expect(f.ay[2]).toBeCloseTo(Math.SQRT1_2, 3);
    // A bank of a quarter turn puts the model's x where its up was.
    state.route.hullPitch[id] = 0;
    state.route.hullBank[id] = 0x400;
    bodyFrame(f, state, id);
    expect(f.ax[2]).toBeCloseTo(1, 3);
    expect(f.ay[1]).toBeCloseTo(-1, 3);
    const out = new Float32Array(TILT_SNAPSHOT_LEN);
    writeTiltSnapshot(state, out);
    expect(out[id * TILT_SNAP_STRIDE + 4]).toBeCloseTo(-1, 3);
    // A turret is its yaw's alone: no row.
    const turret = state.neutralTurretEntity[0];
    for (let k = 0; k < TILT_SNAP_STRIDE; k++) expect(out[turret * TILT_SNAP_STRIDE + k]).toBe(0);
  });
});

describe("the bank (route flag 0x20)", () => {
  it("rolls Hk's tanks into a corner against the turn, and no other arena's", () => {
    for (const [mapId, banks] of [
      [HOLLYWOOD_KEYS_ID, true],
      [LA_CANTINA_ID, false],
    ] as const) {
      const state = createSim(getMapById(mapId), 1);
      const ids = [tankAt(state, 0), tankAt(state, 1)];
      const c = state.route;
      let most = 0;
      for (let t = 0; t < 1500; t++) {
        step(state, idle);
        for (const id of ids) {
          if (!state.ent.alive[id]) continue;
          if (c.bankPeak[id] !== 0) {
            // -3/8 of the corner's yaw: the opposite sign to the turn.
            expect(Math.sign(c.bankPeak[id])).toBe(-Math.sign(c.yawTurn[id]));
          }
          most = Math.max(most, Math.abs(s12(c.hullBank[id])));
        }
      }
      if (banks) expect(most).toBeGreaterThan(0x40);
      else expect(most).toBe(0);
    }
  });

  it("is refused at load where the record would take an arm the port lacks", () => {
    const path = join(import.meta.dir, "..", "maps", "la-cantina.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as MapJson;
    expect(raw.laneGraph?.routes).toEqual({ runner: [0, 307], juggernaut: [8, 204] });
    const graph = raw.laneGraph as NonNullable<MapJson["laneGraph"]>;
    graph.routes = { runner: [0x100, 307], juggernaut: [8, 204] };
    expect(() => loadMapFromJson(raw)).toThrow(/not modelled/);
  });
});

describe("the Dreadnought's guns stand on the tilted hull", () => {
  /** Rounds from a team-0 Dreadnought parked on open ground, its hull pitched. */
  function shots(pitch: number): number {
    const state = createSim(getMapById(LA_CANTINA_ID), 1);
    const ent = state.ent;
    const x = 152;
    const y = 128;
    const id = spawnUnit(state, ARCHETYPE.JUGGERNAUT, 0, x, y);
    const foe = state.avatarId[1];
    ent.hp[foe] = 1e6;
    let n = 0;
    for (let k = 0; k < 61; k++) {
      ent.posX[id] = x;
      ent.posY[id] = y;
      ent.yaw[id] = 0;
      state.route.hullYaw[id] = 0;
      state.route.hullPitch[id] = pitch;
      state.route.hullBank[id] = 0;
      ent.height[id] = sampleHeight(state.map, x, y);
      ent.timerA[id] = -1;
      ent.posX[foe] = x + 4;
      ent.posY[foe] = y;
      ent.velX[foe] = 0;
      ent.velY[foe] = 0;
      step(state, idle);
      for (let i = 0; i < state.events.count; i++) {
        const o = i * EVENT_STRIDE;
        if (state.events.data[o] === EV_SHOT && state.events.data[o + 1] === id) n++;
      }
    }
    return n;
  }

  it("level, every gun fires; the nose 30 degrees up, the foe is under every arc", () => {
    expect(shots(0)).toBe(4);
    expect(shots(-0x155)).toBe(0);
  });
});

describe("a route follower's muzzle", () => {
  it("is its model's point 0 through its hull's matrix (0x0044d98d)", () => {
    const state = createSim(getMapById(LA_CANTINA_ID), 1);
    const ent = state.ent;
    const id = tankAt(state, 0);
    ent.hp[id] = 1e6;
    const foe = state.avatarId[1];
    ent.hp[foe] = 1e6;
    const muzzle = state.map.shapes.tank?.muzzles[0];
    expect(muzzle).toEqual([0.003906, 0.154297, -0.105469]);
    const was = new Uint8Array(ent.cap);
    const f = createFrame();
    let checked = 0;
    for (let t = 0; t < 600 && checked < 3; t++) {
      // The foe 6 m ahead of the tank, where it can be shot.
      ent.posX[foe] = ent.posX[id] + 6 * Math.cos(ent.yaw[id]);
      ent.posY[foe] = ent.posY[id] + 6 * Math.sin(ent.yaw[id]);
      ent.height[foe] = sampleHeight(state.map, ent.posX[foe], ent.posY[foe]);
      for (let p = 0; p < ent.high; p++) was[p] = ent.alive[p];
      step(state, idle);
      for (let p = 0; p < ent.high; p++) {
        if (was[p] || !ent.alive[p] || ent.archetype[p] !== ARCHETYPE.PROJECTILE) continue;
        if (ent.team[p] !== 0) continue;
        // The round, taken back over its one tick of flight.
        bodyFrame(f, state, id);
        const [x, y, z] = muzzle as readonly number[];
        const mx = ent.posX[id] - x * f.ax[0] + y * f.ay[0] + z * f.az[0];
        const my = ent.posY[id] - x * f.ax[1] + y * f.ay[1] + z * f.az[1];
        expect(ent.posX[p] - ent.velX[p] * TICK_DT).toBeCloseTo(mx, 4);
        expect(ent.posY[p] - ent.velY[p] * TICK_DT).toBeCloseTo(my, 4);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("the aircraft's muzzles", () => {
  /** Rounds from team 0's `arch` over la-cantina, the foe held under it: [x, y, side]. */
  function rounds(
    arch: number,
    want: number,
  ): { x: number; y: number; mx: number[][]; side: number }[] {
    const state = createSim(getMapById(LA_CANTINA_ID), 1);
    const ent = state.ent;
    const b = state.map.bases[0];
    const id = spawnUnit(state, arch, 0, b.tankSpawn.x + 20, b.tankSpawn.y - 20);
    ent.hp[id] = 1e6;
    const foe = state.avatarId[1];
    ent.hp[foe] = 1e6;
    const shape = arch === ARCHETYPE.FORTRESS ? state.map.shapes.fortress : state.map.shapes.jet;
    const was = new Uint8Array(ent.cap);
    const f = createFrame();
    const out: { x: number; y: number; mx: number[][]; side: number }[] = [];
    for (let t = 0; t < 3000 && out.length < want; t++) {
      ent.posX[foe] = ent.posX[id] + 4;
      ent.posY[foe] = ent.posY[id];
      ent.height[foe] = sampleHeight(state.map, ent.posX[foe], ent.posY[foe]);
      for (let p = 0; p < ent.high; p++) was[p] = ent.alive[p];
      step(state, idle);
      for (let p = 0; p < ent.high; p++) {
        if (was[p] || !ent.alive[p] || ent.archetype[p] !== ARCHETYPE.PROJECTILE) continue;
        if (ent.team[p] !== 0) continue;
        bodyFrame(f, state, id);
        const mx = (shape?.muzzles ?? []).map(([x, y, z]) => [
          ent.posX[id] - x * f.ax[0] + y * f.ay[0] + z * f.az[0],
          ent.posY[id] - x * f.ax[1] + y * f.ay[1] + z * f.az[1],
        ]);
        out.push({
          x: ent.posX[p] - ent.velX[p] * TICK_DT,
          y: ent.posY[p] - ent.velY[p] * TICK_DT,
          mx,
          side: state.shooterMuzzle[id],
        });
      }
    }
    return out;
  }

  it("the Flying Fortress fires from its points 0 and 1 in turn (ALTERNATE 0x220)", () => {
    expect(getMapById(LA_CANTINA_ID).weapons.filter((w) => w.alternate === 1).length).toBe(1);
    const got = rounds(ARCHETYPE.FORTRESS, 4);
    expect(got.length).toBe(4);
    for (const [i, r] of got.entries()) {
      // +0x23 flipped as the round came due: 1, 0, 1, 0 from the spawn's 0.
      expect(r.side).toBe(i % 2 === 0 ? 1 : 0);
      expect(r.x).toBeCloseTo(r.mx[r.side][0], 3);
      expect(r.y).toBeCloseTo(r.mx[r.side][1], 3);
    }
    // The two points are a wing apart: the rounds alternate across the craft.
    expect(Math.hypot(got[0].x - got[1].x, got[0].y - got[1].y)).toBeGreaterThan(1);
  });

  it("the jet fires from its point 0 (0x202)", () => {
    const got = rounds(ARCHETYPE.GUARDIAN, 2);
    expect(got.length).toBe(2);
    for (const r of got) {
      expect(r.side).toBe(0);
      expect(r.x).toBeCloseTo(r.mx[0][0], 3);
      expect(r.y).toBeCloseTo(r.mx[0][1], 3);
    }
  });

  it("the Sky Captain's gun and missile alternate, its bomb does not", () => {
    const state = createSim(getMapById(LA_CANTINA_ID), 0xc0ffee, {
      wardenPlayer: 1,
      wardenDifficulty: 8,
    });
    const c = state.captain;
    const flips = [0, 0, 0];
    for (let t = 0; t < 3000; t++) {
      const before = [c.muzzle[0], c.muzzle[1], c.muzzle[2]];
      step(state, idle);
      for (let k = 0; k < 3; k++) if (c.muzzle[k] !== before[k]) flips[k]++;
    }
    expect(flips[0]).toBeGreaterThan(0);
    expect(flips[1]).toBeGreaterThan(0);
    expect(flips[2]).toBe(0);
    expect(state.map.shapes.skyCaptain[0].muzzles.length).toBe(2);
  });
});

describe("the aircraft's up row", () => {
  it("is the matrix's row 1 in flight and turns on from itself in the crash", () => {
    const state = createSim(getMapById(LA_CANTINA_ID), 1);
    const b = state.map.bases[0];
    const id = spawnUnit(state, ARCHETYPE.GUARDIAN, 0, b.tankSpawn.x, b.tankSpawn.y);
    const air = state.air;
    const one = AIRCRAFT_HEADING_ONE;
    const check = () => {
      const u = [air.ux[id], air.uy[id], air.uz[id]];
      const h = [air.hx[id], air.hy[id], air.hz[id]];
      expect(Math.hypot(u[0], u[1], u[2]) / one).toBeCloseTo(1, 3);
      expect((u[0] * h[0] + u[1] * h[1] + u[2] * h[2]) / one / one).toBeCloseTo(0, 3);
      expect(air.upY[id]).toBe(Math.abs(air.uy[id]));
    };
    for (let t = 0; t < 300; t++) {
      step(state, idle);
      check();
    }
    aircraftCrash(state, id, 1024);
    air.phase[id] = AIR_CRASH;
    let prev = [air.ux[id], air.uy[id], air.uz[id]];
    let turned = 0;
    for (let t = 0; t < 30 && state.ent.alive[id] && air.phase[id] === AIR_CRASH; t++) {
      step(state, idle);
      if (!state.ent.alive[id] || air.phase[id] !== AIR_CRASH) break;
      check();
      const u = [air.ux[id], air.uy[id], air.uz[id]];
      const dot = (u[0] * prev[0] + u[1] * prev[1] + u[2] * prev[2]) / one / one;
      // The last row biased by 1/8 toward world up: no snap from tick to tick.
      expect(dot).toBeGreaterThan(0.7);
      if (dot < 0.99999) turned++;
      prev = u;
    }
    expect(turned).toBeGreaterThan(0);
  });
});

describe("the cockpit's aim", () => {
  it("steps toward a lock above, 0x18 a tick, to its limit, and the snapshot carries it", () => {
    const state = createSim(getMapById(LA_CANTINA_ID), 1);
    const ent = state.ent;
    const a = state.avatarId[0];
    const foe = state.avatarId[1];
    const place = () => {
      ent.posX[foe] = ent.posX[a] + 3 * Math.cos(ent.yaw[a]);
      ent.posY[foe] = ent.posY[a] + 3 * Math.sin(ent.yaw[a]);
      ent.height[foe] = ent.height[a] + 6;
      ent.hp[foe] = 1e6;
    };
    place();
    step(state, idle);
    expect(state.lockTarget[0]).toBe(foe);
    expect(state.cockpitAim.pitch[0]).toBe(-COCKPIT_AIM_STEP);
    for (let t = 0; t < 30; t++) {
      place();
      step(state, idle);
    }
    // Over 60 degrees up: the pitch holds at its limit.
    expect(state.cockpitAim.pitch[0]).toBe(-COCKPIT_AIM_PITCH_LIMIT);
    const snap = new Float32Array(AVATAR_SNAPSHOT_LEN);
    writeAvatarSnapshot(state, snap);
    expect(snap[AVATAR_SNAP_AIM_PITCH]).toBe(-COCKPIT_AIM_PITCH_LIMIT);
  });
});
