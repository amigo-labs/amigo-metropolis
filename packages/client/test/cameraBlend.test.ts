// The menu→match camera blend must start exactly on the captured flyover pose,
// end exactly on the rig pose, and move monotonically between them — a pop at
// either end would break the "one continuous shot" transition.

import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { applyBlend, beginBlend, createCameraBlend } from "../src/render/cameraBlend";

const FROM_POS = new THREE.Vector3(100, 80, 140);
const RIG_POS = new THREE.Vector3(10, 12, 20);

function flyoverCam(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
  cam.position.copy(FROM_POS);
  cam.lookAt(64, 0, 64);
  return cam;
}

/** Poses `cam` the way the chase rig would every frame. */
function poseAsRig(cam: THREE.PerspectiveCamera): void {
  cam.position.copy(RIG_POS);
  cam.lookAt(0, 0, 0);
  cam.fov = 74;
}

describe("cameraBlend", () => {
  test("starts on the from-pose and lands on the rig pose", () => {
    const b = createCameraBlend();
    const cam = flyoverCam();
    beginBlend(b, cam, 1);
    expect(b.active).toBe(true);

    // Frame 1, tiny dt: still essentially the flyover pose.
    poseAsRig(cam);
    expect(applyBlend(b, cam, 0.001)).toBe(true);
    expect(cam.position.distanceTo(FROM_POS)).toBeLessThan(0.01);

    // Past the duration: blend deactivates and leaves the rig pose untouched.
    poseAsRig(cam);
    expect(applyBlend(b, cam, 2)).toBe(false);
    expect(b.active).toBe(false);
    expect(cam.position.distanceTo(RIG_POS)).toBe(0);
    expect(cam.fov).toBe(74);

    // Inactive blends are a no-op.
    poseAsRig(cam);
    expect(applyBlend(b, cam, 0.016)).toBe(false);
    expect(cam.position.distanceTo(RIG_POS)).toBe(0);
  });

  test("moves monotonically from the from-pose toward the rig pose", () => {
    const b = createCameraBlend();
    const cam = flyoverCam();
    beginBlend(b, cam, 1);
    let prevDist = cam.position.distanceTo(RIG_POS);
    let prevFov = 60;
    for (let i = 0; i < 30; i++) {
      poseAsRig(cam);
      const active = applyBlend(b, cam, 0.045);
      const dist = cam.position.distanceTo(RIG_POS);
      expect(dist).toBeLessThanOrEqual(prevDist + 1e-9);
      expect(cam.fov).toBeGreaterThanOrEqual(prevFov - 1e-9);
      prevDist = dist;
      prevFov = cam.fov;
      if (!active) break;
    }
    expect(b.active).toBe(false);
    expect(prevDist).toBe(0);
  });
});
