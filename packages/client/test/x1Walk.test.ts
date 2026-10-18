// The X1's animation (render/x1Walk.ts): the original's walker state -> leg
// track table, the AnmD player's timing (a frame per `period` of the clock, the
// clock fed the state's rate: 0xa0 or the speed >> 8 over its floor), the
// transform's frames over the ramp, and the codes the legs hand the movement
// loop. A screenshot shows a pose; these pin which pose, and when.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ANIM_AIRBORNE,
  ANIM_HOVER,
  ANIM_MOVING,
  AVATAR_SNAP_ANIM,
  AVATAR_SNAP_BUTTONS,
  AVATAR_SNAP_ID,
  AVATAR_SNAP_LOCK,
  AVATAR_SNAP_VX,
  AVATAR_SNAP_VZ,
  AVATAR_SNAPSHOT_LEN,
  BTN_ACTION,
  BTN_BACK,
  BTN_FORWARD,
  BTN_JINK_LEFT,
  BTN_JINK_RIGHT,
  BTN_JUMP,
  BTN_TURN_LEFT,
  BTN_TURN_RIGHT,
  TICK_DT,
  TRANSFORM_LOCK_TICKS,
  WALKER_HIGH_LIFT,
  WALKER_HOP_LIFT,
  WALKER_LEAP_LIFT,
  X1_GRAVITY,
  X1_SPEED_UNIT,
} from "@metropolis/sim";
import { X1_COCKPIT_TRACKS, X1_LEG_TRACKS } from "../src/render/x1Rig.generated";
import {
  animSetTrack,
  animStep,
  createAnimPlayer,
  createX1Walk,
  legRate,
  RATE_FIXED,
  RATE_LEAP,
  RATE_MIN,
  RATE_RUN,
  tickX1Walk,
  walkerCommand,
  X1_CODES_PER_TICK,
  X1_LOOP_STOP,
  X1_STATE_TRACKS,
  type X1Walk,
} from "../src/render/x1Walk";

const TRACKS_JSON = new URL(
  "../../../tools/generators/units/raw/fcop-x1/tracks.json",
  import.meta.url,
).pathname;
const tracksJson = JSON.parse(readFileSync(TRACKS_JSON, "utf8")) as {
  walker: {
    states: {
      state: number;
      tracks: number[];
      becomes: number | null;
      rate: { fixed?: number; speed_floor?: number };
    }[];
  };
  transform: {
    to_hover: {
      legs_track: number;
      legs_frames: number[];
      cockpit_track: number;
      cockpit_frames: number[];
    };
    progress: { per_tick: number; full: number };
  };
};

/** m/s for a 16.16-a-step speed. */
const mps = (perStep: number) => (perStep / 65536) * X1_SPEED_UNIT;
/** The walk's settled speed on flat ground (push 0xa000 / drag 0.375): rate 426. */
const WALK = mps(0xa000 / 0.375);
const RUN = mps(0x18000 / 0.375);

const snap = new Float32Array(AVATAR_SNAPSHOT_LEN);

function pose(fields: {
  buttons?: number;
  vx?: number;
  vz?: number;
  anim?: number;
  lock?: number;
}) {
  snap.fill(0);
  snap[AVATAR_SNAP_ID] = 7;
  snap[AVATAR_SNAP_BUTTONS] = fields.buttons ?? 0;
  snap[AVATAR_SNAP_VX] = fields.vx ?? 0;
  snap[AVATAR_SNAP_VZ] = fields.vz ?? 0;
  snap[AVATAR_SNAP_ANIM] = fields.anim ?? 0;
  snap[AVATAR_SNAP_LOCK] = fields.lock ?? 0;
  // Slot 1 has no X1.
  snap[9 + AVATAR_SNAP_ID] = -1;
}

function run(w: X1Walk, ticks: number, fields: Parameters<typeof pose>[0], codes?: number[]) {
  for (let t = 0; t < ticks; t++) {
    pose(fields);
    tickX1Walk(w, snap);
    if (codes) for (let k = 0; k < w.codeCount[0]; k++) codes.push(w.codes[k]);
  }
}

