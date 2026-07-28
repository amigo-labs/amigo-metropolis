// Phase 4 — the Warden. The AI runs inside the sim off sim state + sim PRNG
// only, so a Warden match must be exactly as deterministic as a human one
// (golden #4 pins a full match; these tests cover the mechanics directly).

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  RESPAWN_TICKS,
  TRICKLE_INTERVAL_TICKS,
  WARDEN_ALTITUDE,
  WARDEN_CORE_DEFEND_RADIUS,
  WARDEN_DEFEND_RADIUS,
  WARDEN_HP,
  WARDEN_PUSH_COMMIT_RANGE,
} from "../src/balance";
import { EV_CAPTURE, EV_PURCHASE, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import {
  BUG_HUNT_ID,
  DISTRICT_01_ID,
  getMapById,
  LA_CANTINA_ID,
  PROVING_GROUND_ID,
  sampleHeight,
  URBAN_JUNGLE_ID,
} from "../src/map";
import { createSim, hash, type SimState, step } from "../src/sim";
import { WGOAL_CAPTURE, WGOAL_DEFEND, WGOAL_ESCORT } from "../src/warden";

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

  it("clamps the difficulty into 1–10 and coerces config to integers", () => {
    expect(wardenSim(0).wardenDifficulty).toBe(1);
    expect(wardenSim(99).wardenDifficulty).toBe(10);
    expect(wardenSim(7).wardenDifficulty).toBe(7);
    // Both values become array indices — fractional/NaN input must degrade
    // to a sane integer config, never poison the sim.
    expect(wardenSim(7.9).wardenDifficulty).toBe(7);
    expect(wardenSim(Number.NaN).wardenDifficulty).toBe(1);
    const fractional = createSim(getMapById(DISTRICT_01_ID), 1, {
      wardenPlayer: 0.5,
      wardenDifficulty: 5,
    });
    expect(fractional.wardenPlayer).toBe(0);
    expect(fractional.ent.archetype[fractional.avatarId[0]]).toBe(ARCHETYPE.WARDEN);
    const off = createSim(getMapById(DISTRICT_01_ID), 1, {
      wardenPlayer: Number.NaN,
      wardenDifficulty: 5,
    });
    expect(off.wardenPlayer).toBe(-1);
    expect(off.wardenDifficulty).toBe(0);
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

describe("the goal ladder reads the arena's rule set (rules.md §9)", () => {
  // Two rungs behave differently depending on whether the arena's loss condition
  // is a breached gate (§1) or a razed core (§9), and getting that wrong is not a
  // subtle mis-tune: on a §9 arena the §1 forms made the Warden spend the whole
  // match at home and never push. These pin the goal MIX rather than an outcome,
  // because the mix is where the defect was visible and an outcome is not — a
  // Warden can look busy while doing nothing toward the objective.
  const PA_ARENAS = [LA_CANTINA_ID, URBAN_JUNGLE_ID, PROVING_GROUND_ID, BUG_HUNT_ID];

  /**
   * Fraction of ticks spent on each goal over a 5-minute difficulty-8 match.
   * `silenceDefender` turns the far base's free production off, which is the
   * escorted-push scenario paAttribution measures the outcome of.
   */
  function goalMix(mapId: string, silenceDefender = false): Map<number, number> {
    const map = getMapById(mapId);
    if (silenceDefender) (map.bases[0] as { productionTicks: number }).productionTicks = 0;
    const sim = createSim(map, 0xc0ffee, { wardenPlayer: 1, wardenDifficulty: 8 });
    const ticks = new Map<number, number>();
    while (sim.tick < 5 * 60 * 30 && sim.winner < 0) {
      step(sim, idle);
      ticks.set(sim.wardenGoal, (ticks.get(sim.wardenGoal) ?? 0) + 1);
    }
    for (const [g, n] of ticks) ticks.set(g, n / sim.tick);
    return ticks;
  }

  it("escorts a real share of a PA match instead of sitting on home defence", () => {
    // Before v17, over ten minutes: escort 0% on la-cantina, urban-jungle and
    // bug-hunt, with DEFEND taking 63%, 89% and 91%. An enemy ground unit was
    // within 55 m of the gate essentially always, because both bases produce one
    // free Runner every 5 s, so the §1 rung never released the Warden.
    // After, over five minutes: escort 34%, 8%, 80% and 63%, DEFEND 0.0% on all
    // four. The bound on DEFEND is loose because home defence is not wrong, only
    // wrong as a permanent state.
    for (const id of PA_ARENAS) {
      const mix = goalMix(id);
      expect(mix.get(WGOAL_ESCORT) ?? 0).toBeGreaterThan(0.05);
      expect(mix.get(WGOAL_DEFEND) ?? 0).toBeLessThan(0.25);
    }
  }, 30_000);

  it("still defends unconditionally on a gate-breach arena", () => {
    // district-01 has coreHp 0, so a unit reaching the gate wins outright and the
    // wide radius is correct there. This is the guard that the §9 tightening did
    // not leak: goldens 01-04 run on this map and none of their hashes moved.
    const sim = createSim(getMapById(DISTRICT_01_ID), 0xc0ffee, {
      wardenPlayer: 1,
      wardenDifficulty: 8,
    });
    expect(sim.map.bases[1].coreHp).toBe(0);
    expect(WARDEN_DEFEND_RADIUS).toBeGreaterThan(WARDEN_CORE_DEFEND_RADIUS);
  });

  it("does not abandon a push that has arrived at the enemy core", () => {
    // The other rung: WGOAL_CAPTURE outranked WGOAL_ESCORT unconditionally, so a
    // Warden whose push was at the enemy core flew off for its 30th pad — measured
    // 67-75% of ticks capturing against 9% escorting, on arenas carrying 29-32
    // pads. Measured in the scenario where a push actually reaches the core, since
    // that is the only scenario the rung applies to: escort now 71-77% and capture
    // 5-16% on all four. Asserted as the relation that broke, not as transcribed
    // percentages.
    for (const id of PA_ARENAS) {
      const mix = goalMix(id, true);
      expect(mix.get(WGOAL_ESCORT) ?? 0).toBeGreaterThan(mix.get(WGOAL_CAPTURE) ?? 0);
    }
    // Capturing is still what it does with no push in progress: pads are income
    // and the board is worth about two heavy units (paAttribution pins that
    // relation). After v18 (team-unique ring, open midfield) escort claims more of
    // the match, so capture is no longer the majority — but it still runs.
    expect(goalMix(URBAN_JUNGLE_ID).get(WGOAL_CAPTURE) ?? 0).toBeGreaterThan(0.05);
    // And the bottom difficulties keep giving the advantage away, like every other
    // difficulty knob.
    expect(WARDEN_PUSH_COMMIT_RANGE[0]).toBe(0);
    expect(WARDEN_PUSH_COMMIT_RANGE[7]).toBeGreaterThan(0);
  }, 30_000);
});
