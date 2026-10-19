// The original's chase cameras (render/camera.ts) against the RE's own numbers:
// camera.json's pitch curve table and the converged eye of each camera for a
// walker standing at height 0 and facing yaw 0.

import { describe, expect, test } from "bun:test";
import {
  CAMERA_COUNT,
  CAMERA_VFOV_DEG,
  type ChaseCamera,
  type ChasePose,
  type ChaseSubject,
  type ChaseTrace,
  cameraInPa,
  cameraName,
  createChaseCamera,
  createChasePose,
  ENGINE_HZ,
  foldAngle,
  gateCrowdControl,
  pitchCurve,
  pressCameraKey,
  stepChaseCamera,
  turnToward,
  WU_PER_M,
} from "../src/render/camera";
import { CAMERA_CAPTION, CAMERA_STEADY_EYES } from "../src/render/fcopPresentation.generated";

function subject(over: Partial<ChaseSubject> = {}): ChaseSubject {
  return { x: 0, y: 0, height: 0, facing: 0, hover: false, ...over };
}

/** Runs the camera for `seconds` at `fps`; returns the last pose. */
function run(
  cam: ChaseCamera,
  subj: ChaseSubject,
  seconds: number,
  fps = 60,
  trace: ChaseTrace | null = null,
): ChasePose {
  const pose = createChasePose();
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) stepChaseCamera(cam, subj, ENGINE_HZ / fps, trace, 0.5, pose);
  return pose;
}

/** The eye in the RE's runtime frame (position[0], [1], [2]), world units. */
function runtimeEye(p: ChasePose): [number, number, number] {
  return [p.eyeZ * WU_PER_M, p.eyeY * WU_PER_M, p.eyeX * WU_PER_M];
}

describe("pitch curve (view_pitch_curve 0x00445f60)", () => {
  // camera.json pitch_curve.table.
  const table: [number, number][] = [
    [255, 36864],
    [330, 55296],
    [430, 95344],
    [512, 122754],
    [530, 128114],
    [768, 176814],
    [930, 186368],
  ];
  for (const [pitch, height] of table) {
    test(`pitch ${pitch} -> ${height} wu`, () => {
      expect(Math.abs(pitchCurve(pitch) - height)).toBeLessThan(4);
    });
  }
});

describe("steady-state eyes (camera.json steady_state_walker_subject_y0)", () => {
  for (let name = 0; name < CAMERA_COUNT; name++) {
    test(`${name}: ${cameraName({ ...createChaseCamera(), name })}`, () => {
      const cam = createChaseCamera();
      cam.name = name; // no gate: Crowd Control's steady state is defined too
      const eye = runtimeEye(run(cam, subject(), 6));
      const want = CAMERA_STEADY_EYES[name].eye;
      // The RE's numbers are floating point over the game's integers.
      for (let i = 0; i < 3; i++) expect(Math.abs(eye[i] - want[i])).toBeLessThan(8);
    });
  }

  test("Standard: 6.75 m up, 8.57 m behind, pitched 29.0 degrees", () => {
    const pose = run(createChaseCamera(), subject({ x: 100, y: 50, facing: Math.PI / 2 }), 6);
    // Facing +y (three +z): the eye sits behind at -y.
    expect(pose.eyeX).toBeCloseTo(100, 2);
    expect(pose.eyeY).toBeCloseTo(6.75, 2);
    expect(pose.eyeZ).toBeCloseTo(50 - 70188 / WU_PER_M, 2);
    expect((pose.pitch * 180) / Math.PI).toBeCloseTo(29.0039, 2);
  });

  test("the plane rises by half the subject's height", () => {
    const pose = run(createChaseCamera(), subject({ height: 4 }), 8);
    expect(pose.eyeY).toBeCloseTo(6.75 + 2, 1);
  });

  test("the hover's sink lowers the aim point by 5376 wu", () => {
    const walker = runtimeEye(run(createChaseCamera(), subject(), 6));
    const hover = runtimeEye(run(createChaseCamera(), subject({ hover: true }), 6));
    // Same plane; the pull-back grows by cot(pitch) x the lowered aim point.
    expect(hover[1]).toBeCloseTo(walker[1], 3);
    const cot = 1 / Math.tan((330 * 2 * Math.PI) / 4096);
    expect(walker[2] - hover[2]).toBeCloseTo(cot * 5376, 0);
  });

  test("the vertical field of view is the original's 26.38 degrees", () => {
    expect(CAMERA_VFOV_DEG).toBeCloseTo(2 * Math.atan(15 / 64) * (180 / Math.PI), 2);
  });
});

