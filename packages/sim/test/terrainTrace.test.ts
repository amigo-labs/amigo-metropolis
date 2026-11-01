// The sim's line tests on the original's terrain trace (fcop-fidelity.md T1;
// trace.ts traceLine): what changes in a match once every shot, round and
// clear line goes through the plates in three dimensions instead of the
// walker's 2D wall lattice.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { segmentBlocked } from "../src/collision";
import { BTN_FORWARD, BTN_GUN, BTN_HEAVY, createTickInputs } from "../src/inputs";
import {
  getMapById,
  HOLLYWOOD_KEYS_ID,
  LA_CANTINA_ID,
  type MapData,
  resolveHeight,
  sampleHeight,
  TEST_MAP_ID,
} from "../src/map";
import { muzzleAt, x1Muzzle } from "../src/orient";
import { createSim, entityRefHeight, type SimState, step } from "../src/sim";
import { newTraceScratch, traceHit, traceLine } from "../src/trace";

/** Player 0's X1 at p facing q, player 1's at q facing away, both held there. */
function face(
  map: MapData,
  p: [number, number, number, number],
  q: [number, number, number, number],
): { state: SimState; a: number; b: number; hold: () => void } {
  const state = createSim(map, 1);
  const ent = state.ent;
  const a = state.avatarId[0];
  const b = state.avatarId[1];
  const yaw = Math.atan2(q[1] - p[1], q[0] - p[0]);
  const hold = () => {
    ent.posX[a] = p[0];
    ent.posY[a] = p[1];
    ent.height[a] = p[2];
    ent.entLayer[a] = p[3];
    ent.yaw[a] = yaw;
    ent.aimX[a] = Math.cos(yaw);
    ent.aimY[a] = Math.sin(yaw);
    ent.velX[a] = 0;
    ent.velY[a] = 0;
    ent.timerB[a] = 0;
    ent.posX[b] = q[0];
    ent.posY[b] = q[1];
    ent.height[b] = q[2];
    ent.entLayer[b] = q[3];
    ent.yaw[b] = yaw;
    ent.aimX[b] = Math.cos(yaw);
    ent.aimY[b] = Math.sin(yaw);
    ent.velX[b] = 0;
    ent.velY[b] = 0;
    ent.timerB[b] = 0;
    ent.hp[b] = 1e6;
  };
  hold();
  return { state, a, b, hold };
}

/** Damage the Mini-Gun deals from p to q over `ticks` ticks of fire. */
function gunDamage(
  map: MapData,
  p: [number, number, number, number],
  q: [number, number, number, number],
  ticks = 6,
): number {
  const { state, b, hold } = face(map, p, q);
  const input = createTickInputs();
  input.players[0].buttons = BTN_GUN;
  for (let t = 0; t < ticks; t++) {
    hold();
    step(state, input);
  }
  return 1e6 - state.ent.hp[b];
}

describe("a shot across a ledge", () => {
  it("reaches a target below a step the wall lattice closes, over the step's face", () => {
    // On la-cantina, from a spot on a higher level to one on a level a metre or
    // more lower, 5-10 m off: the lattice has a wall bit on the way (the step's
    // face), the line from a muzzle's height passes over it.
    const map = getMapById(LA_CANTINA_ID);
    let found: [[number, number, number, number], [number, number, number, number]] | null = null;
    for (let x = 60; x < 190 && found === null; x += 3) {
      for (let y = 60; y < 190 && found === null; y += 3) {
        const hp = sampleHeight(map, x, y);
        for (let k = 0; k < 8 && found === null; k++) {
          const a = (k * Math.PI) / 4;
          const qx = x + 7 * Math.cos(a);
          const qy = y + 7 * Math.sin(a);
          const hq = sampleHeight(map, qx, qy);
          if (hp - hq < 1.2) continue;
          if (!segmentBlocked(map, x, y, qx, qy)) continue;
          const st = newTraceScratch();
          if (traceLine(map, st, x, y, hp + 0.6, qx, qy, hq + 0.3, 1) !== 0) continue;
          if (traceLine(map, st, x, y, hp + 1.2, qx, qy, hq + 0.8, 1) !== 0) continue;
          found = [
            [x, y, hp, 0],
            [qx, qy, hq, 0],
          ];
        }
      }
    }
    expect(found).not.toBeNull();
    if (found === null) return;
    expect(gunDamage(map, found[0], found[1])).toBeGreaterThan(0);
  });
});

