import { describe, expect, test } from "bun:test";
import {
  ARCHETYPE,
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

  test("an emplacement throws a bolt that covers the gun's reach", () => {
    // Two bugs are pinned here, one old and one the original's data settled.
    //
    // The old one: turrets and units pushed EV_SHOT with b=0, c=0, which the
    // renderer resolved to weaponById(0) and drew at PRIMARY_RANGE = 40 m.
    // la-cantina's turrets have an imported engage_range of 6 m, so 72
    // emplacements each drew a streak seven times longer than their own shot.
    // The reach still comes from the event, and it is still 6.
    //
    // The new one: it is not a streak at all. The original throws an OBJECT
    // about a metre long that travels (docs/specs/fcop-fx.md §5), so the shot
    // spawns a bolt and no tracer.
    const fx = createFx(new THREE.Scene());
    const events = createEventBuffer();
    pushEvent(events, EV_SHOT, 1, SHOT_SLOT_HITSCAN, reachToShotPayload(6));

    fx.pump(events, atOrigin);

    const c = fx.debugCounts();
    expect(c.tracers).toBe(0);
    expect(c.muzzles).toBe(1);
    expect(c.boltsSingle + c.boltsTwin).toBe(1);
    // param carries the distance the bolt covers before it expires.
    expect(fx.debugBoltReach()).toBeCloseTo(6, 5);
  });

  test("turrets throw the twin bolt, units the single one", () => {
    // The original's AI weapon table hands weapon_id 3 — every turret and
    // neutral turret on la-cantina, 64 of 64 — the TWIN bolt, and weapon_id 1
    // and 6, its ground units and aircraft, the single one
    // (docs/specs/fcop-fx.md §4). The archetype is what the renderer has to go
    // on, since the map JSON carries no weapon id.
    const shooterArchetype =
      (archetype: number): FxPoseResolver =>
      (_type, _a, _b, _c, out) => {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        out[3] = 0;
        if (out.length > 4) out[4] = archetype;
        return true;
      };

    const turret = createFx(new THREE.Scene());
    const events = createEventBuffer();
    pushEvent(events, EV_SHOT, 1, SHOT_SLOT_HITSCAN, reachToShotPayload(6));
    turret.pump(events, shooterArchetype(ARCHETYPE.TURRET));
    expect(turret.debugCounts().boltsTwin).toBe(1);
    expect(turret.debugCounts().boltsSingle).toBe(0);

    const unit = createFx(new THREE.Scene());
    unit.pump(events, shooterArchetype(ARCHETYPE.RUNNER));
    expect(unit.debugCounts().boltsSingle).toBe(1);
    expect(unit.debugCounts().boltsTwin).toBe(0);
  });

  test("a bolt travels its reach and then expires", () => {
    // The whole point of the change: it MOVES. Half a life in it is halfway
    // down the shot, where the old streak covered the whole reach from frame
    // one and never went anywhere.
    const scene = new THREE.Scene();
    const fx = createFx(scene);
    const events = createEventBuffer();
    pushEvent(events, EV_SHOT, 1, SHOT_SLOT_HITSCAN, reachToShotPayload(6));
    fx.pump(events, atOrigin);

    const life = 6 / 90; // reach / BOLT_SPEED
    fx.update(life * 0.5);
    // Halfway through its life it is halfway down its reach — which is the same
    // as saying it moves at BOLT_SPEED, and nothing else.
    expect(fx.debugCounts().boltsSingle + fx.debugCounts().boltsTwin).toBe(1);

    // atOrigin faces +X, so the bolt is 3 m along X, out of a 6 m reach, plus
    // the muzzle offset it started from.
    const bolt = scene.children.find(
      (c): c is THREE.InstancedMesh => (c as THREE.InstancedMesh).isInstancedMesh && c.count === 1,
    );
    expect(bolt).toBeDefined();
    const m = new THREE.Matrix4();
    bolt?.getMatrixAt(0, m);
    const at = new THREE.Vector3().setFromMatrixPosition(m);
    expect(at.x).toBeCloseTo(0.6 + 3, 3);
    expect(at.z).toBeCloseTo(0, 5);

    fx.update(life * 0.6);
    expect(fx.debugCounts().boltsSingle + fx.debugCounts().boltsTwin).toBe(0);
  });

  test("a long shot's bolt still travels at BOLT_SPEED, it does not speed up", () => {
    // There used to be a lifetime cap, which bounded the LIFE while the distance
    // stayed the full reach — so past ~22 m the bolt covered more ground in the
    // same time and quietly outran the constant that names its speed. A 40 m
    // shot, the longest the catalog can produce, is the case that exposed it.
    const scene = new THREE.Scene();
    const fx = createFx(scene);
    const events = createEventBuffer();
    pushEvent(events, EV_SHOT, 1, SHOT_SLOT_HITSCAN, reachToShotPayload(40));
    fx.pump(events, atOrigin);

    fx.update(0.25);
    const bolt = scene.children.find(
      (c): c is THREE.InstancedMesh => (c as THREE.InstancedMesh).isInstancedMesh && c.count === 1,
    );
    expect(bolt).toBeDefined();
    const m = new THREE.Matrix4();
    bolt?.getMatrixAt(0, m);
    // 0.25 s at 90 m/s is 22.5 m, from the muzzle — not the 40 m a capped life
    // would have dragged it to.
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBeCloseTo(0.6 + 22.5, 2);
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
