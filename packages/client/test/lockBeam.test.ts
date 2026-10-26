// The lock beam (render/lockBeam.ts, RE hud_draw_lock_beam 0x00435330): its
// near end is the cockpit's model point 0 placed as a cockpit vertex is
// (render/avatarRig.ts x1BeamPoint), and it is drawn in the scene at the nearer
// end's camera depth, clamped up to 2 m, after the near-plane clip.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { x1BeamPoint } from "../src/render/avatarRig";
import { createLockBeam, LOCK_BEAM_MIN_DEPTH_M } from "../src/render/lockBeam";
import {
  X1_ANIM_WIDTH,
  X1_BEAM_POINT,
  X1_COCKPIT_FRAMES,
  X1_MOUNT_TEXEL,
} from "../src/render/x1Rig.generated";

const BIN = fileURLToPath(new URL("../public/models/units/avatar-x1.anim.bin", import.meta.url));
const bin = readFileSync(BIN);
const table = new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

describe("x1BeamPoint", () => {
  test("a point per cockpit frame", () => {
    expect(X1_BEAM_POINT.length).toBe(X1_COCKPIT_FRAMES * 3);
  });

  test("unaimed and facing +x: the mount plus point 0 turned a quarter (model +z forward)", () => {
    const out = new Float32Array(3);
    x1BeamPoint(table, 10, 2, 20, 0, 0, 0, 0, 0, out);
    const m = X1_MOUNT_TEXEL * 4;
    const mx = table[m] + X1_BEAM_POINT[0];
    const my = table[m + 1] + X1_BEAM_POINT[1];
    const mz = table[m + 2] + X1_BEAM_POINT[2];
    // MODEL_YAW - yaw = pi / 2: model +z goes to world +x, model +x to world -z.
    expect(out[0]).toBeCloseTo(10 + mz, 5);
    expect(out[1]).toBeCloseTo(2 + my, 5);
    expect(out[2]).toBeCloseTo(20 - mx, 5);
  });

  test("the aim turns the point about the mount, not the X1's origin", () => {
    const a = new Float32Array(3);
    const b = new Float32Array(3);
    x1BeamPoint(table, 0, 0, 0, 0, 0, 0, 0, 0, a);
    x1BeamPoint(table, 0, 0, 0, 0, 0, 0, Math.PI, 0, b);
    const m = (0 * X1_ANIM_WIDTH + X1_MOUNT_TEXEL) * 4;
    // Half a turn: mirrored through the mount's vertical axis.
    expect(a[0] + b[0]).toBeCloseTo(2 * table[m + 2], 5);
    expect(a[2] + b[2]).toBeCloseTo(-2 * table[m], 5);
    expect(a[1]).toBeCloseTo(b[1], 5);
  });
});

describe("createLockBeam", () => {
  const camera = new THREE.PerspectiveCamera(30, 4 / 3, 0.1, 1000);
  camera.updateMatrixWorld();
  const scene = new THREE.Scene();
  const beam = createLockBeam(scene);
  const u = (beam.mesh.material as THREE.ShaderMaterial).uniforms;

  test("in the scene, additive, depth-tested, not written", () => {
    expect(beam.mesh.parent).toBe(scene);
    const m = beam.mesh.material as THREE.ShaderMaterial;
    expect(m.blending).toBe(THREE.AdditiveBlending);
    expect(m.depthTest).toBe(true);
    expect(m.depthWrite).toBe(false);
  });

  test("the key is the nearer end's depth", () => {
    beam.set(camera, true, 0, 0, -5, 1, 0, -10, 640, 480, 1);
    expect(beam.mesh.visible).toBe(true);
    expect(u.uKey.value).toBeCloseTo(5, 6);
    // The sort point stands on the camera's axis at the key.
    expect(beam.mesh.matrix.elements[14]).toBeCloseTo(-5, 6);
  });

  test("clamped up to 0x400 camera units, 2 m", () => {
    expect(LOCK_BEAM_MIN_DEPTH_M).toBe(2);
    beam.set(camera, true, 0, 0, -0.5, 0, 0, -10, 640, 480, 1);
    expect(u.uKey.value).toBe(2);
  });

  test("an end behind the camera is clipped to the near plane", () => {
    beam.set(camera, true, 0, 0, 5, 0, 0, -10, 640, 480, 1);
    expect(beam.mesh.visible).toBe(true);
    expect(u.uA.value.z).toBeCloseTo(-0.1, 6);
    beam.set(camera, true, 0, 0, 5, 0, 0, 1, 640, 480, 1);
    expect(beam.mesh.visible).toBe(false);
  });

  test("one 640 x 480 pixel wide, scaled with the view", () => {
    beam.set(camera, true, 0, 0, -5, 1, 0, -10, 1280, 960, 2);
    expect(u.uWidth.value).toBe(2);
    beam.set(camera, false, 0, 0, 0, 0, 0, 0, 1, 1, 1);
    expect(beam.mesh.visible).toBe(false);
  });
});
