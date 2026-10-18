// The Dreadnought's guns aim and slew (fcop-fidelity.md G8, I6). The sim turns
// each gun on its mount and writes its yaw relative to the hull per tick
// (writeGunSnapshot); the client draws each gun at that yaw about its own
// mount point (render/arenaUnits.ts gunMatrix), between the two ticks on the
// shortest arc (render/dreadnoughtGuns.ts lerpGunYaws), from the frame loop
// without allocating (renderer rule 1); on Joke's walking hull on the frame
// the sim's walk shows (the snapshot's GUN_SNAP_HULL_FRAME, SIM_VERSION 85).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ARCHETYPE,
  DREADNOUGHT_GUNS,
  DREADNOUGHT_MOUNTS,
  GUN_SNAP_HULL_FRAME,
  GUN_SNAP_STRIDE,
  getMapById,
} from "@metropolis/sim";
import * as THREE from "three";
import {
  type ArenaUnitsRenderer,
  arenaUnitsFor,
  bakedPoint,
  createArenaUnits,
  gunMatrix,
  gunPointOf,
} from "../src/render/arenaUnits";
import { UNIT_MODEL_FILES } from "../src/render/arenaUnits.generated";
import { lerpGunYaws } from "../src/render/dreadnoughtGuns";
import { createGreyboxMeshes, type GreyboxMeshes } from "../src/render/greybox";

const UP = new THREE.Vector3(0, 1, 0);

/** The hull's instance matrix as main.ts writes it: at (x, h, y), turned by -yaw. */
function hullMatrix(x: number, y: number, h: number, yaw: number): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, h, y),
    new THREE.Quaternion().setFromAxisAngle(UP, -yaw),
    new THREE.Vector3(1, 1, 1),
  );
}

/** The sim heading (cos, sin) the matrix turns the baked frame's +x to, as an angle. */
function headingOf(m: THREE.Matrix4): number {
  const e = m.elements;
  return Math.atan2(e[2], e[0]);
}

/** `a - b` folded into (-PI, PI]. */
function arc(a: number, b: number): number {
  const d = (a - b) % (Math.PI * 2);
  return d > Math.PI ? d - Math.PI * 2 : d <= -Math.PI ? d + Math.PI * 2 : d;
}

describe("a gun turns by its own yaw about its mount", () => {
  const point = bakedPoint([-0.267578, 0.486328, 0.283203], new THREE.Vector3());

  test("its pivot stays on the hull's point at every yaw", () => {
    const hull = hullMatrix(100, 50, 2, 0.7);
    const want = point.clone().applyMatrix4(hull);
    for (const g of [0, 0.9, -1.6, 3.1, -Math.PI]) {
      const at = new THREE.Vector3().setFromMatrixPosition(
        gunMatrix(hull, point, g, new THREE.Matrix4()),
      );
      expect(at.distanceTo(want)).toBeLessThan(1e-9);
    }
  });

  test("it faces the hull's yaw plus its own, in the entity yaw's sense", () => {
    for (const yaw of [0, 0.7, -2.2]) {
      const hull = hullMatrix(10, 20, 0, yaw);
      for (const g of [0, 0.5, -1.2, 2.9]) {
        const m = gunMatrix(hull, point, g, new THREE.Matrix4());
        expect(arc(headingOf(m), yaw + g)).toBeCloseTo(0, 9);
        // About +y only: the gun's up stays the world's (no pitch, no roll).
        expect(m.elements[5]).toBeCloseTo(1, 9);
      }
    }
  });

  test("its muzzle lands where the sim fires the round from", () => {
    // sim.ts placeGun: the mount at hull + z * forward + x * (sin yaw, -cos yaw),
    // the muzzle (the gun model's point 0) turned by the gun's world yaw.
    const hx = 40;
    const hy = 30;
    const hh = 1.5;
    for (const yaw of [0, 1.1, -2.6]) {
      for (const g of [0, 0.6, -0.4, 3.0]) {
        for (const m of DREADNOUGHT_MOUNTS) {
          const mount = bakedPoint([m.x, m.y, m.z], new THREE.Vector3());
          const gun = gunMatrix(hullMatrix(hx, hy, hh, yaw), mount, g, new THREE.Matrix4());
          const muzzle = bakedPoint([m.mx, m.my, m.mz], new THREE.Vector3()).applyMatrix4(gun);
          const w = yaw + g;
          const x =
            hx +
            m.z * Math.cos(yaw) +
            m.x * Math.sin(yaw) +
            m.mz * Math.cos(w) +
            m.mx * Math.sin(w);
          const y =
            hy +
            m.z * Math.sin(yaw) -
            m.x * Math.cos(yaw) +
            m.mz * Math.sin(w) -
            m.mx * Math.cos(w);
          expect(muzzle.x).toBeCloseTo(x, 6);
          expect(muzzle.z).toBeCloseTo(y, 6);
          expect(muzzle.y).toBeCloseTo(hh + m.y + m.my, 6);
        }
      }
    }
  });
});