describe("the state -> track table", () => {
  test("is the jump table's, as the RE reads it", () => {
    for (const st of tracksJson.walker.states) {
      if (st.state === 0 || st.state === 12) {
        expect(X1_STATE_TRACKS[st.state]).toBe(-1);
        continue;
      }
      expect(`${st.state}:${X1_STATE_TRACKS[st.state]}`).toBe(`${st.state}:${st.tracks[0]}`);
    }
  });

  test("the rate: 0xa0 fixed in seven states, else speed >> 8 over the state's floor", () => {
    for (const st of tracksJson.walker.states) {
      // A launch arm's rate is the state it becomes in the same step (0x10 -> 0x11).
      if (st.rate.fixed !== undefined) {
        expect(legRate(st.becomes ?? st.state, 0, 0)).toBe(st.rate.fixed);
        expect(legRate(st.becomes ?? st.state, 0x40000, 0)).toBe(RATE_FIXED);
      } else {
        expect(legRate(st.becomes ?? st.state, 0, 0)).toBe(st.rate.speed_floor ?? -1);
      }
    }
    expect(legRate(1, 0x1aaaa, 0)).toBe(426); // the walk, settled
    expect(legRate(3, 0x40000, 0)).toBe(1024); // the run
    expect(legRate(7, 0x2aaaa, 0)).toBe(682); // the strafe
    expect(legRate(0x0e, 0, 0)).toBe(RATE_LEAP);
    expect(legRate(2, 0, 0)).toBe(RATE_RUN);
    expect(legRate(5, 0, 0)).toBe(RATE_MIN);
    // Slippery ground (mode 1..3) multiplies by 4 - mode.
    expect(legRate(1, 0x1aaaa, 1)).toBe(426 * 3);
  });

  test("the commands: slow row, fast row, turns; the fast row's jump is the sim's", () => {
    expect(walkerCommand(BTN_ACTION | BTN_FORWARD)).toBe(1);
    expect(walkerCommand(BTN_ACTION | BTN_BACK)).toBe(2);
    expect(walkerCommand(BTN_ACTION | BTN_JUMP)).toBe(9);
    expect(walkerCommand(BTN_ACTION | BTN_JINK_RIGHT)).toBe(6);
    expect(walkerCommand(BTN_ACTION | BTN_JINK_LEFT)).toBe(5);
    expect(walkerCommand(BTN_FORWARD)).toBe(3);
    expect(walkerCommand(BTN_BACK | BTN_JINK_RIGHT)).toBe(4);
    expect(walkerCommand(BTN_JINK_RIGHT)).toBe(8);
    expect(walkerCommand(BTN_JINK_LEFT)).toBe(7);
    expect(walkerCommand(BTN_JINK_LEFT | BTN_JINK_RIGHT)).toBe(0);
    expect(walkerCommand(BTN_JUMP)).toBe(0);
    expect(walkerCommand(BTN_TURN_RIGHT)).toBe(0x40);
    expect(walkerCommand(BTN_TURN_LEFT | BTN_FORWARD)).toBe(0x23);
  });
});

