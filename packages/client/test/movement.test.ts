import { describe, expect, test } from "bun:test";
import type { Vec2 } from "../src/input/gamepadMapping";
import { cameraRelativeMove } from "../src/input/movement";

const out: Vec2 = { x: 0, y: 0 };
function move(strafe: number, forward: number, fx: number, fy: number): Vec2 {
  return cameraRelativeMove(strafe, forward, fx, fy, { x: 0, y: 0 });
}

describe("cameraRelativeMove", () => {
  test("no facing yet → world-relative passthrough", () => {
    expect(move(0, 1, 0, 0)).toEqual({ x: 0, y: 1 });
    expect(move(1, 0, 0, 0)).toEqual({ x: 1, y: 0 });
    expect(move(-1, 0, 0, 0)).toEqual({ x: -1, y: 0 });
  });

  test("facing +x: forward drives +x, strafe-right drives +y", () => {
    expect(move(0, 1, 1, 0)).toEqual({ x: 1, y: 0 }); // W → into camera-forward
    expect(move(0, -1, 1, 0)).toEqual({ x: -1, y: 0 }); // S → backward
    expect(move(1, 0, 1, 0)).toEqual({ x: 0, y: 1 }); // D → screen right
    expect(move(-1, 0, 1, 0)).toEqual({ x: 0, y: -1 }); // A → screen left
  });

  test("facing +y: forward follows the camera; screen-right flips to -x", () => {
    const w = move(0, 1, 0, 1);
    expect(w.x).toBeCloseTo(0, 12);
    expect(w.y).toBeCloseTo(1, 12);
    const d = move(1, 0, 0, 1);
    expect(d.x).toBeCloseTo(-1, 12);
    expect(d.y).toBeCloseTo(0, 12);
  });

  test("rotation preserves magnitude for a single axis", () => {
    const v = move(0, 1, 0.6, 0.8); // arbitrary unit facing
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 12);
  });

  test("a rotated diagonal is clamped to unit length (survives quantization)", () => {
    const v = move(1, 1, 1, 0); // W+D while facing +x
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 12);
    expect(v.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(v.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(Math.abs(v.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(v.y)).toBeLessThanOrEqual(1);
  });

  test("sub-unit analog magnitude (throttle) is preserved", () => {
    const v = move(0, 0.5, 1, 0);
    expect(v.x).toBeCloseTo(0.5, 12);
    expect(v.y).toBeCloseTo(0, 12);
  });

  test("facing need not be normalized", () => {
    expect(move(0, 1, 2, 0)).toEqual({ x: 1, y: 0 });
  });

  test("writes into and returns the provided out vector", () => {
    const r = cameraRelativeMove(0, 1, 1, 0, out);
    expect(r).toBe(out);
    expect(out).toEqual({ x: 1, y: 0 });
  });
});
