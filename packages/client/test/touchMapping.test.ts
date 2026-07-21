// Pure touch-mapping math (no DOM/three, so it runs under `bun test`). Guards
// the numeric decisions a human can't eyeball without a touchscreen: the
// screen→input y-inversion, the radius-normalized deadzone, the aim stick's
// snap-to-unit (must clear the sim facing threshold after quantization), the
// button table, and the twin-stick auto-fire rule.

import { describe, expect, it } from "bun:test";
import {
  BUTTON_FIRE1,
  BUTTON_FIRE2,
  BUTTON_FIRE3,
  BUTTON_INTERACT,
  BUTTON_JUMP,
  BUTTON_TRANSFORM,
  quantizeAxis,
} from "@metropolis/sim";
import { STICK_DEADZONE, type Vec2 } from "../src/input/gamepadMapping";
import {
  applyStick,
  autoFirePrimary,
  snapAimStick,
  TOUCH_BUTTONS,
  TOUCH_STICK_RADIUS_PX,
} from "../src/input/touchMapping";

const R = TOUCH_STICK_RADIUS_PX;

describe("applyStick (move)", () => {
  const out: Vec2 = { x: 0, y: 0 };

  it("collapses displacements inside the deadzone to zero", () => {
    expect(applyStick(0, 0, R, out)).toBe(0);
    expect(out).toEqual({ x: 0, y: 0 });
    // Just under deadzone * radius pixels of travel.
    expect(applyStick(R * STICK_DEADZONE * 0.9, 0, R, out)).toBe(0);
    expect(out).toEqual({ x: 0, y: 0 });
  });

  it("inverts DOM y: a finger dragged up-screen means forward (+y)", () => {
    const mag = applyStick(0, -R, R, out); // dyPx negative = up-screen
    expect(mag).toBeCloseTo(1, 6);
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo(1, 6);
  });

  it("normalizes by the radius and reaches full magnitude at the rim", () => {
    const mag = applyStick(R, 0, R, out);
    expect(mag).toBeCloseTo(1, 6);
    expect(out).toEqual({ x: 1, y: -0 });
    // Half travel lands strictly between deadzone-edge and full throttle.
    const half = applyStick(R / 2, 0, R, out);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
  });

  it("clamps past-rim drags to the unit disk, preserving direction", () => {
    const mag = applyStick(2 * R, -2 * R, R, out);
    expect(mag).toBeCloseTo(1, 6);
    expect(Math.sqrt(out.x * out.x + out.y * out.y)).toBeCloseTo(1, 6);
    expect(out.x).toBeCloseTo(out.y, 6); // 45° up-right stays 45°
  });
});

describe("snapAimStick (aim)", () => {
  const aim: Vec2 = { x: 1, y: 0 };

  it("does not engage (and keeps out untouched) inside the deadzone", () => {
    aim.x = 0.6;
    aim.y = 0.8;
    expect(snapAimStick(0, 0, R, aim)).toBe(false);
    expect(snapAimStick(R * STICK_DEADZONE, 0, R, aim)).toBe(false); // at the edge
    expect(aim).toEqual({ x: 0.6, y: 0.8 }); // hold-last: caller keeps previous
  });

  it("snaps any engaged displacement to a unit direction, y-inverted", () => {
    // Small-but-engaged drag up-left: unit length regardless of travel.
    expect(snapAimStick(-R * 0.3, -R * 0.3, R, aim)).toBe(true);
    expect(Math.sqrt(aim.x * aim.x + aim.y * aim.y)).toBeCloseTo(1, 6);
    expect(aim.x).toBeLessThan(0);
    expect(aim.y).toBeGreaterThan(0); // up-screen → +y
  });

  it("always clears the sim facing threshold after quantization", () => {
    // sim.ts facing gate: (aimX*S)² + (aimY*S)² > 0.04 with S = 1/127 —
    // i.e. the de-quantized magnitude must exceed 0.2. A unit vector holds
    // that for every direction; probe a sweep of engaged angles.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const engaged = snapAimStick(Math.cos(a) * R, Math.sin(a) * R, R, aim);
      expect(engaged).toBe(true);
      const qx = quantizeAxis(aim.x) / 127;
      const qy = quantizeAxis(aim.y) / 127;
      expect(qx * qx + qy * qy).toBeGreaterThan(0.04);
    }
  });
});

describe("TOUCH_BUTTONS", () => {
  it("covers exactly the non-stick actions; FIRE1 stays auto-fire-only", () => {
    const bits = TOUCH_BUTTONS.map((b) => b.bit);
    expect(new Set(bits)).toEqual(
      new Set([BUTTON_FIRE2, BUTTON_FIRE3, BUTTON_JUMP, BUTTON_TRANSFORM, BUTTON_INTERACT]),
    );
    expect(bits).not.toContain(BUTTON_FIRE1);
  });

  it("assigns each id and each bit exactly once", () => {
    const ids = TOUCH_BUTTONS.map((b) => b.id);
    const bits = TOUCH_BUTTONS.map((b) => b.bit);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(bits).size).toBe(bits.length);
  });
});

describe("autoFirePrimary", () => {
  it("holds FIRE1 exactly while the aim stick is engaged", () => {
    expect(autoFirePrimary(true)).toBe(BUTTON_FIRE1);
    expect(autoFirePrimary(false)).toBe(0);
  });
});
