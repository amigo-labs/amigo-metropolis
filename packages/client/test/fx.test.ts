import { describe, expect, test } from "bun:test";
import {
  createEventBuffer,
  EV_EXPLOSION,
  EV_HIT,
  EV_SHOT,
  PROJ_HEAVY,
  pushEvent,
  reachToShotPayload,
  SHOT_SLOT_HITSCAN,
  SHOT_SLOT_LAUNCH,
  shotPayloadToReach,
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

  test("Cpyr particle role ids match what the contact sheet shows", () => {
    // Was "the by-eye mapping documented in fx.ts". It is now read off
    // docs/renders/fx/particles-contact.png (bun run gen:fxsheet), which prints
    // each sprite's size and paint coverage:
    //   id 8  126x128, 24% paint, densest    -> the fireball itself
    //   id 5  125x126, 18% paint, hollow with a bright yellow rim -> phase two
    //   id 6  32x32,  27% paint, strong red  -> muzzle flash
    //   id 7  16x16,  31% paint, the densest per area -> hit spark
    // 8/6/7 were already right; 5 was declared and never bound.
    expect(PARTICLE_ID.explosion).toBe(8);
    expect(PARTICLE_ID.explosionAlt).toBe(5);
    expect(PARTICLE_ID.muzzle).toBe(6);
    expect(PARTICLE_ID.spark).toBe(7);
  });

  test("an emplacement tracer is as long as the gun's reach, not the Mini-Gun's", () => {
    // The bug this pins: turrets and units pushed EV_SHOT with b=0, c=0, which
    // the renderer resolved to weaponById(0) and drew at PRIMARY_RANGE = 40 m.
    // la-cantina's turrets have an imported engage_range of 6 m, so 72
    // emplacements each drew a bolt seven times longer than their own shot.
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    pushEvent(events, EV_SHOT, 1, SHOT_SLOT_HITSCAN, reachToShotPayload(6));

    fx.pump(events, atOrigin);

    const c = fx.debugCounts();
    expect(c.tracers).toBe(1);
    expect(c.muzzles).toBe(1);
    // param carries the tracer's world length.
    expect(fx.debugTracerLength()).toBeCloseTo(6, 5);
  });

  test("a launch flash spawns no tracer — the shell is its own entity", () => {
    // The Warden's heavy bomb pushed slot 1 with c=0, which resolved to the
    // Mini-Gun: a 40 m hitscan streak alongside the bomb it had just spawned.
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    pushEvent(events, EV_SHOT, 1, SHOT_SLOT_LAUNCH, 0);

    fx.pump(events, atOrigin);

    expect(fx.debugCounts().tracers).toBe(0);
    expect(fx.debugCounts().muzzles).toBe(1);
  });

  test("reach survives the decimetre round trip at the ranges arenas use", () => {
    for (const reach of [6, 14, 28, 40, 42, 0.1]) {
      expect(shotPayloadToReach(reachToShotPayload(reach))).toBeCloseTo(reach, 5);
    }
  });
});
