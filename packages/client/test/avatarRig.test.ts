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
import {
  buildX1Rig,
  createX1AnimTexture,
  placeX1,
  RIG_CAPACITY,
  X1_BONE_ATTR,
  X1_POSE_ATTR,
} from "../src/render/avatarRig";
import { patchTeamUv, prepareTeamUvMask, TEAM_UV_ATTR } from "../src/render/teamUv";
import { X1_ANIM_HEIGHT, X1_ANIM_WIDTH } from "../src/render/x1Rig.generated";

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
});
