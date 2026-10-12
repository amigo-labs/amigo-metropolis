// Avatar movement rules on a tiny authored map: a flat plain with a wall too
// steep to walk, a plateau, and a water strip. Exercises the original's two
// movement models (fcop-fidelity.md P3-P5, SIM_VERSION 39): walker and hover
// speeds, strafe, turn rates, drag and braking, the three jumps, gravity and
// landing damage, water, and the transform.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  ARCHETYPE_RADIUS,
  AVATAR_HOVER_MAX_SLOPE,
  AVATAR_HOVER_SPEED,
  AVATAR_HP,
  AVATAR_WALKER_MAX_SLOPE,
  AVATAR_WALKER_SPEED,
  HOVER_CLEARANCE,
  HOVER_CUSHION_SPAN,
  HOVER_DRAG,
  HOVER_PUSH_STRAFE,
  TRANSFORM_LOCK_TICKS,
  WALKER_DRAG,
  WALKER_PUSH_STRAFE,
  X1_GRAVITY,
  X1_TERMINAL_FALL,
} from "../src/balance";
import { EV_SHOT, EV_TRANSFORM, EVENT_STRIDE } from "../src/events";
import { BUTTON_FIRE1, BUTTON_JUMP, BUTTON_TRANSFORM, createTickInputs } from "../src/inputs";
import { loadMapFromJson, type MapJson, sampleHeight } from "../src/map";
import { ANIM_AIRBORNE, createSim, MODE_HOVER, MODE_WALKER, type SimState, step } from "../src/sim";
import { JUMPABLE_RISE } from "../src/units";

const DEG = 180 / Math.PI;

// 16×16 grid, 4 m cells → 60 m square. Column layout (x in cells):
//   0-6: flat plain (h 0)   7: wall top (h 160 = 5 m, gradient 1.25 — past the
//   walker's 1.04)          8-9: high plateau (5 m) 10: back to 0
//   11-12: water channel (h -64 = -2 m)   13-15: far bank (h 0)
// Rows are uniform, so movement along +x meets: wall → plateau → water.
function arenaJson(): MapJson {
  const size = 16;
  const colHeights = [0, 0, 0, 0, 0, 0, 0, 160, 160, 160, 0, -64, -64, 0, 0, 0];
  const colWater = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0];
  const heights: number[][] = [];
  const water: string[] = [];
  for (let j = 0; j < size; j++) {
    heights.push([...colHeights]);
    water.push(colWater.map((w) => `${w}`).join(""));
  }
  return {
    id: "arena-test",
    size,
    cellSize: 4,
    waterLevel: -0.5,
    heights,
    water,
    spawns: [
      { x: 12, y: 30, yaw: 0 },
      { x: 50, y: 30, yaw: 0 },
    ],
    basePlots: [
      { x: 12, y: 30, radius: 8 },
      { x: 50, y: 30, radius: 8 },
    ],
    // Minimal bases: pads mirror the plots, gates tucked into far corners,
    // no ring turrets — movement tests stay combat-free.
    bases: [
      {
        gate: { x: 2, y: 2, radius: 2 },
        core: [4, 30],
        groundConsole: [12, 22],
        airConsole: [12, 38],
        pad: { x: 12, y: 30, radius: 8 },
        turrets: [],
      },
      {
        gate: { x: 58, y: 58, radius: 2 },
        core: [56, 30],
        groundConsole: [50, 22],
        airConsole: [50, 38],
        pad: { x: 50, y: 30, radius: 8 },
        turrets: [],
      },
    ],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
  };
}

function freshSim(): SimState {
  return createSim(loadMapFromJson(arenaJson()), 1);
}

const inputs = createTickInputs();
const p0 = inputs.players[0];

function reset(): void {
  for (const p of inputs.players) {
    p.moveX = 0;
    p.moveY = 0;
    p.aimX = 0;
    p.aimY = 0;
    p.buttons = 0;
  }
}

/** Count of events of `type` emitted in the last tick. */
function events(sim: SimState, type: number): number {
  let n = 0;
  for (let e = 0; e < sim.events.count; e++) if (sim.events.data[e * EVENT_STRIDE] === type) n++;
  return n;
}