describe("the gun yaws between two ticks", () => {
  const ID = 7;
  const prev = new Float32Array(16 * GUN_SNAP_STRIDE);
  const curr = new Float32Array(16 * GUN_SNAP_STRIDE);
  const out = new Float32Array(GUN_SNAP_STRIDE);
  const o = ID * GUN_SNAP_STRIDE;

  test("across the ±PI wrap they take the short way round", () => {
    prev.set([Math.PI - 0.1, -Math.PI + 0.1, 0.2, -3.0], o);
    curr.set([-Math.PI + 0.1, Math.PI - 0.1, 0.4, 3.0], o);
    lerpGunYaws(prev, curr, ID, 0.25, true, out);
    // Gun 0 slews +0.2 rad over the wrap, gun 1 -0.2: a quarter is 0.05.
    expect(arc(out[0], Math.PI - 0.05)).toBeCloseTo(0, 6);
    expect(arc(out[1], -Math.PI + 0.05)).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(0.25, 6);
    // -3.0 to 3.0 is 0.283 rad the short way (down through -PI), not 6 the long.
    expect(arc(out[3], -3.0 - (Math.PI * 2 - 6) * 0.25)).toBeCloseTo(0, 6);
    // Half way over the wrap is at PI, never back through the hull's forward.
    lerpGunYaws(prev, curr, ID, 0.5, true, out);
    expect(Math.abs(out[0])).toBeCloseTo(Math.PI, 6);
    expect(Math.abs(out[1])).toBeCloseTo(Math.PI, 6);
  });

  test("alpha 0 and 1 are the two ticks", () => {
    prev.set([0.1, -0.2, 1.5, -2.5], o);
    curr.set([0.3, -0.5, 1.2, 2.9], o);
    lerpGunYaws(prev, curr, ID, 0, true, out);
    for (let g = 0; g < DREADNOUGHT_GUNS; g++) expect(arc(out[g], prev[o + g])).toBeCloseTo(0, 6);
    lerpGunYaws(prev, curr, ID, 1, true, out);
    for (let g = 0; g < DREADNOUGHT_GUNS; g++) expect(arc(out[g], curr[o + g])).toBeCloseTo(0, 6);
  });

  test("a hull new this tick shows the current tick's yaws, from its own id", () => {
    prev.fill(9);
    curr.fill(-9);
    curr.set([0.5, 0.6, 0.7, 0.8], o);
    lerpGunYaws(prev, curr, ID, 0.5, false, out);
    expect(Array.from(out.subarray(0, DREADNOUGHT_GUNS))).toEqual(
      Array.from(curr.subarray(o, o + DREADNOUGHT_GUNS)),
    );
  });

  test("carries the hull's frame, the current tick's, with the yaws", () => {
    prev.fill(0);
    curr.fill(0);
    prev[o + GUN_SNAP_HULL_FRAME] = 11;
    curr[o + GUN_SNAP_HULL_FRAME] = 12;
    lerpGunYaws(prev, curr, ID, 0.25, true, out);
    expect(out[GUN_SNAP_HULL_FRAME]).toBe(12);
  });
});

// The frame path itself: arenaUnits.place on la-cantina's own models, loaded
// headlessly. Bun has the fetch and the Blob URLs GLTFLoader reads a .glb
// through, but no image decoder and no ProgressEvent: the texture pages decode
// to a blank 256 x 256 bitmap (only their size is read here), and the files
// come from public/ as the dev server would serve them.
const PUBLIC = new URL("../public", import.meta.url).pathname;
const ORIGIN = "http://units.test";
/** The Dreadnought's entity id in the frames below. */
const HULL_ID = 3;

