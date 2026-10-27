// render/tilt.ts: the sim's model forward and up (writeTiltSnapshot) as the
// drawn model's rotation, and the yaw's own where the body is level.

import { describe, expect, it } from "bun:test";
import { TILT_SNAP_STRIDE, TILT_SNAPSHOT_LEN } from "@metropolis/sim";
import * as THREE from "three";
import { hasTilt, tiltQuat } from "../src/render/tilt";

const UP = new THREE.Vector3(0, 1, 0);

function row(snap: Float32Array, id: number, f: number[], u: number[]): void {
  const o = id * TILT_SNAP_STRIDE;
  snap.set([...f, ...u], o);
}

describe("tiltQuat", () => {
  it("is the yaw's own rotation for a level body", () => {
    const snap = new Float32Array(TILT_SNAPSHOT_LEN);
    const yaw = 0.7;
    row(snap, 3, [Math.cos(yaw), Math.sin(yaw), 0], [0, 0, 1]);
    const q = new THREE.Quaternion();
    expect(tiltQuat(snap, snap, 3, 0.5, false, q)).toBe(true);
    const want = new THREE.Quaternion().setFromAxisAngle(UP, -yaw);
    expect(Math.abs(q.dot(want))).toBeCloseTo(1, 6);
  });

  it("takes the model's +x to the forward and +y to the up, in three's axes", () => {
    const snap = new Float32Array(TILT_SNAPSHOT_LEN);
    const s = Math.SQRT1_2;
    // Facing sim +x, the nose 45 degrees up.
    row(snap, 1, [s, 0, s], [-s, 0, s]);
    const q = new THREE.Quaternion();
    tiltQuat(snap, snap, 1, 0, false, q);
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    expect(x.x).toBeCloseTo(s, 5);
    expect(x.y).toBeCloseTo(s, 5);
    expect(x.z).toBeCloseTo(0, 5);
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    expect(y.x).toBeCloseTo(-s, 5);
    expect(y.y).toBeCloseTo(s, 5);
  });

  it("interpolates between the two ticks, and leaves a body without a row alone", () => {
    const prev = new Float32Array(TILT_SNAPSHOT_LEN);
    const curr = new Float32Array(TILT_SNAPSHOT_LEN);
    row(prev, 2, [1, 0, 0], [0, 0, 1]);
    row(curr, 2, [0, 1, 0], [0, 0, 1]);
    const q = new THREE.Quaternion();
    tiltQuat(prev, curr, 2, 0.5, true, q);
    const want = new THREE.Quaternion().setFromAxisAngle(UP, -Math.PI / 4);
    expect(Math.abs(q.dot(want))).toBeCloseTo(1, 6);
    expect(hasTilt(curr, 5)).toBe(false);
    q.set(0, 0, 0, 1);
    expect(tiltQuat(prev, curr, 5, 0.5, true, q)).toBe(false);
    expect(q.w).toBe(1);
  });
});
