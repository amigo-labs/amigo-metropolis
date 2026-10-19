// writeAvatarSnapshot: the X1's per-player half of the sim -> renderer contract
// (architecture.md §3): the walker machine's state, its legs' and cockpit's
// frames and the tick's codes, which the client reads (packages/client/src/
// render/x1Walk.ts), beside what the movement read. It must be a pure read,
// and it must hand over exactly the sim's.

import { describe, expect, it } from "bun:test";
import {
  AVATAR_SNAP_ANIM,
  AVATAR_SNAP_BUTTONS,
  AVATAR_SNAP_CARRY,
  AVATAR_SNAP_CLOAK,
  AVATAR_SNAP_COCKPIT_FRAME,
  AVATAR_SNAP_COCKPIT_TRACK,
  AVATAR_SNAP_CODE_COUNT,
  AVATAR_SNAP_CODE_SLOTS,
  AVATAR_SNAP_CODES,
  AVATAR_SNAP_FORM,
  AVATAR_SNAP_GROUND_MODE,
  AVATAR_SNAP_ID,
  AVATAR_SNAP_LEGS_CLOCK,
  AVATAR_SNAP_LEGS_DIRECTION,
  AVATAR_SNAP_LEGS_FLAGS,
  AVATAR_SNAP_LEGS_FRAME,
  AVATAR_SNAP_LEGS_TARGET,
  AVATAR_SNAP_LEGS_TRACK,
  AVATAR_SNAP_LOCK,
  AVATAR_SNAP_STRIDE,
  AVATAR_SNAP_VX,
  AVATAR_SNAP_VY,
  AVATAR_SNAP_VZ,
  AVATAR_SNAP_WALK_ASKED,
  AVATAR_SNAP_WALK_FLAGS,
  AVATAR_SNAP_WALK_IDLE,
  AVATAR_SNAP_WALK_LUNGE,
  AVATAR_SNAP_WALK_STATE,
  AVATAR_SNAPSHOT_LEN,
  writeAvatarSnapshot,
} from "../src/avatarSnapshot";
import { MAX_PLAYERS, TRANSFORM_LOCK_TICKS } from "../src/balance";
import {
  BTN_ACTION,
  BTN_FORWARD,
  BTN_JUMP,
  createTickInputs,
  TRANSFORM_CHORD,
  TRANSFORM_KEEPS,
} from "../src/inputs";
import { getMapById } from "../src/map";
import { ANIM_AIRBORNE, ANIM_HOVER, ANIM_MOVING, createSim, hash, step } from "../src/sim";

function freshSim() {
  return createSim(getMapById("urban-jungle"), 12345);
}

