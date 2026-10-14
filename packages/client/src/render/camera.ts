// The original's chase cameras (docs/specs/camera.spec.md; RE camera.json,
// src/game/frame/view_place.c `view_player_camera_tick` 0x004456a0).
//
// Seven cameras the Camera Key cycles — Standard, Close-Up, Standard Side,
// Close-Up Side, Sky, Crowd Control and Crowd Control Side — each a camera
// entry: a flag word (close, side, occlude, closer) and a list of presets, the
// primary first and the fallbacks the occlusion machine probes after it. A
// preset is a pitch, a yaw delta and an offset; the plane the eye sits on comes
// from the pitch curve. The frame turns the camera toward the live preset by a
// 1/32 geometric follow with rate caps, walks the smoothed offset toward the
// preset's, lets the retract grow or shrink, follows the subject's height with a
// cubic spring, and places the eye with `view_chase_position`.
//
// Units are the original's throughout: world units (8192 to a terrain sample,
// one Metropolis metre), angles in 4096 to the turn, time in its 300 Hz ticks.
// The engine runs this once a frame with an integer `dt` of at least 8 ticks;
// here it runs once a render frame with the frame's real ticks, so every rule is
// written as its continuous equivalent (a 1/32 step per two ticks composes to
// (31/32)^(ticks/2) however the time is cut). Floating point stands in for the
// game's 16.16 integers: the steady states agree to a few world units.
//
// Axes: the original's runtime frame is (position[0], position[1] up,
// position[2]); a yaw a looks along (sin a, 0, cos a). Metropolis' map frame
// has x = position[2] and y = position[0], so a Metropolis yaw θ = a·2π/4096
// looks along (cos θ, sin θ) in (x, y) — the sim's own convention — and three's
// (x, y, z) is (position[2], position[1], position[0]).
//
// Client-local render state (camera.spec §2): nothing here reads or writes the
// sim, and nothing allocates per frame (CLAUDE.md renderer rule 1).

import {
  CAMERA_CAPTION,
  CAMERA_IN_PA,
  CAMERA_NAMES,
  CAMERA_PROJECTION,
  CHASE_ENTRIES,
  CHASE_LISTS,
  CHASE_PRESETS,
  type ChasePreset,
} from "./fcopPresentation.generated";

/** World units to a terrain sample, one Metropolis metre. */
export const WU_PER_M = 8192;
/** The engine's clock. */
export const ENGINE_HZ = 300;
/** A full turn in the original's angle units. */
export const TURN = 4096;
/** The cameras the Camera Key cycles (camera_name 0..6; 7 wraps to 0). */
export const CAMERA_COUNT = 7;

/**
 * The original's vertical field of view: its software projection has a focal of
 * 1024 px at 640 x 480 (x' = x·4096/z into a 2560-wide raw screen), so
 * tan(v/2) = 240/1024 = 15/64. Metropolis keeps the VERTICAL angle on every
 * aspect ratio (three's `fov` is vertical): a 4:3 window sees exactly the
 * original's 34.7° x 26.4°, a wider one more to the sides, never less height.
 */
export const CAMERA_VFOV_DEG = CAMERA_PROJECTION.vfovDeg;

/** Flag bits of a camera entry (view_place.h VIEW_CAMERA_FLAG_*). */
export const FLAG_CLOSE = 1;
export const FLAG_SIDE = 2;
export const FLAG_OCCLUDE = 4;
export const FLAG_CLOSER = 8;

/** Retract caps: 0x100 under the close bit, 0x12c under the closer bit (view_place.c:1039). */
const RETRACT_CLOSE = 0x100;
const RETRACT_CLOSER = 0x12c;
/** The side cameras' fixed world yaw, whatever the mech faces (view_place.c:1061). */
const SIDE_YAW = -0x400;
/** Ticks a live camera may stay blocked before the machine probes (0x78, view_place.c:1086). */
const BLOCKED_LIMIT = 0x78;
/** The smoothed offset's reach a tick: `5·dt << 8 >> 4` = 80·dt (view_place.c:1187). */
const OFFSET_RATE = 80;
/** Pitch may move 2 units a tick, yaw 4 (`dt << 9 >> 8`, `dt << 10 >> 8`, view_place.c:1156/1182). */
const PITCH_RATE = 2;
const YAW_RATE = 4;
/** The sink (transform progress) ramps 160 a tick toward 0 (walker) or 0x10000 (hover). */
const SINK_RAMP = 160;
const SINK_HOVER = 0x10000;
/** view_trace pulls an eye above 4 m toward an anchor below it (VIEW_TRACE_Y_LIMIT). */
const TRACE_Y_LIMIT = 0x8000;
/**
 * The height follower drops a step under 256 wu a FRAME (view_place.c:796). The
 * engine's frame is at least 8 ticks, so at its full rate that is a speed under
 * 32 wu a tick; the rule is held at that speed so it does not tighten as the
 * render rate rises.
 */