describe("the AnmD player", () => {
  test("advances a frame each time the clock passes the period", () => {
    const a = createAnimPlayer(X1_LEG_TRACKS, 1);
    // Track 6, the walk's first step: 316 -> 325, period 263, at the walk's 426.
    animSetTrack(a, 0, 6, 1, 1);
    let frames = 0;
    let steps = 0;
    while (a.index[0] === 6) {
      const before = a.frame[0];
      animStep(a, 0, 426, 0);
      steps++;
      if (a.index[0] === 6) frames += a.frame[0] - before;
    }
    // 10 frames, the 11th steps past the end into the link (track 30): 11 x 263 / 426.
    expect(steps).toBe(Math.ceil((11 * 263) / 426));
    expect(a.index[0]).toBe(30);
    expect(frames).toBeGreaterThan(0);
  });

  test("carries the clock across a link and plays a from > to track backwards", () => {
    const a = createAnimPlayer(X1_LEG_TRACKS, 1);
    // Track 7, the walk back: 118 -> 111.
    animSetTrack(a, 0, 7, 1, 0);
    expect(a.direction[0]).toBe(-1);
    animStep(a, 0, 331, 0);
    expect(a.frame[0]).toBe(117);
    expect(a.clock[0]).toBe(1);
  });

  test("fires a track's event at its frame and starts with STARTED", () => {
    const a = createAnimPlayer(X1_LEG_TRACKS, 1);
    animSetTrack(a, 0, 6, 1, 1); // event 0x23 at 316, its first frame
    const r = animStep(a, 0, 1, 0);
    expect((r >>> 1) & 0x3f).toBe(0x23);
  });

  test("mode 3 sets the frame by a 16.16 progress", () => {
    const a = createAnimPlayer(X1_LEG_TRACKS, 1);
    animSetTrack(a, 0, 0x0c, 1, 0);
    animStep(a, 0, 0x8000, 0);
    expect(a.frame[0]).toBe(330 + ((29 * 0x8000) >> 16));
    const c = createAnimPlayer(X1_COCKPIT_TRACKS, 1);
    animSetTrack(c, 0, 2, 1, 0);
    animStep(c, 0, 0x10000, 0);
    expect(c.frame[0]).toBe(29);
  });
});

