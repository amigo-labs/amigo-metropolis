// Soft-lock "lock" mode (input.spec §4.4): the Target-Cycle button acquires a
// lock in-sim, facing tracks the target deterministically, and the lock releases
// when the target dies or drifts beyond AVATAR_LOCK_RANGE. Positions are set
// directly to place the two avatars at known distances.
import { describe, expect, it } from "bun:test";
import {
  AVATAR_LOCK_RANGE,
  BUTTON_TARGET_CYCLE,
  createSim,
  createTestMap,
  createTickInputs,
  hash,
  step,
} from "../src/index";

const map = createTestMap();

/** Places p0's avatar at (ax,ay) and p1's at (bx,by), then settles one tick. */
function place(sim: ReturnType<typeof createSim>, ax: number, ay: number, bx: number, by: number) {
  const a0 = sim.avatarId[0];
  const a1 = sim.avatarId[1];
  sim.ent.posX[a0] = ax;
  sim.ent.posY[a0] = ay;
  sim.ent.posX[a1] = bx;
  sim.ent.posY[a1] = by;
  return { a0, a1 };
}

describe("soft-lock (input.spec §4.4)", () => {
  it("Target-Cycle acquires the enemy and facing tracks it", () => {
    const sim = createSim(map, 0xd0d0);
    const inputs = createTickInputs();
    const { a0, a1 } = place(sim, 50, 50, 60, 50); // enemy 10 east, within range

    inputs.players[0].buttons = BUTTON_TARGET_CYCLE;
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(a1);
    // Facing points from a0 toward a1 (+x), independent of any aim input.
    expect(sim.ent.aimX[a0]).toBeCloseTo(1, 6);
    expect(sim.ent.aimY[a0]).toBeCloseTo(0, 6);

    // Hold nothing (edge clears); the lock persists and tracks the moved target.
    inputs.players[0].buttons = 0;
    sim.ent.posX[a1] = 50;
    sim.ent.posY[a1] = 60; // now 10 north
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(a1);
    expect(sim.ent.aimX[a0]).toBeCloseTo(0, 6);
    expect(sim.ent.aimY[a0]).toBeCloseTo(1, 6);
  });

  it("a locked target that leaves range releases to free aim", () => {
    const sim = createSim(map, 0xd0d0);
    const inputs = createTickInputs();
    const { a0, a1 } = place(sim, 50, 50, 60, 50);
    inputs.players[0].buttons = BUTTON_TARGET_CYCLE;
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(a1);

    // Shove the target well past AVATAR_LOCK_RANGE; the next tick releases it.
    inputs.players[0].buttons = 0;
    inputs.players[0].aimX = 0;
    inputs.players[0].aimY = -127; // free aim points south
    sim.ent.posX[a1] = 50 + AVATAR_LOCK_RANGE + 20;
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(-1);
    // Facing now follows the transmitted aim again (south).
    expect(sim.ent.aimY[a0]).toBeCloseTo(-1, 6);
  });

  it("pressing with no enemy in range acquires nothing", () => {
    const sim = createSim(map, 0xd0d0);
    const inputs = createTickInputs();
    place(sim, 10, 10, 10 + AVATAR_LOCK_RANGE + 30, 10); // enemy out of range
    inputs.players[0].buttons = BUTTON_TARGET_CYCLE;
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(-1);
  });

  it("death releases the lock", () => {
    const sim = createSim(map, 0xd0d0);
    const inputs = createTickInputs();
    const { a1 } = place(sim, 50, 50, 60, 50);
    inputs.players[0].buttons = BUTTON_TARGET_CYCLE;
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(a1);

    // Kill the enemy avatar; the lock must not survive its death. Movement runs
    // before the death system in a tick, so the release lands the next tick
    // (once the target is no longer alive).
    sim.ent.hp[a1] = 0;
    inputs.players[0].buttons = 0;
    step(sim, inputs); // death processed this tick
    step(sim, inputs); // movement now sees a dead target → releases
    expect(sim.lockTarget[0]).toBe(-1);
  });

  it("stays deterministic: same inputs → same hash with the lock active", () => {
    const run = () => {
      const sim = createSim(map, 7);
      const inputs = createTickInputs();
      place(sim, 40, 40, 55, 40);
      inputs.players[0].buttons = BUTTON_TARGET_CYCLE;
      for (let t = 0; t < 20; t++) {
        inputs.players[0].buttons = t === 0 ? BUTTON_TARGET_CYCLE : 0;
        step(sim, inputs);
      }
      return hash(sim);
    };
    expect(run()).toBe(run());
  });

  it("an idle match never engages the lock (hash-neutral trajectory)", () => {
    // No Target-Cycle press → lockTarget stays -1 and facing uses aim/move, so
    // the feature is dormant exactly as the regenerated goldens assume.
    const sim = createSim(map, 0xdead);
    const inputs = createTickInputs();
    inputs.players[0].moveX = 127;
    for (let i = 0; i < 30; i++) step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(-1);
    expect(sim.lockTarget[1]).toBe(-1);
  });
});