describe("walker movement (the original's, fcop-fidelity.md P4)", () => {
  it("runs at 4.69 m/s, reached almost at once", () => {
    reset();
    const sim = freshSim();
    p0.moveX = 127;
    let t95 = -1;
    for (let i = 0; i < 30; i++) {
      step(sim, inputs);
      if (t95 < 0 && sim.ent.velX[0] > 0.95 * AVATAR_WALKER_SPEED) t95 = i + 1;
    }
    // push 0x18000 against drag 0x6000 a step: 4.6875 m/s; 95 % after 0.17 s.
    expect(AVATAR_WALKER_SPEED).toBe(4.6875);
    expect(sim.ent.velX[0]).toBeCloseTo(AVATAR_WALKER_SPEED, 4);
    expect(t95).toBeLessThanOrEqual(6);
    expect(sim.ent.posX[0]).toBeGreaterThan(12 + AVATAR_WALKER_SPEED - 0.4);
    expect(sim.ent.posX[0]).toBeLessThan(12 + AVATAR_WALKER_SPEED);
    // Released, it stops within a few ticks (under 0.586 m/s it stops dead).
    p0.moveX = 0;
    for (let i = 0; i < 6; i++) step(sim, inputs);
    expect(sim.ent.velX[0]).toBe(0);
  });

  it("strafes at 3.13 m/s across its facing, and a diagonal pushes as hard as ahead", () => {
    reset();
    const sim = freshSim();
    // Face +X (spawn default) while the stick asks for +Y: the original strafes.
    p0.aimX = 127;
    p0.moveY = 127;
    for (let i = 0; i < 30; i++) step(sim, inputs);
    expect(sim.ent.velX[0]).toBeCloseTo(0, 6);
    expect(sim.ent.velY[0]).toBeCloseTo(WALKER_PUSH_STRAFE / WALKER_DRAG, 4);
    expect(WALKER_PUSH_STRAFE / WALKER_DRAG).toBe(3.125);
    expect(sim.ent.yaw[0]).toBe(0);
    // Forward + strafe: 181/256 of the fore push at 45°, as fast as straight on.
    p0.moveX = 90;
    p0.moveY = 90;
    for (let i = 0; i < 30; i++) step(sim, inputs);
    expect(Math.hypot(sim.ent.velX[0], sim.ent.velY[0])).toBeCloseTo(AVATAR_WALKER_SPEED, 2);
    expect(sim.ent.velX[0]).toBeCloseTo(sim.ent.velY[0], 4);
  });

  it("turns at 105°/s standing, 79°/s at a full run", () => {
    reset();
    const sim = freshSim();
    p0.aimY = 127; // a quarter turn left of the +X spawn facing
    step(sim, inputs);
    expect(sim.ent.yaw[0] * DEG * 30).toBeCloseTo(105.47, 1);
    reset();
    const run = freshSim();
    p0.aimX = 127;
    p0.moveX = 127;
    for (let i = 0; i < 30; i++) step(run, inputs);
    p0.aimX = 0;
    p0.aimY = 127;
    step(run, inputs);
    // 105.47 * (1 - 4.69 / 18.75): the faster it goes, the slower it turns.
    expect(run.ent.yaw[0] * DEG * 30).toBeCloseTo(79.1, 0);
  });

  it("is blocked by the wall it cannot walk, and cannot jump it", () => {
    reset();
    const sim = freshSim();
    // Wall base at x=24: 5 m over 4 m is a 1.25 gradient, past the walker's 1.04.
    expect(AVATAR_WALKER_MAX_SLOPE).toBe(1.04);
    p0.moveX = 127;
    for (let i = 0; i < 90; i++) step(sim, inputs);
    const blockedX = sim.ent.posX[0];
    expect(blockedX).toBeGreaterThan(23); // at the foot of the ramp...
    expect(blockedX).toBeLessThan(26); // ...and no further
    // The jump does not clear it either: 5 m is far over the 1.1 m it can.
    p0.moveX = 0;
    for (let i = 0; i < 10; i++) step(sim, inputs);
    for (let k = 0; k < 3; k++) {
      p0.buttons = BUTTON_JUMP;
      step(sim, inputs);
      p0.buttons = 0;
      for (let i = 0; i < 40; i++) step(sim, inputs);
    }
    expect(sim.ent.posX[0]).toBeLessThan(27);
    expect(sim.ent.height[0]).toBeLessThan(2);
  });

  it("walks into water and turns into a hover on its own (NORMAL)", () => {
    reset();
    const sim = freshSim();
    // Player 1 spawns on the far bank and walks west into the channel. The
    // original's NORMAL walker requests a transform on water (`player_order`
    // code 1); HARD's sinking is not modelled.
    const p1 = inputs.players[1];
    const id = sim.avatarId[1];
    p1.moveX = -127;
    p1.aimX = -127;
    let changed = -1;
    for (let i = 0; i < 150 && changed < 0; i++) {
      step(sim, inputs);
      if (events(sim, EV_TRANSFORM) > 0) changed = i;
    }
    expect(changed).toBeGreaterThanOrEqual(0);
    expect(sim.ent.mode[id]).toBe(MODE_HOVER);
    for (let i = 0; i < TRANSFORM_LOCK_TICKS + 30; i++) step(sim, inputs);
    // Floating on the water at its ride height, not sunk.
    expect(sim.ent.height[id]).toBeGreaterThanOrEqual(Math.fround(-0.5 + HOVER_CLEARANCE) - 1e-6);
  });

  it("hops on open ground: 6.45 m/s up and 4.69 m/s forward", () => {
    reset();
    const sim = freshSim();
    const ground = sampleHeight(sim.map, 12, 30);
    p0.buttons = BUTTON_JUMP;
    step(sim, inputs);
    p0.buttons = 0;
    let apex = 0;
    let airTicks = 0;
    for (let i = 0; i < 60; i++) {
      step(sim, inputs);
      const h = sim.ent.height[0] - ground;
      if (h > apex) apex = h;
      if (h > 0.001) airTicks++;
      if (i > 5 && h <= 0.001) break;
    }
    // The original's apex is 0.71 m; 30 Hz semi-implicit steps land it at 0.69.
    expect(apex).toBeGreaterThan(0.65);
    expect(apex).toBeLessThan(0.75);
    expect(airTicks).toBeGreaterThan(11); // ~0.48 s
    expect(sim.ent.posX[0] - 12).toBeGreaterThan(1.5); // ~1.8 m forward
    expect(sim.ent.height[0]).toBe(ground);
  });

  it("leaps when it jumps at a run: 7.32 m/s up on top of the run", () => {
    reset();
    const sim = freshSim();
    p0.moveX = 127;
    for (let i = 0; i < 15; i++) step(sim, inputs);
    const ground = sampleHeight(sim.map, sim.ent.posX[0], 30);
    p0.buttons = BUTTON_JUMP;
    step(sim, inputs);
    p0.buttons = 0;
    // The leap adds 1.76 m/s forward on top of the run.
    expect(sim.ent.velX[0]).toBeGreaterThan(AVATAR_WALKER_SPEED + 1.5);
    let apex = 0;
    for (let i = 0; i < 30; i++) {
      step(sim, inputs);
      apex = Math.max(apex, sim.ent.height[0] - ground);
    }
    expect(apex).toBeGreaterThan(0.85); // the original's 0.93 m
    expect(apex).toBeLessThan(0.97);
  });

  it("falls under 26.1 m/s² to a 14.06 m/s terminal speed, and a long fall hurts", () => {
    expect(X1_GRAVITY).toBeCloseTo(26.09, 2);
    expect(X1_TERMINAL_FALL).toBe(14.0625);
    // Walk off the 5 m plateau's far edge (x=40 down to 0 by x=40): the drop is
    // a ramp too steep to hold, so the walker falls the rest of the way.
    reset();
    const sim = freshSim();
    const id = sim.avatarId[0];
    sim.ent.posX[id] = 36;
    sim.ent.height[id] = sampleHeight(sim.map, 36, 30);
    p0.moveX = 127;
    let fastest = 0;
    for (let i = 0; i < 60; i++) {
      step(sim, inputs);
      fastest = Math.min(fastest, sim.ent.timerB[id]);
    }
    // ~4 m of fall lands at ~13 m/s: over the 10.78 m/s threshold, so it costs
    // health — the original's absolute 1000 f(x) HP against its 1250-HP mech
    // (fcop-fidelity.md P1): never more than the 1000 of a terminal-speed fall.
    expect(AVATAR_HP).toBe(1250);
    expect(fastest).toBeLessThan(-10.78);
    expect(sim.ent.hp[id]).toBeLessThan(AVATAR_HP);
    expect(AVATAR_HP - sim.ent.hp[id]).toBeLessThanOrEqual(1000);
  });
});