describe("the Camera Key", () => {
  test("cycles five cameras in Precinct Assault: Crowd Control drops to Standard", () => {
    const cam = createChaseCamera();
    const seen: string[] = [cameraName(cam)];
    for (let i = 0; i < 6; i++) {
      pressCameraKey(cam, false);
      gateCrowdControl(cam, false); // no PA arena has a volume trigger
      seen.push(cameraName(cam));
    }
    expect(seen).toEqual([
      "Standard Camera",
      "Close-Up Camera",
      "Standard Side Camera",
      "Close-Up Side Camera",
      "Sky Camera",
      "Standard Camera",
      "Close-Up Camera",
    ]);
    for (let n = 0; n < CAMERA_COUNT; n++) expect(cameraInPa(n)).toBe(n < 5);
  });

  test("inside a volume trigger the key reaches both Crowd Control cameras", () => {
    const cam = createChaseCamera();
    for (let i = 0; i < 6; i++) {
      pressCameraKey(cam, false);
      gateCrowdControl(cam, true);
    }
    expect(cameraName(cam)).toBe("Crowd Control Side Camera");
    pressCameraKey(cam, false);
    expect(cam.name).toBe(0); // 7 wraps to 0
  });

  test("a press arms the caption for 900 ticks; it counts down; paused, nothing", () => {
    const cam = createChaseCamera();
    expect(cam.caption).toBe(CAMERA_CAPTION.ticks); // armed at construct
    run(cam, subject(), 3.1);
    expect(cam.caption).toBeLessThanOrEqual(0);
    pressCameraKey(cam, true);
    expect(cam.name).toBe(0);
    expect(cam.caption).toBeLessThanOrEqual(0);
    pressCameraKey(cam, false);
    expect(cam.name).toBe(1);
    expect(cam.caption).toBe(900);
    run(cam, subject(), 1);
    expect(cam.caption).toBeCloseTo(600, 6);
  });
});

describe("follow (view_turn_toward, rate caps)", () => {
  test("the turn takes the short way round", () => {
    expect(foldAngle(turnToward(2000, -2000, 1))).toBeGreaterThan(2000);
    expect(foldAngle(turnToward(-2000, 2000, 1))).toBeLessThan(-2000);
  });

  test("time constant ~63 ticks: (31/32)^(ticks/2)", () => {
    // One 1000-unit gap, no cap in the way: half a step per tick.
    const after = turnToward(0, 1000, 63 / 2);
    expect(1000 - after).toBeCloseTo(1000 * (31 / 32) ** 31.5, 6);
  });

  test("yaw never moves more than 4 units a tick, pitch 2", () => {
    const cam = createChaseCamera();
    run(cam, subject(), 4);
    const before = cam.yaw;
    const pose = createChasePose();
    stepChaseCamera(cam, subject({ facing: Math.PI }), 10, null, 0.5, pose);
    expect(Math.abs(foldAngle(cam.yaw - before))).toBeCloseTo(40, 6);
    pressCameraKey(cam, false);
    pressCameraKey(cam, false);
    pressCameraKey(cam, false);
    pressCameraKey(cam, false); // Sky: pitch 330 -> 430
    // A 100-unit gap: the 1/32 follow wants 14.7 in 10 ticks, under the cap.
    const p0 = cam.pitch;
    stepChaseCamera(cam, subject({ facing: Math.PI }), 10, null, 0.5, pose);
    expect(cam.pitch - p0).toBeCloseTo(100 * (1 - (31 / 32) ** 5), 6);
    // Standard's last fallback, preset 2 (930), from 330: the follow wants
    // more than 20 in 10 ticks, the cap gives 20.
    const std = createChaseCamera();
    run(std, subject(), 2);
    std.live = 3;
    expect(turnToward(std.pitch, 930, 5) - std.pitch).toBeGreaterThan(20);
    const before330 = std.pitch;
    stepChaseCamera(std, subject(), 10, null, 0.5, pose);
    expect(std.pitch - before330).toBeCloseTo(20, 6);
  });

  test("frame-rate stable: 30, 60 and 144 fps arrive at the same camera", () => {
    const final = [30, 60, 144].map((fps) => {
      const cam = createChaseCamera();
      run(cam, subject(), 2, fps);
      pressCameraKey(cam, false); // Close-Up: retract and offset walk
      const pose = run(cam, subject({ facing: 1.2, height: 2 }), 1.5, fps);
      return [pose.eyeX, pose.eyeY, pose.eyeZ, cam.yaw, cam.retract];
    });
    for (let i = 0; i < final[0].length; i++) {
      expect(Math.abs(final[1][i] - final[0][i])).toBeLessThan(0.05);
      expect(Math.abs(final[2][i] - final[0][i])).toBeLessThan(0.05);
    }
  });
});

describe("the height follower (view_track_height)", () => {
  test("a small bump is ignored, a storey is followed", () => {
    const cam = createChaseCamera();
    run(cam, subject(), 2);
    const bump = run(cam, subject({ height: 0.05 }), 2);
    expect(bump.eyeY).toBeCloseTo(6.75, 3);
    const storey = run(cam, subject({ height: 4 }), 6);
    expect(storey.eyeY).toBeCloseTo(6.75 + 2, 1);
  });
});

describe("the occlusion machine", () => {
  // A wall at x (three) < -5 blocks: the Standard eye (8.6 m behind at -x when
  // facing +x) is behind it; preset 1 (46.6 degrees, 15.6 m plane) is not.
  const facingX = subject({ facing: 0 });
  const wall: ChaseTrace = (_ax, _ay, _az, ex, ey) => ex < -5 && ey < 12;

  test("after 120 blocked ticks the first fallback goes live", () => {
    const cam = createChaseCamera();
    run(cam, facingX, 0.39, 300, wall);
    expect(cam.live).toBe(1);
    run(cam, facingX, 0.02, 300, wall);
    expect(cam.live).toBe(2);
    const pose = run(cam, facingX, 4, 60, wall);
    expect((pose.pitch * 4096) / (2 * Math.PI)).toBeCloseTo(530, 0);
  });

  test("once the primary is clear again it comes back", () => {
    const cam = createChaseCamera();
    run(cam, facingX, 1, 60, wall);
    expect(cam.live).toBe(2);
    run(cam, facingX, 0.5, 60, () => false);
    expect(cam.live).toBe(1);
  });
});