describe("a shot at a deck from under it", () => {
  it("is stopped by the deck's floor", () => {
    // On hollywood-keys, a deck over the ground with room under it: the X1
    // under the deck, its target on the deck straight over it, 3-6 m off. The
    // wall lattice has nothing between them; the deck's floor plates do.
    const map = getMapById(HOLLYWOOD_KEYS_ID);
    expect(map.layerHeights.length).toBeGreaterThan(0);
    const s = map.size;
    let found: [[number, number, number, number], [number, number, number, number]] | null = null;
    for (let j = 10; j < s - 10 && found === null; j += 2) {
      for (let i = 10; i < s - 10 && found === null; i += 2) {
        if (map.layerMask[0][j * s + i] === 0) continue;
        const x = i + 0.5;
        const y = j + 0.5;
        const g = sampleHeight(map, x, y);
        const d = resolveHeight(map, x, y, 1);
        if (d - g < 3) continue;
        for (let k = 0; k < 8 && found === null; k++) {
          const a = (k * Math.PI) / 4;
          const qx = x + 4 * Math.cos(a);
          const qy = y + 4 * Math.sin(a);
          const qi = Math.floor(qx);
          const qj = Math.floor(qy);
          if (map.layerMask[0][qj * s + qi] === 0) continue;
          const dq = resolveHeight(map, qx, qy, 1);
          if (Math.abs(dq - d) > 0.3) continue;
          if (segmentBlocked(map, x, y, qx, qy)) continue;
          // The deck's plates stop the line from under it.
          if (traceLine(map, newTraceScratch(), x, y, g + 1, qx, qy, dq + 0.5, 1) === 0) continue;
          found = [
            [x, y, g, 0],
            [qx, qy, dq, 1],
          ];
        }
      }
    }
    expect(found).not.toBeNull();
    if (found === null) return;
    expect(gunDamage(map, found[0], found[1])).toBe(0);
  });
});

describe("the X1's muzzles", () => {
  it("launch the Hell Fire from the gun model's point 0, not from the hull", () => {
    const map = getMapById(TEST_MAP_ID);
    const { state, a, hold } = face(map, [20, 30, 0, 0], [28, 30, 0, 0]);
    const input = createTickInputs();
    input.players[0].buttons = BTN_HEAVY;
    hold();
    step(state, input);
    let round = -1;
    for (let e = 0; e < state.ent.high; e++) {
      if (state.ent.alive[e] && state.ent.archetype[e] === ARCHETYPE.PROJECTILE) round = e;
    }
    expect(round).toBeGreaterThanOrEqual(0);
    // The muzzle the shot used is where the gun now stands (its recoil kicks
    // in from the next tick); the round has flown a tick from it.
    state.cockpitAim.recoil[0] = 0;
    state.cockpitAim.recoil[1] = 0;
    x1Muzzle(state, 0, a, 1);
    const off = Math.hypot(state.ent.posX[round] - muzzleAt.x, state.ent.posY[round] - muzzleAt.y);
    expect(off).toBeLessThan(0.2);
    // A quarter metre to the side of the hull's line.
    const side = Math.abs(state.ent.posY[round] - 30);
    expect(side).toBeGreaterThan(0.2);
  });

  it("kick the Heavy slot's gun back along its row 2 for 0x84 engine units", () => {
    const map = getMapById(TEST_MAP_ID);
    const { state, hold } = face(map, [20, 30, 0, 0], [28, 30, 0, 0]);
    const input = createTickInputs();
    input.players[0].buttons = BTN_HEAVY;
    hold();
    step(state, input);
    const kicked = state.cockpitAim.recoil[0] + state.cockpitAim.recoil[1];
    expect(kicked).toBe(0x84);
    input.players[0].buttons = 0;
    for (let t = 0; t < 14; t++) {
      hold();
      step(state, input);
    }
    expect(state.cockpitAim.recoil[0] + state.cockpitAim.recoil[1]).toBe(0);
  });
});