const HEIGHT_DEAD_ZONE_PER_TICK = 256 / 8;
/** The engine clamps a frame to 0x3c ticks (frame.h); a long render frame is too. */
const MAX_FRAME_TICKS = 0x3c;

const UNIT_RAD = (Math.PI * 2) / TURN;

/** Live camera state, one per view, mutated in place. */
export interface ChaseCamera {
  /** camera_name, 0..6: the entry the Camera Key picked. */
  name: number;
  /** Ticks the name caption has left (900 on a press and at construct). */
  caption: number;
  /** chase_retract: grows toward the entry's cap under close/closer, else shrinks. */
  retract: number;
  /** The smoothed offset word_b0, runtime frame, world units. */
  readonly offset: Float64Array;
  /** The camera's turned yaw and pitch, 4096 a turn (pitch positive looks down). */
  yaw: number;
  pitch: number;
  /** The height follower's surface y and rate (view_track_height). */
  surfaceY: number;
  heightRate: number;
  /** chase_sink: the transform's progress, 0 walker .. 0x10000 hover. */
  sink: number;
  /** chase_live: the list index of the camera in use (1 = the primary). */
  live: number;
  /** chase_dirty: the list index the machine probes next. */
  probe: number;
  /** chase_caption: ticks the live camera has been blocked. */
  blocked: number;
  /** False until the first frame seats the camera on its subject. */
  seated: boolean;
}

/** The subject a frame places the camera on: the INTERPOLATED avatar pose. */
export interface ChaseSubject {
  /** Map frame, metres (sim x, sim y, height). */
  x: number;
  y: number;
  height: number;
  /** The hull's heading, radians, sim convention. */
  facing: number;
  /** Hover form (the sink's target). */
  hover: boolean;
}

/** A frame's result, in three's frame: the eye (m) and the view angles (rad). */
export interface ChasePose {
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  /** Heading of the view axis, sim convention: looks along (cos, ·, sin) in three (x, z). */
  yaw: number;
  /** Down-tilt of the view axis, radians (positive looks down). */
  pitch: number;
}

/**
 * Whether the segment from the anchor to the eye is blocked, both in three's
 * frame and metres. `view_trace` with the original's terrain test.
 */
export type ChaseTrace = (
  ax: number,
  ay: number,
  az: number,
  ex: number,
  ey: number,
  ez: number,
) => boolean;

export function createChaseCamera(): ChaseCamera {
  const primary = CHASE_PRESETS[CHASE_LISTS[CHASE_ENTRIES[0].listRow][1]];
  return {
    name: 0,
    // The caption is armed at construct as well as on a press (draw.c:1396).
    caption: CAMERA_CAPTION.ticks,
    retract: 0,
    offset: Float64Array.of(primary.offset[0], primary.offset[1], primary.offset[2]),
    yaw: 0,
    pitch: primary.pitch,
    surfaceY: 0,
    heightRate: 0,
    sink: 0,
    live: 1,
    probe: 1,
    blocked: 0,
    seated: false,
  };
}

/** The caption's text for a camera. */
export function cameraName(cam: ChaseCamera): string {
  return CAMERA_NAMES[cam.name] ?? "";
}

/**
 * The Camera Key's press (view_place.c:932). Ignored while the view is paused
 * (the map screen); otherwise the next camera, its machine reset and its caption
 * armed for 900 ticks.
 */
export function pressCameraKey(cam: ChaseCamera, paused: boolean): void {
  if (paused) return;
  cam.name = (cam.name + 1) % CAMERA_COUNT;
  cam.probe = 1;
  cam.live = 1;
  cam.blocked = 0;
  cam.caption = CAMERA_CAPTION.ticks;
}

/**
 * The Crowd Control gate (view_place.c:948): cameras 5 and 6 hold only inside a
 * type-95 trigger with the volume bit (TRIGGER_FLAG_VOLUME); anywhere else the
 * name drops to 0 in the same frame, so the caption reads "Standard Camera". No
 * Precinct Assault arena has such a trigger, so there the key cycles 0..4.
 */
