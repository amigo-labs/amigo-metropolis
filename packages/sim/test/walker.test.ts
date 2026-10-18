// The X1-Alpha's walker state machine and its legs in the sim (walker.ts;
// fcop-fidelity.md G11, P4): the jump table against the RE's walker states, the
// AnmD player's timing (a frame per `period` of the clock, the clock fed the
// state's rate: 0xa0 or the speed >> 8 over its floor), the commands, and the
// machine stepped by the sim -- the walk, the run, the turns, the crouch, the
// fidget, the three jumps with their wind-ups and take-offs, the HOLD tracks'
// grip on the push, the held jump's repeat, the hard landing, the transform's
// frames over the ramp and the codes the legs hand the movement loop. Moved
// here from the client's copy of the machine (render/x1Walk.ts), which now
// reads the sim's state off the avatar snapshot.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  TICK_DT,
  TRANSFORM_LOCK_TICKS,
  WALK_ARMS,
  WALK_LOOP_STOP,
  WALK_RATE_FIXED,
  WALK_RATE_LEAP,
  WALK_RATE_MIN,
  WALK_RATE_RUN,
  WALKER_HIGH_LIFT,
  WALKER_HOP_LIFT,
  WALKER_LEAP_LIFT,
  WALKER_LUNGE_PUSH,
  X1_GRAVITY,
} from "../src/balance";
import {
  BTN_ACTION,
  BTN_BACK,
  BTN_FORWARD,
  BTN_JINK_LEFT,
  BTN_JINK_RIGHT,
  BTN_JUMP,
  BTN_TURN_LEFT,
  BTN_TURN_RIGHT,
  createTickInputs,
  TRANSFORM_CHORD,
} from "../src/inputs";
import { loadMapFromJson, type MapJson } from "../src/map";
import { createSim, hash, type SimState, step } from "../src/sim";
import {
  animSetTrack,
  animStep,
  createAnimPlayer,
  createWalkerState,
  WALK_AIRBORNE,
  walkerCommand,
  walkerRate,
} from "../src/walker";
import { X1_COCKPIT_TRACKS, X1_LEG_TRACKS } from "../src/x1Tracks.generated";

