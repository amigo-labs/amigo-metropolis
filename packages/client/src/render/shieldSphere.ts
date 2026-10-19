// The Riot Shield's sphere (SimOptions.extraWeapons; sim.ts systemShields),
// drawn as the original draws it: `sustain_sphere_draw` 0x0044cdc0 hands
// `draw_sphere` the record's patch, the mech's frame, the radius and two
// colours — black at the pole, the look's colour toward the equator, a
// latitude ramp whose ramped patch (flags 9) reaches its colour half way down
// (`sphere.h`) — added, untextured. Block A's patch is the front half (the
// mesh's SPHERE_FLAG_HALF_Z drops the -z instances), block B's the whole
// sphere; for the four draws after a contact the colour is the flash.
//
// The looks (`sustain_sphere_create`, LOOK_A / LOOK_B): A (0x40, 0x40, 0x40),
// flash (0x60, 0x30, 0); B (0x40, 0x40, 0x60), flash (0x7f, 0x60, 0), shown
// as the hardware's byte values on an sRGB screen, as every effect is (E18).
//
// Reads the avatar snapshot (AVATAR_SNAP_SHIELD_*) and the frame's interpolated
// mech pose only. Two InstancedMeshes (the half and the whole patch, the two
// shapes the original's one mesh takes), preallocated; nothing allocates per
// frame.

import {
  AVATAR_SNAP_ID,
  AVATAR_SNAP_SHIELD_FLAGS,
  AVATAR_SNAP_SHIELD_RADIUS,
  AVATAR_SNAP_STRIDE,
  MAX_PLAYERS,
  SHIELD_CENTRE_RAISE,
  SHIELD_SNAP_FLASH,
  SHIELD_SNAP_WHOLE,
} from "@metropolis/sim";
import * as THREE from "three";

/** A look's colour as the hardware's byte values on an sRGB screen (E18). */
function look(r: number, g: number, b: number): THREE.Color {
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}
const LOOK_A = look(0x40, 0x40, 0x40);
const FLASH_A = look(0x60, 0x30, 0);
const LOOK_B = look(0x40, 0x40, 0x60);
const FLASH_B = look(0x7f, 0x60, 0);

/** The latitude ramp: black at each pole, the full colour 45° down and on to the equator. */
function rampColours(geometry: THREE.BufferGeometry): void {
  const pos = geometry.getAttribute("position");
  const colours = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = Math.max(-1, Math.min(1, pos.getY(i)));
    const fromPole = Math.acos(Math.abs(y)); // 0 at a pole, pi/2 at the equator
    const k = Math.min(1, fromPole / (Math.PI / 4));
    colours[i * 3] = k;
    colours[i * 3 + 1] = k;
    colours[i * 3 + 2] = k;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
}

function sphereMesh(scene: THREE.Scene, half: boolean): THREE.InstancedMesh {
  // Three's sphere has its x at -cos(phi): phi in [pi/2, 3pi/2] is the +x half,
  // the mech's front (the bucket models face +x, rotated by -yaw).
  const geometry = half
    ? new THREE.SphereGeometry(1, 24, 16, Math.PI / 2, Math.PI)
    : new THREE.SphereGeometry(1, 24, 16);
  rampColours(geometry);
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, MAX_PLAYERS);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.setColorAt(0, LOOK_A);
  scene.add(mesh);
  return mesh;
}

const UP = new THREE.Vector3(0, 1, 0);
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scale = new THREE.Vector3();
const matrix = new THREE.Matrix4();

export interface ShieldSpheres {
  /**
   * Draws every slot's sphere: `avatarSnap` the avatar snapshot, `poses[p]` the
   * slot's interpolated pose (x, sim y, height, found, hover, yaw).
   */
  update(avatarSnap: Float32Array, poses: readonly Float32Array[]): void;
}

export function createShieldSpheres(scene: THREE.Scene): ShieldSpheres {
  const half = sphereMesh(scene, true);
  const whole = sphereMesh(scene, false);
  return {
    update(avatarSnap, poses) {
      let nh = 0;
      let nw = 0;
      for (let p = 0; p < MAX_PLAYERS; p++) {
        const o = p * AVATAR_SNAP_STRIDE;
        const r = avatarSnap[o + AVATAR_SNAP_SHIELD_RADIUS];
        const pose = poses[p];
        if (avatarSnap[o + AVATAR_SNAP_ID] < 0 || !(r > 0) || !pose || pose[3] === 0) continue;
        const flags = avatarSnap[o + AVATAR_SNAP_SHIELD_FLAGS];
        const isWhole = (flags & SHIELD_SNAP_WHOLE) !== 0;
        const flash = (flags & SHIELD_SNAP_FLASH) !== 0;
        pos.set(pose[0], pose[2] + SHIELD_CENTRE_RAISE, pose[1]);
        quat.setFromAxisAngle(UP, -pose[5]);
        scale.set(r, r, r);
        matrix.compose(pos, quat, scale);
        const mesh = isWhole ? whole : half;
        const slot = isWhole ? nw++ : nh++;
        mesh.setMatrixAt(slot, matrix);
        mesh.setColorAt(slot, isWhole ? (flash ? FLASH_B : LOOK_B) : flash ? FLASH_A : LOOK_A);
      }
      half.count = nh;
      whole.count = nw;
      half.instanceMatrix.needsUpdate = true;
      whole.instanceMatrix.needsUpdate = true;
      if (half.instanceColor) half.instanceColor.needsUpdate = true;
      if (whole.instanceColor) whole.instanceColor.needsUpdate = true;
    },
  };
}
