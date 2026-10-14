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
import {
  BUG_HUNT_ID,
  getMapById,
  loadMapFromJson,
  type MapJson,
  PROVING_GROUND_ID,
  URBAN_JUNGLE_ID,
} from "../src/map";
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

describe("the spawn lifts of Slim and Joke (fcop-fidelity.md P12)", () => {
  // Each mech spawns at the foot of a shaft on its lift. The way out is the
  // original's: press, ride up to the base's platform, and walk down the ramp
  // to the consoles and through the gate. Driven here as a player would, by
  // the stick toward each waypoint in turn.
  type Waypoint = [number, number] | "ride";
  const ROUTES: Waypoint[][] = [
    [
      "ride",
      [104, 66.5],
      [104, 67.5],
      [104, 68.5],
      [104, 69.5],
      [104, 70.5],
      [104, 71.5],
      [103, 73.5],
      [105.7, 76.5],
    ],
    [
      "ride",
      [136, 173.5],
      [136, 172.5],
      [136, 171.5],
      [136, 170.5],
      [136, 169.5],
      [136, 168.5],
      [137, 166.5],
      [134.7, 164.5],
    ],
  ];

  function drivesOut(mapId: string, player: number): string {
    const map = getMapById(mapId);
    const state = createSim(map, 1);
    const a = state.avatarId[player];
    const input = createTickInputs();
    const route = ROUTES[player];
    let w = 0;
    for (let t = 0; t < 30 * 40 && w < route.length; t++) {
      const wp = route[w];
      const pi = input.players[player];
      pi.moveX = 0;
      pi.moveY = 0;
      pi.buttons = 0;
      if (wp === "ride") {
        pi.buttons = t % 2 === 0 ? BUTTON_INTERACT : 0;
        step(state, input);
        if (events(state, EV_LIFT_ARRIVE).some((e) => e[1] > 0)) w++;
        continue;
      }
      const dx = wp[0] - state.ent.posX[a];
      const dy = wp[1] - state.ent.posY[a];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 0.35) {
        w++;
        continue;
      }
      pi.moveX = Math.round((dx / d) * 127);
      pi.moveY = Math.round((dy / d) * 127);
      step(state, input);
    }
    if (w >= route.length) return "out";
    return `stuck before ${JSON.stringify(route[w])} at (${state.ent.posX[a].toFixed(2)}, ${state.ent.posY[a].toFixed(2)})`;
  }

  for (const mapId of [PROVING_GROUND_ID, BUG_HUNT_ID]) {
    it(`${mapId}: both mechs ride up and walk down to their gate`, () => {
      const map = getMapById(mapId);
      expect(map.lifts.length).toBe(2);
      for (const l of map.lifts) {
        expect(l.stops).toEqual([0, 921 << 4]);
        expect([l.up, l.down, l.dwell[1]]).toEqual([UP, DOWN, DWELL]);
      }
      expect(drivesOut(mapId, 0)).toBe("out");
      expect(drivesOut(mapId, 1)).toBe("out");
    });
  }
});

describe("Conft's pit lifts (fcop-fidelity.md P12)", () => {
  // Four lifts stand in the sunken ring (-1.81 m) at the four sides of the
  // central platform (0.19 m). From the ring a mech steps onto one (its top
  // parks 0.39 m up, within the walker's own 0.4 m probe), presses, rides up
  // 1.64 m and walks off onto the platform.
  const CASES: {
    lift: number;
    from: [number, number];
    onto: [number, number];
    off: [number, number];
  }[] = [
    { lift: 0, from: [128.5, 120], onto: [126.6, 120], off: [124.5, 120] },
    { lift: 1, from: [111.5, 120], onto: [113.4, 120], off: [115.5, 120] },
    { lift: 2, from: [120, 111.5], onto: [120, 113.4], off: [120, 115.5] },
    { lift: 3, from: [120, 128.5], onto: [120, 126.6], off: [120, 124.5] },
  ];
  for (const c of CASES) {
    it(`lift ${c.lift} carries a mech from the ring onto the platform`, () => {
      const map = getMapById(URBAN_JUNGLE_ID);
      const l = map.lifts[c.lift];
      expect([l.stops[0], l.stops[1], l.up, l.down, l.hurtsTeam]).toEqual([
        81 << 4,
        921 << 4,
        100,
        210,
        -1,
      ]);
      const state = createSim(map, 1);
      const a = state.avatarId[0];
      state.ent.posX[a] = c.from[0];
      state.ent.posY[a] = c.from[1];
      state.ent.height[a] = l.ground;
      const input = createTickInputs();
      const go = (to: [number, number]): void => {
        for (let t = 0; t < 60; t++) {
          const dx = to[0] - state.ent.posX[a];
          const dy = to[1] - state.ent.posY[a];
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 0.25) break;
          input.players[0].moveX = Math.round((dx / d) * 127);
          input.players[0].moveY = Math.round((dy / d) * 127);
          step(state, input);
        }
        input.players[0].moveX = 0;
        input.players[0].moveY = 0;
      };
      step(state, idle);
      go(c.onto);
      expect(state.avatarLift[0]).toBe(c.lift);
      input.players[0].buttons = BUTTON_INTERACT;
      step(state, input);
      input.players[0].buttons = 0;
      expect(untilEvent(state, EV_LIFT_ARRIVE, 200)).toBeGreaterThan(0);
      go(c.off);
      expect(
        Math.abs(state.ent.posX[a] - c.off[0]) + Math.abs(state.ent.posY[a] - c.off[1]),
      ).toBeLessThan(0.5);
      expect(state.ent.height[a]).toBeCloseTo(0.1875, 2);
    });
  }
});
