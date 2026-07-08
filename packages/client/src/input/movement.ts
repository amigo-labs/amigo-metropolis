// Camera-relative movement mapping (shared by keyboard and gamepad).
//
// WASD / the left stick are authored in a SCREEN frame: `forward` is "up the
// screen / away from the camera", `strafe` is "to the screen right". The chase
// camera sits behind the avatar's facing, so the player's facing vector IS the
// camera's ground-forward. Rotating the screen axes by that facing makes
// "forward" always drive where the camera looks, instead of a fixed world axis.
//
// facing (fx, fy) is the avatar's aim/facing vector in sim coords (need not be
// normalized). When it is ~zero (no aim yet) we fall back to world-relative
// axes, matching the pre-aim behavior. Pure + allocation-free (caller owns out).

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
