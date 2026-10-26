// The X1's rig (render/avatarRig.ts): ONE InstancedMesh over the shipped
// avatar-x1.glb, posed in the vertex shader from the bone table by a
// four-float pose per instance, its faces in the original's draw modes (a
// geometry group per pass, render/fcopModel.ts) and gated by the layer masks
// of the instance's draw form. The shader cannot run here, so this pins what
// feeds it -- the attributes, the table texture, the patches -- and what
// `place` writes per slot; render/x1Pose.ts, the shader's CPU twin, is held
// against the RE's assembled poses in tools/generators/test/x1Rig.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  X1_LAYER_ATTR,
  X1_LAYERS_ATTR,
  X1_POSE_ATTR,
  x1CockpitSkeleton,
} from "../src/render/avatarRig";
import {
  type FaceGroup,
  type FaceMode,
  faceMaterials,
  facePassOf,
  materialList,
} from "../src/render/fcopModel";
import { makeShatterSkeleton, SkeletonShatter } from "../src/render/fx/skeletonShatter";
import { patchTeamUv, prepareTeamUvMask, TEAM_UV_ATTR } from "../src/render/teamUv";
import { poseX1Vertex } from "../src/render/x1Pose";
import {
  X1_ANIM_HEIGHT,
  X1_ANIM_WIDTH,
  X1_COCKPIT_LAYER_MASKS,
  X1_COCKPIT_ROW,
  X1_COCKPIT_SLOT,
  X1_LEGS_LAYER_MASKS,
  X1_MOUNT_TEXEL,
} from "../src/render/x1Rig.generated";
import { X1_FORM_HOVER, X1_FORM_RAMP, X1_FORM_WALKER } from "../src/render/x1Walk";

const GLB = fileURLToPath(new URL("../public/models/units/avatar-x1.glb", import.meta.url));
const BIN = fileURLToPath(new URL("../public/models/units/avatar-x1.anim.bin", import.meta.url));

/**
 * The glb as the loader hands it over (render/fcopModel.ts mergeFcopModel):
 * its primitives back to back with a group each, `_X1BONE`, `_TEAMUV` and
 * `_X1LAYER` lowercased, the materials faceMaterials makes with the team
 * offset.
 */
async function loadRig() {
  const doc = await new NodeIO().read(GLB);
  const prims = doc
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives());
  const arrays = new Map<string, number[]>();
  const groups: FaceGroup[] = [];
  const map = new THREE.DataTexture(new Uint8Array(256 * 256 * 4), 256, 256);
  let start = 0;
  for (const p of prims) {
    for (const [gltf, three] of [
      ["POSITION", "position"],
      ["NORMAL", "normal"],
      ["TEXCOORD_0", "uv"],
      ["_X1BONE", "_x1bone"],
      ["_TEAMUV", "_teamuv"],
      ["_X1LAYER", "_x1layer"],
    ]) {
      const a = p.getAttribute(gltf);
      if (!a) throw new Error(`no ${gltf}`);
      const list = arrays.get(three) ?? [];
      list.push(...(a.getArray() as Float32Array));
      arrays.set(three, list);
    }
    const count = p.getAttribute("POSITION")?.getCount() ?? 0;
    const mode = (p.getMaterial()?.getExtras() as { fcop?: { mode?: FaceMode } } | undefined)?.fcop
      ?.mode;
    groups.push({ mode: mode ?? "opaque", tint: null, map, start, count });
    start += count;
  }
  const sizes: Record<string, number> = { position: 3, normal: 3, uv: 2 };
  const geometry = new THREE.BufferGeometry();
  for (const [name, list] of arrays) {
    geometry.setAttribute(
      name,
      new THREE.BufferAttribute(new Float32Array(list), sizes[name] ?? 1),
    );
  }
  const material = faceMaterials(
    { geometry, groups, map, extras: undefined },
    { patch: patchTeamUv },
  );
  prepareTeamUvMask(geometry);
  const bin = readFileSync(BIN);
  const table = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const scene = new THREE.Scene();
  const core = buildX1Rig(scene, geometry, material, table);
  return { scene, core, prims, groups };
}

/** A shader as three hands it over, with the chunks the patches replace. */
function patched(material: THREE.Material) {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: "#include <common>\n#include <uv_vertex>\n#include <begin_vertex>\n",
    fragmentShader: "#include <map_fragment>\n#include <alphatest_fragment>\n",
  };
  material.onBeforeCompile(shader as never, {} as never);
  return shader;
}

