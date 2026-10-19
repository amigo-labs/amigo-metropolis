// The camera shake (render/cameraShake.ts) against the original's two damage
// meters and the camera tick's last arm (RE game/actor/player.c 0x00446200,
// 0x00446720; game/actor/effect.c 0x0042d020; game/frame/view_place.c
// 0x00445d10..0x00445dc4), and the records' exported shakes.

import { describe, expect, test } from "bun:test";
import { FX_RECORDS } from "../src/effects/fcopEffects.generated";
import { FXF_HARD_SHAKE, FXF_SHAKE, type FxShake } from "../src/effects/records";
import { createChasePose, WU_PER_M } from "../src/render/camera";
import {
  applyCameraShake,
  createCameraShake,
  resetCameraShake,
  shakeAdd,
  shakeDamage,
  shakeEffect,
  shakeSpan,
  vecMagnitudeWu,
} from "../src/render/cameraShake";

describe("player_damage_meter: the second meter", () => {
  test("adds a quarter of the share, rounding toward zero", () => {
    const s = createCameraShake();
    shakeAdd(s, 0x7f);
    expect(s.meter).toBe(0x1f);
  });

  test("is gated on what is there, not clamped: it can end past 0xff", () => {
    const s = createCameraShake();
    s.meter = 0xff;
    shakeAdd(s, 1000);
    expect(s.meter).toBe(0xff + 250);
    shakeAdd(s, 1000);
    expect(s.meter).toBe(0xff + 250);
  });

  test("caps the quarter at 0xff", () => {
    const s = createCameraShake();
    shakeAdd(s, 4000);
    expect(s.meter).toBe(0xff);
  });
});

describe("player_take_amount: the share", () => {
  test("is amount * 5 << 10 / max, halved by the team game", () => {
    const s = createCameraShake();
    shakeDamage(s, 25, 1250, true);
    // 25 * 5120 / 1250 = 102; the first meter keeps 102; 102 / 2 = 51; 51 / 4 = 12.
    expect(s.damage).toBe(102);
    expect(s.meter).toBe(12);
  });

  test("the first meter accumulates to 0x1c2 while the share passed on is clamped to 0x200", () => {
    const s = createCameraShake();
    shakeDamage(s, 500, 1250, false);
    // 2048: kept 0x1c2, passed 0x200 -> a quarter 0x80.
    expect(s.damage).toBe(0x1c2);
    expect(s.meter).toBe(0x80);
    // Saturated: a small hit still passes 0x1c2 + its own share.
    const t = createCameraShake();
    t.damage = 0x1c2;
    shakeDamage(t, 1, 1250, true);
    expect(t.meter).toBe(Math.trunc(Math.trunc((0x1c2 + 4) / 2) / 4));
  });

  test("a non-positive amount does nothing; a respawn zeroes both meters", () => {
    const s = createCameraShake();
    shakeDamage(s, 0, 1250, true);
    shakeDamage(s, -5, 1250, true);
    expect(s.meter).toBe(0);
    expect(s.damage).toBe(0);
    shakeDamage(s, 100, 1250, true);
    expect(s.meter).toBeGreaterThan(0);
    resetCameraShake(s, 7);
    expect(s.meter).toBe(0);
    expect(s.damage).toBe(0);
    expect(s.avatar).toBe(7);
  });
});