export function gateCrowdControl(cam: ChaseCamera, insideVolume: boolean): void {
  if ((cam.name === 5 || cam.name === 6) && !insideVolume) cam.name = 0;
}

/** Whether a camera name can be reached in Precinct Assault (camera.json available_in_pa). */
export function cameraInPa(name: number): boolean {
  return CAMERA_IN_PA[name] === true;
}

/**
 * view_pitch_curve (0x00445f60): the plane height for a pitch, world units.
 * 0xd800 at the reference pitch 0x14a, clamped at 0x9000 from below.
 */
export function pitchCurve(pitch: number): number {
  const c = 1 + (0x14a - pitch) / 600;
  const r = 2 * (1 - c * c) * 0x10000 + 0xd800;
  return r < 0x9000 ? 0x9000 : r;
}

/** Folds an angle into -0x800 .. 0x7ff (4096 a turn). */
export function foldAngle(a: number): number {
  let v = a % TURN;
  if (v < 0) v += TURN;
  return v >= TURN / 2 ? v - TURN : v;
}

/**
 * view_turn_toward (0x00445eb0), continuous: `steps` steps of the 1/32 follow,
 * the short way round, never by less than the original's linear guarantee of a
 * unit a step (its integer step rounds to nothing under a 32-unit gap, and it
 * then takes min(steps, |gap|) instead). Returns the turned angle, unfolded so
 * it sits within half a turn of `from`.
 */
export function turnToward(from: number, to: number, steps: number): number {
  let a = foldAngle(from);
  const b = foldAngle(to);
  if (Math.abs(b - a) >= TURN / 2) a += b > a ? TURN : -TURN;
  const gap = b - a;
  if (gap === 0 || steps <= 0) return a;
  const geometric = gap * (1 - (31 / 32) ** steps);
  const linear = Math.min(steps, Math.abs(gap));
  return Math.abs(geometric) >= linear ? a + geometric : a + Math.sign(gap) * linear;
}

/** Moves `value` toward `target` by at most `limit` (view_place.c `approach`). */
function approach(value: number, target: number, limit: number): number {
  if (target - value > limit) return value + limit;
  if (value - target > limit) return value - limit;
  return target;
}

/**
 * view_chase_position (0x00445440), into `out` = (position[0], position[1],
 * position[2]): the offset scaled by the retract and turned by the base yaw, the
 * aim point raised by the anchor's height less the sink's 21/256, the plane at
 * the curve's height plus HALF the anchor's height, and the eye pulled back from
 * the aim point along the aim yaw by |cot(pitch)| x the drop to it.
 */
export function chasePosition(
  p0: number,
  p1: number,
  p2: number,
  yaw: number,
  aimYaw: number,
  pitch: number,
  height: number,
  offset: ArrayLike<number>,
  retract: number,
  sink: number,
  out: Float64Array,
): void {
  const scale = (256 - retract / 2) / 256;
  const lx = offset[0] * scale;
  const lz = offset[2] * scale;
  const ly = offset[1] * scale - (sink * 21) / 256 + p1;
  const plane = height + p1 / 2;
  const pr = pitch * UNIT_RAD;
  const range = Math.abs((Math.cos(pr) / Math.sin(pr)) * (plane - ly));
  const yr = yaw * UNIT_RAD;
  const ar = aimYaw * UNIT_RAD;
  const cy = Math.cos(yr);
  const sy = Math.sin(yr);
  out[0] = p0 + lx * cy + lz * sy - range * Math.sin(ar);
  out[1] = plane;
  out[2] = p2 + lz * cy - lx * sy - range * Math.cos(ar);
}

// Frame scratch (renderer rule 1).
const eye = new Float64Array(3);

function presetAt(row: readonly number[], index: number): ChasePreset | null {
  const p = row[index];
  return p === undefined || p < 0 ? null : (CHASE_PRESETS[p] ?? null);
}

/** The eye a preset would take (the occlusion probes read the record's own columns). */
function probeEye(
  cam: ChaseCamera,
  rec: ChasePreset,
  p0: number,
  p1: number,
  p2: number,
  base: number,
): void {
  const aim = base + rec.yawDelta;
  chasePosition(
    p0,
    p1,
    p2,
    base,
    aim,
    rec.pitch,
    rec.height,
    rec.offset,
    cam.retract,
    cam.sink,
    eye,
  );
}

