// The actors' contacts' push (fcop-fidelity.md P4): `player_push_contacts`
// 0x00442e70 -> `player_push_pair` 0x00442f70 -> `player_push_apart` 0x00443070
// -> `player_push_from_box` 0x004431d0. The mech's own one-box contact model
// (`player_transform_shape` 0x00441cf0, `player_bounds_pair` 0x00444f00) meets
// the hit boxes of the lock candidates near it, and of the other mech with two
// players; each met box pushes it into the wall push's impulse and the toucher
// deals its +0x1a a step.

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  PUSH_BOX_STEP,
  PUSH_BOX_STEP_WIDE,
  SNAP_CONTACT,
  TOUCH_DAMAGE_PER_STEP,
  X1_RAMP_FULL,
} from "../src/balance";
import {
  bodiesContact,
  PUSH_OUT,
  pushContacts,
  SHAPE_STATE_WORDS,
  shapeBounds,
  shapeTransform,
} from "../src/contact";
import { createTickInputs } from "../src/inputs";
import { getMapById, LA_CANTINA_ID } from "../src/map";
import { createSim, type SimState, spawnUnit, step } from "../src/sim";

const X = 120.5;
const Y = 120;

function shapeOf(state: SimState, p: number): number[] {
  return Array.from(state.avatarShape.slice(p * SHAPE_STATE_WORDS, (p + 1) * SHAPE_STATE_WORDS));
}

/** Player 0's mech at (X, Y) facing +x on the ground, the rival's far away. */
function arena(): SimState {
  const state = createSim(getMapById(LA_CANTINA_ID), 1);
  const ent = state.ent;
  const a = state.avatarId[0];
  ent.posX[a] = X;
  ent.posY[a] = Y;
  ent.height[a] = 0;
  ent.yaw[a] = 0;
  const b = state.avatarId[1];
  ent.posX[b] = X + 40;
  ent.posY[b] = Y + 40;
  // Nothing else on the field: the base turrets' rings and the outposts'.
  for (let id = 0; id < ent.high; id++) {
    if (id !== a && id !== b) ent.alive[id] = 0;
  }
  return state;
}

/** A unit of `arch` for `team` (1) at (x, y) on the ground, facing +y. */
function unit(state: SimState, arch: number, x: number, y: number, team = 1): number {
  const id = spawnUnit(state, arch, team, x, y);
  state.ent.height[id] = 0;
  state.ent.yaw[id] = Math.PI / 2;
  return id;
}

describe("the mech's own contact model", () => {
  it("is the legs' frame-0 box with the standing band at the reset", () => {
    const state = arena();
    // Legs frame 0: centre (0, 189, 16), half (132, 189, 164). The band at
    // progress 0: A 0x126, B 0x19, so the box spans 0x32..0x24c (0.098..1.148
    // m); +0x44 is A, +0x46 the horizontal radius sqrt(132^2 + 164^2) = 210.
    expect(shapeOf(state, 0)).toEqual([0, 319, 16, 132, 269, 164, 294, 210]);
  });

  it("widens, lengthens and walks forward at the hover's full progress", () => {
    const state = arena();
    shapeTransform(state, 0, 0, X1_RAMP_FULL);
    // Half x by a quarter, centre z by a half depth, half z doubled; the band
    // 0x73 with no half-span (0..0.449 m).
    expect(shapeOf(state, 0)).toEqual([0, 115, 180, 165, 115, 328, 115, 366]);
  });

  it("is lowered by the crouch's bounds pair and put back", () => {
    const state = arena();
    shapeBounds(state, 0, true);
    // 0x126 - 0x5a +- 0x19: the top 408 (0.797 m), the floor still 0x32.
    expect(shapeOf(state, 0).slice(0, 6)).toEqual([0, 229, 16, 132, 179, 164]);
    shapeBounds(state, 0, false);
    expect(shapeOf(state, 0)).toEqual([0, 319, 16, 132, 269, 164, 294, 210]);
  });
});

