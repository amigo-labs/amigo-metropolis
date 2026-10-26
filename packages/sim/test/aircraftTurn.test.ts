// The original's aircraft turn (RE M3-OR; balance.ts AIRCRAFT_TURN_RATE,
// units.ts steerHeading): a step toward the steer point, rescaled by a pure
// shift to a 15-bit cheap magnitude and scaled by turn * delta >> 3, added to
// the unit heading. Expected values are worked from the retail arithmetic by
// hand, not from the function.

import { describe, expect, it } from "bun:test";
import {
  AIRCRAFT_TURN_RATE,
  SKY_TURN_BOOST_RADIUS,
  SKY_TURN_RATE,
  WU_PER_METRE,
} from "../src/balance";
import { createTickInputs } from "../src/inputs";
import { getMapById, LA_CANTINA_ID } from "../src/map";
import { createSim, step } from "../src/sim";
import { headingScratch, steerHeading } from "../src/units";

describe("steerHeading", () => {
  it("adds the shifted, scaled step to the unit heading", () => {
    // Heading +x, steer point 3 m along +y: 24576 wu, floor(log2) 14, so the
    // shift is left 1 -> 49152; times 5120 * 10 >> 3 = 6400 is 4800 (16.16).
    steerHeading(1, 0, 0, 3, AIRCRAFT_TURN_RATE);
    const l = Math.hypot(65536, 4800);
    expect(headingScratch.x).toBeCloseTo(65536 / l, 12);
    expect(headingScratch.y).toBeCloseTo(4800 / l, 12);
  });

  it("depends on the distance's bit pattern, not its length", () => {
    // 2 m = 16384 wu is exactly 2^14: shifted to 2^15 = 32768, step 3200. Just
    // under 2 m (16383 wu) is floor(log2) 13: shifted to 65532, step 6399.
    steerHeading(1, 0, 0, 2, AIRCRAFT_TURN_RATE);
    expect(headingScratch.y / headingScratch.x).toBeCloseTo(3200 / 65536, 12);
    steerHeading(1, 0, 0, 16383 / WU_PER_METRE, AIRCRAFT_TURN_RATE);
    expect(headingScratch.y / headingScratch.x).toBeCloseTo(6399 / 65536, 12);
  });

  it("does not turn from a point dead behind", () => {
    steerHeading(1, 0, -5, 0, SKY_TURN_RATE);
    expect(headingScratch.x).toBe(1);
    expect(headingScratch.y).toBe(0);
  });
});

describe("the Sky Captain's turn boost", () => {
  it("quadruples its turn within 10 m of home with nothing on offer", () => {
    const map = getMapById(LA_CANTINA_ID);
    const sim = createSim(map, 5, { wardenPlayer: 1, wardenDifficulty: 8 });
    const idle = createTickInputs();
    const wid = sim.avatarId[1];
    step(sim, idle);
    sim.pickupCooldown.fill(1e6);
    const home = map.spawns[1];
    sim.ent.posX[wid] = home.x;
    sim.ent.posY[wid] = home.y + SKY_TURN_BOOST_RADIUS - 2;
    sim.ent.hp[wid] = 50;
    step(sim, idle); // ENGAGE: it breaks off for home
    expect(sim.captain.turn).toBe(SKY_TURN_RATE);
    step(sim, idle); // CRUISE, 8 m out, no pickup: the boost
    expect(sim.captain.turn).toBe(SKY_TURN_RATE * 4);
  });
});
