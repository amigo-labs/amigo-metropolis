// Orbit-follow camera rig (docs/specs/camera.spec.md).
//
// 100% client-local render state (spec §2): the rig never reads or writes sim
// state, is never serialized, and touches no RNG/tick/ordering — two clients
// with wildly different zoom/pan produce byte-identical simulations. This module
// therefore imports NEITHER `@metropolis/sim` NOR three: it is pure math over
// plain {x,y,z} in RENDER space (x = east, y = up, z = south, matching three),
// so the renderer can apply the derived pose straight onto a PerspectiveCamera.
//
// Framerate stability (spec §4.1, §10): all damping is exponential smoothing
// with factor `1 - exp(-dt/tau)`. Because `exp` composes
// (e^(-a/τ)·e^(-b/τ) = e^(-(a+b)/τ)), reaching a constant target over a fixed
// wall-clock span is EXACT regardless of how the span is subdivided — 30, 60 or
// 144 fps converge to the same value (to floating point). `exp` is a
// transcendental, which is banned in the sim, but this is render code where it
// is allowed (CLAUDE.md determinism rules scope to packages/sim only).
//
// Zero allocations in the frame loop (CLAUDE.md renderer rules): `updateCamera`
// and `deriveCameraPose` mutate caller-owned objects in place and never allocate.
// The spec's §6 reference types mark fields `readonly`; the live state is mutated
// here for the zero-alloc rule, so the mutable fields below are a deliberate,
// documented deviation from that reference shape.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Anchor of one view end; ACTION = t0 (low, near), TACTICAL = t1 (high, far). */
export interface ViewAnchor {
  readonly pitchDeg: number; // elevation above the horizon
  readonly distance: number; // world-meters dolly
  readonly fovDeg: number;
}

export interface CameraRigConfig {
  readonly action: ViewAnchor; // t = 0
  readonly tactical: ViewAnchor; // t = 1
  readonly focusHeight: number; // raise of the focus above the ground
  readonly yawLocked: boolean; // default true (north-up / world-fixed)
  readonly followSmoothTime: number; // s, time constant for the focus spring
  readonly paramSmoothTime: number; // s, for t (→ pitch/distance/fov)
  readonly yawSmoothTime: number; // s
  readonly lookAheadMax: number; // world-meters at top speed
  readonly tFreeLookThreshold: number; // edge-pan allowed from this t upward
  readonly transformBias: number; // ± on the resting t per mode
  readonly deadzone: number; // world-meters
}

/**
 * Live rig state, mutated in place per frame (zero-alloc). `t`/`yaw` chase the
 * `*Target` fields (spec §4.1); `focus` chases the interpolated unit point plus
 * look-ahead and (tactical-only) free-look `panOffset`.
 */
export interface CameraState {
  focus: Vec3; // damped focus (render space)
  t: number; // current view value [0,1]
  tTarget: number; // player-chosen resting view value [0,1] (spec §4.1)
  yaw: number; // current azimuth (rad)
  yawTarget: number; // damped-toward azimuth (rad)
  panOffset: Vec3; // free-look offset from the unit (tactical only)
}

/** Per-frame render input. Reused/mutated by the caller — not reallocated. */
export interface CameraInput {
  zoomDelta: number; // wheel/pinch → shifts tTarget
  yawDelta: number; // manual rotation, honoured only when !yawLocked
  panDelta: Vec3; // edge/drag pan (tactical only)
  recenter: boolean; // snaps panOffset → 0
  snapTarget: number | null; // optional tTarget snap [0,1]
}

// Default rig parameters (spec §7). Starting values, tuned in playtest.
export const DEFAULT_RIG_CONFIG: CameraRigConfig = {
  action: { pitchDeg: 30, distance: 14, fovDeg: 55 },
  tactical: { pitchDeg: 62, distance: 34, fovDeg: 50 },
  focusHeight: 1.0,
  yawLocked: true,
  followSmoothTime: 0.12,
  paramSmoothTime: 0.18,
  yawSmoothTime: 0.15,
  lookAheadMax: 4.0,
  tFreeLookThreshold: 0.7,
  transformBias: 0.15,
  deadzone: 0.15,
};

// Speed (world u/s) at which look-ahead saturates to `lookAheadMax`. Tied to the
// avatar hover top speed (balance.AVATAR_HOVER_SPEED = 9) but inlined so this
// module keeps its no-sim-import boundary.
const LOOKAHEAD_REF_SPEED = 9;

const DEG2RAD = Math.PI / 180;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Hermite smoothstep on [0,1] — the spec's recommended (§11) soft t-curve. */
export function smoothstep(x: number): number {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
}

/**
 * Framerate-stable exponential approach: the fraction of the remaining gap to
 * close this frame. `tau` is the time constant (s); `tau <= 0` snaps instantly.
 */
export function smoothFactor(tau: number, dt: number): number {
  if (tau <= 0) return 1;
  return 1 - Math.exp(-dt / tau);
}

function damp(current: number, target: number, tau: number, dt: number): number {
  return current + (target - current) * smoothFactor(tau, dt);
}

/**
 * Advances the rig one render frame. Mutates and returns `state` (zero-alloc).
 *
 * @param followTargetInterpolated INTERPOLATED unit point (render space) — never
 *        raw sim position (spec §2 cadence). Pass the ground point; the rig
 *        raises the focus by `cfg.focusHeight`.
 * @param followVelocity render-space velocity of the unit (world u/s), for
 *        look-ahead. Only x/z matter; y is ignored.
 * @param isPursuitMode true = hover/pursuit (bias toward TACTICAL), false =
 *        walker (bias toward ACTION). A resting-point bias only; player zoom wins.
 */
