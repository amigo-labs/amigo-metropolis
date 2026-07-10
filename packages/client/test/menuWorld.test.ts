// The menu demo battle reuses the Phase 3 feeder script, generalized to either
// slot. Slot 1 must stay byte-identical to the historic ?opponent=feeder
// behavior (its move constants were authored for slot 1's base), and slot 0
// must be the exact mirror (district-01 mirrors the bases about x).

import { describe, expect, test } from "bun:test";
import { BUTTON_INTERACT, DISTRICT_01_ID, getMapById, type PlayerInput } from "@metropolis/sim";
import { createDemoSim, demoFeeder, zeroPlayerInput } from "../src/menuWorld";

function freshInput(): PlayerInput {
  return { moveX: 9, moveY: 9, aimX: 9, aimY: 9, buttons: 9 };
}

describe("demoFeeder", () => {
  test("slot 1 reproduces the historic feeder pattern", () => {
    const out = freshInput();
    demoFeeder(1, 0, out);
    expect(out).toEqual({ moveX: 40, moveY: 120, aimX: 0, aimY: 0, buttons: 0 });
    demoFeeder(1, 75, out);
    expect(out.moveX).toBe(40);
    expect(out.moveY).toBe(120);
    // After the walk: 10 s INTERACT bursts, 20 s pauses (900-tick cycle).
    demoFeeder(1, 76, out);
    expect(out).toEqual({ moveX: 0, moveY: 0, aimX: 0, aimY: 0, buttons: BUTTON_INTERACT });
    demoFeeder(1, 900 + 299, out);
    expect(out.buttons).toBe(BUTTON_INTERACT);
    demoFeeder(1, 900 + 300, out);
    expect(out.buttons).toBe(0);
  });

  test("slot 0 mirrors the walk and keeps the button schedule", () => {
    const a = freshInput();
    const b = freshInput();
    for (const tick of [0, 40, 75, 76, 300, 899, 900, 1200]) {
      demoFeeder(0, tick, a);
      demoFeeder(1, tick, b);
      expect(a.moveX + b.moveX).toBe(0); // exact mirror (sum form avoids -0)
      expect(a.moveY + b.moveY).toBe(0);
      expect(a.buttons).toBe(b.buttons);
      expect(a.aimX).toBe(0);
      expect(a.aimY).toBe(0);
    }
  });
});

describe("zeroPlayerInput", () => {
  test("clears every field", () => {
    const out = freshInput();
    zeroPlayerInput(out);
    expect(out).toEqual({ moveX: 0, moveY: 0, aimX: 0, aimY: 0, buttons: 0 });
  });
});

describe("createDemoSim", () => {
  test("builds a Warden-on-slot-1 sim on the given map", () => {
    const sim = createDemoSim(getMapById(DISTRICT_01_ID));
    expect(sim.wardenPlayer).toBe(1);
    expect(sim.wardenDifficulty).toBe(5);
    expect(sim.tick).toBe(0);
  });
});