describe("transform", () => {
  it("flips mode, locks for TRANSFORM_LOCK_TICKS, and freezes movement", () => {
    reset();
    const sim = freshSim();
    expect(sim.ent.mode[0]).toBe(MODE_WALKER);
    p0.buttons = BUTTON_TRANSFORM;
    p0.moveX = 127;
    step(sim, inputs);
    expect(sim.ent.mode[0]).toBe(MODE_HOVER);
    const xAfterFlip = sim.ent.posX[0];
    // Held button must not re-trigger (edge detection).
    for (let i = 0; i < TRANSFORM_LOCK_TICKS - 1; i++) step(sim, inputs);
    expect(sim.ent.mode[0]).toBe(MODE_HOVER);
    // Hover drifts from zero velocity, so during the lock it barely moves.
    expect(sim.ent.posX[0] - xAfterFlip).toBeLessThan(0.5);
    // Release and re-press → transforms back.
    p0.buttons = 0;
    step(sim, inputs);
    p0.buttons = BUTTON_TRANSFORM;
    step(sim, inputs);
    expect(sim.ent.mode[0]).toBe(MODE_WALKER);
  });

  it("takes the original's 41 ticks, keeps the guns live and the facing frozen", () => {
    // player_transform_step: 0 -> 0x10000 at 160 per engine unit = 409.6 units
    // at 300 Hz (fcop-fidelity.md P3).
    expect(TRANSFORM_LOCK_TICKS).toBe(41);
    reset();
    const sim = freshSim();
    const id = sim.avatarId[0];
    const yaw0 = sim.ent.yaw[id];
    p0.buttons = BUTTON_TRANSFORM;
    step(sim, inputs);
    // Mid-change: the stick and the aim are ignored, the trigger is not.
    p0.buttons = BUTTON_FIRE1;
    p0.aimX = 0;
    p0.aimY = 127;
    p0.moveY = 127;
    let shots = 0;
    for (let i = 0; i < TRANSFORM_LOCK_TICKS - 1; i++) {
      step(sim, inputs);
      for (let e = 0; e < sim.events.count; e++) {
        if (sim.events.data[e * EVENT_STRIDE] === EV_SHOT) shots++;
      }
      expect(sim.ent.yaw[id]).toBe(yaw0);
      expect(sim.ent.timerA[id]).toBeGreaterThan(0);
    }
    expect(shots).toBeGreaterThan(0);
    expect(sim.ent.velY[id]).toBe(0);
    // The ride height ramped up to the full clearance on the last ramp tick.
    expect(sim.ent.height[id]).toBeCloseTo(
      sampleHeight(sim.map, sim.ent.posX[id], 30) +
        HOVER_CLEARANCE * (1 - 1 / TRANSFORM_LOCK_TICKS),
      4,
    );
    step(sim, inputs);
    expect(sim.ent.timerA[id]).toBe(0);
    expect(sim.ent.velY[id]).toBeGreaterThan(0); // the stick drives again
  });

  it("coasts on hover physics through the change, in both directions", () => {
    reset();
    const sim = freshSim();
    const id = sim.avatarId[0];
    // Hover north at speed, then change back to walker: the hull keeps going.
    p0.buttons = BUTTON_TRANSFORM;
    step(sim, inputs);
    p0.buttons = 0;
    for (let i = 0; i < TRANSFORM_LOCK_TICKS; i++) step(sim, inputs);
    p0.moveY = 127;
    for (let i = 0; i < 90; i++) step(sim, inputs);
    const fast = sim.ent.velY[id];
    expect(fast).toBeGreaterThan(3);
    p0.buttons = BUTTON_TRANSFORM;
    step(sim, inputs);
    expect(sim.ent.mode[id]).toBe(MODE_WALKER);
    const y0 = sim.ent.posY[id];
    step(sim, inputs);
    expect(sim.ent.velY[id]).toBeGreaterThan(0); // not stopped dead
    expect(sim.ent.velY[id]).toBeLessThan(fast); // but no thrust
    expect(sim.ent.posY[id]).toBeGreaterThan(y0);
  });

  it("refuses to become a walker over water", () => {
    reset();
    const sim = freshSim();
    // Hover, then drift onto the water channel.
    p0.buttons = BUTTON_TRANSFORM;
    step(sim, inputs);
    p0.buttons = 0;
    p0.moveX = 127;
    for (let i = 0; i < 300; i++) step(sim, inputs);
    // Wall is hover-impassable → go around? No: hover blocked by wall too.
    // Use player 1 (east side) instead: transform and drift west onto water.
    const p1 = inputs.players[1];
    reset();
    p1.buttons = BUTTON_TRANSFORM;
    step(sim, inputs);
    p1.buttons = 0;
    p1.moveX = -127;
    let onWater = -1;
    for (let i = 0; i < 300; i++) {
      step(sim, inputs);
      if (onWater < 0 && sim.ent.posX[1] < 46) {
        onWater = i;
        break;
      }
    }
    expect(onWater).toBeGreaterThanOrEqual(0); // hover DID cross the bank
    // Rides the water surface (Float32-rounded, hence fround).
    expect(sim.ent.height[1]).toBe(Math.fround(-0.5 + HOVER_CLEARANCE));
    p1.moveX = 0;
    p1.buttons = BUTTON_TRANSFORM;
    step(sim, inputs);
    expect(sim.ent.mode[1]).toBe(MODE_HOVER); // still hover — refused over water
  });
});

