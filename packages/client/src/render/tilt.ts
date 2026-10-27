// The bodies' orientations beyond the yaw (fcop-fidelity.md I6, U1, A19): a
// route follower's hull on the road's slope and Hk's tanks' bank, an aircraft's
// bank and pitch, the crash tumble's turn. The sim writes each such body's
// model forward and up per tick (sim orient.ts writeTiltSnapshot); the client
// keeps two ticks, as it does for the entities, and turns the model between
// them.
//
// The drawn models face +x at rest, up +y (unitMeshes.ts bakes +z to +x), and
// three's (x, y, z) is the sim's (x, height, y), so the rotation is the one
// taking +x to the forward and +y to the up, both read in three's axes. With
// no tilt it is the yaw's own: `setFromAxisAngle(UP, -yaw)`.
//
// Renderer rule 1: tiltQuat runs per tilted body per frame and allocates
// nothing.

import { TILT_SNAP_STRIDE } from "@metropolis/sim";
import * as THREE from "three";

const basisX = new THREE.Vector3();
const basisY = new THREE.Vector3();
const basisZ = new THREE.Vector3();
const basis = new THREE.Matrix4();
const quatPrev = new THREE.Quaternion();
const quatCurr = new THREE.Quaternion();

/** Does row `id` of the tilt snapshot carry an orientation? */
export function hasTilt(snap: Float32Array, id: number): boolean {
  const o = id * TILT_SNAP_STRIDE;
  return snap[o + 3] !== 0 || snap[o + 4] !== 0 || snap[o + 5] !== 0;
}

/** Row `id`'s rotation into `out`. */
function quatOf(snap: Float32Array, id: number, out: THREE.Quaternion): THREE.Quaternion {
  const o = id * TILT_SNAP_STRIDE;
  // sim (x, y, height) -> three (x, height, y)
  basisX.set(snap[o], snap[o + 2], snap[o + 1]);
  basisY.set(snap[o + 3], snap[o + 5], snap[o + 4]);
  basisZ.crossVectors(basisX, basisY);
  basis.makeBasis(basisX, basisY, basisZ);
  return out.setFromRotationMatrix(basis);
}

/**
 * Entity `id`'s rotation `alpha` of the way from the previous tick's tilt
 * snapshot to the current one (the current one's alone when the previous has
 * none for it), into `out`. False, and `out` untouched, when the current tick
 * carries no tilt for it: the caller turns it by its yaw.
 */
export function tiltQuat(
  prev: Float32Array,
  curr: Float32Array,
  id: number,
  alpha: number,
  hasPrev: boolean,
  out: THREE.Quaternion,
): boolean {
  if (!hasTilt(curr, id)) return false;
  if (!hasPrev || !hasTilt(prev, id)) {
    quatOf(curr, id, out);
    return true;
  }
  quatOf(prev, id, quatPrev);
  quatOf(curr, id, quatCurr);
  out.slerpQuaternions(quatPrev, quatCurr, alpha);
  return true;
}
