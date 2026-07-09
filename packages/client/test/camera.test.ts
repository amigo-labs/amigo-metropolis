import { describe, expect, test } from "bun:test";
import {
  type CameraInput,
  type CameraState,
  createCameraState,
  DEFAULT_RIG_CONFIG,
  deriveCameraPose,
  smoothstep,
  updateCamera,
  type Vec3,
} from "../src/render/camera";

const cfg = DEFAULT_RIG_CONFIG;

function neutralInput(over: Partial<CameraInput> = {}): CameraInput {
  return {
    zoomDelta: 0,
    yawDelta: 0,
    panDelta: { x: 0, y: 0, z: 0 },
    recenter: false,
    snapTarget: null,
    ...over,
  };
}

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const STILL: Vec3 = { x: 0, y: 0, z: 0 };

/** Runs the rig for `seconds` at a fixed `fps`, holding a constant input. */
function run(state: CameraState, input: CameraInput, target: Vec3, fps: number, seconds: number) {
  const dt = 1 / fps;
  const steps = Math.round(seconds * fps);
  for (let i = 0; i < steps; i++) {
    updateCamera(state, input, target, STILL, true, cfg, dt);
  }
  return state;
}

describe("smoothstep", () => {
  test("clamped Hermite, monotone through the ends and midpoint", () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 12);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(2)).toBe(1);
    expect(smoothstep(0.25)).toBeLessThan(0.25); // eased-in below the mid
  });
});

describe("updateCamera — framerate stability (DoD §10)", () => {
  // The core determinism-adjacent guarantee: exponential smoothing with
  // 1-exp(-dt/tau) reaches the same value over a fixed wall-clock span no matter
  // how it is subdivided. Three very different framerates must converge alike.
  test("t damping (pure exponential, no deadzone) is EXACTLY framerate-identical", () => {
    // tTarget is pinned so the only variable is the damping cadence.
    const mk = () => {
      const s = createCameraState(ORIGIN, 0);
      s.tTarget = 1;
      return s;
    };
    const a = run(mk(), neutralInput(), ORIGIN, 30, 2);
    const b = run(mk(), neutralInput(), ORIGIN, 60, 2);
    const c = run(mk(), neutralInput(), ORIGIN, 144, 2);
    expect(a.t).toBeCloseTo(b.t, 9);
    expect(b.t).toBeCloseTo(c.t, 9);
  });

  test("focus damping matches across framerates while actively closing (gap >> deadzone)", () => {
    // Far target + a 0.5 s span (an exact integer frame count at all three
    // framerates: 15 / 30 / 72) → the focus stays well outside the deadzone the
    // whole time, so the exponential closes identically regardless of fps.
    const target: Vec3 = { x: 100, y: 0, z: -100 };
    const a = run(createCameraState(ORIGIN, 0), neutralInput(), target, 30, 0.5);
    const b = run(createCameraState(ORIGIN, 0), neutralInput(), target, 60, 0.5);
    const c = run(createCameraState(ORIGIN, 0), neutralInput(), target, 144, 0.5);
    expect(a.focus.x).toBeCloseTo(b.focus.x, 6);
    expect(b.focus.x).toBeCloseTo(c.focus.x, 6);
    expect(a.focus.z).toBeCloseTo(c.focus.z, 6);
    // …and each matches the closed-form continuous solution 100·(1−e^(−T/τ)).
    const closed = 100 * (1 - Math.exp(-0.5 / cfg.followSmoothTime));
    expect(a.focus.x).toBeCloseTo(closed, 6);
  });

  test("focus homes onto a static target to within the deadzone, at any framerate", () => {
    const target: Vec3 = { x: 4, y: 1, z: 2 };
    for (const fps of [30, 60, 144]) {
      const s = run(createCameraState(ORIGIN, 0), neutralInput(), target, fps, 5);
      const dx = s.focus.x - target.x;
      const dy = s.focus.y - (target.y + cfg.focusHeight);
      const dz = s.focus.z - target.z;
      expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeLessThanOrEqual(cfg.deadzone + 1e-6);
    }
  });
});

describe("updateCamera — view continuum", () => {
  test("zoom raises tTarget and t chases it, clamped to [0,1]", () => {
    const s = run(createCameraState(ORIGIN, 0), neutralInput({ zoomDelta: 0.5 }), ORIGIN, 60, 3);
    expect(s.tTarget).toBe(1);
    expect(s.t).toBeGreaterThan(0.9);
    const s2 = run(createCameraState(ORIGIN, 0), neutralInput({ zoomDelta: -0.5 }), ORIGIN, 60, 1);
    expect(s2.tTarget).toBe(0);
  });

  test("snapTarget overrides accumulation", () => {
    const s = createCameraState(ORIGIN, 0);
    updateCamera(
      s,
      neutralInput({ zoomDelta: 0.9, snapTarget: 0.3 }),
      ORIGIN,
      STILL,
      true,
      cfg,
      1 / 60,
    );
    expect(s.tTarget).toBe(0.3);
  });

  test("transform bias shifts the resting t but the player still wins", () => {
    // Pursuit biases toward TACTICAL, walker toward ACTION, for the SAME tTarget.
    const pursuit = createCameraState(ORIGIN, 0);
    const walker = createCameraState(ORIGIN, 0);
    const dt = 1 / 60;
    for (let i = 0; i < 300; i++) {
      updateCamera(pursuit, neutralInput({ snapTarget: 0.5 }), ORIGIN, STILL, true, cfg, dt);
      updateCamera(walker, neutralInput({ snapTarget: 0.5 }), ORIGIN, STILL, false, cfg, dt);
    }
    expect(pursuit.t).toBeGreaterThan(walker.t);
    expect(pursuit.t).toBeCloseTo(0.5 + cfg.transformBias, 3);
    expect(walker.t).toBeCloseTo(0.5 - cfg.transformBias, 3);
  });
});

