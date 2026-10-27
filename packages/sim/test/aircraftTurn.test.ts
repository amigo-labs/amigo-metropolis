// The original's aircraft flight (RE M3-OR / M3-OT; balance.ts AIRCRAFT_*,
// units.ts flyHeading / verticalCommand / travelWu / upRowY): the heading
// step toward the steer point, rescaled by a pure shift to a 15-bit cheap
// magnitude and scaled by turn * delta >> 3, its Y the altitude controller's
// command; the 7/8 decay and the pitch clamp; the bank's speed penalty.
// Expected values are worked from the retail arithmetic by hand
// (aircraft.c 0x00420a0f..0x00420bcc), not from the functions.

import { describe, expect, it } from "bun:test";
import {
  AIRCRAFT_TURN_RATE,
  ORIGINAL_JET_FLIGHT,
  SKY_TURN_BOOST_RADIUS,
  SKY_TURN_RATE,
} from "../src/balance";
import { createTickInputs } from "../src/inputs";
import { getMapById, LA_CANTINA_ID } from "../src/map";
import { createSim, step } from "../src/sim";
import { flyHeading, flyScratch, travelWu, upRowY, verticalCommand } from "../src/units";

function level(hx: number, hy: number, hz: number): void {
  flyScratch.hx = hx;
  flyScratch.hy = hy;
  flyScratch.hz = hz;
  flyScratch.sx = 0;
  flyScratch.sy = 0;
  flyScratch.sz = 0;
}

describe("flyHeading", () => {
  it("adds the shifted, scaled step to the unit heading", () => {
    // Heading +x, steer point 3 m along +z: 24576 wu, floor(log2) 14, so the
    // shift is left 1 -> 49152; times 5120 * 10 >> 3 = 6400 is 4800 (16.16).
    // The heading (65536, 0, 4800) rescales right 1 and normalises.
    level(65536, 0, 0);
    flyHeading(0, 24576, 0, AIRCRAFT_TURN_RATE);
    expect(flyScratch.hz / flyScratch.hx).toBeCloseTo(4800 / 65536, 4);
    expect(flyScratch.hy).toBe(0);
    // The steer low-passes the step: (3 * 0 + 4800) >> 2.
    expect(flyScratch.sz).toBe(1200);
  });

  it("depends on the distance's bit pattern, not its length", () => {
    // 2 m = 16384 wu is exactly 2^14: shifted to 2^15 = 32768, step 3200. Just
    // under 2 m (16383 wu) is floor(log2) 13: shifted to 65532, step 6399.
    level(65536, 0, 0);
    flyHeading(0, 16384, 0, AIRCRAFT_TURN_RATE);
    expect(flyScratch.hz / flyScratch.hx).toBeCloseTo(3200 / 65536, 4);
    level(65536, 0, 0);
    flyHeading(0, 16383, 0, AIRCRAFT_TURN_RATE);
    expect(flyScratch.hz / flyScratch.hx).toBeCloseTo(6399 / 65536, 4);
  });

  it("does not turn from a point dead behind", () => {
    level(65536, 0, 0);
    flyHeading(-5 * 8192, 0, 0, SKY_TURN_RATE);
    expect(flyScratch.hx).toBe(65536);
    expect(flyScratch.hz).toBe(0);
  });

  it("takes the vertical command into the heading's Y, less an eighth", () => {
    // 0x1800 - 0x1800 / 8 = 5376 against 65536; the rescale halves both. The
    // steer's Y: (0 + 6144) >> 2 = 1536, less a quarter = 1152.
    level(65536, 0, 0);
    flyHeading(0, 0, 0x1800, AIRCRAFT_TURN_RATE);
    expect(flyScratch.hy / flyScratch.hx).toBeCloseTo(2688 / 32768, 4);
    expect(flyScratch.sy).toBe(1152);
  });

  it("clamps the pitch to 0x8000 of the 15-bit rescale", () => {
    // Straight up plus 0x1800: 71680 - 8960 = 62720, with 4800 along z; the
    // cheap magnitude 62720 + 1200 is 15 bits, no shift; Y clamps to 32768.
    level(0, 65536, 0);
    flyHeading(0, 24576, 0x1800, AIRCRAFT_TURN_RATE);
    expect(flyScratch.hy / flyScratch.hz).toBeCloseTo(32768 / 4800, 3);
  });
});

describe("the altitude controller (0x00420a60..0x00420af2)", () => {
  const f = ORIGINAL_JET_FLIGHT; // 819 / 921 / 1024
  it("saturates at the band's edges and rests in its deadband", () => {
    expect(verticalCommand((819 << 4) - 1, 0, f)).toBe(0x1800);
    expect(verticalCommand(819 << 4, 0, f)).toBe(0x1800);
    expect(verticalCommand(1024 << 4, 0, f)).toBe(-0x1800);
    expect(verticalCommand(921 << 4, 0, f)).toBe(0);
  });

  it("commands the error times the half band's reciprocal, times 3/32", () => {
    // 736 wu under 14736: 0x80000000 / 816 = 2631720; 736 * that >> 16 = 29556;
    // * 3 >> 5 = 2770.
    expect(verticalCommand(14000, 0, f)).toBe(2770);
  });
});

describe("the bank's speed penalty (0x00420b84)", () => {
  it("moves a level aircraft speed * delta >> 8 and a banked one less", () => {
    // The jet's word 27962: 1092 wu a tick level. |m(1,1)| 52429: tilt
    // 26214 - 1638 = 24576, >> 8 = 96, so (416 * 1092) >> 9 = 887.
    expect(travelWu(27962, 0x10000)).toBe(1092);
    expect(travelWu(27962, 52429)).toBe(887);
  });

  it("reads the bank from the up vector the steer leans", () => {
    // Forward +z, steer 0x2000 along x: up (8192, 8192, 0), 45 degrees.
    expect(upRowY(0, 0, 65536, 0, 0, 0)).toBe(65536);
    expect(upRowY(0, 0, 65536, 8192, 0, 0)).toBe(46340);
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