/** Transforms player 0 into a hover and waits out the change. */
function toHover(sim: SimState): void {
  p0.buttons = BUTTON_TRANSFORM;
  step(sim, inputs);
  p0.buttons = 0;
  for (let i = 0; i < TRANSFORM_LOCK_TICKS; i++) step(sim, inputs);
  expect(sim.ent.mode[0]).toBe(MODE_HOVER);
}

describe("hover model (the original's, fcop-fidelity.md P5)", () => {
  it("reaches 9.38 m/s in the original's 1.56 s and coasts with a 0.36 s half-life", () => {
    reset();
    const sim = freshSim();
    toHover(sim);
    expect(sim.ent.height[0]).toBe(HOVER_CLEARANCE); // 0.5 m (was 0.3)
    p0.aimY = 127;
    for (let i = 0; i < 20; i++) step(sim, inputs); // face north first
    p0.moveY = 127; // open ground to the north/south
    let t95 = -1;
    for (let i = 0; i < 120; i++) {
      step(sim, inputs);
      if (t95 < 0 && sim.ent.velY[0] > 0.95 * AVATAR_HOVER_SPEED) t95 = i + 1;
    }
    // push 0x6666 against drag 0x0ccc a step: 9.38 m/s.
    expect(AVATAR_HOVER_SPEED).toBeCloseTo(9.377, 3);
    expect(sim.ent.velY[0]).toBeCloseTo(AVATAR_HOVER_SPEED, 2);
    expect(t95 / 30).toBeCloseTo(1.56, 1);
    // Released: it glides, half its speed gone in ~0.36 s, and then stops dead
    // under 0.146 m/s.
    p0.moveY = 0;
    const v0 = sim.ent.velY[0];
    let half = -1;
    let stop = -1;
    for (let i = 0; i < 120; i++) {
      step(sim, inputs);
      if (half < 0 && sim.ent.velY[0] < v0 / 2) half = i + 1;
      if (stop < 0 && sim.ent.velY[0] === 0) stop = i + 1;
    }
    expect(half / 30).toBeCloseTo(0.36, 1);
    expect(stop).toBeGreaterThan(half);
    expect(stop / 30).toBeLessThan(3);
  });

  it("brakes on the jump button: drag 0.15 a step instead of 0.05", () => {
    const halfLife = (buttons: number, moveY: number): number => {
      reset();
      const sim = freshSim();
      toHover(sim);
      p0.aimY = 127;
      for (let i = 0; i < 20; i++) step(sim, inputs);
      p0.moveY = 127;
      for (let i = 0; i < 120; i++) step(sim, inputs);
      const v0 = sim.ent.velY[0];
      p0.moveY = moveY;
      p0.buttons = buttons;
      for (let t = 1; t <= 120; t++) {
        step(sim, inputs);
        if (sim.ent.velY[0] < v0 / 2) return t;
      }
      return 121;
    };
    const coast = halfLife(0, 0);
    const brake = halfLife(BUTTON_JUMP, 0);
    const reverse = halfLife(0, -127);
    expect(brake * 2).toBeLessThan(coast); // ln 0.5 / ln 0.85 vs / ln 0.95
    expect(reverse).toBeLessThan(coast); // back thrust also bites
  });

  it("strafes at 2.93 m/s", () => {
    reset();
    const sim = freshSim();
    toHover(sim);
    p0.aimX = 127;
    p0.moveY = 127;
    for (let i = 0; i < 150; i++) step(sim, inputs);
    expect(sim.ent.velY[0]).toBeCloseTo(HOVER_PUSH_STRAFE / HOVER_DRAG, 3);
    expect(sim.ent.velY[0]).toBeCloseTo(2.93, 2);
  });

  it("turns at 158°/s after a ~0.26 s ramp", () => {
    reset();
    const sim = freshSim();
    toHover(sim);
    p0.aimX = -127; // half a turn
    const deltas: number[] = [];
    let last = sim.ent.yaw[0];
    for (let i = 0; i < 60; i++) {
      step(sim, inputs);
      let d = sim.ent.yaw[0] - last;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      deltas.push(Math.abs(d) * DEG * 30);
      last = sim.ent.yaw[0];
    }
    expect(Math.max(...deltas)).toBeCloseTo(158.2, 0);
    expect(deltas[0]).toBeLessThan(30); // the rate word starts from zero
    // 0x60 / 12.5 a tick: full rate on the 8th tick.
    expect(deltas.findIndex((d) => d > 158)).toBe(7);
  });

  it("drives off a ledge and falls, where it used to stick to the ground", () => {
    reset();
    const sim = kerbSim();
    // Spawn 1 stands on the 2.06 m shelf; west of x=14 the ground drops 1.31 m.
    const p1 = inputs.players[1];
    p1.buttons = BUTTON_TRANSFORM;
    step(sim, inputs);
    p1.buttons = 0;
    for (let i = 0; i < TRANSFORM_LOCK_TICKS; i++) step(sim, inputs);
    p1.aimX = -127;
    for (let i = 0; i < 40; i++) step(sim, inputs);
    p1.moveX = -127;
    let air = 0;
    for (let i = 0; i < 60; i++) {
      step(sim, inputs);
      if ((sim.ent.animState[1] & ANIM_AIRBORNE) !== 0) air++;
    }
    expect(air).toBeGreaterThan(2);
    expect(sim.ent.posX[1]).toBeLessThan(13);
  });

  it("hover cannot climb the steep wall", () => {
    reset();
    const sim = freshSim();
    toHover(sim);
    p0.moveX = 127;
    for (let i = 0; i < 200; i++) step(sim, inputs);
    expect(sim.ent.posX[0]).toBeLessThan(26); // blocked like the walker
  });
});