describe("the frame path", () => {
  const realFetch = globalThis.fetch;
  const g = globalThis as { createImageBitmap?: unknown; ProgressEvent?: unknown };
  const bitmap = g.createImageBitmap;
  const progress = g.ProgressEvent;
  let scene: THREE.Scene;
  let greybox: GreyboxMeshes;
  let units: ArenaUnitsRenderer;
  const hullPos = new THREE.Vector3(60, 1, 45);
  const hullQuat = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const yaws = new Float32Array(GUN_SNAP_STRIDE);
  const HULL_YAW = 0.4;

  /** One frame with one Dreadnought: what main.ts renderEntities does for it. */
  function frame(prev: Float32Array, curr: Float32Array, alpha: number): void {
    units.begin(0);
    greybox.juggernaut.count = 1;
    lerpGunYaws(prev, curr, HULL_ID, alpha, true, yaws);
    units.place(
      greybox.juggernaut,
      0,
      HULL_ID,
      ARCHETYPE.JUGGERNAUT,
      0,
      60,
      45,
      hullPos,
      hullQuat,
      one,
      yaws,
    );
    units.end();
  }

  /** The part buckets drawing something, in scene order. */
  function drawnParts(): THREE.InstancedMesh[] {
    return scene.children.filter(
      (c): c is THREE.InstancedMesh =>
        (c as THREE.InstancedMesh).isInstancedMesh &&
        c !== greybox.juggernaut.mesh &&
        (c as THREE.InstancedMesh).count > 0,
    );
  }

  beforeAll(async () => {
    g.createImageBitmap = async () => ({ width: 256, height: 256, close() {} });
    g.ProgressEvent ??= class extends Event {
      constructor(type: string, init: object) {
        super(type);
        Object.assign(this, init);
      }
    };
    THREE.DefaultLoadingManager.setURLModifier((url) =>
      url.startsWith("/models/") ? ORIGIN + url : url,
    );
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith(`${ORIGIN}/`)) return realFetch(input, init);
        return Promise.resolve(new Response(Bun.file(PUBLIC + url.slice(ORIGIN.length))));
      },
      { preconnect: realFetch.preconnect },
    );
    scene = new THREE.Scene();
    greybox = createGreyboxMeshes(scene);
    units = createArenaUnits(scene, greybox);
    units.load(getMapById("la-cantina"), () => false, true);
    hullQuat.setFromAxisAngle(UP, -HULL_YAW);
    // The guns draw once the hull and both gun models have landed.
    const none = new Float32Array(16 * GUN_SNAP_STRIDE);
    for (let i = 0; i < 400 && drawnParts().length === 0; i++) {
      await Bun.sleep(5);
      frame(none, none, 0);
    }
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    THREE.DefaultLoadingManager.setURLModifier(undefined);
    g.createImageBitmap = bitmap;
    g.ProgressEvent = progress;
    if (bitmap === undefined) delete g.createImageBitmap;
    if (progress === undefined) delete g.ProgressEvent;
  });

  test("draws each of the four guns at its own yaw on its own point", () => {
    const prev = new Float32Array(16 * GUN_SNAP_STRIDE);
    const curr = new Float32Array(16 * GUN_SNAP_STRIDE);
    prev.set([0.2, -0.3, 1.4, -3.0], HULL_ID * GUN_SNAP_STRIDE);
    curr.set([0.4, -0.5, 1.2, 3.1], HULL_ID * GUN_SNAP_STRIDE);
    frame(prev, curr, 0.5);
    const want = [0.3, -0.4, 1.3, -3.0 - (Math.PI * 2 - 6.1) * 0.5];
    // Guns 0/1 are one model and 2/3 the other (Mp 37, 38): two buckets, two each.
    const parts = drawnParts();
    expect(parts.map((p) => p.count)).toEqual([2, 2]);
    const guns = arenaUnitsFor("la-cantina").dreadnought.guns;
    const hull = new THREE.Matrix4().compose(hullPos, hullQuat, one);
    const got = new THREE.Matrix4();
    for (let i = 0; i < 4; i++) {
      parts[i >> 1].getMatrixAt(i & 1, got);
      const point = bakedPoint(guns[i].point, new THREE.Vector3());
      const at = new THREE.Vector3().setFromMatrixPosition(got);
      expect(at.distanceTo(point.applyMatrix4(hull))).toBeLessThan(1e-5);
      expect(arc(headingOf(got), HULL_YAW + want[i])).toBeCloseTo(0, 5);
    }
  });

  test("constructs no three.js object over a thousand frames", () => {
    const prev = new Float32Array(16 * GUN_SNAP_STRIDE);
    const curr = new Float32Array(16 * GUN_SNAP_STRIDE);
    curr.fill(1.5);
    let made = 0;
    // A constructor's first field write, caught on the prototype: the setter
    // counts, then stores the field as the own property it would have been.
    const fields: [object, string][] = [
      [THREE.Vector3.prototype, "x"],
      [THREE.Vector2.prototype, "x"],
      [THREE.Quaternion.prototype, "isQuaternion"],
      [THREE.Euler.prototype, "isEuler"],
      [THREE.Matrix4.prototype, "elements"],
      [THREE.Matrix3.prototype, "elements"],
      [THREE.Color.prototype, "isColor"],
    ];
    for (const [proto, key] of fields) {
      Object.defineProperty(proto, key, {
        configurable: true,
        set(this: object, value: unknown) {
          made++;
          Object.defineProperty(this, key, { value, writable: true, enumerable: true });
        },
      });
    }
    try {
      // The hook counts: one Vector3, one Matrix4.
      new THREE.Vector3();
      new THREE.Matrix4();
      expect(made).toBe(2);
      made = 0;
      for (let f = 0; f < 1000; f++) frame(prev, curr, (f % 10) / 10);
    } finally {
      for (const [proto, key] of fields) delete (proto as Record<string, unknown>)[key];
    }
    expect(made).toBe(0);
    expect(drawnParts().map((p) => p.count)).toEqual([2, 2]);
  });

  test("allocates in none of its source: no new, closure, literal or spread", () => {
    const allocates = /\bnew\b|=>|\bfunction\b|[=(,:?]\s*[[{]|\breturn\s*[[{]|\.\.\./;
    for (const fn of [lerpGunYaws, gunMatrix, gunPointOf, units.place, units.begin, units.end]) {
      const body = fn.toString();
      expect({ fn: fn.name, allocates: allocates.test(body.slice(body.indexOf("{"))) }).toEqual({
        fn: fn.name,
        allocates: false,
      });
    }
  });
});

describe("Joke's guns ride the hull's walk (RE cact_mount_step reads the hull's frame)", () => {
  const realFetch = globalThis.fetch;
  const g = globalThis as { createImageBitmap?: unknown; ProgressEvent?: unknown };
  const bitmap = g.createImageBitmap;
  const progress = g.ProgressEvent;
  let scene: THREE.Scene;
  let greybox: GreyboxMeshes;
  let units: ArenaUnitsRenderer;
  const hullPos = new THREE.Vector3(80, 0, 80);
  const hullQuat = new THREE.Quaternion().setFromAxisAngle(UP, -0.4);
  const one = new THREE.Vector3(1, 1, 1);
  const yaws = new Float32Array(GUN_SNAP_STRIDE);
  const joke = arenaUnitsFor("bug-hunt").dreadnought;
  const track = UNIT_MODEL_FILES.find((f) => f.file === joke.hull)?.morph;

  /** One frame with Joke's hull at hullPos, its guns at yaw 0. */
  function frame(): void {
    units.begin(0);
    greybox.juggernaut.count = 1;
    units.place(
      greybox.juggernaut,
      0,
      HULL_ID,
      ARCHETYPE.JUGGERNAUT,
      0,
      hullPos.x,
      hullPos.z,
      hullPos,
      hullQuat,
      one,
      yaws,
    );
    units.end();
  }

  function drawnParts(): THREE.InstancedMesh[] {
    return scene.children.filter(
      (c): c is THREE.InstancedMesh =>
        (c as THREE.InstancedMesh).isInstancedMesh &&
        c !== greybox.juggernaut.mesh &&
        (c as THREE.InstancedMesh).count > 0,
    );
  }

  /** Every gun's pivot as drawn, against hull frame k's points placed by the hull. */
  function expectGunsOn(k: number): void {
    const parts = drawnParts();
    expect(parts.map((p) => p.count)).toEqual([2, 2]);
    const hull = new THREE.Matrix4().compose(hullPos, hullQuat, one);
    const got = new THREE.Matrix4();
    for (let i = 0; i < 4; i++) {
      parts[i >> 1].getMatrixAt(i & 1, got);
      const p = joke.guns[i].byFrame?.[k];
      if (!p) throw new Error(`gun ${i} has no frame ${k}`);
      const want = bakedPoint(p, new THREE.Vector3()).applyMatrix4(hull);
      expect(new THREE.Vector3().setFromMatrixPosition(got).distanceTo(want)).toBeLessThan(1e-5);
    }
    // The hull's own morph row shows the same frame (target k - 1 at weight 1).
    const row = greybox.juggernaut.mesh.morphTexture?.image.data as Float32Array;
    const len = row.length / greybox.juggernaut.tintCache.length;
    for (let t = 1; t < len; t++) expect(row[t]).toBe(t === k ? 1 : 0);
  }

  beforeAll(async () => {
    g.createImageBitmap = async () => ({ width: 256, height: 256, close() {} });
    g.ProgressEvent ??= class extends Event {
      constructor(type: string, init: object) {
        super(type);
        Object.assign(this, init);
      }
    };
    THREE.DefaultLoadingManager.setURLModifier((url) =>
      url.startsWith("/models/") ? ORIGIN + url : url,
    );
    // The hull's file lands well after its guns': the guns wait for it (they
    // stood unready for the session when the hull came last).
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith(`${ORIGIN}/`)) return realFetch(input, init);
        if (url.endsWith(`/${joke.hull}.glb`)) await Bun.sleep(150);
        return new Response(Bun.file(PUBLIC + url.slice(ORIGIN.length)));
      },
      { preconnect: realFetch.preconnect },
    );
    scene = new THREE.Scene();
    greybox = createGreyboxMeshes(scene);
    units = createArenaUnits(scene, greybox);
    units.load(getMapById("bug-hunt"), () => false, true);
    for (let i = 0; i < 600 && drawnParts().length === 0; i++) {
      await Bun.sleep(5);
      frame();
    }
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    THREE.DefaultLoadingManager.setURLModifier(undefined);
    g.createImageBitmap = bitmap;
    g.ProgressEvent = progress;
    if (bitmap === undefined) delete g.createImageBitmap;
    if (progress === undefined) delete g.ProgressEvent;
  });

  test("the guns draw although the hull's model landed after theirs", () => {
    expect(drawnParts().map((p) => p.count)).toEqual([2, 2]);
  });

  test("shows the frame the sim's walk is on, and every gun stands on its point", () => {
    if (!track) throw new Error("Joke's hull has no track");
    expect(track).toMatchObject({ frames: 20, period: 775, drivenBy: "distance" });
    // Frame 0 and frame 12 are metres apart, so standing on the right one shows.
    const a = joke.guns[0].byFrame?.[0] ?? [0, 0, 0];
    const b = joke.guns[0].byFrame?.[12] ?? [0, 0, 0];
    expect(Math.hypot(a[1] - b[1], a[2] - b[2])).toBeGreaterThan(0.5);
    // The gun snapshot's frame (sim hullWalk, SIM_VERSION 85), not the distance
    // the client sees the hull cover.
    yaws[GUN_SNAP_HULL_FRAME] = 0;
    frame();
    expectGunsOn(0);
    yaws[GUN_SNAP_HULL_FRAME] = 12;
    frame();
    expectGunsOn(12);
    // Moving the hull by itself changes nothing: the walk is the sim's.
    for (let s = 0; s < 59; s++) {
      hullPos.x += 0.02 * Math.cos(0.4);
      hullPos.z += 0.02 * Math.sin(0.4);
      frame();
    }
    expectGunsOn(12);
  });
});
