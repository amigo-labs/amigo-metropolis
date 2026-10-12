// The X1-Alpha's lock (fcop-fidelity.md W2; fcop-re/player-and-weapons.md §7):
// 12 m horizontal, acquired inside +-12.5° of the hull's facing — by the
// Target-Cycle press or, while there is no lock, automatically every tick — and
// held inside +-25°. A lock the player took with the press is also the heading
// the hull turns to (input.spec §4.4 `lock` mode); an auto-acquired one only aims
// the weapons. Positions are set directly to place the actors at known spots.
import { describe, expect, it } from "bun:test";
import {
  ARCHETYPE,
  AVATAR_LOCK_ACQUIRE_COS,
  AVATAR_LOCK_HOLD_COS,
  AVATAR_LOCK_RANGE,
  BUTTON_TARGET_CYCLE,
  createSim,
  createTestMap,
  createTickInputs,
  getMapById,
  hash,
  LA_CANTINA_ID,
  spawnUnit,
  step,
} from "../src/index";

const map = createTestMap();
const DEG = Math.PI / 180;

/**
 * p0 at (50, 50) facing +x; p1 at `dist` m from it on the bearing `deg`. The test
 * map spawns both avatars on the same spot, so both are moved apart first.
 */
function place(sim: ReturnType<typeof createSim>, dist: number, deg: number) {
  const a0 = sim.avatarId[0];
  const a1 = sim.avatarId[1];
  sim.ent.posX[a0] = 50;
  sim.ent.posY[a0] = 50;
  sim.ent.yaw[a0] = 0;
  sim.ent.aimX[a0] = 1;
  sim.ent.aimY[a0] = 0;
  setBearing(sim, a1, dist, deg);
  // p1 faces away, so it never locks p0 and the tests read p0's lock alone.
  sim.ent.yaw[a1] = Math.PI / 2;
  sim.ent.aimX[a1] = 0;
  sim.ent.aimY[a1] = 1;
  return { a0, a1 };
}

function setBearing(sim: ReturnType<typeof createSim>, id: number, dist: number, deg: number) {
  sim.ent.posX[id] = 50 + dist * Math.cos(deg * DEG);
  sim.ent.posY[id] = 50 + dist * Math.sin(deg * DEG);
}

