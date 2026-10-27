// Pins exact hashes and positions. A changed pin = changed sim behavior =
// SIM_VERSION bump + golden regeneration in the same commit.
import { describe, expect, it } from "bun:test";
import {
  BTN_FORWARD,
  BTN_JINK_LEFT,
  BTN_TURN_LEFT,
  BTN_TURN_RIGHT,
  createSim,
  createTestMap,
  createTickInputs,
  hash,
  MAX_ENTITIES,
  SNAPSHOT_STRIDE,
  step,
  writeSnapshot,
} from "../src/index";
import { face } from "./drive";

const map = createTestMap();

describe("sim tick loop", () => {
  it("pins the initial state hash", () => {
    // SIM_VERSION 39: the hash covers the X1-Alpha's movement state (turn rate,
    // idle timer, lunge countdown) on every map. SIM_VERSION 40: and the lock's
    // steer flag; the test map spawns both avatars on one spot, so each
    // auto-acquires the other on the first tick. SIM_VERSION 41: and the avatars'
    // 1250 HP, their Gun magazines and burst counters. SIM_VERSION 43: and the
    // block-B (power-up) magazines. SIM_VERSION 51: no longer the purchase hold
    // (buyTarget/buyProgress left with it). SIM_VERSION 52: the test map carries
    // the original's profiles, so weapon profiles are hashed on it too.
    // SIM_VERSION 61: and the spawn queues, whose phases are drawn at createSim.
    // SIM_VERSION 68: no longer the steer flag (the lock never turns the hull).
    // SIM_VERSION 76: and the results page's figures and the rival-hit flags.
    // SIM_VERSION 83: and the walker's state machine and its legs (walker.ts),
    // in place of the lunge countdown. SIM_VERSION 84: the queue countdowns in
    // engine ticks from u32 % period. SIM_VERSION 108: and the wall contacts'
    // pending impulse and snap state. SIM_VERSION 110: and the count words.
    // SIM_VERSION 113: and the mechs' own contact models. SIM_VERSION 114: and
    // the cockpits' aims. SIM_VERSION 116: and the Sky Captain's muzzle indices.
    expect(hash(createSim(map, 0xdead))).toBe(2586610510);
  });

  it("pins hashes for idle and movement scripts", () => {
    const sim = createSim(map, 0xdead);
    const inputs = createTickInputs();
    for (let i = 0; i < 10; i++) step(sim, inputs);
    expect(hash(sim)).toBe(373151918);
    expect(sim.tick).toBe(10);

    inputs.players[0].buttons = BTN_FORWARD; // the spawn faces +x
    for (let i = 0; i < 30; i++) step(sim, inputs);
    // The original's walker (SIM_VERSION 39): 4.69 m/s reached in ~0.2 s, and
    // slowed a little by the slope push up the test map's rise (was a flat 5 m/s).
    expect(hash(sim)).toBe(3815703845);
    expect(sim.ent.posX[0]).toBe(131.49205017089844);
    expect(sim.ent.posY[0]).toBe(127);
    expect(sim.ent.height[0]).toBe(0.34852543473243713);
  });

  it("produces identical hash sequences for identical seed + inputs", () => {
    const a = createSim(map, 42);
    const b = createSim(map, 42);
    const inputs = createTickInputs();
    for (let t = 0; t < 120; t++) {
      inputs.players[0].buttons =
        (t % 60 < 30 ? BTN_FORWARD : BTN_JINK_LEFT) |
        (t % 40 < 20 ? BTN_TURN_RIGHT : BTN_TURN_LEFT);
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
    inputs.players[0].buttons = BTN_TURN_LEFT; // one button for one tick
    step(b, inputs);
    expect(hash(a)).not.toBe(hash(b));
  });

  it("differs across seeds", () => {
    expect(hash(createSim(map, 1))).not.toBe(hash(createSim(map, 2)));
  });

  it("clamps the avatar to map bounds", () => {
    const sim = createSim(map, 7);
    const inputs = createTickInputs();
    face(sim, sim.avatarId[0], Math.PI);
    inputs.players[0].buttons = BTN_FORWARD;
    for (let i = 0; i < 3000; i++) step(sim, inputs); // 100 s west into the wall
    expect(sim.ent.posX[0]).toBe(0);
  });
});

describe("writeSnapshot", () => {
  it("writes stride-10 records for both avatars in dense id order", () => {
    const sim = createSim(map, 0xdead);
    const inputs = createTickInputs();
    inputs.players[0].buttons = BTN_FORWARD;
    for (let i = 0; i < 30; i++) step(sim, inputs);
    const out = new Float32Array(MAX_ENTITIES * SNAPSHOT_STRIDE);
    const n = writeSnapshot(sim, out);
    expect(n).toBe(2);
    expect(Array.from(out.slice(0, SNAPSHOT_STRIDE))).toEqual([
      0, // id
      0, // archetype AVATAR
      0, // team
      // A tick short of 30 of push: the reset's step has no control (SIM_VERSION 83).
      131.33580017089844, // x
      127, // y
      0.3140789270401001, // height
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
