// Avatar movement rules on a tiny authored map: a flat plain with a steep
// wall, a jumpable ledge, and a water strip. Exercises walker/hover slope
// limits, water rules, jump/gravity, transform lock, and hover drift.
import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  ARCHETYPE_RADIUS,
  AVATAR_HOVER_MAX_SLOPE,
  AVATAR_HOVER_SPEED,
  AVATAR_WALKER_SPEED,
  HOVER_CLEARANCE,
  HOVER_CUSHION_SPAN,
  TRANSFORM_LOCK_TICKS,
} from "../src/balance";
import { BUTTON_JUMP, BUTTON_TRANSFORM, createTickInputs } from "../src/inputs";
import { loadMapFromJson, type MapJson, sampleHeight } from "../src/map";
import { createSim, MODE_HOVER, MODE_WALKER, type SimState, step } from "../src/sim";
import { JUMPABLE_RISE } from "../src/units";

// 16×16 grid, 4 m cells → 60 m square. Column layout (x in cells):
//   0-6: flat plain (h 0)   7: steep wall top (h 96 = 3 m, slope 0.75)
//   8-9: high plateau (3 m) 10: back to 0   11-12: water channel (h -64 = -2 m)
//   13-15: far bank (h 0)
// Rows are uniform, so movement along +x meets: wall → plateau → water.
function arenaJson(): MapJson {
  const size = 16;
  const colHeights = [0, 0, 0, 0, 0, 0, 0, 96, 96, 96, 0, -64, -64, 0, 0, 0];
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

describe("walker movement", () => {
  it("moves at walker speed on flat ground", () => {
    reset();
    const sim = freshSim();
    p0.moveX = 127;
    for (let i = 0; i < 30; i++) step(sim, inputs);
    expect(sim.ent.posX[0]).toBeCloseTo(12 + AVATAR_WALKER_SPEED, 3);
  });

  it("is blocked by the steep wall but jumps onto the ledge", () => {
    reset();
    const sim = freshSim();
    // Wall base is at x=24 (cell 6→7 rises 3 m over 4 m = slope 0.75 > 0.6).
    p0.moveX = 127;
    for (let i = 0; i < 90; i++) step(sim, inputs); // 15 m of driving into it
    const blockedX = sim.ent.posX[0];
    expect(blockedX).toBeLessThan(26); // stuck at the foot of the wall
    expect(sim.ent.height[0]).toBeLessThan(1.5);

    // 3 m wall is too high even for a jump (apex 1.6 m) — stays blocked.
    p0.buttons = BUTTON_JUMP;
    for (let i = 0; i < 60; i++) step(sim, inputs);
    expect(sim.ent.posX[0]).toBeLessThan(27);
  });

  it("cannot enter water on foot", () => {
    reset();
    const sim = freshSim();
    // Teleport-free approach: player 1 spawns at x=50; drive west to water
    // edge (water cells 11-12 → x 42..52 nearest-vertex zone).
    const p1 = inputs.players[1];
    p1.moveX = -127;
    for (let i = 0; i < 150; i++) step(sim, inputs);
    expect(sim.ent.posX[1]).toBeGreaterThan(45); // stopped at the bank
    expect(sim.ent.velX[1]).toBe(0);
  });

  it("jump follows a gravity arc and lands", () => {
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
    step(sim, inputs); // one more tick fully snaps the landing
    expect(apex).toBeGreaterThan(1.2);
    expect(apex).toBeLessThan(1.7); // v²/2g = 1.6 m
    expect(airTicks).toBeGreaterThan(15); // ~0.8 s of air time
    expect(sim.ent.height[0]).toBe(ground); // landed
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

describe("hover drift", () => {
  it("accelerates gradually toward the commanded velocity", () => {
    reset();
    const sim = freshSim();
    p0.buttons = BUTTON_TRANSFORM;
    step(sim, inputs);
    p0.buttons = 0;
    for (let i = 0; i < TRANSFORM_LOCK_TICKS; i++) step(sim, inputs);
    p0.moveY = 127; // open ground to the north/south
    step(sim, inputs);
    const v1 = sim.ent.velY[0];
    expect(v1).toBeGreaterThan(0);
    expect(v1).toBeLessThan(AVATAR_HOVER_SPEED * 0.2); // far from top speed
    for (let i = 0; i < 120; i++) step(sim, inputs);
    expect(sim.ent.velY[0]).toBeGreaterThan(AVATAR_HOVER_SPEED * 0.9); // ~4 s later
    // Release the stick: hover keeps sliding (drift), walker would stop dead.
    p0.moveY = 0;
    step(sim, inputs);
    expect(sim.ent.velY[0]).toBeGreaterThan(AVATAR_HOVER_SPEED * 0.8);
  });

  it("counter-steer kills drift far faster than coasting", () => {
    // Two identical hovers at full speed north; one releases the stick, the
    // other counter-steers. The brake must bite hard while the coast glides.
    const half = AVATAR_HOVER_SPEED * 0.5;
    const ticksToHalfSpeed = (steer: number): number => {
      reset();
      const sim = freshSim();
      p0.buttons = BUTTON_TRANSFORM;
      step(sim, inputs);
      p0.buttons = 0;
      p0.moveY = 127;
      for (let i = 0; i < 150; i++) step(sim, inputs); // reach top speed
      expect(sim.ent.velY[0]).toBeGreaterThan(AVATAR_HOVER_SPEED * 0.95);
      p0.moveY = steer;
      for (let t = 1; t <= 120; t++) {
        step(sim, inputs);
        if (sim.ent.velY[0] < half) return t;
      }
      return 121;
    };
    const brakeTicks = ticksToHalfSpeed(-127);
    const coastTicks = ticksToHalfSpeed(0);
    expect(brakeTicks).toBeLessThan(8); // counter-steer stops the slide fast
    expect(coastTicks).toBeGreaterThan(20); // released stick keeps gliding
    expect(brakeTicks * 4).toBeLessThan(coastTicks);
  });

  it("hover cannot climb the steep wall", () => {
    reset();
    const sim = freshSim();
    p0.buttons = BUTTON_TRANSFORM;
    step(sim, inputs);
    p0.buttons = 0;
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
  it("pins the span to the avatar's own footprint", () => {
    // The span is the vehicle's footprint diameter, not a tuned number. If the
    // avatar's radius moves, this is the reminder that the span moves with it.
    expect(HOVER_CUSHION_SPAN).toBe(2 * ARCHETYPE_RADIUS[ARCHETYPE.AVATAR]);
    // And the ceiling it implies has to stay under the walker's jump, or the
    // hover would out-climb the form whose job is climbing.
    expect(HOVER_CUSHION_SPAN * AVATAR_HOVER_MAX_SLOPE).toBeLessThan(JUMPABLE_RISE);
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

  it("splits the ground the two forms own, in both directions", () => {
    // The asymmetry rules.md §2 claims, measured on the same three features:
    // the walker climbs the sustained ramp the hover cannot, and the hover rides
    // over the 0.75 m step the walker has to jump.
    reset();
    const walkerRamp = driveEast(kerbSim(), 1, false, 240);
    expect(walkerRamp).toBeGreaterThan(21); // walked up the 0.5625 ramp

    reset();
    const sim = kerbSim();
    const walkerKerb = driveEast(sim, 0, false, 120);
    expect(walkerKerb).toBeLessThan(8); // stopped dead at the 0.75 m step
    inputs.players[0].buttons = BUTTON_JUMP; // ...which it clears by jumping
    for (let i = 0; i < 120; i++) step(sim, inputs);
    expect(sim.ent.posX[0]).toBeGreaterThan(9);
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