describe("the X1's rig", () => {
  test("is one InstancedMesh for every form, in the scene, at capacity 4", async () => {
    const { scene, core } = await loadRig();
    const meshes = scene.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh);
    expect(meshes.length).toBe(1);
    expect(core.mesh.count).toBe(0);
    expect(core.mesh.matrixAutoUpdate).toBe(false);
    expect(core.mesh.instanceMatrix.count).toBe(RIG_CAPACITY);
    const g = core.mesh.geometry;
    expect(g.getAttribute(X1_BONE_ATTR)).toBeDefined();
    expect(g.getAttribute("_x1bone")).toBeUndefined();
    expect(g.getAttribute(X1_LAYER_ATTR)).toBeDefined();
    expect(g.getAttribute("_x1layer")).toBeUndefined();
    expect((g.getAttribute(X1_POSE_ATTR) as THREE.InstancedBufferAttribute).meshPerAttribute).toBe(
      1,
    );
    expect((g.getAttribute(X1_LAYERS_ATTR) as THREE.InstancedBufferAttribute).itemSize).toBe(2);
    expect(g.getAttribute(TEAM_UV_ATTR)).toBeDefined();
  });

  test("draws the original's modes: opaque, then the legs' half faces twice", async () => {
    const { core, prims, groups } = await loadRig();
    // A primitive per mode, opaque first (gen:units' order).
    expect(prims.length).toBe(2);
    expect(groups.map((g) => g.mode)).toEqual(["opaque", "half"]);
    const passes = materialList(core.mesh.material).map(facePassOf);
    expect(passes).toEqual(["opaque", "half-solid", "half-blend"]);
    // The half group's two passes cover the same triangles.
    const [, solid, blend] = core.mesh.geometry.groups;
    expect([solid.start, solid.count]).toEqual([blend.start, blend.count]);
    // The legs (slots below the cockpit's) are half throughout.
    const slot = core.mesh.geometry.getAttribute(X1_BONE_ATTR);
    for (let i = 0; i < groups[0].count; i++) expect(slot.getX(i) >= X1_COCKPIT_SLOT).toBe(true);
  });

  test("feeds the shader a float table it fetches unfiltered", () => {
    const tex = createX1AnimTexture(new Float32Array(X1_ANIM_WIDTH * X1_ANIM_HEIGHT * 4));
    expect(tex.type).toBe(THREE.FloatType);
    expect(tex.magFilter).toBe(THREE.NearestFilter);
    expect(tex.minFilter).toBe(THREE.NearestFilter);
    expect(tex.generateMipmaps).toBe(false);
    expect(() => createX1AnimTexture(new Float32Array(8))).toThrow();
  });

  test("patches the pose and the layer gate into every pass, after its own patches", async () => {
    const { core } = await loadRig();
    const materials = materialList(core.mesh.material);
    expect(materials.map((m) => m.customProgramCacheKey())).toEqual([
      "teamUv+x1",
      "teamUv+x1",
      "fcopHalf+teamUv+x1",
    ]);
    for (const material of materials) {
      const shader = patched(material);
      expect(shader.vertexShader).toContain("instanceTeamUv");
      expect(shader.vertexShader).toContain("texelFetch(x1Anim");
      expect(shader.vertexShader).toContain("(x1Mask >> int(x1Layer + 0.5)) & 1");
      expect(shader.vertexShader).toContain("transformed = x1Q;");
      expect((shader.uniforms.x1Anim.value as THREE.DataTexture).isDataTexture).toBe(true);
    }
    expect(patched(materials[2]).fragmentShader).toContain("if ( diffuseColor.a > 0.75 ) discard;");
  });

  test("place writes the slot's matrix, its pose, and the offset on a change only", async () => {
    const { core } = await loadRig();
    const pose = core.mesh.geometry.getAttribute(X1_POSE_ATTR) as THREE.InstancedBufferAttribute;
    const team = core.mesh.geometry.getAttribute(TEAM_UV_ATTR) as THREE.InstancedBufferAttribute;
    placeX1(core, 1, 10, 2, 20, Math.PI / 2, 1, 316, 0, 0.1, -0.2, -1, X1_FORM_WALKER);
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
    placeX1(core, 1, 10, 2, 20, Math.PI / 2, 1, 317, 0, 0.1, -0.2, -1, X1_FORM_WALKER);
    expect(team.version).toBe(version);
    // The cloak: v is the frame clock's, the side's u stays.
    placeX1(core, 1, 10, 2, 20, Math.PI / 2, 1, 317, 0, 0.1, -0.2, 40, X1_FORM_WALKER);
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
    // Side 1's texels, through the rig's passes with the team offset and no
    // pose: a half face's bit-15 texels still their own pass.
    expect([out.teamU, out.teamV]).toEqual([0.5, 0]);
    const plain = materialList(out.material);
    const rig = materialList(core.mesh.material);
    expect(plain.map(facePassOf)).toEqual(rig.map(facePassOf));
    for (const m of plain) {
      expect(rig).not.toContain(m);
      const shader = patched(m);
      expect(shader.vertexShader).toContain("instanceTeamUv");
      expect(shader.vertexShader).not.toContain("x1Anim");
      expect(shader.fragmentShader.includes("diffuseColor.a > 0.75")).toBe(
        facePassOf(m) === "half-blend",
      );
    }
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
    // The pieces keep the rig's groups: a face's pass is its source group's.
    const src = core.mesh.geometry.groups;
    const shards = scene.children
      .map((c) => (c as THREE.Mesh).geometry)
      .find((g) => g?.drawRange.count === 126 * 3) as THREE.BufferGeometry;
    expect(shards.groups.map((g) => g.materialIndex)).toEqual(src.map((g) => g.materialIndex));
    expect(
      shards.groups.reduce(
        (n, g, i) => (i > 0 && g.start === shards.groups[i - 1].start ? n : n + g.count),
        0,
      ),
    ).toBe(126 * 3);
  });

  test("place gates the layers by the partner's masks of the draw form", async () => {
    const { core } = await loadRig();
    const layers = core.mesh.geometry.getAttribute(
      X1_LAYERS_ATTR,
    ) as THREE.InstancedBufferAttribute;
    const masks = (form: number) => {
      placeX1(core, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, form);
      return [layers.array[4], layers.array[5]];
    };
    // player_partner.c 299-320: the legs 3 / 7 / 5, the cockpit 5 / 0xf / 0xb.
    expect([X1_LEGS_LAYER_MASKS, X1_COCKPIT_LAYER_MASKS]).toEqual([
      [3, 7, 5],
      [5, 15, 11],
    ]);
    expect(masks(X1_FORM_WALKER)).toEqual([3, 5]);
    expect(masks(X1_FORM_RAMP)).toEqual([7, 15]);
    expect(masks(X1_FORM_HOVER)).toEqual([5, 11]);
    // So the legs' layer 1 shows as a walker and through the ramp, the
    // cockpit's as a hover and through the ramp.
    const bit1 = (m: number) => (m >> 1) & 1;
    expect(
      [X1_FORM_WALKER, X1_FORM_RAMP, X1_FORM_HOVER].map((f) => bit1(X1_LEGS_LAYER_MASKS[f])),
    ).toEqual([1, 1, 0]);
    expect(
      [X1_FORM_WALKER, X1_FORM_RAMP, X1_FORM_HOVER].map((f) => bit1(X1_COCKPIT_LAYER_MASKS[f])),
    ).toEqual([0, 1, 1]);
    const version = layers.version;
    masks(X1_FORM_HOVER);
    expect(layers.version).toBe(version);
  });

  test("the glb's layer-1 faces are the legs' and the cockpit's", async () => {
    const { core } = await loadRig();
    const g = core.mesh.geometry;
    const slot = g.getAttribute(X1_BONE_ATTR);
    const layer = g.getAttribute(X1_LAYER_ATTR);
    let legs = 0;
    let cockpit = 0;
    for (let i = 0; i < layer.count; i++) {
      if (layer.getX(i) === 0) continue;
      expect(layer.getX(i)).toBe(1);
      if (slot.getX(i) < X1_COCKPIT_SLOT) legs++;
      else cockpit++;
    }
    // 16 legs faces (4 triangles, 12 quads), 6 cockpit quads, as vertices.
    expect([legs, cockpit]).toEqual([(4 + 12 * 2) * 3, 6 * 2 * 3]);
  });
});
