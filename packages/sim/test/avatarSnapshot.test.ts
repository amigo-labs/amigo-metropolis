// writeAvatarSnapshot: the X1's per-player half of the sim -> renderer contract
// (architecture.md §3), which the client's copy of the original's walker
// animation runs off (packages/client/src/render/x1Walk.ts). It must be a pure
// read, and it must hand over exactly what the movement read.

import { describe, expect, it } from "bun:test";
import {
  AVATAR_SNAP_ANIM,
  AVATAR_SNAP_BUTTONS,
  AVATAR_SNAP_CLOAK,
  AVATAR_SNAP_GROUND_MODE,
  AVATAR_SNAP_ID,
  AVATAR_SNAP_LOCK,
  AVATAR_SNAP_STRIDE,
  AVATAR_SNAP_VX,
  AVATAR_SNAP_VY,
  AVATAR_SNAP_VZ,
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

  it("hands over the jump's lift and the airborne bit", () => {
    const sim = freshSim();
    const inputs = createTickInputs();
    for (let i = 0; i < 5; i++) step(sim, inputs);
    inputs.players[0].buttons = BTN_JUMP;
    step(sim, inputs);
    const out = new Float32Array(AVATAR_SNAPSHOT_LEN);
    writeAvatarSnapshot(sim, out);
    expect(out[AVATAR_SNAP_VZ]).toBeGreaterThan(0);
    expect(out[AVATAR_SNAP_ANIM] & ANIM_AIRBORNE).toBe(ANIM_AIRBORNE);
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
