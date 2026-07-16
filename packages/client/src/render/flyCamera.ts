// Free-fly debug camera (?cam=fly) — noclip navigation for inspecting the
// textured map meshes up close (texture variants, tile seams, atmosphere).
//
// 100% client-local render state, exactly like the orbit-follow rig
// (render/camera.ts): no sim imports, never serialized, no RNG/tick coupling —
// a flying debug camera cannot desync anyone. Pure math over the caller's
// PerspectiveCamera; the only three import is for the camera/vector types.
//
// Zero allocations in the frame loop (CLAUDE.md renderer rules): all scratch
// lives at module scope; updateFlyCamera mutates the camera in place.
//
// Controls (browser-standard for noclip debug cams):
//   click canvas  pointer lock (mouse-look; ESC releases)
//   WASD          move on the view plane (W = view forward incl. pitch)
//   Q / E         down / up (world axis)
//   Shift         fast (x4)

import type * as THREE from "three";

export interface FlyState {
  yaw: number; // rad, 0 = -Z, positive turns left
  pitch: number; // rad, clamped to +-MAX_PITCH
  /** Pressed-key state, maintained by the listeners installed in initFlyInput. */
  readonly keys: Set<string>;
  /** Accumulated pointer-lock mouse deltas, drained each frame. */
  lookX: number;
  lookY: number;
}

// Tuning knobs (playtest): base speed in world units/s, fast multiplier,
// radians of look per pixel of mouse movement, pitch clamp.
const FLY_SPEED = 24;
const FLY_FAST = 4;
const LOOK_SENSITIVITY = 0.0022;
const MAX_PITCH = (89 * Math.PI) / 180;

/** Fresh fly state; pose the camera separately (createFlyPose). */
export function createFlyState(): FlyState {
  return { yaw: 0, pitch: 0, keys: new Set(), lookX: 0, lookY: 0 };
}

/**
 * Installs the fly-mode input listeners: pointer lock on canvas click plus a
 * private keydown/keyup pair. Deliberately separate from PlayerOneInput — that
 * class samples SIM input per tick; fly is render-only and must not leak into
 * the input path. Returns a cleanup function (unused today; fly mode lives for
 * the whole page, but the symmetry keeps listener ownership explicit).
 */
export function initFlyInput(state: FlyState, canvas: HTMLCanvasElement): () => void {
  const onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement === canvas) {
      state.lookX += e.movementX;
      state.lookY += e.movementY;
    }
  };
  const onClick = () => {
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    state.keys.add(e.code);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    state.keys.delete(e.code);
  };
  const onBlur = () => state.keys.clear();
  canvas.addEventListener("click", onClick);
  document.addEventListener("mousemove", onMouseMove);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  return () => {
    canvas.removeEventListener("click", onClick);
    document.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}

/** Initial pose: hover over the arena at a readable 3/4 angle toward centre. */
export function poseFlyStart(
  state: FlyState,
  camera: THREE.PerspectiveCamera,
  extent: number,
): void {
  camera.position.set(extent / 2, extent / 3, extent * 0.95);
  state.yaw = 0;
  state.pitch = -0.45;
  applyRotation(state, camera);
}

function applyRotation(state: FlyState, camera: THREE.PerspectiveCamera): void {
  // YXZ order = yaw about world Y first, then pitch — the FPS convention that
  // never rolls. Writing euler angles directly allocates nothing.
  camera.rotation.order = "YXZ";
  camera.rotation.set(state.pitch, state.yaw, 0);
}

/** Advances the fly camera one render frame. Mutates camera in place. */
export function updateFlyCamera(
  state: FlyState,
  camera: THREE.PerspectiveCamera,
  dt: number,
): void {
  // --- Mouse look (drain the accumulated pointer-lock deltas) ---------------
  state.yaw -= state.lookX * LOOK_SENSITIVITY;
  state.pitch -= state.lookY * LOOK_SENSITIVITY;
  if (state.pitch > MAX_PITCH) state.pitch = MAX_PITCH;
  if (state.pitch < -MAX_PITCH) state.pitch = -MAX_PITCH;
  state.lookX = 0;
  state.lookY = 0;
  applyRotation(state, camera);

  // --- Movement --------------------------------------------------------------
  const k = state.keys;
  const fwd = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
  const strafe = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
  const lift = (k.has("KeyE") ? 1 : 0) - (k.has("KeyQ") ? 1 : 0);
  if (fwd === 0 && strafe === 0 && lift === 0) return;

  const speed = FLY_SPEED * (k.has("ShiftLeft") || k.has("ShiftRight") ? FLY_FAST : 1) * dt;
  const cosPitch = Math.cos(state.pitch);
  // View-forward (incl. pitch) and view-right, derived from yaw/pitch — no
  // vector allocations, position mutated component-wise.
  const fx = -Math.sin(state.yaw) * cosPitch;
  const fy = Math.sin(state.pitch);
  const fz = -Math.cos(state.yaw) * cosPitch;
  const rx = Math.cos(state.yaw);
  const rz = -Math.sin(state.yaw);
  camera.position.x += (fx * fwd + rx * strafe) * speed;
  camera.position.y += (fy * fwd + lift) * speed;
  camera.position.z += (fz * fwd + rz * strafe) * speed;
}