describe("the lock (fcop-fidelity.md W2)", () => {
  it("is the original's: 12 m, +-12.5° to acquire, +-25° to hold", () => {
    expect(AVATAR_LOCK_RANGE).toBe(12);
    expect(Math.acos(AVATAR_LOCK_ACQUIRE_COS) / DEG).toBeCloseTo(12.5, 1);
    expect(Math.acos(AVATAR_LOCK_HOLD_COS) / DEG).toBeCloseTo(25, 1);
  });

  it("auto-acquires the enemy straight ahead with no press, and does not steer", () => {
    const sim = createSim(map, 0xd0d0);
    const inputs = createTickInputs();
    const { a0, a1 } = place(sim, 10, 10);
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(a1);
    expect(sim.lockSteer[0]).toBe(0);
    // Nothing aims, so the hull stays where it was: an auto-lock aims the guns only.
    expect(sim.ent.aimX[a0]).toBeCloseTo(1, 6);
  });

  it("acquires nothing outside the 12.5° cone or past 12 m, pressed or not", () => {
    for (const [dist, deg] of [
      [10, 14],
      [10, -14],
      [12.2, 0],
    ]) {
      const sim = createSim(map, 0xd0d0);
      const inputs = createTickInputs();
      place(sim, dist, deg);
      step(sim, inputs);
      expect(sim.lockTarget[0]).toBe(-1);
      inputs.players[0].buttons = BUTTON_TARGET_CYCLE;
      step(sim, inputs);
      expect(sim.lockTarget[0]).toBe(-1);
    }
  });

  it("holds to 25° off the facing and drops beyond it, or past 12 m", () => {
    const sim = createSim(map, 0xd0d0);
    const inputs = createTickInputs();
    const { a1 } = place(sim, 10, 0);
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(a1);
    setBearing(sim, a1, 10, 22);
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(a1); // held: inside 25°, though outside 12.5°
    setBearing(sim, a1, 10, 28);
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(-1);

    setBearing(sim, a1, 10, 0);
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(a1);
    setBearing(sim, a1, 12.5, 0);
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(-1);
  });

  it("a cycled lock steers the hull, which keeps it inside the hold cone", () => {
    const sim = createSim(map, 0xd0d0);
    const inputs = createTickInputs();
    const { a0, a1 } = place(sim, 10, 5);
    inputs.players[0].buttons = BUTTON_TARGET_CYCLE;
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(a1);
    expect(sim.lockSteer[0]).toBe(1);
    inputs.players[0].buttons = 0;
    // The target walks round p0 at 2° a tick; the walker turns 3.5° a tick
    // (105°/s at rest, fcop-fidelity.md P4), so the hull keeps up and the lock holds.
    for (let deg = 6; deg <= 90; deg += 2) {
      setBearing(sim, a1, 10, deg);
      step(sim, inputs);
      expect(sim.lockTarget[0]).toBe(a1);
    }
    for (let t = 0; t < 5; t++) step(sim, inputs);
    expect(sim.ent.aimX[a0]).toBeCloseTo(0, 6);
    expect(sim.ent.aimY[a0]).toBeCloseTo(1, 6);
  });

  it("an auto-lock drops when the player turns the hull away", () => {
    const sim = createSim(map, 0xd0d0);
    const inputs = createTickInputs();
    const { a1 } = place(sim, 10, 0);
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(a1);
    inputs.players[0].aimX = 0;
    inputs.players[0].aimY = 127; // aim north: the hull turns 3.5° a tick
    let ticks = 0;
    while (sim.lockTarget[0] === a1 && ticks < 30) {
      step(sim, inputs);
      ticks++;
    }
    expect(sim.lockTarget[0]).toBe(-1);
    // 25° at 105°/s is about 7 ticks of turning, plus the tick it is noticed in.
    expect(ticks).toBeGreaterThanOrEqual(7);
    expect(ticks).toBeLessThanOrEqual(9);
  });

  it("the cycle press alternates between the two nearest targets in the cone", () => {
    const sim = createSim(map, 0xd0d0);
    const inputs = createTickInputs();
    const { a1 } = place(sim, 10, 3);
    const runner = spawnUnit(sim, ARCHETYPE.RUNNER, 1, 58, 50);
    expect(runner).toBeGreaterThanOrEqual(0);
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(runner); // the nearer, 8 m
    const press = () => {
      inputs.players[0].buttons = BUTTON_TARGET_CYCLE;
      step(sim, inputs);
      inputs.players[0].buttons = 0;
      step(sim, inputs); // release, so the next press is an edge again
      // Keep both where they are (the Runner drives, the steering hull turns).
      sim.ent.posX[runner] = 58;
      sim.ent.posY[runner] = 50;
      setBearing(sim, a1, 10, 3);
    };
    press();
    expect(sim.lockTarget[0]).toBe(a1);
    press();
    expect(sim.lockTarget[0]).toBe(runner);
  });

  it("a press with nothing else in the cone keeps the lock", () => {
    const sim = createSim(map, 0xd0d0);
    const inputs = createTickInputs();
    const { a1 } = place(sim, 10, 0);
    step(sim, inputs);
    inputs.players[0].buttons = BUTTON_TARGET_CYCLE;
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(a1);
    expect(sim.lockSteer[0]).toBe(1);
  });

  it("death releases the lock", () => {
    const sim = createSim(map, 0xd0d0);
    const inputs = createTickInputs();
    const { a1 } = place(sim, 10, 0);
    inputs.players[0].buttons = BUTTON_TARGET_CYCLE;
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(a1);
    // A target at zero health is no longer lockable; the death system then
    // removes it in the same tick.
    sim.ent.hp[a1] = 0;
    inputs.players[0].buttons = 0;
    step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(-1);
    expect(sim.lockSteer[0]).toBe(0);
  });

  it("stays deterministic: same inputs → same hash with the lock active", () => {
    const run = () => {
      const sim = createSim(map, 7);
      const inputs = createTickInputs();
      place(sim, 9, 4);
      for (let t = 0; t < 20; t++) {
        inputs.players[0].buttons = t === 0 ? BUTTON_TARGET_CYCLE : 0;
        step(sim, inputs);
      }
      return hash(sim);
    };
    expect(run()).toBe(run());
  });

  it("avatars a whole arena apart never lock", () => {
    const sim = createSim(getMapById(LA_CANTINA_ID), 0xdead);
    const inputs = createTickInputs();
    inputs.players[0].moveX = 127;
    for (let i = 0; i < 30; i++) step(sim, inputs);
    expect(sim.lockTarget[0]).toBe(-1);
    expect(sim.lockTarget[1]).toBe(-1);
  });
});