// What the hover measures a climb over (issue #34). The gate takes two readings,
// the step and the ground HOVER_CUSHION_SPAN further on, and blocks only when
// both are over the limit — so a step the hull spans is ridden over and ground
// that keeps climbing still stops the vehicle. The three features below are the
// three answers, on their own map: 1 m cells, so a one-cell step is a one-metre
// ramp in the bilinear field and every gradient below is exact.
//
//   x 0-7    flat 0                       — the run-up (spawn 0 at x=4)
//   x 8      +0.75 m step, flat beyond    — RIDDEN OVER: 0.75 gradient in the
//                                           step, 0.31 over the span. The walker
//                                           has to JUMP this one (> 0.6).
//   x 9-13   flat 0.75
//   x 14     +1.3125 m step, flat beyond  — BLOCKED: over the span the hover
//                                           climbs at most span × limit = 1.2 m.
//                                           The walker jumps it (< 1.4 m).
//   x 15-19  flat 2.0625                  — spawn 1 at x=17, for the ramp
//   x 20-23  +0.5625 m per cell           — BLOCKED: 0.5625 sustained, over the
//                                           0.5 limit. The walker WALKS it.
//   x 24-31  flat 3.75
function kerbJson(): MapJson {
  const size = 32;
  const colHeights = [
    0, 0, 0, 0, 0, 0, 0, 0, 24, 24, 24, 24, 24, 24, 66, 66, 66, 66, 66, 66, 84, 102, 120, 120, 120,
    120, 120, 120, 120, 120, 120, 120,
  ];
  const heights: number[][] = [];
  const water: string[] = [];
  for (let j = 0; j < size; j++) {
    heights.push([...colHeights]);
    water.push("0".repeat(size));
  }
  return {
    id: "kerb-test",
    size,
    cellSize: 1,
    waterLevel: -100, // dry map: nothing here tests water
    heights,
    water,
    spawns: [
      { x: 4, y: 16, yaw: 0 },
      { x: 17, y: 16, yaw: 0 },
    ],
    basePlots: [
      { x: 4, y: 16, radius: 4 },
      { x: 17, y: 16, radius: 4 },
    ],
    bases: [
      {
        gate: { x: 1, y: 1, radius: 1 },
        core: [2, 16],
        groundConsole: [4, 12],
        airConsole: [4, 20],
        pad: { x: 4, y: 16, radius: 4 },
        turrets: [],
      },
      {
        gate: { x: 30, y: 30, radius: 1 },
        core: [30, 16],
        groundConsole: [17, 12],
        airConsole: [17, 20],
        pad: { x: 17, y: 16, radius: 4 },
        turrets: [],
      },
    ],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
  };
}

