import { describe, expect, test } from "bun:test";
import {
  createEventBuffer,
  EV_EXPLOSION,
  EV_HIT,
  EV_SHOT,
  PROJ_HEAVY,
  pushEvent,
} from "@metropolis/sim";
import * as THREE from "three";
import { createFx, type FxPoseResolver, PARTICLE_ID } from "../src/render/fx";

/** Resolver that always places the event at the origin facing +X. */
const atOrigin: FxPoseResolver = (_type, _a, _b, _c, out) => {
  out[0] = 0;
  out[1] = 1;
  out[2] = 0;
  out[3] = 0;
  return true;
};

const missing: FxPoseResolver = () => false;

describe("shot VFX", () => {
  test("EV_SHOT slot 0 spawns tracer core+halo and a muzzle flash", () => {
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    pushEvent(events, EV_SHOT, 1, 0, 0);

    fx.pump(events, atOrigin);

    const c = fx.debugCounts();
    expect(c.tracers).toBe(1);
    expect(c.muzzles).toBe(1);
    expect(c.explosions).toBe(0);
    expect(c.sparks).toBe(0);
    expect(c.shockwaves).toBe(0);
  });

  test("EV_SHOT heavy/special projectiles spawn only muzzle (entity draws the shell)", () => {
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    // c = weapon catalog id: 3 Hellfire, 6 Plasma (both projectile delivery).
    pushEvent(events, EV_SHOT, 1, 1, 3);
    pushEvent(events, EV_SHOT, 1, 2, 6);

    fx.pump(events, atOrigin);

    const c = fx.debugCounts();
    expect(c.tracers).toBe(0);
    expect(c.muzzles).toBe(2);
  });

  test("EV_SHOT concussion beam (special hitscan) still draws a tracer", () => {
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    pushEvent(events, EV_SHOT, 1, 2, 8); // Concussion Beam

    fx.pump(events, atOrigin);

    expect(fx.debugCounts().tracers).toBe(1);
    expect(fx.debugCounts().muzzles).toBe(1);
  });

  test("EV_EXPLOSION spawns fireball + shockwave; EV_HIT spawns spark", () => {
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    pushEvent(events, EV_EXPLOSION, 160, 320, PROJ_HEAVY);
    pushEvent(events, EV_HIT, 5, 0, 8);

    fx.pump(events, atOrigin);

    const c = fx.debugCounts();
    expect(c.explosions).toBe(1);
    expect(c.shockwaves).toBe(1);
    expect(c.sparks).toBe(1);
  });

  test("unresolvable events are skipped", () => {
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    pushEvent(events, EV_SHOT, 1, 0, 0);
    pushEvent(events, EV_EXPLOSION, 0, 0, 1);

    fx.pump(events, missing);

    const c = fx.debugCounts();
    expect(c.tracers).toBe(0);
    expect(c.muzzles).toBe(0);
    expect(c.explosions).toBe(0);
    expect(c.shockwaves).toBe(0);
  });

  test("update drains effects after their lifetime", () => {
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    pushEvent(events, EV_SHOT, 1, 0, 0);
    pushEvent(events, EV_EXPLOSION, 0, 0, 1);
    pushEvent(events, EV_HIT, 1, 0, 1);
    fx.pump(events, atOrigin);

    expect(fx.debugCounts().tracers).toBe(1);

    fx.update(1);

    const c = fx.debugCounts();
    expect(c.tracers).toBe(0);
    expect(c.muzzles).toBe(0);
    expect(c.explosions).toBe(0);
    expect(c.sparks).toBe(0);
    expect(c.shockwaves).toBe(0);
  });

  test("overflow drops silently past pool capacity", () => {
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    for (let i = 0; i < 200; i++) pushEvent(events, EV_SHOT, 1, 0, 0);

    fx.pump(events, atOrigin);

    expect(fx.debugCounts().tracers).toBe(128);
    expect(fx.debugCounts().muzzles).toBe(64);
  });

  test("Cpyr particle role ids are the by-eye mapping documented in fx.ts", () => {
    // Pins the semantic mapping so a casual palette swap is a deliberate edit.
    expect(PARTICLE_ID.explosion).toBe(8);
    expect(PARTICLE_ID.muzzle).toBe(6);
    expect(PARTICLE_ID.spark).toBe(7);
  });
});
