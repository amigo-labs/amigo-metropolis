// One-shot camera pose blend: carries the view from a captured "from" pose
// (the menu flyover) into wherever the chase rig wants the camera, so starting
// a match from the menu is a single continuous shot instead of a cut. Frame-
// loop discipline: all scratch lives at module scope; applyBlend allocates
// nothing and only touches the projection matrix when the fov actually moves.

import * as THREE from "three";
import { smoothstep } from "./camera";

export interface CameraBlend {
  active: boolean;
  /** Seconds elapsed since beginBlend. */
  t: number;
  duration: number;
  readonly fromPos: THREE.Vector3;
  readonly fromQuat: THREE.Quaternion;
  fromFov: number;
}

const rigPos = new THREE.Vector3();
const rigQuat = new THREE.Quaternion();

/** Boot-time allocation of the (single) blend state. */
export function createCameraBlend(): CameraBlend {
  return {
    active: false,
    t: 0,
    duration: 1,
    fromPos: new THREE.Vector3(),
    fromQuat: new THREE.Quaternion(),
    fromFov: 60,
  };
}

/** Captures `from`'s current pose as the blend origin and starts the clock. */
export function beginBlend(
  b: CameraBlend,
  from: THREE.PerspectiveCamera,
  durationSec: number,
): void {
  b.fromPos.copy(from.position);
  b.fromQuat.copy(from.quaternion);
  b.fromFov = from.fov;
  b.t = 0;
  b.duration = durationSec;
  b.active = true;
}

/**
 * Call AFTER the rig has posed `cam` for this frame; overwrites the camera
 * with the eased from→rig mix. Returns false once the blend has finished
 * (the camera then already holds the pure rig pose).
 */
export function applyBlend(b: CameraBlend, cam: THREE.PerspectiveCamera, dtSec: number): boolean {
  if (!b.active) return false;
  b.t += dtSec;
  if (b.t >= b.duration) {
    b.active = false;
    return false;
  }
  const k = smoothstep(b.t / b.duration);
  rigPos.copy(cam.position);
  rigQuat.copy(cam.quaternion);
  cam.position.lerpVectors(b.fromPos, rigPos, k);
  cam.quaternion.slerpQuaternions(b.fromQuat, rigQuat, k);
  const fov = b.fromFov + (cam.fov - b.fromFov) * k;
  if (cam.fov !== fov) {
    cam.fov = fov;
    cam.updateProjectionMatrix();
  }
  return true;
}