function kerbSim(): SimState {
  return createSim(loadMapFromJson(kerbJson()), 1);
}

/** Drives one player east for `ticks`, in hover if asked, and returns its x. */
function driveEast(sim: SimState, player: number, hover: boolean, ticks: number): number {
  const p = inputs.players[player];
  if (hover) {
    p.buttons = BUTTON_TRANSFORM;
    step(sim, inputs);
    p.buttons = 0;
    for (let i = 0; i < TRANSFORM_LOCK_TICKS; i++) step(sim, inputs);
    expect(sim.ent.mode[player]).toBe(MODE_HOVER);
  }
  p.moveX = 127;
  for (let i = 0; i < ticks; i++) step(sim, inputs);
  return sim.ent.posX[player];
}

describe("hover slope gate", () => {
  it("pins the span against the terrain, not against the hull", () => {
    // This used to assert HOVER_CUSHION_SPAN === 2 * ARCHETYPE_RADIUS[AVATAR],
    // "the vehicle's footprint diameter", with the comment inviting the next
    // person to move the span whenever the radius moved. They did, when the
    // models came down to the size the original authored, and it cost the whole
    // issue-#34 kerb fix: hover-blocked road edges went 0->10 on la-cantina,
    // 20->49 on urban-jungle, and three of the four arenas lost a team that
    // could drive its own network. The kerbs the cushion rides over are terrain,
    // and terrain did not shrink.
    //
    // So the span is pinned to what it is measured against. It must clear the
    // FCOP streets' kerbs by a wide margin — those run to ~0.17 m, and the span
    // is an order of magnitude over that.
    expect(HOVER_CUSHION_SPAN).toBe(2.4);
    expect(HOVER_CUSHION_SPAN).toBeGreaterThan(ARCHETYPE_RADIUS[ARCHETYPE.AVATAR] * 2);
    // What it implies against the walker. Until SIM_VERSION 39 the cushion's
    // 1.2 m single-step ceiling sat under the walker's 1.4 m air-steered jump.
    // The original's walker (fcop-fidelity.md P4) instead WALKS what its slope
    // push climbs, a 1.04 gradient — twice the hover's sustained 0.5 — and its
    // jumps climb nothing the walk does not (JUMPABLE_RISE 0). So the walker
    // owns all sustained climbing, and the one band the hover owns is a single
    // step of 1.04-1.2 m with flat ground beyond.
    // The original's hover has no cushion (it snaps up per step and stalls on
    // its own slope push); the span is Metropolis' issue-#34 rule.
    expect(AVATAR_WALKER_MAX_SLOPE).toBeGreaterThan(2 * AVATAR_HOVER_MAX_SLOPE);
    const hoverStep = HOVER_CUSHION_SPAN * AVATAR_HOVER_MAX_SLOPE;
    expect(hoverStep).toBeGreaterThan(AVATAR_WALKER_MAX_SLOPE);
    expect(hoverStep - AVATAR_WALKER_MAX_SLOPE).toBeLessThan(0.2);
  });

  it("rides over a step its hull spans, and stops at one it does not", () => {
    reset();
    const sim = kerbSim();
    // 8 s east from x=4: over the 0.75 m step at x=8, then into the 1.31 m one
    // at x=14 — above the 1.2 m the span allows.
    const x = driveEast(sim, 0, true, 240);
    expect(x).toBeGreaterThan(9); // crossed the kerb...
    expect(x).toBeLessThan(14); // ...and parked at the tall step
    // Up on the kerb, having nosed a little way into the step it cannot take.
    const onKerb = sampleHeight(sim.map, x, 16);
    expect(onKerb).toBeGreaterThanOrEqual(0.75);
    expect(onKerb).toBeLessThan(1);
  });

  it("stops at ground that keeps climbing past the span", () => {
    reset();
    const sim = kerbSim();
    // Spawn 1 sits on the flat shelf at x=17; the ramp east of x=19 climbs
    // 0.5625 per metre, just over the limit, and never flattens out.
    const x = driveEast(sim, 1, true, 240);
    expect(x).toBeLessThan(20.5);
    // Still on the shelf, or barely onto the foot of the ramp.
    const onShelf = sampleHeight(sim.map, x, 16);
    expect(onShelf).toBeGreaterThanOrEqual(2.0625);
    expect(onShelf).toBeLessThan(2.35);
  });

  it("splits the ground the two forms own", () => {
    // The asymmetry rules.md §2 claims, measured on the same three features.
    // The walker climbs the sustained ramp the hover cannot.
    reset();
    const walkerRamp = driveEast(kerbSim(), 1, false, 240);
    expect(walkerRamp).toBeGreaterThan(21); // walked up the 0.5625 ramp

    // The 0.75 m kerb it used to have to jump, the original's walker walks
    // (a 0.75 gradient, under its 1.04); and the 1.31 m step stops it, walking
    // or jumping, as it stops the hover.
    reset();
    const sim = kerbSim();
    const walkerKerb = driveEast(sim, 0, false, 120);
    expect(walkerKerb).toBeGreaterThan(9);
    expect(walkerKerb).toBeLessThan(14);
    inputs.players[0].moveX = 0;
    for (let k = 0; k < 3; k++) {
      inputs.players[0].buttons = BUTTON_JUMP;
      step(sim, inputs);
      inputs.players[0].buttons = 0;
      for (let i = 0; i < 40; i++) step(sim, inputs);
    }
    expect(sim.ent.posX[0]).toBeLessThan(14.5);
  });

  it("climbs nothing by jumping that it cannot walk (JUMPABLE_RISE 0)", () => {
    // A one-cell step is a 1 m ramp, the way the terrain draws every step. The
    // walker walks a 1.0 m one (a 1.0 gradient, under its 1.04). At 1.06 m it is
    // stopped at the foot, and neither of the original's jumps gets it on top:
    // the standing high jump's lunge comes too late to cross the ramp, and the
    // running leap (pressed at full speed just short of the foot) is lower than
    // the step.
    const ledge = (rise32: number): SimState => {
      const j = kerbJson();
      j.heights = j.heights.map((row) => row.map((_, i) => (i >= 9 ? rise32 : 0)));
      return createSim(loadMapFromJson(j), 1);
    };
    expect(JUMPABLE_RISE).toBe(0);
    const top = (sim: SimState, rise32: number) => sim.ent.height[0] >= rise32 / 32 - 0.01;
    // 1.0 m: walked.
    reset();
    let sim = ledge(32);
    inputs.players[0].moveX = 127;
    for (let i = 0; i < 150; i++) step(sim, inputs);
    expect(top(sim, 32)).toBe(true);
    // 1.06 m: not walked...
    reset();
    sim = ledge(34);
    inputs.players[0].moveX = 127;
    for (let i = 0; i < 150; i++) step(sim, inputs);
    expect(top(sim, 34)).toBe(false);
    // ...nor high-jumped from the foot...
    inputs.players[0].moveX = 0;
    for (let i = 0; i < 10; i++) step(sim, inputs);
    inputs.players[0].buttons = BUTTON_JUMP;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    for (let i = 0; i < 40; i++) step(sim, inputs);
    expect(top(sim, 34)).toBe(false);
    // ...nor leapt at a run (from x=4 the foot is ~0.85 s away).
    reset();
    sim = ledge(34);
    inputs.players[0].moveX = 127;
    for (let i = 0; i < 24; i++) step(sim, inputs);
    expect(sim.ent.posX[0]).toBeLessThan(8);
    inputs.players[0].buttons = BUTTON_JUMP;
    step(sim, inputs);
    inputs.players[0].buttons = 0;
    inputs.players[0].moveX = 0;
    for (let i = 0; i < 40; i++) step(sim, inputs);
    expect(top(sim, 34)).toBe(false);
  });
});

describe("determinism of the movement model", () => {
  it("mirrored runs stay hash-identical with mode changes and jumps", async () => {
    const { hash } = await import("../src/sim");
    const a = freshSim();
    const b = freshSim();
    const ins = createTickInputs();
    for (let t = 0; t < 300; t++) {
      ins.players[0].moveX = ((t * 37) % 255) - 127;
      ins.players[0].moveY = ((t * 53) % 255) - 127;
      ins.players[0].buttons =
        (t % 40 === 0 ? BUTTON_TRANSFORM : 0) | (t % 17 === 0 ? BUTTON_JUMP : 0);
      step(a, ins);
      step(b, ins);
      expect(hash(a)).toBe(hash(b));
    }
  });
});
