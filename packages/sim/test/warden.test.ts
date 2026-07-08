// Phase 4 — the Warden. The AI runs inside the sim off sim state + sim PRNG
// only, so a Warden match must be exactly as deterministic as a human one
// (golden #4 pins a full match; these tests cover the mechanics directly).

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import { RESPAWN_TICKS, TRICKLE_INTERVAL_TICKS, WARDEN_ALTITUDE, WARDEN_HP } from "../src/balance";
import { EV_CAPTURE, EV_PURCHASE, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { DISTRICT_01_ID, getMapById, sampleHeight } from "../src/map";
import { createSim, hash, type SimState, step } from "../src/sim";

const idle = createTickInputs();

function wardenSim(difficulty: number, seed = 0xc0ffee): SimState {
  return createSim(getMapById(DISTRICT_01_ID), seed, {
    wardenPlayer: 1,
    wardenDifficulty: difficulty,
  });
}

describe("warden", () => {
  it("spawns as the superplane on the configured slot", () => {
    const sim = wardenSim(5);
    const wid = sim.avatarId[1];
    expect(wid).toBeGreaterThanOrEqual(0);
    expect(sim.ent.archetype[wid]).toBe(ARCHETYPE.WARDEN);
    expect(sim.ent.hp[wid]).toBe(WARDEN_HP);
    // Flies at cruise altitude, not on the ground.
    const ground = sampleHeight(sim.map, sim.ent.posX[wid], sim.ent.posY[wid]);
    expect(sim.ent.height[wid]).toBeGreaterThanOrEqual(ground + WARDEN_ALTITUDE - 0.001);
    // The human slot is untouched.
    expect(sim.ent.archetype[sim.avatarId[0]]).toBe(ARCHETYPE.AVATAR);
    // No Warden without the option.
    const plain = createSim(getMapById(DISTRICT_01_ID), 1);
    expect(plain.wardenPlayer).toBe(-1);
    expect(plain.ent.archetype[plain.avatarId[1]]).toBe(ARCHETYPE.AVATAR);
  });

  it("clamps the difficulty into 1–10", () => {
    expect(wardenSim(0).wardenDifficulty).toBe(1);
    expect(wardenSim(99).wardenDifficulty).toBe(10);
    expect(wardenSim(7).wardenDifficulty).toBe(7);
  });

  it("is deterministic: two identical runs, identical hash streams", () => {
    const a = wardenSim(7, 123);
    const b = wardenSim(7, 123);
    for (let t = 0; t < 900; t++) {
      step(a, idle);
      step(b, idle);
      if (hash(a) !== hash(b)) {
        throw new Error(`warden runs diverged at tick ${t}`);
      }
    }
  });

  it("difficulty changes the match (same seed, different stream)", () => {
    const low = wardenSim(1, 42);
    const high = wardenSim(10, 42);
    let diverged = false;
    for (let t = 0; t < 900 && !diverged; t++) {
      step(low, idle);
      step(high, idle);
      diverged = hash(low) !== hash(high);
    }
    expect(diverged).toBe(true);
  });

  it("scales trickle income by the difficulty multiplier (integer-exact)", () => {
    // Difficulty 1 earns 50%: the fixed-point accumulator holds the odd half
    // point after one interval and flushes it on the next — no float drift.
    // (+1: the trickle fires during the step that BEGINS on the interval tick)
    const sim = wardenSim(1);
    for (let t = 0; t < TRICKLE_INTERVAL_TICKS + 1; t++) step(sim, idle);
    expect(sim.wardenIncomeAcc).toBe(50);
    for (let t = 0; t < TRICKLE_INTERVAL_TICKS; t++) step(sim, idle);
    expect(sim.wardenIncomeAcc).toBe(0);
  });

  it("respawns as the superplane after death", () => {
    const sim = wardenSim(5);
    const wid = sim.avatarId[1];
    // Clearly below zero: the spawn sits on the own repair pad, which heals
    // 0.5 hp during the same tick before the death system runs.
    sim.ent.hp[wid] = -10;
    step(sim, idle);
    expect(sim.avatarId[1]).toBe(-1);
    // The spawning system already counted down once in the death tick.
    expect(sim.respawnTimer[1]).toBe(RESPAWN_TICKS - 1);
    for (let t = 0; t < RESPAWN_TICKS - 1; t++) step(sim, idle);
    const reborn = sim.avatarId[1];
    expect(reborn).toBeGreaterThanOrEqual(0);
    expect(sim.ent.archetype[reborn]).toBe(ARCHETYPE.WARDEN);
    expect(sim.ent.hp[reborn]).toBe(WARDEN_HP);
  });

  it("captures turrets and buys units on its own within two minutes", () => {
    const sim = wardenSim(5);
    let captures = 0;
    let purchases = 0;
    for (let t = 0; t < 3600; t++) {
      step(sim, idle);
      for (let i = 0; i < sim.events.count; i++) {
        const o = i * EVENT_STRIDE;
        if (sim.events.data[o] === EV_CAPTURE && sim.events.data[o + 2] === 1) captures += 1;
        if (sim.events.data[o] === EV_PURCHASE && sim.events.data[o + 2] === 1) purchases += 1;
      }
    }
    expect(captures).toBeGreaterThanOrEqual(1);
    expect(purchases).toBeGreaterThanOrEqual(1);
    // It spends within its ledger — the economy never goes negative (u32
    // wraparound would explode the balance).
    expect(sim.points[1]).toBeLessThan(100000);
  });
});
