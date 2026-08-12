// The transformation morph is the one piece of the walker <-> hover change that
// a screenshot cannot check: it is a curve over 0.8 s, and any single frame of
// it looks plausible. So the curves and the slot bookkeeping are pinned here,
// and the pin harness is left to judge whether it looks right.

import { describe, expect, test } from "bun:test";
import { TICK_HZ, TRANSFORM_LOCK_TICKS } from "@metropolis/sim";
import {
  createAvatarMorph,
  foldAt,
  foldRadiansAt,
  MORPH_DRAW_HOVER,
  MORPH_DURATION_SEC,
  MORPH_OUT_LEN,
  MORPH_SCALE_XZ,
  MORPH_SCALE_Y,
  MORPH_SLOTS,
  MORPH_SPIN,
  spinAt,
  spreadXZAt,
  squashYAt,
} from "../src/render/morph";

const out = new Float32Array(MORPH_OUT_LEN);

describe("morph curves", () => {
  test("the mech starts and ends at its standing proportions", () => {
    for (const t of [0, 1]) {
      expect(squashYAt(t)).toBeCloseTo(1, 6);
      expect(spreadXZAt(t)).toBeCloseTo(1, 6);
      expect(foldRadiansAt(t)).toBeCloseTo(0, 6);
    }
  });

  test("it is flattest and widest exactly at the swap", () => {
    expect(foldAt(0.5)).toBeCloseTo(1, 6);
    expect(squashYAt(0.5)).toBeLessThan(0.4);
    expect(spreadXZAt(0.5)).toBeGreaterThan(1.15);
    // And nowhere else is flatter — a curve that overshoots past the swap would
    // pop the mech back up through the mesh change.
    for (let t = 0; t <= 1.0001; t += 0.02) {
      expect(squashYAt(t)).toBeGreaterThanOrEqual(squashYAt(0.5) - 1e-6);
      expect(spreadXZAt(t)).toBeLessThanOrEqual(spreadXZAt(0.5) + 1e-6);
    }
  });

  test("the collapse eases out of rest rather than snapping into it", () => {
    // Smoothstep, not a tent: the first slice of the morph moves far less than
    // a linear ramp would, which is what keeps the start from reading as a jolt.
    expect(foldAt(0.05)).toBeLessThan(0.1);
    expect(foldAt(0.95)).toBeLessThan(0.1);
  });

  test("the spin is monotonic and lands back on the original heading", () => {
    expect(spinAt(0)).toBeCloseTo(0, 6);
    expect(spinAt(1)).toBeCloseTo(Math.PI * 2, 6);
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const v = spinAt(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  test("the hip tuck goes well past the walk cycle's swing", () => {
    // SWING_RADIANS is 0.44 in avatarRig; a fold that stayed under it would read
    // as a stride, not as legs being put away.
    expect(foldRadiansAt(0.5)).toBeGreaterThan(0.44 * 2);
  });
});

describe("morph duration", () => {
  test("it is the sim's transform lock, not a number of its own", () => {
    expect(MORPH_DURATION_SEC).toBeCloseTo(TRANSFORM_LOCK_TICKS / TICK_HZ, 6);
  });
});

describe("morph slots", () => {
  test("a started morph runs for the lock and then releases itself", () => {
    const m = createAvatarMorph();
    m.start(7, true);
    expect(m.live).toBe(1);
    expect(m.sample(7, out)).toBe(true);

    m.advance(MORPH_DURATION_SEC * 0.5);
    expect(m.sample(7, out)).toBe(true);

    m.advance(MORPH_DURATION_SEC * 0.51);
    expect(m.live).toBe(0);
    expect(m.sample(7, out)).toBe(false);
  });

  test("the form on screen is the source first, the destination after the swap", () => {
    const m = createAvatarMorph();
    m.start(3, true); // walker -> hover

    m.sample(3, out);
    expect(out[MORPH_DRAW_HOVER]).toBe(0); // still the walker it is leaving

    m.advance(MORPH_DURATION_SEC * 0.51);
    m.sample(3, out);
    expect(out[MORPH_DRAW_HOVER]).toBe(1); // now the hover it is becoming
  });

  test("and the other way round for hover -> walker", () => {
    const m = createAvatarMorph();
    m.start(3, false);

    m.sample(3, out);
    expect(out[MORPH_DRAW_HOVER]).toBe(1);

    m.advance(MORPH_DURATION_SEC * 0.51);
    m.sample(3, out);
    expect(out[MORPH_DRAW_HOVER]).toBe(0);
  });

  test("sample leaves the buffer untouched for an avatar that is not morphing", () => {
    const m = createAvatarMorph();
    out.fill(-99);
    expect(m.sample(42, out)).toBe(false);
    for (let i = 0; i < MORPH_OUT_LEN; i++) expect(out[i]).toBe(-99);
  });

  test("release ends a morph early — the sim is the authority on the lock", () => {
    const m = createAvatarMorph();
    m.start(1, true);
    m.advance(MORPH_DURATION_SEC * 0.25);

    m.release(1);

    expect(m.live).toBe(0);
    expect(m.sample(1, out)).toBe(false);
    // Releasing something that is not morphing is a no-op, not a corrupt count.
    m.release(1);
    m.release(999);
    expect(m.live).toBe(0);
  });

  test("slots are recycled, so a match's worth of transforms never fills them", () => {
    const m = createAvatarMorph();
    for (let round = 0; round < 50; round++) {
      for (let id = 0; id < MORPH_SLOTS; id++) m.start(id, round % 2 === 0);
      expect(m.live).toBe(MORPH_SLOTS);
      m.advance(MORPH_DURATION_SEC + 0.01);
      expect(m.live).toBe(0);
    }
  });

  test("restarting an avatar mid-morph reuses its slot and rewinds it", () => {
    const m = createAvatarMorph();
    m.start(2, true);
    m.advance(MORPH_DURATION_SEC * 0.75);

    m.start(2, false); // transformed straight back

    expect(m.live).toBe(1);
    m.sample(2, out);
    // Rewound to the start: standing proportions, and drawing the hover form it
    // is now leaving.
    expect(out[MORPH_SCALE_Y]).toBeCloseTo(1, 6);
    expect(out[MORPH_SCALE_XZ]).toBeCloseTo(1, 6);
    expect(out[MORPH_SPIN]).toBeCloseTo(0, 6);
    expect(out[MORPH_DRAW_HOVER]).toBe(1);
  });

  test("more avatars than slots drops the extra morph, it does not corrupt live", () => {
    const m = createAvatarMorph();
    for (let id = 0; id < MORPH_SLOTS + 3; id++) m.start(id, true);
    expect(m.live).toBe(MORPH_SLOTS);
    expect(m.sample(MORPH_SLOTS + 1, out)).toBe(false);
  });

  test("advance ignores a zero or negative frame time", () => {
    const m = createAvatarMorph();
    m.start(5, true);
    m.advance(0);
    m.advance(-1);
    expect(m.live).toBe(1);
    m.sample(5, out);
    expect(out[MORPH_SCALE_Y]).toBeCloseTo(1, 6);
  });
});