/** Traces the anchor -> eye segment (runtime frame, wu) through `trace`, in metres. */
function traced(
  trace: ChaseTrace,
  a0: number,
  a1: number,
  a2: number,
  e0: number,
  e1: number,
  e2: number,
): boolean {
  // view_trace (0x00445e00): with the anchor below 4 m, an eye whose midpoint is
  // above it is pulled toward the anchor by midpoints first.
  let mx = (e0 + a0) / 2;
  let my = (e1 + a1) / 2;
  let mz = (e2 + a2) / 2;
  if (a1 < TRACE_Y_LIMIT && my > TRACE_Y_LIMIT) {
    do {
      e0 = mx;
      e1 = my;
      e2 = mz;
      mx = (mx + a0) / 2;
      my = (my + a1) / 2;
      mz = (mz + a2) / 2;
    } while (my > TRACE_Y_LIMIT);
  }
  return trace(
    a2 / WU_PER_M,
    a1 / WU_PER_M,
    a0 / WU_PER_M,
    e2 / WU_PER_M,
    e1 / WU_PER_M,
    e0 / WU_PER_M,
  );
}

/**
 * One frame of view_player_camera_tick for `ticks` engine ticks (dt seconds x
 * 300). `anchorHeight` lifts the occlusion anchor above the subject's feet;
 * `trace` is null where nothing can occlude (tests). Writes `out`.
 */