const TRACKS_JSON = new URL(
  "../../../tools/generators/units/raw/fcop-x1/tracks.json",
  import.meta.url,
).pathname;
const tracksJson = JSON.parse(readFileSync(TRACKS_JSON, "utf8")) as {
  walker: {
    states: {
      state: number;
      push: number;
      sideways: boolean;
      tracks: number[];
      becomes: number | null;
      lift: { raw: number } | null;
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

// A 16 x 16 grid of 4 m cells: flat (0) but for a ramp too steep to walk
// (column 7, 5 m over 4 m) up to a plateau, and the far bank's water.
function arenaJson(hover = false): MapJson {
  const size = 16;
  const colHeights = [0, 0, 0, 0, 0, 0, 0, 160, 160, 160, 0, -64, -64, 0, 0, 0];
  const colWater = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0];
  const heights: number[][] = [];
  const water: string[] = [];
  for (let j = 0; j < size; j++) {
    heights.push([...colHeights]);
    water.push(colWater.map((w) => `${w}`).join(""));
  }
  return {
    id: "walker-test",
    size,
    cellSize: 4,
    waterLevel: -0.5,
    heights,
    water,
    spawns: [
      { x: 12, y: 30, yaw: 0, hover },
      { x: 50, y: 30, yaw: 0 },
    ],
    basePlots: [
      { x: 12, y: 30, radius: 8 },
      { x: 50, y: 30, radius: 8 },
    ],
    bases: [
      {
        gate: { x: 2, y: 2, radius: 2 },
        core: [4, 30],
        groundConsole: [12, 22],
        airConsole: [12, 38],
        turrets: [],
      },
      {
        gate: { x: 58, y: 58, radius: 2 },
        core: [56, 30],
        groundConsole: [50, 22],
        airConsole: [50, 38],
        turrets: [],
      },
    ],
    lanes: [],
    turretSpots: [],
    outpostSpots: [],
    dummySpots: [],
  };
}

const inputs = createTickInputs();

/** A fresh sim, its reset spent: two steps on the ground (the landing, then the bit). */
function freshSim(hover = false): SimState {
  const sim = createSim(loadMapFromJson(arenaJson(hover)), 1);
  run(sim, 3, 0);
  return sim;
}

/** `ticks` ticks of `buttons` for player 0; the legs' codes, if asked. */
function run(sim: SimState, ticks: number, buttons: number, codes?: number[]): void {
  for (let t = 0; t < ticks; t++) {
    inputs.players[0].buttons = buttons;
    inputs.players[1].buttons = 0;
    step(sim, inputs);
    if (codes) for (let k = 0; k < sim.walker.codeCount[0]; k++) codes.push(sim.walker.codes[k]);
  }
}

/** Ticks of `buttons` until `done`, at most `limit`; how many ran (-1: never). */
function until(sim: SimState, buttons: number, done: () => boolean, limit = 120): number {
  for (let t = 1; t <= limit; t++) {
    run(sim, 1, buttons);
    if (done()) return t;
  }
  return -1;
}

const legs = (sim: SimState) => sim.walker.legs.index[0];
const stateOf = (sim: SimState) => sim.walker.state[0];
const vz = (sim: SimState) => sim.ent.timerB[sim.avatarId[0]];
const lifted = (sim: SimState) => vz(sim) > 0;

describe("the jump table", () => {
  test("is the RE's walker states: push, sideways, track, lift and the state it becomes", () => {
    for (const st of tracksJson.walker.states) {
      const a = WALK_ARMS[st.state];
      const want = {
        push: st.push,
        sideways: st.sideways,
        // State 0's tracks are the idle's and the turns'; 0x0c asks for none.
        track: st.state === 0 || st.state === 12 ? -1 : st.tracks[0],
        lift: st.lift ? st.lift.raw : 0,
        becomes: st.becomes ?? -1,
      };
      expect(`${st.state}:${JSON.stringify({ ...a, settle: undefined })}`).toBe(
        `${st.state}:${JSON.stringify({ ...want, settle: undefined })}`,
      );
    }
  });

  test("the rate: 0xa0 fixed in seven states, else speed >> 8 over the state's floor", () => {
    for (const st of tracksJson.walker.states) {
      // A launch arm's rate is the state it becomes in the same step (0x10 -> 0x11).
      const s = st.becomes ?? st.state;
      if (st.rate.fixed !== undefined) {
        expect(walkerRate(s, 0, 0)).toBe(st.rate.fixed);
        expect(walkerRate(s, 0x40000, 0)).toBe(WALK_RATE_FIXED);
      } else {
        expect(walkerRate(s, 0, 0)).toBe(st.rate.speed_floor ?? -1);
      }
    }
    expect(walkerRate(1, 0x1aaaa, 0)).toBe(426); // the walk, settled
    expect(walkerRate(3, 0x40000, 0)).toBe(1024); // the run
    expect(walkerRate(7, 0x2aaaa, 0)).toBe(682); // the strafe
    expect(walkerRate(0x0e, 0, 0)).toBe(WALK_RATE_LEAP);
    expect(walkerRate(2, 0, 0)).toBe(WALK_RATE_RUN);
    expect(walkerRate(5, 0, 0)).toBe(WALK_RATE_MIN);
    // Slippery ground (mode 1..3) multiplies by 4 - mode.
    expect(walkerRate(1, 0x1aaaa, 1)).toBe(426 * 3);
  });

  test("the commands: slow row, fast row, turns; the fast row's jump by the probe", () => {
    const w = createWalkerState(1);
    const cmd = (bits: number, rise = 0) => walkerCommand(w, 0, bits, rise);
    expect(cmd(BTN_ACTION | BTN_FORWARD)).toBe(1);
    expect(cmd(BTN_ACTION | BTN_BACK)).toBe(2);
    expect(cmd(BTN_ACTION | BTN_JUMP)).toBe(9);
    expect(cmd(BTN_ACTION | BTN_JINK_RIGHT)).toBe(6);
    expect(cmd(BTN_ACTION | BTN_JINK_LEFT)).toBe(5);
    expect(cmd(BTN_FORWARD)).toBe(3);
    expect(cmd(BTN_BACK | BTN_JINK_RIGHT)).toBe(4);
    expect(cmd(BTN_JINK_RIGHT)).toBe(8);
    expect(cmd(BTN_JINK_LEFT)).toBe(7);
    expect(cmd(BTN_TURN_RIGHT)).toBe(0x40);
    expect(cmd(BTN_TURN_LEFT | BTN_FORWARD)).toBe(0x23);
    // The fast row's jump takes no turn bit and no direction: the probe's rise.
    expect(cmd(BTN_JUMP | BTN_FORWARD | BTN_TURN_RIGHT, 0.2)).toBe(0x0f);
    expect(cmd(BTN_JUMP, 0.5)).toBe(0x0a);
    expect(w.flags[0] & 8).toBe(0);
    expect(cmd(BTN_JUMP, 1.2)).toBe(0x0a);
    expect(w.flags[0] & 8).toBe(8); // a wall ahead: no lunge
    // Running (state 3) the jump is the run's own: no probe, the row decoded.
    w.state[0] = 3;
    expect(cmd(BTN_JUMP | BTN_FORWARD, 0.5)).toBe(3);
    // Nor on steep ground.
    w.state[0] = 0;
    w.flags[0] = 0x40;
    expect(cmd(BTN_JUMP, 0.5)).toBe(0);
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

describe("the walker in the sim", () => {
  test("starts with no control and lands on its first step, on track 0", () => {
    const sim = createSim(loadMapFromJson(arenaJson()), 1);
    expect(sim.walker.flags[0]).toBe(WALK_AIRBORNE); // player_reset's flags_b9 = 1
    const codes: number[] = [];
    run(sim, 1, BTN_FORWARD, codes);
    // The reset's step is airborne: the command is taken (the legs are on
    // track 0) but its arm is the air's -- no push -- and it lands.
    expect(sim.ent.velX[sim.avatarId[0]]).toBe(0);
    expect(sim.walker.flags[0] & 3).toBe(2);
    expect(stateOf(sim)).toBe(3);
    expect(legs(sim)).toBe(0);
    expect(sim.walker.legs.frame[0]).toBe(0);
    // Track 0 offers its frame's code every step: the loop's stop.
    expect(codes).toContain(WALK_LOOP_STOP);
    // The next step's arm is the ground's: the run's push and track.
    run(sim, 1, BTN_FORWARD);
    expect(sim.ent.velX[sim.avatarId[0]]).toBeGreaterThan(0);
    expect(sim.walker.asked[0]).toBe(8);
  });

  test("walks on the slow row: state 1, track 6 into the 30 / 31 cycle, at 1.25 steps a tick", () => {
    const sim = freshSim();
    const codes: number[] = [];
    run(sim, 1, BTN_ACTION | BTN_FORWARD, codes);
    expect(stateOf(sim)).toBe(1);
    expect(sim.walker.asked[0]).toBe(6);
    expect(codes).toContain(0x23); // track 6's event at its first frame
    const carry = sim.walker.carry[0];
    run(sim, 40, BTN_ACTION | BTN_FORWARD, codes);
    expect([30, 31]).toContain(legs(sim));
    // 30 and 31 carry the footfalls 0x33 (frame 94) and 0x23 (frame 109).
    expect(codes).toContain(0x33);
    // Forty ticks are 50 steps: the eighths' carry gives 1, 1, 1, 2.
    expect(sim.walker.carry[0]).toBe((carry + 40 * 10) & 7);
  });

  test("runs on the fast row: state 3, track 8 into the 38-41 cycle", () => {
    const sim = freshSim();
    run(sim, 30, BTN_FORWARD);
    expect(stateOf(sim)).toBe(3);
    expect(sim.walker.asked[0]).toBe(8);
    expect([38, 39, 40, 41]).toContain(legs(sim));
  });

  test("a released move stands at once: track 0", () => {
    const sim = freshSim();
    run(sim, 20, BTN_FORWARD);
    run(sim, 1, 0);
    expect(stateOf(sim)).toBe(0);
    expect(legs(sim)).toBe(0);
  });

  test("another move finishes the step first, on the track's second link, and pushes on", () => {
    const sim = freshSim();
    run(sim, 30, BTN_ACTION | BTN_FORWARD);
    run(sim, 1, BTN_ACTION | BTN_BACK);
    // Still state 1, on 30 / 31, until the step ends into 32 / 33 and then track 0:
    // the walker goes on forward until then.
    expect(stateOf(sim)).toBe(1);
    expect(sim.ent.velX[sim.avatarId[0]]).toBeGreaterThan(1.9);
    const seen = new Set<number>();
    for (let t = 0; t < 60 && stateOf(sim) !== 2; t++) {
      run(sim, 1, BTN_ACTION | BTN_BACK);
      seen.add(legs(sim));
    }
    expect(seen.has(32) || seen.has(33)).toBe(true);
    expect(stateOf(sim)).toBe(2);
    run(sim, 30, BTN_ACTION | BTN_BACK);
    expect(sim.ent.velX[sim.avatarId[0]]).toBeLessThan(-1.9);
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
      const sim = freshSim();
      run(sim, 2, buttons);
      expect(`${buttons}:${stateOf(sim)}:${sim.walker.asked[0]}`).toBe(
        `${buttons}:${state}:${track}`,
      );
    }
  });

  test("turns on the spot on 0x0f (right) and 0x0e (left)", () => {
    const sim = freshSim();
    run(sim, 3, BTN_TURN_RIGHT);
    expect(stateOf(sim)).toBe(0);
    expect(legs(sim)).toBe(0x0f);
    run(sim, 3, BTN_TURN_LEFT);
    expect(legs(sim)).toBe(0x0e);
  });

  test("crouches on slow + jump: track 3 down to 225, held on 25, back up on 26", () => {
    const sim = freshSim();
    run(sim, 1, BTN_ACTION | BTN_JUMP);
    expect(stateOf(sim)).toBe(9);
    expect(legs(sim)).toBe(3);
    expect(sim.walker.flags[0] & 0x80).toBe(0x80); // the bounds' lowered pair
    run(sim, 40, BTN_ACTION | BTN_JUMP);
    expect(legs(sim)).toBe(25);
    expect(sim.walker.legs.frame[0]).toBe(225);
    const seen = new Set<number>();
    for (let t = 0; t < 40; t++) {
      run(sim, 1, 0);
      seen.add(legs(sim));
    }
    expect(seen.has(26)).toBe(true);
    expect(stateOf(sim)).toBe(0);
    expect(legs(sim)).toBe(0);
    expect(sim.walker.flags[0] & 0x80).toBe(0);
  });

  test("fidgets after 256 idle steps on track 0x10", () => {
    const sim = createSim(loadMapFromJson(arenaJson()), 1);
    // The reset's step and 204 more ticks: 255 steps, the idle count at 253.
    run(sim, 204, 0);
    expect(legs(sim)).toBe(0);
    run(sim, 2, 0);
    expect([0x10, 61]).toContain(legs(sim));
  });
});

describe("the jumps", () => {
  test("the hop winds up on track 0x11 and leaves on 0x3a, 0.2 s after the press", () => {
    const sim = freshSim();
    run(sim, 1, BTN_JUMP);
    expect(stateOf(sim)).toBe(0x0f);
    expect(legs(sim)).toBe(0x11);
    expect(lifted(sim)).toBe(false);
    // A press is enough: released, the wind-up runs on.
    const ticks = until(sim, 0, () => lifted(sim));
    expect(ticks).toBe(6); // 8 steps of track 0x11 at 0xa0, its LAUNCH link, the arm
    expect(stateOf(sim)).toBe(0x11);
    expect(legs(sim)).toBe(0x3a);
    // 6.45 m/s up less a tick of gravity, 4.69 m/s forward.
    expect(vz(sim)).toBeCloseTo(WALKER_HOP_LIFT - X1_GRAVITY * TICK_DT, 4);
    expect(sim.ent.velX[sim.avatarId[0]]).toBeCloseTo(4.6875, 3);
  });

  test("the high jump winds up on track 4 and leaves on 0x1b, 0.4 s after the press, then lunges", () => {
    const sim = freshSim();
    const id = sim.avatarId[0];
    // At the ramp's foot: 1 m ahead the ground is 0.6 m up, over 0xae1 (0.34 m).
    sim.ent.posX[id] = 23.3;
    run(sim, 1, BTN_JUMP);
    expect(stateOf(sim)).toBe(0x0a);
    expect(legs(sim)).toBe(4);
    const ticks = until(sim, 0, () => lifted(sim));
    expect(ticks).toBe(12);
    expect(stateOf(sim)).toBe(0x0c);
    expect([0x1b, 0x1c]).toContain(legs(sim));
    expect(vz(sim)).toBeCloseTo(WALKER_HIGH_LIFT - X1_GRAVITY * TICK_DT, 4);
    expect(sim.ent.velX[id]).toBe(0);
    // Nine steps after the take-off, the lunge.
    const lunge = until(sim, 0, () => sim.ent.velX[id] > 0);
    expect(lunge).toBe(7);
    expect(sim.ent.velX[id]).toBeCloseTo(WALKER_LUNGE_PUSH, 4);
  });

  test("the wind-up's HOLD track keeps the push: Forward moves nothing until the take-off", () => {
    const sim = freshSim();
    const id = sim.avatarId[0];
    run(sim, 1, BTN_JUMP);
    const x = sim.ent.posX[id];
    until(sim, BTN_FORWARD, () => lifted(sim));
    // Five ticks of Forward on the wind-up: the hop's arm, not the run, moved it.
    expect(sim.ent.posX[id] - x).toBeLessThan(0.2);
    expect(stateOf(sim)).toBe(0x11);
  });

  test("the leap leaves only from a run, on 0x36 / 0x37 at the press and the next step's lift", () => {
    const sim = freshSim();
    run(sim, 21, BTN_FORWARD);
    expect(stateOf(sim)).toBe(3);
    // A tick of one step: its second would already lift.
    expect(sim.walker.carry[0]).toBeLessThan(6);
    run(sim, 1, BTN_FORWARD | BTN_JUMP);
    expect(stateOf(sim)).toBe(0x0d);
    expect([0x36, 0x37]).toContain(legs(sim));
    expect(lifted(sim)).toBe(false);
    run(sim, 1, BTN_FORWARD);
    expect(stateOf(sim)).toBe(0x0e);
    expect(vz(sim)).toBeCloseTo(WALKER_LEAP_LIFT - X1_GRAVITY * TICK_DT, 4);
    // From standing, Forward and Jump together are the hop's wind-up, not a leap.
    const still = freshSim();
    run(still, 1, BTN_FORWARD | BTN_JUMP);
    expect(stateOf(still)).toBe(0x0f);
  });

  test("a held Jump jumps again once the legs are back on track 0", () => {
    const sim = freshSim();
    let takeoffs = 0;
    let was = false;
    for (let t = 0; t < 90; t++) {
      run(sim, 1, BTN_JUMP);
      const up = lifted(sim);
      if (up && !was) takeoffs++;
      was = up;
    }
    expect(takeoffs).toBe(3);
  });

  test("a hard landing is state 0x12 on track 5, which holds the walker still", () => {
    const sim = freshSim();
    const id = sim.avatarId[0];
    // 3 m up: it lands at 12.5 m/s, 0x88888 a step, over 0x50000.
    sim.ent.height[id] = 3;
    const landed = until(sim, 0, () => (sim.walker.flags[0] & 2) !== 0);
    expect(landed).toBeGreaterThan(0);
    expect(stateOf(sim)).toBe(0x12);
    // The landing step keeps the air's track; the next asks for the state's.
    run(sim, 1, BTN_FORWARD);
    expect(stateOf(sim)).toBe(0x12);
    expect(sim.walker.asked[0]).toBe(5);
    // Forward is not taken until track 5 has run back to track 0.
    run(sim, 5, BTN_FORWARD);
    expect(stateOf(sim)).toBe(0x12);
    expect(sim.ent.velX[id]).toBe(0);
    const free = until(sim, BTN_FORWARD, () => stateOf(sim) === 3);
    expect(free).toBeGreaterThan(0);
  });
});

describe("the transform", () => {
  test("plays legs 330 -> 359 and the cockpit 0 -> 29 over the ramp, then holds the hover", () => {
    const sim = freshSim();
    const w = sim.walker;
    const t = tracksJson.transform;
    expect(t.to_hover.legs_frames).toEqual([330, 359]);
    expect(t.to_hover.cockpit_frames).toEqual([0, 29]);
    const per = t.progress.per_tick * 10; // 160 a unit, 10 units a sim tick
    run(sim, 1, TRANSFORM_CHORD);
    for (let lock = TRANSFORM_LOCK_TICKS; lock >= 1; lock--) {
      expect(sim.ent.timerA[sim.avatarId[0]]).toBe(lock);
      const k = TRANSFORM_LOCK_TICKS - lock;
      const progress = Math.min(per * (k + 1), t.progress.full);
      expect(w.legs.frame[0]).toBe(330 + ((29 * progress) >> 16));
      expect(w.cockpit.frame[0]).toBe((29 * progress) >> 16);
      expect(w.form[0]).toBe(1);
      run(sim, 1, 0);
    }
    expect(w.legs.frame[0]).toBe(359);
    run(sim, 5, BTN_FORWARD);
    expect(w.legs.index[0]).toBe(0x0d);
    expect(w.legs.frame[0]).toBe(359);
    expect(w.cockpit.frame[0]).toBe(29);
  });

  test("runs back to the walker and puts both blocks on track 0 at its end", () => {
    const sim = freshSim();
    const w = sim.walker;
    run(sim, 1, TRANSFORM_CHORD);
    run(sim, TRANSFORM_LOCK_TICKS + 5, 0);
    expect(w.legs.frame[0]).toBe(359);
    run(sim, 1, TRANSFORM_CHORD);
    let last = 359;
    while (sim.ent.timerA[sim.avatarId[0]] > 1) {
      expect(w.legs.frame[0]).toBeLessThanOrEqual(last);
      last = w.legs.frame[0];
      run(sim, 1, 0);
    }
    expect(w.legs.index[0]).toBe(0);
    expect(w.cockpit.index[0]).toBe(0);
    expect(w.form[0]).toBe(0);
    // The hover's tick ran through the ramp with no buttons: state 0 at the end.
    expect(stateOf(sim)).toBe(0);
    run(sim, 3, BTN_FORWARD);
    expect(stateOf(sim)).toBe(3);
  });

  test("a hover spawn starts on the hover's holds", () => {
    const sim = createSim(loadMapFromJson(arenaJson(true)), 1);
    expect(sim.walker.legs.index[0]).toBe(0x0d);
    expect(sim.walker.cockpit.index[0]).toBe(1);
    expect(sim.walker.form[0]).toBe(1);
    run(sim, 3, 0);
    expect(sim.walker.legs.frame[0]).toBe(359);
  });
});

describe("the machine is sim state", () => {
  test("is hashed", () => {
    const sim = freshSim();
    const before = hash(sim);
    sim.walker.legs.clock[0] += 1;
    expect(hash(sim)).not.toBe(before);
    sim.walker.legs.clock[0] -= 1;
    expect(hash(sim)).toBe(before);
    sim.walker.state[0] = 9;
    expect(hash(sim)).not.toBe(before);
  });
});
