// Camera-relative movement mapping (shared by keyboard and gamepad).
//
// WASD / the left stick are authored in a SCREEN frame: `forward` is "up the
// screen / away from the camera", `strafe` is "to the screen right". The basis
// (fx, fy) is the CAMERA's ground-forward in sim coords (camera.spec §5): the
// camera yaw is world-fixed, so movement is relative to the view, NOT to the
// avatar's aim/facing — that decoupling is the deliberate modernisation vs. the
// original's movement-coupled camera (camera.spec §9). Rotating the screen axes
// by the camera-forward makes "forward" always drive where the camera looks.
//
// When the basis is ~zero (camera not ready) we fall back to world-relative
// axes. Pure + allocation-free (caller owns out).

import type * as THREE from "three";
import { Vector3 } from "three";
import type { Vec2 } from "./gamepadMapping";

export function cameraRelativeMove(
  strafe: number,
  forward: number,
  fx: number,
  fy: number,
  out: Vec2,
): Vec2 {
  const flen2 = fx * fx + fy * fy;
  let wx: number;
  let wy: number;
  if (flen2 < 1e-6) {
    // No facing established yet — keep world-relative axes.
    wx = strafe;
    wy = forward;
  } else {
    const inv = 1 / Math.sqrt(flen2);
    const nx = fx * inv; // facing (forward) unit axis
    const ny = fy * inv;
    // forward → facing axis; strafe → facing rotated 90° CW (screen right).
    wx = forward * nx - strafe * ny;
    wy = forward * ny + strafe * nx;
  }
  // Clamp to unit length so a rotated diagonal survives int8 quantization
  // (mirrors the sim's own move clamp); sub-unit analog magnitude is preserved.
  const l2 = wx * wx + wy * wy;
  if (l2 > 1) {
    const inv = 1 / Math.sqrt(l2);
    wx *= inv;
    wy *= inv;
  }
  out.x = wx;
  out.y = wy;
  return out;
}

// Scratch for the world-direction read; sample()/updateAim() are synchronous and
// non-reentrant within a tick, so a shared module scratch is allocation-free-safe.
const fwd = new Vector3();

/**
 * The camera's ground-forward as a sim-space unit vector (sim x,y = three x,z),
 * i.e. the horizontal projection of the camera's look direction. This is the
 * read-only yaw basis the movement layer consumes (camera.spec §5). Writes into
 * `out`; leaves `out` untouched (keeping the last basis) when the look direction
 * is near-vertical so a degenerate top-down frame never zeroes movement.
 */
export function cameraGroundForward(camera: THREE.Camera, out: Vec2): Vec2 {
  camera.getWorldDirection(fwd);
  const len = Math.sqrt(fwd.x * fwd.x + fwd.z * fwd.z);
  if (len > 1e-6) {
    out.x = fwd.x / len;
    out.y = fwd.z / len;
  }
  return out;
}