describe("updateCamera — yaw policy (§3)", () => {
  test("yawDelta is ignored while world-fixed (locked)", () => {
    const s = createCameraState(ORIGIN, 0);
    run(s, neutralInput({ yawDelta: 0.2 }), ORIGIN, 60, 2);
    expect(s.yaw).toBe(0);
    expect(s.yawTarget).toBe(0);
  });

  test("yawDelta rotates when unlocked", () => {
    const unlocked = { ...cfg, yawLocked: false };
    const s = createCameraState(ORIGIN, 0);
    const dt = 1 / 60;
    for (let i = 0; i < 120; i++) {
      updateCamera(s, neutralInput({ yawDelta: 0.01 }), ORIGIN, STILL, true, unlocked, dt);
    }
    expect(s.yawTarget).toBeCloseTo(1.2, 6);
    expect(s.yaw).toBeGreaterThan(1.0);
  });
});

describe("updateCamera — free-look (§4.4)", () => {
  test("pan only accumulates in the tactical range; recenter zeroes it", () => {
    const pan = neutralInput({ panDelta: { x: 1, y: 0, z: 0 } });
    // Below threshold: focus stays hard on the unit, pan does not build up.
    const low = createCameraState(ORIGIN, 0);
    low.t = 0.2;
    low.tTarget = 0.2;
    run(low, pan, ORIGIN, 60, 1);
    expect(Math.abs(low.panOffset.x)).toBeLessThan(0.05);

    // Tactical: pan accumulates and moves the focus off the unit.
    const high = createCameraState(ORIGIN, 0);
    high.t = 0.9;
    high.tTarget = 0.9;
    run(high, pan, ORIGIN, 60, 1);
    expect(high.panOffset.x).toBeGreaterThan(1);

    // Recenter damps the offset back toward the unit.
    run(high, neutralInput({ recenter: true }), ORIGIN, 60, 3);
    expect(Math.abs(high.panOffset.x)).toBeLessThan(0.05);
  });
});

describe("updateCamera — look-ahead (§4.2)", () => {
  test("focus leads the unit toward its velocity, saturating at lookAheadMax", () => {
    const s = createCameraState(ORIGIN, 0);
    const vel: Vec3 = { x: 100, y: 0, z: 0 }; // well past the saturation speed
    const dt = 1 / 60;
    for (let i = 0; i < 600; i++) updateCamera(s, neutralInput(), ORIGIN, vel, true, cfg, dt);
    // Settles within the deadzone of the full lookAheadMax lead.
    expect(cfg.lookAheadMax - s.focus.x).toBeLessThanOrEqual(cfg.deadzone + 1e-6);
    expect(s.focus.x).toBeGreaterThan(cfg.lookAheadMax - cfg.deadzone - 1e-6);
    expect(Math.abs(s.focus.z)).toBeLessThan(0.05);
  });
});

describe("deriveCameraPose", () => {
  const eye: Vec3 = { x: 0, y: 0, z: 0 };
  const target: Vec3 = { x: 0, y: 0, z: 0 };

  test("target is the focus; eye sits behind and above by t-eased anchors", () => {
    const s = createCameraState({ x: 5, y: 1, z: -2 }, 0);
    s.t = 0; // ACTION
    const fov = deriveCameraPose(s, cfg, eye, target);
    expect(target).toEqual({ x: 5, y: 1, z: -2 });
    expect(fov).toBeCloseTo(cfg.action.fovDeg, 6);
    // yaw 0 → ground-forward +x → eye is pulled back along -x and lifted.
    expect(eye.x).toBeLessThan(target.x);
    expect(eye.y).toBeGreaterThan(target.y);
    expect(eye.z).toBeCloseTo(target.z, 6);
  });

  test("higher t frames higher and farther (tactical)", () => {
    const s = createCameraState(ORIGIN, 0);
    s.t = 0;
    deriveCameraPose(s, cfg, eye, target);
    const lowRise = eye.y;
    const lowRun = Math.abs(eye.x);
    s.t = 1;
    const fovHigh = deriveCameraPose(s, cfg, eye, target);
    expect(eye.y).toBeGreaterThan(lowRise); // steeper → higher
    expect(Math.abs(eye.x)).toBeGreaterThan(lowRun); // farther dolly
    expect(fovHigh).toBeCloseTo(cfg.tactical.fovDeg, 6);
  });

  test("yaw orients the pull-back direction in the ground plane", () => {
    const s = createCameraState(ORIGIN, Math.PI / 2); // ground-forward +z
    s.t = 0.5;
    deriveCameraPose(s, cfg, eye, target);
    expect(eye.x).toBeCloseTo(0, 6);
    expect(eye.z).toBeLessThan(0); // pulled back along -z
  });
});
