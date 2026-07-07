// Golden #3 (Phase 2 DoD): beyond the hash-sequence check in golden.test.ts,
// assert the scripted mini-match actually plays out — both sides buy Runners,
// the wave grinds base East's ring, one side breaches on the KNOWN tick, and
// the sim freezes for the rest of the replay. If a balance retune shifts the
// match off these beats, this fails and the script needs adjusting WITH the
// regenerated golden (and a new pinned breach tick).

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHETYPE } from "../src/archetypes";
import { EV_BREACH, EV_DEATH, EV_PURCHASE, EVENT_STRIDE } from "../src/events";
import { createTickInputs } from "../src/inputs";
import { getMapById } from "../src/map";
import { decodeReplay, readFrame } from "../src/replay";
import { createSim, step } from "../src/sim";

// Pinned after recording; regenerate together with the golden.
const BREACH_TICK_PIN = 4066;

describe("golden-03-match beats", () => {
  it("plays a full mini-match: runner waves, ring kills, breach, freeze", () => {
    const replay = decodeReplay(
      new Uint8Array(readFileSync(join(import.meta.dir, "goldens", "golden-03-match.mrep"))),
    );
    expect(replay.mapId).toBe("district-01");
    const sim = createSim(getMapById(replay.mapId), replay.seed);
    const inputs = createTickInputs();

    const purchases = [0, 0];
    let juggernauts = 0;
    let runnerDeaths = 0;
    let turretDeaths = 0;
    let breachTick = -1;
    let breachTeam = -1;
    let breaches = 0;

    for (let t = 0; t < replay.tickCount; t++) {
      readFrame(replay, t, inputs);
      step(sim, inputs);
      for (let i = 0; i < sim.events.count; i++) {
        const o = i * EVENT_STRIDE;
        const type = sim.events.data[o];
        if (type === EV_PURCHASE) {
          purchases[sim.events.data[o + 2]] += 1;
          if (sim.events.data[o + 3] === ARCHETYPE.JUGGERNAUT) juggernauts += 1;
        } else if (type === EV_DEATH) {
          if (sim.events.data[o + 3] === ARCHETYPE.RUNNER) runnerDeaths += 1;
          if (sim.events.data[o + 3] === ARCHETYPE.TURRET) turretDeaths += 1;
        } else if (type === EV_BREACH) {
          breaches += 1;
          breachTick = t;
          breachTeam = sim.events.data[o + 2];
        }
      }
    }

    // Runners spawned on BOTH sides (Phase 2 DoD).
    expect(purchases[0]).toBeGreaterThanOrEqual(10);
    expect(purchases[1]).toBeGreaterThanOrEqual(2);
    expect(juggernauts).toBe(1);
    // The push cost blood on both ends.
    expect(runnerDeaths).toBeGreaterThanOrEqual(10);
    expect(turretDeaths).toBeGreaterThanOrEqual(1);
    // Exactly one breach, by team 0, on the known tick.
    expect(breaches).toBe(1);
    expect(breachTeam).toBe(0);
    expect(breachTick).toBe(BREACH_TICK_PIN);
    expect(sim.winner).toBe(0);
    // The replay ran well past the breach: the frozen tail is in the golden.
    expect(replay.tickCount).toBeGreaterThan(BREACH_TICK_PIN + 300);
  });
});