export function stepChaseCamera(
  cam: ChaseCamera,
  subject: ChaseSubject,
  ticks: number,
  trace: ChaseTrace | null,
  anchorHeight: number,
  out: ChasePose,
): void {
  const dt = ticks < 0 ? 0 : ticks > MAX_FRAME_TICKS ? MAX_FRAME_TICKS : ticks;
  const steps = dt / 2; // half_dt: (dt + carry) >> 1
  const p0 = subject.y * WU_PER_M;
  const p1 = subject.height * WU_PER_M;
  const p2 = subject.x * WU_PER_M;
  const facing = subject.facing / UNIT_RAD;

  const entry = CHASE_ENTRIES[cam.name] ?? CHASE_ENTRIES[0];
  const row = CHASE_LISTS[entry.listRow];
  const flags = entry.flags;
  let base = (flags & FLAG_SIDE) !== 0 ? SIDE_YAW : facing;

  if (!cam.seated) {
    const rec = presetAt(row, 1) ?? CHASE_PRESETS[0];
    cam.yaw = foldAngle(base + rec.yawDelta);
    cam.pitch = rec.pitch;
    cam.offset[0] = rec.offset[0];
    cam.offset[1] = rec.offset[1];
    cam.offset[2] = rec.offset[2];
    cam.surfaceY = p1;
    cam.heightRate = 0;
    cam.sink = subject.hover ? SINK_HOVER : 0;
    cam.seated = true;
  }

  // --- the sink: the transform's progress, ramped toward the form being entered.
  cam.sink = approach(cam.sink, subject.hover ? SINK_HOVER : 0, SINK_RAMP * dt);

  // --- the height follower (view_track_height 0x00445fd0): a cubic spring.
  const delta = p1 - cam.surfaceY;
  if (delta === 0) {
    cam.heightRate = 0;
  } else {
    const accel = (delta * delta * delta) / 2 ** 26;
    if (accel < 0 !== cam.heightRate < 0) cam.heightRate = 0;
    cam.heightRate += accel * steps;
    const speed = cam.heightRate / 16384; // `rate >> 14`, per tick
    let step = Math.abs(speed) < HEIGHT_DEAD_ZONE_PER_TICK ? 0 : speed * dt;
    if (Math.abs(step) > Math.abs(delta)) step = delta;
    cam.surfaceY += step;
  }
  const s1 = cam.surfaceY;

  // --- the retract: toward the entry's cap, or back to 0.
  if ((flags & (FLAG_CLOSE | FLAG_CLOSER)) !== 0) {
    const cap = (flags & FLAG_CLOSE) !== 0 ? RETRACT_CLOSE : RETRACT_CLOSER;
    cam.retract = Math.min(cam.retract + dt, cap);
  } else {
    cam.retract = Math.max(cam.retract - dt, 0);
  }

  // --- the caption counts down while positive.
  if (cam.caption > 0) cam.caption -= dt;

  // --- the occlusion machine (view_place.c:1064-1133), over the entry's list.
  if ((flags & FLAG_OCCLUDE) !== 0 && trace !== null) {
    const a1 = p1 + anchorHeight * WU_PER_M;
    let rec = presetAt(row, cam.live);
    if (rec === null) {
      cam.live = 1;
      rec = presetAt(row, 1) as ChasePreset;
    }
    probeEye(cam, rec, p0, s1, p2, base);
    let blocked = traced(trace, p0, a1, p2, eye[0], eye[1], eye[2]);
    if (!blocked && cam.live === 1) {
      cam.blocked = 0;
    } else {
      cam.blocked += dt;
      if (cam.blocked > BLOCKED_LIMIT) {
        cam.blocked = 0;
        if (cam.live !== 1) {
          // A fallback is live: the primary is tried again first.
          const prim = presetAt(row, 1) as ChasePreset;
          probeEye(cam, prim, p0, s1, p2, base);
          if (!traced(trace, p0, a1, p2, eye[0], eye[1], eye[2])) {
            cam.live = 1;
            cam.probe = 1;
            blocked = false;
          }
        }
        // Still the FIRST trace's answer: a clear fallback whose primary is
        // blocked stays where it is.
        if (blocked) {
          cam.probe += 1;
          if (presetAt(row, cam.probe) === null) cam.probe = 2;
          const next = presetAt(row, cam.probe);
          if (next !== null) {
            probeEye(cam, next, p0, s1, p2, base);
            if (!traced(trace, p0, a1, p2, eye[0], eye[1], eye[2])) cam.live = cam.probe;
            else cam.blocked = BLOCKED_LIMIT;
          }
        }
      }
    }
  }

  // --- the live preset: turn toward it, walk the offset, place the eye.
  const rec = presetAt(row, cam.live) ?? (presetAt(row, 1) as ChasePreset);
  let newYaw = turnToward(cam.yaw, base + rec.yawDelta, steps);
  let newPitch = turnToward(cam.pitch, rec.pitch, steps);
  newPitch = approach(cam.pitch, newPitch, PITCH_RATE * dt);
  newYaw = foldAngle(newYaw);
  cam.yaw = foldAngle(cam.yaw);
  if (Math.abs(cam.yaw - newYaw) >= TURN / 2) newYaw += cam.yaw - newYaw > 0 ? TURN : -TURN;
  newYaw = approach(cam.yaw, newYaw, YAW_RATE * dt);
  cam.yaw = foldAngle(newYaw);
  cam.pitch = newPitch;

  const d0 = rec.offset[0] - cam.offset[0];
  const d1 = rec.offset[1] - cam.offset[1];
  const d2 = rec.offset[2] - cam.offset[2];
  const len = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
  const reach = OFFSET_RATE * dt;
  if (len < reach || len === 0) {
    cam.offset[0] = rec.offset[0];
    cam.offset[1] = rec.offset[1];
    cam.offset[2] = rec.offset[2];
  } else {
    cam.offset[0] += (d0 / len) * reach;
    cam.offset[1] += (d1 / len) * reach;
    cam.offset[2] += (d2 / len) * reach;
  }

  // The plane is the curve of the TURNED pitch, never the record's column.
  base = (flags & FLAG_SIDE) !== 0 ? SIDE_YAW : facing;
  const plane = pitchCurve(cam.pitch);
  chasePosition(
    p0,
    s1,
    p2,
    base,
    cam.yaw,
    cam.pitch,
    plane,
    cam.offset,
    cam.retract,
    cam.sink,
    eye,
  );

  // Pulled in along the camera's forward row by retract << 7 world units.
  const yr = cam.yaw * UNIT_RAD;
  const pr = cam.pitch * UNIT_RAD;
  const pull = cam.retract * 128;
  const cp = Math.cos(pr);
  eye[0] += cp * Math.sin(yr) * pull;
  eye[1] -= Math.sin(pr) * pull;
  eye[2] += cp * Math.cos(yr) * pull;

  out.eyeX = eye[2] / WU_PER_M;
  out.eyeY = eye[1] / WU_PER_M;
  out.eyeZ = eye[0] / WU_PER_M;
  out.yaw = yr;
  out.pitch = pr;
}

/** A fresh pose (boot-time allocation). */
export function createChasePose(): ChasePose {
  return { eyeX: 0, eyeY: 0, eyeZ: 0, yaw: 0, pitch: 0 };
}
