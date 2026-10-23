// The type-96 Props and type-97 DCSQuads in three (fcop-fidelity.md G13;
// render/emitterProps.ts, render/decals.ts): the orientation snd_emit_build
// and pyro_place give them, through the one mapping every record angle takes
// (render/recordYaw.ts), and the turn and frames snd_emit_draw_block steps.

import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  SCENERY_PLACEMENTS,
  type SceneryProp,
  type SceneryQuad,
} from "../src/render/arenaScenery.generated";
import {
  QUAD_DEPTH_VERTEX,
  QUAD_NEAR,
  quadGeometry,
  quadMatrix,
  quadRotation,
  useQuadDepth,
} from "../src/render/decals";
import {
  emitterFrame,
  emitterMatrix,
  emitterOrientation,
  emitterYaw,
} from "../src/render/emitterProps";
import { recordTurn } from "../src/render/recordYaw";

const UP = new THREE.Vector3(0, 1, 0);

function prop(over: Partial<SceneryProp>): SceneryProp {
  return {
    record: "Cact 1",
    cobj: 61,
    x: 10,
    y: 20,
    h: 1.5,
    yaw: 0,
    pitch: 0,
    roll: 0,
    scale: [64, 64, 64],
    spin: 0,
    swing: 0,
    park: 0,
    anim: "none",
    period: 0,
    sound: 0,
    ...over,
  };
}

/** v * M + p in the game's frame, then three's (z, y, x): the original's placement. */
function original(m: number[][], v: THREE.Vector3): THREE.Vector3 {
  const c = [v.x, v.y, v.z];
  const w = [0, 1, 2].map((j) => c[0] * m[0][j] + c[1] * m[1][j] + c[2] * m[2][j]);
  return new THREE.Vector3(w[2], w[1], w[0]);
}

describe("a Prop's matrix", () => {
  test("with a yaw only, is the one mapping's turn", () => {
    for (const yaw of [0, 220, 1024, 1738, 2582, 3500]) {
      const m = emitterMatrix(prop({ yaw }), new THREE.Matrix4());
      const want = new THREE.Matrix4().compose(
        new THREE.Vector3(10, 1.5, 20),
        new THREE.Quaternion().setFromAxisAngle(UP, recordTurn(yaw)),
        new THREE.Vector3(1, 1, 1),
      );
      m.elements.forEach((e, i) => {
        expect(e).toBeCloseTo(want.elements[i], 9);
      });
    }
  });

  test("lands every glb vertex where v * (scaled Mz Mx My) puts the Cobj's", () => {
    const p = prop({ yaw: 700, pitch: 24, roll: 90, scale: [23, 32, 51] });
    const m = emitterMatrix(p, new THREE.Matrix4());
    const o = emitterOrientation(p);
    for (const cobj of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0.3, 0.9, -0.2)]) {
      // The RE's glb is the Cobj with its x negated.
      const glb = new THREE.Vector3(-cobj.x, cobj.y, cobj.z);
      const got = glb.applyMatrix4(m);
      const want = original(o, cobj).add(new THREE.Vector3(10, 1.5, 20));
      expect(got.distanceTo(want)).toBeLessThan(1e-9);
    }
    // Not mirrored: the two mirrors cancel.
    expect(m.determinant()).toBeGreaterThan(0);
  });
});

describe("a spinning Prop", () => {
  test("turns clock * spin, and a negative spin one unit short of the mirror", () => {
    expect(emitterYaw(8, 0, 0, 0)).toBe(0);
    expect(emitterYaw(8, 0, 0, 100)).toBe(800);
    expect(emitterYaw(8, 0, 0, 600)).toBe(4800 - 4096);
    // 0xfff - ((-(clock * spin)) & 0xfff) = (clock * spin - 1) & 0xfff.
    expect(emitterYaw(-2, 0, 0, 100)).toBe((4096 - 200 - 1) & 0xfff);
    expect(emitterYaw(-2, 0, 0, 0)).toBe(0xfff);
  });

  test("with a swing, rocks about its park and back", () => {
    // spin 8, 60 degrees (682): over one sweep of the spin's angle the swing
    // runs 0 -> -amp/2 -> 0 -> +amp/2 -> 0, doubled: +-amp about the park.
    const at = (now: number) => emitterYaw(8, 682, 1024, now);
    expect(at(0)).toBe(1024);
    const sweep = Array.from({ length: 512 }, (_, k) => {
      const a = at(k);
      return a > 2048 ? a - 4096 : a;
    });
    expect(Math.min(...sweep)).toBeGreaterThanOrEqual(1024 - 682);
    expect(Math.max(...sweep)).toBeLessThanOrEqual(1024 + 682);
    expect(Math.min(...sweep)).toBeLessThan(1024 - 600);
    expect(Math.max(...sweep)).toBeGreaterThan(1024 + 600);
  });
});

describe("a Prop's frames", () => {
  test("loop one per period, or go there and back", () => {
    const loop = prop({ anim: "loop", period: 37 });
    expect([0, 36, 37, 37 * 8, 37 * 9].map((n) => emitterFrame(loop, 9, n))).toEqual([
      0, 0, 1, 8, 0,
    ]);
    const back = prop({ anim: "boomerang", period: 10 });
    expect([0, 10, 30, 40, 50, 60, 80].map((n) => emitterFrame(back, 5, n))).toEqual([
      0, 1, 3, 4, 3, 2, 0,
    ]);
    expect(emitterFrame(prop({}), 9, 1000)).toBe(0);
  });
});

