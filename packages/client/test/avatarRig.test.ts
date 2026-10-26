// The X1's rig (render/avatarRig.ts): ONE InstancedMesh over the shipped
// avatar-x1.glb, posed in the vertex shader from the bone table by a
// four-float pose per instance. The shader cannot run here, so this pins what
// feeds it -- the attributes, the table texture, the patch -- and what `place`
// writes per slot; render/x1Pose.ts, the shader's CPU twin, is held against the
// RE's assembled poses in tools/generators/test/x1Rig.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NodeIO } from "@gltf-transform/core";
import * as THREE from "three";
import { FX_ARENAS, FX_RECORDS } from "../src/effects/fcopEffects.generated";
import type { Fx90 } from "../src/effects/records";
import {
  buildX1Rig,
  createX1AnimTexture,
  placeX1,
  RIG_CAPACITY,
  X1_BONE_ATTR,
  X1_COCKPIT_BONES,
  X1_POSE_ATTR,
  x1CockpitSkeleton,
} from "../src/render/avatarRig";
import { makeShatterSkeleton, SkeletonShatter } from "../src/render/fx/skeletonShatter";
import { patchTeamUv, prepareTeamUvMask, TEAM_UV_ATTR } from "../src/render/teamUv";
import { poseX1Vertex } from "../src/render/x1Pose";
import {
  X1_ANIM_HEIGHT,
  X1_ANIM_WIDTH,
  X1_COCKPIT_ROW,
  X1_COCKPIT_SLOT,
  X1_MOUNT_TEXEL,
} from "../src/render/x1Rig.generated";

const GLB = new URL("../public/models/units/avatar-x1.glb", import.meta.url).pathname;
const BIN = new URL("../public/models/units/avatar-x1.anim.bin", import.meta.url).pathname;

/** The glb as GLTFLoader hands it over: `_X1BONE` and `_TEAMUV` lowercased. */
async function loadRig() {
  const doc = await new NodeIO().read(GLB);
  const prims = doc
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives());
  const p = prims[0];
  const geometry = new THREE.BufferGeometry();
  const set = (gltf: string, three: string, size: number) => {
    const a = p.getAttribute(gltf);
    if (!a) throw new Error(`no ${gltf}`);
    geometry.setAttribute(three, new THREE.BufferAttribute(a.getArray() as Float32Array, size));
  };
  set("POSITION", "position", 3);
  set("NORMAL", "normal", 3);
  set("TEXCOORD_0", "uv", 2);
  set("_X1BONE", "_x1bone", 1);
  set("_TEAMUV", "_teamuv", 1);
  prepareTeamUvMask(geometry);
  const material = new THREE.MeshStandardMaterial({ flatShading: true });
  material.map = new THREE.DataTexture(new Uint8Array(256 * 256 * 4), 256, 256);
  patchTeamUv(material);
  const bin = readFileSync(BIN);
  const table = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const scene = new THREE.Scene();
  const core = buildX1Rig(scene, geometry, material, table);
  return { scene, core, prims: prims.length };
}