describe("writeAvatarSnapshot", () => {
  it("cannot move the sim hash", () => {
    const sim = freshSim();
    const inputs = createTickInputs();
    inputs.players[0].buttons = BTN_FORWARD;
    for (let i = 0; i < 40; i++) step(sim, inputs);
    const before = hash(sim);
    const out = new Float32Array(AVATAR_SNAPSHOT_LEN);
    for (let i = 0; i < 5; i++) writeAvatarSnapshot(sim, out);
    expect(hash(sim)).toBe(before);
  });

  it("copies the word, the velocity and the bits the walker read", () => {
    const sim = freshSim();
    const inputs = createTickInputs();
    inputs.players[0].buttons = BTN_FORWARD | BTN_ACTION;
    for (let i = 0; i < 20; i++) step(sim, inputs);
    const out = new Float32Array(AVATAR_SNAPSHOT_LEN);
    writeAvatarSnapshot(sim, out);
    const id = sim.avatarId[0];
    expect(out[AVATAR_SNAP_ID]).toBe(id);
    expect(out[AVATAR_SNAP_BUTTONS]).toBe(BTN_FORWARD | BTN_ACTION);
    expect(out[AVATAR_SNAP_VX]).toBe(Math.fround(sim.ent.velX[id]));
    expect(out[AVATAR_SNAP_VY]).toBe(Math.fround(sim.ent.velY[id]));
    expect(out[AVATAR_SNAP_VZ]).toBe(0);
    expect(out[AVATAR_SNAP_ANIM] & ANIM_MOVING).toBe(ANIM_MOVING);
    expect(out[AVATAR_SNAP_LOCK]).toBe(0);
    expect(out[AVATAR_SNAP_GROUND_MODE]).toBe(0);
    expect(out[AVATAR_SNAP_CLOAK]).toBe(0);
    // The stride is the layout's: slot 1 starts one stride on.
    expect(out[AVATAR_SNAP_STRIDE + AVATAR_SNAP_ID]).toBe(sim.avatarId[1]);
  });

  it("hands over the jump's lift and the airborne bit, after the wind-up", () => {
    const sim = freshSim();
    const inputs = createTickInputs();
    for (let i = 0; i < 5; i++) step(sim, inputs);
    inputs.players[0].buttons = BTN_JUMP;
    step(sim, inputs);
    const out = new Float32Array(AVATAR_SNAPSHOT_LEN);
    writeAvatarSnapshot(sim, out);
    // The wind-up: the hop's or the high jump's, on the ground.
    expect([0x0a, 0x0f]).toContain(out[AVATAR_SNAP_WALK_STATE]);
    expect(out[AVATAR_SNAP_VZ]).toBe(0);
    inputs.players[0].buttons = 0;
    // The lift can come in a tick's second step, the climb in the next tick.
    for (let i = 0; i < 20 && (out[AVATAR_SNAP_ANIM] & ANIM_AIRBORNE) === 0; i++) {
      step(sim, inputs);
      writeAvatarSnapshot(sim, out);
    }
    expect(out[AVATAR_SNAP_VZ]).toBeGreaterThan(0);
    expect(out[AVATAR_SNAP_ANIM] & ANIM_AIRBORNE).toBe(ANIM_AIRBORNE);
    expect([0x0c, 0x11]).toContain(out[AVATAR_SNAP_WALK_STATE]);
  });

  it("copies the walker machine, both AnmD blocks and the tick's codes", () => {
    const sim = freshSim();
    const inputs = createTickInputs();
    inputs.players[0].buttons = BTN_FORWARD;
    const out = new Float32Array(AVATAR_SNAPSHOT_LEN);
    const w = sim.walker;
    let codes = 0;
    for (let i = 0; i < 40; i++) {
      step(sim, inputs);
      writeAvatarSnapshot(sim, out);
      expect(out[AVATAR_SNAP_WALK_STATE]).toBe(w.state[0]);
      expect(out[AVATAR_SNAP_WALK_FLAGS]).toBe(w.flags[0]);
      expect(out[AVATAR_SNAP_WALK_ASKED]).toBe(w.asked[0]);
      expect(out[AVATAR_SNAP_WALK_IDLE]).toBe(w.idle[0]);
      expect(out[AVATAR_SNAP_WALK_LUNGE]).toBe(w.lunge[0]);
      expect(out[AVATAR_SNAP_FORM]).toBe(w.form[0]);
      expect(out[AVATAR_SNAP_LEGS_TRACK]).toBe(w.legs.index[0]);
      expect(out[AVATAR_SNAP_LEGS_FRAME]).toBe(w.legs.frame[0]);
      expect(out[AVATAR_SNAP_LEGS_CLOCK]).toBe(w.legs.clock[0]);
      expect(out[AVATAR_SNAP_LEGS_DIRECTION]).toBe(w.legs.direction[0]);
      expect(out[AVATAR_SNAP_LEGS_TARGET]).toBe(w.legs.target[0]);
      expect(out[AVATAR_SNAP_LEGS_FLAGS]).toBe(w.legs.flags[0]);
      expect(out[AVATAR_SNAP_COCKPIT_TRACK]).toBe(w.cockpit.index[0]);
      expect(out[AVATAR_SNAP_COCKPIT_FRAME]).toBe(w.cockpit.frame[0]);
      expect(out[AVATAR_SNAP_CARRY]).toBe(w.carry[0]);
      const n = out[AVATAR_SNAP_CODE_COUNT];
      expect(n).toBe(w.codeCount[0]);
      for (let k = 0; k < AVATAR_SNAP_CODE_SLOTS; k++) {
        expect(out[AVATAR_SNAP_CODES + k]).toBe(k < n ? w.codes[k] : 0);
      }
      codes += n;
    }
    // The run's legs on track 8's cycle, and their footfalls handed over.
    expect(out[AVATAR_SNAP_WALK_STATE]).toBe(3);
    expect([38, 39, 40, 41]).toContain(out[AVATAR_SNAP_LEGS_TRACK]);
    expect(codes).toBeGreaterThan(0);
  });

  it("counts the transform's lock down and filters the word as the walker does", () => {
    const sim = freshSim();
    const inputs = createTickInputs();
    for (let i = 0; i < 5; i++) step(sim, inputs);
    inputs.players[0].buttons = TRANSFORM_CHORD;
    step(sim, inputs);
    const out = new Float32Array(AVATAR_SNAPSHOT_LEN);
    writeAvatarSnapshot(sim, out);
    expect(out[AVATAR_SNAP_LOCK]).toBe(TRANSFORM_LOCK_TICKS);
    expect(out[AVATAR_SNAP_ANIM] & ANIM_HOVER).toBe(ANIM_HOVER);
    expect(out[AVATAR_SNAP_BUTTONS] & ~TRANSFORM_KEEPS).toBe(0);
    inputs.players[0].buttons = 0;
    for (let i = 0; i < TRANSFORM_LOCK_TICKS; i++) step(sim, inputs);
    writeAvatarSnapshot(sim, out);
    expect(out[AVATAR_SNAP_LOCK]).toBe(0);
  });

  it("names no X1 for the Warden's slot", () => {
    const sim = createSim(getMapById("urban-jungle"), 7, { wardenPlayer: 1 });
    step(sim, createTickInputs());
    const out = new Float32Array(AVATAR_SNAPSHOT_LEN).fill(5);
    writeAvatarSnapshot(sim, out);
    expect(out[AVATAR_SNAP_STRIDE + AVATAR_SNAP_ID]).toBe(-1);
    for (let k = 1; k < AVATAR_SNAP_STRIDE; k++) expect(out[AVATAR_SNAP_STRIDE + k]).toBe(0);
    expect(MAX_PLAYERS * AVATAR_SNAP_STRIDE).toBe(AVATAR_SNAPSHOT_LEN);
  });
});
