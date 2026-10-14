// The original's lifts (fcop-fidelity.md P12; RE `camera-and-movement.md`
// "Lifts", `precinct-assault.md` "The bases' floors, lifts and spawn guards"),
// on a small fixture built like Slim's spawn shaft: a lift parked on the ground
// with Slim's own numbers (stops 0 and 921 raw, 13 / 21 wu an engine tick, a
// 1.5 s dwell at the top), a 2 m deck beside it, and a wall on the ground
// between the two, so the deck is reached only from the raised lift.

import { describe, expect, it } from "bun:test";
import { FLOOR_DAMAGE_PER_STEP, HOVER_CLEARANCE } from "../src/balance";
import { EV_HIT, EV_LIFT_ARRIVE, EV_LIFT_START, EVENT_STRIDE } from "../src/events";
import { BUTTON_INTERACT, createTickInputs, type TickInputs } from "../src/inputs";
import { loadMapFromJson, type MapJson } from "../src/map";
import {
  createSim,
  hash,
  LIFT_DWELL,
  LIFT_MOVING,
  LIFT_PARKED,
  LIFT_SNAP_MOVING,
  LIFT_SNAP_STRIDE,
  LIFT_SNAP_TOP,
  liftTopHeight,
  MODE_HOVER,
  type SimState,
  step,
  writeLiftSnapshot,
} from "../src/sim";

/** Slim's lift 249 in sim ticks: 10 engine ticks a tick. */
const STOP_TOP = 921 << 4;
const UP = 13 * 10;
const DOWN = 21 * 10;
const DWELL = 45;
const TOP = 0.296875;
/** Ticks from the press to the top stop, and from leaving it to the bottom. */
const RISE_TICKS = Math.ceil(STOP_TOP / UP);
const FALL_TICKS = Math.ceil(STOP_TOP / DOWN);

/**
 * 8 x 8 m, ground 0. The lift's face covers x 1..3, y 3..5 (centre (2, 4)).
 * Deck 1 covers columns 3..7 at 2.0 m; the ground's lattice walls the x = 3
 * line, the deck's does not.
 */
function shaft(hurtsTeam = -1): MapJson {
  const size = 8;
  const flat = (v: number) =>
    Array.from({ length: size }, () => Array.from({ length: size }, () => v));
  const none = Array.from({ length: size }, () => "0".repeat(size));
  return {
    id: "t-lift",
    size,
    cellSize: 1,
    waterLevel: -10,
    heights: flat(0),
    water: none,
    wallsV: Array.from({ length: size }, () => "00010000"),
    wallsH: none,
    layers: [
      {
        heights: flat(64),
        mask: Array.from({ length: size }, () => "00011111"),
        wallsV: none,
        wallsH: none,
      },
    ],
    spawns: [
      { x: 2, y: 4, yaw: 0 },
      { x: 6, y: 7, yaw: 0 },
    ],
    basePlots: [
      { x: 2, y: 4, radius: 1 },
      { x: 6, y: 7, radius: 1 },
    ],
    bases: [
      {
        gate: { x: 2, y: 2, radius: 1 },
        core: [2, 4],
        groundConsole: [2, 4],
        airConsole: [2, 4],
        turrets: [],
      },
      {
        gate: { x: 6, y: 6, radius: 1 },
        core: [6, 7],
        groundConsole: [6, 7],
        airConsole: [6, 7],
        turrets: [],
      },
    ],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
    lifts: [
      {
        x: 2,
        y: 4,
        x0: 1.0566,
        x1: 2.9434,
        y0: 3.0566,
        y1: 4.9434,
        ground: 0,
        top: TOP,
        stops: [0, STOP_TOP],
        up: UP,
        down: DOWN,
        dwell: [0, DWELL],
        start: 0,
        hurtsTeam,
        layers: [0, 1],
        model: 87,
        yaw: 0,
      },
    ],
  };
}

const idle = createTickInputs();

function press(): TickInputs {
  const t = createTickInputs();
  t.players[0].buttons = BUTTON_INTERACT;
  return t;
}

