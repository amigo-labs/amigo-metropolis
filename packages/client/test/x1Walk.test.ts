// The X1's animation as the client reads it (render/x1Walk.ts): the sim's
// walker machine (packages/sim/src/walker.ts, whose own tests are
// packages/sim/test/walker.test.ts) copied off the avatar snapshot once a tick
// -- the frames the rig poses, the form whose tick runs and the codes the
// legs handed the movement loop -- and the cockpit's aim at the lock, which is
// the client's own.

import { describe, expect, test } from "bun:test";
import {
  AVATAR_SNAP_AIM_PITCH,
  AVATAR_SNAP_AIM_YAW,
  AVATAR_SNAPSHOT_LEN,
  BTN_FORWARD,
  BTN_JUMP,
  createSim,
  createTickInputs,
  getMapById,
  type SimState,
  step,
  TRANSFORM_CHORD,
  TRANSFORM_LOCK_TICKS,
  writeAvatarSnapshot,
} from "@metropolis/sim";
import { createX1Walk, tickX1Walk, X1_CODES_PER_TICK } from "../src/render/x1Walk";

/** The sim's own machine (a test may look inside the sim; the client may not). */
const machine = (sim: SimState) => sim.walker;

describe("tickX1Walk", () => {
  test("reads the sim's frames, form, state and codes every tick", () => {
    const sim = createSim(getMapById("urban-jungle"), 12345);
    const inputs = createTickInputs();
    const snap = new Float32Array(AVATAR_SNAPSHOT_LEN);
    const x1 = createX1Walk();
    const plan: [number, number][] = [
      [10, 0],
      [40, BTN_FORWARD],
      [1, BTN_JUMP],
      [40, 0],
      [1, TRANSFORM_CHORD],
      [TRANSFORM_LOCK_TICKS + 10, 0],
    ];
    let codes = 0;
    let hoverTicks = 0;
    for (const [n, buttons] of plan) {
      for (let t = 0; t < n; t++) {
        inputs.players[0].buttons = buttons;
        step(sim, inputs);
        writeAvatarSnapshot(sim, snap);
        tickX1Walk(x1, snap);
        const w = machine(sim);
        expect(x1.owner[0]).toBe(sim.avatarId[0]);
        expect(x1.legsFrame[0]).toBe(w.legs.frame[0]);
        expect(x1.cockpitFrame[0]).toBe(w.cockpit.frame[0]);
        expect(x1.legsTrack[0]).toBe(w.legs.index[0]);
        expect(x1.form[0]).toBe(w.form[0]);
        expect(x1.state[0]).toBe(w.state[0]);
        expect(x1.flagsB9[0]).toBe(w.flags[0]);
        expect(x1.asked[0]).toBe(w.asked[0]);
        expect(x1.codeCount[0]).toBe(w.codeCount[0]);
        for (let k = 0; k < x1.codeCount[0]; k++) expect(x1.codes[k]).toBe(w.codes[k]);
        codes += x1.codeCount[0];
        hoverTicks += x1.form[0];
      }
    }
    expect(codes).toBeGreaterThan(0);
    expect(hoverTicks).toBeGreaterThan(TRANSFORM_LOCK_TICKS);
    // Ended in the hover's hold: legs 359, cockpit 29.
    expect(x1.legsFrame[0]).toBe(359);
    expect(x1.cockpitFrame[0]).toBe(29);
    expect(X1_CODES_PER_TICK).toBe(16);
  });

  test("names no X1 where the snapshot has none, and a new one aims straight ahead", () => {
    const sim = createSim(getMapById("urban-jungle"), 7, { wardenPlayer: 1 });
    const snap = new Float32Array(AVATAR_SNAPSHOT_LEN);
    const x1 = createX1Walk();
    step(sim, createTickInputs());
    writeAvatarSnapshot(sim, snap);
    x1.aimYaw[0] = 50;
    tickX1Walk(x1, snap);
    expect(x1.owner[1]).toBe(-1);
    expect(x1.owner[0]).toBe(sim.avatarId[0]);
    expect(x1.aimYaw[0]).toBe(0);
    // The aim is the sim's, off the snapshot (orient.ts systemCockpitAim).
    snap[AVATAR_SNAP_AIM_YAW] = 0x18;
    snap[AVATAR_SNAP_AIM_PITCH] = -0x30;
    tickX1Walk(x1, snap);
    expect(x1.aimYaw[0]).toBe(0x18);
    expect(x1.aimPitch[0]).toBe(-0x30);
  });
});
