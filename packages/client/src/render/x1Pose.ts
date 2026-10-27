// The X1-Alpha's pose, vertex by vertex, as the bone table holds it
// (x1Rig.generated.ts, `bun run gen:x1`). This is the reference for the vertex
// shader in render/avatarRig.ts, which does the same arithmetic per vertex on
// the GPU; the tests pose the shipped mesh with it and hold it against the
// RE's own assembled walker and hover (tools/generators/test/x1Rig.test.ts).
//
// The assembly is the original's: a legs vertex is its joint's skin matrix of
// the legs frame; everything from X1_COCKPIT_SLOT on -- the cockpit's joints,
// the two guns, the beacon -- is its matrix of the cockpit frame, turned by the
// cockpit's aim (yaw about +y, then pitch about +x, the partner's
// `math_matrix_from_angles(facing + aim_yaw, aim_pitch, roll)`, player.c
// 1676-1680) and set on the cockpit's mount, 3DHS channel 0 of the legs frame.
// Model space throughout: +y up, +z forward, the RE glb's frame.
//
// A normal goes the same way without the translations (poseX1Normal): a
// skeleton turns its 4DNL records through each bone's 3x3 alone and lights
// them against the light in the same space (`cact_model_project`
// 0x004281db..0x00428206, RE docs/formats/objects.md "Face lighting"), which
// is what render/fcopModel.ts' shade then reads.

import { X1_ANIM_WIDTH, X1_COCKPIT_ROW, X1_COCKPIT_SLOT, X1_MOUNT_TEXEL } from "./x1Rig.generated";

/** Texels per matrix in the bone table: its three rows. */
export const X1_TEXELS_PER_MATRIX = 3;

/**
 * Poses one bind-pose vertex of slot `slot`. `table` is the bone table
 * (avatar-x1.anim.bin as floats), `aimYaw` / `aimPitch` radians in model space.
 * Writes (x, y, z) into `out` at `at`.
 */
export function poseX1Vertex(
  table: Float32Array,
  slot: number,
  legsFrame: number,
  cockpitFrame: number,
  aimYaw: number,
  aimPitch: number,
  x: number,
  y: number,
  z: number,
  out: Float32Array,
  at: number,
): void {
  const cockpit = slot >= X1_COCKPIT_SLOT;
  const row = cockpit ? X1_COCKPIT_ROW + cockpitFrame : legsFrame;
  const texel = (cockpit ? slot - X1_COCKPIT_SLOT : slot) * X1_TEXELS_PER_MATRIX;
  const o = (row * X1_ANIM_WIDTH + texel) * 4;
  let px = table[o] * x + table[o + 1] * y + table[o + 2] * z + table[o + 3];
  let py = table[o + 4] * x + table[o + 5] * y + table[o + 6] * z + table[o + 7];
  let pz = table[o + 8] * x + table[o + 9] * y + table[o + 10] * z + table[o + 11];
  if (cockpit) {
    // Pitch about +x, then yaw about +y (column vectors: Ry * Rx * p).
    const cp = Math.cos(aimPitch);
    const sp = Math.sin(aimPitch);
    const y1 = cp * py - sp * pz;
    const z1 = sp * py + cp * pz;
    const cy = Math.cos(aimYaw);
    const sy = Math.sin(aimYaw);
    const x2 = cy * px + sy * z1;
    const z2 = -sy * px + cy * z1;
    const m = (legsFrame * X1_ANIM_WIDTH + X1_MOUNT_TEXEL) * 4;
    px = x2 + table[m];
    py = y1 + table[m + 1];
    pz = z2 + table[m + 2];
  }
  out[at] = px;
  out[at + 1] = py;
  out[at + 2] = pz;
}

/**
 * Turns one bind-pose normal of slot `slot` as poseX1Vertex turns its vertex:
 * the slot's 3x3 of the frame, then for the cockpit's slots the aim's pitch
 * and yaw; no translation, no mount, not renormalised. Writes into `out` at `at`.
 */
export function poseX1Normal(
  table: Float32Array,
  slot: number,
  legsFrame: number,
  cockpitFrame: number,
  aimYaw: number,
  aimPitch: number,
  x: number,
  y: number,
  z: number,
  out: Float32Array,
  at: number,
): void {
  const cockpit = slot >= X1_COCKPIT_SLOT;
  const row = cockpit ? X1_COCKPIT_ROW + cockpitFrame : legsFrame;
  const texel = (cockpit ? slot - X1_COCKPIT_SLOT : slot) * X1_TEXELS_PER_MATRIX;
  const o = (row * X1_ANIM_WIDTH + texel) * 4;
  let nx = table[o] * x + table[o + 1] * y + table[o + 2] * z;
  let ny = table[o + 4] * x + table[o + 5] * y + table[o + 6] * z;
  let nz = table[o + 8] * x + table[o + 9] * y + table[o + 10] * z;
  if (cockpit) {
    const cp = Math.cos(aimPitch);
    const sp = Math.sin(aimPitch);
    const y1 = cp * ny - sp * nz;
    const z1 = sp * ny + cp * nz;
    const cy = Math.cos(aimYaw);
    const sy = Math.sin(aimYaw);
    const x2 = cy * nx + sy * z1;
    nz = -sy * nx + cy * z1;
    nx = x2;
    ny = y1;
  }
  out[at] = nx;
  out[at + 1] = ny;
  out[at + 2] = nz;
}
