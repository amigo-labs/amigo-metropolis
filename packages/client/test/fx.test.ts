import { describe, expect, test } from "bun:test";
import {
  createEventBuffer,
  EV_EXPLOSION,
  EV_HIT,
  EV_SHOT,
  EV_TRANSFORM,
  PROJ_HEAVY,
  pushEvent,
  reachToShotPayload,
  SHOT_SLOT_HITSCAN,
  SHOT_SLOT_LAUNCH,
  shotPayloadToReach,
  TICK_HZ,
  TRANSFORM_LOCK_TICKS,
} from "@metropolis/sim";
import * as THREE from "three";
import { ARC_CAP, createFx, type FxPoseResolver, PARTICLE_ID } from "../src/render/fx";

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
    // c = weapon catalog id: 3 Hell Fire 2000, 7 Mortar (both projectile delivery).
    pushEvent(events, EV_SHOT, 1, 1, 3);
    pushEvent(events, EV_SHOT, 1, 2, 7);

    fx.pump(events, atOrigin);

    const c = fx.debugCounts();
    expect(c.tracers).toBe(0);
    expect(c.muzzles).toBe(2);
  });

  test("EV_SHOT concussion beam (heavy hitscan) still draws a tracer", () => {
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    pushEvent(events, EV_SHOT, 1, 1, 8); // Concussion Beam (Heavy)

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

describe("transformation discharge", () => {
  // Off balance.ts, not a literal: the event carries the sim's own lock, so a
  // hard-coded 24 would keep passing while testing a window the sim no longer
  // uses the next time this is retuned.
  const LOCK_TICKS = TRANSFORM_LOCK_TICKS;
  const DURATION = LOCK_TICKS / TICK_HZ;

  /** Pumps one EV_TRANSFORM and returns the fx it started. */
  function startTransform(): ReturnType<typeof createFx> {
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    pushEvent(events, EV_TRANSFORM, 1, 1, LOCK_TICKS);
    fx.pump(events, atOrigin);
    return fx;
  }

  test("EV_TRANSFORM starts an emitter but spawns nothing until the first frame", () => {
    const fx = startTransform();

    // pump only claims the emitter — arcs are spawned by update, so a tick that
    // is never followed by a frame cannot leave streaks behind.
    expect(fx.debugCounts().arcEmitters).toBe(1);
    expect(fx.debugCounts().arcs).toBe(0);
  });

  test("the emitter crackles: arcs appear on the first frame and keep coming", () => {
    const fx = startTransform();

    fx.update(1 / 60);
    const first = fx.debugCounts().arcs;
    expect(first).toBeGreaterThan(0);

    // Well past one arc lifetime: old streaks have died and new ones replaced
    // them, so the pool is still populated rather than drained once.
    for (let i = 0; i < 12; i++) fx.update(1 / 60);
    expect(fx.debugCounts().arcs).toBeGreaterThan(0);
    expect(fx.debugCounts().arcEmitters).toBe(1);
  });

  test("the flash over the mesh swap fires once, at the halfway point", () => {
    const fx = startTransform();

    // Just short of half the lock: still only arcs.
    let elapsed = 0;
    while (elapsed < DURATION * 0.45) {
      fx.update(1 / 60);
      elapsed += 1 / 60;
    }
    expect(fx.debugCounts().transformFlashes).toBe(0);

    while (elapsed < DURATION * 0.6) {
      fx.update(1 / 60);
      elapsed += 1 / 60;
    }
    // One flash, and it does not re-fire on later frames of the same morph.
    expect(fx.debugCounts().transformFlashes).toBe(1);
    // Comfortably past TRANSFORM_FLASH_LIFE: it ages out and nothing replaces it.
    for (let i = 0; i < 24; i++) fx.update(1 / 60);
    expect(fx.debugCounts().transformFlashes).toBe(0);
    // And it never touched the shared explosion/shockwave pools, which age on a
    // different clock.
    expect(fx.debugCounts().shockwaves).toBe(0);
    expect(fx.debugCounts().explosions).toBe(0);
  });

  test("the emitter releases itself when the lock is over", () => {
    const fx = startTransform();

    let elapsed = 0;
    while (elapsed < DURATION + 0.05) {
      fx.update(1 / 60);
      elapsed += 1 / 60;
    }
    expect(fx.debugCounts().arcEmitters).toBe(0);

    // And the streaks it left drain rather than sticking on screen.
    for (let i = 0; i < 12; i++) fx.update(1 / 60);
    expect(fx.debugCounts().arcs).toBe(0);
  });

  test("more transforms than emitter slots drops the extras, never overflows", () => {
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    for (let id = 1; id <= 8; id++) pushEvent(events, EV_TRANSFORM, id, 1, LOCK_TICKS);

    fx.pump(events, atOrigin);

    // Four slots, one per avatar the renderer can draw — the rest are dropped.
    expect(fx.debugCounts().arcEmitters).toBe(4);
    // Run every one of them through the densest part of its discharge. STRICTLY
    // under capacity: at the ceiling `spawn` starts returning false, which drops
    // streaks silently and is the only way the core and glow pools could ever
    // come apart. The cap is sized off the burst numbers so this stays true when
    // someone retunes the density.
    for (let i = 0; i < 40; i++) fx.update(1 / 60);
    expect(fx.debugCounts().arcs).toBeLessThan(ARC_CAP);
  });

  test("an unresolvable position skips the discharge entirely", () => {
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    pushEvent(events, EV_TRANSFORM, 1, 1, LOCK_TICKS);

    fx.pump(events, missing);

    expect(fx.debugCounts().arcEmitters).toBe(0);
  });
});