describe("the walker", () => {
  test("stands on track 0, frame 0, and the loop hears 0x27", () => {
    const w = createX1Walk();
    const codes: number[] = [];
    run(w, 4, {}, codes);
    expect(w.legs.index[0]).toBe(0);
    expect(w.legsFrame[0]).toBe(0);
    expect(w.cockpitFrame[0]).toBe(0);
    expect(codes).toContain(X1_LOOP_STOP);
    expect(w.owner[1]).toBe(-1);
  });

  test("walks on the slow row: state 1, track 6 into the 30 / 31 cycle, at 1.25 steps a tick", () => {
    const w = createX1Walk();
    const codes: number[] = [];
    run(w, 1, { buttons: BTN_ACTION | BTN_FORWARD, vx: WALK, anim: ANIM_MOVING }, codes);
    expect(w.state[0]).toBe(1);
    expect(w.asked[0]).toBe(6);
    expect(codes).toContain(0x23); // track 6's event at its first frame
    run(w, 40, { buttons: BTN_ACTION | BTN_FORWARD, vx: WALK, anim: ANIM_MOVING }, codes);
    expect([30, 31]).toContain(w.legs.index[0]);
    // 30 and 31 carry the footfalls 0x33 (frame 94) and 0x23 (frame 109).
    expect(codes).toContain(0x33);
    // Forty ticks are 50 steps: the eighths' carry gives 1, 1, 1, 2.
    expect(w.carry[0]).toBe((41 * 10) & 7);
  });

  test("runs on the fast row: state 3, track 8 into the 38-41 cycle", () => {
    const w = createX1Walk();
    run(w, 30, { buttons: BTN_FORWARD, vx: RUN, anim: ANIM_MOVING });
    expect(w.state[0]).toBe(3);
    expect(w.asked[0]).toBe(8);
    expect([38, 39, 40, 41]).toContain(w.legs.index[0]);
  });

  test("a released move stands at once: track 0", () => {
    const w = createX1Walk();
    run(w, 20, { buttons: BTN_FORWARD, vx: RUN, anim: ANIM_MOVING });
    run(w, 1, { vx: RUN * 0.5 });
    expect(w.state[0]).toBe(0);
    expect(w.legs.index[0]).toBe(0);
  });

  test("another move finishes the step first, on the track's second link", () => {
    const w = createX1Walk();
    run(w, 30, { buttons: BTN_ACTION | BTN_FORWARD, vx: WALK, anim: ANIM_MOVING });
    run(w, 1, { buttons: BTN_ACTION | BTN_BACK, vx: WALK, anim: ANIM_MOVING });
    // Still state 1, on 30 / 31, until the step ends into 32 / 33 and then track 0.
    expect(w.state[0]).toBe(1);
    const seen = new Set<number>();
    for (let t = 0; t < 60 && w.state[0] !== 2; t++) {
      run(w, 1, { buttons: BTN_ACTION | BTN_BACK, vx: WALK, anim: ANIM_MOVING });
      seen.add(w.legs.index[0]);
    }
    expect(seen.has(32) || seen.has(33)).toBe(true);
    expect(w.state[0]).toBe(2);
  });

  test("strafes and sidesteps on their own tracks", () => {
    const cases: [number, number, number][] = [
      [BTN_JINK_RIGHT, 8, 0x0b],
      [BTN_JINK_LEFT, 7, 0x0a],
      [BTN_ACTION | BTN_JINK_RIGHT, 6, 2],
      [BTN_ACTION | BTN_JINK_LEFT, 5, 1],
      [BTN_BACK, 4, 9],
      [BTN_ACTION | BTN_BACK, 2, 7],
    ];
    for (const [buttons, state, track] of cases) {
      const w = createX1Walk();
      run(w, 2, { buttons, vx: WALK, anim: ANIM_MOVING });
      expect(`${buttons}:${w.state[0]}:${w.asked[0]}`).toBe(`${buttons}:${state}:${track}`);
    }
  });

  test("turns on the spot on 0x0f (right) and 0x0e (left)", () => {
    const w = createX1Walk();
    run(w, 3, { buttons: BTN_TURN_RIGHT });
    expect(w.state[0]).toBe(0);
    expect(w.legs.index[0]).toBe(0x0f);
    run(w, 3, { buttons: BTN_TURN_LEFT });
    expect(w.legs.index[0]).toBe(0x0e);
  });

  test("crouches on slow + jump: track 3 down to 225, held on 25, back up on 26", () => {
    const w = createX1Walk();
    run(w, 1, { buttons: BTN_ACTION | BTN_JUMP });
    expect(w.state[0]).toBe(9);
    expect(w.legs.index[0]).toBe(3);
    run(w, 40, { buttons: BTN_ACTION | BTN_JUMP });
    expect(w.legs.index[0]).toBe(25);
    expect(w.legsFrame[0]).toBe(225);
    const seen = new Set<number>();
    for (let t = 0; t < 40; t++) {
      run(w, 1, {});
      seen.add(w.legs.index[0]);
    }
    expect(seen.has(26)).toBe(true);
    expect(w.state[0]).toBe(0);
    expect(w.legs.index[0]).toBe(0);
  });

  test("fidgets after 256 idle steps on track 0x10", () => {
    const w = createX1Walk();
    run(w, 204, {}); // 255 steps
    expect(w.legs.index[0]).toBe(0);
    run(w, 1, {});
    expect([0x10, 61]).toContain(w.legs.index[0]);
  });
});