describe("the push", () => {
  it("pushes the mech off a tank it stands inside, by the tank's box", () => {
    const state = arena();
    const t = unit(state, ARCHETYPE.RUNNER, X + 0.8, Y);
    expect(pushContacts(state, 0, false)).toBe(1);
    expect(PUSH_OUT.touched[0]).toBe(t);
    // Inside the box's height and its depth but outside its width: the push
    // along the box's x alone, which the tank's yaw turns onto the sim's -x.
    expect(PUSH_OUT.ix).toBe(-PUSH_BOX_STEP * 16);
    expect(PUSH_OUT.iy).toBe(0);
  });

  it("halves both steps inside the box's footprint", () => {
    const state = arena();
    unit(state, ARCHETYPE.RUNNER, X + 0.5, Y);
    expect(pushContacts(state, 0, false)).toBe(1);
    expect(Math.abs(PUSH_OUT.ix)).toBe((PUSH_BOX_STEP / 2) * 16);
    expect(Math.abs(PUSH_OUT.iy)).toBe((PUSH_BOX_STEP / 2) * 16);
    expect(PUSH_OUT.ix).toBeLessThan(0);
  });

  it("does not reach a tank a metre off", () => {
    const state = arena();
    unit(state, ARCHETYPE.RUNNER, X + 1, Y);
    expect(pushContacts(state, 0, false)).toBe(0);
    expect(PUSH_OUT.ix).toBe(0);
  });

  it("pushes at 0x4000 off the Dreadnought, whose hull and mounts each count", () => {
    const state = arena();
    unit(state, ARCHETYPE.JUGGERNAUT, X + 0.8, Y);
    expect(pushContacts(state, 0, false)).toBe(1);
    expect(PUSH_OUT.ix).toBe(-PUSH_BOX_STEP_WIDE * 16);
  });

  it("tries the other mech by its contact model only with two players", () => {
    const state = arena();
    const b = state.avatarId[1];
    state.ent.posX[b] = X + 0.5;
    state.ent.posY[b] = Y;
    state.ent.height[b] = 0;
    state.ent.yaw[b] = 0;
    expect(pushContacts(state, 0, false)).toBe(0);
    expect(pushContacts(state, 0, true)).toBe(1);
    expect(PUSH_OUT.touched[0]).toBe(b);
    expect(PUSH_OUT.ix).toBeLessThan(0);
  });

  it("is spent the next tick: the snap 0x10, the toucher's damage a step", () => {
    const state = arena();
    const ent = state.ent;
    const a = state.avatarId[0];
    // The mech's own side's tank: it does not shoot, it only touches.
    const t = unit(state, ARCHETYPE.RUNNER, X + 0.8, Y, 0);
    const inputs = createTickInputs();
    const hp = ent.hp[a];
    // Hold the tank where it is for the one tick.
    ent.velX[t] = 0;
    ent.velY[t] = 0;
    step(state, inputs);
    expect(state.avatarSnap[0]).toBe(SNAP_CONTACT);
    expect(state.avatarImpulse[0]).toBeLessThan(0);
    const steps = state.walker.steps[0];
    expect(hp - ent.hp[a]).toBe(TOUCH_DAMAGE_PER_STEP[ARCHETYPE.RUNNER] * steps);
    const x0 = ent.posX[a];
    step(state, inputs);
    // The impulse moved it away from the tank.
    expect(ent.posX[a]).toBeLessThan(x0);
  });
});

describe("a route follower's contact", () => {
  it("does not count the Dreadnought's gun mounts", () => {
    const state = arena();
    const d = unit(state, ARCHETYPE.JUGGERNAUT, X, Y);
    state.ent.yaw[d] = 0;
    // A tank lifted to a fore mount's height beside the hull: the mount's box
    // alone meets it, and the mount lacks bit 31 (0x00425fdd, 0x004247e5).
    const t = unit(state, ARCHETYPE.RUNNER, X - 1.5, Y - 0.5);
    state.ent.yaw[t] = 0;
    state.ent.height[t] = 0.8;
    expect(bodiesContact(state, d, t)).toBe(1);
    expect(bodiesContact(state, d, t, true)).toBe(0);
  });
});
