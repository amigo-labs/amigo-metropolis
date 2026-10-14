// The menu's stick math (no DOM/three, so it runs under `bun test`): the radial
// deadzone rescale the menu navigation reads a pad through.

import { describe, expect, it } from "bun:test";
import { STICK_DEADZONE, stickWithDeadzone, type Vec2 } from "../src/input/gamepadMapping";

describe("stickWithDeadzone", () => {
  const out: Vec2 = { x: 0, y: 0 };

  it("collapses anything inside the deadzone to zero", () => {
    expect(stickWithDeadzone(0, 0, 0.2, out)).toBe(0);
    expect(out).toEqual({ x: 0, y: 0 });
    expect(stickWithDeadzone(0.1, 0.1, 0.2, out)).toBe(0); // mag ≈ 0.141 < 0.2
    expect(out).toEqual({ x: 0, y: 0 });
  });

  it("rescales so the edge of the deadzone reads as zero throttle", () => {
    // Just past the deadzone along +x → magnitude near 0, same direction.
    const mag = stickWithDeadzone(0.2 + 1e-6, 0, 0.2, out);
    expect(mag).toBeGreaterThan(0);
    expect(mag).toBeLessThan(0.001);
    expect(out.x).toBeGreaterThan(0);
    expect(out.y).toBe(0);
  });

  it("reaches full unit magnitude at the stick extreme", () => {
    const mag = stickWithDeadzone(1, 0, 0.2, out);
    expect(mag).toBeCloseTo(1, 6);
    expect(out.x).toBeCloseTo(1, 6);
    expect(out.y).toBeCloseTo(0, 6);
  });

  it("clamps past-unit inputs (diagonal corners) to the unit disk", () => {
    const mag = stickWithDeadzone(1, 1, 0.2, out);
    expect(mag).toBeCloseTo(1, 6);
    const len = Math.sqrt(out.x * out.x + out.y * out.y);
    expect(len).toBeCloseTo(1, 6);
    // Direction preserved: equal components on the x=y diagonal.
    expect(out.x).toBeCloseTo(out.y, 6);
  });

  it("preserves direction while rescaling magnitude", () => {
    stickWithDeadzone(0.6, 0.8, STICK_DEADZONE, out); // input already unit-length
    // Direction (3,4)/5 preserved.
    expect(out.x / out.y).toBeCloseTo(0.6 / 0.8, 6);
  });
});