describe("cact_effect_install: the effect's shake", () => {
  test("every record's exported shake is its +0x32 bits: 300 with bit 4, 1000 with bit 13", () => {
    let shaking = 0;
    for (const rec of FX_RECORDS) {
      const bits = rec.flags & (FXF_SHAKE | FXF_HARD_SHAKE);
      if (bits === 0) {
        expect(rec.shake).toBeUndefined();
        continue;
      }
      shaking++;
      const shake = rec.shake as FxShake;
      expect(shake.amount).toBe((rec.flags & FXF_HARD_SHAKE) !== 0 ? 1000 : 300);
      // player_damage_meter's add, and the install's range.
      expect(shake.add).toBe(Math.min(Math.trunc(shake.amount / 4), 0xff));
      expect(shake.range).toBe(0x20000);
    }
    expect(shaking).toBeGreaterThan(0);
  });

  test("within the range by vec_magnitude: max + (mid + min) / 4", () => {
    const hard: FxShake = { amount: 1000, add: 250, range: 0x20000 };
    const light: FxShake = { amount: 300, add: 75, range: 0x20000 };
    expect(vecMagnitudeWu(3, 0, 4)).toBe(4 * WU_PER_M + ((3 * WU_PER_M) >> 2));
    const s = createCameraShake();
    shakeEffect(s, hard, 15.9, 0, 0);
    expect(s.meter).toBe(250);
    const far = createCameraShake();
    shakeEffect(far, hard, 14, 4, 4); // 14 + 8 / 4 = 16 m: out of range
    expect(far.meter).toBe(0);
    shakeEffect(far, undefined, 1, 0, 0); // a record without one
    expect(far.meter).toBe(0);
    shakeEffect(far, light, 1, 0, 0);
    expect(far.meter).toBe(75);
  });
});

describe("view_player_camera_tick: the shake's arm", () => {
  test("the span is the top bit of min(meter, 0xff)", () => {
    expect(shakeSpan(1)).toBe(1);
    expect(shakeSpan(75)).toBe(64);
    expect(shakeSpan(0xff)).toBe(128);
  });

  test("moves the eye within (span / 2) << 3 world units an axis and spends dt", () => {
    const s = createCameraShake(1234);
    const pose = createChasePose();
    pose.yaw = 0.7;
    pose.pitch = 0.4;
    let maxOff = 0;
    s.meter = 0x1fe; // past the gate: the span is still min(meter, 0xff)'s
    for (let i = 0; i < 40; i++) {
      pose.eyeX = 0;
      pose.eyeY = 0;
      pose.eyeZ = 0;
      const before = s.meter;
      applyCameraShake(s, 8, pose);
      expect(s.meter).toBe(Math.max(0, before - 8));
      const off = Math.hypot(pose.eyeX, pose.eyeY, pose.eyeZ);
      maxOff = Math.max(maxOff, off);
    }
    // Two orthogonal axes of at most 64 << 3 world units each.
    expect(maxOff).toBeGreaterThan(0);
    expect(maxOff).toBeLessThanOrEqual((Math.SQRT2 * (64 * 8)) / WU_PER_M + 1e-9);
  });

  test("nothing moves while the camera does not tick, or once the meter is spent", () => {
    const s = createCameraShake();
    const pose = createChasePose();
    s.meter = 40;
    applyCameraShake(s, 0, pose);
    expect(s.meter).toBe(40);
    expect([pose.eyeX, pose.eyeY, pose.eyeZ]).toEqual([0, 0, 0]);
    applyCameraShake(s, 100, pose); // a long frame: dt is clamped to 0x3c
    expect(s.meter).toBe(0);
    pose.eyeX = 0;
    pose.eyeY = 0;
    pose.eyeZ = 0;
    applyCameraShake(s, 8, pose);
    expect([pose.eyeX, pose.eyeY, pose.eyeZ]).toEqual([0, 0, 0]);
  });

  test("the jitter lies in the camera's up and right rows, never along its axis", () => {
    const s = createCameraShake(99);
    const pose = createChasePose();
    pose.yaw = 1.1;
    pose.pitch = 0.45;
    const fx = Math.cos(pose.pitch) * Math.cos(pose.yaw);
    const fy = -Math.sin(pose.pitch);
    const fz = Math.cos(pose.pitch) * Math.sin(pose.yaw);
    for (let i = 0; i < 20; i++) {
      s.meter = 200;
      pose.eyeX = 0;
      pose.eyeY = 0;
      pose.eyeZ = 0;
      applyCameraShake(s, 1, pose);
      expect(Math.abs(pose.eyeX * fx + pose.eyeY * fy + pose.eyeZ * fz)).toBeLessThan(1e-12);
    }
  });
});
