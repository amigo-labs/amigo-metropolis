import { describe, expect, test } from "bun:test";
import {
  ASSIST_CONE_COS,
  ASSIST_STRENGTH,
  applyAimAssist,
  parseAimAssistMode,
} from "../src/input/aimAssist";
import type { Vec2 } from "../src/input/gamepadMapping";

const out: Vec2 = { x: 0, y: 0 };
const CONE = ASSIST_CONE_COS;
const S = ASSIST_STRENGTH;

describe("parseAimAssistMode", () => {
  test("only 'assist' and 'lock' are honored; everything else is off", () => {
    expect(parseAimAssistMode("assist")).toBe("assist");
    expect(parseAimAssistMode("lock")).toBe("lock");
    expect(parseAimAssistMode("off")).toBe("off");
    expect(parseAimAssistMode(null)).toBe("off");
    expect(parseAimAssistMode("nonsense")).toBe("off");
  });
});

describe("applyAimAssist", () => {
  test("pulls the aim toward an enemy inside the cone", () => {
    // Self at origin aiming +x; enemy slightly north of the aim line, in-cone.
    const enemies = new Float32Array([10, 1]);
    const pulled = applyAimAssist(1, 0, 0, 0, enemies, 1, CONE, S, out);
    expect(pulled).toBe(true);
    expect(out.y).toBeGreaterThan(0); // nudged toward the enemy (north)
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(1, 9); // stays a unit vector
    // Partial pull: not all the way onto the enemy direction.
    const enemyDirY = 1 / Math.hypot(10, 1);
    expect(out.y).toBeLessThan(enemyDirY);
  });

  test("ignores enemies outside the cone", () => {
    // Enemy due north while aiming +x is ~90° away — well outside a 25° cone.
    const enemies = new Float32Array([0, 10]);
    const pulled = applyAimAssist(1, 0, 0, 0, enemies, 1, CONE, S, out);
    expect(pulled).toBe(false);
    expect(out.x).toBe(1);
    expect(out.y).toBe(0);
  });

  test("picks the nearest in-cone enemy", () => {
    // Two enemies on the aim line; the nearer one is at +x=5, farther at +x=20
    // nudged north. Nearest wins → negligible vertical pull.
    const enemies = new Float32Array([5, 0, 20, 5]);
    applyAimAssist(1, 0, 0, 0, enemies, 2, CONE, S, out);
    expect(out.x).toBeCloseTo(1, 9);
    expect(out.y).toBeCloseTo(0, 9);
  });

  test("no enemies → aim unchanged", () => {
    const enemies = new Float32Array(0);
    expect(applyAimAssist(0.6, 0.8, 3, 3, enemies, 0, CONE, S, out)).toBe(false);
    expect(out.x).toBeCloseTo(0.6, 9);
    expect(out.y).toBeCloseTo(0.8, 9);
  });

  test("an enemy exactly on the aim line leaves the direction unchanged", () => {
    const enemies = new Float32Array([7, 0]);
    applyAimAssist(1, 0, 0, 0, enemies, 1, CONE, S, out);
    expect(out.x).toBeCloseTo(1, 9);
    expect(out.y).toBeCloseTo(0, 9);
  });

  test("strength 1 snaps fully onto the target direction", () => {
    const enemies = new Float32Array([10, 3]);
    applyAimAssist(1, 0, 0, 0, enemies, 1, CONE, 1, out);
    const inv = 1 / Math.hypot(10, 3);
    expect(out.x).toBeCloseTo(10 * inv, 6);
    expect(out.y).toBeCloseTo(3 * inv, 6);
  });
});