describe("the X1's rig", () => {
  test("is one InstancedMesh for every form, in the scene, at capacity 4", async () => {
    const { scene, core, prims } = await loadRig();
    expect(prims).toBe(1);
    const meshes = scene.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh);
    expect(meshes.length).toBe(1);
    expect(core.mesh.count).toBe(0);
    expect(core.mesh.matrixAutoUpdate).toBe(false);
    expect(core.mesh.instanceMatrix.count).toBe(RIG_CAPACITY);
    const g = core.mesh.geometry;
    expect(g.getAttribute(X1_BONE_ATTR)).toBeDefined();
    expect(g.getAttribute("_x1bone")).toBeUndefined();
    expect((g.getAttribute(X1_POSE_ATTR) as THREE.InstancedBufferAttribute).meshPerAttribute).toBe(
      1,
    );
    expect(g.getAttribute(TEAM_UV_ATTR)).toBeDefined();
  });

  test("feeds the shader a float table it fetches unfiltered", () => {
    const tex = createX1AnimTexture(new Float32Array(X1_ANIM_WIDTH * X1_ANIM_HEIGHT * 4));
    expect(tex.type).toBe(THREE.FloatType);
    expect(tex.magFilter).toBe(THREE.NearestFilter);
    expect(tex.minFilter).toBe(THREE.NearestFilter);
    expect(tex.generateMipmaps).toBe(false);
    expect(() => createX1AnimTexture(new Float32Array(8))).toThrow();
  });

  test("patches the pose in after the team offset", async () => {
    const { core } = await loadRig();
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: "#include <common>\n#include <uv_vertex>\n#include <begin_vertex>\n",
      fragmentShader: "",
    };
    const material = core.mesh.material as THREE.Material;
    material.onBeforeCompile(shader as never, {} as never);
    expect(shader.vertexShader).toContain("instanceTeamUv");
    expect(shader.vertexShader).toContain("texelFetch(x1Anim");
    expect(shader.vertexShader).toContain("transformed = x1Q;");
    expect((shader.uniforms.x1Anim.value as THREE.DataTexture).isDataTexture).toBe(true);
    expect(material.customProgramCacheKey()).toBe("teamUv+x1");
  });

  test("place writes the slot's matrix, its pose, and the offset on a change only", async () => {
    const { core } = await loadRig();
    const pose = core.mesh.geometry.getAttribute(X1_POSE_ATTR) as THREE.InstancedBufferAttribute;
    const team = core.mesh.geometry.getAttribute(TEAM_UV_ATTR) as THREE.InstancedBufferAttribute;
    placeX1(core, 1, 10, 2, 20, Math.PI / 2, 1, 316, 0, 0.1, -0.2, -1);
    const m = new THREE.Matrix4();
    core.mesh.getMatrixAt(1, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect([p.x, p.y, p.z]).toEqual([10, 2, 20]);
    // Facing sim +y (yaw pi/2): the model's +z forward lands on three's +z.
    const fwd = new THREE.Vector3(0, 0, 1).transformDirection(m);
    expect(fwd.z).toBeCloseTo(1, 6);
    expect(Array.from(pose.array.slice(4, 8))).toEqual([
      316,
      0,
      Math.fround(0.1),
      Math.fround(-0.2),
    ]);
    // Side 1 is u 128 of the 256-wide page, v 0.
    expect(team.array[2]).toBeCloseTo(0.5, 6);
    expect(team.array[3]).toBe(0);
    const version = team.version;
    placeX1(core, 1, 10, 2, 20, Math.PI / 2, 1, 317, 0, 0.1, -0.2, -1);
    expect(team.version).toBe(version);
    // The cloak: v is the frame clock's, the side's u stays.
    placeX1(core, 1, 10, 2, 20, Math.PI / 2, 1, 317, 0, 0.1, -0.2, 40);
    expect(team.array[2]).toBeCloseTo(0.5, 6);
    expect(team.array[3]).toBeCloseTo(40 / 256, 6);
  });

  test("the wrecked cockpit hands the skeleton shatter its seven bones, unturned, on the mount", async () => {
    const { core, scene } = await loadRig();
    const out = makeShatterSkeleton();
    x1CockpitSkeleton(core, 10, 2, 20, Math.PI / 2, 1, 316, 5, out);
    expect([out.first, out.bones]).toEqual([X1_COCKPIT_SLOT, 7]);
    expect(X1_COCKPIT_BONES).toBe(7);
    const row = (X1_COCKPIT_ROW + 5) * X1_ANIM_WIDTH;
    for (let n = 0; n < 7; n++) {
      for (let k = 0; k < 12; k++) {
        expect(out.matrices[n * 12 + k]).toBe(core.table[(row + n * 3) * 4 + k]);
      }
    }
    // Facing sim +y the rig turns nothing: the mount as the table has it.
    const m = (316 * X1_ANIM_WIDTH + X1_MOUNT_TEXEL) * 4;
    expect(out.x).toBeCloseTo(10 + core.table[m], 5);
    expect(out.y).toBeCloseTo(2 + core.table[m + 1], 5);
    expect(out.z).toBeCloseTo(20 + core.table[m + 2], 5);
    // Facing sim +x: the quarter turn, (x, z) -> (z, -x).
    x1CockpitSkeleton(core, 10, 2, 20, 0, 1, 316, 5, out);
    expect(out.x).toBeCloseTo(10 + core.table[m + 2], 5);
    expect(out.z).toBeCloseTo(20 - core.table[m], 5);
    // Side 1's texels, through a material with the team offset and no pose.
    expect([out.teamU, out.teamV]).toEqual([0.5, 0]);
    const shader = {
      uniforms: {},
      vertexShader: "#include <common>\n#include <uv_vertex>\n#include <begin_vertex>\n",
      fragmentShader: "",
    };
    out.material.onBeforeCompile(shader as never, {} as never);
    expect(shader.vertexShader).toContain("instanceTeamUv");
    expect(shader.vertexShader).not.toContain("x1Anim");
    // The cockpit's faces wholly inside one bone, 126; a face across two
    // bones is never drawn.
    const rec = FX_RECORDS[FX_ARENAS["la-cantina"].banks[1][8]] as Fx90;
    expect(rec.shatterFlags & 0x10).toBe(0x10);
    const bones = new SkeletonShatter(scene);
    expect(bones.spawn(rec, out, 0)).toBe(true);
    expect(bones.drawn()).toBe(126);
    expect(bones.left(0)).toBe(7);
    // Before the first tick every corner is where the rig draws it on an X1
    // facing sim +x with its aim at rest: the identity is that X1.
    const drawnPos = scene.children
      .map((c) => (c as THREE.Mesh).geometry)
      .find((g) => g?.drawRange.count === 126 * 3)
      ?.getAttribute("position").array as Float32Array;
    const geo = core.mesh.geometry;
    const position = geo.getAttribute("position");
    const slot = geo.getAttribute(X1_BONE_ATTR);
    const posed = new Float32Array(3);
    let f = 0;
    for (let t = 0; t < position.count / 3; t++) {
      const b = slot.getX(t * 3);
      if (b < X1_COCKPIT_SLOT || b >= X1_COCKPIT_SLOT + 7) continue;
      if (slot.getX(t * 3 + 1) !== b || slot.getX(t * 3 + 2) !== b) continue;
      for (let k = 0; k < 3; k++) {
        const v = t * 3 + k;
        poseX1Vertex(
          core.table,
          b,
          316,
          5,
          0,
          0,
          position.getX(v),
          position.getY(v),
          position.getZ(v),
          posed,
          0,
        );
        const o = (f * 3 + k) * 3;
        expect(drawnPos[o]).toBeCloseTo(10 + posed[2], 4);
        expect(drawnPos[o + 1]).toBeCloseTo(2 + posed[1], 4);
        expect(drawnPos[o + 2]).toBeCloseTo(20 - posed[0], 4);
      }
      f++;
    }
    expect(f).toBe(126);
  });
});