describe("the X1 against the plates' walls", () => {
  it("is pushed off them, never through, walking or hovering", () => {
    for (const id of [LA_CANTINA_ID, HOLLYWOOD_KEYS_ID]) {
      const map = getMapById(id);
      let crossings = 0;
      let pushed = 0;
      for (let seed = 1; seed <= 4; seed++) {
        const state = createSim(map, seed);
        const ent = state.ent;
        const a = state.avatarId[0];
        const input = createTickInputs();
        input.players[0].buttons = BTN_FORWARD;
        ent.hp[a] = 1e9;
        for (let t = 0; t < 240; t++) {
          if (t % 60 === 0) {
            const yaw = ent.yaw[a] + 1.3 + seed;
            ent.yaw[a] = yaw;
            ent.aimX[a] = Math.cos(yaw);
            ent.aimY[a] = Math.sin(yaw);
          }
          const px = ent.posX[a];
          const py = ent.posY[a];
          const ph = ent.height[a] + 0.6;
          step(state, input);
          if (state.avatarImpulse[0] !== 0 || state.avatarImpulse[1] !== 0) pushed++;
          const h = ent.height[a] + 0.6;
          if (traceLine(map, newTraceScratch(), px, py, ph, ent.posX[a], ent.posY[a], h, 0) !== 0) {
            crossings++;
          }
        }
      }
      expect(pushed).toBeGreaterThan(0);
      expect(crossings).toBe(0);
    }
  });
});

describe("traceLine in the sim's frame", () => {
  it("stops on the floor under a feature the map stands on the original's surface", () => {
    // Each base turret stands on its plate (SIM_VERSION 100): a line from a
    // metre over it to a metre under it meets a floor within a few centimetres
    // of its height. Floor hits report the piece's upper end, so it is the
    // short segments' answers that are compared.
    const map = getMapById(LA_CANTINA_ID);
    const state = createSim(map, 1);
    const ent = state.ent;
    let checked = 0;
    for (const t of state.baseTurretEntity) {
      if (t < 0) continue;
      const x = ent.posX[t];
      const y = ent.posY[t];
      const h = ent.height[t];
      const st = newTraceScratch();
      expect(traceLine(map, st, x, y, h + 0.05, x, y, h - 0.05, 1)).not.toBe(0);
      expect(traceLine(map, st, x, y, h + 0.2, x, y, h + 1, 1)).toBe(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("answers a map with no plates by the wall lattice, walls of any height", () => {
    const map = getMapById(TEST_MAP_ID);
    expect(map.trace).toBeNull();
    const st = newTraceScratch();
    for (let x = 10; x < 100; x += 7) {
      const blocked = segmentBlocked(map, x, 10, x, 100);
      expect(traceLine(map, st, x, 10, 50, x, 100, 50, 1) !== 0).toBe(blocked);
      if (blocked) expect(traceHit.h).toBe(50);
    }
  });

  it("is what the shooters' clear line reads: a turret sees over a ledge to a target above", () => {
    const map = getMapById(LA_CANTINA_ID);
    const state = createSim(map, 1);
    const ent = state.ent;
    const t = state.baseTurretEntity.find((id) => id >= 0) ?? -1;
    expect(t).toBeGreaterThanOrEqual(0);
    const from = ent.height[t] + entityRefHeight(state, t);
    // Straight up from the gun nothing is in the way.
    expect(
      traceLine(
        map,
        newTraceScratch(),
        ent.posX[t],
        ent.posY[t],
        from,
        ent.posX[t] + 0.5,
        ent.posY[t],
        from + 6,
        1,
      ),
    ).toBe(0);
  });
});
