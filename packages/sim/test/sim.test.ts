// Pins exact hashes and positions. A changed pin = changed sim behavior =
// SIM_VERSION bump + golden regeneration in the same commit.
import { describe, expect, it } from "bun:test";
import {
  createSim,
  createTestMap,
  createTickInputs,
  hash,
  MAX_ENTITIES,
  quantizeAxis,
  SNAPSHOT_STRIDE,
  step,
  writeSnapshot,
} from "../src/index";

const map = createTestMap();

describe("quantizeAxis", () => {
  it("maps [-1,1] to int8 exactly", () => {
    expect(quantizeAxis(0)).toBe(0);
    expect(quantizeAxis(1)).toBe(127);
    expect(quantizeAxis(-1)).toBe(-127);
    expect(quantizeAxis(0.5)).toBe(64);
    expect(quantizeAxis(-0.5)).toBe(-63);
    expect(quantizeAxis(2)).toBe(127);
    expect(quantizeAxis(-2)).toBe(-127);
  });
});

describe("sim tick loop", () => {
  it("pins the initial state hash", () => {
    // SIM_VERSION 39: the hash covers the X1-Alpha's movement state (turn rate,
    // idle timer, lunge countdown) on every map. SIM_VERSION 40: and the lock's
    // steer flag; the test map spawns both avatars on one spot, so each
    // auto-acquires the other on the first tick. SIM_VERSION 41: and the avatars'
    // 1250 HP, their Gun magazines and burst counters. SIM_VERSION 43: and the
    // block-B (power-up) magazines.
    expect(hash(createSim(map, 0xdead))).toBe(4280519373);
  });

  it("pins hashes for idle and movement scripts", () => {
    const sim = createSim(map, 0xdead);
    const inputs = createTickInputs();
    for (let i = 0; i < 10; i++) step(sim, inputs);
    expect(hash(sim)).toBe(3405716358);
    expect(sim.tick).toBe(10);

    inputs.players[0].moveX = 127;
    for (let i = 0; i < 30; i++) step(sim, inputs);
    // The original's walker (SIM_VERSION 39): 4.69 m/s reached in ~0.2 s, and
    // slowed a little by the slope push up the test map's rise (was a flat 5 m/s).
    expect(hash(sim)).toBe(2408290731);
    expect(sim.ent.posX[0]).toBe(131.49205017089844);
    expect(sim.ent.posY[0]).toBe(127);
    expect(sim.ent.height[0]).toBe(0.34852543473243713);
  });

  it("produces identical hash sequences for identical seed + inputs", () => {
    const a = createSim(map, 42);
    const b = createSim(map, 42);
    const inputs = createTickInputs();
    for (let t = 0; t < 120; t++) {
      inputs.players[0].moveX = quantizeAxis(((t % 60) - 30) / 30);
      inputs.players[0].moveY = quantizeAxis(((t % 40) - 20) / 20);
      step(a, inputs);
      step(b, inputs);
      expect(hash(a)).toBe(hash(b));
    }
  });

  it("diverges when a single input differs", () => {
    const a = createSim(map, 42);
    const b = createSim(map, 42);
    const inputs = createTickInputs();
    step(a, inputs);
    inputs.players[0].moveY = 1; // smallest possible axis difference
    step(b, inputs);
    expect(hash(a)).not.toBe(hash(b));
  });

  it("differs across seeds", () => {
    expect(hash(createSim(map, 1))).not.toBe(hash(createSim(map, 2)));
  });

  it("clamps the avatar to map bounds", () => {
    const sim = createSim(map, 7);
    const inputs = createTickInputs();
    inputs.players[0].moveX = -127;
    for (let i = 0; i < 3000; i++) step(sim, inputs); // 100 s west into the wall
    expect(sim.ent.posX[0]).toBe(0);
  });
});

describe("writeSnapshot", () => {
  it("writes stride-10 records for both avatars in dense id order", () => {
    const sim = createSim(map, 0xdead);
    const inputs = createTickInputs();
    inputs.players[0].moveX = 127;
    for (let i = 0; i < 30; i++) step(sim, inputs);
    const out = new Float32Array(MAX_ENTITIES * SNAPSHOT_STRIDE);
    const n = writeSnapshot(sim, out);
    expect(n).toBe(2);
    expect(Array.from(out.slice(0, SNAPSHOT_STRIDE))).toEqual([
      0, // id
      0, // archetype AVATAR
      0, // team
      131.49205017089844, // x
      127, // y
      0.34852543473243713, // height
      0, // yaw (moving +x)
      1, // animState: moving
      1, // hpFrac
      0, // aux
    ]);
    // Player 1's avatar idles at the test map's center spawn.
    expect(out[10]).toBe(1); // id
    expect(out[12]).toBe(1); // team
    expect(out[13]).toBe(127); // x
    expect(out[17]).toBe(0); // animState: idle
  });
});
