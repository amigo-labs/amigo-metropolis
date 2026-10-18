// One record angle, one turn (fcop-fidelity.md G12; render/recordYaw.ts). These
// rebuild the original's placement of a model from the RE's own conventions and
// hold the client's one mapping to it: the record's My(a) (fcop/matrix.h, the
// row-vector convention the draw keeps), the actors frame the sim and the
// terrain share (sim x = game z, sim y = game x), and the RE's glb export (the
// Cobj with its x negated, tools/gfx/obj_mesh.py).

import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { BAKED_TURN, RECORD_TURN, recordTurn, recordYaw, yawTurn } from "../src/render/recordYaw";

const UP = new THREE.Vector3(0, 1, 0);

/** The RE's My(a), rows (cos, 0, -sin), (0, 1, 0), (sin, 0, cos); a in 4096ths. */
function my(raw: number): number[][] {
  const a = (raw * 2 * Math.PI) / RECORD_TURN;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [c, 0, -s],
    [0, 1, 0],
    [s, 0, c],
  ];
}

/** v' = v * M: row r of M is the image of basis vector r. */
function rowTimes(v: readonly number[], m: number[][]): number[] {
  return [0, 1, 2].map((c) => v[0] * m[0][c] + v[1] * m[1][c] + v[2] * m[2][c]);
}

/** The game's (x, y, z) in three: the actors frame's swap of x and z. */
function toThree(g: readonly number[]): THREE.Vector3 {
  return new THREE.Vector3(g[2], g[1], g[0]);
}

/** A Cobj vertex as the RE's glb carries it: x negated. */
function toGlb(v: readonly number[]): THREE.Vector3 {
  return new THREE.Vector3(-v[0], v[1], v[2]);
}

const ANGLES = [0, 1, 512, 700, 1024, 1536, 2048, 2560, 3072, 3584, 4095, -1024];
const VERTICES = [
  [0, 0, 1],
  [1, 0, 0],
  [0.3, 0.88, -0.31],
  [-0.27, 0.49, 0.28],
];

describe("a record angle stands a model as the original does", () => {
  test("three's turn of the glb lands every vertex where v * My(a) puts it", () => {
    for (const raw of ANGLES) {
      for (const v of VERTICES) {
        const want = toThree(rowTimes(v, my(raw)));
        const got = toGlb(v).applyAxisAngle(UP, recordTurn(raw));
        expect(got.distanceTo(want)).toBeLessThan(1e-9);
      }
    }
  });

  test("without a mirror: the swap and the export's negation cancel", () => {
    // The composite glb -> three is S * My^T * N; its determinant is +1, so the
    // model's winding is kept and its front faces stay front faces.
    for (const raw of ANGLES) {
      const col = (e: number[]) => toThree(rowTimes([-e[0], e[1], e[2]], my(raw)));
      const m = new THREE.Matrix4().makeBasis(col([1, 0, 0]), col([0, 1, 0]), col([0, 0, 1]));
      expect(m.determinant()).toBeCloseTo(1, 9);
    }
  });

  test("the record angle is the sim's yaw: the model's +z heads (cos a, sin a)", () => {
    // Row 2 of My(a) is (sin a, 0, cos a) in the game's frame: the sim's
    // (cos a, sin a). The X1Alpha's spawn facing (enrichArena.ts out0Spawns,
    // raw * pi / 2048 onto the gate) and every unit's motion (+z forward) read it so.
    for (const raw of ANGLES) {
      const row2 = toThree(my(raw)[2]);
      expect(row2.x).toBeCloseTo(Math.cos(recordYaw(raw)), 9);
      expect(row2.z).toBeCloseTo(Math.sin(recordYaw(raw)), 9);
      expect(recordYaw(raw)).toBeCloseTo((raw * Math.PI) / 2048, 12);
    }
  });

  test("is the turn a unit of the same sim yaw is drawn with", () => {
    // A unit bakes a quarter turn into its geometry and turns by -yaw
    // (unitMeshes.ts, main.ts); a turret part the same (arenaUnits.ts): the
    // same rotation as yawTurn on the bare glb.
    for (const raw of ANGLES) {
      const yaw = recordYaw(raw);
      const unit = new THREE.Quaternion()
        .setFromAxisAngle(UP, -yaw)
        .multiply(new THREE.Quaternion().setFromAxisAngle(UP, BAKED_TURN));
      const bare = new THREE.Quaternion().setFromAxisAngle(UP, yawTurn(yaw));
      const part = new THREE.Quaternion()
        .setFromAxisAngle(UP, yawTurn(yaw) - BAKED_TURN)
        .multiply(new THREE.Quaternion().setFromAxisAngle(UP, BAKED_TURN));
      expect(Math.abs(unit.dot(bare))).toBeCloseTo(1, 9);
      expect(Math.abs(part.dot(bare))).toBeCloseTo(1, 9);
    }
  });

  test("not the mapping the lifts and the turret bases had", () => {
    // The lifts swapped the glb's axes once more and turned by -yaw: the model
    // mirrored in its own x. The turret bases stood at three's turn a: a
    // quarter turn and a mirror about the diagonal away.
    for (const raw of [700, 1024, 1536, 3000]) {
      const yaw = recordYaw(raw);
      const v = toGlb([0.3, 0.88, -0.31]);
      const want = v.clone().applyAxisAngle(UP, recordTurn(raw));
      const lift = new THREE.Vector3(v.z, v.y, v.x).applyAxisAngle(UP, -yaw);
      const base = v.clone().applyAxisAngle(UP, yaw);
      expect(lift.distanceTo(want)).toBeGreaterThan(0.1);
      expect(base.distanceTo(want)).toBeGreaterThan(0.1);
    }
  });
});
