// Phase 4 — the Warden. The AI runs inside the sim off sim state + sim PRNG
// only, so a Warden match must be exactly as deterministic as a human one
// (golden #4 pins a full match; these tests cover the mechanics directly).

import { describe, expect, it } from "bun:test";
import { ARCHETYPE } from "../src/archetypes";
import {
  POINTS_AVATAR_DOWN,
  STARTING_POINTS,
  WARDEN_ALTITUDE,
  WARDEN_DEFEND_RADIUS,
  WARDEN_HP,
  WARDEN_PUSH_COMMIT_RANGE,
  WARDEN_RESPAWN_TICKS,
  WARDEN_SUPPRESS_DISTANCE,
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
import { createSim, hash, type SimState, spawnUnit, step } from "../src/sim";
import { isGroundUnit } from "../src/units";
import { WGOAL_CAPTURE, WGOAL_DEFEND, WGOAL_ESCORT, WGOAL_SUPPRESS } from "../src/warden";

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

  it("earns like a human side: same start, and its fall pays the enemy 10 at once", () => {
    // The original's Sky Captain budget IS its Current Points
    // (fcop-re/ai-and-rules.md §1.8). This used to pin a difficulty income
    // multiplier on the trickle; the original has neither.
    const sim = wardenSim(1);
    expect(sim.points[1]).toBe(STARTING_POINTS);
    sim.points[1] = 25;
    const wid = sim.avatarId[1];
    sim.ent.hp[wid] = -10;
    step(sim, idle);
    expect(sim.avatarId[1]).toBe(-1);
    // Its death script pays when it is shot down, not at its respawn.
    expect(sim.points[0]).toBe(STARTING_POINTS + POINTS_AVATAR_DOWN);
    expect(sim.points[1]).toBe(25 - POINTS_AVATAR_DOWN);
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
    // The Warden keeps Metropolis' own 8 s (WARDEN_RESPAWN_TICKS): the player's
    // 4 s is the X1-Alpha's (fcop-fidelity.md P2); the Sky Captain's is U3's.
    expect(sim.respawnTimer[1]).toBe(WARDEN_RESPAWN_TICKS - 1);
    for (let t = 0; t < WARDEN_RESPAWN_TICKS - 1; t++) step(sim, idle);
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

describe("the goal ladder on the imported arenas (rules.md §7, §9)", () => {
  // Until SIM_VERSION 32 two rungs read whether the loss condition was a breached
  // gate (§1) or a razed core (§9). The original has no core and no free
  // production (fcop-fidelity.md R1, I7), so the loss condition is the gate
  // everywhere and base defense reads one radius. The push rung (commit, then
  // suppress or escort) still reads the arena: it exists for the imported city
  // lattice. These pin the goal MIX rather than an outcome, because the mix is
  // where a defect is visible and an outcome is not — a Warden can look busy
  // while doing nothing toward the objective.
  const PA_ARENAS = [LA_CANTINA_ID, URBAN_JUNGLE_ID, PROVING_GROUND_ID, BUG_HUNT_ID];

  /**
   * The window these measure over: twelve minutes, or the breach. It was five
   * until v33, when the original's economy (no trickle, a 10-point start) made a
   * difficulty-8 Warden spend its first minutes capturing toward the 50-point
   * Juggernaut it saves for — proving-ground and bug-hunt field nothing in the
   * first five, so a five-minute window held no push to measure.
   */
  const WINDOW = 12 * 60 * 30;

  /** Fraction of ticks spent on each goal over a difficulty-8 match. */
  function goalMix(mapId: string): Map<number, number> {
    const map = getMapById(mapId);
    const sim = createSim(map, 0xc0ffee, { wardenPlayer: 1, wardenDifficulty: 8 });
    const ticks = new Map<number, number>();
    while (sim.tick < WINDOW && sim.winner < 0) {
      step(sim, idle);
      ticks.set(sim.wardenGoal, (ticks.get(sim.wardenGoal) ?? 0) + 1);
    }
    for (const [g, n] of ticks) ticks.set(g, n / sim.tick);
    return ticks;
  }

  /**
   * Share of the match spent on the committed-push rung, in either of its forms.
   *
   * Asserted as the sum from v20 on, because that rung now answers "what is
   * stopping this push" before "who do I fly alongside" and the split between the
   * two forms is arena geometry, not the behaviour under test. Measured at v33
   * over the window, at difficulty 8: SUPPRESS 11/2/2/3% and ESCORT 10/10/5/6% on
   * la-cantina, urban-jungle, proving-ground and bug-hunt (at v32, over five
   * minutes with a trickle, it was SUPPRESS 68/22/60/62% and ESCORT 3/24/6/5%).
   * The share is small now because a push is one Juggernaut bought late, not a
   * stream; pinning either form alone would read geometry as a regression.
   */
  const committed = (mix: Map<number, number>): number =>
    (mix.get(WGOAL_ESCORT) ?? 0) + (mix.get(WGOAL_SUPPRESS) ?? 0);

  it("commits to a PA push instead of sitting on home defence", () => {
    // Before v17, over ten minutes: escort 0% on la-cantina, urban-jungle and
    // bug-hunt, with DEFEND taking 63%, 89% and 91%: both bases produced a free
    // Runner every 5 s, so an enemy unit was always near the gate. v17 tightened
    // the §9 radius; v32 removed the free production instead, which is what the
    // original does, and the one §1 radius is back. Against an idle player there
    // is nobody to defend against, so DEFEND stays at zero and the committed rung
    // carries the match. The bound on DEFEND is loose because home defence is not
    // wrong, only wrong as a permanent state.
    for (const id of PA_ARENAS) {
      const mix = goalMix(id);
      expect(committed(mix)).toBeGreaterThan(0.05);
      expect(mix.get(WGOAL_DEFEND) ?? 0).toBeLessThan(0.25);
    }
  }, 30_000);

  it("defends its gate on the §1 radius on a PA arena too", () => {
    // An enemy Runner inside WARDEN_DEFEND_RADIUS of the Warden's gate is the
    // loss condition on every arena now, so it outranks everything but survival.
    const map = getMapById(LA_CANTINA_ID);
    const sim = createSim(map, 0xc0ffee, { wardenPlayer: 1, wardenDifficulty: 8 });
    const gate = map.bases[1].gate;
    const graph = map.laneGraph;
    if (!graph) throw new Error("la-cantina must carry a lane graph");
    // An enemy Runner on its own road, the node nearest 30 m from the gate.
    let at = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let k = 0; k < graph.nodes.length; k++) {
      const d = Math.abs(Math.hypot(graph.nodes[k].x - gate.x, graph.nodes[k].y - gate.y) - 30);
      if (d < best) {
        best = d;
        at = k;
      }
    }
    const n = graph.nodes[at];
    const unit = spawnUnit(sim, ARCHETYPE.RUNNER, 0, n.x, n.y, undefined, true);
    expect(Math.hypot(n.x - gate.x, n.y - gate.y)).toBeLessThan(WARDEN_DEFEND_RADIUS);
    sim.wardenThink = 0;
    step(sim, idle);
    expect(sim.wardenGoal).toBe(WGOAL_DEFEND);
    expect(sim.wardenSlot).toBe(unit);
  });

  it("does not abandon a push for another pad", () => {
    // The other rung: WGOAL_CAPTURE outranked WGOAL_ESCORT unconditionally, so a
    // Warden whose push was at the enemy base flew off for its 30th pad — measured
    // 67-75% of ticks capturing against 9% escorting, on arenas carrying 29-32
    // pads. Measured over the ticks a push EXISTS: with nothing produced for free
    // (v32) the Warden spends its opening on pads until its first bought wave
    // rolls, which is capture with no push to abandon. While one lives: capture
    // 0% on all four, the committed rung 63-70%. Asserted as the relation.
    for (const id of PA_ARENAS) {
      const sim = createSim(getMapById(id), 0xc0ffee, { wardenPlayer: 1, wardenDifficulty: 8 });
      let capture = 0;
      let pushing = 0;
      while (sim.tick < WINDOW && sim.winner < 0) {
        step(sim, idle);
        let tip = false;
        for (let e = 0; e < sim.ent.high && !tip; e++) {
          tip =
            sim.ent.alive[e] === 1 && sim.ent.team[e] === 1 && isGroundUnit(sim.ent.archetype[e]);
        }
        if (!tip) continue;
        if (sim.wardenGoal === WGOAL_CAPTURE) capture += 1;
        if (sim.wardenGoal === WGOAL_ESCORT || sim.wardenGoal === WGOAL_SUPPRESS) pushing += 1;
      }
      expect(pushing).toBeGreaterThan(capture);
    }
    // ...and capture still runs when the field has no tip.
    expect(goalMix(URBAN_JUNGLE_ID).get(WGOAL_CAPTURE) ?? 0).toBeGreaterThan(0);
    // And the bottom difficulties keep giving the advantage away, like every other
    // difficulty knob.
    expect(WARDEN_PUSH_COMMIT_RANGE[0]).toBe(0);
    expect(WARDEN_PUSH_COMMIT_RANGE[7]).toBeGreaterThan(0);
  }, 30_000);

  it("closes on what is stopping the push instead of hovering at cannon range", () => {
    // v20's rung, asserted as the thing that was missing: contact. The Warden used
    // to sit at WARDEN_ESCORT_DISTANCE behind a unit that had halted at its own
    // 14-16 m reach, i.e. ~20 m off the emplacement holding it, which is a distance
    // the arenas' walls make useless (paAttribution pins that no standoff position
    // exists). What must not regress is that it comes within contact distance of a
    // defending emplacement at all — measured closest approach 0.4-2.8 m on the four
    // arenas against 5.7-23.0 m before.
    for (const id of PA_ARENAS) {
      const map = getMapById(id);
      const sim = createSim(map, 0xc0ffee, { wardenPlayer: 1, wardenDifficulty: 8 });
      let closest = Number.POSITIVE_INFINITY;
      let suppressTicks = 0;
      while (sim.tick < WINDOW && sim.winner < 0) {
        step(sim, idle);
        if (sim.wardenGoal === WGOAL_SUPPRESS) suppressTicks += 1;
        const w = sim.avatarId[1];
        if (w < 0 || !sim.ent.alive[w]) continue;
        for (let e = 0; e < sim.ent.high; e++) {
          if (!sim.ent.alive[e] || sim.ent.team[e] !== 0) continue;
          if (sim.ent.archetype[e] !== ARCHETYPE.TURRET) continue;
          const d = Math.hypot(
            sim.ent.posX[e] - sim.ent.posX[w],
            sim.ent.posY[e] - sim.ent.posY[w],
          );
          if (d < closest) closest = d;
        }
      }
      expect(suppressTicks).toBeGreaterThan(0);
      // Inside the emplacement's own 12 m reach — the trade is the point, not a
      // side effect. Loose enough to survive a balance pass on the arrive radius.
      expect(closest).toBeLessThan(WARDEN_SUPPRESS_DISTANCE + 3);
    }
  }, 60_000);

  it("never takes the suppress rung off the imported arenas", () => {
    // The rung is gated on the arena carrying the original road graph (it used
    // to be gated on a core): district-01 has neither the graph nor the city
    // lattice the rung was measured on, so it must never reach it.
    const sim = wardenSim(8);
    expect(sim.map.laneGraph).toBeUndefined();
    let suppressTicks = 0;
    while (sim.tick < 3 * 60 * 30 && sim.winner < 0) {
      step(sim, idle);
      if (sim.wardenGoal === WGOAL_SUPPRESS) suppressTicks += 1;
    }
    expect(suppressTicks).toBe(0);
  }, 30_000);
});