function drive(state: SimState, moveX: number, ticks: number): void {
  const t = createTickInputs();
  t.players[0].moveX = moveX;
  for (let i = 0; i < ticks; i++) step(state, t);
}

function events(state: SimState, kind: number): number[][] {
  const out: number[][] = [];
  const d = state.events.data;
  for (let i = 0; i < state.events.count; i++) {
    const o = i * EVENT_STRIDE;
    if (d[o] === kind) out.push([d[o + 1], d[o + 2], d[o + 3]]);
  }
  return out;
}

/** Steps until the lift reports `kind`, returning the ticks taken (or -1). */
function untilEvent(state: SimState, kind: number, limit: number): number {
  for (let t = 1; t <= limit; t++) {
    step(state, idle);
    if (events(state, kind).length > 0) return t;
  }
  return -1;
}

describe("lifts (fcop-fidelity.md P12)", () => {
  it("parks at its first stop with the spawned mech on its top", () => {
    const state = createSim(loadMapFromJson(shaft()), 1);
    const a = state.avatarId[0];
    expect(state.liftPhase[0]).toBe(LIFT_PARKED);
    expect(liftTopHeight(state, 0)).toBeCloseTo(TOP, 6);
    expect(state.ent.height[a]).toBeCloseTo(TOP, 6);
    for (let t = 0; t < 60; t++) step(state, idle);
    expect(state.liftWu[0]).toBe(0);
    expect(state.avatarLift[0]).toBe(0);
    expect(state.ent.height[a]).toBeCloseTo(TOP, 6);
  });

  it("stays parked for a press off its top", () => {
    const state = createSim(loadMapFromJson(shaft()), 1);
    const a = state.avatarId[0];
    state.ent.posX[a] = 0.5;
    state.ent.height[a] = 0;
    step(state, idle);
    step(state, press());
    expect(state.avatarLift[0]).toBe(-1);
    expect(state.liftPhase[0]).toBe(LIFT_PARKED);
    expect(events(state, EV_LIFT_START).length).toBe(0);
  });

  it("rises on its rider's press, dwells 1.5 s at the top and comes back down", () => {
    const state = createSim(loadMapFromJson(shaft()), 1);
    const a = state.avatarId[0];
    step(state, idle);
    step(state, press());
    expect(events(state, EV_LIFT_START)).toEqual([[0, 1, 0]]);
    expect(state.liftPhase[0]).toBe(LIFT_MOVING);
    expect(state.liftWu[0]).toBe(UP);
    // 3.8 s up (Slim: 0.48 m/s), carrying its rider.
    expect(untilEvent(state, EV_LIFT_ARRIVE, 200) + 1).toBe(RISE_TICKS);
    expect(events(state, EV_LIFT_ARRIVE)).toEqual([[0, 1, 0]]);
    expect(state.liftWu[0]).toBe(STOP_TOP);
    expect(state.liftPhase[0]).toBe(LIFT_DWELL);
    expect(state.ent.height[a]).toBeCloseTo(STOP_TOP / 8192 + TOP, 5);
    // 1.5 s at the top, then down by itself at 0.77 m/s (2.3 s).
    expect(untilEvent(state, EV_LIFT_START, 100)).toBe(DWELL);
    expect(events(state, EV_LIFT_START)).toEqual([[0, 0, 0]]);
    expect(untilEvent(state, EV_LIFT_ARRIVE, 200) + 1).toBe(FALL_TICKS);
    expect(state.liftWu[0]).toBe(0);
    expect(state.liftPhase[0]).toBe(LIFT_PARKED);
    expect(state.avatarLift[0]).toBe(0);
    expect(state.ent.height[a]).toBeCloseTo(TOP, 5);
    // Parked again: it waits for the next press.
    for (let t = 0; t < 90; t++) step(state, idle);
    expect(state.liftWu[0]).toBe(0);
  });

  it("keeps its rider grounded all the way, walker and hover", () => {
    for (const hover of [false, true]) {
      const state = createSim(loadMapFromJson(shaft()), 1);
      const a = state.avatarId[0];
      if (hover) {
        state.ent.mode[a] = MODE_HOVER;
        state.ent.height[a] = TOP + HOVER_CLEARANCE;
      }
      step(state, idle);
      step(state, press());
      const ride = hover ? HOVER_CLEARANCE : 0;
      for (let t = 0; t < RISE_TICKS + DWELL + FALL_TICKS; t++) {
        step(state, idle);
        expect(state.avatarLift[0]).toBe(0);
        expect(state.ent.timerB[a]).toBe(0); // no fall speed: never airborne
        expect(state.ent.height[a]).toBeCloseTo(liftTopHeight(state, 0) + ride, 5);
      }
    }
  });

  it("lets its rider out onto the deck at the top, and not at the bottom", () => {
    const bottom = createSim(loadMapFromJson(shaft()), 1);
    const a = bottom.avatarId[0];
    drive(bottom, 127, 60);
    expect(bottom.ent.posX[a]).toBeLessThan(3);
    expect(bottom.ent.entLayer[a]).toBe(0);

    const top = createSim(loadMapFromJson(shaft()), 1);
    const b = top.avatarId[0];
    step(top, idle);
    step(top, press());
    untilEvent(top, EV_LIFT_ARRIVE, 200);
    drive(top, 127, 30);
    expect(top.ent.posX[b]).toBeGreaterThan(3.5);
    expect(top.ent.entLayer[b]).toBe(1);
    expect(top.ent.height[b]).toBeCloseTo(2, 3);
    expect(top.avatarLift[0]).toBe(-1);
  });

  it("steps its rider back on from the ground over its rim", () => {
    const state = createSim(loadMapFromJson(shaft()), 1);
    const a = state.avatarId[0];
    state.ent.posX[a] = 0.4;
    state.ent.height[a] = 0;
    step(state, idle);
    expect(state.avatarLift[0]).toBe(-1);
    drive(state, 127, 15);
    expect(state.ent.posX[a]).toBeGreaterThan(1.2);
    expect(state.avatarLift[0]).toBe(0);
    expect(state.ent.height[a]).toBeCloseTo(TOP, 5);
  });

  it("hurts the enemy mech on a tagged top as its base's floor does, and no one else", () => {
    const hits = (team: number): number => {
      const state = createSim(loadMapFromJson(shaft(team)), 1);
      const a = state.avatarId[0];
      let sum = 0;
      for (let t = 0; t < 4; t++) {
        step(state, idle);
        const d = state.events.data;
        for (let i = 0; i < state.events.count; i++) {
          const o = i * EVENT_STRIDE;
          if (d[o] === EV_HIT && d[o + 1] === a && d[o + 2] === -1) sum += d[o + 3];
        }
      }
      return sum;
    };
    // Four ticks are five movement steps (1, 1, 1, 2).
    expect(hits(0)).toBe(5 * FLOOR_DAMAGE_PER_STEP);
    expect(hits(1)).toBe(0);
    expect(hits(-1)).toBe(0);
  });

  it("is hashed, and reported by its snapshot", () => {
    const state = createSim(loadMapFromJson(shaft()), 1);
    step(state, idle);
    const out = new Float32Array(LIFT_SNAP_STRIDE);
    writeLiftSnapshot(state, out);
    expect(out[LIFT_SNAP_TOP]).toBeCloseTo(TOP, 6);
    expect(out[LIFT_SNAP_MOVING]).toBe(0);
    const before = hash(state);
    state.liftWu[0] += 1;
    expect(hash(state)).not.toBe(before);
    state.liftWu[0] -= 1;
    step(state, press());
    writeLiftSnapshot(state, out);
    expect(out[LIFT_SNAP_MOVING]).toBe(1);
    expect(out[LIFT_SNAP_TOP]).toBeCloseTo(TOP + UP / 8192, 6);
  });

  it("rejects a lift whose stops do not climb", () => {
    const bad = shaft();
    bad.lifts = [{ ...(bad.lifts ?? [])[0], stops: [STOP_TOP, 0] }];
    expect(() => loadMapFromJson(bad)).toThrow(/ascending/);
  });
});