describe("the jumps", () => {
  const first = (lift: number) => lift - X1_GRAVITY * TICK_DT;

  test("the high jump leaves on its LAUNCH track 0x1b in state 0x0c, and lands", () => {
    const w = createX1Walk();
    run(w, 3, {});
    run(w, 1, { vz: first(WALKER_HIGH_LIFT), anim: ANIM_AIRBORNE });
    expect(w.state[0]).toBe(0x0c);
    expect(w.asked[0]).toBe(4);
    expect([0x1b, 0x1c]).toContain(w.legs.index[0]);
    run(w, 8, { vz: -3, anim: ANIM_AIRBORNE });
    expect(w.legs.index[0]).toBe(0x1c); // frame 0 held in the air
    run(w, 2, {});
    expect(w.legs.index[0]).toBe(0);
  });

  test("the hop leaves on 0x3a in state 0x11 and lands through track 5's crouch", () => {
    const w = createX1Walk();
    run(w, 3, {});
    run(w, 1, { vz: first(WALKER_HOP_LIFT), anim: ANIM_AIRBORNE });
    expect(w.state[0]).toBe(0x11);
    expect(w.legs.index[0]).toBe(0x3a);
    run(w, 12, { vz: -3, anim: ANIM_AIRBORNE });
    const seen = new Set<number>();
    for (let t = 0; t < 40; t++) {
      run(w, 1, {});
      seen.add(w.legs.index[0]);
    }
    expect(seen.has(5)).toBe(true);
    expect(w.state[0]).toBe(0);
  });

  test("the leap leaves from the run on 0x36 / 0x37 in state 0x0e", () => {
    const w = createX1Walk();
    run(w, 20, { buttons: BTN_FORWARD, vx: RUN, anim: ANIM_MOVING });
    run(w, 1, { buttons: BTN_FORWARD, vx: RUN, vz: first(WALKER_LEAP_LIFT), anim: ANIM_AIRBORNE });
    expect(w.state[0]).toBe(0x0e);
    expect([0x36, 0x37]).toContain(w.legs.index[0]);
  });

  test("a hard landing is state 0x12 on track 5", () => {
    const w = createX1Walk();
    run(w, 3, {});
    run(w, 1, { vz: first(WALKER_HIGH_LIFT), anim: ANIM_AIRBORNE });
    run(w, 10, { vz: -10, anim: ANIM_AIRBORNE }); // 10 m/s: 0x88888 a step, over 0x50000
    run(w, 1, {});
    expect(w.state[0]).toBe(0x12);
    // The landing step keeps the air's track; the next asks for the state's.
    run(w, 1, {});
    expect(w.state[0]).toBe(0x12);
    expect(w.asked[0]).toBe(5);
  });
});

describe("the transform", () => {
  test("plays legs 330 -> 359 and the cockpit 0 -> 29 over the ramp, then holds the hover", () => {
    const w = createX1Walk();
    run(w, 3, {});
    const t = tracksJson.transform;
    expect(t.to_hover.legs_frames).toEqual([330, 359]);
    expect(t.to_hover.cockpit_frames).toEqual([0, 29]);
    const per = t.progress.per_tick * 10; // 160 a unit, 10 units a sim tick
    for (let lock = TRANSFORM_LOCK_TICKS; lock >= 1; lock--) {
      run(w, 1, { anim: ANIM_HOVER, lock });
      const k = TRANSFORM_LOCK_TICKS - lock;
      const progress = Math.min(per * (k + 1), t.progress.full);
      expect(w.legsFrame[0]).toBe(330 + ((29 * progress) >> 16));
      expect(w.cockpitFrame[0]).toBe((29 * progress) >> 16);
      expect(w.form[0]).toBe(1);
    }
    expect(w.legsFrame[0]).toBe(359);
    run(w, 5, { anim: ANIM_HOVER });
    expect(w.legsFrame[0]).toBe(359);
    expect(w.cockpitFrame[0]).toBe(29);
  });

  test("runs back to the walker and puts both blocks on track 0 at its end", () => {
    const w = createX1Walk();
    run(w, 2, { anim: ANIM_HOVER });
    expect(w.legsFrame[0]).toBe(359);
    let last = 359;
    for (let lock = TRANSFORM_LOCK_TICKS; lock >= 2; lock--) {
      run(w, 1, { lock });
      expect(w.legsFrame[0]).toBeLessThanOrEqual(last);
      last = w.legsFrame[0];
    }
    run(w, 1, { lock: 1 });
    expect(w.legsFrame[0]).toBe(0);
    expect(w.cockpitFrame[0]).toBe(0);
    expect(w.form[0]).toBe(0);
  });

  test("a hover spawn starts on the hover's holds", () => {
    const w = createX1Walk();
    run(w, 1, { anim: ANIM_HOVER });
    expect(w.legs.index[0]).toBe(0x0d);
    expect(w.cockpit.index[0]).toBe(1);
    expect(w.codeCount[0]).toBeLessThanOrEqual(X1_CODES_PER_TICK);
  });
});