export function updateCamera(
  state: CameraState,
  input: CameraInput,
  followTargetInterpolated: Vec3,
  followVelocity: Vec3,
  isPursuitMode: boolean,
  cfg: CameraRigConfig,
  dt: number,
): CameraState {
  // --- View continuum t -----------------------------------------------------
  if (input.snapTarget !== null) state.tTarget = clamp01(input.snapTarget);
  else state.tTarget = clamp01(state.tTarget + input.zoomDelta);
  // Transform bias shifts only the resting point; the player's tTarget still
  // wins because the bias is a fixed ± offset, not an override (spec §4.3).
  const bias = isPursuitMode ? cfg.transformBias : -cfg.transformBias;
  const tEff = clamp01(state.tTarget + bias);
  state.t = damp(state.t, tEff, cfg.paramSmoothTime, dt);

  // --- Yaw -------------------------------------------------------------------
  // World-fixed by default (spec §3): manual rotation is honoured only when the
  // rig is explicitly unlocked, and is NEVER coupled to movement.
  if (!cfg.yawLocked) state.yawTarget += input.yawDelta;
  state.yaw = damp(state.yaw, state.yawTarget, cfg.yawSmoothTime, dt);

  // --- Free-look pan (tactical only, spec §4.4) ------------------------------
  // Above the threshold the focus may decouple from the unit (edge-pan/drag);
  // below it, and on recenter, the offset damps back to zero (hard on the unit).
  const freeLook = !input.recenter && state.t >= cfg.tFreeLookThreshold;
  if (freeLook) {
    state.panOffset.x += input.panDelta.x;
    state.panOffset.y += input.panDelta.y;
    state.panOffset.z += input.panDelta.z;
  } else {
    const k = smoothFactor(cfg.followSmoothTime, dt);
    state.panOffset.x -= state.panOffset.x * k;
    state.panOffset.y -= state.panOffset.y * k;
    state.panOffset.z -= state.panOffset.z * k;
  }

  // --- Look-ahead ------------------------------------------------------------
  // Offset toward the unit velocity, saturating to lookAheadMax at top speed —
  // gives more visibility in the direction of travel (spec §4.2).
  const vx = followVelocity.x;
  const vz = followVelocity.z;
  const speed = Math.sqrt(vx * vx + vz * vz);
  let aheadX = 0;
  let aheadZ = 0;
  if (speed > 1e-4) {
    const mag = cfg.lookAheadMax * clamp01(speed / LOOKAHEAD_REF_SPEED);
    aheadX = (vx / speed) * mag;
    aheadZ = (vz / speed) * mag;
  }

  // --- Focus follow (critically-damped-ish exponential spring) ---------------
  const desiredX = followTargetInterpolated.x + aheadX + state.panOffset.x;
  const desiredY = followTargetInterpolated.y + cfg.focusHeight + state.panOffset.y;
  const desiredZ = followTargetInterpolated.z + aheadZ + state.panOffset.z;
  // Deadzone: ignore sub-`deadzone` drift so a standing unit doesn't jitter.
  const ddx = desiredX - state.focus.x;
  const ddy = desiredY - state.focus.y;
  const ddz = desiredZ - state.focus.z;
  if (ddx * ddx + ddy * ddy + ddz * ddz > cfg.deadzone * cfg.deadzone) {
    const k = smoothFactor(cfg.followSmoothTime, dt);
    state.focus.x += ddx * k;
    state.focus.y += ddy * k;
    state.focus.z += ddz * k;
  }
  return state;
}

/**
 * Derives the concrete camera pose from `state` + `cfg`, writing the eye and
 * look-at target into the caller-owned vectors and returning the field-of-view
 * (degrees). Pure and allocation-free.
 *
 * The rig orbits `focus` at elevation `pitch` above the horizon, `distance`
 * behind the ground-forward `(cos yaw, 0, sin yaw)`. pitch/distance/fov are
 * pulled together from `t` via smoothstep so one control gives coherent framing.
 */
export function deriveCameraPose(
  state: CameraState,
  cfg: CameraRigConfig,
  outEye: Vec3,
  outTarget: Vec3,
): number {
  const s = smoothstep(state.t);
  const pitch = (cfg.action.pitchDeg + (cfg.tactical.pitchDeg - cfg.action.pitchDeg) * s) * DEG2RAD;
  const distance = cfg.action.distance + (cfg.tactical.distance - cfg.action.distance) * s;
  const fov = cfg.action.fovDeg + (cfg.tactical.fovDeg - cfg.action.fovDeg) * s;

  const cosYaw = Math.cos(state.yaw);
  const sinYaw = Math.sin(state.yaw);
  const ground = distance * Math.cos(pitch); // horizontal run behind the focus
  const rise = distance * Math.sin(pitch); // vertical lift above the focus

  outTarget.x = state.focus.x;
  outTarget.y = state.focus.y;
  outTarget.z = state.focus.z;
  outEye.x = state.focus.x - cosYaw * ground;
  outEye.y = state.focus.y + rise;
  outEye.z = state.focus.z - sinYaw * ground;
  return fov;
}

/** Fresh rig state focused on `focus` (render space), oriented at `yaw` (rad). */
export function createCameraState(focus: Vec3, yaw: number): CameraState {
  return {
    focus: { x: focus.x, y: focus.y, z: focus.z },
    t: 0,
    tTarget: 0,
    yaw,
    yawTarget: yaw,
    panOffset: { x: 0, y: 0, z: 0 },
  };
}