function quadOf(over: Partial<SceneryQuad>): SceneryQuad {
  return {
    record: "Cact 2",
    decal: 1,
    x: 3,
    y: 4,
    h: 1.2,
    yaw: 0,
    pitch: 0,
    roll: 0,
    halfX: 1.6,
    halfZ: 0.8,
    tint: [64, 64, 64],
    blend: 2,
    twoSided: false,
    ...over,
  };
}

describe("a DCSQuad", () => {
  test("stands its corners where pyro_place turns them", () => {
    for (const yaw of [0, 545, 1235, 3333]) {
      const q = quadOf({ yaw });
      const m = quadMatrix(q, new THREE.Matrix4());
      const a = (yaw * 2 * Math.PI) / 4096;
      const my = [
        [Math.cos(a), 0, -Math.sin(a)],
        [0, 1, 0],
        [Math.sin(a), 0, Math.cos(a)],
      ];
      // Corner (-x, +z) of the quad's own frame, three's (z, 0, x) unit corner.
      const corner = new THREE.Vector3(-q.halfX, 0, q.halfZ);
      const want = original(my, corner).add(new THREE.Vector3(q.x, q.h, q.y));
      const got = new THREE.Vector3(1, 0, -1).applyMatrix4(m);
      expect(got.distanceTo(want)).toBeLessThan(1e-9);
      expect(quadRotation(q, new THREE.Matrix4()).determinant()).toBeCloseTo(1, 9);
    }
  });

  test("faces up, the rect's (u, v) on corner (-x, +z)", () => {
    const g = quadGeometry({ file: "dcs-01.png", w: 63, h: 64 });
    const p = g.getAttribute("position");
    const idx = g.getIndex();
    if (!idx) throw new Error("no index");
    const v = (i: number) => new THREE.Vector3().fromBufferAttribute(p, idx.getX(i));
    const n = v(1)
      .sub(v(0))
      .cross(v(2).sub(v(0)));
    expect(n.y).toBeGreaterThan(0);
    const uv = g.getAttribute("uv");
    expect([uv.getX(0), uv.getY(0)]).toEqual([0, 1]);
    expect(uv.getX(1)).toBeCloseTo(62 / 63, 6);
  });

  test("the corner the drawer's depth leaves out is pyro_place's fourth, (-x, -z)", () => {
    // The key reads the centre and points 1..3 (pyro_draw.c 0x0043783d):
    // (-x, +z), (+x, +z), (+x, -z); QUAD_DEPTH_VERTEX names them by the unit
    // quad's corners, and leaves (-1, 0, -1) out.
    for (const yaw of [0, 777, 2900]) {
      const q = quadOf({ yaw });
      const m = quadMatrix(q, new THREE.Matrix4());
      const a = (yaw * 2 * Math.PI) / 4096;
      const my = [
        [Math.cos(a), 0, -Math.sin(a)],
        [0, 1, 0],
        [Math.sin(a), 0, Math.cos(a)],
      ];
      const at = new THREE.Vector3(q.x, q.h, q.y);
      const corners: [number, number, number, number][] = [
        [1, -1, -1, 1],
        [1, 1, 1, 1],
        [-1, 1, 1, -1],
        [-1, -1, -1, -1],
      ];
      for (const [ux, uz, sx, sz] of corners) {
        const want = original(my, new THREE.Vector3(sx * q.halfX, 0, sz * q.halfZ)).add(at);
        expect(new THREE.Vector3(ux, 0, uz).applyMatrix4(m).distanceTo(want)).toBeLessThan(1e-9);
      }
    }
    expect(QUAD_DEPTH_VERTEX).toContain("float key = (zc + za + zb + zcc) * 0.25;");
    expect(QUAD_DEPTH_VERTEX).toContain("vec4(-1.0, 0.0, -1.0, 1.0)");
    expect(QUAD_NEAR).toBeCloseTo(1029 / 512, 12);
    expect(QUAD_DEPTH_VERTEX).toContain(`<= ${QUAD_NEAR.toFixed(9)}`);
  });

  test("its material draws at the drawer's depth, no polygon offset", () => {
    const material = new THREE.MeshBasicMaterial();
    useQuadDepth(material);
    expect(material.polygonOffset).toBe(false);
    const shader = {
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
      uniforms: {},
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain("mvPosition.xyz *= key / -mvPosition.z;");
    // three's own projection still runs first: the key slides what it placed.
    expect(shader.vertexShader.indexOf("#include <project_vertex>")).toBeLessThan(
      shader.vertexShader.indexOf("quadView"),
    );
    expect(material.customProgramCacheKey()).toBe("dcsquad-depth");
  });

  test("on Slim, Joke and Hk: the additive haze of one cloud each", () => {
    for (const id of ["proving-ground", "bug-hunt", "hollywood-keys"]) {
      const s = SCENERY_PLACEMENTS[id];
      expect(Object.keys(s.decals).length).toBe(1);
      for (const q of s.quads) {
        expect([q.blend, q.twoSided, q.pitch, q.roll]).toEqual([2, false, 0, 0]);
        expect(q.halfX).toBeGreaterThan(1.3);
      }
    }
  });
});
